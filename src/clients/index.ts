import type { Env } from "../env";
import { UsageError } from "../errors";
import { claudeCode } from "./claude-code";
import { claudeDesktop } from "./claude-desktop";
import { codex } from "./codex";
import { cursor } from "./cursor";
import type { Client, ClientId } from "./types";
import { vscode } from "./vscode";

export const CLIENTS: Client[] = [claudeCode, codex, cursor, vscode, claudeDesktop];

export const CLIENT_IDS = CLIENTS.map((client) => client.id);

export const SERVER_NAME = "loookin";

/** The server name becomes a config key and a command argument. */
export function checkName(name: string | undefined): string {
  const value = name ?? SERVER_NAME;
  if (!/^[a-z0-9-]+$/.test(value)) throw new UsageError("--name may contain only a-z, 0-9 and hyphens.");
  return value;
}

export interface Target {
  client: Client;
  installed: boolean;
}

/**
 * The clients a command works on: the ones named with --client (installed or
 * not, so a missing one is reported), otherwise every installed one.
 */
export async function findTargets(env: Env, wanted: string[]): Promise<Target[]> {
  const unknown = wanted.filter((id) => !CLIENT_IDS.includes(id as ClientId));
  if (unknown.length) {
    throw new UsageError(`Unknown client: ${unknown.join(", ")}. Supported: ${CLIENT_IDS.join(", ")}.`);
  }
  const all = await Promise.all(
    CLIENTS.map(async (client) => ({ client, installed: await client.detect(env) })),
  );
  return wanted.length ? all.filter((t) => wanted.includes(t.client.id)) : all.filter((t) => t.installed);
}

/** One aligned line of a plan or a listing. */
export const row = (label: string, state: string, detail = "") =>
  `  ${label.padEnd(16)}${state.padEnd(14)}${detail}`.trimEnd();
