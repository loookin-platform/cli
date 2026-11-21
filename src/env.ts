import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { run, which, type ExecOptions, type ExecResult } from "./exec";

/**
 * Everything the CLI touches outside its own code. Commands take it as a
 * parameter, so tests swap in a temp directory, fake processes and a fake
 * fetch, and never reach the real home directory or the network.
 */
export interface Env {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  vars: Record<string, string | undefined>;
  /** False when stdin is not a terminal: the CLI must not ask anything. */
  tty: boolean;
  out(text: string): void;
  err(text: string): void;
  readLine(question: string): Promise<string>;
  fetch: typeof fetch;
  exec(command: string, args: string[], options: ExecOptions): Promise<ExecResult>;
  /** Full path of a command on PATH, or null. */
  which(command: string): Promise<string | null>;
}

export function realEnv(): Env {
  const vars = process.env;
  return {
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    vars,
    tty: process.stdin.isTTY === true,
    out: (text) => void process.stdout.write(`${text}\n`),
    err: (text) => void process.stderr.write(`${text}\n`),
    async readLine(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    fetch: (input, init) => fetch(input, init),
    exec: (command, args, options) => run(command, args, { cwd: process.cwd(), ...options }),
    which: (command) => which(command, vars, process.platform),
  };
}
