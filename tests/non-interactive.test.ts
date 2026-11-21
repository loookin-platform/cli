import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import { bounded } from "../src/deadline";
import { commands, fakeEnv, type Fake, type FakeOptions } from "./helpers";

const URL = "https://acme.loookin.com/api/mcp";
const run = (env: Fake, ...argv: string[]) => runCli(argv, env, "0.0.0");

/** No terminal: any prompt throws in the fake, so a pass proves nothing was asked. */
function machine(options: FakeOptions = {}) {
  const env = fakeEnv({ tty: false, ...options });
  mkdirSync(join(env.home, ".cursor"));
  return Object.assign(env, { cursorFile: join(env.home, ".cursor", "mcp.json") });
}

const tree = (env: Fake) => (readdirSync(env.root, { recursive: true }) as string[]).sort();

afterEach(() => vi.useRealTimers());

describe("without a terminal", () => {
  it("names the missing --workspace, exits 2 and does nothing", async () => {
    const env = machine();
    const before = tree(env);
    expect(await run(env, "mcp", "add", "--yes")).toBe(2);
    expect(env.errLines.join("\n")).toContain("--workspace");
    expect(env.questions).toEqual([]);
    expect(env.fetched).toEqual([]);
    expect(tree(env)).toEqual(before);
  });

  it("refuses to change anything without --yes", async () => {
    const env = machine();
    const before = tree(env);
    expect(await run(env, "mcp", "add", "--workspace", "acme")).toBe(2);
    expect(env.errLines.join("\n")).toContain("--yes");
    expect(await run(env, "mcp", "remove")).toBe(2);
    expect(env.questions).toEqual([]);
    expect(env.fetched).toEqual([]);
    expect(tree(env)).toEqual(before);
  });

  it("runs to the end with everything in parameters", async () => {
    const env = machine();
    expect(await run(env, "mcp", "add", "--workspace", "acme", "--client", "cursor", "--yes")).toBe(0);
    expect(JSON.parse(env.read(env.cursorFile))).toEqual({ mcpServers: { loookin: { url: URL } } });
    expect(await run(env, "mcp", "list")).toBe(0);
    expect(await run(env, "mcp", "remove", "--yes")).toBe(0);
    expect(JSON.parse(env.read(env.cursorFile))).toEqual({ mcpServers: {} });
    expect(env.questions).toEqual([]);
  });

  it("--dry-run needs no --yes", async () => {
    const env = machine();
    const before = tree(env);
    expect(await run(env, "mcp", "add", "--workspace", "acme", "--dry-run")).toBe(0);
    expect(await run(env, "mcp", "remove", "--dry-run")).toBe(0);
    expect(tree(env)).toEqual(before);
  });

  it("with --yes replaces another address and goes on past a failed workspace check", async () => {
    const env = machine({ fetch: () => new Response("nope", { status: 404 }) });
    env.write(env.cursorFile, '{ "mcpServers": { "loookin": { "url": "https://old.loookin.com/api/mcp" } } }');
    expect(await run(env, "mcp", "add", "--workspace", "acme", "--yes")).toBe(0);
    expect(env.errLines.join("\n")).toContain("Continuing because --yes was given.");
    expect(JSON.parse(env.read(env.cursorFile)).mcpServers.loookin.url).toBe(URL);
  });
});

describe("time limits", () => {
  const never = () => new Promise<never>(() => {});

  /**
   * Runs a command under fake timers and returns its exit code and how long
   * it took on the fake clock. File access is real, so the clock moves only
   * when the run is waiting on a timer, straight to that timer.
   */
  async function timed(start: () => Promise<number>): Promise<{ code: number; elapsed: number }> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const started = Date.now();
    let outcome: { code: number; elapsed: number } | undefined;
    void start().then((code) => (outcome = { code, elapsed: Date.now() - started }));
    while (!outcome) {
      if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
      else await new Promise((resolve) => setImmediate(resolve));
    }
    return outcome;
  }

  it("hanging client commands cannot push a run past its deadline", async () => {
    const env = machine({
      installed: ["claude", "codex"],
      // `claude mcp get` answers "not set" after 9 s; every other command hangs forever.
      exec: ({ args }) =>
        args[1] === "get" ? new Promise((resolve) => setTimeout(() => resolve({ code: 1 }), 9_000)) : never(),
    });
    const { code, elapsed } = await timed(() => run(env, "mcp", "add", "--workspace", "acme", "--yes"));

    expect(code).toBe(1);
    expect(elapsed).toBe(25_000);
    // 9 s, then 10 s for the hanging `claude mcp add`, and Codex gets only the 6 s that are left.
    expect(env.calls.map((c) => [c.command, c.args[1], c.timeoutMs])).toEqual([
      ["claude", "get", 10_000],
      ["claude", "add", 10_000],
      ["codex", "add", 6_000],
    ]);
    const errors = env.errLines.join("\n");
    expect(errors).toMatch(/Claude Code: .*timed out after 10 s/);
    expect(errors).toMatch(/Codex: .*timed out after 6 s/);
    // The file client does not depend on any of it.
    expect(JSON.parse(env.read(env.cursorFile)).mcpServers.loookin.url).toBe(URL);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a client that cannot be read is a failure of that client, exit code 1", async () => {
    const env = machine({ installed: ["claude", "codex"], exec: never });
    env.write(join(env.home, ".codex", "config.toml"), `[mcp_servers.loookin]\nurl = "${URL}"\n`);
    const { code, elapsed } = await timed(() => run(env, "mcp", "remove", "--yes"));

    expect(code).toBe(1);
    expect(elapsed).toBe(20_000); // `claude mcp get` and `codex mcp remove`, 10 s each
    expect(env.outLines.join("\n")).toMatch(/Claude Code\s+failed\s+`claude mcp get loookin` timed out after 10 s/);
  });

  it("does not start a command once the budget is spent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const base = fakeEnv({ exec: never });
    const env = bounded(base, 15_000);
    const calls = [env.exec("a", [], { timeoutMs: 10_000 }), env.exec("b", [], { timeoutMs: 10_000 })];
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await calls[0])?.error).toBe("timed out after 10 s");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await env.exec("c", [], { timeoutMs: 10_000 })).toMatchObject({ code: null, error: expect.stringContaining("15 s limit") });
    expect(commands(base)).toEqual(["a", "b"]);
  });

  it("in a terminal only the per-command timeout applies", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const base = fakeEnv({ tty: true, exec: () => ({ code: 0 }) });
    const env = bounded(base, 1_000);
    await vi.advanceTimersByTimeAsync(5_000); // a person reading a prompt
    expect(await env.exec("a", [], { timeoutMs: 10_000 })).toMatchObject({ code: 0 });
    expect(base.calls[0]?.timeoutMs).toBe(10_000);
  });
});
