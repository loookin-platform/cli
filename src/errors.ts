/** Wrong or missing parameters. Exit code 2. */
export class UsageError extends Error {}

/** Anything else that stops a command. Exit code 1. */
export class CliError extends Error {}
