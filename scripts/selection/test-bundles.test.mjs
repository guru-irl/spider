// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

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
