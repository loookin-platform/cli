import { join } from "node:path";
import type { Env } from "../env";
import { isDirectory } from "./cursor";
import type { Client } from "./types";

function appDir(env: Env): string {
  if (env.platform === "darwin") return join(env.home, "Library", "Application Support", "Claude");
  if (env.platform === "win32") return join(env.vars.APPDATA ?? join(env.home, "AppData", "Roaming"), "Claude");
  return join(env.vars.XDG_CONFIG_HOME || join(env.home, ".config"), "Claude");
}

const WHERE = "Claude Desktop → Settings → Connectors";

// claude_desktop_config.json is documented for local servers only. A remote
// server is a connector added in the app's settings, tied to the claude.ai
// account. The only way around it through the file needs another package and
// is not documented, so the CLI writes nothing and says what to do instead.
// https://modelcontextprotocol.io/docs/develop/connect-remote-servers
export const claudeDesktop: Client = {
  id: "claude-desktop",
  label: "Claude Desktop",
  hasProjectScope: false,
  manualOnly: true,
  detect: (env) => isDirectory(appDir(env)),
  read: async () => ({ location: WHERE, entries: [] }),
  describeAdd: () => "",
  add: async () => {},
  describeRemove: () => "",
  remove: async () => {},
  manualAdd: (_env, _scope, name, url) => [
    `Claude Desktop takes remote servers only through its settings, not through a file.`,
    `Open ${WHERE} → Add custom connector, name it "${name}" and paste:`,
    `  ${url}`,
  ],
  manualRemove: (_env, _scope, name) => [`Open ${WHERE} and remove "${name}" there.`],
  nextSteps: () => [],
};
