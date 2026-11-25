#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Measurement only. This cohort never replaces the required PR test manifest.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionPlan } from './run-selected-tests.mjs';
import { partitionFiles } from './test-shards.ts';

export function measurementPlan(manifest, { root = process.cwd(), shard, shadow = false, durations } = {}) {
  const plan = executionPlan(manifest, { root, shard, shadow });
  const excludedSlowFiles = plan.files.filter(file => (durations[file] ?? 0) > 5000);
  const unmeasuredFiles = plan.files.filter(file => durations[file] === undefined);
  const files = plan.files.filter(file => (durations[file] ?? 0) <= 5000);
  const [index, count] = plan.shard.split('/').map(Number);
  return { ...plan, files, empty: !partitionFiles(files, durations, count)[index - 1].length,
    excludedSlowFiles, unmeasuredFiles, sourceSelectionHash: manifest.selectionHash,
    cohortHash: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('test wall-time measurements run only on GitHub Actions');
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  if (!args.includes('--manifest') || !args.includes('--shard') || !args.includes('--output')) throw new Error('usage: measure-test-selection.mjs --manifest file --shard index/count --output file [--shadow]');
  const manifest = JSON.parse(readFileSync(option('--manifest'), 'utf8'));
  const durations = JSON.parse(readFileSync(new URL('./test-durations.json', import.meta.url), 'utf8'));
  const plan = measurementPlan(manifest, { shard: option('--shard'), shadow: args.includes('--shadow'), durations });
  const output = resolve(option('--output'));
  mkdirSync(dirname(output), { recursive: true });
  const measurement = { ...plan, testedSha: manifest.testedSha, timingHash: manifest.timingHash,
    startedAt: new Date().toISOString(), status: 'failed', wallMs: null };
  const started = performance.now();
  let ctx;
  try {
    if (!plan.empty) {
      const { createVitest } = await import('vitest/node');
      ctx = await createVitest('test', { run: true, watch: false, include: plan.files,
        shard: plan.shard, maxWorkers: 3, changed: false, related: undefined,
        reporters: ['default', 'json'], outputFile: output.replace(/\.json$/, '-results.json') });
      const { testModules, unhandledErrors } = await ctx.start();
      if (unhandledErrors.length || testModules.some(module => !module.ok())) throw new Error('measurement test failure; not a valid timing sample');
    }
    measurement.status = 'passed';
  } catch (error) {
    measurement.error = error.message.split('\n')[0];
    process.exitCode = 1;
  } finally {
    if (ctx) await ctx.close();
    measurement.wallMs = Math.round(performance.now() - started);
    measurement.finishedAt = new Date().toISOString();
    writeFileSync(output, JSON.stringify(measurement, null, 2) + '\n');
  }
  console.log(`Measurement ${plan.shard}: ${measurement.status}, ${measurement.wallMs} ms, ${plan.excludedSlowFiles.length} recorded slow files excluded, ${plan.unmeasuredFiles.length} unmeasured files retained`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
