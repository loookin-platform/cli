import { parseArgs, type ParseArgsConfig } from "node:util";
import { CLIENT_IDS } from "./clients";
import { UsageError } from "./errors";

export type CommandName = "mcp add" | "mcp list" | "mcp remove" | "init";

export type Parsed =
  | { kind: "help"; topic: CommandName | "mcp" | "root" }
  | { kind: "version" }
  | { kind: "run"; command: CommandName; flags: Flags };

/** Every flag of every command, already typed. Unused ones keep their default. */
export interface Flags {
  workspace?: string;
  client: string[];
  project: boolean;
  name?: string;
  yes: boolean;
  dryRun: boolean;
  target?: string;
  noInstall: boolean;
  noFile: boolean;
}

type Options = NonNullable<ParseArgsConfig["options"]>;

const workspace: Options = { workspace: { type: "string" } };
const change: Options = { yes: { type: "boolean" }, "dry-run": { type: "boolean" } };
const pick: Options = {
  client: { type: "string", multiple: true },
  project: { type: "boolean" },
  name: { type: "string" },
};

const OPTIONS: Record<CommandName, Options> = {
  "mcp add": { ...workspace, ...pick, ...change },
  "mcp list": { project: { type: "boolean" } },
  "mcp remove": { ...pick, ...change },
  init: {
    ...workspace,
    ...change,
    target: { type: "string" },
    "no-install": { type: "boolean" },
    "no-file": { type: "boolean" },
  },
};

const COMMON = `  --workspace <slug|host|url>  Workspace to connect: acme, acme.loookin.com or a full URL.
                               Asked for when missing.`;
const CHANGE = `  --yes                        Confirm every change without asking.
  --dry-run                    Print what would change and change nothing.`;
const PICK = `  --client <id>                One of: ${CLIENT_IDS.join(", ")}.
                               Repeatable. Default: every client found.
  --project                    Use the configuration of the project in the current
                               directory instead of your user settings.
  --name <name>                Name of the server entry. Default: loookin.`;
const HELP_FLAG = `  --help                       Show this help.`;

export const HELP: Record<CommandName | "mcp" | "root", string> = {
  root: `Usage: loookin <command> [options]

Commands:
  mcp add       Connect your AI clients to a workspace's MCP server
  mcp list      Show where Loookin is set up
  mcp remove    Remove Loookin from your AI clients
  init          Add event tracking to the project in this directory (not available yet)

Options:
  --help        Show help, also for a single command: loookin mcp add --help
  --version     Print the version

The CLI writes the server address only, never a key or a token. Without a
terminal it never asks: pass --yes, or --dry-run to preview.

Exit codes: 0 done (or nothing to do), 1 error or declined, 2 wrong parameters.`,

  mcp: `Usage: loookin mcp <add|list|remove> [options]

  add       Connect your AI clients to a workspace's MCP server
  list      Show where Loookin is set up
  remove    Remove Loookin from your AI clients

Run loookin mcp <command> --help for the options of each.`,

  "mcp add": `Usage: loookin mcp add [options]

Finds the AI clients on this machine, shows what it would do in each and,
once confirmed, adds the workspace's MCP server to them. Only the address is
written; each client signs in through the browser.

  Claude Code     runs \`claude mcp add\`
  Codex           runs \`codex mcp add\`
  Cursor          edits ~/.cursor/mcp.json
  VS Code         edits mcp.json of your user profile
  Claude Desktop  not written: remote servers are added in Settings → Connectors,
                  the CLI prints the address to paste

Checked by hand on macOS and Linux. Windows paths are in place but unverified.

Options:
${COMMON}
${PICK}
${CHANGE}
${HELP_FLAG}`,

  "mcp list": `Usage: loookin mcp list [options]

Shows, for every AI client found, the Loookin entry, its address and where it
is stored. Changes nothing.

Options:
  --project                    Look at the configuration of the project in the
                               current directory instead of your user settings.
${HELP_FLAG}`,

  "mcp remove": `Usage: loookin mcp remove [options]

Removes the Loookin entry from your AI clients and touches nothing else. A
sign-in the client saved for the server is not revoked.

Options:
${PICK}
${CHANGE}
${HELP_FLAG}`,

  init: `Usage: loookin init [options]

Adds @loookin/sdk to the project in the current directory and shows the code
to send your first events. Not available yet.

Options:
${COMMON}
  --target <web|server>        Override the detected project type.
  --no-install                 Do not install the SDK, only show the command.
  --no-file                    Do not create an example file, only print the code.
${CHANGE}
${HELP_FLAG}`,
};

const wantsHelp = (args: string[]) => args.includes("--help") || args.includes("-h");

function command(argv: string[]): { name: CommandName; rest: string[] } | { help: "mcp" | "root" } {
  const [first, second, ...rest] = argv;
  if (first === "init") return { name: "init", rest: argv.slice(1) };
  if (first === "mcp") {
    if (second === "add" || second === "list" || second === "remove") return { name: `mcp ${second}`, rest };
    if (second === undefined || second === "--help" || second === "-h") return { help: "mcp" };
    throw new UsageError(`Unknown command: mcp ${second}. Run loookin mcp --help.`);
  }
  if (first === undefined || first === "--help" || first === "-h" || first === "help") return { help: "root" };
  throw new UsageError(`Unknown command: ${first}. Run loookin --help.`);
}

export function parse(argv: string[]): Parsed {
  if (argv[0] === "--version" || argv[0] === "-v") return { kind: "version" };
  const found = command(argv);
  if ("help" in found) return { kind: "help", topic: found.help };
  if (wantsHelp(found.rest)) return { kind: "help", topic: found.name };

  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({ args: found.rest, options: OPTIONS[found.name], strict: true, allowPositionals: false }));
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\nRun loookin ${found.name} --help.`);
  }
  if (values.target !== undefined && values.target !== "web" && values.target !== "server") {
    throw new UsageError("--target must be web or server.");
  }

  return {
    kind: "run",
    command: found.name,
    flags: {
      workspace: values.workspace as string | undefined,
      client: (values.client as string[] | undefined) ?? [],
      project: values.project === true,
      name: values.name as string | undefined,
      yes: values.yes === true,
      dryRun: values["dry-run"] === true,
      target: values.target as string | undefined,
      noInstall: values["no-install"] === true,
      noFile: values["no-file"] === true,
    },
  };
}
