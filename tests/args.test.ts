import { describe, expect, it } from "vitest";
import { parse } from "../src/args";
import { runCli } from "../src/cli";
import { UsageError } from "../src/errors";
import { fakeEnv } from "./helpers";

describe("parse", () => {
  it("reads every flag of mcp add", () => {
    const argv = ["mcp", "add", "--workspace", "acme", "--client", "cursor", "--client", "vscode", "--project", "--name", "x", "--yes", "--dry-run"];
    expect(parse(argv)).toMatchObject({
      kind: "run",
      command: "mcp add",
      flags: { workspace: "acme", client: ["cursor", "vscode"], project: true, name: "x", yes: true, dryRun: true },
    });
    expect(parse(["mcp", "add"])).toMatchObject({ flags: { client: [], project: false, yes: false, dryRun: false } });
  });

  it("keeps the final shape of init", () => {
    expect(parse(["init", "--workspace", "acme", "--target", "server", "--no-install", "--no-file", "--yes", "--dry-run"])).toMatchObject({
      command: "init",
      flags: { workspace: "acme", target: "server", noInstall: true, noFile: true, yes: true, dryRun: true },
    });
    expect(() => parse(["init", "--target", "desktop"])).toThrow(UsageError);
  });

  it.each([
    [[], "root"],
    [["--help"], "root"],
    [["mcp"], "mcp"],
    [["mcp", "--help"], "mcp"],
    [["mcp", "add", "--help"], "mcp add"],
    [["mcp", "list", "-h"], "mcp list"],
    [["mcp", "remove", "--yes", "--help"], "mcp remove"],
    [["init", "--help"], "init"],
  ])("%j → help for %s", (argv, topic) => {
    expect(parse(argv)).toEqual({ kind: "help", topic });
  });

  it.each([
    [["deploy"]],
    [["mcp", "install"]],
    [["mcp", "add", "--workspce", "acme"]],
    [["mcp", "add", "acme"]],
    [["mcp", "list", "--yes"]],
    [["mcp", "remove", "--workspace", "acme"]],
    [["mcp", "add", "--workspace"]],
  ])("%j is a usage error", (argv) => {
    expect(() => parse(argv)).toThrow(UsageError);
  });
});

describe("runCli", () => {
  it("prints the version and help with exit code 0", async () => {
    const env = fakeEnv();
    expect(await runCli(["--version"], env, "1.2.3")).toBe(0);
    expect(env.outLines).toEqual(["1.2.3"]);
    expect(await runCli(["mcp", "add", "--help"], env, "1.2.3")).toBe(0);
    expect(env.outLines.join("\n")).toContain("Usage: loookin mcp add");
    for (const flag of ["--workspace", "--client", "--project", "--name", "--yes", "--dry-run"]) {
      expect(env.outLines.join("\n")).toContain(flag);
    }
  });

  it("exits 2 on wrong parameters and says where the help is", async () => {
    const env = fakeEnv();
    expect(await runCli(["mcp", "add", "--nope"], env, "0")).toBe(2);
    expect(env.errLines.join("\n")).toContain("loookin mcp add --help");
    expect(await runCli(["mcp", "add", "--workspace", "http://acme.loookin.com", "--yes"], env, "0")).toBe(2);
  });

  it("init says it is not available yet and exits 1", async () => {
    const env = fakeEnv();
    expect(await runCli(["init", "--workspace", "acme"], env, "0")).toBe(1);
    expect(env.errLines.join("\n")).toContain("not available yet");
  });
});
