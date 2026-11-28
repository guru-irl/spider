// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';

const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/selection/scoreboard.mjs MAP');
const map = JSON.parse(readFileSync(input, 'utf8'));
const tests = Object.entries(map.tests).map(([file, record]) => ({ file, ...record }));
for (const test of tests) {
  if (!Number.isSafeInteger(test.processes) || test.processes < 1 ||
      !Number.isFinite(test.knownCpuMs) || test.knownCpuMs < 0 ||
      !Number.isSafeInteger(test.unknownCpu) || test.unknownCpu < 0 || test.unknownCpu > test.processes ||
      !Number.isSafeInteger(test.missingCpu) || test.missingCpu < 0 || test.missingCpu > test.unknownCpu ||
      (test.unknownCpu ? test.cpuMs !== null : test.cpuMs !== test.knownCpuMs) ||
      !Number.isFinite(test.ms) || test.ms < 0) throw new Error(`Invalid scoreboard record: ${test.file}`);
}
tests.sort((a, b) => b.knownCpuMs - a.knownCpuMs || a.file.localeCompare(b.file));
const totalProcesses = tests.reduce((sum, test) => sum + test.processes, 0);
const totalCpu = tests.reduce((sum, test) => sum + test.knownCpuMs, 0);
const unknown = tests.reduce((sum, test) => sum + test.unknownCpu, 0);
const missing = tests.reduce((sum, test) => sum + test.missingCpu, 0);
const heavy = tests.filter(test => test.processes >= 50);
const heavyCpu = heavy.reduce((sum, test) => sum + test.knownCpuMs, 0);
const slow = tests.filter(test => test.ms > 89000).length;
const integer = value => Math.round(value).toLocaleString('en-US');
const one = value => value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const partial = value => value ? '≥' : '';
const rows = tests.slice(0, 30).map(test =>
  `| ${test.file.replaceAll('|', '\\|')} | ${integer(test.processes)} | ${partial(test.unknownCpu)}${integer(test.knownCpuMs)} | ${integer(test.ms)} | ${partial(test.unknownCpu)}${one(test.knownCpuMs / test.processes)} |`);
console.log([
  '## Test process scoreboard', '',
  'Ranked by observed CPU; ≥ indicates an incomplete measurement.', '',
  '| Test file | Processes | CPU ms | Wall ms | CPU ms/process |',
  '| --- | ---: | ---: | ---: | ---: |', ...rows, '',
  `- Processes: ${integer(totalProcesses)}`,
  `- CPU: ${partial(unknown)}${integer(totalCpu)} ms`,
  `- ${integer(heavy.length)} files with 50 or more processes: ${one(totalCpu ? heavyCpu / totalCpu * 100 : 0)}% of observed CPU`,
  `- ${integer(slow)} files with wall time over 89,000 ms`,
  `- ${integer(unknown)} processes with unknown CPU (missing or unfinished checkpoint)`,
  `- ${integer(missing)} processes with no CPU sample`, '',
].join('\n'));
