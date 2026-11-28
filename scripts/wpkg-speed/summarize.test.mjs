import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const scratch = resolve('.spider/scratch/wpkg-profiler-selftest');
mkdirSync(scratch, { recursive: true });
const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture({ status = 'passed', trace } = {}) {
  const dir = mkdtempSync(join(scratch, 'report-'));
  directories.push(dir);
  const base = 'example.test.ts';
  writeFileSync(join(dir, `${base}.json`), JSON.stringify({ success: status === 'passed', numFailedTests: status === 'passed' ? 0 : 1, testResults: [{ status, startTime: 1000, endTime: 3500 }] }));
  writeFileSync(join(dir, `${base}.time`), 'real 3.00\nuser 2.50\nsys 0.50\n');
  if (trace !== undefined) writeFileSync(join(dir, `${base}.ndjson`), trace);
  return dir;
}
function summarize(dir, ...expected) {
  return spawnSync(process.execPath, ['scripts/wpkg-speed/summarize.mjs', dir, ...expected], { encoding: 'utf8' });
}

test('a passing in-process suite can have no Node-child log', () => {
  const result = summarize(fixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /file 2\.5s.*waited-tree CPU 3\.00s.*0 Node starts/);
});
test('empty and populated child logs are counted', () => {
  const empty = summarize(fixture({ trace: '' }));
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /0 Node starts/);
  const trace = [JSON.stringify({ type: 'start', argv: ['/x/fake-hc.mjs', 'list'] }), JSON.stringify({ type: 'exit' })].join('\n');
  const populated = summarize(fixture({ trace }));
  assert.equal(populated.status, 0, populated.stderr);
  assert.match(populated.stdout, /1 Node starts.*1 observed exits/);
  assert.match(populated.stdout, /fake-hc\.mjs list: 1/);
});
test('labels uninstrumented runs without claiming zero child starts', () => {
  const dir = fixture();
  const result = spawnSync(process.execPath, ['scripts/wpkg-speed/summarize.mjs', '--no-trace', dir, 'example.test.ts'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /waited-tree CPU 3\.00s.*Node starts unmeasured/);
  assert.doesNotMatch(result.stdout, /0 Node starts/);
  const missing = spawnSync(process.execPath, ['scripts/wpkg-speed/summarize.mjs', '--no-trace', dir, 'missing.test.ts'], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
});
test('an empty report directory is not a successful profile', () => {
  const dir = mkdtempSync(join(scratch, 'empty-'));
  directories.push(dir);
  assert.notEqual(summarize(dir).status, 0);
});
test('a failing test file is not a successful profile', () => {
  assert.notEqual(summarize(fixture({ status: 'failed', trace: '' })).status, 0);
});
test('a requested but missing test report is not a successful profile', () => {
  assert.notEqual(summarize(fixture({ trace: '' }), 'example.test.ts', 'missing.test.ts').status, 0);
});
