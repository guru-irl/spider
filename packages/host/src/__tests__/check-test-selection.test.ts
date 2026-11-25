import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('rejects a fallback masquerading as a successful scoped probe and reports omitted consumers', async () => {
  const file = resolve('scripts/check-test-selection.mjs');
  expect(existsSync(file), 'the CI graph probe script must exist').toBe(true);
  const { checkProbe } = await import(/* @vite-ignore */ file);
  const probe = { name: 'resource', mode: 'scoped', expected: ['packages/herdr/src/example.test.ts'] };
  const manifest = { mode: 'scoped', testedSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), files: ['packages/herdr/src/example.test.ts'], selectionMs: 42, optional: { chrome: false } };
  expect(checkProbe(probe, manifest)).toMatchObject({ name: 'resource', files: 1, selectionMs: 42 });
  expect(() => checkProbe(probe, { ...manifest, mode: 'full', fallback: 'graph error' })).toThrow(/fallback|scoped/);
  expect(() => checkProbe(probe, { ...manifest, files: [] })).toThrow(/consumer/);
  expect(() => checkProbe({ ...probe, mode: 'full' }, manifest)).toThrow(/full/);
});

it('rejects skipped, failed or extra files in exact-manifest execution evidence', async () => {
  const { checkExecution } = await import(/* @vite-ignore */ resolve('scripts/check-test-selection.mjs'));
  const root = resolve('selection-fixture'), file = 'packages/a/src/value.test.ts';
  const report = { success: true, numPassedTests: 1, numFailedTests: 0,
    testResults: [{ name: resolve(root, file), status: 'passed' }] };
  expect(() => checkExecution(report, root, file)).not.toThrow();
  expect(() => checkExecution({ ...report, success: false }, root, file)).toThrow();
  expect(() => checkExecution({ ...report, numPassedTests: 0 }, root, file)).toThrow();
  expect(() => checkExecution({ ...report, testResults: [] }, root, file)).toThrow();
  expect(() => checkExecution({ ...report, testResults: [...report.testResults, { name: resolve(root, 'packages/b/src/unselected.test.ts'), status: 'passed' }] }, root, file)).toThrow();
});
