import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { addOrReplace, runOrThrow, show } from "./command";
import type { Client, Entry } from "./types";

// Codex is driven through its own command. `codex mcp add <name> --url <url>`
// is documented; `codex mcp remove <name>` follows the same pattern but was
// not confirmed against `codex mcp --help` when this was written (Codex was
// not installed). It has to be verified in manual testing before a release.
// https://learn.chatgpt.com/docs/extend/mcp
const addArgs = (name: string, url: string) => ["mcp", "add", name, "--url", url];
const removeArgs = (name: string) => ["mcp", "remove", name];

const configPath = (home: string) => join(home, ".codex", "config.toml");

/**
 * Finds `[mcp_servers.<name>]` tables and their `url` in config.toml. This is
 * read-only and deliberately small: no TOML dependency for one string. Inline
 * tables (`name = { url = … }`) are not recognised.
 */
export function parseCodexServers(toml: string): Entry[] {
  const entries: Entry[] = [];
  let current: Entry | undefined;
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
    if (header) {
      const server = /^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/.exec(header[1]!);
      current = server ? { name: (server[1] ?? server[2] ?? server[3])! } : undefined;
      if (current) entries.push(current);
      continue;
    }
    const url = /^\s*url\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (current && url) current.url = url[1] ?? url[2];
  }
  return entries;
}

export const codex: Client = {
  id: "codex",
  label: "Codex",
  hasProjectScope: false,
  detect: async (env) => (await env.which("codex")) !== null,

  async read(env) {
    const location = configPath(env.home);
    try {
      return { location, entries: parseCodexServers(await readFile(location, "utf8")) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { location, entries: [] };
      return { location, entries: [], unreadable: (error as Error).message };
    }
  },

  describeAdd: (_env, _scope, name, url, replacing) =>
    (replacing ? `${show("codex", removeArgs(name))}, then ` : "") + show("codex", addArgs(name, url)),
  add: (env, _scope, name, url, replacing, previousUrl) =>
    addOrReplace(env, "codex", removeArgs(name), (to) => addArgs(name, to), url, replacing, previousUrl),

  describeRemove: (_env, _scope, name) => show("codex", removeArgs(name)),
  remove: (env, _scope, name) => runOrThrow(env, "codex", removeArgs(name)),

  manualAdd: (_env, _scope, name, url) => [`Run: codex ${addArgs(name, url).join(" ")}`],
  manualRemove: (env, _scope, name) => [`Delete the [mcp_servers.${name}] table in ${configPath(env.home)}.`],
  nextSteps: (name) => [`Run \`codex mcp login ${name}\` and sign in in the browser.`],
};
