import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Env } from "../env";
import { CliError } from "../errors";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type Target = "web" | "server";
export type ProjectKind = Target | "both";

export interface Project {
  dir: string;
  manager: PackageManager;
  /** Where the manager came from, for the printout. */
  managerSource: string;
  /** Null when no known framework is in the dependencies: the user says. */
  kind: ProjectKind | null;
  /** The dependencies the kind was read from. */
  evidence: string[];
  typescript: boolean;
  /** `"type": "module"` in the manifest. */
  esm: boolean;
  hasSrc: boolean;
  sdkInstalled: boolean;
}

export const SDK = "@loookin/sdk";

const MANAGERS: PackageManager[] = ["npm", "pnpm", "yarn", "bun"];
const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

const WEB = ["react", "vue", "svelte", "vite", "@angular/core", "astro"];
const SERVER = ["express", "fastify", "hono", "koa", "@nestjs/core"];
const BOTH = ["next", "nuxt", "@sveltejs/kit"];
const isBoth = (name: string) => BOTH.includes(name) || name.startsWith("@remix-run/");

const names = (value: unknown) => (typeof value === "object" && value !== null ? Object.keys(value) : []);

type Manager = Pick<Project, "manager" | "managerSource">;

/** `packageManager` of a manifest: "pnpm@9.1.0+sha512..." → "pnpm". */
const declaredIn = (manifest: Record<string, unknown> | null) =>
  typeof manifest?.packageManager === "string" ? manifest.packageManager.split("@")[0] : undefined;

function readManifest(dir: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * What one directory says about the package manager. The `packageManager`
 * field is the project's own statement, so it wins over a lockfile. `where`
 * is appended to the source when the directory is not the project itself.
 */
function managerIn(dir: string, manifest: Record<string, unknown> | null, where: string): Manager | undefined {
  const known = MANAGERS.find((name) => name === declaredIn(manifest));
  if (known) return { manager: known, managerSource: `packageManager in package.json${where}` };
  for (const [file, name] of LOCKFILES) {
    if (existsSync(join(dir, file))) return { manager: name, managerSource: `${file}${where}` };
  }
  if (existsSync(join(dir, "pnpm-workspace.yaml"))) return { manager: "pnpm", managerSource: `pnpm-workspace.yaml${where}` };
  return undefined;
}

/**
 * The package manager of the project in `dir`. An app inside a monorepo has
 * no lockfile of its own, so the directories above are asked too, nearest
 * first, up to the root of the repository (the directory with `.git`).
 */
function manager(dir: string, manifest: Record<string, unknown>): Manager {
  const own = managerIn(dir, manifest, "");
  if (own) return own;
  for (let at = dir; !existsSync(join(at, ".git")) && dirname(at) !== at; ) {
    at = dirname(at);
    const parent = readManifest(at);
    const found = managerIn(at, parent, ` in ${at}`);
    if (found) return found;
    // A workspace root that names no manager: nothing above it belongs to this project.
    if (parent?.workspaces !== undefined) break;
  }
  // An unknown manager cannot be driven by this CLI; npm reads any package.json.
  const declared = declaredIn(manifest);
  return { manager: "npm", managerSource: declared ? `"${declared}" in packageManager is not supported` : "default" };
}

function kind(deps: string[]): Pick<Project, "kind" | "evidence"> {
  const both = deps.filter(isBoth);
  if (both.length) return { kind: "both", evidence: both };
  const web = deps.filter((name) => WEB.includes(name));
  const server = deps.filter((name) => SERVER.includes(name));
  if (web.length && server.length) return { kind: "both", evidence: [...web, ...server] };
  if (web.length) return { kind: "web", evidence: web };
  if (server.length) return { kind: "server", evidence: server };
  return { kind: null, evidence: [] };
}

/**
 * Reads what `init` needs to know about the project in the current directory.
 * Only looks: the manifest and the presence of a few files. Refuses a
 * directory without a manifest and a monorepo root, where a dependency would
 * land in the wrong place.
 */
export async function detectProject(env: Env): Promise<Project> {
  const dir = env.cwd;
  let text: string;
  try {
    text = await readFile(join(dir, "package.json"), "utf8");
  } catch {
    throw new CliError(`No package.json in ${dir}. Run loookin init in the directory of your app. Nothing was installed.`);
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new CliError(`package.json in ${dir} is not valid JSON. Nothing was installed.`);
  }
  if (manifest.workspaces !== undefined || existsSync(join(dir, "pnpm-workspace.yaml"))) {
    throw new CliError(
      "This is the root of a monorepo. Run loookin init in the directory of the app that should send events. Nothing was installed.",
    );
  }

  const dependencies = names(manifest.dependencies);
  const all = [...dependencies, ...names(manifest.devDependencies)];
  return {
    dir,
    ...manager(dir, manifest),
    ...kind(all),
    typescript: existsSync(join(dir, "tsconfig.json")),
    esm: manifest.type === "module",
    hasSrc: existsSync(join(dir, "src")),
    sdkInstalled: all.includes(SDK),
  };
}
