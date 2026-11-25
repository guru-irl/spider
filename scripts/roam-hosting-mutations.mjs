#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run from the source checkout with an independent initialized copy and a single-file test runner.
// Usage: node scripts/roam-hosting-mutations.mjs <copy-root> <runner>
const source = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
if (process.argv.length !== 4) throw new Error("Pass an independent copy root and a single-file test runner");
const copy = realpathSync(resolve(process.argv[2])), runner = realpathSync(resolve(process.argv[3]));
if (copy === source || copy.startsWith(source + sep) || source.startsWith(copy + sep)) throw new Error("The mutation copy must be independent");
if (!statSync(join(copy, ".git")).isDirectory()) throw new Error("The copy must have its own git directory");
const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: copy, encoding: "utf8" });
if (top.status !== 0 || realpathSync(top.stdout.trim()) !== copy) throw new Error("The copy must be its own repository");
if (realpathSync(join(copy, "node_modules")) !== join(copy, "node_modules")) throw new Error("Do not share node_modules through a symlink");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const mutants = [
  {
    name: "drop-inspection-cause", file: "packages/roam/src/supervisor.ts",
    before: 'check === "inspection" ? cause ?? "inspection-unavailable"',
    after: 'check === "inspection" ? "inspection-unavailable"',
    test: "packages/roam/src/__tests__/supervisor.test.ts",
    testName: "preserves a safe inspection cause in the record, journal and doctor: ENOENT",
  },
  {
    name: "skip-destination-capture", file: "packages/roam/src/move-ports.ts",
    before: "async function initializeCapture(): Promise<void> {",
    after: "async function initializeCapture(): Promise<void> { return;",
    test: "packages/roam/src/__tests__/move-ports.test.ts",
    testName: "destination activation enables capture before exact hosting with several maps, already activated=false",
  },
  {
    name: "omit-pending-capture-repair", file: "packages/roam/src/move-ports.ts",
    before: "          await initializeCapture();\n        });",
    after: "        });",
    test: "packages/roam/src/__tests__/move-ports.test.ts",
    testName: "destination activation enables capture before exact hosting with several maps, already activated=true",
  },
];
const originals = new Map(mutants.map(({ file }) => [file, readFileSync(join(source, file), "utf8")]));
for (const [file, original] of originals) {
  if (readFileSync(join(copy, file), "utf8") !== original) throw new Error(`The copy differs from the source: ${file}`);
}
function run(spec) {
  const result = spawnSync("bash", [runner, spec.test, "-t", spec.testName], { cwd: copy, encoding: "utf8" });
  const output = result.stdout + result.stderr;
  const log = /^Full test log: (.+)$/m.exec(output)?.[1];
  if (!log || result.signal || result.error || ![0, 1].includes(result.status)) throw new Error(`Test run was inconclusive for ${spec.name}`);
  if (!realpathSync(log).startsWith(copy + sep)) throw new Error("The runner wrote its log outside the copy");
  return { exit: result.status, log, text: readFileSync(log, "utf8") };
}
const results = [];
try {
  for (const spec of mutants) {
    const original = originals.get(spec.file);
    if (original.split(spec.before).length !== 2) throw new Error(`Mutation anchor is not unique: ${spec.name}`);
    const baseline = run(spec);
    if (baseline.exit !== 0 || !/Tests\s+1 passed/.test(baseline.text)) throw new Error(`Baseline failed or did not run the named test: ${spec.name}`);
    try {
      writeFileSync(join(copy, spec.file), original.replace(spec.before, spec.after));
      const mutant = run(spec);
      const caught = mutant.exit === 1 && mutant.text.includes(`> ${spec.testName}`) && /AssertionError/.test(mutant.text);
      results.push({ mutant: spec.name, test: spec.testName, caught, baselineLog: baseline.log, mutantLog: mutant.log });
      if (!caught) throw new Error(`Named test did not catch ${spec.name}`);
    } finally { writeFileSync(join(copy, spec.file), original); }
  }
} finally {
  for (const [file, original] of originals) {
    if (readFileSync(join(source, file), "utf8") !== original) throw new Error(`The source changed during mutation testing: ${file}`);
    if (readFileSync(join(copy, file), "utf8") !== original) throw new Error(`The copy was not restored: ${file}`);
  }
  console.log(JSON.stringify({ results, sourceUnchanged: true, copyRestored: true,
    sourceHashes: Object.fromEntries([...originals].map(([file, text]) => [file, digest(text)])) }, null, 2));
}
