// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync } from 'node:fs';
import { medianDuration, partitionFiles, sortByDuration } from './test-shards.ts';
import { testInventory, validateManifest } from './select-tests.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const durations = JSON.parse(readFileSync(new URL('./test-durations.json', import.meta.url), 'utf8'));
const manifest = option('--manifest');
const files = manifest ? validateManifest(JSON.parse(readFileSync(manifest, 'utf8'))) : testInventory(process.cwd());
const machines = Number(option('--machines', 2));
const workerCount = Number(option('--workers', 3));
if (!Number.isInteger(workerCount) || workerCount < 1) throw new Error('workers must be a positive integer');
const fallback = medianDuration(durations);
function budget(files) {
  const shards = partitionFiles(files, durations, machines).map((files, index) => {
    const workers = Array(workerCount).fill(0);
    for (const file of sortByDuration(files, durations)) {
      const worker = workers.indexOf(Math.min(...workers));
      workers[worker] += durations[file] ?? fallback;
    }
    return { shard: index + 1, predictedMs: Math.max(...workers), workersMs: workers, files };
  });
  return { fileCount: files.length, aggregateMs: files.reduce((sum, file) => sum + (durations[file] ?? fallback), 0), predictedMaxMs: Math.max(...shards.map(shard => shard.predictedMs)), shards };
}
const result = budget(files);
result.unmeasuredFiles = files.filter(file => durations[file] === undefined).length;
result.slowFiles = files.filter(file => (durations[file] ?? 0) > 5000).length;
result.withoutSlowFiles = budget(files.filter(file => (durations[file] ?? 0) <= 5000));
console.log(JSON.stringify(result, null, 2));
const limit = Number(option('--limit-ms', Infinity));
if (result.predictedMaxMs >= limit) process.exitCode = 1;
