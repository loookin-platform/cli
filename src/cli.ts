import { HELP, parse } from "./args";
import { init } from "./commands/init";
import { mcpAdd } from "./commands/mcp-add";
import { mcpList } from "./commands/mcp-list";
import { mcpRemove } from "./commands/mcp-remove";
import type { Env } from "./env";
import { UsageError } from "./errors";

/**
 * Runs one command and returns the exit code: 0 done (or nothing to do),
 * 1 error or declined confirmation, 2 wrong parameters. Output is plain text
 * without colours, so it reads the same in a terminal, a pipe and a log.
 */
export async function runCli(argv: string[], env: Env, version: string): Promise<number> {
  try {
    const parsed = parse(argv);
    if (parsed.kind === "version") {
      env.out(version);
      return 0;
    }
    if (parsed.kind === "help") {
      env.out(HELP[parsed.topic]);
      return 0;
    }
    const { flags } = parsed;
    switch (parsed.command) {
      case "mcp add":
        return await mcpAdd(env, flags);
      case "mcp list":
        return await mcpList(env, flags);
      case "mcp remove":
        return await mcpRemove(env, flags);
      case "init":
        return await init(env);
    }
  } catch (error) {
    env.err((error as Error).message);
    return error instanceof UsageError ? 2 : 1;
  }
}
