#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { testInventory, validateManifest } from './select-tests.mjs';
import { partitionFiles, sortByDuration } from './test-shards.ts';

const shard = process.argv[2];
if (!/^\d+\/\d+$/.test(shard ?? '')) throw new Error('usage: node scripts/list-test-shards.mjs index/count [--manifest file]');
const [index, count] = shard.split('/').map(Number);
if (index < 1 || index > count) throw new Error('shard index must be between 1 and count');
const manifestIndex = process.argv.indexOf('--manifest');
const files = manifestIndex < 0 ? testInventory(process.cwd()) : validateManifest(JSON.parse(readFileSync(process.argv[manifestIndex + 1], 'utf8')));
const durations = JSON.parse(readFileSync(new URL('./test-durations.json', import.meta.url), 'utf8'));
console.log(JSON.stringify(sortByDuration(partitionFiles(files, durations, count)[index - 1], durations), null, 2));
