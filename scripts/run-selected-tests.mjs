#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testInventory, validateManifest } from './select-tests.mjs';
import { partitionFiles } from './test-shards.ts';

const durations = JSON.parse(readFileSync(new URL('./test-durations.json', import.meta.url), 'utf8'));

export function executionEnvironment(root = process.cwd(), env = process.env) {
  return { ...env, PATH: `${resolve(root, 'node_modules/.bin')}${delimiter}${env.PATH ?? ''}`,
    TEST: 'true', VITEST: 'true', NODE_ENV: env.NODE_ENV ?? 'test' };
}

export function executionPlan(manifest, { root = process.cwd(), shard, shadow = false } = {}) {
  const match = /^(\d+)\/(\d+)$/.exec(shard ?? '');
  if (!match || +match[1] < 1 || +match[1] > +match[2]) throw new Error('invalid shard index/count');
  const selected = validateManifest(manifest, { root });
  const files = shadow ? testInventory(root) : selected;
  const partition = partitionFiles(files, durations, +match[2])[+match[1] - 1];
  return { files, shard, maxWorkers: 3, empty: partition.length === 0, shadow };
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  const filename = args.includes('--manifest') ? option('--manifest') : undefined;
  if (!filename || !args.includes('--shard')) throw new Error('usage: run-selected-tests.mjs --manifest file --shard index/count [--shadow] [--report file]');
  const manifest = JSON.parse(readFileSync(filename, 'utf8'));
  const plan = executionPlan(manifest, { shard: option('--shard'), shadow: args.includes('--shadow') });
  if (plan.empty) { console.log(`Validated empty partition ${plan.shard}; no tests to run.`); return; }
  Object.assign(process.env, executionEnvironment());
  const { createVitest } = await import('vitest/node');
  const ctx = await createVitest('test', {
    run: true, watch: false, include: plan.files, shard: plan.shard,
    maxWorkers: plan.maxWorkers, changed: false, related: undefined,
    reporters: ['default', 'json'], outputFile: args.includes('--report') ? option('--report') : undefined,
  });
  try {
    const { testModules, unhandledErrors } = await ctx.start();
    if (unhandledErrors.length || testModules.some(module => !module.ok())) process.exitCode = 1;
  } finally { await ctx.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
