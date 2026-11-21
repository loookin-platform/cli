import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { commands, CURSOR_FIXTURE, fakeEnv, type Fake, type FakeOptions } from "./helpers";

const URL = "https://acme.loookin.com/api/mcp";
const run = (env: Fake, ...argv: string[]) => runCli(argv, env, "0.0.0");

const VSCODE_FIXTURE = `{
	// Servers of my profile
	"servers": {
		"db": { "command": "db-mcp", "args": ["--ro"] }, // local database
		"docs": {
			"type": "http",
			"url": "https://docs.example/mcp"
		}
	},
	"inputs": [],
}
`;

function machine(options: FakeOptions = {}) {
  const env = fakeEnv({ tty: true, ...options });
  mkdirSync(join(env.home, ".cursor"));
  mkdirSync(join(env.home, ".config", "Code", "User"), { recursive: true });
  return Object.assign(env, {
    cursorFile: join(env.home, ".cursor", "mcp.json"),
    vscodeFile: join(env.home, ".config", "Code", "User", "mcp.json"),
  });
}

describe("mcp remove", () => {
  it("add followed by remove leaves every config exactly as it was", async () => {
    const env = machine({ answers: ["y", "y"] });
    env.write(env.cursorFile, CURSOR_FIXTURE);
    env.write(env.vscodeFile, VSCODE_FIXTURE);

    expect(await run(env, "mcp", "add", "--workspace", "acme")).toBe(0);
    expect(env.read(env.cursorFile)).not.toBe(CURSOR_FIXTURE);
    expect(env.read(env.vscodeFile)).not.toBe(VSCODE_FIXTURE);

    env.outLines.length = 0;
    expect(await run(env, "mcp", "remove")).toBe(0);
    expect(env.outLines.join("\n")).toMatch(/1\. Cursor\s+will remove\s+edit .*: delete mcpServers\.loookin/);
    expect(env.read(env.cursorFile)).toBe(CURSOR_FIXTURE);
    expect(env.read(env.vscodeFile)).toBe(VSCODE_FIXTURE);
    expect(env.outLines.join("\n")).toContain("sign-in the client saved for this server is not revoked");
  });

  it("is not an error when there is nothing to remove", async () => {
    const env = machine();
    env.write(env.cursorFile, CURSOR_FIXTURE);
    expect(await run(env, "mcp", "remove")).toBe(0);
    expect(env.outLines.join("\n")).toMatch(/Cursor\s+not set/);
    expect(env.outLines.at(-1)).toBe("\nNothing to remove.");
    expect(env.questions).toEqual([]);
    expect(env.read(env.cursorFile)).toBe(CURSOR_FIXTURE);

    const bare = fakeEnv({ tty: true });
    expect(await run(bare, "mcp", "remove")).toBe(0);
  });

  it("changes nothing when declined or with --dry-run", async () => {
    const env = machine({ answers: ["n"] });
    await run(env, "mcp", "add", "--workspace", "acme", "--yes");
    const cursor = env.read(env.cursorFile);

    expect(await run(env, "mcp", "remove")).toBe(1);
    expect(await run(env, "mcp", "remove", "--dry-run")).toBe(0);
    expect(env.read(env.cursorFile)).toBe(cursor);
    expect(env.outLines.at(-1)).toBe("\nDry run: nothing was changed.");
  });

  it("removes only from the chosen client and only the named entry", async () => {
    const env = machine();
    await run(env, "mcp", "add", "--workspace", "acme", "--yes");
    await run(env, "mcp", "add", "--workspace", "beta", "--name", "loookin-beta", "--yes");

    expect(await run(env, "mcp", "remove", "--client", "cursor", "--yes")).toBe(0);
    expect(JSON.parse(env.read(env.cursorFile)).mcpServers).toEqual({ "loookin-beta": { url: "https://beta.loookin.com/api/mcp" } });
    expect(Object.keys(JSON.parse(env.read(env.vscodeFile)).servers)).toEqual(["loookin", "loookin-beta"]);
  });

  it("runs the client's command, and tells where to remove by hand", async () => {
    const env = fakeEnv({
      tty: true,
      platform: "darwin",
      installed: ["claude", "codex"],
      exec: ({ args }) => (args[1] === "get" ? { stdout: `loookin:\n  Scope: User config\n  URL: ${URL}\n` } : {}),
    });
    mkdirSync(join(env.home, "Library", "Application Support", "Claude"), { recursive: true });
    env.write(join(env.home, ".codex", "config.toml"), `[mcp_servers.loookin]\nurl = "${URL}"\n`);

    expect(await run(env, "mcp", "remove", "--yes")).toBe(0);
    expect(commands(env)).toEqual(["claude mcp get loookin", "claude mcp remove --scope user loookin", "codex mcp remove loookin"]);
    const out = env.outLines.join("\n");
    expect(out).toMatch(/Claude Desktop\s+manual/);
    expect(out).toContain('Settings → Connectors and remove "loookin" there');
  });

  it("leaves a file it cannot parse and says so", async () => {
    const env = machine();
    env.write(env.cursorFile, "{ broken");
    expect(await run(env, "mcp", "remove", "--yes")).toBe(0);
    expect(env.outLines.join("\n")).toMatch(/Cursor\s+manual/);
    expect(env.read(env.cursorFile)).toBe("{ broken");
  });
});

describe("mcp list", () => {
  it("shows the entry, its address and where it is, or not set", async () => {
    const env = machine({ installed: ["codex"] });
    env.write(env.cursorFile, CURSOR_FIXTURE);
    await run(env, "mcp", "add", "--workspace", "acme", "--client", "cursor", "--yes");
    env.write(join(env.home, ".codex", "config.toml"), '[mcp_servers.lookin]\nurl = "https://old.loookin.com/api/mcp"\n');
    const before = env.read(env.cursorFile);

    env.outLines.length = 0;
    expect(await run(env, "mcp", "list")).toBe(0);
    const out = env.outLines.join("\n");
    expect(out).toMatch(new RegExp(`Cursor\\s+loookin\\s+${URL}  in .*\\.cursor/mcp\\.json`));
    // Found by address although the entry has the older name.
    expect(out).toMatch(/Codex\s+lookin\s+https:\/\/old\.loookin\.com\/api\/mcp/);
    expect(out).toMatch(/VS Code\s+not set/);
    expect(out).not.toContain("sentry");
    expect(env.read(env.cursorFile)).toBe(before);
    expect(env.calls).toEqual([]);
  });

  it("--project looks at the project and needs no terminal", async () => {
    const env = machine({ tty: false, installed: ["codex"] });
    env.write(join(env.cwd, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { loookin: { url: URL } } }));
    expect(await run(env, "mcp", "list", "--project")).toBe(0);
    const out = env.outLines.join("\n");
    expect(out).toMatch(/Cursor\s+loookin/);
    expect(out).toMatch(/Codex\s+skipped/);
  });

  it("says so when no client is installed", async () => {
    const env = fakeEnv();
    expect(await run(env, "mcp", "list")).toBe(0);
    expect(env.outLines).toEqual(["No supported AI client was found on this machine."]);
  });
});
