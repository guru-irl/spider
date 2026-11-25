#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Usage: node scripts/check-roam-session-folder-mutants.mjs <copy> <source> <runner> <reports>
// Prepare an independent copy, including node_modules, before running this check.
const [copyArg, sourceArg, runner, reportsArg] = process.argv.slice(2);
if (!copyArg || !sourceArg || !runner || !reportsArg) throw new Error("Expected copy, source, single-file runner and reports directory");
const copy = realpathSync(copyArg), source = realpathSync(sourceArg), reports = resolve(reportsArg);
if (copy === source || copy.startsWith(source + "/") || source.startsWith(copy + "/")) throw new Error("Mutation copy must be separate from the source");
const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: copy, encoding: "utf8" });
if (top.status !== 0 || realpathSync(top.stdout.trim()) !== copy) throw new Error("Copy must be its own repository");
if (!existsSync(join(copy, ".git", "config"))) throw new Error("Use an independent repository, not a shared worktree");
mkdirSync(reports, { recursive: true });
const test = "packages/host/src/roam/__tests__/roam-session-folder.test.ts";
const folder = "packages/roam/src/session-folder.ts", ports = "packages/roam/src/move-ports.ts";
const mutations = [
  { name: "skip-local-folder-check", file: ports,
    from: '        await required(bindings.checkSessionFile, "checkSessionFile")(local.file);', to: "        // mutant: skipped source policy",
    caughtBy: "refuses custom session folders before home, fence or pending move" },
  { name: "textual-folder-prefix", file: folder,
    from: 'if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))', to: "if (!transcript.startsWith(folder))",
    caughtBy: "refuses prefix session folders before home, fence or pending move" },
  { name: "skip-transcript-realpath", file: folder,
    from: "transcript = await realpath(file);", to: "transcript = file;",
    caughtBy: "allows symlink session paths at preflight" },
  { name: "skip-first-move-membership", file: ports,
    from: "seeded = seedSession(stores.open(key), id, home.epoch, key, participant.config.limits.targetBatchBytes);", to: "seeded = { complete: true, through: 0 };",
    caughtBy: "a standard first-home move reaches the real frozen usage ledger with local machine identity" },
  { name: "skip-remote-folder-check", file: ports,
    from: '\n    await required(bindings.checkSessionFile, "checkSessionFile")(local.file);', to: "\n    // mutant: skipped remote source policy",
    caughtBy: "remote location preflight refuses an unsupported transcript on its source machine" },
];
const originals = new Map();
for (const file of new Set([test, ...mutations.map(mutation => mutation.file)])) {
  const original = readFileSync(join(source, file), "utf8");
  if (readFileSync(join(copy, file), "utf8") !== original) throw new Error(`Copy differs before mutation: ${file}`);
  originals.set(file, original);
}
function run(name) {
  const result = spawnSync("bash", [runner, test], { cwd: copy, encoding: "utf8", timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  writeFileSync(join(reports, `${name}.log`), output);
  if (result.error || result.signal) throw new Error(`Runner did not finish: ${name}`);
  const path = /Full test log: ([^\n]+)/.exec(output)?.[1];
  if (!path) throw new Error(`Runner did not produce a test log: ${name}`);
  return { status: result.status, log: readFileSync(path, "utf8") };
}
const baseline = run("baseline");
if (baseline.status !== 0 || !/Test Files\s+1 passed/.test(baseline.log)) throw new Error("Baseline must pass before mutation");
const results = [];
for (const mutation of mutations) {
  const original = originals.get(mutation.file);
  if (original.split(mutation.from).length !== 2) throw new Error(`Mutation is not unique: ${mutation.name}`);
  try {
    writeFileSync(join(copy, mutation.file), original.replace(mutation.from, mutation.to));
    const result = run(mutation.name);
    const caught = result.status !== 0 && /Test Files\s+1 failed/.test(result.log) && result.log.includes(`> ${mutation.caughtBy}\n`);
    results.push({ mutant: mutation.name, caught, test: mutation.caughtBy });
    console.log(`${mutation.name}: ${caught ? "caught" : "SURVIVED or inconclusive"}`);
    if (!caught) throw new Error(`Mutant was not caught by its expected test: ${mutation.name}`);
  } finally { writeFileSync(join(copy, mutation.file), original); }
}
const restored = run("restored");
if (restored.status !== 0 || !/Test Files\s+1 passed/.test(restored.log)) throw new Error("Restored source must pass");
writeFileSync(join(reports, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(`${results.length} mutants caught; restored tests pass`);
