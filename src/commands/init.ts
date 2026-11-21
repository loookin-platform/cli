import type { Env } from "../env";

/** Placeholder: the command and its flags are final, the behaviour comes next. */
export async function init(env: Env): Promise<number> {
  env.err("`loookin init` is not available yet. Use `loookin mcp add` to connect your AI clients.");
  return 1;
}
