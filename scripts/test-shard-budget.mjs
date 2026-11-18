// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { globSync, readFileSync } from 'node:fs';
import { medianDuration, partitionFiles, sortByDuration } from './test-shards.ts';

const durations = JSON.parse(readFileSync('scripts/test-durations.json', 'utf8'));
const files = globSync('packages/**/src/**/*.test.ts').sort();
const fallback = medianDuration(durations);
const shards = partitionFiles(files, durations, 12).map((files, index) => {
  const workers = [0, 0];
  for (const file of sortByDuration(files, durations)) {
    const worker = workers[0] <= workers[1] ? 0 : 1;
    workers[worker] += durations[file] ?? fallback;
  }
  return { shard: index + 1, predictedMs: Math.max(...workers), workersMs: workers, files };
});
const predictedMaxMs = Math.max(...shards.map(shard => shard.predictedMs));
console.log(JSON.stringify({ fileCount: files.length, predictedMaxMs, shards }, null, 2));
if (predictedMaxMs >= 420_000) process.exitCode = 1;
