import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const scratch = resolve('.spider/scratch/wpkg-profiler-selftest');
mkdirSync(scratch, { recursive: true });
const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const files = ['packages/herdr/src/__tests__/one.test.ts', 'packages/herdr/src/__tests__/two.test.ts'];
function fixture({ missing = false, duplicate = false, fail = false, duration = 44_999 } = {}) {
  const dir = mkdtempSync(join(scratch, 'loaded-'));
  directories.push(dir);
  const row = (name, milliseconds) => ({ name: resolve(name), status: fail ? 'failed' : 'passed', startTime: 1000, endTime: 1000 + milliseconds, assertionResults: [{ status: 'passed' }] });
  const results = [row(files[0], duration), ...(missing ? [] : [row(duplicate ? files[0] : files[1], 500)])];
  const report = join(dir, 'report.json'), list = join(dir, 'files.txt');
  writeFileSync(report, JSON.stringify({ success: !fail, numFailedTests: fail ? 1 : 0, testResults: results }));
  writeFileSync(list, files.join('\n') + '\n');
  return [report, list];
}
function summarize(args) {
  return spawnSync(process.execPath, ['scripts/wpkg-speed/summarize-loaded.mjs', ...args], { encoding: 'utf8' });
}

test('accepts complete passing reports below the file limit', () => {
  const result = summarize(fixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /one\.test\.ts.*44\.999s/);
});
test('rejects a file that takes 45 seconds or longer', () => {
  const result = summarize(fixture({ duration: 45_000 }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /45-second file limit/);
});
test('report-only mode records slow files but still rejects incomplete reports', () => {
  const slow = summarize([...fixture({ duration: 45_000 }), '--report-only']);
  assert.equal(slow.status, 0, slow.stderr);
  assert.match(slow.stdout, /one\.test\.ts.*45\.000s/);
  const missing = summarize([...fixture({ missing: true }), '--report-only']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing requested file/);
  const failed = summarize([...fixture({ fail: true }), '--report-only']);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Failing test report/);
});
test('rejects missing and duplicate files', () => {
  const missing = summarize(fixture({ missing: true }));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing requested file/);
  const duplicate = summarize(fixture({ duplicate: true }));
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Duplicate test file/);
});
test('rejects failing test reports', () => {
  const result = summarize(fixture({ fail: true }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Failing test report/);
});
