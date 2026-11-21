import { checkName, findTargets, row } from "../clients";
import type { AddState, Client, Scope } from "../clients/types";
import { bounded } from "../deadline";
import type { Env } from "../env";
import { UsageError } from "../errors";
import { ask, confirm, confirmSome } from "../prompt";
import { checkWorkspace, parseWorkspace, sameUrl, type Workspace } from "../workspace";

export interface McpAddFlags {
  workspace?: string;
  client: string[];
  project: boolean;
  name?: string;
  yes: boolean;
  dryRun: boolean;
}

interface Row {
  client: Client;
  state: AddState;
  detail: string;
  /** Lines printed under the plan: what to do by hand. */
  manual?: string[];
  /** The address of the entry a "will replace" row replaces. */
  previousUrl?: string;
}

async function plan(env: Env, client: Client, installed: boolean, scope: Scope, name: string, url: string): Promise<Row> {
  if (!installed) return { client, state: "not found", detail: "not installed on this machine" };
  if (scope === "project" && !client.hasProjectScope) {
    return { client, state: "skipped", detail: "has no per-project configuration" };
  }
  const manual = client.manualAdd(env, scope, name, url);
  if (client.manualOnly) return { client, state: "manual", detail: "set up in the app, see below", manual };

  const current = await client.read(env, scope, name);
  if (current.failed) return { client, state: "failed", detail: current.failed };
  if (current.unreadable) return { client, state: "manual", detail: `${current.location}: ${current.unreadable}`, manual };

  const existing = current.entries.find((entry) => entry.name === name);
  if (!existing) return { client, state: "will add", detail: client.describeAdd(env, scope, name, url, false) };
  if (existing.url && sameUrl(existing.url, url)) return { client, state: "already set", detail: current.location };
  return {
    client,
    state: "will replace",
    detail: `${existing.url ?? "an entry without a URL"} → ${url}; ${client.describeAdd(env, scope, name, url, true)}`,
    previousUrl: existing.url,
  };
}

const genericBlock = (name: string, url: string) =>
  JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }, null, 2);

/**
 * `checked` is a workspace the caller has already asked about and checked
 * (`init` offering this command): it is taken as it is, so the run makes no
 * second request.
 */
export async function mcpAdd(base: Env, flags: McpAddFlags, checked?: Workspace): Promise<number> {
  const env = bounded(base);
  const name = checkName(flags.name);
  const scope: Scope = flags.project ? "project" : "user";
  const workspace =
    checked ??
    parseWorkspace(
      flags.workspace ??
        (await ask(env, "Workspace (slug, host or URL): ", "--workspace <slug|host|url>", "to say which workspace to connect")),
    );
  // Decided before anything is looked at: without a terminal nobody can confirm.
  if (!flags.dryRun && !flags.yes && !env.tty) {
    throw new UsageError("Not running in a terminal, so nothing can be asked. Pass --yes to apply the changes or --dry-run to preview them.");
  }
  const targets = await findTargets(env, flags.client);

  env.out(`Workspace:  ${workspace.origin}`);
  env.out(`MCP server: ${workspace.mcpUrl} (as "${name}")`);
  env.out("The workspace name is not checked here. If it is wrong, sign-in in your client will fail.");

  if (!checked && !(await checkWorkspace(env, workspace, flags))) return 1;

  if (!targets.length) {
    env.out("\nNo supported AI client was found on this machine. Add this to your client's MCP configuration:\n");
    env.out(genericBlock(name, workspace.mcpUrl));
    return 0;
  }

  const rows: Row[] = [];
  for (const { client, installed } of targets) rows.push(await plan(env, client, installed, scope, name, workspace.mcpUrl));

  const changing = rows.filter((r) => r.state === "will add" || r.state === "will replace");
  env.out(`\nPlan (${scope} configuration):`);
  for (const r of rows) {
    const number = changing.length > 1 && changing.includes(r) ? `${changing.indexOf(r) + 1}. ` : "";
    env.out(row(number + r.client.label, r.state, r.detail));
  }
  for (const r of rows) {
    if (!r.manual) continue;
    env.out(`\n${r.client.label}:`);
    for (const line of r.manual) env.out(`  ${line}`);
  }

  const unanswered = rows.some((r) => r.state === "failed");
  if (!changing.length) {
    env.out(unanswered ? "\nNothing was changed." : "\nNothing to change.");
    return unanswered ? 1 : 0;
  }
  if (flags.dryRun) {
    env.out("\nDry run: nothing was changed.");
    return 0;
  }

  let chosen = changing;
  if (!flags.yes) {
    env.out("");
    const picked = await confirmSome(env, "Apply these changes?", changing.length);
    if (!picked) {
      env.out("Nothing was changed.");
      return 1;
    }
    chosen = picked.map((i) => changing[i]!);
    // Pointing an existing entry at another workspace is confirmed on its own.
    const kept: Row[] = [];
    for (const r of chosen) {
      if (r.state !== "will replace" || (await confirm(env, `${r.client.label}: replace the existing "${name}" entry?`))) kept.push(r);
    }
    chosen = kept;
    if (!chosen.length) {
      env.out("Nothing was changed.");
      return 1;
    }
  }

  env.out("");
  let failed = rows.some((r) => r.state === "failed");
  const done: Row[] = [];
  for (const r of chosen) {
    try {
      await r.client.add(env, scope, name, workspace.mcpUrl, r.state === "will replace", r.previousUrl);
      env.out(`${r.client.label}: ${r.state === "will replace" ? "replaced" : "added"}.`);
      done.push(r);
    } catch (error) {
      failed = true;
      env.err(`${r.client.label}: ${(error as Error).message}`);
    }
  }

  if (done.length) {
    env.out("\nNext steps:");
    for (const r of done) for (const step of r.client.nextSteps(name)) env.out(`  ${r.client.label}: ${step}`);
    env.out("\nNo key was written anywhere. Each client signs in through the browser.");
  }
  return failed ? 1 : 0;
}
