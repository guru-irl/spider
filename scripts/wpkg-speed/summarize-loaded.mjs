import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const files = readFileSync(process.argv[3], 'utf8').trim().split('\n').filter(Boolean).map(file => resolve(file));
if (!files.length || new Set(files).size !== files.length) throw new Error('Empty or duplicate requested file list');
if (!report.success || report.numFailedTests !== 0 || !Array.isArray(report.testResults)) throw new Error('Failing test report');
const expected = new Set(files), seen = new Set(), rows = [];
for (const result of report.testResults) {
  const path = resolve(result.name);
  if (seen.has(path)) throw new Error(`Duplicate test file: ${path}`);
  if (!expected.has(path)) throw new Error(`Unexpected test file: ${path}`);
  seen.add(path);
  if (result.status !== 'passed' || !Array.isArray(result.assertionResults) || !result.assertionResults.length) throw new Error(`Failing test file: ${path}`);
  const seconds = (result.endTime - result.startTime) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`Invalid file wall time: ${path}`);
  rows.push({ name: basename(path), seconds });
}
for (const file of expected) if (!seen.has(file)) throw new Error(`Missing requested file: ${file}`);
for (const row of rows.sort((a, b) => b.seconds - a.seconds)) console.log(`${row.name.padEnd(55)} ${row.seconds.toFixed(3)}s`);
const slow = rows.filter(row => row.seconds >= 45);
if (slow.length) throw new Error(`${slow.length} file(s) reached the 45-second file limit`);
