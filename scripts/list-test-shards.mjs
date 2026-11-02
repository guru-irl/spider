#!/usr/bin/env node
import { relative } from 'node:path';
import { createVitest } from 'vitest/node';

const shard = process.argv[2];
if (!/^\d+\/\d+$/.test(shard ?? '')) throw new Error('usage: node scripts/list-test-shards.mjs index/count');
const [index, count] = shard.split('/').map(Number);
if (index < 1 || index > count) throw new Error('shard index must be between 1 and count');
const ctx = await createVitest('test', { run: true, watch: false, shard, maxWorkers: 2 });
try {
  const files = await ctx.globTestSpecifications();
  const sequencer = new ctx.config.sequence.sequencer(ctx);
  const selected = await sequencer.sort(await sequencer.shard(files));
  console.log(JSON.stringify(selected.map(file => relative(ctx.config.root, file.moduleId).replaceAll('\\', '/')), null, 2));
} finally { await ctx.close(); }
