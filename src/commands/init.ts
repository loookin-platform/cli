import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Env } from "../env";
import { UsageError } from "../errors";
import { detectProject, SDK, type Project, type Target } from "../project/detect";
import { installCommand, installSdk } from "../project/install";
import { fileName, snippet, workspaceValue } from "../project/snippets";
import { ask, confirm } from "../prompt";
import { checkWorkspace, parseWorkspace, type Workspace } from "../workspace";
import { mcpAdd } from "./mcp-add";

export interface InitFlags {
  workspace?: string;
  target?: string;
  noInstall: boolean;
  noFile: boolean;
  yes: boolean;
  dryRun: boolean;
}

interface Sample {
  target: Target;
  /** Relative to the project, for the printout. */
  path: string;
  code: string;
  /** Why the code is only printed; undefined when the file is created. */
  printOnly?: string;
}

const LABEL: Record<Target, string> = { web: "web (browser)", server: "server (Node.js)" };
const EXISTS = "the file already exists and is left as it is";

async function targets(env: Env, flags: InitFlags, project: Project): Promise<Target[]> {
  if (flags.target === "web" || flags.target === "server") return [flags.target];
  if (project.kind === "both") return ["web", "server"];
  if (project.kind) return [project.kind];
  const answer = await ask(
    env,
    "No known framework in the dependencies. Is this a web app or a server? [web/server] ",
    "--target <web|server>",
    "to say what the project is",
  );
  if (answer !== "web" && answer !== "server") throw new UsageError(`"${answer}" is neither web nor server.`);
  return [answer];
}

function samples(flags: InitFlags, project: Project, workspace: Workspace, wanted: Target[]): Sample[] {
  return wanted.map((target) => {
    const path = join(project.hasSrc ? "src" : "", fileName(target, wanted.length > 1, project));
    const printOnly = flags.noFile ? "--no-file" : existsSync(join(project.dir, path)) ? EXISTS : undefined;
    return { target, path, code: snippet(target, workspace), printOnly };
  });
}

function describe(env: Env, project: Project, wanted: Target[]): void {
  const found = project.evidence.length ? ` (found ${project.evidence.join(", ")})` : "";
  const type = project.kind === "both" ? "web and server" : (project.kind ?? "not recognised");
  env.out(`\nProject:         ${project.dir}`);
  env.out(`Package manager: ${project.manager} (${project.managerSource})`);
  env.out(`Project type:    ${type}${found}`);
  env.out(`Example for:     ${wanted.join(" and ")}`);
  env.out(`TypeScript:      ${project.typescript ? "yes (tsconfig.json)" : "no"}`);
  env.out(`Modules:         ${project.esm ? 'ES modules ("type": "module")' : "CommonJS"}`);
}

function keyHelp(env: Env, workspace: Workspace, list: Sample[]): void {
  env.out(`\nAPI keys: ${workspace.origin}/developers`);
  for (const { target, path, printOnly } of list) {
    if (target === "web") {
      env.out(`  Web: create a publishable key and put it in place of "pub_..." in ${printOnly ? "the code above" : path}.`);
      env.out("       Add the origin of your site to the key's allowed origins.");
    } else {
      env.out("  Server: create a server key and set it as the LOOOKIN_KEY environment variable.");
      env.out("          Keep it out of the code and never commit it.");
    }
  }
  env.out("The CLI did not read or store any key.");
  env.out("The example has dryRun: true: events are validated and nothing is stored. Remove it to go live.");
}

/**
 * Adds the SDK to the project in the current directory and shows the first
 * calls. It may run the package manager and create new example files; it
 * never edits or overwrites a file that exists and never handles a key.
 */
export async function init(env: Env, flags: InitFlags): Promise<number> {
  const project = await detectProject(env);
  const input =
    flags.workspace ??
    (await ask(env, "Workspace (slug, host or URL): ", "--workspace <slug|host|url>", "to say which workspace receives the events"));
  const workspace = parseWorkspace(input);
  // Decided before anything else happens: without a terminal nobody can confirm.
  if (!flags.dryRun && !flags.yes && !env.tty) {
    throw new UsageError("Not running in a terminal, so nothing can be asked. Pass --yes to apply the changes or --dry-run to preview them.");
  }
  const wanted = await targets(env, flags, project);

  env.out(`Workspace: ${workspace.origin}`);
  env.out("The workspace name is not checked here. If it is wrong, the SDK's events will be refused.");
  if (!(await checkWorkspace(env, workspace, flags))) return 1;
  describe(env, project, wanted);

  const list = samples(flags, project, workspace, wanted);
  const install = !project.sdkInstalled && !flags.noInstall;
  const command = installCommand(project.manager);

  env.out("\nPlan:");
  if (project.sdkInstalled) env.out(`  skip     ${SDK} is already a dependency`);
  else if (install) env.out(`  run      ${command}`);
  else env.out(`  skip     install (--no-install); run it yourself: ${command}`);
  for (const sample of list) {
    if (sample.printOnly) env.out(`  print    ${LABEL[sample.target]} example, not written to ${sample.path}: ${sample.printOnly}`);
    else env.out(`  create   ${sample.path} (${LABEL[sample.target]} example)`);
  }
  env.out("  No existing file is changed.");

  const changes = install || list.some((sample) => !sample.printOnly);
  if (changes && !flags.dryRun && !flags.yes && !(await confirm(env, "\nApply these changes?"))) {
    env.out("Nothing was changed.");
    return 1;
  }

  let failed = false;
  if (!flags.dryRun) {
    if (install) {
      env.out(`\nRunning ${command} (up to 2 minutes)...`);
      const problem = await installSdk(env, project.manager);
      if (problem) {
        failed = true;
        env.err(`The install failed: ${problem}`);
        env.err(`Run it yourself: ${command}`);
      } else env.out(`Installed ${SDK}.`);
    }
    for (const sample of list) {
      if (sample.printOnly) continue;
      try {
        // "wx" fails if the file appeared in the meantime, so nothing is ever overwritten.
        await writeFile(join(project.dir, sample.path), sample.code, { flag: "wx" });
      } catch (error) {
        const exists = (error as NodeJS.ErrnoException).code === "EEXIST";
        sample.printOnly = exists ? EXISTS : `could not write it (${(error as Error).message})`;
        if (!exists) failed = true;
      }
    }
  }

  for (const sample of list) {
    const state = sample.printOnly ? `not written: ${sample.printOnly}` : flags.dryRun ? "would be created" : "created";
    env.out(`\n${sample.path} (${state}):\n`);
    env.out(sample.code);
  }
  if (list[0]!.path.endsWith(".mjs")) {
    env.out("This project is CommonJS and the SDK is ESM only, so the example is an .mjs file.");
    env.out(`Load it from CommonJS code with: await import("./${basename(list[0]!.path)}")`);
  }

  keyHelp(env, workspace, list);

  const mcpCommand = `npx @loookin/cli mcp add --workspace ${workspaceValue(workspace)}`;
  if (flags.dryRun) {
    env.out(`\nTo connect your AI clients to this workspace: ${mcpCommand}`);
    env.out("\nDry run: nothing was changed.");
    return 0;
  }
  // Only a person at a terminal who has not pre-confirmed everything is asked:
  // --yes covers what this command printed, not changes to AI clients.
  if (env.tty && !flags.yes && (await confirm(env, "\nConnect your AI clients to this workspace now?"))) {
    env.out("");
    const code = await mcpAdd(env, { workspace: workspace.origin, client: [], project: false, yes: false, dryRun: false });
    return failed ? 1 : code;
  }
  env.out(`\nTo connect your AI clients to this workspace: ${mcpCommand}`);
  return failed ? 1 : 0;
}
