import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, which } from "../src/exec";
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
