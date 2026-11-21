import type { Env } from "./env";
import { UsageError } from "./errors";

export interface Workspace {
  /** `https://acme.loookin.com` */
  origin: string;
  /** `https://acme.loookin.com/api/mcp` */
  mcpUrl: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/i;
const VERIFY_TIMEOUT_MS = 5_000;

const isLocal = (hostname: string) => hostname === "localhost" || hostname.endsWith(".localhost");

/**
 * Accepts a slug (`acme`), a host (`acme.loookin.com`) or a full URL and
 * reduces it to an origin. The result ends up as an argument of other
 * programs and in config files, so it is validated here, once: https only,
 * no credentials, no port. Local development hosts are the exception.
 */
export function parseWorkspace(input: string): Workspace {
  const value = input.trim();
  if (!value) throw new UsageError("Workspace is empty. Pass a slug, a host or a URL.");

  let url: URL;
  try {
    if (SLUG.test(value) && !isLocal(value.toLowerCase())) url = new URL(`https://${value.toLowerCase()}.loookin.com`);
    else if (value.includes("://")) url = new URL(value);
    else url = new URL(`${isLocal(value.split(/[:/]/)[0]!.toLowerCase()) ? "http" : "https"}://${value}`);
  } catch {
    throw new UsageError(`"${value}" is not a workspace slug, host or URL.`);
  }

  const local = isLocal(url.hostname);
  if (url.username || url.password) throw new UsageError("The workspace address must not contain credentials.");
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new UsageError("The workspace address must use https (http is allowed for localhost only).");
  }
  if (url.port && !local) throw new UsageError("The workspace address must not contain a port.");

  return { origin: url.origin, mcpUrl: `${url.origin}/api/mcp` };
}

export type Verification = { ok: true } | { ok: false; reason: "not-loookin" | "network"; message: string };

/**
 * Asks the workspace for its OAuth discovery document, which every Loookin
 * workspace serves publicly. This is the only request the CLI ever makes.
 */
export async function verifyWorkspace(env: Env, workspace: Workspace): Promise<Verification> {
  const url = `${workspace.origin}/.well-known/oauth-protected-resource/api/mcp`;
  const notLoookin = (detail: string): Verification => ({
    ok: false,
    reason: "not-loookin",
    message: `No Loookin workspace answers at ${workspace.origin} (${detail}). Check the workspace name.`,
  });

  let res: Response;
  try {
    res = await env.fetch(url, {
      redirect: "manual",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "network", message: `Could not reach ${workspace.origin} to check the workspace.` };
  }
  if (res.status !== 200) return notLoookin(`HTTP ${res.status}`);

  const body: unknown = await res.json().catch(() => null);
  const resource = typeof body === "object" && body !== null ? (body as { resource?: unknown }).resource : undefined;
  return resource === workspace.mcpUrl ? { ok: true } : notLoookin("unexpected answer");
}

const trimSlash = (value: string) => value.replace(/\/+$/, "");

export const sameUrl = (a: string, b: string) => trimSlash(a) === trimSlash(b);

/** True for the MCP address of any Loookin workspace, whatever the entry is called. */
export function isLoookinMcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.endsWith(".loookin.com") && trimSlash(url.pathname) === "/api/mcp";
  } catch {
    return false;
  }
}
