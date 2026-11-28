// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { medianDuration, partitionFiles, sortByDuration } from './test-shards.ts';

// CI run 45615685564 reported 127 s / 206 files and 143.5 s / 210 files
// of summed worker import time. Round the larger per-file cost up to 700 ms.
export const PR_IMPORT_MS = 700;

export function testBudget(files, durations, machines = 2, workerCount = 3, importMs = 0) {
  if (!Number.isFinite(importMs) || importMs < 0) throw new Error('import allowance must be finite and nonnegative');
  if (!Number.isInteger(workerCount) || workerCount < 1) throw new Error('workers must be a positive integer');
  const fallback = medianDuration(durations);
  const shards = partitionFiles(files, durations, machines).map((files, index) => {
    const workers = Array(workerCount).fill(0);
    for (const file of sortByDuration(files, durations)) {
      const worker = workers.indexOf(Math.min(...workers));
      workers[worker] += (durations[file] ?? fallback) + importMs;
    }
    return { shard: index + 1, predictedMs: Math.max(...workers), workersMs: workers, files };
  });
  return { fileCount: files.length, aggregateMs: files.reduce((sum, file) => sum + (durations[file] ?? fallback), 0), predictedMaxMs: Math.max(...shards.map(shard => shard.predictedMs)), shards };
}

// A higher-priority file is never displaced by a lower-priority one. Oversized
// files wait for the full run, but smaller later files can use the space left.
export function cutToBudget({ files, durations, priorities = {}, machines = 2, workerCount = 3, limitMs = 75_000, importMs = 0 }) {
  if (!Number.isFinite(limitMs) || limitMs <= 0) throw new Error('test budget must be positive and finite');
  const ordered = [...new Set(files)].sort((a, b) => (priorities[a] ?? 2) - (priorities[b] ?? 2) || (a < b ? -1 : a > b ? 1 : 0));
  const selected = [], deferred = [];
  const fallback = medianDuration(durations);
  for (const file of ordered) {
    if (testBudget([...selected, file], durations, machines, workerCount, importMs).predictedMaxMs <= limitMs) selected.push(file);
    else deferred.push({ file, durationMs: durations[file] ?? fallback, rule: 'exceeds the PR test budget; covered by the full run before merge' });
  }
  selected.sort();
  deferred.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return { files: selected, deferred, budget: { limitMs, machines, workerCount, importMs, ...testBudget(selected, durations, machines, workerCount, importMs) } };
}

export function selectionSummary(manifest) {
  const lines = ['## PR test selection', '', `${manifest.files.length} files selected; ${manifest.deferred.length} files deferred to the mandatory full run before merge.`];
  if (manifest.budget) lines.push(`Test-time estimate: ${manifest.budget.predictedMaxMs} ms per runner, limit ${manifest.budget.limitMs} ms, including ${manifest.budget.importMs} ms of import allowance per file. Installation and selection are additional.`);
  if (manifest.fallback) lines.push(`Candidate selection used the full inventory: ${manifest.fallback}`);
  if (manifest.optional.chrome) lines.push('The full run covers the Chrome tests.');
  if (manifest.optional.acceptance) lines.push('The full run covers the Herdr confidence utilities and packed acceptance.');
  if (manifest.optional.stories) lines.push('The full run covers the default headless story set.');
  lines.push('', '### Deferred files', '');
  for (const entry of manifest.deferred) lines.push(`- \`${entry.file}\` (${entry.durationMs} ms): ${entry.rule}`);
  if (!manifest.deferred.length) lines.push('None.');
  return lines.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const { testInventory, validateManifest } = await import('./select-tests.mjs');
  const durations = JSON.parse(readFileSync(new URL('./test-durations.json', import.meta.url), 'utf8'));
  const manifest = option('--manifest');
  const selection = manifest ? JSON.parse(readFileSync(manifest, 'utf8')) : undefined;
  const files = selection ? validateManifest(selection) : testInventory(process.cwd());
  const machines = Number(option('--machines', 2));
  const workerCount = Number(option('--workers', 3));
  const importMs = Number(option('--import-ms', selection?.budget?.importMs ?? 0));
  const result = testBudget(files, durations, machines, workerCount, importMs);
  result.importMs = importMs;
  result.unmeasuredFiles = files.filter(file => durations[file] === undefined).length;
  result.slowFiles = files.filter(file => (durations[file] ?? 0) > 5000).length;
  result.withoutSlowFiles = testBudget(files.filter(file => (durations[file] ?? 0) <= 5000), durations, machines, workerCount, importMs);
  console.log(JSON.stringify(result, null, 2));
  if (result.predictedMaxMs > Number(option('--limit-ms', Infinity))) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
