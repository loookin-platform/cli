// The CLI runs through npx on someone else's machine and edits their config
// files, so every runtime dependency is supply-chain surface. This fails when
// one is added, or when the one we have starts running code at install time.
import { readFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const allowed = ["jsonc-parser"];
const problems = [];

const own = Object.keys(read("../package.json").dependencies ?? {});
if (own.join() !== allowed.join()) problems.push(`dependencies must be exactly [${allowed}], found [${own}]`);

for (const name of allowed) {
  const pkg = read(`../node_modules/${name}/package.json`);
  const nested = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies });
  if (nested.length) problems.push(`${name} has dependencies of its own: ${nested}`);
  const hooks = ["preinstall", "install", "postinstall"].filter((hook) => pkg.scripts?.[hook]);
  if (hooks.length) problems.push(`${name} runs install scripts: ${hooks}`);
}

if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`Runtime dependencies: ${allowed.join(", ")} (no install scripts, nothing nested).`);
