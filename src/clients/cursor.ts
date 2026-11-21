import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as file from "./file";
import type { Client } from "./types";

// Cursor has no command for adding a server, so the CLI edits its file.
// A remote server is an entry with `url` and no `type`.
// https://cursor.com/docs/context/mcp
const spec: file.FileSpec = {
  key: "mcpServers",
  path: (env, scope) => join(scope === "user" ? env.home : env.cwd, ".cursor", "mcp.json"),
  entry: (url) => ({ url }),
};

export const isDirectory = (path: string) =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );

export const cursor: Client = {
  id: "cursor",
  label: "Cursor",
  hasProjectScope: true,
  detect: (env) => isDirectory(join(env.home, ".cursor")),
  read: (env, scope) => file.readFileEntries(env, spec, scope),
  describeAdd: (env, scope, name, url) => file.describeFileAdd(env, spec, scope, name, url),
  add: (env, scope, name, url) => file.addToFile(env, spec, scope, name, url),
  describeRemove: (env, scope, name) => file.describeFileRemove(env, spec, scope, name),
  remove: (env, scope, name) => file.removeFromFile(env, spec, scope, name),
  manualAdd: (env, scope, name, url) => file.manualFileAdd(env, spec, scope, name, url),
  manualRemove: (env, scope, name) => file.manualFileRemove(env, spec, scope, name),
  nextSteps: (name) => [
    `Restart Cursor, open Settings → MCP and sign in to "${name}" in the browser when asked.`,
  ],
};
