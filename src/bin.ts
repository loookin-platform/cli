#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runCli } from "./cli";
import { realEnv } from "./env";

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  process.stderr.write(`@loookin/cli needs Node 22 or newer (this is ${process.versions.node}).\n`);
  process.exit(1);
}

// package.json sits next to dist/ in the published package.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

process.exitCode = await runCli(process.argv.slice(2), realEnv(), version);
