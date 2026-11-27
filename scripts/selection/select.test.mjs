// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as selector from './select.mjs';
import * as manifest from './manifest.mjs';

const base = '1'.repeat(40), head = '2'.repeat(40), unrelated = '3'.repeat(40);
const asOf = '2026-11-27T13:00:00Z';
const map = (files = [], tests = {}, extra = {}) => ({
  version: 1, commit: base, runId: '44', createdAt: '2026-11-27T11:00:00Z', files, tests, ...extra,
});
const artifact = selectionMap => ({ map: selectionMap, publishedAt: '2026-11-27T12:00:00Z', expired: false });
const run = (id, sha) => ({ id, head_sha: sha });
const lookup = (runs, artifacts) => selector.lookupMap({
  mergeBase: head, asOf, listRuns: async () => runs,
  isAncestor: (commit, target) => commit === base && target === head,
  load: async id => artifacts[id],
});

test('loads the newest usable ancestor, not a successful sibling run', async () => {
  const chosen = await lookup([run(46, unrelated), run(45, base), run(44, base)], {
    46: artifact(map([], {}, { runId: '46', commit: unrelated })),
    45: artifact(map([], {}, { runId: '45' })), 44: artifact(map()),
  });
  assert.equal(chosen.map.runId, '45');
});

test('reports when there is no published ancestor map', async () => {
  const result = await lookup([run(46, unrelated)], {});
  assert.equal(result.map, null);
  assert.match(result.fallback, /ancestor/);
});

test('ignores expired and missing artifacts, trying older runs before full fallback', async () => {
  const runs = [run(46, base), run(45, base), run(44, base)];
  const artifacts = { 46: { ...artifact(map()), expired: true }, 44: artifact(map()) };
  assert.equal((await lookup(runs, artifacts)).map.runId, '44');
  assert.match((await lookup(runs.slice(0, 2), artifacts)).fallback, /expired/);
});

test('ignores artifacts published after the PR run started and rejects the wrong map identity', async () => {
  const result = await lookup([run(46, base), run(45, base), run(44, base)], {
    46: { ...artifact(map([], {}, { runId: '46' })), publishedAt: '2026-11-27T14:00:00Z' },
    45: artifact(map([], {}, { runId: '45', commit: unrelated })), 44: artifact(map()),
  });
  assert.equal(result.map.runId, '44');
});

test('rejects a malformed source index instead of inferring an empty read set', async () => {
  const result = await lookup([run(44, base)], { 44: artifact(map([], { [a]: row({ reads: [0] }) })) });
  assert.equal(result.map, null);
  assert.match(result.fallback, /invalid/);
});

const a = 'packages/one/src/a.test.ts', b = 'packages/two/src/b.test.ts';
const c = 'packages/two/src/c.test.ts', d = 'packages/one/src/d.test.ts';
const docGuard = 'packages/host/src/__tests__/readme.test.ts';
const guard = 'packages/host/src/__tests__/ci-workflows.test.ts';
const selectorTest = 'packages/host/src/__tests__/selection.test.ts';
const bundleReader = 'packages/host/src/__tests__/build-id.test.ts';
const bundleEntry = 'packages/host/src/extension.ts';
const inventory = [a, b, c, d, guard, docGuard, selectorTest, bundleReader];
const row = (extra = {}) => ({ reads: [], unresolved: [], ms: 10, result: 'passed', ranBundle: false, ...extra });
const changed = (file, status = 'M') => ({ file, status });
const fixture = ({ changes = [], files, records, unmapped, names, ...options } = {}) => selector.selectTests({
  head, inventory, changes,
  map: map(files, { ...Object.fromEntries(inventory.map(file => [file, row()])), ...records }),
  resolveRelated: async seeds => [...new Set(seeds.flatMap(file => unmapped?.[file] ?? []))],
  namedBy: file => names?.[file] ?? [], ...options,
});
const selected = result => Object.keys(result.selected).sort();
const assertSelected = (result, ...files) => assert.deepEqual(selected(result), files.sort());

test('runs the complete inventory on toolchain changes', async () => {
  for (const file of ['package.json', 'packages/one/package.json', 'package-lock.json', 'tsconfig.build.json', 'vitest.config.ts', '.nvmrc', '.node-version', '.tool-versions']) {
    const result = await fixture({ changes: [changed(file)] });
    assertSelected(result, ...inventory);
    assert.equal(result.mode, 'full');
  }
});

test('runs a changed or added test file itself', async () => {
  for (const status of ['A', 'M']) {
    const result = await fixture({ changes: [changed(a, status)] });
    assert.ok(result.selected[a].includes('changed test'));
    assert.equal(result.selected[b], undefined);
  }
});

test('runs every test whose record contains the changed source, including mapped bundle sources', async () => {
  const file = 'packages/one/src/known.ts';
  assertSelected(await fixture({ changes: [changed(file)], files: [file],
    records: { [a]: row({ reads: [0] }), [b]: row({ reads: [0], ranBundle: true }) } }), a, b);
});

test('uses static importers for a source not present in the map', async () => {
  const file = 'packages/one/src/new.ts';
  assertSelected(await fixture({ changes: [changed(file, 'A')], unmapped: { [file]: [b, d] } }), b, d);
});

test('finds transitive type-only importers through the real checkout graph', async t => {
  const root = mkdtempSync(join(tmpdir(), 'selection-types-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const input = 'packages/one/src/type.ts';
  const sources = {
    'vitest.config.mjs': 'export default {};',
    [a]: `import type { Foo } from './helper.js'; export type Bar = Foo;`,
    'packages/one/src/helper.ts': `export type { Foo } from './type.js';`,
    [input]: `export type Foo = string;`,
    [b]: `export const other = 1;`,
  };
  for (const [file, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '--', '.'], { cwd: root });
  const graph = await selector.createGraphResolver(root, [a, b], []);
  try { assert.deepEqual(await graph.resolveRelated([input]), [a]); }
  finally { await graph.close(); }
});

test('runs surviving recorded readers of deleted files but not the deleted test', async () => {
  const old = 'packages/one/src/gone.ts';
  assertSelected(await fixture({ changes: [changed(old, 'D'), changed(a, 'D')], files: [old],
    inventory: inventory.filter(file => file !== a), records: { [b]: row({ reads: [0] }) } }), b);
});

test('runs doc guards and tests naming or reading a README', async () => {
  const file = 'packages/one/README.md';
  assertSelected(await fixture({ changes: [changed(file)], names: { [file]: [b] },
    files: [file], records: { [c]: row({ reads: [0] }) } }), b, c, docGuard);
});

test('runs tests naming, importing, or running a script', async () => {
  const file = 'scripts/check-thing.mjs';
  assertSelected(await fixture({ changes: [changed(file)], names: { [file]: [a] },
    files: [file], records: { [b]: row({ reads: [0] }) }, unmapped: { [file]: [d] } }), a, b, d);
});

test('runs tests using Herdr e2e files through the graph or record', async () => {
  const file = 'packages/herdr/e2e/harness/run.ts';
  assertSelected(await fixture({ changes: [changed(file)], files: [file],
    records: { [a]: row({ reads: [0] }) }, unmapped: { [file]: [b] } }), a, b);
});

test('runs the reserved-machine guard when Herdr e2e test source changes', async () => {
  const reserved = 'packages/herdr/src/__tests__/reserved-machines.test.ts';
  const result = await fixture({ inventory: [...inventory, reserved], records: { [reserved]: row() },
    changes: [changed('packages/herdr/e2e/fixtures/relocate-assertions.test.ts')] });
  assertSelected(result, reserved);
});

test('runs the bundle reader inventory guard when a test adds a literal consumer', async () => {
  const bundleGuard = 'packages/host/src/__tests__/bundle-readers.test.ts';
  const result = await fixture({ inventory: [...inventory, bundleGuard], records: { [bundleGuard]: row() }, changes: [changed(a)] });
  assertSelected(result, a, bundleGuard);
});

test('runs bundle executors and readers for build config', async () => {
  assertSelected(await fixture({ changes: [changed('vite.config.mjs')],
    records: { [b]: row({ ranBundle: true }) } }), b, bundleReader);
});

test('runs the selector and guard tests on a selection policy edit', async () => {
  assertSelected(await fixture({ changes: [changed('scripts/test-resources.json')] }), selectorTest, guard, docGuard);
});

test('runs bundle policy readers when a changed input reaches a bundle entry', async () => {
  const file = 'packages/one/src/bundled.ts';
  assertSelected(await fixture({ changes: [changed(file)], files: [file],
    records: { [a]: row({ reads: [0] }) }, unmapped: { [file]: [bundleEntry] } }), a, bundleReader);
});

test('runs possible unresolved fixture bundle users for non-doc source changes', async () => {
  const records = { [b]: row({ unresolved: ['<tmp>/made-by-test/cli.mjs'] }) };
  const file = 'packages/one/src/fixture-input.ts';
  assertSelected(await fixture({ changes: [changed(file)], records }), b);
  assertSelected(await fixture({ changes: [changed('docs/guide.md')], records }), docGuard);
});

test('always runs failed, skipped and unrecorded test files', async () => {
  const tests = Object.fromEntries(inventory.filter(file => file !== d).map(file => [file, row()]));
  tests[b] = row({ result: 'failed' });
  tests[c] = row({ result: 'skipped' });
  const result = await fixture({ map: map([], tests) });
  assertSelected(result, b, c, d);
  assert.match(result.selected[d][0], /missing/);
});

test('falls back to the whole suite with a reason when lookup has no usable map', async () => {
  const result = await fixture({ map: null, fallback: 'selection-map artifact expired' });
  assertSelected(result, ...inventory);
  assert.match(result.fallback, /expired/);
  assert.equal(result.mapRunId, null);
});

test('packs four groups longest first using the median recording for a new file', async () => {
  const tests = { [a]: row({ ms: 25 }), [b]: row({ ms: 2 }), [c]: row({ ms: 10 }),
    [guard]: row({ ms: 45 }), [docGuard]: row({ ms: 60 }) }; // median = 25
  const options = { inventory: [guard, d, a, c, b], map: map([], tests), changes: [changed('tsconfig.json')] };
  const result = await fixture(options);
  assert.deepEqual(result.groups, [[guard], [a], [d], [c, b]]);
  assert.equal((await fixture({ ...options, inventory: [...options.inventory].reverse() })).selectionHash, result.selectionHash);
});

test('requires successful compile and four numbered runners agreeing with the uploaded manifest', async () => {
  const result = await fixture({ changes: [changed(a)] });
  const needs = { compile: { result: 'success' }, tests: { result: 'success' } };
  const hashes = [1, 2, 3, 4].map(group => ({ group, selectionHash: result.selectionHash }));
  assert.equal(manifest.requireAgreement({ needs, hashes, selection: result, head }), result.selectionHash);
  for (const state of ['skipped', 'failure', 'cancelled']) {
    assert.throws(() => manifest.requireAgreement({ needs: { ...needs, tests: { result: state } }, hashes, selection: result, head }));
  }
  assert.throws(() => manifest.requireAgreement({ needs, hashes: hashes.slice(1), selection: result, head }));
  assert.throws(() => manifest.requireAgreement({ needs, hashes: [hashes[0], ...hashes.slice(0, 3)], selection: result, head }));
  assert.throws(() => manifest.requireAgreement({ needs, hashes: [...hashes.slice(0, 3), { group: 4, selectionHash: 'wrong' }], selection: result, head }));
  assert.throws(() => manifest.requireAgreement({ needs, hashes, selection: { ...result, changedFiles: [] }, head }));
  assert.throws(() => manifest.requireAgreement({ needs, hashes, selection: result, head: base }));
});
