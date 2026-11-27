import { execFileSync } from 'node:child_process';
import { it } from 'vitest';

for (const file of ['select', 'audit', 'map', 'recorder']) {
  it(`checks ${file} behavior with Node's test runner`, () => {
    execFileSync(process.execPath, ['--test', '--test-concurrency=1', `scripts/selection/${file}.test.mjs`], { encoding: 'utf8' });
  });
}
