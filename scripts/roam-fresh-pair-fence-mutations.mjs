// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Run only in an isolated worktree with no other writers.
// Output includes original source snapshots for recovery after a forced stop.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [runner, output, selected] = process.argv.slice(2);
if (!runner || !output) throw new Error("usage: node scripts/roam-fresh-pair-fence-mutations.mjs single-file-runner output-directory [comma-separated-mutations]");
const directory = resolve(output);
mkdirSync(directory, { recursive: true });
const registry = "packages/roam/src/intercom-registry.ts", production = "packages/roam/src/intercom-production.ts";
const endpointTests = "packages/roam/src/__tests__/intercom-fresh-pair-fence.test.ts";
const centralTests = "packages/roam/src/__tests__/intercom-production.test.ts";
function replace(text, before, after) {
  if (text.split(before).length !== 2) throw new Error(`mutation anchor is not unique: ${before}`);
  return text.replace(before, after);
}
const mutations = [
  { name: "any-retained-fence-is-complete", file: registry, tests: endpointTests, test: "incomplete predecessor",
    before: "      if (!fence) return { pending: false };",
    after: "      if (!fence) return { pending: false };\n      return { pending: false };" },
  { name: "ignore-owner-epoch", file: registry, tests: endpointTests, test: "incomplete predecessor.*epoch",
    before: "            record.revocationEpoch === fence.edge_epoch &&\n", after: "" },
  { name: "ignore-closed-fence", file: registry, tests: endpointTests, test: "incomplete predecessor.*(closed-fence|missing-unit)",
    before: "predecessors[0].unit?.closedFenceId === fence.fence_id", after: "true" },
  { name: "ignore-owning-pair", file: registry, tests: endpointTests, test: "completion proof.*renamed-owner",
    before: "(predecessorPairId === undefined || record.pair.pairId === predecessorPairId)", after: "true" },
  { name: "trust-fresh-pair-state", file: registry, tests: endpointTests, test: "completion proof.*missing-owner",
    before: "      if (predecessorPairId !== undefined) return { pending: true };\n", after: "" },
  { name: "discard-retained-fence", file: registry, tests: endpointTests, test: "completed predecessor permits",
    before: "fenceId: observation.predecessor?.fenceId ?? (reuse ? null : existing?.fenceId ?? null)",
    after: "fenceId: reuse ? null : existing?.fenceId ?? null" },
  { name: "reuse-revoked-epoch", file: registry, tests: endpointTests, test: "cannot reuse",
    before: "        if (observation.predecessor?.revocationEpoch === candidate.edgeEpoch) throw new Error(\"fresh-peer-consent-required\");\n", after: "" },
  { name: "restore-unscoped-peer-refusal", file: registry, tests: endpointTests, test: "completed predecessor permits",
    before: "      // A fresh pair carries a reference, never its predecessor's completion proof.",
    after: "      if (other !== scopedPeer) return { pending: true };\n      // A fresh pair carries a reference, never its predecessor's completion proof." },
  { name: "ignore-central-owner-epoch", file: production, tests: centralTests, test: "requires the central owner.*epoch",
    before: "record.revocationEpoch === first.value.edgeEpoch && record.revocationEpoch === second.value.edgeEpoch", after: "true" },
  { name: "ignore-central-owner-completion", file: production, tests: centralTests, test: "requires the central owner",
    before: 'owner?.state !== "revoked" || owner.cleanupReason !== null || owner.unit !== undefined && owner.unit.closedFenceId !== first.value.fenceId',
    after: "false" },
];
const names = selected?.split(",");
if (names?.some(name => !mutations.some(mutation => mutation.name === name))) throw new Error(`unknown mutation: ${selected}`);
const chosen = names ? mutations.filter(mutation => names.includes(mutation.name)) : mutations;
function runTests(name, file, pattern) {
  const report = join(directory, `${name}.json`);
  rmSync(report, { force: true });
  const args = [resolve(runner), file, ...(pattern ? ["-t", pattern] : []), "--reporter=json", `--outputFile=${report}`];
  const run = spawnSync("bash", args, { encoding: "utf8" });
  writeFileSync(join(directory, `${name}.log`), `${run.stdout ?? ""}${run.stderr ?? ""}`);
  if (run.error) throw run.error;
  return { status: run.status, result: JSON.parse(readFileSync(report, "utf8")) };
}
const originals = new Map([registry, production].map(file => [file, readFileSync(file, "utf8")]));
for (const [file, original] of originals) writeFileSync(join(directory, `original-${file.split("/").at(-1)}`), original);
for (const file of new Set(chosen.map(mutation => mutation.tests))) {
  const name = file === endpointTests ? "baseline-endpoint" : "baseline-central";
  const { status, result } = runTests(name, file, file === centralTests ? "checks the central predecessor|requires the central owner" : undefined);
  if (status !== 0 || !result.numPassedTests || result.numFailedTests) throw new Error(`baseline is not green: ${file}`);
  console.log(`${name}: ${result.numPassedTests} passed`);
}
const results = [];
for (const mutation of chosen) {
  for (const [file, original] of originals) {
    if (readFileSync(file, "utf8") !== original) throw new Error(`source changed before mutation: ${file}`);
  }
  const original = originals.get(mutation.file), changed = replace(original, mutation.before, mutation.after);
  try {
    writeFileSync(mutation.file, changed);
    const { status, result } = runTests(mutation.name, mutation.tests, mutation.test);
    const failures = result.testResults.flatMap(row => row.assertionResults.filter(test => test.status === "failed"));
    if (status !== 1 || !result.numFailedTests || !failures.length ||
        failures.some(test => !test.failureMessages.some(message => /AssertionError|promise resolved/.test(message)))) {
      throw new Error(`mutation survived or did not reach an assertion: ${mutation.name}`);
    }
    results.push({ mutation: mutation.name, failed: result.numFailedTests, tests: failures.map(test => test.title) });
    writeFileSync(join(directory, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
    console.log(`${mutation.name}: caught by ${result.numFailedTests} assertion failure(s)`);
  } finally {
    writeFileSync(mutation.file, original);
    if (readFileSync(mutation.file, "utf8") !== original) throw new Error(`source restoration failed: ${mutation.file}`);
  }
}
for (const [file, original] of originals) {
  if (readFileSync(file, "utf8") !== original) throw new Error(`source restoration failed: ${file}`);
}
writeFileSync(join(directory, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(`restored source bytes; ${results.length}/${chosen.length} mutants caught`);
