// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const implementation = () => import('./replay.mjs');

test('add loaded-only tests only to the upper bound and retain non-runtime readers in both', async () => {
  const { selectForReplay } = await implementation();
  const tests = ['exercised', 'loaded', 'reader', 'unrelated', 'asset'].map(name => `packages/example/src/${name}.test.ts`);
  const [exercised, loaded, reader, unrelated, asset] = tests;
  const added = 'packages/example/src/added.test.ts';
  const source = 'packages/example/src/runtime.ts';
  const inputs = [source, 'packages/example/sample.json', added];
  const records = {
    [exercised]: { executed: [source], loaded: [source] },
    [loaded]: { executed: [], loaded: [source] },
    [unrelated]: { executed: ['packages/example/src/other.ts'], loaded: [] },
    [asset]: { executed: ['packages/example/src/asset-reader.ts'], loaded: [] },
  };
  const rules = [{ inputs: ['packages/*/*.json'], tests: ['packages/$package/src/reader.test.ts'], related: ['packages/example/src/asset-reader.ts'] }];
  const result = selectForReplay({ inventory: tests, records, rules, manifest: { changedPaths: inputs, files: [added], deferred: [] } });
  assert.deepEqual(result.lower, [added, asset, exercised, reader]);
  assert.deepEqual(result.upper, [added, asset, exercised, loaded, reader]);
});

test('honor toolchain and historical full fallbacks without coverage data', async () => {
  const { selectForReplay } = await implementation();
  const archived = 'packages/example/src/historical.test.ts';
  const current = 'packages/example/src/current.test.ts';
  const manifest = { changedPaths: ['package.json'], files: [], deferred: [{ file: archived }], budget: { candidateMode: 'full' } };
  const rules = [{ id: 'toolchain', full: true, inputs: ['package.json'], tests: [], related: [] }];
  const result = selectForReplay({ inventory: [current], records: {}, rules, manifest });
  assert.equal(result.full, 'toolchain');
  // Archived full inventories must not pull in tests added after that head.
  assert.deepEqual(result.lower, [archived]);
  assert.deepEqual(result.upper, [archived]);
  assert.equal(selectForReplay({ inventory: [current], records: {}, rules, manifest: { ...manifest, changedPaths: ['unknown.md'], fallback: 'old safety fallback' } }).full, 'old safety fallback');
});

test('pack longest first into 12 slots and apply the slowdown before testing the wall budget', async () => {
  const { estimate } = await implementation();
  const files = Array.from({ length: 14 }, (_, i) => `f${i}`);
  const timings = Object.fromEntries(files.slice(0, 13).map((file, i) => [file, i === 0 ? 91_000 : 25_000]));
  const result = estimate(files, timings, 25_000);
  assert.equal(result.totalMs, 416_000);
  assert.equal(result.wallMs, 182_850);
  assert.equal(result.fits, false);
  assert.deepEqual(result.over90s, [{ file: 'f0', durationMs: 91_000 }]);
  assert.deepEqual(result.estimated, ['f13']);
  const exact = estimate(['f1'], { f1: 88_888 }, 25_000);
  assert.equal(exact.fits, true);
  // This overrun rounds to 180 seconds in a summary, but it doesn't fit.
  assert.equal(estimate(['f1'], { f1: 88_889 }, 25_000).fits, false);
});

test('precise replay routes each fallback to its evidenced consumers', async () => {
  const { selectForReplay } = await implementation();
  const path = name => `packages/example/src/${name}.test.ts`;
  const files = ['doc', 'doc-reader', 'script-reader', 'script-execution', 'e2e-import', 'e2e-execution',
    'e2e-load-only', 'deleted-load', 'bundle', 'inventory', 'changed', 'unrelated'].map(path);
  const rules = [
    { id: 'toolchain', full: true, inputs: ['**/vite*.config.*', 'package.json'] },
    { id: 'test-policy', full: true, inputs: ['scripts/test-resources.json'] },
    { id: 'documentation', inputs: ['docs/**'], tests: [path('doc')], related: [] },
    { id: 'test-inventory', inputs: ['packages/*/src/**/*.test.ts'], tests: [path('inventory')], related: [] },
  ];
  const e2e = 'packages/herdr/e2e/fixtures/example.ts';
  const deleted = 'packages/example/src/deleted.ts';
  const script = 'scripts/run-example.mjs';
  const doc = 'packages/herdr/e2e/README.md';
  const record = (executed, loaded = executed, bundleLoaded = []) => ({ executed, loaded, bundleLoaded });
  const records = {
    [path('script-execution')]: record([script]),
    [path('e2e-execution')]: record([e2e]),
    [path('e2e-load-only')]: record([], [e2e, script]),
    [path('deleted-load')]: record([], [deleted]),
    [path('bundle')]: record([], [], ['packages/example/src/built.ts']),
  };
  const select = (...changedPaths) => selectForReplay({ mode: 'precise', inventory: files, records, rules,
    manifest: { changedPaths, files, deferred: [], mode: 'full', fallback: 'archived fallback' },
    deletedPaths: [deleted],
    textReaders: ((...paths) => paths.flatMap(file => file === doc ? [path('doc-reader')]
      : file === script ? [path('script-reader')] : [])),
    staticImporters: ((...paths) => paths.includes(e2e) ? [path('e2e-import')] : []),
  });
  for (const [changes, names] of [
    [[doc], ['doc', 'doc-reader']],
    [[script, 'scripts/no-reader.mjs'], ['script-reader', 'script-execution']],
    [[e2e], ['e2e-import', 'e2e-execution']],
    [[deleted], ['deleted-load']],
    [['vite.dashboard.config.mjs', 'scripts/build-example.mjs'], ['bundle']],
    [['scripts/test-resources.json', path('changed')], ['inventory', 'changed']],
    [['scripts/no-reader.mjs'], []],
  ]) {
    const result = select(...changes);
    assert.equal(result.full, null, changes.join(', '));
    assert.deepEqual(result.lower, names.map(path).sort(), changes.join(', '));
    assert.deepEqual(result.upper, result.lower);
  }
  const full = select('package.json', doc);
  assert.deepEqual(full.lower, files.slice().sort());
  assert.deepEqual(full.upper, full.lower);
  assert.deepEqual(full.toolchainPaths, ['package.json']);
});

test('use the tested Git tree for names, imports, and deleted paths', async t => {
  const { historicalInputs } = await implementation();
  const root = mkdtempSync(join(tmpdir(), 'tia-inputs-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=TIA test', '-c', 'user.email=tia@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
  const put = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const helper = 'packages/herdr/e2e/fixtures/task.ts';
  const retired = 'packages/example/src/retired.ts';
  const docs = 'docs/unique-note.md';
  const tests = 'packages/herdr/src';
  git('init', '-q', '-b', 'fixture');
  put(helper, 'export const task = 1;');
  put(retired, 'export const retired = true;');
  put(docs, '# Note');
  put(`${tests}/bridge.ts`, "export { task } from '../e2e/fixtures/task.js';");
  put(`${tests}/reader.test.ts`, "import { task } from './bridge.js';\nconst docs = 'unique-note.md';");
  put(`${tests}/decoy.test.ts`, "const text = '../e2e/fixtures/task.js';");
  git('add', '.');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  put(helper, 'export const task = 2;');
  put(docs, '# Revised note');
  git('rm', '-q', retired);
  git('add', '.');
  git('commit', '-qm', 'tested');
  const testedSha = git('rev-parse', 'HEAD');
  put(`${tests}/reader.test.ts`, 'uncommitted source should not count');
  const inputs = historicalInputs(root, { baseSha, testedSha, changedPaths: [docs, retired, helper].sort() });
  assert.deepEqual(inputs.deletedPaths, [retired]);
  assert.deepEqual(inputs.textReaders(docs), [`${tests}/reader.test.ts`]);
  assert.deepEqual(inputs.staticImporters(helper), [`${tests}/reader.test.ts`]);
  assert.throws(() => historicalInputs(root, { baseSha, testedSha, changedPaths: [helper] }), /changed paths differ/);
});

test('identify overruns caused only by files over the single-file limit', async () => {
  const { estimate } = await implementation();
  const long = { long: 88_889 };
  const short = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`short${i}`, 50_000]));
  const first = estimate(['long', 'short0'], { ...long, ...short }, 1);
  assert.equal(first.longFilesOnly, true);
  assert.deepEqual(first.overSingleFileLimit, [{ file: 'long', durationMs: 88_889 }]);
  const many = estimate(['long', ...Object.keys(short)], { ...long, ...short }, 1);
  assert.equal(many.longFilesOnly, false);
  assert.equal(estimate(['short0'], short, 1).longFilesOnly, false);
});
