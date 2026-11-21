import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createScanner, parse, parseTree, printParseErrorCode, SyntaxKind, type Node, type ParseError } from "jsonc-parser";

export type JsonObject = Record<string, unknown>;

export type JsoncFile =
  | { kind: "missing" }
  | { kind: "ok"; text: string; value: JsonObject }
  | { kind: "invalid"; reason: string };

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses JSON with comments and trailing commas. An empty file is an empty object. */
export function parseJsonc(text: string): JsoncFile {
  if (!text.trim()) return { kind: "ok", text, value: {} };
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    const first = errors[0]!;
    return { kind: "invalid", reason: `${printParseErrorCode(first.error)} at offset ${first.offset}` };
  }
  if (!isObject(value)) return { kind: "invalid", reason: "the top level is not an object" };
  return { kind: "ok", text, value };
}

export async function readJsonc(path: string): Promise<JsoncFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", reason: (error as Error).message };
  }
  return parseJsonc(text);
}

/** Indentation unit and line ends of the file as it is, so an edit blends in. */
function style(text: string) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  return { eol, unit: indent?.startsWith("\t") ? "\t" : " ".repeat(indent?.length ?? 2) };
}

interface Edit {
  offset: number;
  length: number;
  content: string;
}

const apply = (text: string, edits: Edit[]) =>
  [...edits]
    .sort((a, b) => b.offset - a.offset)
    .reduce((out, e) => out.slice(0, e.offset) + e.content + out.slice(e.offset + e.length), text);

const end = (node: Node) => node.offset + node.length;

/** Leading whitespace of the line that holds `offset`. */
function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start, offset))![0];
}

/** What sits between two nodes: the first comma, and where the last comma or comment ends. */
function gap(text: string, from: number, to: number): { comma?: number; contentEnd: number } {
  const scanner = createScanner(text, false);
  scanner.setPosition(from);
  let comma: number | undefined;
  let contentEnd = from;
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF && scanner.getTokenOffset() < to; kind = scanner.scan()) {
    const tokenEnd = scanner.getTokenOffset() + scanner.getTokenLength();
    if (kind === SyntaxKind.CommaToken) {
      comma ??= scanner.getTokenOffset();
      contentEnd = tokenEnd;
    } else if (kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia) {
      contentEnd = tokenEnd;
    }
  }
  return { comma, contentEnd };
}

/** A value as multi-line JSON whose following lines sit at `indent`. */
const render = (value: unknown, indent: string, { eol, unit }: { eol: string; unit: string }) =>
  JSON.stringify(value, null, unit).split("\n").join(eol + indent);

function insert(text: string, object: Node, key: string, value: unknown): Edit[] {
  const s = style(text);
  const close = end(object) - 1;
  const last = object.children?.at(-1);

  if (!last) {
    const indent = lineIndent(text, object.offset);
    const inner = text.slice(object.offset + 1, close);
    const property = `${s.eol}${indent}${s.unit}${JSON.stringify(key)}: ${render(value, indent + s.unit, s)}`;
    if (inner.includes("\n")) return [{ offset: object.offset + 1, length: 0, content: property }];
    // `{}` on one line opens up; anything inside it (a comment) stays.
    if (!inner.trim()) return [{ offset: object.offset + 1, length: inner.length, content: property + s.eol + indent }];
    return [
      { offset: object.offset + 1, length: 0, content: property },
      { offset: close, length: 0, content: s.eol + indent },
    ];
  }

  const { comma, contentEnd } = gap(text, end(last), close);
  // An object written on one line keeps its shape.
  if (!text.slice(object.offset, last.offset).includes("\n")) {
    const property = ` ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    return [{ offset: comma === undefined ? end(last) : comma + 1, length: 0, content: (comma === undefined ? "," : "") + property }];
  }
  // The new property goes on its own line after everything that is there,
  // so a comment behind the last property stays with that property.
  // A file that ends its lists with a comma keeps doing so, which also lets
  // a later removal give back exactly the original text.
  const indent = lineIndent(text, last.offset);
  const property = `${s.eol}${indent}${JSON.stringify(key)}: ${render(value, indent, s)}${comma === undefined ? "" : ","}`;
  const separator = comma === undefined ? [{ offset: end(last), length: 0, content: "," }] : [];
  if (separator.length && contentEnd === end(last)) return [{ offset: contentEnd, length: 0, content: `,${property}` }];
  return [...separator, { offset: contentEnd, length: 0, content: property }];
}

function remove(text: string, object: Node, property: Node): Edit[] {
  const siblings = object.children!;
  const index = siblings.indexOf(property);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  const after = gap(text, end(property), next ? next.offset : end(object) - 1);
  const cut = (from: number, to: number): Edit => ({ offset: from, length: to - from, content: "" });

  const lineStart = text.lastIndexOf("\n", property.offset - 1) + 1;
  const ownLine = lineStart > object.offset && !text.slice(lineStart, property.offset).trim();
  if (ownLine) {
    // Take the property's lines and its comma, nothing around them.
    const from = lineStart - (text[lineStart - 2] === "\r" ? 2 : 1);
    const edits = [cut(from, after.comma === undefined ? end(property) : after.comma + 1)];
    // It was the last one: the comma that led to it must go too, or strict
    // JSON is left with a trailing comma.
    if (!next && previous && after.comma === undefined) {
      const before = gap(text, end(previous), property.offset).comma;
      if (before !== undefined) edits.push(cut(before, before + 1));
    }
    return edits;
  }
  if (next) return [cut(property.offset, next.offset)];
  if (previous) return [cut(end(previous), end(property))];
  return [cut(property.offset, after.comma === undefined ? end(property) : after.comma + 1)];
}

const nest = (path: string[], value: unknown): unknown =>
  path.reduceRight((inner, key) => ({ [key]: inner }), value);

/**
 * Sets (or with `undefined` removes) one key and returns the new text.
 * Every other byte stays: comments, formatting, the neighbours' layout.
 *
 * The edits are computed here rather than with jsonc-parser's `modify`: with
 * formatting on, it reformats the whole line it inserts into (a neighbour
 * written on one line gets expanded), and on removal it takes the comments
 * around the property with it.
 */
export function editKey(text: string, path: string[], value: unknown): string {
  if (!text.trim()) return value === undefined ? text : `${JSON.stringify(nest(path, value), null, 2)}\n`;

  let object = parseTree(text, [], { allowTrailingComma: true });
  for (const [i, key] of path.entries()) {
    if (object?.type !== "object") throw new Error(`Cannot edit ${path.join(".")}: not an object.`);
    const property = object.children?.find((child) => child.children?.[0]?.value === key);
    const target = property?.children?.[1];
    if (!property || !target) {
      return value === undefined ? text : apply(text, insert(text, object, key, nest(path.slice(i + 1), value)));
    }
    if (i === path.length - 1) {
      if (value === undefined) return apply(text, remove(text, object, property));
      const content = render(value, lineIndent(text, property.offset), style(text));
      return apply(text, [{ offset: target.offset, length: target.length, content }]);
    }
    object = target;
  }
  return text;
}

/**
 * Replaces a file so that an interruption leaves either the old content or
 * the new one, never half: write a temp file next to it, then rename. A
 * symlinked config (dotfile managers) keeps its link, the target is replaced.
 */
export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const target = await realpath(path).catch(() => path);
  const mode = await stat(target).then(
    (s) => s.mode & 0o777,
    () => undefined,
  );
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temp, "wx", mode);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
