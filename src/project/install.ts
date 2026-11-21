import type { Env } from "../env";
import { SDK, type PackageManager } from "./detect";

/** A package manager decides how long it needs; this only stops a hung one. */
export const INSTALL_TIMEOUT_MS = 120_000;

const VERB: Record<PackageManager, string> = { npm: "install", pnpm: "add", yarn: "add", bun: "add" };

export const installArgs = (manager: PackageManager): string[] => [VERB[manager], SDK];

export const installCommand = (manager: PackageManager): string => [manager, ...installArgs(manager)].join(" ");

/**
 * Adds the SDK with the project's own package manager, in the project
 * directory, without a shell. Returns null on success, otherwise why it failed.
 */
export async function installSdk(env: Env, manager: PackageManager): Promise<string | null> {
  const result = await env.exec(manager, installArgs(manager), { timeoutMs: INSTALL_TIMEOUT_MS, cwd: env.cwd });
  if (result.code === 0) return null;
  // The manager's own words are shown only when it failed, and only the end of them.
  const tail = (result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n");
  const reason = result.error ?? `exit code ${result.code}`;
  return tail ? `${reason}\n${tail}` : reason;
}
