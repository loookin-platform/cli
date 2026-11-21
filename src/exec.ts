import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";

export interface ExecOptions {
  /** The caller decides: a client command is short, a package install is not. */
  timeoutMs: number;
  cwd?: string;
}

export interface ExecResult {
  /** Exit code; null when the process did not start, was killed or timed out. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why there is no exit code. */
  error?: string;
}

/**
 * Runs a command with an argument array and no shell, so nothing in an
 * argument is ever interpreted. Never throws: a failure is a result. Output is
 * captured, the caller decides whether to show it (only on failure).
 */
export function run(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  const { timeoutMs } = options;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const error = timedOut ? `timed out after ${timeoutMs / 1000} s` : code === null ? "killed" : undefined;
      resolve({ code: timedOut ? null : code, stdout, stderr, error });
    });
  });
}

/** Looks a command up on PATH without running anything. */
export async function which(
  command: string,
  vars: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const windows = platform === "win32";
  const extensions = windows ? (vars.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of (vars.PATH ?? vars.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, command + extension);
      try {
        await access(candidate, windows ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // Not here, keep looking.
      }
    }
  }
  return null;
}
