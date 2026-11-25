// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Run only in an idle, isolated worktree. The runner takes one test file.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [runner, output, baseline] = process.argv.slice(2);
if (!runner || !output) throw new Error('usage: node scripts/roam-prestage-mutations.mjs single-file-runner output-directory [baseline-ref]');
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git(['rev-parse', '--absolute-git-dir']) === git(['rev-parse', '--path-format=absolute', '--git-common-dir'])) {
  throw new Error('Use an isolated worktree.');
}
const directory = resolve(output), runFile = resolve(runner);
mkdirSync(directory, { recursive: true });
rmSync(join(directory, 'results.json'), { force: true });
const test = 'packages/roam/src/__tests__/prestage-diagnostics.test.ts';
const ports = 'packages/roam/src/move-ports.ts', codes = 'packages/roam/src/cause-codes.ts';
const agent = 'packages/roam/src/agent.ts', move = 'packages/roam/src/move.ts';
const diagnostic = 'packages/roam/src/private-transfer-diagnostics.ts';
const mutations = [
  { name: 'stage-blind-public-label', file: codes,
    before: 'return stage === "pre" ? "remote-prepare" : "transfer";', after: 'return "transfer";' },
  { name: 'coordinator-pre-unwrapped', file: ports,
    before: 'withPrivateTransferDiagnostic(journal, operation.id, stage, phase, effect);',
    after: 'stage === "pre" ? effect() : withPrivateTransferDiagnostic(journal, operation.id, stage, phase, effect);' },
  { name: 'participant-pre-unwrapped', file: ports,
    before: '=> stage === "pre" || stage === "final"', after: '=> stage === "final"' },
  { name: 'wrong-participant-journal-id', file: ports,
    before: 'withPrivateTransferDiagnostic(journal, String(operation.args.moveId), stage, phase, effect)',
    after: 'withPrivateTransferDiagnostic(journal, operation.id, stage, phase, effect)' },
  { name: 'prerequisite-parent-not-begun', file: ports,
    before: '["move-prerequisites", "move-export", "move-import"].includes(operation.kind)',
    after: '["move-export", "move-import"].includes(operation.kind)' },
  { name: 'outer-prestage-result-unwrapped', file: move,
    before: 'name === "prestage" || name === "transfer"', after: 'name === "transfer"' },
  { name: 'import-label-uses-request-stage', file: agent,
    before: 'plainObject(exported) && plainObject(exported.workspace) ? exported.workspace.stage : undefined',
    after: 'operation.args.stage' },
  { name: 'observer-stage-not-validated', file: diagnostic,
    before: '(row.stage !== "pre" && row.stage !== "final") || ', after: '',
    test: 'packages/roam/src/__tests__/private-transfer-diagnostics.test.ts' },
];
if (baseline) {
  const ref = git(['rev-parse', '--verify', `${baseline}^{commit}`]);
  mutations.unshift({ name: 'original-production-baseline', replacements: [ports, codes, agent, move, diagnostic].map(file =>
    ({ file, content: execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' }) })) });
}
mutations.unshift({ name: 'green-control', replacements: [], expectPass: true });
let restore;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { restore?.(); process.exit(1); });
const results = [];
for (const mutation of mutations) {
  const replacements = mutation.replacements ?? [{ file: mutation.file }];
  const originals = replacements.map(({ file }) => ({ file, content: readFileSync(file, 'utf8') }));
  if (!mutation.replacements && originals[0].content.split(mutation.before).length !== 2) {
    throw new Error(`mutation anchor is not unique: ${mutation.name}`);
  }
  const report = join(directory, `${mutation.name}.json`);
  rmSync(report, { force: true });
  const comparison = join(directory, `${mutation.name}-comparison.json`);
  rmSync(comparison, { force: true });
  restore = () => {
    for (const { file, content } of originals) writeFileSync(file, content);
    for (const { file, content } of originals) if (readFileSync(file, 'utf8') !== content) throw new Error(`source restoration failed: ${file}`);
  };
  try {
    for (const [index, replacement] of replacements.entries()) {
      writeFileSync(replacement.file, replacement.content ?? originals[index].content.replace(mutation.before, mutation.after));
    }
    const run = spawnSync('bash', [runFile, mutation.test ?? test, '--reporter=json', `--outputFile=${report}`],
      { encoding: 'utf8', env: { ...process.env, SPIDER_TEST_TRANSFER_COMPARISON: comparison } });
    writeFileSync(join(directory, `${mutation.name}.log`), `${run.stdout ?? ''}${run.stderr ?? ''}`);
    if (run.error) throw run.error;
    const result = JSON.parse(readFileSync(report, 'utf8'));
    const failed = result.testResults.flatMap(row => row.assertionResults).filter(row => row.status === 'failed');
    if (mutation.expectPass ? run.status !== 0 || !result.success || !result.numPassedTests :
      run.status === 0 || !failed.length || result.numFailedTests !== failed.length || failed.some(row =>
        !row.failureMessages.some(message => message.includes('AssertionError')) || row.failureMessages.some(message => /timed out|Transform failed/.test(message)))) {
      throw new Error(`unexpected control or mutation result: ${mutation.name}`);
    }
    if (!mutation.test) {
      const observed = JSON.parse(readFileSync(comparison, 'utf8'));
      if (!observed.failure?.step || !Array.isArray(observed.coordinator) || !Array.isArray(observed.participant))
        throw new Error(`missing deciding comparison: ${mutation.name}`);
    }
    results.push({ mutation: mutation.name, failedTests: failed.length, passedTests: result.numPassedTests, tests: failed.map(row => row.title) });
    writeFileSync(join(directory, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(mutation.expectPass ? `${mutation.name}: ${result.numPassedTests} passed` : `${mutation.name}: caught by ${failed.length} failed test(s)`);
  } finally { restore(); restore = undefined; }
}
