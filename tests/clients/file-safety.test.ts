import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cursor } from "../../src/clients/cursor";
import { fakeEnv } from "../helpers";

// The editor is replaced by one that makes the mistake the check exists for:
// the value comes out right and a comment is gone.
vi.mock("../../src/jsonc", async (original) => {
  const real = await original<typeof import("../../src/jsonc")>();
  return {
    ...real,
    editKey: (text: string, path: string[], value: unknown) => real.editKey(text, path, value).replace("// keep me", ""),
  };
});

const URL = "https://acme.loookin.com/api/mcp";
const CONFIG = `{
  "mcpServers": {
    "loookin": { "url": "${URL}" }
    // keep me
  }
}
`;

describe("the check before a config file is written", () => {
  it("refuses an edit that would drop a comment, on removal and on addition", async () => {
    const env = fakeEnv();
    const path = join(env.home, ".cursor", "mcp.json");
    env.write(path, CONFIG);

    await expect(cursor.remove(env, "user", "loookin")).rejects.toThrow(/left untouched.*could not be applied safely/);
    expect(env.read(path)).toBe(CONFIG);

    await expect(cursor.add(env, "user", "other", URL, false)).rejects.toThrow(/left untouched.*could not be applied safely/);
    expect(env.read(path)).toBe(CONFIG);
  });

  it("lets an edit through that keeps every comment", async () => {
    const env = fakeEnv();
    const path = join(env.home, ".cursor", "mcp.json");
    env.write(path, CONFIG.replace("keep me", "keep this"));
    await cursor.remove(env, "user", "loookin");
    expect(env.read(path)).toBe('{\n  "mcpServers": {\n    // keep this\n  }\n}\n');
  });
});
