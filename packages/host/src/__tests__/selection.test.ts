import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

const files = readdirSync('scripts/selection').filter(file => file.endsWith('.test.mjs'))
  .map(file => file.slice(0, -'.test.mjs'.length));

it('runs every Node test file in the selection directory', () => {
  const discovered = readdirSync('scripts/selection').filter(file => file.endsWith('.test.mjs'))
    .map(file => file.slice(0, -'.test.mjs'.length));
  expect([...files].sort()).toEqual(discovered.sort());
});

for (const file of files) {
  it(`checks ${file} behavior with Node's test runner`, () => {
    execFileSync(process.execPath, ['--test', '--test-concurrency=1', `scripts/selection/${file}.test.mjs`], { encoding: 'utf8' });
  });
}
