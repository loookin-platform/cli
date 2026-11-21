import type { Env } from "./env";
import { UsageError } from "./errors";

/**
 * Without a terminal the CLI never waits for input: the question becomes an
 * error that names the parameter to pass instead.
 */
function requireTty(env: Env, flag: string, purpose: string): void {
  if (!env.tty) throw new UsageError(`Not running in a terminal, so nothing can be asked. Pass ${flag} ${purpose}.`);
}

export async function ask(env: Env, question: string, flag: string, purpose: string): Promise<string> {
  requireTty(env, flag, purpose);
  return (await env.readLine(question)).trim();
}

const YES = /^y(es)?$/i;

/** Yes only on an explicit y; Enter means no. */
export async function confirm(env: Env, question: string): Promise<boolean> {
  requireTty(env, "--yes", "to confirm changes");
  return YES.test((await env.readLine(`${question} [y/N] `)).trim());
}

/**
 * Confirmation that can also narrow the choice: `y` takes all `count` items,
 * a list of numbers (`1,3`) takes those, anything else declines.
 * Returns zero-based indexes, or null when declined.
 */
export async function confirmSome(env: Env, question: string, count: number): Promise<number[] | null> {
  requireTty(env, "--yes", "to confirm changes");
  const all = Array.from({ length: count }, (_, i) => i);
  if (count < 2) return (await confirm(env, question)) ? all : null;

  const answer = (await env.readLine(`${question} [y = all / numbers such as 1,3 / N] `)).trim();
  if (YES.test(answer)) return all;
  if (!/^\d+(\s*[,\s]\s*\d+)*$/.test(answer)) return null;
  const picked = [...new Set(answer.split(/[,\s]+/).map((n) => Number(n) - 1))];
  return picked.every((i) => i >= 0 && i < count) ? picked.sort((a, b) => a - b) : null;
}
