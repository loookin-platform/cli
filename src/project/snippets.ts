import type { Project, Target } from "./detect";
import type { Workspace } from "../workspace";

/**
 * The SDK takes a slug or a full origin. A slug reads better, so it is used
 * whenever the origin is the standard `https://<slug>.loookin.com`.
 */
export function workspaceValue(workspace: Workspace): string {
  const match = /^https:\/\/([a-z0-9-]+)\.loookin\.com$/.exec(workspace.origin);
  return match ? match[1]! : workspace.origin;
}

// Both snippets are plain JavaScript that is also valid TypeScript, with no
// top-level await, so the same text works in a .ts, .js and .mjs file. The key
// is a placeholder or an environment variable: the CLI never sees a real one.

const web = (workspace: string) => `import { loookin } from "@loookin/sdk";

loookin.init({
  workspace: ${JSON.stringify(workspace)},
  key: "pub_...", // Developers → API keys → Publishable
  dryRun: true, // validates events without storing them; remove to go live
});

// After sign-in:
loookin.identify("user-id", { company: "company-id" });

// Where something worth measuring happens:
loookin.track("report_exported", { format: "pdf" });
`;

const server = (workspace: string) => `import { createClient } from "@loookin/sdk/node";

const loookin = createClient({
  workspace: ${JSON.stringify(workspace)},
  key: process.env.LOOOKIN_KEY ?? "", // server key, never commit it
  dryRun: true, // validates events without storing them; remove to go live
});

loookin.track({ event: "order_paid", company: "company-id", user: "user-id" });

// Before the process exits, inside an async function:
//   await loookin.shutdown();
`;

export const snippet = (target: Target, workspace: Workspace): string =>
  (target === "web" ? web : server)(workspaceValue(workspace));

/**
 * The SDK is ESM only. TypeScript and `"type": "module"` projects import it
 * as they are; a CommonJS project gets `.mjs`, so `import` is valid without
 * changing the project.
 */
export function extension(project: Pick<Project, "typescript" | "esm">): "ts" | "js" | "mjs" {
  if (project.typescript) return "ts";
  return project.esm ? "js" : "mjs";
}

/** `loookin.ts` for one snippet; `loookin.client.ts` and `loookin.server.ts` when the project gets both. */
export function fileName(target: Target, both: boolean, project: Pick<Project, "typescript" | "esm">): string {
  const part = both ? (target === "web" ? ".client" : ".server") : "";
  return `loookin${part}.${extension(project)}`;
}
