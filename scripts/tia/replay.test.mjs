// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
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
