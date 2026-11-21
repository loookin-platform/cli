import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KILL_GRACE_MS, resolveCommand, run, runCommand, which } from "../src/exec";
import { confirm, confirmSome } from "../src/prompt";
import { fakeEnv } from "./helpers";

// The only process these tests start is Node itself.
const node = process.execPath;

describe("run", () => {
  it("passes arguments as they are, without a shell", async () => {
    const tricky = ["$(echo no)", "a b", ";", "`x`", "&&"];
    const result = await run(node, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...tricky], { timeoutMs: 10_000 });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(tricky);
  });

  it("returns the exit code and stderr instead of throwing", async () => {
    const result = await run(node, ["-e", "console.error('bad'); process.exit(3)"], { timeoutMs: 10_000 });
    expect(result).toMatchObject({ code: 3, stderr: "bad\n" });
  });

  it("stops a process at the given timeout", async () => {
    const result = await run(node, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 200 });
    expect(result).toMatchObject({ code: null, error: "timed out after 0.2 s" });
  });

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // Enough for Node to start and print; far below the minute the scripts would take.
  const TIMEOUT = 1_500;
  const LIMIT = TIMEOUT + KILL_GRACE_MS + 1_000;

  it("kills a process that ignores the request to stop", async () => {
    const stubborn = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)";
    const started = Date.now();
    const result = await run(node, ["-e", stubborn], { timeoutMs: TIMEOUT });
    expect(Date.now() - started).toBeLessThan(LIMIT);
    expect(result).toMatchObject({ code: null, error: "timed out after 1.5 s" });
    const pid = Number(result.stdout);
    expect(pid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(pid)).toBe(false);
  });

  it("returns when a grandchild keeps the output open", async () => {
    // The child ends on SIGTERM; the process it started holds the same stdout.
    const holder = "setTimeout(() => {}, 20000)";
    const parent = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(holder)}], { stdio: 'inherit' }); console.log(c.pid); setTimeout(() => {}, 60000)`;
    const started = Date.now();
    const result = await run(node, ["-e", parent], { timeoutMs: TIMEOUT });
    try {
      expect(Date.now() - started).toBeLessThan(LIMIT);
      expect(result).toMatchObject({ code: null, error: "timed out after 1.5 s" });
    } finally {
      const pid = Number(result.stdout);
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 30_000);

  it("reports a command that does not exist", async () => {
    const env = fakeEnv();
    const result = await run(join(env.root, "no-such-command"), [], { timeoutMs: 1_000 });
    expect(result.code).toBeNull();
    expect(result.error).toMatch(/ENOENT/);
  });
});

describe("which", () => {
  it("finds an executable on the given PATH only", async () => {
    const env = fakeEnv();
    const bin = join(env.root, "bin");
    env.write(join(bin, "claude"), "#!/bin/sh\n");
    env.write(join(bin, "notes.txt"), "");
    chmodSync(join(bin, "claude"), 0o755);
    writeFileSync(join(bin, "plain"), "");
    chmodSync(join(bin, "plain"), 0o644);

    const vars = { PATH: `${join(env.root, "empty")}:${bin}` };
    expect(await which("claude", vars, "linux")).toBe(join(bin, "claude"));
    expect(await which("plain", vars, "linux")).toBeNull();
    expect(await which("codex", vars, "linux")).toBeNull();
    expect(await which("claude", {}, "linux")).toBeNull();
  });
});

describe("resolveCommand", () => {
  it("spawns the full path, and the bare name when the command is not on PATH", () => {
    expect(resolveCommand("claude", ["mcp"], "/usr/local/bin/claude", "linux")).toEqual({ file: "/usr/local/bin/claude" });
    expect(resolveCommand("claude", ["mcp"], null, "win32")).toEqual({ file: "claude" });
    expect(resolveCommand("node", [], "C:\\node\\node.EXE", "win32")).toEqual({ file: "C:\\node\\node.EXE" });
    // Elsewhere the extension means nothing.
    expect(resolveCommand("tool", [], "/opt/bin/tool.cmd", "linux")).toEqual({ file: "/opt/bin/tool.cmd" });
  });

  it.each(["C:\\npm\\npm.cmd", "C:\\npm\\npm.CMD", "C:\\tools\\claude.bat"])("refuses %s on Windows and names the command to run", (found) => {
    const result = resolveCommand("npm", ["install", "@loookin/sdk"], found, "win32");
    expect(result).toEqual({ error: expect.stringContaining("Run it yourself: npm install @loookin/sdk") });
    expect(result).toEqual({ error: expect.stringContaining(found) });
  });

  it("finds a Windows shim on PATH and does not start it", async () => {
    const env = fakeEnv();
    const bin = join(env.root, "bin");
    // Would leave a file behind if anything ran it.
    env.write(join(bin, "pnpm.CMD"), `#!/bin/sh\ntouch "${join(env.root, "ran")}"\n`);
    chmodSync(join(bin, "pnpm.CMD"), 0o755);

    const result = await runCommand("pnpm", ["add", "@loookin/sdk"], { timeoutMs: 5_000 }, { PATH: bin, PATHEXT: ".EXE;.CMD" }, "win32");
    expect(result.code).toBeNull();
    expect(result.error).toContain("Run it yourself: pnpm add @loookin/sdk");
    expect(existsSync(join(env.root, "ran"))).toBe(false);
  });

  it("runs a command given as a path as it is", async () => {
    const result = await runCommand(node, ["-e", "console.log('ok')"], { timeoutMs: 10_000 }, {}, process.platform);
    expect(result).toMatchObject({ code: 0, stdout: "ok\n" });
  });
});

describe("prompts", () => {
  it("take yes only on an explicit y", async () => {
    for (const [answer, expected] of [["y", true], ["YES", true], ["", false], ["n", false], ["yep", false]] as const) {
      expect(await confirm(fakeEnv({ tty: true, answers: [answer] }), "Go?")).toBe(expected);
    }
  });

  it("pick a subset by numbers", async () => {
    const pick = (answer: string, count = 3) => confirmSome(fakeEnv({ tty: true, answers: [answer] }), "Go?", count);
    expect(await pick("y")).toEqual([0, 1, 2]);
    expect(await pick("3, 1")).toEqual([0, 2]);
    expect(await pick("2 2")).toEqual([1]);
    expect(await pick("4")).toBeNull();
    expect(await pick("0")).toBeNull();
    expect(await pick("")).toBeNull();
    expect(await pick("1", 1)).toBeNull();
  });

  it("refuse to ask without a terminal", async () => {
    await expect(confirm(fakeEnv(), "Go?")).rejects.toThrow(/--yes/);
  });
});
