import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCode } from "../../src/clients/claude-code";
import { claudeDesktop } from "../../src/clients/claude-desktop";
import { codex, parseCodexServers } from "../../src/clients/codex";
import { commands, fakeEnv } from "../helpers";

const URL = "https://acme.loookin.com/api/mcp";

const GET_OUTPUT = (scope: string, url: string) =>
  `loookin:\n  Scope: ${scope}\n  Status: ✓ Connected\n  Type: http\n  URL: ${url}\n\nTo remove this server, run: claude mcp remove "loookin" -s user\n`;

describe("claude-code", () => {
  it("is found on PATH", async () => {
    expect(await claudeCode.detect(fakeEnv())).toBe(false);
    expect(await claudeCode.detect(fakeEnv({ installed: ["claude"] }))).toBe(true);
  });

  it("adds through the client's own command, with the scope spelled out", async () => {
    const env = fakeEnv();
    await claudeCode.add(env, "user", "loookin", URL, false);
    await claudeCode.add(env, "project", "loookin", URL, false);
    expect(env.calls.map((c) => [c.command, c.args])).toEqual([
      ["claude", ["mcp", "add", "--transport", "http", "--scope", "user", "loookin", URL]],
      ["claude", ["mcp", "add", "--transport", "http", "--scope", "project", "loookin", URL]],
    ]);
    expect(env.calls.every((c) => c.timeoutMs === 10_000)).toBe(true);
  });

  it("removes first when replacing, and stops when a command fails", async () => {
    const env = fakeEnv();
    await claudeCode.add(env, "user", "loookin", URL, true);
    expect(commands(env)).toEqual([
      "claude mcp remove --scope user loookin",
      `claude mcp add --transport http --scope user loookin ${URL}`,
    ]);

    const failing = fakeEnv({ exec: () => ({ code: 1, stderr: "No MCP server found" }) });
    await expect(claudeCode.add(failing, "user", "loookin", URL, true)).rejects.toThrow(/No MCP server found/);
    expect(failing.calls).toHaveLength(1);
  });

  const OLD = "https://old.loookin.com/api/mcp";
  /** A machine where adding the new address fails and everything else works. */
  const addFails = (alsoRestore = false) =>
    fakeEnv({
      exec: ({ args }) => (args.includes(URL) || (alsoRestore && args.includes(OLD)) ? { code: 1, stderr: "Invalid server" } : {}),
    });

  it("puts the old address back when the add of a replace fails", async () => {
    const env = addFails();
    const failed = claudeCode.add(env, "user", "loookin", URL, true, OLD);
    await expect(failed).rejects.toThrow(/Invalid server/);
    await expect(failed).rejects.toThrow(`was put back with: claude mcp add --transport http --scope user loookin ${OLD}`);
    expect(commands(env)).toEqual([
      "claude mcp remove --scope user loookin",
      `claude mcp add --transport http --scope user loookin ${URL}`,
      `claude mcp add --transport http --scope user loookin ${OLD}`,
    ]);
  });

  it("prints the command that restores the old entry when it cannot put it back", async () => {
    const env = addFails(true);
    await expect(claudeCode.add(env, "project", "loookin", URL, true, OLD)).rejects.toThrow(
      `could not be put back. Restore it with: claude mcp add --transport http --scope project loookin ${OLD}`,
    );
    expect(env.calls).toHaveLength(3);
  });

  it("says so when the replaced entry had no address to restore", async () => {
    const env = addFails();
    await expect(claudeCode.add(env, "user", "loookin", URL, true)).rejects.toThrow(/had no address to put back/);
    expect(env.calls).toHaveLength(2);
  });

  it("reads the user entry from `claude mcp get`", async () => {
    const set = fakeEnv({ exec: () => ({ stdout: GET_OUTPUT("User config (available in all your projects)", URL) }) });
    expect(await claudeCode.read(set, "user", "loookin")).toMatchObject({ entries: [{ name: "loookin", url: URL }] });
    expect(commands(set)).toEqual(["claude mcp get loookin"]);

    const missing = fakeEnv({ exec: () => ({ code: 1, stderr: "No MCP server found with name: loookin" }) });
    expect((await claudeCode.read(missing, "user", "loookin")).entries).toEqual([]);

    // An entry of the same name in another scope is not the user-level one.
    const local = fakeEnv({ exec: () => ({ stdout: GET_OUTPUT("Local config (private to you in this project)", URL) }) });
    expect((await claudeCode.read(local, "user", "loookin")).entries).toEqual([]);

    const hung = fakeEnv({ exec: () => ({ code: null, error: "timed out after 10 s" }) });
    expect((await claudeCode.read(hung, "user", "loookin")).failed).toMatch(/timed out/);
  });

  it("reads the project entry from .mcp.json without running anything", async () => {
    const env = fakeEnv();
    env.write(join(env.cwd, ".mcp.json"), JSON.stringify({ mcpServers: { loookin: { type: "http", url: URL } } }));
    expect((await claudeCode.read(env, "project", "loookin")).entries).toEqual([{ name: "loookin", url: URL }]);
    expect(env.calls).toEqual([]);
  });
});

describe("codex", () => {
  it("adds, replaces and removes through `codex mcp`", async () => {
    const env = fakeEnv();
    await codex.add(env, "user", "loookin", URL, false);
    await codex.add(env, "user", "loookin", URL, true);
    await codex.remove(env, "user", "loookin");
    expect(commands(env)).toEqual([
      `codex mcp add loookin --url ${URL}`,
      "codex mcp remove loookin",
      `codex mcp add loookin --url ${URL}`,
      "codex mcp remove loookin",
    ]);
    expect(codex.hasProjectScope).toBe(false);

    const failing = fakeEnv({ exec: ({ args }) => (args.includes(URL) ? { code: 1, stderr: "bad url" } : {}) });
    await expect(codex.add(failing, "user", "loookin", URL, true, "https://old.loookin.com/api/mcp")).rejects.toThrow(
      "was put back with: codex mcp add loookin --url https://old.loookin.com/api/mcp",
    );
    expect(commands(failing).at(-1)).toBe("codex mcp add loookin --url https://old.loookin.com/api/mcp");
    expect(codex.nextSteps("loookin")[0]).toContain("codex mcp login loookin");
  });

  it("reads servers from config.toml, read-only", async () => {
    const env = fakeEnv();
    expect((await codex.read(env, "user", "loookin")).entries).toEqual([]);
    const toml = `model = "gpt"\n\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs"]\n\n[mcp_servers.loookin] # ours\nurl = "${URL}"\n\n[mcp_servers."with.dot"]\nurl = 'https://x.example/mcp'\n\n[profiles.a]\nurl = "https://not-a-server.example"\n`;
    env.write(join(env.home, ".codex", "config.toml"), toml);
    expect((await codex.read(env, "user", "loookin")).entries).toEqual([
      { name: "docs" },
      { name: "loookin", url: URL },
      { name: "with.dot", url: "https://x.example/mcp" },
    ]);
    expect(env.read(join(env.home, ".codex", "config.toml"))).toBe(toml);
    expect(env.calls).toEqual([]);
  });

  it("parses CRLF and ignores url outside server tables", () => {
    expect(parseCodexServers('url = "https://top.example"\r\n[mcp_servers.a]\r\nurl = "https://a.example"\r\n')).toEqual([
      { name: "a", url: "https://a.example" },
    ]);
  });
});

describe("claude-desktop", () => {
  it("is found by its application directory and only ever gives instructions", async () => {
    const env = fakeEnv({ platform: "darwin" });
    expect(await claudeDesktop.detect(env)).toBe(false);
    mkdirSync(join(env.home, "Library", "Application Support", "Claude"), { recursive: true });
    expect(await claudeDesktop.detect(env)).toBe(true);

    expect(claudeDesktop.manualOnly).toBe(true);
    const text = claudeDesktop.manualAdd(env, "user", "loookin", URL).join("\n");
    expect(text).toContain("Settings → Connectors");
    expect(text).toContain(URL);
    await claudeDesktop.add(env, "user", "loookin", URL, false);
    expect(env.calls).toEqual([]);
  });
});
