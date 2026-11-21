import { chmodSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { commentsOf, editKey, parseJsonc, readJsonc, writeAtomic } from "../src/jsonc";
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
  ])("%s, and removal restores the file", (_label, before, after) => {
    expect(set(before)).toBe(after);
    expect(unset(after)).toBe(before);
  });

  it("opens up an empty one-line object", () => {
    expect(set('{\n  "m": {}\n}\n')).toBe(`{\n  "m": {\n    ${NEW}\n  }\n}\n`);
  });

  // `{}` and an object left open over two lines look the same once an entry
  // is in, so removal cannot restore both. It closes to `{}`, the usual shape.
  it("fills an empty multi-line object and closes it again on removal", () => {
    const after = set('{\n  "m": {\n  }\n}\n');
    expect(after).toBe(`{\n  "m": {\n    ${NEW}\n  }\n}\n`);
    expect(unset(after)).toBe('{\n  "m": {}\n}\n');
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

describe("editKey never removes a comment", () => {
  const unset = (text: string) => editKey(text, ["mcpServers", "loookin"], undefined);
  const MINE = '"loookin": { "url": "https://acme.loookin.com/api/mcp" }';

  it("keeps a commented-out server behind the only entry", () => {
    const text = `{\n  "mcpServers": {\n    ${MINE}\n    // "github": { "command": "npx" }\n  }\n}\n`;
    expect(unset(text)).toBe('{\n  "mcpServers": {\n    // "github": { "command": "npx" }\n  }\n}\n');
  });

  it.each([
    ["behind the only entry, on its line", `{"mcpServers": {\n  ${MINE}, // mine\n}}`, '{"mcpServers": {\n  // mine\n}}'],
    ["between two entries on one line", `{"mcpServers": {${MINE}, /* about b */ "b": {}}}`, '{"mcpServers": {/* about b */ "b": {}}}'],
    ["before the last entry on one line", `{"mcpServers": {"a": {}, /* mine */ ${MINE}}}`, '{"mcpServers": {"a": {} /* mine */}}'],
    ["between the entry and its comma", `{"mcpServers": {${MINE} /* mine */, "b": {}}}`, '{"mcpServers": {/* mine */ "b": {}}}'],
    ["inside a one-line object that empties", `{"mcpServers": { /* none yet */ ${MINE} }}`, '{"mcpServers": { /* none yet */ }}'],
    // The neighbour must not end up behind the `//` of the line above.
    ["above, with a neighbour on the entry's line", `{"mcpServers": {\n  // mine\n  ${MINE}, "b": {}\n}}`, '{"mcpServers": {\n  // mine\n  "b": {}\n}}'],
    ["above, with the closing brace on the entry's line", `{"mcpServers": {\n  "a": 1, // a\n  ${MINE} }}`, '{"mcpServers": {\n  "a": 1 // a\n  }}'],
  ])("%s", (_label, before, after) => {
    expect(unset(before)).toBe(after);
    expect(commentsOf(after)).toEqual(commentsOf(before));
  });

  it("closes the object only when nothing but whitespace is left", () => {
    expect(unset(`{"mcpServers": {\n  ${MINE},\n}}`)).toBe('{"mcpServers": {}}');
    expect(unset(`{"mcpServers": {\n  ${MINE} /* x */\n}}`)).toBe('{"mcpServers": {\n  /* x */\n}}');
  });

  it("keeps the trailing comma of a one-line object, so removal undoes the addition", () => {
    const before = '{ "mcpServers": { "a": 1, } }';
    const added = editKey(before, ["mcpServers", "loookin"], ENTRY);
    expect(added).toBe('{ "mcpServers": { "a": 1, "loookin": {"url":"https://acme.loookin.com/api/mcp"}, } }');
    expect(unset(added)).toBe(before);
  });
});

describe("a byte order mark", () => {
  const BOM = "\uFEFF";

  it("does not stop the file from parsing", () => {
    expect(parseJsonc(`${BOM}{ "a": 1 }`)).toEqual({ kind: "ok", text: `${BOM}{ "a": 1 }`, value: { a: 1 } });
    expect(parseJsonc(BOM)).toMatchObject({ kind: "ok", value: {} });
  });

  it("stays where it is through an edit", () => {
    const text = `${BOM}{\n  "mcpServers": {\n    "a": 1 // a\n  }\n}\n`;
    const added = editKey(text, ["mcpServers", "loookin"], ENTRY);
    expect(added.startsWith(`${BOM}{`)).toBe(true);
    expect(parseJsonc(added)).toMatchObject({ kind: "ok", value: { mcpServers: { a: 1, loookin: ENTRY } } });
    expect(editKey(added, ["mcpServers", "loookin"], undefined)).toBe(text);
    expect(editKey(BOM, ["mcpServers", "loookin"], ENTRY).startsWith(`${BOM}{`)).toBe(true);
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

  it("refuses a read-only file instead of replacing it", async () => {
    const env = fakeEnv();
    const path = join(env.home, "mcp.json");
    env.write(path, "original");
    chmodSync(path, 0o444);
    await expect(writeAtomic(path, "new")).rejects.toThrow(/read-only/);
    expect(env.read(path)).toBe("original");
    expect(statSync(path).mode & 0o777).toBe(0o444);
    expect(readdirSync(env.home)).toEqual(["mcp.json"]);
  });

  it("writes through a symlink whose target does not exist yet", async () => {
    const env = fakeEnv();
    mkdirSync(join(env.home, ".cursor"));
    const link = join(env.home, ".cursor", "mcp.json");
    // Relative, as dotfile managers write them: resolved from the link's directory.
    symlinkSync(join("..", "dotfiles", "mcp.json"), link);

    await writeAtomic(link, "new");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join("..", "dotfiles", "mcp.json"));
    expect(env.read(join(env.home, "dotfiles", "mcp.json"))).toBe("new");
    expect(readdirSync(join(env.home, ".cursor"))).toEqual(["mcp.json"]);
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

// The same on files where anything may sit in any gap: comments before and
// after every property, every comma and both braces, on one line or many.
// Each comment has its own text, so one that is lost or merged into another
// shows up.
describe("editKey on generated files with comments in every gap", () => {
  const random = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const MINE = '"loookin": {"url":"https://acme.loookin.com/api/mcp"}';

  /** A file with `others` servers; with `at`, the loookin entry is written in at that position. */
  function generate(rand: () => number, at?: number) {
    const pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)]!;
    const eol = pick(["\n", "\n", "\r\n"]);
    const unit = pick(["  ", "    ", "\t"]);
    const oneLine = rand() < 0.3;
    let id = 0;
    const block = () => `/* c${id++} */`;
    const line = (indent: string) => `// c${id++}${eol}${indent}`;
    // Thunks, so that only the comment that is used takes a number.
    const gap = (indent: string) => {
      const br = eol + indent;
      const flat = [() => "", () => " ", () => " ", () => ` ${block()} `, () => block()];
      const broken = [() => br, () => br, () => br, () => ` ${block()}${br}`, () => ` ${line(indent)}`, () => `${br}${line(indent)}`, () => `${br}${block()}${br}`, () => `${br}${block()} `];
      return pick(oneLine ? flat : [...flat, ...broken])();
    };
    const value = () => pick(['"x"', "1", "null", "[1, 2,   3]", '{ "command": "npx", "args": ["-y", "tool"] }', '{"url":"https://example.com/mcp"}']);
    const object = (properties: string[], indent: string) => {
      const inner = indent + unit;
      let out = `{${gap(inner)}`;
      properties.forEach((property, i) => {
        const last = i === properties.length - 1;
        out += property + gap(inner);
        if (!last || rand() < 0.3) out += `,${gap(last ? indent : inner)}`;
      });
      return `${out}}`;
    };

    const others = Math.floor(rand() * 4);
    const hasServers = at !== undefined || rand() < 0.85;
    const top = ['"editor.fontSize": 14'];
    if (hasServers) {
      const servers = Array.from({ length: others }, (_, i) => `"server-${i}"${rand() < 0.1 ? ` ${block()} ` : ""}: ${value()}`);
      if (at !== undefined) servers.splice(Math.floor(at * (others + 1)), 0, MINE);
      top.splice(rand() < 0.5 ? 0 : 1, 0, `"mcpServers": ${object(servers, unit)}`);
    }
    if (rand() < 0.5) top.push(`"last": ${value()}`);
    const text = `${rand() < 0.3 ? `// c${id++}${eol}` : ""}${object(top, "")}${pick(["", eol])}`;
    return { text, others, hasServers, comments: id };
  }

  const CASES = 20_000;
  const sorted = (text: string) => commentsOf(text).sort();

  it("adds and removes without losing a comment, and removal undoes the addition", () => {
    let exact = 0;
    for (let seed = 1; seed <= CASES; seed++) {
      const { text, others, hasServers, comments } = generate(random(seed));
      const before = parse(text);
      expect(commentsOf(text), `seed ${seed}`).toHaveLength(comments);

      const added = editKey(text, ["mcpServers", "loookin"], ENTRY);
      const trace = `seed ${seed}:\n${text}\n->\n${added}`;
      expect(parseJsonc(added).kind, trace).toBe("ok");
      expect(parse(added), trace).toEqual({ ...before, mcpServers: { ...(before.mcpServers ?? {}), loookin: ENTRY } });
      expect(sorted(added), trace).toEqual(sorted(text));

      const removed = editKey(added, ["mcpServers", "loookin"], undefined);
      expect(parseJsonc(removed).kind, `${trace}\n->\n${removed}`).toBe("ok");
      expect(parse(removed), `${trace}\n->\n${removed}`).toEqual(hasServers ? before : { ...before, mcpServers: {} });
      expect(sorted(removed), `${trace}\n->\n${removed}`).toEqual(sorted(text));
      // With another server in the object there is a layout to return to.
      if (hasServers && others > 0) {
        expect(removed, `${trace}\n->\n${removed}`).toBe(text);
        exact++;
      }
    }
    expect(exact).toBeGreaterThan(CASES / 2);
  });

  it("removes an entry it did not write, wherever it is, without losing a comment", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const rand = random(seed);
      const { text } = generate(rand, rand());
      const before = parse(text);
      const { loookin: _mine, ...rest } = before.mcpServers;

      const removed = editKey(text, ["mcpServers", "loookin"], undefined);
      const trace = `seed ${seed}:\n${text}\n->\n${removed}`;
      expect(parseJsonc(removed).kind, trace).toBe("ok");
      expect(parse(removed), trace).toEqual({ ...before, mcpServers: rest });
      expect(sorted(removed), trace).toEqual(sorted(text));
    }
  });
});

describe("editKey when the last server goes", () => {
  it("closes the emptied object and gives back a one-line original", () => {
    const original = '{\n  "servers": {}\n}\n';
    const added = editKey(original, ["servers", "loookin"], ENTRY);
    expect(editKey(added, ["servers", "loookin"], undefined)).toBe(original);
  });

  it("keeps a comment that sits in the emptied object", () => {
    const text = '{\n  "servers": {\n    // mine\n    "loookin": { "url": "x" }\n  }\n}\n';
    const removed = editKey(text, ["servers", "loookin"], undefined);
    expect(removed).toContain("// mine");
    expect(parseJsonc(removed)).toMatchObject({ kind: "ok", value: { servers: {} } });
  });
});
