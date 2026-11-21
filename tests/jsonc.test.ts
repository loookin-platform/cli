import { chmodSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { editKey, parseJsonc, readJsonc, writeAtomic } from "../src/jsonc";
import { CURSOR_FIXTURE, fakeEnv } from "./helpers";

const ENTRY = { url: "https://acme.loookin.com/api/mcp" };

describe("editKey", () => {
  it("adds one key and keeps comments, formatting and the other keys", () => {
    const edited = editKey(CURSOR_FIXTURE, ["mcpServers", "loookin"], ENTRY);
    expect(parse(edited).mcpServers.loookin).toEqual(ENTRY);
    // Every original line is still there, untouched.
    for (const line of CURSOR_FIXTURE.split("\n").filter((l) => l.trim() && l.trim() !== "}")) {
      expect(edited).toContain(line.replace(/,?$/, ""));
    }
    expect(edited).toContain("// My servers");
    expect(edited).toContain("/* remote */");
    expect(edited).toContain('"other": [1, 2,   3]');
    // The new entry follows the file's own four-space indentation.
    expect(edited).toMatch(/\n {8}"loookin": \{\n {12}"url"/);
  });

  it("adding and removing gives back the original text", () => {
    const added = editKey(CURSOR_FIXTURE, ["mcpServers", "loookin"], ENTRY);
    expect(added).not.toBe(CURSOR_FIXTURE);
    expect(editKey(added, ["mcpServers", "loookin"], undefined)).toBe(CURSOR_FIXTURE);
  });

  it("replaces only the value of an existing key", () => {
    const added = editKey(CURSOR_FIXTURE, ["mcpServers", "sentry"], ENTRY);
    expect(parse(added).mcpServers).toEqual({ github: { command: "npx", args: ["-y", "gh-mcp"] }, sentry: ENTRY });
    expect(added).toContain("// local");
  });

  it("keeps tabs and CRLF", () => {
    const source = '{\r\n\t"mcpServers": {\r\n\t\t"a": { "url": "x" }\r\n\t}\r\n}\r\n';
    const edited = editKey(source, ["mcpServers", "loookin"], ENTRY);
    expect(edited).toContain('\r\n\t\t"loookin": {\r\n\t\t\t"url"');
    expect(edited.replace(/\r\n/g, "")).not.toContain("\n");
    expect(editKey(edited, ["mcpServers", "loookin"], undefined)).toBe(source);
  });

  it("creates the parent key and starts an empty file", () => {
    expect(parse(editKey('{ "a": 1 }', ["mcpServers", "loookin"], ENTRY))).toEqual({ a: 1, mcpServers: { loookin: ENTRY } });
    const fresh = editKey("", ["mcpServers", "loookin"], ENTRY);
    expect(JSON.parse(fresh)).toEqual({ mcpServers: { loookin: ENTRY } });
    expect(fresh.endsWith("}\n")).toBe(true);
  });
});

describe("editKey leaves the neighbours alone", () => {
  const set = (text: string) => editKey(text, ["m", "loookin"], ENTRY);
  const unset = (text: string) => editKey(text, ["m", "loookin"], undefined);
  const NEW = '"loookin": {\n      "url": "https://acme.loookin.com/api/mcp"\n    }';

  it.each([
    ["a neighbour written on one line", '{\n  "m": {\n    "a": { "url": "x" }\n  }\n}\n', `{\n  "m": {\n    "a": { "url": "x" },\n    ${NEW}\n  }\n}\n`],
    ["a comment behind the last property", '{\n  "m": {\n    "a": 1 // about a\n  }\n}\n', `{\n  "m": {\n    "a": 1, // about a\n    ${NEW}\n  }\n}\n`],
    ["a comment on its own line at the end", '{\n  "m": {\n    "a": 1\n    // "b": 2\n  }\n}\n', `{\n  "m": {\n    "a": 1,\n    // "b": 2\n    ${NEW}\n  }\n}\n`],
    ["an empty multi-line object", '{\n  "m": {\n  }\n}\n', `{\n  "m": {\n    ${NEW}\n  }\n}\n`],
  ])("%s, and removal restores the file", (_label, before, after) => {
    expect(set(before)).toBe(after);
    expect(unset(after)).toBe(before);
  });

  it("opens up an empty one-line object", () => {
    expect(set('{\n  "m": {}\n}\n')).toBe(`{\n  "m": {\n    ${NEW}\n  }\n}\n`);
  });

  it("keeps a one-line object on one line", () => {
    const before = '{ "m": { "a": 1 } }';
    const after = '{ "m": { "a": 1, "loookin": {"url":"https://acme.loookin.com/api/mcp"} } }';
    expect(set(before)).toBe(after);
    expect(unset(after)).toBe(before);
  });

  it("works with an existing trailing comma", () => {
    const after = set('{\n  "m": {\n    "a": 1, // c\n  }\n}\n');
    // The file ends its lists with a comma, so the new entry does too.
    expect(after).toBe(`{\n  "m": {\n    "a": 1, // c\n    ${NEW},\n  }\n}\n`);
    expect(parseJsonc(after)).toMatchObject({ kind: "ok" });
  });

  it("removes from the start and the middle without touching the rest", () => {
    expect(unset(`{\n  "m": {\n    ${NEW},\n    "b": { "x": 1 } // b\n  }\n}\n`)).toBe('{\n  "m": {\n    "b": { "x": 1 } // b\n  }\n}\n');
    expect(unset(`{\n  "m": {\n    "a": 1, // a\n    // mine\n    ${NEW},\n    "b": 2\n  }\n}\n`)).toBe(
      '{\n  "m": {\n    "a": 1, // a\n    // mine\n    "b": 2\n  }\n}\n',
    );
  });

  it("leaves strict JSON strict after removing the last property", () => {
    const result = unset(`{\n  "m": {\n    "a": 1,\n    ${NEW}\n  }\n}\n`);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toEqual({ m: { a: 1 } });
  });

  it("does nothing when there is nothing to remove", () => {
    expect(unset(CURSOR_FIXTURE)).toBe(CURSOR_FIXTURE);
    expect(unset("")).toBe("");
  });
});

describe("parseJsonc", () => {
  it("accepts comments and trailing commas", () => {
    expect(parseJsonc('{ // c\n "a": 1, }')).toMatchObject({ kind: "ok", value: { a: 1 } });
  });
  it.each(['{ "a": ', "[1, 2]", "nonsense", '{ "a": 1 } trailing'])("refuses %s", (text) => {
    expect(parseJsonc(text).kind).toBe("invalid");
  });
});

describe("writeAtomic", () => {
  it("creates missing directories and leaves no temp file behind", async () => {
    const env = fakeEnv();
    const path = join(env.home, "deep", "er", "mcp.json");
    await writeAtomic(path, "{}\n");
    expect(env.read(path)).toBe("{}\n");
    expect(readdirSync(join(env.home, "deep", "er"))).toEqual(["mcp.json"]);
    expect(await readJsonc(path)).toMatchObject({ kind: "ok" });
    expect(await readJsonc(join(env.home, "nope.json"))).toEqual({ kind: "missing" });
  });

  it("keeps the file mode and a symlink", async () => {
    const env = fakeEnv();
    const real = join(env.home, "dotfiles", "mcp.json");
    env.write(real, "old");
    chmodSync(real, 0o600);
    mkdirSync(join(env.home, ".cursor"));
    const link = join(env.home, ".cursor", "mcp.json");
    symlinkSync(real, link);

    await writeAtomic(link, "new");
    expect(readlinkSync(link)).toBe(real);
    expect(env.read(real)).toBe("new");
    expect(statSync(real).mode & 0o777).toBe(0o600);
  });

  it("leaves the original when the write fails", async () => {
    const env = fakeEnv();
    const dir = join(env.home, "locked");
    const path = join(dir, "mcp.json");
    env.write(path, "original");
    chmodSync(dir, 0o500);
    try {
      await expect(writeAtomic(path, "new")).rejects.toThrow();
      expect(env.read(path)).toBe("original");
      expect(readdirSync(dir)).toEqual(["mcp.json"]);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

// The editor works on text, so it is checked against many generated files:
// whatever the layout, the result parses, differs from the original in one
// key only, and removing the key gives the original text back.
describe("editKey on generated files", () => {
  const random = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  function generate(rand: () => number): { text: string; hasServers: boolean } {
    const pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)]!;
    const eol = pick(["\n", "\n", "\r\n"]);
    const unit = pick(["  ", "    ", "\t"]);
    const comment = () => pick(["", "", " // note", " /* note */"]);
    const value = () =>
      pick(['"x"', "1", "true", "null", '[1, 2,   3]', '{ "command": "npx", "args": ["-y", "tool"] }', '{"url":"https://example.com/mcp"}']);
    const server = (i: number) => `${unit}${unit}"server-${i}": ${value()}`;

    const count = Math.floor(rand() * 4);
    const trailing = rand() < 0.3 ? "," : "";
    const servers = Array.from({ length: count }, (_, i) => server(i));
    const body =
      count === 0
        ? pick(["{}", "{ }", `{${eol}${unit}}`])
        : `{${comment()}${eol}${servers.map((s, i) => s + (i < count - 1 ? "," : trailing) + comment()).join(eol)}${eol}${unit}}`;

    const hasServers = rand() < 0.8;
    const lines = [`${unit}"editor.fontSize": 14`];
    if (hasServers) lines.splice(rand() < 0.5 ? 0 : 1, 0, `${unit}"mcpServers": ${body}`);
    if (rand() < 0.5) lines.push(`${unit}"last": ${value()}`);
    const head = rand() < 0.3 ? `// Settings${eol}` : "";
    const text = `${head}{${eol}${lines.map((l, i) => l + (i < lines.length - 1 ? "," : rand() < 0.2 ? "," : "") + comment()).join(eol)}${eol}}${pick(["", eol])}`;
    return { text, hasServers };
  }

  it("changes one key only and can be undone", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const { text, hasServers } = generate(random(seed));
      const before = parse(text);
      const added = editKey(text, ["mcpServers", "loookin"], ENTRY);

      const parsed = parseJsonc(added);
      expect(parsed.kind, `seed ${seed}:\n${text}\n->\n${added}`).toBe("ok");
      expect(parse(added), `seed ${seed}`).toEqual({
        ...before,
        mcpServers: { ...(before.mcpServers ?? {}), loookin: ENTRY },
      });
      // Every comment of the original survives.
      const comments = (t: string) => (t.match(/\/\/ \w+|\/\* note \*\//g) ?? []).length;
      expect(comments(added), `seed ${seed}:\n${text}\n->\n${added}`).toBe(comments(text));

      const removed = editKey(added, ["mcpServers", "loookin"], undefined);
      expect(parse(removed), `seed ${seed}`).toEqual(hasServers ? before : { ...before, mcpServers: {} });
      // Where the servers object already had entries on their own lines, undoing is exact.
      if (hasServers && Object.keys(before.mcpServers).length && !/"mcpServers": \{[^\n]*\}/.test(text)) {
        expect(removed, `seed ${seed}:\n${text}\n->\n${added}\n->\n${removed}`).toBe(text);
      }
    }
  });
});
