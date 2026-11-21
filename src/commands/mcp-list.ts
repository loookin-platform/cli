import { findTargets, row, SERVER_NAME } from "../clients";
import type { Scope } from "../clients/types";
import { bounded } from "../deadline";
import type { Env } from "../env";
import { isLoookinMcpUrl } from "../workspace";

export interface McpListFlags {
  project: boolean;
}

/** Read-only: where Loookin is set, under which name and with which address. */
export async function mcpList(base: Env, flags: McpListFlags): Promise<number> {
  const env = bounded(base);
  let failed = false;
  const scope: Scope = flags.project ? "project" : "user";
  const targets = await findTargets(env, []);
  if (!targets.length) {
    env.out("No supported AI client was found on this machine.");
    return 0;
  }

  env.out(`Loookin in your AI clients (${scope} configuration):`);
  for (const { client } of targets) {
    if (scope === "project" && !client.hasProjectScope) {
      env.out(row(client.label, "skipped", "has no per-project configuration"));
      continue;
    }
    if (client.manualOnly) {
      env.out(row(client.label, "unknown", `cannot be read from here, check ${(await client.read(env, scope, SERVER_NAME)).location}`));
      continue;
    }
    const current = await client.read(env, scope, SERVER_NAME);
    if (current.failed) {
      failed = true;
      env.out(row(client.label, "failed", current.failed));
      continue;
    }
    if (current.unreadable) {
      env.out(row(client.label, "unknown", `${current.location}: ${current.unreadable}`));
      continue;
    }
    // By name, and by address too: an entry under another name (a second
    // workspace, the older "lookin") still counts.
    const found = current.entries.filter((e) => e.name === SERVER_NAME || (e.url && isLoookinMcpUrl(e.url)));
    if (!found.length) env.out(row(client.label, "not set", current.location));
    for (const entry of found) {
      env.out(row(client.label, entry.name, `${entry.url ?? "(no URL)"}  in ${current.location}`));
    }
  }
  return failed ? 1 : 0;
}
