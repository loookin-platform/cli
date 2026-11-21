import { join } from "node:path";
import type { Env } from "../env";
import { isDirectory } from "./cursor";
import * as file from "./file";
import type { Client } from "./types";

// The user profile directory of VS Code. These paths are not spelled out in
// the VS Code documentation; they are the well-known defaults. Only macOS and
// Linux are checked by hand, Windows is not.
export function userDir(env: Env): string {
  if (env.platform === "darwin") return join(env.home, "Library", "Application Support", "Code", "User");
  if (env.platform === "win32") return join(env.vars.APPDATA ?? join(env.home, "AppData", "Roaming"), "Code", "User");
  return join(env.vars.XDG_CONFIG_HOME || join(env.home, ".config"), "Code", "User");
}

// `code --add-mcp` exists but has no counterpart for removal, so the CLI
// edits mcp.json for both. Servers live under `servers` and need a `type`.
// https://code.visualstudio.com/docs/agents/reference/mcp-configuration
const spec: file.FileSpec = {
  key: "servers",
  path: (env, scope) => (scope === "user" ? join(userDir(env), "mcp.json") : join(env.cwd, ".vscode", "mcp.json")),
  entry: (url) => ({ type: "http", url }),
};

export const vscode: Client = {
  id: "vscode",
  label: "VS Code",
  hasProjectScope: true,
  detect: async (env) => (await env.which("code")) !== null || (await isDirectory(userDir(env))),
  read: (env, scope) => file.readFileEntries(env, spec, scope),
  describeAdd: (env, scope, name, url) => file.describeFileAdd(env, spec, scope, name, url),
  add: (env, scope, name, url) => file.addToFile(env, spec, scope, name, url),
  describeRemove: (env, scope, name) => file.describeFileRemove(env, spec, scope, name),
  remove: (env, scope, name) => file.removeFromFile(env, spec, scope, name),
  manualAdd: (env, scope, name, url) => file.manualFileAdd(env, spec, scope, name, url),
  manualRemove: (env, scope, name) => file.manualFileRemove(env, spec, scope, name),
  nextSteps: (name) => [
    `In VS Code run "MCP: List Servers", start "${name}" and sign in in the browser when asked.`,
  ],
};
