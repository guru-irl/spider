// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createNamedByTests, git, selectTests, testInventory } from './select.mjs';

const root = process.cwd();
const head = git(root, 'rev-parse', 'HEAD').trim();
const inventory = testInventory(root, head);
const tracked = git(root, 'ls-tree', '-r', '-z', '--name-only', head).split('\0').filter(Boolean);
const pathsByName = new Map();
for (const path of tracked) {
  const name = basename(path);
  if (!pathsByName.has(name)) pathsByName.set(name, []);
  pathsByName.get(name).push(path);
}

// Like the review sweep, count a quoted basename or its use at the end of
// a quoted path. Ambiguous basenames count for all matching tracked paths.
const namesByPath = new Map();
for (const test of inventory) {
  const source = readFileSync(resolve(root, test), 'utf8');
  for (const [, suffix] of source.matchAll(/['"`/]([^'"`/\r\n]+)(?=['"`])/g)) {
    for (const path of pathsByName.get(suffix.split(/[?#]/, 1)[0]) ?? []) {
      if (!namesByPath.has(path)) namesByPath.set(path, new Set());
      namesByPath.get(path).add(test);
    }
  }
}
if (!namesByPath.size) throw new Error('Named-input sweep found no paths to check');

// Assert literal dependencies independently of what the recorder happened to
// see or what the import graph knows. All tests are recorded, with no reads.
const record = { reads: [], unresolved: [], ms: 1, result: 'passed', ranBundle: false, incomplete: false };
const map = { version: 2, commit: head, runId: null, files: [], tests: Object.fromEntries(inventory.map(test => [test, record])) };
const namedBy = createNamedByTests(root, inventory);
const misses = [];
for (const [file, tests] of [...namesByPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const result = await selectTests({ head, inventory, map, changes: [{ file, status: 'M' }], namedBy });
  if (result.mode === 'full' && ![`toolchain changed: ${file}`, `selection infrastructure changed: ${file}`].includes(result.fallback)) {
    misses.push(`${file}: unexpected full fallback (${result.fallback})`);
    continue;
  }
  for (const test of tests) if (!result.selected[test]) misses.push(`${file} -> ${test}`);
}
console.log(`Checked ${namesByPath.size} named paths across ${inventory.length} test files; ${misses.length} misses.`);
if (misses.length) {
  console.error(misses.join('\n'));
  process.exitCode = 1;
}
