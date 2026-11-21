import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { snippet } from "../src/project/snippets";
import { parseWorkspace } from "../src/workspace";
import { commands, fakeEnv, type Fake, type FakeOptions } from "./helpers";

const run = (env: Fake, ...argv: string[]) => runCli(["init", ...argv], env, "0.0.0");

type Files = Record<string, string | object>;

/** A fake project: the given files in the fake cwd. Objects are written as JSON. */
function project(files: Files, options: FakeOptions = {}) {
  const env = fakeEnv({ tty: true, ...options });
  for (const [path, content] of Object.entries(files)) {
    env.write(join(env.cwd, path), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return env;
}

const MAIN = "console.log('app');\n";

const VITE: Files = {
  "package.json": { name: "shop", type: "module", dependencies: { react: "^19.0.0" }, devDependencies: { vite: "^7.0.0", typescript: "^6.0.0" } },
  "tsconfig.json": "{}",
  "src/main.ts": MAIN,
};
const EXPRESS_CJS: Files = { "package.json": { name: "api", dependencies: { express: "^5.0.0" } }, "index.js": MAIN };
const EXPRESS_ESM: Files = { "package.json": { name: "api", type: "module", dependencies: { express: "^5.0.0" } }, "index.js": MAIN };
const NEXT: Files = {
  "package.json": { name: "site", dependencies: { next: "^16.0.0", react: "^19.0.0" } },
  "tsconfig.json": "{}",
  "src/app/page.tsx": MAIN,
};

/** Every file under the fake home and project with its content: proof of what changed. */
function snapshot(env: Fake): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of (readdirSync(env.root, { recursive: true }) as string[]).sort()) {
    const full = join(env.root, path);
    if (statSync(full).isFile()) files[path] = readFileSync(full, "utf8");
  }
  return files;
}

/** What a run added, after checking that nothing that was there changed or disappeared. */
function added(env: Fake, before: Record<string, string>): string[] {
  const after = snapshot(env);
  for (const [path, content] of Object.entries(before)) expect(after[path], path).toBe(content);
  return Object.keys(after).filter((path) => !(path in before));
}

const out = (env: Fake) => env.outLines.join("\n");

/** No key and no header may ever appear: only the placeholder and the variable name. */
function expectNoSecrets(text: string) {
  expect(text).not.toMatch(/Authorization|Bearer/i);
  expect(text).not.toMatch(/\b(pub|ins)_[A-Za-z0-9]/);
}

describe("init: what it recognises and does", () => {
  it("Vite: web, TypeScript, installs with npm and creates src/loookin.ts", async () => {
    const env = project(VITE, { answers: ["y", "n"] });
    const before = snapshot(env);

    expect(await run(env, "--workspace", "acme")).toBe(0);

    expect(out(env)).toContain("Package manager: npm");
    expect(out(env)).toMatch(/Project type:\s+web \(found react, vite\)/);
    expect(out(env)).toContain("TypeScript:      yes");
    expect(out(env)).toMatch(/run\s+npm install @loookin\/sdk/);
    expect(commands(env)).toEqual(["npm install @loookin/sdk"]);
    expect(env.calls[0]!.timeoutMs).toBe(120_000);
    expect(added(env, before)).toEqual([join("project", "src", "loookin.ts")]);

    const file = env.read(join(env.cwd, "src", "loookin.ts"));
    expect(file).toBe(snippet("web", parseWorkspace("acme")));
    expect(file).toContain('import { loookin } from "@loookin/sdk";');
    expect(file).toContain('workspace: "acme"');
    expect(file).toContain('key: "pub_..."');
    expect(file).toContain("dryRun: true");
    expect(file).toContain("loookin.identify(");
    expect(file).toContain("loookin.track(");
    expect(out(env)).toContain(file);
    expect(out(env)).toContain("https://acme.loookin.com/developers");
    expect(out(env)).toContain("publishable key");
    expect(out(env)).toContain("npx @loookin/cli mcp add --workspace acme");
    expectNoSecrets(env.text());
  });

  it("Express without TypeScript and without type module: server, .mjs and how to load it", async () => {
    const env = project(EXPRESS_CJS, { answers: ["y", "n"] });
    const before = snapshot(env);

    expect(await run(env, "--workspace", "acme")).toBe(0);

    expect(out(env)).toMatch(/Project type:\s+server \(found express\)/);
    expect(out(env)).toContain("Modules:         CommonJS");
    expect(added(env, before)).toEqual([join("project", "loookin.mjs")]);
    const file = env.read(join(env.cwd, "loookin.mjs"));
    expect(file).toContain('import { createClient } from "@loookin/sdk/node";');
    expect(file).toContain('key: process.env.LOOOKIN_KEY ?? ""');
    expect(file).toContain("dryRun: true");
    expect(file).toContain("//   await loookin.shutdown();");
    expect(file).not.toContain("loookin.identify");
    expect(out(env)).toContain('await import("./loookin.mjs")');
    expect(out(env)).toContain("server key");
    expect(out(env)).toContain("never commit it");
    expectNoSecrets(env.text());
  });

  it("Express with type module and no TypeScript: .js", async () => {
    const env = project(EXPRESS_ESM, { answers: ["y", "n"] });
    const before = snapshot(env);
    expect(await run(env, "--workspace", "acme")).toBe(0);
    expect(added(env, before)).toEqual([join("project", "loookin.js")]);
    expect(out(env)).not.toContain("await import(");
  });

  it("Next.js: both examples, each in its own file", async () => {
    const env = project(NEXT, { answers: ["y", "n"] });
    const before = snapshot(env);

    expect(await run(env, "--workspace", "acme")).toBe(0);

    expect(out(env)).toMatch(/Project type:\s+web and server \(found next\)/);
    expect(added(env, before)).toEqual([join("project", "src", "loookin.client.ts"), join("project", "src", "loookin.server.ts")]);
    expect(env.read(join(env.cwd, "src", "loookin.client.ts"))).toContain("loookin.init(");
    expect(env.read(join(env.cwd, "src", "loookin.server.ts"))).toContain("createClient(");
    expect(out(env)).toContain("publishable key");
    expect(out(env)).toContain("server key");
  });

  it("--target narrows a both project to one example", async () => {
    const env = project(NEXT, { answers: ["y", "n"] });
    const before = snapshot(env);
    expect(await run(env, "--workspace", "acme", "--target", "server")).toBe(0);
    expect(added(env, before)).toEqual([join("project", "src", "loookin.server.ts")].map((p) => p.replace(".server", "")));
    expect(env.read(join(env.cwd, "src", "loookin.ts"))).toContain("createClient(");
  });

  it("web and server dependencies together count as both", async () => {
    const env = project({ "package.json": { dependencies: { express: "1", vue: "3" } } });
    expect(await run(env, "--workspace", "acme", "--dry-run")).toBe(0);
    expect(out(env)).toMatch(/web and server \(found vue, express\)/);
  });

  it("asks what the project is when no framework is known", async () => {
    const env = project({ "package.json": { name: "lib", dependencies: { lodash: "4" } } }, { answers: ["server", "y", "n"] });
    expect(await run(env, "--workspace", "acme")).toBe(0);
    expect(env.questions[0]).toMatch(/web app or a server/);
    expect(env.read(join(env.cwd, "loookin.mjs"))).toContain("createClient(");
  });

  it("uses the full origin in the code when the workspace is not a loookin.com subdomain", async () => {
    const env = project(VITE);
    expect(await run(env, "--workspace", "http://sandbox.localhost:3000", "--dry-run")).toBe(0);
    expect(out(env)).toContain('workspace: "http://sandbox.localhost:3000"');
    expect(out(env)).toContain("http://sandbox.localhost:3000/developers");
  });
});

describe("init: package managers", () => {
  const cases: [string, Files, string][] = [
    ["npm by default", {}, "npm install @loookin/sdk"],
    ["npm from package-lock.json", { "package-lock.json": "{}" }, "npm install @loookin/sdk"],
    ["pnpm from its lockfile", { "pnpm-lock.yaml": "" }, "pnpm add @loookin/sdk"],
    ["yarn from its lockfile", { "yarn.lock": "" }, "yarn add @loookin/sdk"],
    ["bun from bun.lock", { "bun.lock": "" }, "bun add @loookin/sdk"],
    ["bun from bun.lockb", { "bun.lockb": "" }, "bun add @loookin/sdk"],
  ];
  for (const [name, extra, command] of cases) {
    it(name, async () => {
      const env = project({ ...EXPRESS_ESM, ...extra }, { tty: false });
      expect(await run(env, "--workspace", "acme", "--yes")).toBe(0);
      expect(commands(env)).toEqual([command]);
      expect(out(env)).toContain(`Package manager: ${command.split(" ")[0]}`);
    });
  }

  it("the packageManager field wins over a lockfile", async () => {
    const manifest = { type: "module", packageManager: "pnpm@10.2.0+sha512.abc", dependencies: { hono: "4" } };
    const env = project({ "package.json": manifest, "yarn.lock": "" }, { tty: false });
    expect(await run(env, "--workspace", "acme", "--yes")).toBe(0);
    expect(commands(env)).toEqual(["pnpm add @loookin/sdk"]);
  });

  it("an unknown packageManager falls back and says so", async () => {
    const env = project({ "package.json": { packageManager: "deno@2.0.0", dependencies: { hono: "4" } } });
    expect(await run(env, "--workspace", "acme", "--dry-run")).toBe(0);
    expect(out(env)).toContain('Package manager: npm ("deno" in packageManager is not supported)');
  });

  it("runs the manager without a shell, as an argument array", async () => {
    const env = project(EXPRESS_ESM, { tty: false });
    await run(env, "--workspace", "acme", "--yes");
    expect(env.calls[0]).toEqual({ command: "npm", args: ["install", "@loookin/sdk"], timeoutMs: 120_000 });
  });

  it("a failed install is reported with the command to run, and the example is still created", async () => {
    const env = project(EXPRESS_ESM, { tty: false, exec: () => ({ code: 1, stderr: "npm error network ENOTFOUND" }) });
    expect(await run(env, "--workspace", "acme", "--yes")).toBe(1);
    expect(env.errLines.join("\n")).toContain("ENOTFOUND");
    expect(env.errLines.join("\n")).toContain("Run it yourself: npm install @loookin/sdk");
    expect(readdirSync(env.cwd)).toContain("loookin.js");
  });
});

describe("init: what it refuses and what it leaves alone", () => {
  it("an empty directory: exit 1, nothing installed, nothing asked or fetched", async () => {
    const env = project({});
    const before = snapshot(env);
    expect(await run(env, "--workspace", "acme", "--yes")).toBe(1);
    expect(env.errLines.join("\n")).toContain("No package.json");
    expect(env.calls).toEqual([]);
    expect(env.fetched).toEqual([]);
    expect(env.questions).toEqual([]);
    expect(added(env, before)).toEqual([]);
  });

  it("a monorepo root: exit 1 with where to run it instead", async () => {
    const roots: Files[] = [
      { "package.json": { name: "root", workspaces: ["apps/*"], devDependencies: { vite: "7" } } },
      { "package.json": { name: "root", devDependencies: { vite: "7" } }, "pnpm-workspace.yaml": "packages:\n  - apps/*\n" },
    ];
    for (const files of roots) {
      const env = project(files);
      const before = snapshot(env);
      expect(await run(env, "--workspace", "acme", "--yes")).toBe(1);
      expect(env.errLines.join("\n")).toMatch(/monorepo.*directory of the app/);
      expect(env.calls).toEqual([]);
      expect(added(env, before)).toEqual([]);
    }
  });

  it("a manifest that does not parse: exit 1", async () => {
    const env = project({ "package.json": "{ nope" });
    expect(await run(env, "--workspace", "acme", "--yes")).toBe(1);
    expect(env.calls).toEqual([]);
  });

  it("the SDK already installed: nothing is installed again", async () => {
    const files = { ...EXPRESS_ESM, "package.json": { type: "module", dependencies: { express: "5", "@loookin/sdk": "^1.0.0" } } };
    const env = project(files, { answers: ["y", "n"] });
    expect(await run(env, "--workspace", "acme")).toBe(0);
    expect(env.calls).toEqual([]);
    expect(out(env)).toContain("@loookin/sdk is already a dependency");
  });

  it("an existing loookin.ts is not overwritten: the code is printed instead", async () => {
    const mine = "// my own setup\n";
    const env = project({ ...VITE, "src/loookin.ts": mine }, { answers: ["y", "n"] });
    const before = snapshot(env);

    expect(await run(env, "--workspace", "acme")).toBe(0);

    expect(added(env, before)).toEqual([]);
    expect(env.read(join(env.cwd, "src", "loookin.ts"))).toBe(mine);
    expect(out(env)).toContain("already exists");
    expect(out(env)).toContain("loookin.init({");
    expect(commands(env)).toEqual(["npm install @loookin/sdk"]);
  });

  it("a second run changes nothing and asks for no confirmation of changes", async () => {
    const files = { ...VITE, "package.json": { type: "module", dependencies: { react: "19", "@loookin/sdk": "1" } }, "src/loookin.ts": "// mine\n" };
    const env = project(files, { answers: ["n"] });
    const before = snapshot(env);
    expect(await run(env, "--workspace", "acme")).toBe(0);
    expect(env.questions).toHaveLength(1);
    expect(env.questions[0]).toMatch(/AI clients/);
    expect(env.calls).toEqual([]);
    expect(added(env, before)).toEqual([]);
  });

  it("--no-install prints the command and --no-file prints the code", async () => {
    const env = project({ ...VITE, "pnpm-lock.yaml": "" }, { tty: false });
    const before = snapshot(env);
    expect(await run(env, "--workspace", "acme", "--no-install", "--no-file", "--yes")).toBe(0);
    expect(env.calls).toEqual([]);
    expect(added(env, before)).toEqual([]);
    expect(out(env)).toContain("run it yourself: pnpm add @loookin/sdk");
    expect(out(env)).toContain("loookin.init({");
  });

  it("--dry-run prints everything and changes nothing", async () => {
    for (const files of [VITE, EXPRESS_CJS, NEXT]) {
      const env = project(files);
      const before = snapshot(env);
      expect(await run(env, "--workspace", "acme", "--dry-run")).toBe(0);
      expect(added(env, before)).toEqual([]);
      expect(env.calls).toEqual([]);
      expect(env.questions).toEqual([]);
      expect(out(env)).toMatch(/run\s+npm install @loookin\/sdk/);
      expect(out(env)).toContain("would be created");
      expect(out(env)).toContain("dryRun: true");
      expect(out(env)).toContain("/developers");
      expect(env.outLines.at(-1)).toBe("\nDry run: nothing was changed.");
      expectNoSecrets(env.text());
    }
  });

  it("a declined confirmation changes nothing and exits 1", async () => {
    for (const answer of ["n", "", "later"]) {
      const env = project(VITE, { answers: [answer] });
      const before = snapshot(env);
      expect(await run(env, "--workspace", "acme")).toBe(1);
      expect(added(env, before)).toEqual([]);
      expect(env.calls).toEqual([]);
      expect(env.outLines.at(-1)).toBe("Nothing was changed.");
    }
  });

  it("says honestly that the workspace name is not verified, and stops when the host is not Loookin", async () => {
    const env = project(VITE, { answers: ["n"], fetch: () => new Response("", { status: 404 }) });
    const before = snapshot(env);
    expect(await run(env, "--workspace", "acme")).toBe(1);
    expect(out(env)).toContain("The workspace name is not checked here.");
    expect(env.errLines.join("\n")).toContain("does not answer like Loookin");
    expect(env.calls).toEqual([]);
    expect(added(env, before)).toEqual([]);
  });
});

describe("init: without a terminal", () => {
  it("a missing --workspace is exit 2 and names the flag", async () => {
    const env = project(VITE, { tty: false });
    expect(await run(env, "--yes")).toBe(2);
    expect(env.errLines.join("\n")).toContain("--workspace");
    expect(env.fetched).toEqual([]);
  });

  it("a missing --yes is exit 2 and nothing happens", async () => {
    const env = project(VITE, { tty: false });
    const before = snapshot(env);
    expect(await run(env, "--workspace", "acme")).toBe(2);
    expect(env.errLines.join("\n")).toContain("--yes");
    expect(env.fetched).toEqual([]);
    expect(env.calls).toEqual([]);
    expect(added(env, before)).toEqual([]);
  });

  it("an unknown project type is exit 2 and names --target", async () => {
    const env = project({ "package.json": { name: "lib" } }, { tty: false });
    expect(await run(env, "--workspace", "acme", "--yes")).toBe(2);
    expect(env.errLines.join("\n")).toContain("--target");
    expect(env.calls).toEqual([]);
    expect(await run(env, "--workspace", "acme", "--yes", "--target", "web")).toBe(0);
  });

  it("with --yes it runs to the end and only prints the mcp add command", async () => {
    const env = project(VITE, { tty: false, installed: ["claude"] });
    expect(await run(env, "--workspace", "acme", "--yes")).toBe(0);
    expect(env.questions).toEqual([]);
    expect(commands(env)).toEqual(["npm install @loookin/sdk"]);
    expect(out(env)).toContain("npx @loookin/cli mcp add --workspace acme");
  });
});

describe("init: the mcp add offer", () => {
  it("--yes in a terminal does not run mcp add either", async () => {
    const env = project(VITE, { installed: ["claude"] });
    expect(await run(env, "--workspace", "acme", "--yes")).toBe(0);
    expect(env.questions).toEqual([]);
    expect(commands(env)).toEqual(["npm install @loookin/sdk"]);
  });

  it("accepted: runs mcp add for the same workspace without asking for it again", async () => {
    const env = project(VITE, { answers: ["y", "y", "y"] });
    mkdirSync(join(env.home, ".cursor"));

    expect(await run(env, "--workspace", "acme")).toBe(0);

    expect(env.questions.map((q) => q.trim())).toEqual([
      "Apply these changes? [y/N]",
      "Connect your AI clients to this workspace now? [y/N]",
      "Apply these changes? [y/N]",
    ]);
    expect(JSON.parse(env.read(join(env.home, ".cursor", "mcp.json")))).toEqual({
      mcpServers: { loookin: { url: "https://acme.loookin.com/api/mcp" } },
    });
    expectNoSecrets(env.text());
  });
});

describe("init: the generated code", () => {
  it("every variant parses as JavaScript", () => {
    const env = fakeEnv();
    for (const workspace of ["acme", "http://sandbox.localhost:3000"]) {
      for (const target of ["web", "server"] as const) {
        const code = snippet(target, parseWorkspace(workspace));
        // The text is the same for .ts, .js and .mjs. Node parses it as an ES
        // module without running it; a syntax error or TypeScript-only syntax fails.
        const file = join(env.root, `${target}.mjs`);
        env.write(file, code);
        expect(() => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" })).not.toThrow();
        expect(code).not.toMatch(/^\s*await /m);
        expectNoSecrets(code);
      }
    }
  });

  it("node --check does catch TypeScript-only syntax, so the test above means something", () => {
    const env = fakeEnv();
    const file = join(env.root, "bad.mjs");
    env.write(file, 'const key: string = process.env.KEY!;\n');
    expect(() => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" })).toThrow();
  });
});
