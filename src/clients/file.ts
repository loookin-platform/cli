import { isDeepStrictEqual } from "node:util";
import type { Env } from "../env";
import { CliError } from "../errors";
import { editKey, isObject, parseJsonc, readJsonc, writeAtomic, type JsonObject, type JsoncFile } from "../jsonc";
import type { Entry, ReadResult, Scope } from "./types";

/** What differs between clients that keep MCP servers in a JSON file. */
export interface FileSpec {
  /** Top-level key that holds the servers. */
  key: string;
  path(env: Env, scope: Scope): string;
  /** The entry to write. URL only: never a key, a token or a header. */
  entry(url: string): Record<string, string>;
}

function entriesOf(file: JsoncFile, key: string): { entries: Entry[]; unreadable?: string } {
  if (file.kind === "missing") return { entries: [] };
  if (file.kind === "invalid") return { entries: [], unreadable: `the file does not parse (${file.reason})` };
  const servers = file.value[key];
  if (servers === undefined) return { entries: [] };
  if (!isObject(servers)) return { entries: [], unreadable: `"${key}" is not an object` };
  return {
    entries: Object.entries(servers).map(([name, value]) => ({
      name,
      url: isObject(value) && typeof value.url === "string" ? value.url : undefined,
    })),
  };
}

export async function readFileEntries(env: Env, spec: FileSpec, scope: Scope): Promise<ReadResult> {
  const location = spec.path(env, scope);
  return { location, ...entriesOf(await readJsonc(location), spec.key) };
}

/**
 * Sets or removes one server. Reads the file again right before writing, so
 * the edit applies to what is on disk now, and refuses a file it does not
 * understand instead of overwriting it.
 */
async function edit(env: Env, spec: FileSpec, scope: Scope, name: string, value: unknown): Promise<void> {
  const path = spec.path(env, scope);
  const file = await readJsonc(path);
  const { unreadable } = entriesOf(file, spec.key);
  if (unreadable) throw new CliError(`${path} was left untouched: ${unreadable}.`);
  if (file.kind !== "ok" && value === undefined) return;
  const before = file.kind === "ok" ? file.value : {};
  let text: string;
  try {
    text = editKey(file.kind === "ok" ? file.text : "", [spec.key, name], value);
  } catch (error) {
    throw new CliError(`${path} was left untouched: ${(error as Error).message}`);
  }
  // The edit is computed on the text. Before anything reaches the disk, the
  // result is parsed again and must be exactly the old content with this one
  // server changed; otherwise the file stays as it is.
  const after = parseJsonc(text);
  if (after.kind !== "ok" || !isDeepStrictEqual(after.value, expected(before, spec.key, name, value))) {
    throw new CliError(`${path} was left untouched: the edit could not be applied safely.`);
  }
  try {
    await writeAtomic(path, text);
  } catch (error) {
    throw new CliError(`Could not write ${path}: ${(error as Error).message}`);
  }
}

/** The content the file must have after the edit: `before` with one server set or removed. */
function expected(before: JsonObject, key: string, name: string, value: unknown): JsonObject {
  const servers = { ...(isObject(before[key]) ? before[key] : {}) };
  if (value === undefined) delete servers[name];
  else servers[name] = value;
  // Removing from a file that never had the key must not add an empty one.
  return value === undefined && before[key] === undefined ? before : { ...before, [key]: servers };
}

export const addToFile = (env: Env, spec: FileSpec, scope: Scope, name: string, url: string) =>
  edit(env, spec, scope, name, spec.entry(url));

export const removeFromFile = (env: Env, spec: FileSpec, scope: Scope, name: string) =>
  edit(env, spec, scope, name, undefined);

export const describeFileAdd = (env: Env, spec: FileSpec, scope: Scope, name: string, url: string) =>
  `edit ${spec.path(env, scope)}: set ${spec.key}.${name} = ${JSON.stringify(spec.entry(url))}`;

export const describeFileRemove = (env: Env, spec: FileSpec, scope: Scope, name: string) =>
  `edit ${spec.path(env, scope)}: delete ${spec.key}.${name}`;

export const manualFileAdd = (env: Env, spec: FileSpec, scope: Scope, name: string, url: string) => [
  `Add this under "${spec.key}" in ${spec.path(env, scope)}:`,
  `  ${JSON.stringify(name)}: ${JSON.stringify(spec.entry(url))}`,
];

export const manualFileRemove = (env: Env, spec: FileSpec, scope: Scope, name: string) => [
  `Delete "${name}" under "${spec.key}" in ${spec.path(env, scope)}.`,
];
