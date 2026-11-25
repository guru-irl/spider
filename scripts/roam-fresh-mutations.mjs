// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Run only in an idle, isolated worktree. The runner takes one test file.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [runner, output] = process.argv.slice(2);
if (!runner || !output) throw new Error('usage: node scripts/roam-fresh-mutations.mjs single-file-runner output-directory');
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git(['rev-parse', '--absolute-git-dir']) === git(['rev-parse', '--path-format=absolute', '--git-common-dir'])) {
  throw new Error('Use an isolated worktree.');
}
const directory = resolve(output), runFile = resolve(runner);
mkdirSync(directory, { recursive: true });
rmSync(join(directory, 'results.json'), { force: true });
const preparation = 'packages/host/src/roam/__tests__/roam-preparation-causes.test.ts';
const readiness = 'packages/host/src/roam/readiness.ts';
const admission = 'packages/host/src/roam/admission.ts';
const privateEvidence = 'packages/roam/src/private-transfer-diagnostics.ts';
const mutations = [
  { name: 'fresh-file-not-retried', file: readiness,
    before: 'return "pending-file";', after: 'return;',
    test: preparation, title: 'captures a fresh native session' },
  { name: 'first-persistence-not-observed', file: admission,
    before: "${file ? fileVersion(file) : 'no-session-file'}", after: 'unchanged-session',
    test: preparation, title: 'production discovery revision' },
  { name: 'native-file-public', file: readiness,
    before: 'handle.chmod(0o600)', after: 'handle.chmod(0o644)',
    test: preparation, title: 'persisted native participant' },
  { name: 'native-file-not-writable', file: readiness,
    before: 'handle.chmod(0o600)', after: 'handle.chmod(0o400)',
    test: preparation, title: 'persisted native participant' },
  { name: 'original-transfer-code-lost', file: privateEvidence,
    before: 'let code = codeToken(row.code)', after: 'let code = codeToken(undefined)',
    test: 'packages/roam/src/__tests__/move-faults.test.ts', title: 'keeps private transfer diagnostics' },
  { name: 'raw-transfer-message-recorded', file: privateEvidence,
    before: '{ stage, phase, code, codeSource,', after: '{ stage, phase, code, codeSource, message,',
    test: 'packages/roam/src/__tests__/move-faults.test.ts', title: 'keeps private transfer diagnostics' },
  { name: 'final-transfer-substeps-not-recorded', file: 'packages/roam/src/move-ports.ts',
    before: 'withPrivateTransferDiagnostic(journal, operation.id, stage, phase, effect);',
    after: 'stage === "pre" ? withPrivateTransferDiagnostic(journal, operation.id, stage, phase, effect) : effect();',
    test: 'packages/roam/src/__tests__/move-ports.test.ts', title: 'records private transfer diagnostics' },
  { name: 'participant-original-code-not-recorded', file: 'packages/roam/src/move-ports.ts',
    before: 'withPrivateTransferDiagnostic(journal, String(operation.args.moveId), stage, phase, effect)', after: 'effect()',
    test: 'packages/roam/src/__tests__/move-ports.test.ts', title: 'records private participant transfer' },
  { name: 'private-reader-mixes-operations', file: 'packages/roam/src/local-diagnostics.ts',
    before: "WHERE operation_id=? AND action='move-transfer-diagnostic'", after: "WHERE (? IS NOT NULL) AND action='move-transfer-diagnostic'",
    test: 'packages/roam/src/__tests__/private-transfer-diagnostics.test.ts', title: 'observes only private diagnostic fields' },
  { name: 'private-reader-returns-extra-fields', file: privateEvidence,
    before: 'return { stage: row.stage, phase, code: row.code, codeSource,', after: 'return { ...row, stage: row.stage, phase, code: row.code, codeSource,',
    test: 'packages/roam/src/__tests__/private-transfer-diagnostics.test.ts', title: 'observes only private diagnostic fields' },
];
let restore;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { restore?.(); process.exit(1); });
const results = [];
for (const mutation of mutations) {
  const original = readFileSync(mutation.file, 'utf8');
  if (original.split(mutation.before).length !== 2) throw new Error(`mutation anchor is not unique: ${mutation.name}`);
  const report = join(directory, `${mutation.name}.json`);
  rmSync(report, { force: true });
  restore = () => writeFileSync(mutation.file, original);
  try {
    writeFileSync(mutation.file, original.replace(mutation.before, mutation.after));
    const run = spawnSync('bash', [runFile, mutation.test, '-t', mutation.title,
      '--reporter=json', `--outputFile=${report}`], { encoding: 'utf8' });
    writeFileSync(join(directory, `${mutation.name}.log`), `${run.stdout ?? ''}${run.stderr ?? ''}`);
    if (run.error) throw run.error;
    const result = JSON.parse(readFileSync(report, 'utf8'));
    const assertions = result.testResults.flatMap(row => row.assertionResults)
      .filter(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError')));
    if (run.status === 0 || !assertions.length) throw new Error(`mutation survived or did not reach an assertion: ${mutation.name}`);
    results.push({ mutation: mutation.name, failed: assertions.length, tests: assertions.map(test => test.title) });
    console.log(`${mutation.name}: caught by ${assertions.length} assertion(s)`);
  } finally { restore(); restore = undefined; }
}
writeFileSync(join(directory, 'results.json'), JSON.stringify(results, null, 2) + '\n');
