import { randomBytes } from "node:crypto";
import { access, constants, lstat, mkdir, open, readFile, readlink, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createScanner, parse, parseTree, printParseErrorCode, SyntaxKind, type Node, type ParseError } from "jsonc-parser";

export type JsonObject = Record<string, unknown>;

export type JsoncFile =
  | { kind: "missing" }
  | { kind: "ok"; text: string; value: JsonObject }
  | { kind: "invalid"; reason: string };

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const BOM = "\uFEFF";

/** Some editors on Windows start a file with a byte order mark. It is not JSON. */
const splitBom = (text: string) => (text.startsWith(BOM) ? { bom: BOM, body: text.slice(1) } : { bom: "", body: text });

/**
 * Parses JSON with comments and trailing commas. An empty file is an empty
 * object. `text` in the result is the file as it is, byte order mark included.
 */
export function parseJsonc(text: string): JsoncFile {
  const { body } = splitBom(text);
  if (!body.trim()) return { kind: "ok", text, value: {} };
  const errors: ParseError[] = [];
  const value: unknown = parse(body, errors, { allowTrailingComma: true });
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

/** The text of every comment, in file order. An edit must leave each one in. */
export function commentsOf(text: string): string[] {
  const { body } = splitBom(text);
  const scanner = createScanner(body, false);
  const found: string[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
    if (kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia) found.push(body.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()));
  }
  return found;
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

/**
 * What sits between two nodes: the first comma, where the last comma or
 * comment ends, and whether the last thing there is a `//` comment (text put
 * behind it would become part of the comment).
 */
function gap(text: string, from: number, to: number): { comma?: number; contentEnd: number; endsInLineComment: boolean } {
  const scanner = createScanner(text, false);
  scanner.setPosition(from);
  let comma: number | undefined;
  let contentEnd = from;
  let endsInLineComment = false;
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF && scanner.getTokenOffset() < to; kind = scanner.scan()) {
    const tokenEnd = scanner.getTokenOffset() + scanner.getTokenLength();
    if (kind === SyntaxKind.CommaToken) {
      comma ??= scanner.getTokenOffset();
      contentEnd = tokenEnd;
      endsInLineComment = false;
    } else if (kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia) {
      contentEnd = tokenEnd;
      endsInLineComment = kind === SyntaxKind.LineCommentTrivia;
    }
  }
  return { comma, contentEnd, endsInLineComment };
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
    if (comma === undefined) return [{ offset: end(last), length: 0, content: `,${property}` }];
    // The list ended with a comma and still does.
    return [{ offset: comma + 1, length: 0, content: `${property},` }];
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

/** Where the run of spaces and tabs around `offset` starts and ends. */
const blankStart = (text: string, offset: number) => offset - /[ \t]*$/.exec(text.slice(0, offset))![0].length;
const blankEnd = (text: string, offset: number) => offset + /^[ \t]*/.exec(text.slice(offset))![0].length;
const endsLine = (text: string, offset: number) => offset >= text.length || text[offset] === "\n" || text.startsWith("\r\n", offset);

/**
 * Takes out a property and exactly one comma: the one behind it, or, when it
 * is the last property, the one that led to it. Comments are never part of a
 * cut, whichever side of the property they are on; only spaces, tabs and at
 * most the property's own line go with it.
 */
function remove(text: string, object: Node, property: Node): Edit[] {
  const siblings = object.children!;
  const index = siblings.indexOf(property);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  const open = object.offset + 1;
  const close = end(object) - 1;
  const before = gap(text, previous ? end(previous) : open, property.offset);
  const after = gap(text, end(property), next ? next.offset : close);
  const cut = (from: number, to: number): Edit => ({ offset: from, length: to - from, content: "" });

  // A comma right behind the property goes in the same cut. One further away
  // (a comment in between, another line) is cut on its own, and so is the one
  // before a last property, which would otherwise be left trailing.
  const adjacent = after.comma !== undefined && blankEnd(text, end(property)) === after.comma;
  const tail = adjacent ? after.comma! + 1 : end(property);
  const comma = adjacent ? undefined : (after.comma ?? (next ? undefined : before.comma));
  const edits = comma === undefined ? [] : [cut(comma, comma + 1)];

  // The only property goes: the object closes up to `{}` instead of keeping
  // an empty line, but only when nothing else is in it. A comment stays.
  if (!previous && !next) {
    const rest = text.slice(open, property.offset) + text.slice(end(property), close);
    if (!rest.replace(",", "").trim()) return [cut(open, close)];
  }

  const lineStart = text.lastIndexOf("\n", property.offset - 1) + 1;
  const ownLine = lineStart > object.offset && !text.slice(lineStart, property.offset).trim();
  const restEnd = blankEnd(text, tail);
  if (ownLine) {
    const lineBreak = lineStart - (text[lineStart - 2] === "\r" ? 2 : 1);
    // Nothing else on its lines: they go whole.
    if (endsLine(text, restEnd)) return [...edits, cut(lineBreak, restEnd)];
    // Only the closing brace follows: it moves up to where it was before the
    // property was added, unless a `//` comment there would swallow it.
    if (!next && !before.endsInLineComment && !text.slice(tail, close).trim()) return [...edits, cut(lineBreak, tail)];
    // A comment or a neighbour follows: it keeps the line and the indentation.
    return [...edits, cut(property.offset, restEnd)];
  }
  // Something else starts the line. What follows moves up to the property's
  // place; at the end of a line or of the list, the space before it goes instead.
  if (endsLine(text, restEnd) || !next) return [...edits, cut(blankStart(text, property.offset), tail)];
  return [...edits, cut(property.offset, restEnd)];
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
export function editKey(file: string, path: string[], value: unknown): string {
  const { bom, body } = splitBom(file);
  return bom + editBody(body, path, value);
}

function editBody(text: string, path: string[], value: unknown): string {
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

/** Follows symlinks to the file a path stands for, also when the last link points at nothing yet. */
async function linkTarget(path: string): Promise<string> {
  let target = path;
  // A dotfile manager may link a config that it has not created. Writing to
  // the path itself would replace the link with a file, so the link is read.
  for (let hops = 0; hops < 16; hops++) {
    try {
      return await realpath(target);
    } catch {
      const link = await lstat(target).then(
        (s) => s.isSymbolicLink(),
        () => false,
      );
      if (!link) return target;
      target = resolve(dirname(target), await readlink(target));
    }
  }
  throw new Error("too many levels of symbolic links");
}

/**
 * Replaces a file so that an interruption leaves either the old content or
 * the new one, never half: write a temp file next to it, then rename. A
 * symlinked config (dotfile managers) keeps its link, the target is replaced.
 * A file that is not writable is refused: the rename would get around a
 * protection its owner put there.
 */
export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const target = await linkTarget(path);
  if (target !== path) await mkdir(dirname(target), { recursive: true });
  const mode = await stat(target).then(
    (s) => s.mode & 0o777,
    () => undefined,
  );
  if (mode !== undefined) {
    await access(target, constants.W_OK).catch(() => {
      throw new Error("the file is read-only");
    });
  }
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
