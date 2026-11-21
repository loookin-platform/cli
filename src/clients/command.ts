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

/**
 * Adds an entry, or replaces one. The clients refuse a name that exists, so a
 * replace removes first. Between the two commands the entry is gone: when the
 * add fails, the old address is put back, and the message carries the command
 * that restores it either way.
 */
export async function addOrReplace(
  env: Env,
  command: string,
  removeArgs: string[],
  addArgs: (url: string) => string[],
  url: string,
  replacing: boolean,
  previousUrl: string | undefined,
): Promise<void> {
  if (!replacing) return runOrThrow(env, command, addArgs(url));
  await runOrThrow(env, command, removeArgs);
  try {
    await runOrThrow(env, command, addArgs(url));
  } catch (error) {
    const reason = (error as Error).message;
    if (!previousUrl) {
      throw new CliError(`${reason}\nThe previous entry was removed and had no address to put back. Set it up again in the client.`);
    }
    const restore = [command, ...addArgs(previousUrl)].join(" ");
    const restored = await runOrThrow(env, command, addArgs(previousUrl)).then(
      () => true,
      () => false,
    );
    throw new CliError(
      restored
        ? `${reason}\nThe previous entry (${previousUrl}) was put back with: ${restore}`
        : `${reason}\nThe previous entry (${previousUrl}) was removed and could not be put back. Restore it with: ${restore}`,
    );
  }
}
