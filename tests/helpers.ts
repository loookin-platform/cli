import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Env } from "../src/env";
import type { ExecResult } from "../src/exec";

export interface Call {
  command: string;
  args: string[];
  timeoutMs: number;
}

type Exec = (call: Call) => Partial<ExecResult> | Promise<Partial<ExecResult>>;

export interface Fake extends Env {
  root: string;
  outLines: string[];
  errLines: string[];
  /** stdout and stderr together, for "is there anything secret in here" checks. */
  text(): string;
  calls: Call[];
  questions: string[];
  fetched: string[];
  write(path: string, content: string): void;
  read(path: string): string;
}

export interface FakeOptions {
  tty?: boolean;
  platform?: NodeJS.Platform;
  /** Commands "on PATH". */
  installed?: string[];
  /** Answers to prompts, in order. Running out is a test failure. */
  answers?: string[];
  exec?: Exec;
  fetch?: (url: string) => Response | Promise<Response>;
  vars?: Record<string, string>;
}

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** The discovery answer of a real workspace. */
export const loookin = (url: string) => json(200, { resource: `${new URL(url).origin}/api/mcp` });

/**
 * An Env over a fresh temp directory: fake home, fake project, fake PATH,
 * fake processes and fake fetch. Nothing here can reach the real machine.
 */
export function fakeEnv(options: FakeOptions = {}): Fake {
  const root = mkdtempSync(join(tmpdir(), "loookin-cli-test-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  const answers = [...(options.answers ?? [])];
  const fake: Fake = {
    root,
    home,
    cwd,
    platform: options.platform ?? "linux",
    vars: options.vars ?? {},
    tty: options.tty ?? false,
    outLines: [],
    errLines: [],
    calls: [],
    questions: [],
    fetched: [],
    text: () => [...fake.outLines, ...fake.errLines].join("\n"),
    out: (text) => void fake.outLines.push(text),
    err: (text) => void fake.errLines.push(text),
    async readLine(question) {
      fake.questions.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`Unexpected prompt: ${question}`);
      return answer;
    },
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      fake.fetched.push(url);
      return (options.fetch ?? loookin)(url);
    }) as typeof fetch,
    async exec(command, args, opts) {
      const call = { command, args, timeoutMs: opts.timeoutMs };
      fake.calls.push(call);
      const result = (await options.exec?.(call)) ?? {};
      return { code: 0, stdout: "", stderr: "", ...result };
    },
    which: async (command) => (options.installed?.includes(command) ? `/fake/bin/${command}` : null),
    write(path, content) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
    read: (path) => readFileSync(path, "utf8"),
  };
  return fake;
}

/** A Cursor config with comments, another server and its own formatting. */
export const CURSOR_FIXTURE = `{
    // My servers
    "mcpServers": {
        "github": { "command": "npx", "args": ["-y", "gh-mcp"] }, // local
        /* remote */
        "sentry": {
            "url": "https://mcp.sentry.dev/mcp"
        }
    },
    "other": [1, 2,   3]
}
`;

/** Shell-style commands as one string each, for readable assertions. */
export const commands = (fake: Fake) => fake.calls.map((c) => [c.command, ...c.args].join(" "));
