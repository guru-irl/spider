// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('prints the top 30 by observed CPU and suite totals without claiming missing CPU', t => {
  const scratch = resolve('.spider/scratch/selection');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'scoreboard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tests = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`test-${String(i).padStart(2, '0')}.ts`, {
    processes: i === 30 ? 50 : 1, cpuMs: i === 30 ? null : i * 100,
    knownCpuMs: i * 100, unknownCpu: i === 30 ? 1 : 0, ms: i === 30 ? 89001 : 89000,
  }]));
  const file = join(dir, 'map.json');
  writeFileSync(file, JSON.stringify({ tests }));
  const run = spawnSync(process.execPath, ['scripts/selection/scoreboard.mjs', file], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\| test-30\.ts \| 50 \| ≥3,000 \| 89,001 \| ≥60\.0 \|/);
  assert.ok(run.stdout.indexOf('test-30.ts') < run.stdout.indexOf('test-29.ts'));
  assert.doesNotMatch(run.stdout, /\| test-00\.ts \|/);
  assert.match(run.stdout, /Processes: 80/);
  assert.match(run.stdout, /CPU: ≥46,500 ms/);
  assert.match(run.stdout, /1 file.*50 or more.*6\.5%/);
  assert.match(run.stdout, /1 file.*over 89,000 ms/);
  assert.match(run.stdout, /1 process.*unknown CPU/);
});
