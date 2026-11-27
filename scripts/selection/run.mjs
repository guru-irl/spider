// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter, relative, resolve } from 'node:path';
import { groupCount, sorted, validateSelection } from './manifest.mjs';

const [file, groupText, reportFile, hashFile] = process.argv.slice(2);
const group = Number(groupText);
if (!file || !reportFile || !hashFile || !Number.isInteger(group) || group < 1 || group > groupCount) {
  throw new Error('Usage: node scripts/selection/run.mjs MANIFEST GROUP REPORT HASH_FILE');
}
const root = process.cwd();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const selection = validateSelection(JSON.parse(readFileSync(file, 'utf8')), head);
const files = selection.groups[group - 1];
if (files.length) {
  // Match npx vitest, including the pi shim available to child processes.
  process.env.PATH = `${resolve(root, 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`;
  process.env.TEST = process.env.VITEST = 'true';
  process.env.NODE_ENV ??= 'test';
  const { createVitest } = await import('vitest/node');
  const ctx = await createVitest('test', { run: true, watch: false, include: files, changed: false,
    maxWorkers: 3, reporters: ['default', 'json'], outputFile: reportFile });
  try {
    const { testModules, unhandledErrors } = await ctx.start();
    const actual = sorted(testModules.map(module => relative(root, module.moduleId).replaceAll('\\', '/')));
    if (JSON.stringify(actual) !== JSON.stringify(sorted(files))) throw new Error('Vitest did not report exactly the assigned group');
    if (unhandledErrors.length || testModules.some(module => !module.ok()) || process.exitCode) process.exitCode = 1;
  } finally { await ctx.close(); }
} else {
  console.log(`Group ${group}/${groupCount} is empty, as recorded in the verified selection.`);
}
if (!process.exitCode) writeFileSync(hashFile, `${JSON.stringify({ group, selectionHash: selection.selectionHash })}\n`);
