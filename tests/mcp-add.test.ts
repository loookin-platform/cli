import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { commands, CURSOR_FIXTURE, fakeEnv, json, type Fake, type FakeOptions } from "./helpers";

const URL = "https://acme.loookin.com/api/mcp";
const run = (env: Fake, ...argv: string[]) => runCli(argv, env, "0.0.0");

/** A machine with Cursor and VS Code (Linux paths), in a terminal by default. */
function machine(options: FakeOptions = {}) {
  const env = fakeEnv({ tty: true, ...options });
  mkdirSync(join(env.home, ".cursor"));
  mkdirSync(join(env.home, ".config", "Code", "User"), { recursive: true });
  return Object.assign(env, {
    cursorFile: join(env.home, ".cursor", "mcp.json"),
    vscodeFile: join(env.home, ".config", "Code", "User", "mcp.json"),
  });
}

/** Every file under the fake home and project, to prove nothing was written. */
const tree = (env: Fake) => (readdirSync(env.root, { recursive: true }) as string[]).sort();

describe("mcp add", () => {
  it("shows the plan, waits for confirmation and writes to every client found", async () => {
    const env = machine({ answers: ["y"] });
    env.write(env.cursorFile, CURSOR_FIXTURE);

    expect(await run(env, "mcp", "add", "--workspace", "acme")).toBe(0);

    const out = env.outLines.join("\n");
    expect(out).toContain(`MCP server: ${URL}`);
    expect(out).toMatch(/1\. Cursor\s+will add\s+edit .*\.cursor\/mcp\.json: set mcpServers\.loookin = \{"url":/);
    expect(out).toMatch(/2\. VS Code\s+will add\s+edit .*Code\/User\/mcp\.json: set servers\.loookin = \{"type":"http"/);
    expect(env.questions).toHaveLength(1);
    expect(out).toContain("Next steps:");

    const cursor = parse(env.read(env.cursorFile));
    expect(cursor.mcpServers.loookin).toEqual({ url: URL });
    expect(cursor.mcpServers.sentry).toEqual({ url: "https://mcp.sentry.dev/mcp" });
    expect(env.read(env.cursorFile)).toContain("// My servers");
    expect(JSON.parse(env.read(env.vscodeFile))).toEqual({ servers: { loookin: { type: "http", url: URL } } });
  });

  it("asks for the workspace when it is not given", async () => {
    const env = machine({ answers: ["acme.loookin.com", "y"] });
    expect(await run(env, "mcp", "add")).toBe(0);
    expect(env.questions[0]).toMatch(/Workspace/);
    expect(parse(env.read(env.cursorFile)).mcpServers.loookin.url).toBe(URL);
  });

  it("changes nothing when the confirmation is declined", async () => {
    for (const answer of ["n", "", "maybe"]) {
      const env = machine({ answers: [answer] });
      env.write(env.cursorFile, CURSOR_FIXTURE);
      const before = tree(env);
      expect(await run(env, "mcp", "add", "--workspace", "acme")).toBe(1);
      expect(tree(env)).toEqual(before);
      expect(env.read(env.cursorFile)).toBe(CURSOR_FIXTURE);
      expect(env.outLines).toContain("Nothing was changed.");
    }
  });

  it("lets the user pick clients by number", async () => {
    const env = machine({ answers: ["2"] });
    expect(await run(env, "mcp", "add", "--workspace", "acme")).toBe(0);
    expect(tree(env)).not.toContain(join("home", ".cursor", "mcp.json"));
    expect(JSON.parse(env.read(env.vscodeFile)).servers.loookin.url).toBe(URL);
  });

  it("--dry-run prints the plan and changes nothing, without asking", async () => {
    const env = machine();
    const before = tree(env);
    expect(await run(env, "mcp", "add", "--workspace", "acme", "--dry-run")).toBe(0);
    expect(tree(env)).toEqual(before);
    expect(env.questions).toEqual([]);
    expect(env.outLines.join("\n")).toMatch(/Cursor\s+will add/);
    expect(env.outLines.at(-1)).toBe("\nDry run: nothing was changed.");
  });

  it("--client narrows the run and reports a client that is not installed", async () => {
    const env = machine();
    expect(await run(env, "mcp", "add", "--workspace", "acme", "--client", "cursor", "--client", "codex", "--yes")).toBe(0);
    const out = env.outLines.join("\n");
    expect(out).toMatch(/Codex\s+not found/);
    expect(out).not.toContain("VS Code");
    expect(parse(env.read(env.cursorFile)).mcpServers.loookin.url).toBe(URL);
    expect(tree(env)).not.toContain(join("home", ".config", "Code", "User", "mcp.json"));
    expect(env.calls).toEqual([]);
  });

  it("--project writes to the project and skips clients without a project scope", async () => {
    const env = machine({ installed: ["codex", "claude"] });
    expect(await run(env, "mcp", "add", "--workspace", "acme", "--project", "--yes")).toBe(0);
    expect(env.outLines.join("\n")).toMatch(/Codex\s+skipped\s+has no per-project configuration/);
    expect(JSON.parse(env.read(join(env.cwd, ".cursor", "mcp.json"))).mcpServers.loookin.url).toBe(URL);
    expect(JSON.parse(env.read(join(env.cwd, ".vscode", "mcp.json"))).servers.loookin.url).toBe(URL);
    expect(commands(env)).toEqual([`claude mcp add --transport http --scope project loookin ${URL}`]);
    expect(tree(env)).not.toContain(join("home", ".cursor", "mcp.json"));
  });

  it("says it is done when the same address is already there", async () => {
    const env = machine({ answers: ["y"] });
    await run(env, "mcp", "add", "--workspace", "acme");
    const cursor = env.read(env.cursorFile);
    const vscode = env.read(env.vscodeFile);

    env.outLines.length = 0;
    expect(await run(env, "mcp", "add", "--workspace", "https://acme.loookin.com/")).toBe(0);
    expect(env.outLines.join("\n")).toMatch(/Cursor\s+already set/);
    expect(env.outLines.at(-1)).toBe("\nNothing to change.");
    expect(env.questions).toHaveLength(1); // only the first run asked
    expect(env.read(env.cursorFile)).toBe(cursor);
    expect(env.read(env.vscodeFile)).toBe(vscode);
  });

  it("replaces another address only after its own confirmation", async () => {
    const other = '{\n  "mcpServers": {\n    "loookin": { "url": "https://old.loookin.com/api/mcp" }\n  }\n}\n';
    const declined = machine({ answers: ["y", "n"] });
    declined.write(declined.cursorFile, other);
    expect(await run(declined, "mcp", "add", "--workspace", "acme", "--client", "cursor")).toBe(1);
    expect(declined.outLines.join("\n")).toMatch(/will replace\s+https:\/\/old\.loookin\.com\/api\/mcp → https:\/\/acme/);
    expect(declined.questions[1]).toMatch(/Cursor: replace the existing "loookin" entry/);
    expect(declined.read(declined.cursorFile)).toBe(other);

    const accepted = machine({ answers: ["y", "y"] });
    accepted.write(accepted.cursorFile, other);
    expect(await run(accepted, "mcp", "add", "--workspace", "acme", "--client", "cursor")).toBe(0);
    expect(parse(accepted.read(accepted.cursorFile))).toEqual({ mcpServers: { loookin: { url: URL } } });
  });

  it("does not overwrite a file it cannot parse and prints what to paste", async () => {
    const env = machine({ answers: ["y"] });
    env.write(env.cursorFile, '{ "mcpServers": ');
    expect(await run(env, "mcp", "add", "--workspace", "acme")).toBe(0);
    const out = env.outLines.join("\n");
    expect(out).toMatch(/Cursor\s+manual/);
    expect(out).toContain(`"loookin": {"url":"${URL}"}`);
    expect(env.read(env.cursorFile)).toBe('{ "mcpServers": ');
    expect(JSON.parse(env.read(env.vscodeFile)).servers.loookin.url).toBe(URL);
  });

  it("prints a generic block when no client is installed", async () => {
    const env = fakeEnv({ tty: true });
    const before = tree(env);
    expect(await run(env, "mcp", "add", "--workspace", "acme")).toBe(0);
    expect(env.outLines.join("\n")).toContain("No supported AI client was found");
    expect(JSON.parse(env.outLines.at(-1)!)).toEqual({ mcpServers: { loookin: { type: "http", url: URL } } });
    expect(tree(env)).toEqual(before);
  });

  it("drives Claude Code and Codex through their commands and explains Claude Desktop", async () => {
    const env = fakeEnv({
      tty: true,
      platform: "darwin",
      installed: ["claude", "codex"],
      answers: ["y"],
      exec: ({ args }) => (args[1] === "get" ? { code: 1, stderr: "No MCP server found" } : {}),
    });
    mkdirSync(join(env.home, "Library", "Application Support", "Claude"), { recursive: true });

    expect(await run(env, "mcp", "add", "--workspace", "acme")).toBe(0);
    expect(commands(env)).toEqual([
      "claude mcp get loookin",
      `claude mcp add --transport http --scope user loookin ${URL}`,
      `codex mcp add loookin --url ${URL}`,
    ]);
    const out = env.outLines.join("\n");
    expect(out).toMatch(/1\. Claude Code\s+will add\s+run: claude mcp add --transport http --scope user loookin/);
    expect(out).toMatch(/Claude Desktop\s+manual/);
    expect(out).toContain("Settings → Connectors");
    expect(out).toContain("codex mcp login loookin");
  });

  it("reports a failing client command, keeps going and exits 1", async () => {
    const env = machine({
      installed: ["claude"],
      exec: ({ args }) => (args[1] === "get" ? { code: 1 } : { code: 1, stderr: "boom" }),
    });
    expect(await run(env, "mcp", "add", "--workspace", "acme", "--yes")).toBe(1);
    expect(env.errLines.join("\n")).toMatch(/Claude Code: .*failed \(exit code 1\):\nboom/);
    expect(parse(env.read(env.cursorFile)).mcpServers.loookin.url).toBe(URL);
  });

  it("a replace that fails halfway puts the old entry back and says how to restore it", async () => {
    const old = "https://old.loookin.com/api/mcp";
    const env = fakeEnv({
      installed: ["claude"],
      exec: ({ args }) => {
        if (args[1] === "get") return { stdout: `loookin:\n  Scope: User config\n  Type: http\n  URL: ${old}\n` };
        return args.includes(URL) ? { code: 1, stderr: "Invalid server" } : {};
      },
    });
    expect(await run(env, "mcp", "add", "--workspace", "acme", "--client", "claude-code", "--yes")).toBe(1);
    expect(commands(env).slice(1)).toEqual([
      "claude mcp remove --scope user loookin",
      `claude mcp add --transport http --scope user loookin ${URL}`,
      `claude mcp add --transport http --scope user loookin ${old}`,
    ]);
    expect(env.errLines.join("\n")).toContain(`was put back with: claude mcp add --transport http --scope user loookin ${old}`);
  });

  it("warns about a workspace that does not answer and continues only when told to", async () => {
    const declined = machine({ answers: ["n"], fetch: () => json(404, {}) });
    expect(await run(declined, "mcp", "add", "--workspace", "acmee")).toBe(1);
    expect(declined.errLines[0]).toMatch(/https:\/\/acmee\.loookin\.com does not answer like Loookin \(HTTP 404\)/);
    expect(declined.questions).toEqual(["Continue anyway? [y/N] "]);
    expect(tree(declined)).not.toContain(join("home", ".cursor", "mcp.json"));

    const offline = machine({
      answers: ["y", "y"],
      fetch: () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await run(offline, "mcp", "add", "--workspace", "acme")).toBe(0);
    expect(offline.errLines[0]).toMatch(/Could not reach/);
    expect(parse(offline.read(offline.cursorFile)).mcpServers.loookin.url).toBe(URL);
  });

  it("--name sets the entry name and rejects anything unsafe", async () => {
    const env = machine();
    expect(await run(env, "mcp", "add", "--workspace", "acme", "--name", "loookin-acme", "--yes")).toBe(0);
    expect(Object.keys(parse(env.read(env.cursorFile)).mcpServers)).toEqual(["loookin-acme"]);

    const bad = machine();
    expect(await run(bad, "mcp", "add", "--workspace", "acme", "--name", "a b; rm", "--yes")).toBe(2);
    // A leading hyphen would be read as an option by `claude` and `codex`.
    for (const name of ["--name=--scope", "--name=-x", "--name=-"]) {
      expect(await run(bad, "mcp", "add", "--workspace", "acme", name, "--yes")).toBe(2);
      expect(await run(bad, "mcp", "remove", name, "--yes")).toBe(2);
    }
    expect(bad.errLines.at(-1)).toMatch(/must not start with a hyphen/);
    expect(bad.calls).toEqual([]);
    expect(await run(bad, "mcp", "add", "--workspace", "acme", "--client", "emacs", "--yes")).toBe(2);
    expect(bad.errLines.join("\n")).toMatch(/Unknown client: emacs/);
    expect(bad.fetched).toEqual([]);
  });

  it("never writes or prints anything that looks like a secret", async () => {
    const env = machine({
      installed: ["claude", "codex"],
      exec: ({ args }) => (args[1] === "get" ? { code: 1 } : {}),
    });
    expect(await run(env, "mcp", "add", "--workspace", "acme", "--yes")).toBe(0);
    const written = [env.read(env.cursorFile), env.read(env.vscodeFile)].join("\n");
    const spawned = env.calls.flatMap((c) => c.args).join(" ");
    for (const text of [written, spawned, env.text()]) {
      expect(text).not.toMatch(/authorization|bearer|token|secret|password|api[-_ ]?key|headers?\b|--header|-H\b/i);
    }
    expect(Object.keys(parse(env.read(env.cursorFile)).mcpServers.loookin)).toEqual(["url"]);
    expect(Object.keys(parse(env.read(env.vscodeFile)).servers.loookin)).toEqual(["type", "url"]);
  });
});
