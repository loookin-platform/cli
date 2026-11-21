import { checkName, findTargets, row } from "../clients";
import type { Client, RemoveState, Scope } from "../clients/types";
import { bounded } from "../deadline";
import type { Env } from "../env";
import { UsageError } from "../errors";
import { confirmSome } from "../prompt";

export interface McpRemoveFlags {
  client: string[];
  project: boolean;
  name?: string;
  yes: boolean;
  dryRun: boolean;
}

interface Row {
  client: Client;
  state: RemoveState;
  detail: string;
  manual?: string[];
}

async function plan(env: Env, client: Client, installed: boolean, scope: Scope, name: string): Promise<Row> {
  if (!installed) return { client, state: "not found", detail: "not installed on this machine" };
  if (scope === "project" && !client.hasProjectScope) {
    return { client, state: "skipped", detail: "has no per-project configuration" };
  }
  const manual = client.manualRemove(env, scope, name);
  if (client.manualOnly) return { client, state: "manual", detail: "remove it in the app, see below", manual };

  const current = await client.read(env, scope, name);
  if (current.failed) return { client, state: "failed", detail: current.failed };
  if (current.unreadable) return { client, state: "manual", detail: `${current.location}: ${current.unreadable}`, manual };
  if (!current.entries.some((entry) => entry.name === name)) return { client, state: "not set", detail: current.location };
  return { client, state: "will remove", detail: client.describeRemove(env, scope, name) };
}

export async function mcpRemove(base: Env, flags: McpRemoveFlags): Promise<number> {
  const env = bounded(base);
  const name = checkName(flags.name);
  const scope: Scope = flags.project ? "project" : "user";
  if (!flags.dryRun && !flags.yes && !env.tty) {
    throw new UsageError("Not running in a terminal, so nothing can be asked. Pass --yes to apply the changes or --dry-run to preview them.");
  }
  const targets = await findTargets(env, flags.client);
  if (!targets.length) {
    env.out("No supported AI client was found on this machine. Nothing to remove.");
    return 0;
  }

  const rows: Row[] = [];
  for (const { client, installed } of targets) rows.push(await plan(env, client, installed, scope, name));

  const removing = rows.filter((r) => r.state === "will remove");
  env.out(`Plan (${scope} configuration, entry "${name}"):`);
  for (const r of rows) {
    const number = removing.length > 1 && removing.includes(r) ? `${removing.indexOf(r) + 1}. ` : "";
    env.out(row(number + r.client.label, r.state, r.detail));
  }
  for (const r of rows) {
    if (!r.manual) continue;
    env.out(`\n${r.client.label}:`);
    for (const line of r.manual) env.out(`  ${line}`);
  }

  const unanswered = rows.some((r) => r.state === "failed");
  if (!removing.length) {
    env.out(unanswered ? "\nNothing was changed." : "\nNothing to remove.");
    return unanswered ? 1 : 0;
  }
  if (flags.dryRun) {
    env.out("\nDry run: nothing was changed.");
    return 0;
  }

  let chosen = removing;
  if (!flags.yes) {
    env.out("");
    const picked = await confirmSome(env, "Remove these entries?", removing.length);
    if (!picked) {
      env.out("Nothing was changed.");
      return 1;
    }
    chosen = picked.map((i) => removing[i]!);
  }

  env.out("");
  let failed = rows.some((r) => r.state === "failed");
  for (const r of chosen) {
    try {
      await r.client.remove(env, scope, name);
      env.out(`${r.client.label}: removed.`);
    } catch (error) {
      failed = true;
      env.err(`${r.client.label}: ${(error as Error).message}`);
    }
  }
  env.out("\nA sign-in the client saved for this server is not revoked. Sign out in the client if you want it gone.");
  return failed ? 1 : 0;
}
