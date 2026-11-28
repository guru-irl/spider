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
  version: 2, commit: base, runId: '44', createdAt: '2026-11-27T11:00:00Z', files, tests, ...extra,
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

test('accepts workflow_run and manual maps only from the target main branch, repository and workflow', async () => {
  const root = process.cwd();
  const commit = selector.git(root, 'rev-parse', 'HEAD').trim();
  const repo = 'guru-irl/spider';
  const runs = [
    { id: 50, event: 'pull_request' },
    { id: 49, event: 'push' },
    { id: 48, head_repository: { full_name: 'fork/spider' } },
    { id: 47, path: '.github/workflows/other.yml' },
    { id: 46, event: 'workflow_dispatch', head_branch: 'try-map' },
    { id: 45 }, // The artifact claims a different commit.
    { id: 44 },
    { id: 43, event: 'workflow_dispatch' },
  ].map(item => ({ path: '.github/workflows/selection-map.yml', event: 'workflow_run', head_sha: commit,
    head_branch: 'main', head_repository: { full_name: repo }, conclusion: 'success',
    updated_at: '2026-11-27T12:00:00Z', ...item }));
  const loaded = [];
  const api = {
    get: () => ({ created_at: asOf }),
    pages: endpoint => {
      const event = new URLSearchParams(endpoint.split('?')[1]).get('event');
      return [{ workflow_runs: runs.filter(run => !event || run.event === event) }];
    },
    artifact: async id => {
      loaded.push(id);
      return artifact(map([], {}, { commit: id === 45 ? unrelated : commit, runId: String(id) }));
    },
  };
  const options = { root, mergeBase: commit, repo, workflowRun: 1, api };
  assert.equal((await selector.lookupMainMap(options)).map.runId, '44');
  assert.deepEqual(loaded, [45, 44]);
  runs.splice(runs.findIndex(run => run.id === 44), 1);
  assert.equal((await selector.lookupMainMap(options)).map.runId, '43');
  assert.deepEqual(loaded, [45, 44, 45, 43]);
});

test('fails loudly on map API or artifact read errors instead of changing selections', async () => {
  const failure = new Error('network unavailable');
  const options = { mergeBase: head, asOf, isAncestor: () => true,
    listRuns: async () => [run(44, base)], load: async () => { throw failure; } };
  await assert.rejects(selector.lookupMap(options), /network unavailable/);
  await assert.rejects(selector.lookupMap({ ...options, listRuns: async () => { throw failure; } }), /network unavailable/);
  await assert.rejects(selector.lookupMap({ ...options, load: async () => ({ ...artifact(map()), read: () => { throw failure; } }) }), /network unavailable/);
  const api = { get: () => { throw failure; } };
  await assert.rejects(selector.lookupMainMap({ root: process.cwd(), mergeBase: head, repo: 'guru-irl/spider', workflowRun: 1, api }), /network unavailable/);
});

test('rejects a malformed source index instead of inferring an empty read set', async () => {
  const result = await lookup([run(44, base)], { 44: artifact(map([], { [a]: row({ reads: [0] }) })) });
  assert.equal(result.map, null);
  assert.match(result.fallback, /invalid/);
});

test('rejects a v1 map and maps without a boolean completeness flag', async () => {
  const { incomplete: _omitted, ...legacyRow } = row();
  for (const candidate of [map([], { [a]: legacyRow }, { version: 1 }),
    map([], { [a]: legacyRow }), map([], { [a]: row({ incomplete: 'false' }) })]) {
    const result = await lookup([run(44, base)], { 44: artifact(candidate) });
    assert.equal(result.map, null);
    assert.match(result.fallback, /invalid/);
    const selection = await fixture(result);
    assert.equal(selection.mode, 'full');
    assertSelected(selection, ...inventory);
  }
});

test('loads v2 maps with unfinished records', async () => {
  const selectionMap = map([], { [a]: row({ incomplete: true }) });
  const result = await lookup([run(44, base)], { 44: artifact(selectionMap) });
  assert.deepEqual(result, { map: selectionMap, fallback: null });
});

const a = 'packages/one/src/a.test.ts', b = 'packages/two/src/b.test.ts';
const c = 'packages/two/src/c.test.ts', d = 'packages/one/src/d.test.ts';
const docGuard = 'packages/host/src/__tests__/readme.test.ts';
const guard = 'packages/host/src/__tests__/ci-workflows.test.ts';
const selectorTest = 'packages/host/src/__tests__/selection.test.ts';
const bundleReader = 'packages/host/src/__tests__/build-id.test.ts';
const bundleEntry = 'packages/host/src/extension.ts';
const inventory = [a, b, c, d, guard, docGuard, selectorTest, bundleReader];
const row = (extra = {}) => ({ reads: [], unresolved: [], ms: 10, result: 'passed', ranBundle: false, incomplete: false, ...extra });
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

test('runs the complete inventory for Vite config and Vitest setup changes', async t => {
  for (const file of ['vite.config.mjs', 'vite.dashboard.config.mjs', 'packages/one/viteExtra.config.ts',
    'vitest.setup.ts', 'vitest.herdr-global-setup.ts', 'packages/herdr/e2e/setup.ts', 'scripts/vitest-sequencer.ts']) {
    await t.test(file, async () => {
      for (const status of ['A', 'M', 'D']) {
        const result = await fixture({ changes: [changed(file, status), changed('packages/one/src/product.ts')] });
        assert.equal(result.mode, 'full');
        assertSelected(result, ...inventory);
      }
    });
  }
});

test('runs the complete inventory when selection infrastructure or workflows change', async () => {
  for (const file of ['scripts/selection/select.mjs', 'scripts/selection/subdir/helper.mjs',
    'scripts/test-resources.json', 'scripts/test-shards.ts', 'scripts/selection/known-flakes.json',
    '.github/workflows/pr.yml', '.github/workflows/ci.yml']) {
    for (const status of ['A', 'M', 'D']) {
      const result = await fixture({ changes: [changed(file, status), changed('packages/one/src/product.ts')] });
      assert.equal(result.mode, 'full', `${status} ${file}`);
      assertSelected(result, ...inventory);
    }
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

test('selects raw, URL and inline readers recorded with Vite suffixes', async () => {
  const machine = 'packages/db-core/src/roam/machine.ts';
  const config = 'packages/roam/src/config.ts';
  const identity = 'packages/roam/src/__tests__/bootstrap-identity.test.ts';
  const payload = 'packages/roam/src/__tests__/provision-payload.test.ts';
  const options = { inventory: [a, identity, payload], files: [machine, `${machine}?raw`, `${config}?url`, `${config}#inline`],
    records: { [a]: row({ reads: [0] }), [identity]: row({ reads: [1] }), [payload]: row({ reads: [2, 3] }) } };
  assertSelected(await fixture({ ...options, changes: [changed(machine)] }), a, identity);
  assertSelected(await fixture({ ...options, changes: [changed(config, 'D')] }), payload);
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
  try {
    assert.deepEqual(await graph.resolveRelated([input]), [a]);
    // Bundle-consumer policy can ask for helper files as static graph targets.
    assert.deepEqual(await graph.resolveRelated([input], ['packages/one/src/helper.ts']), ['packages/one/src/helper.ts']);
  } finally { await graph.close(); }
});

test('unions recorded readers with lazy importers in the real checkout graph', async t => {
  const root = mkdtempSync(join(tmpdir(), 'selection-lazy-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const file = 'packages/one/src/deferred.ts';
  const sources = {
    'vitest.config.mjs': 'export default {};',
    [a]: `export const reader = 1;`,
    [b]: `export const maybeRead = enabled => enabled && import('../../one/src/deferred.js');`,
    [c]: `export const unrelated = 1;`,
    [file]: `export const value = 2;`,
  };
  for (const [path, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '--', '.'], { cwd: root });
  const graph = await selector.createGraphResolver(root, [a, b, c], []);
  try {
    const result = await fixture({ inventory: [a, b, c], changes: [changed(file)], files: [file],
      records: { [a]: row({ reads: [0] }) }, resolveRelated: graph.resolveRelated });
    assert.equal(result.mode, 'scoped');
    assertSelected(result, a, b);
    assert.ok(result.selected[a].includes(`recorded input: ${file}`));
    assert.ok(result.selected[b].includes('static import graph'));
  } finally { await graph.close(); }
});

test('runs surviving recorded readers of deleted files but not the deleted test', async () => {
  const old = 'packages/one/src/gone.ts';
  assertSelected(await fixture({ changes: [changed(old, 'D'), changed(a, 'D')], files: [old],
    inventory: inventory.filter(file => file !== a), records: { [b]: row({ reads: [0] }) } }), b);
});

test('runs tests naming a changed or removed resource even if another test recorded it', async () => {
  const file = 'packages/one/src/sample.json';
  for (const status of ['M', 'D']) {
    const result = await fixture({ changes: [changed(file, status)], files: [file],
      records: { [a]: row({ reads: [0] }) }, names: { [file]: [b] } });
    assert.equal(result.mode, 'scoped');
    assertSelected(result, a, b);
    assert.ok(result.selected[b].includes(`names ${file}`));
  }
});

test('runs doc guards and tests naming or reading a README', async () => {
  const file = 'packages/one/README.md';
  assertSelected(await fixture({ changes: [changed(file)], names: { [file]: [b] },
    files: [file], records: { [c]: row({ reads: [0] }) } }), b, c, docGuard);
});

test('a removed README still selects its guards and tests naming it', async () => {
  const file = 'packages/one/README.md';
  assertSelected(await fixture({ changes: [changed(file, 'D')], names: { [file]: [b] },
    files: [file], records: { [c]: row({ reads: [0] }) } }), b, c, docGuard);
});

test('finds a test naming a README by a path relative to the test', t => {
  const root = mkdtempSync(join(tmpdir(), 'selection-name-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(dirname(join(root, a)), { recursive: true });
  writeFileSync(join(root, a), `export const page = new URL('../README.md', import.meta.url);`);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '--', a], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'], { cwd: root });
  const tempHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const namedBy = selector.createNamedByTests(root, selector.testInventory(root, tempHead));
  assert.deepEqual(namedBy('packages/one/README.md'), [a]);
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
  assertSelected(await fixture({ changes: [changed('scripts/build-herdr.mjs')],
    records: { [b]: row({ ranBundle: true }) } }), b, bundleReader);
});

test('runs the selector and guard tests on a selection policy edit', async () => {
  const result = await fixture({ changes: [changed('scripts/test-resources.json')] });
  for (const file of [selectorTest, guard, docGuard]) assert.ok(result.selected[file]);
  assertSelected(result, ...inventory);
});

test('runs bundle policy readers when a changed input reaches a bundle entry', async () => {
  const file = 'packages/one/src/bundled.ts';
  assertSelected(await fixture({ changes: [changed(file)], files: [file],
    records: { [a]: row({ reads: [0] }) }, unmapped: { [file]: [bundleEntry] } }), a, bundleReader);
});

test('selects the compatibility guards and bundle executors for a Roam build manifest edit', async () => {
  const result = await fixture({ changes: [changed('scripts/roam-entries.json')],
    records: { [b]: row({ ranBundle: true }) } });
  assertSelected(result, b, bundleReader, selectorTest, guard, docGuard);
});

test('selects bundle readers when the relay-soak entry is affected', async () => {
  const soak = 'packages/roam/src/relocate/relay-soak.ts';
  const result = await fixture({ changes: [changed(soak)], unmapped: { [soak]: [soak] } });
  assert.equal(result.mode, 'scoped');
  assertSelected(result, bundleReader);
});

test('runs possible unresolved fixture bundle users for non-doc source changes', async () => {
  const records = { [b]: row({ unresolved: ['<tmp>/made-by-test/cli.mjs'] }) };
  const file = 'packages/one/src/fixture-input.ts';
  assertSelected(await fixture({ changes: [changed(file)], records }), b);
  assertSelected(await fixture({ changes: [changed('docs/guide.md')], records }), docGuard);
});

const paneWriter = 'packages/herdr/src/__tests__/endpoint-fixture.ts';
const paneDigest = '8926a2faecbd602f6fec0248b87f80e8fea3dde43555c852f2a34ef475148463';
const paneStub = `<tmp>/h/1/package/dist/herdr/pane-endpoint-${paneDigest}.mjs`;
const wiringBuilder = 'packages/host/src/__tests__/herdr-wiring-fixture.ts';
const wiringBlob = 'b209b9382a714bca041da4a50e348a926776e4d6';
const viewerEntry = 'packages/herdr/src/bin/viewer.ts';
const fixtureInput = 'packages/one/src/runtime-input.ts';
const unrelatedInput = 'packages/one/src/unrelated.ts';
const wiringRecord = path => row({ reads: [0], unresolved: [path], ranBundle: true });

function wiringFixture({ path = '<tmp>/h/w0/dist/herdr/assets/ports-C3IoFaj8.js',
  blob = wiringBlob, changes = [changed(unrelatedInput)], ...options } = {}) {
  return fixture({ changes, files: [wiringBuilder], records: { [b]: wiringRecord(path) },
    fixtureBlobs: () => new Map([[wiringBuilder, blob]]),
    resolveRelated: async (seeds, targets) => seeds.includes(fixtureInput) && targets?.includes(viewerEntry) ? [viewerEntry] : [],
    ...options });
}

test('a recorded standalone pane fixture needs its writer, not unrelated source', async () => {
  const options = { files: [paneWriter], records: { [b]: row({ reads: [0], unresolved: [paneStub], ranBundle: true }) } };
  assertSelected(await fixture({ ...options, changes: [changed(unrelatedInput)] }));
  assertSelected(await fixture({ ...options, changes: [changed(paneWriter, 'D')] }), b);
  assertSelected(await fixture({ ...options, changes: [changed('scripts/build-herdr.mjs')] }), b, bundleReader);
});

test('a verified fixture chunk selects its transitive inputs instead of unrelated packages', async () => {
  assertSelected(await wiringFixture());
  assertSelected(await wiringFixture({ changes: [changed(fixtureInput)] }), b);
});

test('a changed builder, ambiguous path, or another unresolved chunk keeps the fixture conservative', async () => {
  assertSelected(await wiringFixture({ blob: 'f'.repeat(40) }), b);
  assertSelected(await wiringFixture({ path: '<tmp>/another-tool/dist/ports-C3IoFaj8.js' }), b);
  assertSelected(await wiringFixture({ records: { [b]: row({ reads: [0], ranBundle: true,
    unresolved: [paneStub, '<tmp>/h/w0/dist/herdr/assets/ports-C3IoFaj8.js', '<tmp>/mystery.js'] }) } }), b);
  assertSelected(await fixture({ changes: [changed(unrelatedInput)], records: { [b]: row({ unresolved: [paneStub] }) } }), b);
});

test('a fixture with a verified build graph still runs on deletes and non-code inputs', async () => {
  assertSelected(await wiringFixture({ changes: [changed(fixtureInput, 'D')] }), b);
  assertSelected(await wiringFixture({ changes: [changed('packages/one/src/options.json')] }), b);
});

test('matches cutover CLI inputs from the generated entry, even in a basename-only record', async () => {
  const builder = 'packages/herdr/src/__tests__/production-cutover-fixture.ts';
  const ports = 'packages/host/src/herdr/ports.ts';
  const options = { files: [builder], records: { [b]: wiringRecord('<tmp>/cli.mjs') },
    fixtureBlobs: () => new Map([[builder, '22410c6e6d8cd2ad45964b01b2fa39c938f277b3']]) };
  assertSelected(await fixture({ ...options, changes: [changed(unrelatedInput)] }));
  assertSelected(await fixture({ ...options, changes: [changed(ports)] }), b);
});

test('the standalone bridge fixture does not scope other files called extension.js', async () => {
  const builder = 'packages/host/src/__tests__/copy-button-entry.test.ts';
  const options = { changes: [changed(unrelatedInput)], files: [builder],
    fixtureBlobs: () => new Map([[builder, '76292c563bb1a50fd9a1733d2a6bc2a11f497b71']]) };
  assertSelected(await fixture({ ...options, records: { [b]: wiringRecord('<tmp>/tests/case-1/dist/extension.js') } }));
  assertSelected(await fixture({ ...options, records: { [b]: wiringRecord('<tmp>/tests/release/dist/extension.js') } }), b);
});

test('a broken fixture graph cannot omit the tests that ran it', async () => {
  const result = await wiringFixture({ async resolveRelated(_seeds, targets) {
    if (targets?.includes(viewerEntry)) throw new Error('test fixture graph error');
    return [];
  } });
  assert.equal(result.mode, 'full');
  assertSelected(result, ...inventory);
});

test('always runs failed, skipped and unrecorded test files', async () => {
  const tests = Object.fromEntries(inventory.filter(file => file !== d).map(file => [file, row()]));
  tests[b] = row({ result: 'failed' });
  tests[c] = row({ result: 'skipped' });
  const result = await fixture({ map: map([], tests) });
  assertSelected(result, b, c, d);
  assert.match(result.selected[d][0], /missing/);
});

test('always runs a test with an incomplete record even if it passed', async () => {
  const result = await fixture({ records: { [b]: row({ incomplete: true }) } });
  assert.equal(result.mode, 'scoped');
  assertSelected(result, b);
  assert.ok(result.selected[b].includes('incomplete recording'));
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
    assert.throws(() => manifest.requireAgreement({ needs: { ...needs, compile: { result: state } }, hashes, selection: result, head }));
  }
  assert.throws(() => manifest.requireAgreement({ needs, hashes: hashes.slice(1), selection: result, head }));
  assert.throws(() => manifest.requireAgreement({ needs, hashes: [hashes[0], ...hashes.slice(0, 3)], selection: result, head }));
  assert.throws(() => manifest.requireAgreement({ needs, hashes: [...hashes.slice(0, 3), { group: 4, selectionHash: 'wrong' }], selection: result, head }));
  assert.throws(() => manifest.requireAgreement({ needs, hashes, selection: { ...result, changedFiles: [] }, head }));
  assert.throws(() => manifest.requireAgreement({ needs, hashes, selection: result, head: base }));
});

test('reports the runner map and fallback when selections disagree', async () => {
  const result = await fixture({ changes: [changed(a)] });
  const needs = { compile: { result: 'success' }, tests: { result: 'success' } };
  const hashes = [1, 2, 3, 4].map(group => ({ group, selectionHash: result.selectionHash, mapRunId: '44', fallback: null }));
  hashes[2] = { group: 3, selectionHash: 'a'.repeat(64), mapRunId: null, fallback: 'selection-map lookup failed' };
  assert.throws(() => manifest.requireAgreement({ needs, hashes, selection: result, head }),
    /group 3.*selection-map lookup failed/);
});

test('rejects unsafe changed paths before they enter the audit summary', async () => {
  const result = await fixture({ changes: [changed(a)] });
  for (const change of [{ file: 'docs/`injected`', status: 'M' }, { file: a, status: 'X' }]) {
    const unsafe = { ...result, changedFiles: [change] };
    unsafe.selectionHash = manifest.selectionHash(unsafe);
    assert.throws(() => manifest.validateSelection(unsafe, head), /changed files/i);
  }
});
