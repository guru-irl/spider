import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const dir = process.argv[2];
let totalCpu = 0;
for (const name of readdirSync(dir).filter(name => name.endsWith('.test.ts.json')).sort()) {
  const base = name.slice(0, -'.json'.length);
  const report = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  if (report.testResults.length !== 1) throw new Error(`Expected one test file in ${name}`);
  const result = report.testResults[0];
  const times = Object.fromEntries(readFileSync(join(dir, `${base}.time`), 'utf8').trim().split('\n').map(line => line.split(' ')));
  const cpu = Number(times.user) + Number(times.sys);
  if (!Number.isFinite(cpu)) throw new Error(`Missing CPU time for ${base}`);
  totalCpu += cpu;
  const log = readFileSync(join(dir, `${base}.ndjson`), 'utf8').trim();
  const rows = log ? log.split('\n').map(line => JSON.parse(line)) : [];
  const starts = rows.filter(row => row.type === 'start');
  const exits = rows.filter(row => row.type === 'exit');
  const groups = new Map();
  for (const row of starts) {
    const entry = basename(row.argv[0] ?? '(flag only)');
    const key = entry === 'cli.mjs' || entry === 'fake-hc.mjs' ? `${entry} ${row.argv[1] ?? ''}` : entry;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  console.log(`${base} | ${result.status} | file ${(result.endTime - result.startTime) / 1000}s | command wall ${times.real}s | waited-tree CPU ${cpu.toFixed(2)}s | ${starts.length} Node starts | ${exits.length} observed exits`);
  console.log('  ' + [...groups].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([key, count]) => `${key}: ${count}`).join('; '));
}
console.log(`Total waited-tree CPU: ${totalCpu.toFixed(2)}s`);
