// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { selectionHash } from './manifest.mjs';

const runner = process.env.SELECTION_RUN_SCRIPT ?? fileURLToPath(new URL('./run.mjs', import.meta.url));
const aggregate = process.env.SELECTION_AGGREGATE_SCRIPT ?? fileURLToPath(new URL('./aggregate.mjs', import.meta.url));
const testFile = 'packages/one/src/example.test.ts';
const needs = { compile: { result: 'success' }, tests: { result: 'success' } };

function setup(t, body) {
  const root = mkdtempSync(join(tmpdir(), 'selection-run-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(resolve('node_modules/vitest'), join(root, 'node_modules/vitest'), 'dir');
  writeFileSync(join(root, 'node_modules/.bin/selection-shim'), '#!/bin/sh\nprintf shim\n');
  chmodSync(join(root, 'node_modules/.bin/selection-shim'), 0o755);
  mkdirSync(dirname(join(root, testFile)), { recursive: true });
  writeFileSync(join(root, testFile), body);
  writeFileSync(join(root, 'vitest.config.mjs'), 'export default {};\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '--', testFile], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'], { cwd: root });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, head };
}

function manifest(head, files) {
  const selection = { version: 1, head, mode: 'scoped', fallback: null, mapRunId: '44', mapCommit: 'a'.repeat(40),
    changedFiles: [], selected: Object.fromEntries(files.map(file => [file, ['fixture']])), groups: [files, [], [], []] };
  return { ...selection, selectionHash: selectionHash(selection) };
}

function invoke(root, selection, group = 1) {
  writeFileSync(join(root, 'selection.json'), JSON.stringify(selection));
  const env = { ...process.env, TEST: 'false', VITEST: 'false' };
  delete env.NODE_ENV;
  return spawnSync(process.execPath, [runner, 'selection.json', String(group), 'report.json', 'hash.json'],
    { cwd: root, env, encoding: 'utf8' });
}

const passing = `import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
it('has the CI execution environment', () => {
  expect(process.env.TEST).toBe('true');
  expect(process.env.VITEST).toBe('true');
  expect(process.env.NODE_ENV).toBe('test');
  expect(execFileSync('selection-shim', { encoding: 'utf8' })).toBe('shim');
});`;

test('runs the assigned group with the test environment and installed-command PATH', t => {
  const { root, head } = setup(t, passing);
  const selection = manifest(head, [testFile]);
  const result = invoke(root, selection);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'hash.json'), 'utf8')),
    { group: 1, selectionHash: selection.selectionHash, mapRunId: '44', fallback: null });
  assert.ok(existsSync(join(root, 'report.json')));
});

test('passes test variables to Vitest before initialization', t => {
  const { root, head } = setup(t, passing);
  const harness = join(root, 'harness');
  const pkg = join(harness, 'node_modules/vitest');
  mkdirSync(pkg, { recursive: true });
  copyFileSync(runner, join(harness, 'run.mjs'));
  copyFileSync(fileURLToPath(new URL('./manifest.mjs', import.meta.url)), join(harness, 'manifest.mjs'));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: { './node': './node.mjs' } }));
  writeFileSync(join(pkg, 'node.mjs'), `import { writeFileSync } from 'node:fs';
export async function createVitest() {
  writeFileSync('vitest-env.json', JSON.stringify({ TEST: process.env.TEST, VITEST: process.env.VITEST, NODE_ENV: process.env.NODE_ENV }));
  return { start: async () => ({ testModules: [{ moduleId: process.cwd() + '/${testFile}', ok: () => true }], unhandledErrors: [] }), close: async () => {} };
}`);
  writeFileSync(join(root, 'selection.json'), JSON.stringify(manifest(head, [testFile])));
  const env = { ...process.env, TEST: 'false', VITEST: 'false' }; delete env.NODE_ENV;
  const result = spawnSync(process.execPath, [join(harness, 'run.mjs'), 'selection.json', '1', 'report.json', 'hash.json'],
    { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'vitest-env.json'), 'utf8')),
    { TEST: 'true', VITEST: 'true', NODE_ENV: 'test' });
});

test('does not attest a failed test or a group Vitest did not report', t => {
  const { root, head } = setup(t, `import { it, expect } from 'vitest'; it('fails', () => expect(1).toBe(2));`);
  const failed = invoke(root, manifest(head, [testFile]));
  assert.notEqual(failed.status, 0);
  assert.equal(existsSync(join(root, 'hash.json')), false);
  const missing = invoke(root, manifest(head, [testFile, 'packages/one/src/missing.test.ts']));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /did not report exactly the assigned group/);
  assert.equal(existsSync(join(root, 'hash.json')), false);
});

test('attests an empty group without running Vitest', t => {
  const { root, head } = setup(t, passing);
  const selection = manifest(head, [testFile]);
  const result = invoke(root, selection, 2);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Group 2\/4 is empty/);
  assert.equal(JSON.parse(readFileSync(join(root, 'hash.json'), 'utf8')).group, 2);
  assert.equal(existsSync(join(root, 'report.json')), false);
});

test('aggregate rejects missing attestations and failed compile jobs', t => {
  const { root, head } = setup(t, passing);
  const selection = manifest(head, [testFile]);
  writeFileSync(join(root, 'test-selection.json'), JSON.stringify(selection));
  for (const group of [1, 2, 4]) writeFileSync(join(root, `hash-${group}.json`), JSON.stringify({ group, selectionHash: selection.selectionHash }));
  const run = value => spawnSync(process.execPath, [aggregate, root, head], { encoding: 'utf8', env: { ...process.env, NEEDS_JSON: JSON.stringify(value) } });
  const missing = run(needs);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /hash-3\.json/);
  writeFileSync(join(root, 'hash-3.json'), JSON.stringify({ group: 3, selectionHash: selection.selectionHash }));
  assert.equal(run(needs).status, 0);
  for (const state of ['failure', 'cancelled', 'skipped']) {
    const result = run({ ...needs, compile: { result: state } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Compile and every test runner must succeed/);
  }
});
