// SPDX-License-Identifier: MIT
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const testDirectory = 'packages/herdr/src/__tests__/';

function tokens(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const result = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    result.push([kind, scanner.getTokenText()]);
  }
  return JSON.stringify(result);
}

function assertions(files) {
  const found = new Map();
  for (const { path, text } of files) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (source.parseDiagnostics.length) throw new Error(`Could not parse ${path}`);
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'expect') {
        let outer = node;
        for (;;) {
          const parent = outer.parent;
          if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent) || ts.isCallExpression(parent)) && parent.expression === outer) outer = parent;
          else break;
        }
        const expression = outer.getText(source), key = tokens(expression);
        const row = found.get(key) ?? { text: expression, path, count: 0 };
        row.count++;
        found.set(key, row);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

export function missingAssertions(before, after) {
  const old = assertions(before), current = assertions(after), missing = [];
  for (const [key, row] of old) {
    const count = row.count - (current.get(key)?.count ?? 0);
    if (count > 0) missing.push({ text: row.text, path: row.path, count });
  }
  return missing;
}

export function missingCases(before, after) {
  const count = rows => {
    const result = new Map();
    for (const { name, status } of rows) {
      const key = JSON.stringify([name, status]);
      const row = result.get(key) ?? { name, status, count: 0 };
      row.count++;
      result.set(key, row);
    }
    return result;
  };
  const current = count(after), missing = [];
  for (const [key, row] of count(before)) {
    const absent = row.count - (current.get(key)?.count ?? 0);
    if (absent > 0) missing.push({ name: row.name, status: row.status, count: absent });
  }
  return missing;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitFile(revision, path) {
  const result = spawnSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' });
  if (result.status === 0) return { path, text: result.stdout };
  const exists = spawnSync('git', ['cat-file', '-e', `${revision}:${path}`], { stdio: 'ignore' });
  if (exists.status !== 0) return null;
  throw new Error(`Could not read ${revision}:${path}: ${result.stderr}`);
}

function sources(base, head) {
  const baseSha = git('rev-parse', '--verify', `${base}^{commit}`);
  const headSha = head === 'WORKTREE' ? null : git('rev-parse', '--verify', `${head}^{commit}`);
  const args = ['diff', '--name-only', '--no-renames', baseSha];
  if (headSha) args.push(headSha);
  args.push('--', testDirectory);
  const changed = git(...args).split('\n').filter(Boolean);
  if (!headSha) changed.push(...git('ls-files', '--others', '--exclude-standard', '--', testDirectory).split('\n').filter(Boolean));
  const paths = [...new Set(changed)].filter(path => path.endsWith('.ts')).sort();
  if (!paths.length) throw new Error(`No changed TypeScript files under ${testDirectory}`);
  const before = [], after = [];
  for (const path of paths) {
    const previous = gitFile(baseSha, path);
    if (previous) before.push(previous);
    const current = headSha ? gitFile(headSha, path) : existsSync(path) ? { path, text: readFileSync(path, 'utf8') } : null;
    if (current) after.push(current);
  }
  return { paths, before, after };
}

function reportCases(directory) {
  const files = readdirSync(directory).filter(name => name.endsWith('.test.ts.json')).sort();
  if (!files.length) throw new Error(`No test reports in ${directory}`);
  const cases = [];
  for (const file of files) {
    const report = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    if (!Array.isArray(report.testResults) || !report.testResults.length || report.numFailedTests !== 0) throw new Error(`Incomplete or failing report: ${file}`);
    for (const result of report.testResults) {
      if (result.status !== 'passed' || !Array.isArray(result.assertionResults) || !result.assertionResults.length) throw new Error(`Incomplete or failing file in ${file}`);
      for (const row of result.assertionResults) {
        if (typeof row.fullName !== 'string' || typeof row.status !== 'string') throw new Error(`Invalid case in ${file}`);
        cases.push({ name: row.fullName, status: row.status });
      }
    }
  }
  return cases;
}

function main() {
  const { values } = parseArgs({ options: {
    base: { type: 'string', default: 'origin/main' }, head: { type: 'string', default: 'WORKTREE' },
    'before-reports': { type: 'string' }, 'after-reports': { type: 'string' },
  } });
  const { paths, before, after } = sources(values.base, values.head);
  const missing = missingAssertions(before, after);
  console.log(`Compared assertion expressions in ${paths.length} changed Herdr files.`);
  for (const row of missing) console.error(`Missing ${row.count} in ${row.path}: ${row.text}`);
  let missingRuns = [];
  if (values['before-reports'] || values['after-reports']) {
    if (!values['before-reports'] || !values['after-reports']) throw new Error('Both report directories are required');
    const oldCases = reportCases(values['before-reports']), newCases = reportCases(values['after-reports']);
    missingRuns = missingCases(oldCases, newCases);
    console.log(`Compared ${oldCases.length} baseline CI cases with ${newCases.length} current CI cases.`);
    for (const row of missingRuns) console.error(`Missing ${row.count} ${row.status} case: ${row.name}`);
  }
  if (missing.length || missingRuns.length) process.exitCode = 1;
  else console.log(values['before-reports'] ? 'No baseline assertions or named cases are missing.' : 'No baseline assertion expressions are missing. CI cases were not compared.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
