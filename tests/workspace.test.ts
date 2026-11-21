import { describe, expect, it } from "vitest";
import { UsageError } from "../src/errors";
import { isLoookinMcpUrl, parseWorkspace, verifyWorkspace } from "../src/workspace";
import { fakeEnv, json } from "./helpers";

describe("parseWorkspace", () => {
  it.each([
    ["acme", "https://acme.loookin.com"],
    [" Acme ", "https://acme.loookin.com"],
    ["acme.loookin.com", "https://acme.loookin.com"],
    ["https://acme.loookin.com", "https://acme.loookin.com"],
    ["https://acme.loookin.com/api/mcp", "https://acme.loookin.com"],
    ["https://acme.loookin.com/developers?x=1", "https://acme.loookin.com"],
    ["sandbox.localhost:3000", "http://sandbox.localhost:3000"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["localhost", "http://localhost"],
  ])("%s → %s", (input, origin) => {
    expect(parseWorkspace(input)).toEqual({ origin, mcpUrl: `${origin}/api/mcp` });
  });

  it.each([
    ["http://acme.loookin.com", /https/],
    ["ftp://acme.loookin.com", /https/],
    ["https://acme.loookin.com:8443", /port/],
    ["acme.loookin.com:8443", /port/],
    ["https://user:pass@acme.loookin.com", /credentials/],
    ["https://token@acme.loookin.com", /credentials/],
    ["", /empty/],
    ["not a host", /not a workspace/],
  ])("rejects %s", (input, message) => {
    expect(() => parseWorkspace(input)).toThrow(UsageError);
    expect(() => parseWorkspace(input)).toThrow(message);
  });
});

describe("verifyWorkspace", () => {
  const workspace = parseWorkspace("acme");

  it("accepts a discovery document that names the MCP address", async () => {
    const env = fakeEnv();
    expect(await verifyWorkspace(env, workspace)).toEqual({ ok: true });
    expect(env.fetched).toEqual(["https://acme.loookin.com/.well-known/oauth-protected-resource/api/mcp"]);
  });

  it("reports a workspace that does not exist", async () => {
    const env = fakeEnv({ fetch: () => json(404, { error: "not_found" }) });
    expect(await verifyWorkspace(env, workspace)).toMatchObject({ ok: false, reason: "not-loookin" });
  });

  it.each([
    ["another resource", json(200, { resource: "https://other.loookin.com/api/mcp" })],
    ["not JSON", new Response("<html>", { status: 200 })],
    ["a redirect", new Response(null, { status: 307, headers: { Location: "/login" } })],
  ])("does not accept %s", async (_label, response) => {
    const env = fakeEnv({ fetch: () => response });
    expect(await verifyWorkspace(env, workspace)).toMatchObject({ ok: false, reason: "not-loookin" });
  });

  it("tells a network failure apart", async () => {
    const env = fakeEnv({
      fetch: () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await verifyWorkspace(env, workspace)).toMatchObject({ ok: false, reason: "network" });
  });
});

it("recognises the MCP address of any workspace", () => {
  expect(isLoookinMcpUrl("https://acme.loookin.com/api/mcp")).toBe(true);
  expect(isLoookinMcpUrl("https://acme.loookin.com/api/mcp/")).toBe(true);
  expect(isLoookinMcpUrl("https://mcp.sentry.dev/mcp")).toBe(false);
  expect(isLoookinMcpUrl("https://evil-loookin.com/api/mcp")).toBe(false);
  expect(isLoookinMcpUrl("nonsense")).toBe(false);
});
