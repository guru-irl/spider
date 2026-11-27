// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(process.argv[2]));
const entries = Object.entries(data.records);
assert.equal(entries.length, 2);
for (const [, record] of entries) {
  assert.equal(record.result, 'passed');
  assert.equal(record.workerPids.length, 1);
}
assert.notEqual(entries[0][1].workerPids[0], entries[1][1].workerPids[0]);
console.log(entries.map(([file, value]) => `${file}: fork ${value.workerPids[0]}`).join('\n'));
