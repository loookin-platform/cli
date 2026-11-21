# @loookin/cli

Connects your AI clients (Claude Code, Codex, Cursor, VS Code) to the MCP
server of a Loookin workspace. It writes the server URL only: no key, no
token. The client signs in through the browser on first use.

`loookin init`, run in the directory of your app, installs `@loookin/sdk`
with the project's package manager and creates one new example file with the
first calls. It never edits an existing file and never handles a key.

Not released yet. Full documentation comes with the first release.

```
loookin mcp add --workspace acme
loookin mcp list
loookin mcp remove
loookin init --workspace acme
```

Run `loookin --help` for every command and flag.
