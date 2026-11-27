// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupCount, requireAgreement } from './manifest.mjs';

const [directory, head] = process.argv.slice(2);
const needs = JSON.parse(process.env.NEEDS_JSON);
if (needs.compile?.result !== 'success' || needs.tests?.result !== 'success') {
  throw new Error('Compile and every test runner must succeed');
}
const read = name => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const hashes = Array.from({ length: groupCount }, (_, index) => read(`hash-${index + 1}.json`));
const selection = read('test-selection.json');
console.log(`All ${groupCount} runners completed selection ${requireAgreement({ needs, hashes, selection, head })}`);
