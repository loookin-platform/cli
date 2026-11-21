# @loookin/cli

Command line tool for [Loookin](https://loookin.com). Two things:

- **`mcp add`** connects the AI clients on your machine to the MCP server of
  your workspace.
- **`init`** adds event tracking with [`@loookin/sdk`](https://github.com/loookin-platform/sdk)
  to the project you run it in.

```bash
npx @loookin/cli mcp add --workspace acme
```

```bash
npx @loookin/cli init --workspace acme
```

`acme` is your workspace: the first part of `acme.loookin.com`. A host or a
full URL works too. Requires Node 22 or newer.

## What it never does

- It never writes a key, a token or a header anywhere. AI clients sign in
  through the browser; keys for the SDK stay with you.
- It never changes anything without showing it first and asking. `--dry-run`
  only shows.
- It never edits an existing source file of your project.
- It sends nothing anywhere, except one request to the workspace address to
  check that Loookin answers there. No telemetry.

## Connect AI clients

```bash
npx @loookin/cli mcp add --workspace acme
```

The command finds the supported clients, shows what it will do for each and
waits for your confirmation. The server is registered as `loookin` with the
address `https://acme.loookin.com/api/mcp`. On first use the client opens the
browser and you sign in to the workspace.

| Client | How |
|---|---|
| Claude Code | runs `claude mcp add --transport http --scope user` |
| Codex | runs `codex mcp add --url`, then you run `codex mcp login loookin` |
| Cursor | edits `~/.cursor/mcp.json` |
| VS Code | edits `mcp.json` of your user profile |
| Claude Desktop | instructions only: remote servers are added in Settings → Connectors |

Config files are edited in place: only the `loookin` entry changes, comments,
formatting and other servers stay. A file that does not parse or is read-only
is left alone and the command prints what to paste by hand.

Options:

| Option | Meaning |
|---|---|
| `--workspace <slug\|host\|url>` | The workspace. Asked for when missing. |
| `--client <id>` | Only this client: `claude-code`, `codex`, `cursor`, `vscode`, `claude-desktop`. Repeatable. |
| `--project` | Write to the configuration of the project in this directory instead of your user configuration. |
| `--name <name>` | Name of the server in the client. Default `loookin`. |
| `--yes` | Confirm without asking. |
| `--dry-run` | Show the plan, change nothing. |

See and undo:

```bash
npx @loookin/cli mcp list
```

```bash
npx @loookin/cli mcp remove
```

`mcp remove` deletes the entry. It does not sign the client out; that is done
in the client.

The workspace name is not checked: Loookin answers the same for every
subdomain. A typo shows up when the client fails to sign in.

## Add event tracking

Run it in the directory of your app (not in a monorepo root; inside a
monorepo the package manager is taken from the root of the repository):

```bash
npx @loookin/cli init --workspace acme
```

It tells you what it found (package manager, web or server, TypeScript), and
after confirmation:

1. installs `@loookin/sdk` with your package manager,
2. creates one new example file with `init`, `identify` and `track`
   (`createClient` and `track` on a server) and the workspace filled in,
3. prints the link to **Developers** in your workspace, where you create the
   key, and where to put it.

The example has `dryRun: true`: events are validated and nothing is stored.
Remove it to go live.

| Option | Meaning |
|---|---|
| `--target web\|server` | Skip detection. A project that is both gets two files. |
| `--no-install` | Do not install, print the command. |
| `--no-file` | Do not create a file, print the code. |
| `--yes`, `--dry-run` | As above. |

## Scripts and CI

Without a terminal the CLI never asks. Pass everything as options and add
`--yes`; a missing option is an error and nothing is changed. `mcp` commands
finish within 30 seconds even when a client does not answer.

Exit codes: `0` done or nothing to do, `1` error or declined, `2` wrong
options.

## Not verified yet

Windows. The paths are there, but nothing has been tried on it. Commands
that are `.cmd` shims there (`npm`, `pnpm`, `yarn`, `claude`) are not started:
the CLI prints the command for you to run.

## License

MIT
