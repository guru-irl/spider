import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = message => { throw new Error(message); };
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function checkLifecycle(files, report, json) {
  const expected = new Set(files.map(file => basename(file)));
  if (!files.length || expected.size !== files.length) fail('empty or duplicate expected files');
  if (report.reason !== 'passed' || report.unhandledErrors !== 0 || !Array.isArray(report.errors) || report.errors.length) fail('lifecycle run did not finish cleanly');
  if (!Array.isArray(report.modules) || report.modules.length !== expected.size) fail('incomplete lifecycle modules');
  if (!json.success || json.numFailedTests !== 0 || !Array.isArray(json.testResults) || json.testResults.length !== expected.size) fail('incomplete JSON results');
  const byName = new Map();
  for (const test of json.testResults) {
    const name = basename(test.name);
    if (!expected.has(name) || byName.has(name) || test.status !== 'passed' || !Array.isArray(test.assertionResults) || !test.assertionResults.length || !number(test.startTime) || !number(test.endTime) || test.endTime < test.startTime) fail(`bad JSON result: ${name}`);
    byName.set(name, test);
  }
  const seen = new Set();
  return report.modules.map(row => {
    const name = basename(row.name);
    if (!expected.has(name) || seen.has(name) || row.state !== 'passed') fail(`bad module result: ${name}`);
    seen.add(name);
    const d = row.diagnostic;
    if (!d || !number(row.activeMs) || !number(row.fullMs) || !number(d.prepareDuration) || !number(d.duration) || !number(d.collectDuration) || !number(d.setupDuration)) fail(`invalid lifecycle time: ${name}`);
    if (Math.abs(row.fullMs - row.activeMs - d.prepareDuration) > 0.01) fail(`invalid preparation time: ${name}`);
    const span = byName.get(name).endTime - byName.get(name).startTime;
    if (row.activeMs + 30 < span || row.activeMs + 30 < d.duration + d.collectDuration + d.setupDuration) fail(`lifecycle omits observed work: ${name}`);
    return { name, activeMs: row.activeMs, fullMs: row.fullMs, jsonSpanMs: span, overLimit: row.fullMs >= 45_000 };
  }).sort((a, b) => b.fullMs - a.fullMs);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [reportPath, jsonPath, listPath, flag] = process.argv.slice(2);
    if (!reportPath || !jsonPath || !listPath || flag && flag !== '--report-only') fail('usage: lifecycle-summary.mjs <lifecycle.json> <results.json> <file-list> [--report-only]');
    const files = readFileSync(listPath, 'utf8').trim().split('\n').filter(Boolean);
    const rows = checkLifecycle(files, JSON.parse(readFileSync(reportPath)), JSON.parse(readFileSync(jsonPath)));
    for (const row of rows) console.log(`${row.name.padEnd(55)} ${(row.fullMs / 1000).toFixed(3)}s (JSON span ${(row.jsonSpanMs / 1000).toFixed(3)}s)`);
    const over = rows.filter(row => row.overLimit).length;
    console.log(`${over} file(s) reached 45 seconds`);
    if (over && flag !== '--report-only') process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
