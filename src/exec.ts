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

/** How long a process gets to end after SIGTERM before it is killed. */
export const KILL_GRACE_MS = 500;

/**
 * Runs a command with an argument array and no shell, so nothing in an
 * argument is ever interpreted. Never throws: a failure is a result. Output is
 * captured, the caller decides whether to show it (only on failure).
 *
 * At the timeout the process is asked to end and, if it does not, killed.
 * Either way the call returns and lets go of the process: one that ignores
 * the signal, or a child of its own that keeps the output open, must not keep
 * this program running.
 */
export function run(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  const { timeoutMs } = options;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;
    const child = spawn(command, args, { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (result: ExecResult) => {
      clearTimeout(timer);
      clearTimeout(killer);
      resolve(result);
    };
    const expired = () => {
      // Whatever still holds the pipes is no longer listened to.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish({ code: null, stdout, stderr, error: `timed out after ${timeoutMs / 1000} s` });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killer = setTimeout(() => {
        child.kill("SIGKILL");
        expired();
      }, KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => finish({ code: null, stdout, stderr, error: error.message }));
    // "close" waits for the pipes, which a grandchild may hold for as long as it likes.
    child.on("exit", () => {
      if (timedOut) expired();
    });
    child.on("close", (code) => finish({ code, stdout, stderr, error: code === null ? "killed" : undefined }));
  });
}

export type Resolved = { file: string } | { error: string };

/**
 * What to hand to `spawn` for a command. The full path from PATH, so that on
 * Windows it carries its extension. A `.cmd` or `.bat` shim (npm, pnpm, yarn,
 * claude) cannot be started without a shell, and a shell would interpret the
 * arguments, so it is not started at all: the user gets the command to run.
 */
export function resolveCommand(command: string, args: string[], found: string | null, platform: NodeJS.Platform): Resolved {
  if (!found) return { file: command };
  if (platform === "win32" && /\.(cmd|bat)$/i.test(found)) {
    const error = `${found} is a batch file, which cannot be started safely from here. Run it yourself: ${[command, ...args].join(" ")}`;
    return { error };
  }
  return { file: found };
}

/** `run` for a command name: looked up on PATH first, see `resolveCommand`. */
export async function runCommand(
  command: string,
  args: string[],
  options: ExecOptions,
  vars: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): Promise<ExecResult> {
  const isPath = command.includes("/") || (platform === "win32" && command.includes("\\"));
  const target = resolveCommand(command, args, isPath ? null : await which(command, vars, platform), platform);
  if ("error" in target) return { code: null, stdout: "", stderr: "", error: target.error };
  return run(target.file, args, options);
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
