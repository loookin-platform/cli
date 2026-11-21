import type { Env } from "../env";

export type ClientId = "claude-code" | "codex" | "cursor" | "vscode" | "claude-desktop";

/** Where the entry lives: the user's own settings, or the project in cwd. */
export type Scope = "user" | "project";

/** One MCP server entry as a client has it. Only remote servers carry a URL. */
export interface Entry {
  name: string;
  url?: string;
}

export interface ReadResult {
  /** File or place the entries come from, for display. */
  location: string;
  entries: Entry[];
  /** Set when the CLI cannot make sense of the configuration and must not touch it. */
  unreadable?: string;
  /** Set when the client's own command did not answer (timeout, not runnable). */
  failed?: string;
}

/** States of a client in the `mcp add` plan (the contract's wording). */
export type AddState = "will add" | "already set" | "will replace" | "manual" | "skipped" | "not found" | "failed";

export type RemoveState = "will remove" | "not set" | "manual" | "skipped" | "not found" | "failed";

/**
 * One AI client. Every client is a single file with this shape, so adding
 * another one is one module and its tests.
 */
export interface Client {
  id: ClientId;
  label: string;
  /** False when the client has no per-project configuration. */
  hasProjectScope: boolean;
  /** True when the CLI can only tell the user what to do (Claude Desktop). */
  manualOnly?: boolean;

  /** Is the client installed on this machine? */
  detect(env: Env): Promise<boolean>;
  /** Current entries. `name` is the entry asked about; clients that can list return all. */
  read(env: Env, scope: Scope, name: string): Promise<ReadResult>;

  /** What `add` would do, in words: the file and the change, or the command. */
  describeAdd(env: Env, scope: Scope, name: string, url: string, replacing: boolean): string;
  add(env: Env, scope: Scope, name: string, url: string, replacing: boolean): Promise<void>;

  describeRemove(env: Env, scope: Scope, name: string): string;
  remove(env: Env, scope: Scope, name: string): Promise<void>;

  /** What to do by hand when the CLI must not or cannot do it. */
  manualAdd(env: Env, scope: Scope, name: string, url: string): string[];
  manualRemove(env: Env, scope: Scope, name: string): string[];

  /** What the user does after a successful add (restart, sign-in). */
  nextSteps(name: string): string[];
}
