import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { cursor } from "../../src/clients/cursor";
import { vscode } from "../../src/clients/vscode";
import { CURSOR_FIXTURE, fakeEnv } from "../helpers";

const URL = "https://acme.loookin.com/api/mcp";

describe("cursor", () => {
  it("is found by its directory in the home folder", async () => {
    const env = fakeEnv();
    expect(await cursor.detect(env)).toBe(false);
    mkdirSync(join(env.home, ".cursor"));
    expect(await cursor.detect(env)).toBe(true);
  });

  it("writes a URL-only entry to the user file, or the project file", async () => {
    const env = fakeEnv();
    await cursor.add(env, "user", "loookin", URL, false);
    expect(JSON.parse(env.read(join(env.home, ".cursor", "mcp.json")))).toEqual({ mcpServers: { loookin: { url: URL } } });

    await cursor.add(env, "project", "loookin", URL, false);
    expect(JSON.parse(env.read(join(env.cwd, ".cursor", "mcp.json")))).toEqual({ mcpServers: { loookin: { url: URL } } });
  });

  it("reads entries, adds next to them and removes back to the original", async () => {
    const env = fakeEnv();
    const path = join(env.home, ".cursor", "mcp.json");
    env.write(path, CURSOR_FIXTURE);

    expect((await cursor.read(env, "user", "loookin")).entries).toEqual([
      { name: "github", url: undefined },
      { name: "sentry", url: "https://mcp.sentry.dev/mcp" },
    ]);

    await cursor.add(env, "user", "loookin", URL, false);
    await cursor.add(env, "user", "loookin", URL, false); // again: no duplicate
    const servers = parse(env.read(path)).mcpServers;
    expect(Object.keys(servers)).toEqual(["github", "sentry", "loookin"]);
    expect(env.read(path).match(/loookin/g)).toHaveLength(2); // the key and the host

    await cursor.remove(env, "user", "loookin");
    expect(env.read(path)).toBe(CURSOR_FIXTURE);
  });

  it.each([
    ["broken JSON", '{ "mcpServers": { '],
    ["servers that are not an object", '{ "mcpServers": [] }'],
  ])("refuses %s and leaves the file as it is", async (_label, content) => {
    const env = fakeEnv();
    const path = join(env.home, ".cursor", "mcp.json");
    env.write(path, content);
    expect((await cursor.read(env, "user", "loookin")).unreadable).toBeTruthy();
    await expect(cursor.add(env, "user", "loookin", URL, false)).rejects.toThrow(/left untouched/);
    await expect(cursor.remove(env, "user", "loookin")).rejects.toThrow(/left untouched/);
    expect(env.read(path)).toBe(content);
    expect(cursor.manualAdd(env, "user", "loookin", URL).join("\n")).toContain(`"loookin": {"url":"${URL}"}`);
  });

  it("leaves a read-only file alone and says what to do by hand", async () => {
    const env = fakeEnv();
    const path = join(env.home, ".cursor", "mcp.json");
    env.write(path, CURSOR_FIXTURE);
    chmodSync(path, 0o444);

    const refused = cursor.add(env, "user", "loookin", URL, false);
    await expect(refused).rejects.toThrow(/read-only/);
    await expect(refused).rejects.toThrow(`Add this under "mcpServers" in ${path}:\n  "loookin": {"url":"${URL}"}`);
    expect(env.read(path)).toBe(CURSOR_FIXTURE);
    expect(statSync(path).mode & 0o777).toBe(0o444);

    await expect(cursor.remove(env, "user", "github")).rejects.toThrow(`Delete "github" under "mcpServers" in ${path}.`);
    expect(env.read(path)).toBe(CURSOR_FIXTURE);
  });

  it("reads and edits a file that starts with a byte order mark, and keeps the mark", async () => {
    const env = fakeEnv();
    const path = join(env.home, ".cursor", "mcp.json");
    const original = `\uFEFF${CURSOR_FIXTURE}`;
    env.write(path, original);

    expect((await cursor.read(env, "user", "loookin")).unreadable).toBeUndefined();
    await cursor.add(env, "user", "loookin", URL, false);
    expect(env.read(path).startsWith("\uFEFF{")).toBe(true);
    expect(parse(env.read(path).slice(1)).mcpServers.loookin).toEqual({ url: URL });
    await cursor.remove(env, "user", "loookin");
    expect(env.read(path)).toBe(original);
  });

  it("removing from a missing file creates nothing", async () => {
    const env = fakeEnv();
    await cursor.remove(env, "user", "loookin");
    expect(() => env.read(join(env.home, ".cursor", "mcp.json"))).toThrow();
  });
});

describe("vscode", () => {
  it.each([
    ["darwin", {}, ["Library", "Application Support", "Code", "User", "mcp.json"]],
    ["linux", {}, [".config", "Code", "User", "mcp.json"]],
  ] as const)("writes type http to the %s profile", async (platform, vars, parts) => {
    const env = fakeEnv({ platform, vars });
    await vscode.add(env, "user", "loookin", URL, false);
    expect(JSON.parse(env.read(join(env.home, ...parts)))).toEqual({ servers: { loookin: { type: "http", url: URL } } });
  });

  it("follows XDG_CONFIG_HOME and APPDATA", async () => {
    const linux = fakeEnv({ platform: "linux" });
    linux.vars.XDG_CONFIG_HOME = join(linux.root, "xdg");
    expect(vscode.describeAdd(linux, "user", "loookin", URL, false)).toContain(join(linux.root, "xdg", "Code", "User", "mcp.json"));

    const windows = fakeEnv({ platform: "win32" });
    windows.vars.APPDATA = join(windows.root, "Roaming");
    expect(vscode.describeAdd(windows, "user", "loookin", URL, false)).toContain(join(windows.root, "Roaming", "Code", "User", "mcp.json"));
  });

  it("is found by the code command or the profile directory", async () => {
    expect(await vscode.detect(fakeEnv())).toBe(false);
    expect(await vscode.detect(fakeEnv({ installed: ["code"] }))).toBe(true);
    const env = fakeEnv();
    mkdirSync(join(env.home, ".config", "Code", "User"), { recursive: true });
    expect(await vscode.detect(env)).toBe(true);
  });

  it("uses .vscode/mcp.json for the project and keeps other servers", async () => {
    const env = fakeEnv();
    const path = join(env.cwd, ".vscode", "mcp.json");
    const before = '{\n\t"servers": {\n\t\t// local\n\t\t"db": { "command": "db-mcp" }\n\t},\n\t"inputs": []\n}\n';
    env.write(path, before);
    await vscode.add(env, "project", "loookin", URL, false);
    expect(parse(env.read(path))).toEqual({ servers: { db: { command: "db-mcp" }, loookin: { type: "http", url: URL } }, inputs: [] });
    await vscode.remove(env, "project", "loookin");
    expect(env.read(path)).toBe(before);
  });
});
