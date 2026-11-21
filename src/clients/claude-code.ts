import { join } from "node:path";
import { CLIENT_TIMEOUT_MS, runOrThrow, show } from "./command";
import { readFileEntries, type FileSpec } from "./file";
import type { Client, Scope } from "./types";

// Claude Code keeps user-level servers in ~/.claude.json together with
// unrelated state, and rewrites that file while it runs. The CLI therefore
// never edits it and goes through `claude mcp` (checked against
// `claude mcp --help`). The default scope of `claude mcp add` is `local`
// (this project only), so the scope is always passed.
// https://code.claude.com/docs/en/mcp
const addArgs = (scope: Scope, name: string, url: string) =>
  ["mcp", "add", "--transport", "http", "--scope", scope, name, url];
const removeArgs = (scope: Scope, name: string) => ["mcp", "remove", "--scope", scope, name];

// Project-level servers are a plain file the CLI can read without the client.
const projectFile: FileSpec = {
  key: "mcpServers",
  path: (env) => join(env.cwd, ".mcp.json"),
  entry: (url) => ({ type: "http", url }),
};

export const claudeCode: Client = {
  id: "claude-code",
  label: "Claude Code",
  hasProjectScope: true,
  detect: async (env) => (await env.which("claude")) !== null,

  async read(env, scope, name) {
    if (scope === "project") return readFileEntries(env, projectFile, scope);

    const location = "Claude Code user settings";
    const result = await env.exec("claude", ["mcp", "get", name], { cwd: env.cwd, timeoutMs: CLIENT_TIMEOUT_MS });
    if (result.code === null) return { location, entries: [], failed: `\`claude mcp get ${name}\` ${result.error}` };
    // A non-zero exit means no server of that name.
    if (result.code !== 0) return { location, entries: [] };
    // `get` answers from any scope. An entry that lives in the project or
    // local scope is not the user-level one this command manages.
    const foundScope = /^\s*Scope:\s*(.+)$/im.exec(result.stdout)?.[1];
    if (foundScope && !/user/i.test(foundScope)) return { location, entries: [] };
    return { location, entries: [{ name, url: /^\s*URL:\s*(\S+)/im.exec(result.stdout)?.[1] }] };
  },

  describeAdd: (_env, scope, name, url, replacing) =>
    (replacing ? `${show("claude", removeArgs(scope, name))}, then ` : "") + show("claude", addArgs(scope, name, url)),
  async add(env, scope, name, url, replacing) {
    // `claude mcp add` refuses a name that exists, so a replace removes first.
    if (replacing) await runOrThrow(env, "claude", removeArgs(scope, name));
    await runOrThrow(env, "claude", addArgs(scope, name, url));
  },

  describeRemove: (_env, scope, name) => show("claude", removeArgs(scope, name)),
  remove: (env, scope, name) => runOrThrow(env, "claude", removeArgs(scope, name)),

  manualAdd: (_env, scope, name, url) => [`Run: claude ${addArgs(scope, name, url).join(" ")}`],
  manualRemove: (_env, scope, name) => [`Run: claude ${removeArgs(scope, name).join(" ")}`],
  nextSteps: (name) => [`In Claude Code run /mcp, pick "${name}" and sign in in the browser.`],
};
