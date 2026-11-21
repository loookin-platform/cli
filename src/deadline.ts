import type { Env } from "./env";
import type { ExecResult } from "./exec";

/** One shared time budget for a whole run without a terminal. */
export const RUN_DEADLINE_MS = 25_000;

/**
 * Wraps `exec` so no client command can hold a run up. Every call ends at its
 * own timeout even if the process ignores it. Without a terminal the calls
 * also share one deadline: a client that does not finish in what is left
 * fails on its own, and a run with several hanging clients still ends in time.
 */
export function bounded(env: Env, budgetMs = RUN_DEADLINE_MS): Env {
  const deadline = env.tty ? Infinity : Date.now() + budgetMs;
  return {
    ...env,
    async exec(command, args, options) {
      const left = deadline - Date.now();
      if (left <= 0) {
        const error = `not run: the ${budgetMs / 1000} s limit of this run was reached`;
        return { code: null, stdout: "", stderr: "", error };
      }
      const timeoutMs = Math.min(options.timeoutMs, left);
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<ExecResult>((resolve) => {
        const error = `timed out after ${Math.round(timeoutMs / 100) / 10} s`;
        timer = setTimeout(() => resolve({ code: null, stdout: "", stderr: "", error }), timeoutMs);
      });
      try {
        return await Promise.race([env.exec(command, args, { ...options, timeoutMs }), expired]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
