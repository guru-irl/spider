import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const dir = process.argv[2];
const load = name => readFileSync(join(dir, name), 'utf8');
const rows = load('children.ndjson').trim().split('\n').map(line => JSON.parse(line));
const files = new Map(rows.filter(r => r.type === 'file').map(r => [r.file, r.worker]));
const starts = rows.filter(r => r.type === 'start');
const exits = new Map(rows.filter(r => r.type === 'exit').map(r => [`${r.worker}:${r.pid}`, r]));
const report = JSON.parse(load('vitest.json'));
for (const test of report.testResults) {
  const worker = files.get(test.name);
  if (!worker) throw Error(`Missing worker for ${test.name}`);
  const children = starts.filter(r => r.worker === worker);
  console.log(`${basename(test.name)} | ${test.status} | ${test.endTime - test.startTime} ms | ${children.length} observed child Node processes`);
  const grouped = new Map();
  for (const row of children) {
    const [entry, command] = row.argv;
    const script = basename(entry ?? '(flag only)');
    const key = script === 'cli.mjs' || script === 'fake-hc.mjs' ? `${script} ${command ?? ''}` : script;
    if (!grouped.has(key)) grouped.set(key, { n: 0, cpu: 0, timed: 0, wall: 0 });
    const stat = grouped.get(key); stat.n++;
    const end = exits.get(`${worker}:${row.pid}`);
    if (end) { stat.timed++; stat.cpu += end.cpuMs; stat.wall += end.at - row.at; }
  }
  for (const [command, x] of [...grouped].sort((a, b) => b[1].cpu - a[1].cpu).slice(0, 15))
    console.log(`  ${x.n}x ${command} | ${x.cpu.toFixed(0)} CPU ms | ${x.timed} exits | ${x.timed ? (x.wall / x.timed).toFixed(0) : '-'} avg wall ms`);
  for (const c of test.assertionResults.filter(r => r.status !== 'skipped')) console.log(`  ${Math.round(c.duration ?? 0)} ms | ${c.status} | ${c.title}`);
}
