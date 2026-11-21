import type { Env } from "../env";
import { CliError } from "../errors";

/** How long one `claude` or `codex` call may take. */
export const CLIENT_TIMEOUT_MS = 10_000;

/** A command as shown in the plan. Arguments never pass through a shell. */
export const show = (command: string, args: string[]) => `run: ${[command, ...args].join(" ")}`;

/** Runs a client's own command; its output is shown only when it fails. */
export async function runOrThrow(env: Env, command: string, args: string[]): Promise<void> {
  const result = await env.exec(command, args, { cwd: env.cwd, timeoutMs: CLIENT_TIMEOUT_MS });
  if (result.code === 0) return;
  const output = (result.stderr.trim() || result.stdout.trim()).trim();
  const why = result.error ?? `exit code ${result.code}`;
  throw new CliError(`\`${[command, ...args].join(" ")}\` failed (${why})${output ? `:\n${output}` : "."}`);
}
