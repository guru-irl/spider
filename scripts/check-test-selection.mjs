#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkProbe(probe, manifest) {
  if (manifest.mode !== probe.mode) throw new Error(`${probe.name}: expected ${probe.mode}, got ${manifest.mode}; fallback: ${manifest.fallback}`);
  for (const consumer of probe.expected) if (!manifest.files.includes(consumer)) throw new Error(`${probe.name}: omitted consumer ${consumer}`);
  return { name: probe.name, mode: manifest.mode, files: manifest.files.length, selectionMs: manifest.selectionMs, optional: manifest.optional, selectionHash: manifest.selectionHash };
}

export function checkExecution(report, root, file) {
  const files = report?.testResults?.map(result => relative(root, result.name).replaceAll('\\', '/'));
  if (report?.success !== true || report.numFailedTests !== 0 || report.numPassedTests !== 1
    || !files || files.length !== 1 || files[0] !== file || report.testResults[0].status !== 'passed') {
    throw new Error('exact-manifest execution evidence is failed, skipped or contains unexpected files');
  }
}

const run = (executable, args, options = {}) => execFileSync(executable, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });

function probeExecution(root, directory) {
  const checkout = mkdtempSync(join(directory, 'runner-'));
  const put = (file, contents, mode) => { const path = join(checkout, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents, { mode }); };
  const git = (...args) => run('git', args, { cwd: checkout });
  const commit = message => {
    const path = join(directory, 'runner-commit-message.txt'); writeFileSync(path, message + '\n');
    git('add', '--all'); git('-c', 'user.name=Gurupungav Narayanan', '-c', 'user.email=gurupungavn@gmail.com', 'commit', '--quiet', '-F', path);
    return git('rev-parse', 'HEAD').trim();
  };
  const name = 'exact-manifest-execution', file = 'packages/a/src/value.test.ts';
  const filename = join(directory, `${name}.json`), report = join(directory, 'runner-results.json');
  try {
    git('init', '--quiet'); put('.gitignore', 'node_modules/\n'); put('package.json', '{"type":"module"}\n');
    for (const script of ['select-tests.mjs', 'run-selected-tests.mjs', 'test-resources.json', 'test-durations.json', 'test-shards.ts']) {
      mkdirSync(join(checkout, 'scripts'), { recursive: true });
      copyFileSync(join(root, 'scripts', script), join(checkout, 'scripts', script));
    }
    const resources = JSON.parse(readFileSync(join(checkout, 'scripts/test-resources.json'), 'utf8'));
    resources.bundles.entries = []; resources.bundles.consumers = [];
    put('scripts/test-resources.json', JSON.stringify(resources) + '\n');
    put('scripts/roam-entries.json', '{}\n');
    put('vitest.config.mjs', 'export default { test: { include: ["packages/*/src/*.test.ts"], globalSetup: ["./global-setup.mjs"] } };\n');
    put('global-setup.mjs', 'export default function () { if (process.env.TEST !== "true" || process.env.VITEST !== "true" || process.env.NODE_ENV !== "test") throw new Error("runner environment was not prepared"); }\n');
    put('packages/a/src/value.ts', 'export const value = 1;\n');
    put(file, 'import { it, expect } from "vitest"; import { spawnSync } from "node:child_process"; import { value } from "./value.ts"; it("runs the exact manifest with local commands", () => { expect(value).toBe(2); const child = spawnSync("fixture-selection-command", [], { encoding: "utf8" }); expect(child.status, child.stderr).toBe(0); expect(child.stdout).toBe("fixture-command"); });\n');
    put('packages/b/src/unselected.test.ts', 'throw new Error("an unselected test was executed");\n');
    run('cp', ['-al', join(root, 'node_modules'), join(checkout, 'node_modules')]);
    put('node_modules/.bin/fixture-selection-command', '#!/bin/sh\nprintf fixture-command\n', 0o755);
    const base = commit('test(ci): seed execution fixture'); put('packages/a/src/value.ts', 'export const value = 2;\n');
    const head = commit('test(ci): change execution fixture source');
    const env = { ...process.env, PATH: (process.env.PATH ?? '').split(delimiter).filter(path => !path.endsWith('/node_modules/.bin')).join(delimiter) };
    for (const key of ['TEST', 'VITEST', 'NODE_ENV']) delete env[key];
    run(process.execPath, [join(checkout, 'scripts/select-tests.mjs'), '--base', base, '--head', head, '--output', filename], { cwd: checkout, env, timeout: 30_000 });
    const manifest = JSON.parse(readFileSync(filename, 'utf8'));
    const result = checkProbe({ name, mode: 'scoped', expected: [file] }, manifest);
    if (manifest.files.length !== 1) throw new Error('fixture selection was not exactly one test file');
    const log = run(process.execPath, [join(checkout, 'scripts/run-selected-tests.mjs'), '--manifest', filename, '--shard', '1/1', '--report', report], { cwd: checkout, env, timeout: 30_000 });
    writeFileSync(join(directory, 'runner-execution.log'), log);
    checkExecution(JSON.parse(readFileSync(report, 'utf8')), checkout, file);
    return { ...result, status: 'passed', executedFiles: 1 };
  } catch (error) {
    writeFileSync(join(directory, 'runner-execution.log'), `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`);
    return { name, status: 'failed', error: error.message.split('\n')[0] };
  } finally { rmSync(checkout, { recursive: true, force: true }); }
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('real graph probes run only on a disposable GitHub runner');
  const root = process.cwd();
  const directory = resolve('.spider/scratch/selection-probes');
  mkdirSync(directory, { recursive: true });
  const checkout = mkdtempSync(join(directory, 'tree-'));
  const git = (...args) => run('git', args, { cwd: checkout });
  const selector = fileURLToPath(new URL('./select-tests.mjs', import.meta.url));
  const base = run('git', ['rev-parse', 'HEAD']).trim();
  const results = [];
  const append = (file, suffix) => () => appendFileSync(join(checkout, file), suffix);
  const roam = 'packages/roam/src/__tests__/store-prune.test.ts';
  const assets = 'packages/herdr/src/__tests__/cross-machine-mod-compat.test.ts';
  const docs = 'packages/host/src/__tests__/pi-config-examples.test.ts';
  const newTest = 'packages/roam/src/__tests__/selection-added.test.ts';
  const probes = [
    { name: 'roam-source', mode: 'scoped', expected: [roam], mutate: append('packages/roam/src/store-prune.ts', '\n// Selection probe.\n') },
    { name: 'herdr-asset', mode: 'scoped', expected: [assets], mutate: append('packages/herdr/assets/pane/actions.js', '\n// Selection probe.\n') },
    { name: 'documentation', mode: 'scoped', expected: [docs], mutate: append('docs/architecture/README.md', '\n<!-- Selection probe. -->\n') },
    { name: 'raw-template', mode: 'scoped', expected: [assets], mutate: append('packages/herdr/assets/templates/role.md', '\n<!-- Selection probe. -->\n') },
    { name: 'skill-script', mode: 'scoped', expected: ['packages/pstack/src/__tests__/log-script.test.ts', 'packages/organism/src/__tests__/bundled-skills.test.ts'], mutate: append('packages/pstack/skills/show-me-your-work/scripts/log.sh', '\n# Selection probe.\n') },
    { name: 'json-fixture', mode: 'scoped', expected: [assets], mutate: append('packages/herdr/src/__tests__/fixtures/mod-api.json', '\n') },
    { name: 'bundle-input', mode: 'scoped', expected: ['packages/herdr/src/__tests__/herdr-viewer-warning.test.ts'], mutate: append('packages/herdr/src/bin/viewer.ts', '\n// Selection probe.\n') },
    { name: 'new-test', mode: 'scoped', expected: [newTest], mutate: () => writeFileSync(join(checkout, newTest), 'import { it } from "vitest";\nthrow new Error("file-only selection collected a test module");\nit("probe", () => {});\n') },
    { name: 'rename', mode: 'full', expected: [roam, assets], mutate: () => git('mv', 'packages/roam/src/store-prune.ts', 'packages/roam/src/selection-renamed.ts') },
    { name: 'delete', mode: 'full', expected: [roam, assets], mutate: () => git('rm', 'packages/roam/src/store-prune.ts') },
    { name: 'unknown-resource', mode: 'full', expected: [roam, assets], mutate: () => writeFileSync(join(checkout, 'selection-unknown.resource'), 'probe') },
    { name: 'unsupported-path', mode: 'full', expected: [roam, assets], mutate: () => writeFileSync(join(checkout, 'selection with spaces.resource'), 'probe') },
    { name: 'missing-base', mode: 'full', expected: [roam, assets], base: 'f'.repeat(40), mutate: append('docs/architecture/README.md', '\n<!-- Selection probe. -->\n') },
  ];
  try {
    run('git', ['worktree', 'add', '--quiet', '--detach', checkout, base]);
    run('cp', ['-al', join(root, 'node_modules'), join(checkout, 'node_modules')]);
    for (const probe of probes) {
      git('reset', '--quiet', '--hard', base);
      probe.mutate();
      git('add', '--all');
      const message = join(directory, 'probe-commit-message.txt');
      writeFileSync(message, `test(ci): probe ${probe.name}\n`);
      git('-c', 'user.name=Gurupungav Narayanan', '-c', 'user.email=gurupungavn@gmail.com', 'commit', '--quiet', '-F', message);
      const head = git('rev-parse', 'HEAD').trim();
      const filename = join(directory, `${probe.name}.json`);
      const log = run(process.execPath, [selector, '--base', probe.base ?? base, '--head', head, '--output', filename], { cwd: checkout, timeout: 180_000 });
      writeFileSync(join(directory, `${probe.name}.log`), log);
      const manifest = JSON.parse(readFileSync(filename, 'utf8'));
      try {
        const result = checkProbe(probe, manifest);
        const budget = JSON.parse(run(process.execPath, [fileURLToPath(new URL('./test-shard-budget.mjs', import.meta.url)), '--manifest', filename], { cwd: checkout }));
        results.push({ ...result, status: 'passed', predictedMs: budget.predictedMaxMs, withoutSlowFilesMs: budget.withoutSlowFiles.predictedMaxMs, slowFiles: budget.slowFiles });
      } catch (error) { results.push({ name: probe.name, status: 'failed', error: error.message, mode: manifest.mode, fallback: manifest.fallback }); }
      writeFileSync(join(directory, 'summary.json'), JSON.stringify(results, null, 2) + '\n');
      console.log(`${probe.name}: ${results.at(-1).status}, ${manifest.files.length} files, ${manifest.selectionMs} ms`);
    }
  } finally { run('git', ['worktree', 'remove', '--force', checkout]); }
  results.push(probeExecution(root, directory));
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`${results.at(-1).name}: ${results.at(-1).status}`);
  if (results.some(result => result.status !== 'passed')) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
