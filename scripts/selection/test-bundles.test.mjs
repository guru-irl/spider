// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { bundleDigest } from './bundle-keys.mjs';
import { buildSelectionMap } from './map.mjs';
import { reduce } from './reduce.mjs';
import { selectTests } from './select.mjs';

const builders = new Map([
  ['vite', new Set(['build', 'createBuilder'])],
  ['rolldown', new Set(['rolldown', 'build', 'watch'])],
  ['esbuild', new Set(['build', 'buildSync', 'context'])],
]);

function rawBuilderImports(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const problems = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const api = builders.get(specifier.text);
        const clause = ts.isImportDeclaration(node) ? node.importClause : node.exportClause;
        if (api && !clause?.isTypeOnly) {
          const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : clause;
          const named = bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings));
          const defaultImport = ts.isImportDeclaration(node) && node.importClause?.name;
          if (defaultImport || (!named && (clause || ts.isExportDeclaration(node))) ||
            (named && bindings.elements.some(element => !element.isTypeOnly && api.has((element.propertyName ?? element.name).text)))) {
            problems.push(specifier);
          }
        }
      }
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier) && builders.has(specifier.text)) problems.push(specifier);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return problems.map(node => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} (${node.text})`);
}

test('direct bundler imports reject aliases, namespace imports, re-exports, and runtime imports', () => {
  const source = `import { build as bundle } from 'vite';
import { createServer, type build } from 'vite';
import type * as Esbuild from 'esbuild';
export * from 'rolldown';
import * as esbuild from 'esbuild';
const { build } = await import('vite');
const { rolldown } = require('rolldown');`;
  assert.deepEqual(rawBuilderImports('fixture.ts', source), [
    'fixture.ts:1 (vite)', 'fixture.ts:4 (rolldown)', 'fixture.ts:5 (esbuild)',
    'fixture.ts:6 (vite)', 'fixture.ts:7 (rolldown)',
  ]);
});

test('publishes pre-tree-shake inputs, direct reads, and renamed executable bytes from real recording', async t => {
  const root = mkdtempSync(join(tmpdir(), 'selection-bundle-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const raw = join(root, 'raw'), maps = join(root, 'maps');
  const bundleTools = name => fileURLToPath(new URL(name, import.meta.url));
  const run = (script, env = {}) => execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { cwd: root, env: { ...process.env, NODE_OPTIONS: '', ...env }, encoding: 'utf8' });
  const entry = 'packages/one/src/main.mjs', testFile = 'packages/one/src/build.test.ts';
  const aliasTest = 'packages/herdr/src/__tests__/herdr-viewer-warning.test.ts';
  const inventoryTest = 'packages/one/src/inventory.test.ts';
  const removed = 'packages/one/src/shaken.js';
  for (const [file, text] of Object.entries({
    [entry]: 'import { unused } from "./shaken.js"; export const marker = "main";',
    [removed]: 'export const unused = "unreachable text";',
    'packages/one/src/other.mjs': 'export const marker = "other";',
    'vite.config.mjs': 'import "./build-options.mjs"; export default {};',
    'build-options.mjs': 'export const onlyConfig = 1;',
  })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  run(`
    const { build } = await import(${JSON.stringify(import.meta.resolve('vite'))});
    const { archiveMaps, sourcemap } = await import(${JSON.stringify(new URL('./build-maps.mjs', import.meta.url).href)});
    for (const name of ['main', 'other']) {
      await build({ logLevel: 'silent', plugins: archiveMaps(), build: {
        emptyOutDir: false, ssr: 'packages/one/src/' + name + '.mjs', sourcemap,
        rollupOptions: { output: { entryFileNames: name + '.mjs', codeSplitting: false } },
      } });
    }`, { SPIDER_BUILD_SOURCEMAP: '1', SPIDER_SELECTION_MAPS: maps, SPIDER_SELECTION_DIR: '' });
  assert.ok(!readFileSync(join(root, 'dist/main.mjs'), 'utf8').includes('unreachable text'));
  assert.ok(existsSync(join(maps, 'main.mjs.artifact.json')), 'the build must archive artifact identity and inputs');
  mkdirSync(raw);
  const keys = execFileSync(process.execPath, [bundleTools('./bundle-keys.mjs')], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } }).trim();
  const recorded = {
    NODE_OPTIONS: `--require=${JSON.stringify(bundleTools('./cov-hook.cjs'))}`,
    SPIDER_SELECTION_DIR: raw, SPIDER_SELECTION_ROOT: root, SPIDER_SELECTION_BUNDLE_KEYS: keys,
    SPIDER_SELECTION_TEST: '',
  };
  run(`
    globalThis[Symbol.for('spider.selection.tag')](${JSON.stringify(testFile)});
    const fs = await import('node:fs');
    fs.readFileSync('dist/main.mjs');
    fs.mkdirSync('.spider/scratch', { recursive: true });
    fs.copyFileSync('dist/other.mjs', '.spider/scratch/renamed.mjs');`, recorded);
  run(`
    globalThis[Symbol.for('spider.selection.tag')](${JSON.stringify(aliasTest)});
    await import('./.spider/scratch/renamed.mjs');`, recorded);
  run(`
    globalThis[Symbol.for('spider.selection.tag')](${JSON.stringify(inventoryTest)});
    const fs = await import('node:fs');
    fs.readdirSync('dist');`, recorded);
  const inventory = [testFile, aliasTest, inventoryTest];
  const reportFile = join(root, 'report.json'), output = join(root, 'shard.json');
  writeFileSync(reportFile, JSON.stringify({ testResults: inventory.map(file => (
    { name: resolve(root, file), status: 'passed', startTime: 0, endTime: 1 })) }));
  writeFileSync(output, JSON.stringify(reduce({ root, rawDir: raw, mapsDir: maps, reportFile })));
  execFileSync(process.execPath, [bundleTools('./bundle-observations.mjs'), raw, maps, output],
    { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  const { map, problems } = buildSelectionMap({ shards: [JSON.parse(readFileSync(output, 'utf8'))],
    expectedFiles: inventory, commit: 'a'.repeat(40), runId: '4', createdAt: new Date().toISOString() });
  assert.deepEqual(problems, []);
  const artifacts = map.bundleRouting.artifacts;
  const main = artifacts.find(artifact => artifact.path === 'dist/main.mjs');
  assert.equal(main.entry, entry);
  assert.ok(main.inputs.includes(removed));
  assert.ok(main.inputs.includes('build-options.mjs'));
  const { ambiguous, hashes } = map.bundleRouting.tests[testFile];
  assert.equal(ambiguous, false);
  assert.deepEqual(hashes, artifacts.map(artifact => artifact.sha256).sort());
  assert.deepEqual(map.bundleRouting.tests[aliasTest], {
    ambiguous: false, hashes: [artifacts.find(artifact => artifact.path === 'dist/other.mjs').sha256],
  });
  assert.deepEqual(map.bundleRouting.tests[inventoryTest], { ambiguous: true, hashes });

  const blob = 'b'.repeat(40);
  const options = { head: 'c'.repeat(40), inventory, map, changes: [{ file: removed, status: 'M' }],
    bundleContracts: new Map([[aliasTest, { outputs: ['dist/other.mjs'], blobs: { [aliasTest]: blob } }]]),
    bundleBlobs: () => new Map([[aliasTest, blob]]), artifactDigest: file => bundleDigest(root, file),
  };
  const unchanged = await selectTests(options);
  assert.deepEqual(Object.keys(unchanged.selected), [testFile, inventoryTest]);
  const other = join(root, 'dist/other.mjs');
  writeFileSync(other, 'export const marker = "new";');
  const changed = await selectTests(options);
  assert.deepEqual(Object.keys(changed.selected), [aliasTest, testFile, inventoryTest]);
  rmSync(other);
  symlinkSync('../.spider/scratch/renamed.mjs', other);
  const relocated = await selectTests(options);
  assert.deepEqual(Object.keys(relocated.selected), [aliasTest, testFile, inventoryTest]);
});

test('all test code and fixtures use recorder-aware bundle helpers', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'packages', 'scripts'], { encoding: 'utf8' })
    .split('\0').filter(file => file !== 'scripts/test-fixture-build.ts'
      && /(?:\/(?:__tests__|e2e)\/|\.(?:test|spec|testutil)\.|^scripts\/test-)/.test(file) && /\.[cm]?[jt]sx?$/.test(file));
  const problems = [];
  for (const file of new Set(files)) {
    const source = readFileSync(file, 'utf8');
    if ([...builders.keys()].some(name => source.includes(name))) problems.push(...rawBuilderImports(file, source));
  }
  assert.deepEqual(problems, [], 'Import the builder from scripts/test-fixture-build.ts so its inputs enter the selection map');
});
