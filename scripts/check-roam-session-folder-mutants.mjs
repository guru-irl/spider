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
const boxTests = "packages/host/src/roam/__tests__/roam-box-moves.test.ts";
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
  { name: "use-hub-folder-for-box-source", file: ports, test: boxTests,
    from: '      if (home.machineId !== config.machineId) local = checkedLocation(successful(await call<unknown>(home, request.operation, "move-location")));',
    to: '      if (home.machineId !== config.machineId) { local = checkedLocation(successful(await call<unknown>(home, request.operation, "move-location"))); await required(bindings.checkSessionFile, "checkSessionFile")(local.file); }',
    caughtBy: "a production-composed box source completes a move to another box without outbound peers with unchanged folder policy" },
  { name: "recheck-frozen-cancel", file: "packages/roam/src/move-recovery.ts", test: boxTests,
    from: '  const id = request.operation.id;\n  ports.journal.record(id, "move-abort-start", {});',
    to: '  const id = request.operation.id;\n  await ports.check(request);\n  ports.journal.record(id, "move-abort-start", {});',
    caughtBy: "a production-composed frozen box source cancels without dialing the hub with changed folder policy" },
  { name: "recheck-rollback-transcript", file: ports, test: boxTests,
    from: "    const verifyOriginal = async () => {",
    to: '    const verifyOriginal = async () => {\n      await required(bindings.checkSessionFile, "checkSessionFile")(frozen.file);',
    caughtBy: "a production-composed box source rolls back to its live original process with changed folder policy" },
  { name: "recheck-completed-preflight", file: "packages/roam/src/move.ts", test: boxTests,
    from: "      if (completed) return structuredClone(completed.result.value) as T;",
    to: '      if (completed && (name !== "check" || !actionReceipt(ports.journal.read(id), "freeze"))) return structuredClone(completed.result.value) as T;',
    caughtBy: "a production-composed box source completes a move to another box without outbound peers with changed folder policy" },
];
const tests = [...new Set(mutations.map(mutation => mutation.test ?? test))];
const originals = new Map();
for (const file of new Set([...tests, ...mutations.map(mutation => mutation.file)])) {
  const original = readFileSync(join(source, file), "utf8");
  if (readFileSync(join(copy, file), "utf8") !== original) throw new Error(`Copy differs before mutation: ${file}`);
  originals.set(file, original);
}
function run(name, testFile) {
  const result = spawnSync("bash", [runner, testFile], { cwd: copy, encoding: "utf8", timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  writeFileSync(join(reports, `${name}.log`), output);
  if (result.error || result.signal) throw new Error(`Runner did not finish: ${name}`);
  const path = /Full test log: ([^\n]+)/.exec(output)?.[1];
  if (!path) throw new Error(`Runner did not produce a test log: ${name}`);
  return { status: result.status, log: readFileSync(path, "utf8") };
}
for (const [index, testFile] of tests.entries()) {
  const baseline = run(`baseline-${index}`, testFile);
  if (baseline.status !== 0 || !/Test Files\s+1 passed/.test(baseline.log)) throw new Error(`Baseline must pass before mutation: ${testFile}`);
}
const results = [];
for (const mutation of mutations) {
  const original = originals.get(mutation.file);
  if (original.split(mutation.from).length !== 2) throw new Error(`Mutation is not unique: ${mutation.name}`);
  try {
    writeFileSync(join(copy, mutation.file), original.replace(mutation.from, mutation.to));
    const result = run(mutation.name, mutation.test ?? test);
    const lines = result.log.split("\n");
    let failureLine = lines.findIndex(line => line === ` FAIL  ${mutation.test ?? test} > ${mutation.caughtBy}`);
    // Vitest shares one assertion body between consecutive failure headers.
    while (failureLine >= 0 && lines[failureLine]?.startsWith(" FAIL ")) failureLine++;
    const failure = failureLine >= 0 ? lines[failureLine] ?? "" : "";
    const caught = result.status !== 0 && /Test Files\s+1 failed/.test(result.log) &&
      failure.startsWith("AssertionError:") && !/timed out/i.test(failure);
    results.push({ mutant: mutation.name, caught, test: mutation.caughtBy });
    console.log(`${mutation.name}: ${caught ? "caught" : "SURVIVED or inconclusive"}`);
    if (!caught) throw new Error(`Mutant was not caught by its expected test: ${mutation.name}`);
  } finally { writeFileSync(join(copy, mutation.file), original); }
}
for (const [index, testFile] of tests.entries()) {
  const restored = run(`restored-${index}`, testFile);
  if (restored.status !== 0 || !/Test Files\s+1 passed/.test(restored.log)) throw new Error(`Restored source must pass: ${testFile}`);
}
writeFileSync(join(reports, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(`${results.length} mutants caught; restored tests pass`);
