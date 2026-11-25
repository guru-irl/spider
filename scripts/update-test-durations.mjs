#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
let output = 'scripts/test-durations.json';
if (args[0] === '--output') {
  args.shift();
  output = args.shift();
}
if (!output || !args.length) throw new Error('usage: node scripts/update-test-durations.mjs [--output file] report.json ...');

const durations = {};
for (const report of args) {
  const { testResults } = JSON.parse(readFileSync(report, 'utf8'));
  if (!Array.isArray(testResults) || !testResults.length) throw new Error(`${report}: no test file results`);
  for (const result of testResults) {
    const name = String(result.name).replaceAll('\\', '/');
    const file = name.startsWith('packages/') ? name : name.slice(name.indexOf('/packages/') + 1);
    if (!/^packages\/.+\/src\/.+\.test\.ts$/.test(file) || file.split('/').includes('..')) {
      throw new Error(`${report}: not a root-suite file: ${name}`);
    }
    const { startTime, endTime } = result;
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
      throw new Error(`${report}: invalid file timestamps: ${file}`);
    }
    durations[file] = Math.max(durations[file] ?? 0, endTime - startTime);
  }
}
// Reports from scoped PR runs cannot replace the complete history. Observed
// files use the new maximum, so a genuine speedup can lower an old weight.
const previous = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {};
const merged = { ...previous, ...durations };
writeFileSync(output, JSON.stringify(Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), null, 2) + '\n');
console.log(`Updated ${Object.keys(durations).length} file durations; retained ${Object.keys(merged).length} total entries`);
