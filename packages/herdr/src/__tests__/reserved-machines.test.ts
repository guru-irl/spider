// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';
import { commandName, normalizeSshHost, parseSshDestinations, shellCommands } from '../ssh/parse.js';

function scanTestSource(file: string, text: string): string[] {
  const failures: string[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const check = (node: ts.Node, name: string) => {
    const host = normalizeSshHost(name);
    // An empty name means the local machine, so it never reaches a remote destination.
    if (name === '') return;
    if (host.endsWith('.invalid')) return;
    // Parser-only syntax coverage uses RFC 3849/5737 documentation networks.
    if (file.endsWith('ssh-policy.test.ts') && (/^2001:db8:/i.test(host) || /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/.test(host))) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    failures.push(`${file}:${line}: unreserved test machine ${name}`);
  };
  const isClockMachine = (node: ts.PropertyAssignment): boolean => {
    if (!ts.isObjectLiteralExpression(node.parent)) return false;
    const owner = node.parent.parent;
    if (ts.isVariableDeclaration(owner) && owner.type?.getText(source) === 'Hlc') return true;
    return ts.isCallExpression(owner) && ['compareHlc', 'observeHlc'].includes(owner.expression.getText(source));
  };
  const walk = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText(source).replace(/^['"]|['"]$/g, '');
      const value = node.initializer;
      const machineSummary = ts.isObjectLiteralExpression(node.parent) && ['id', 'name'].every(required => node.parent.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(source) === required));
      if (machineSummary && ['host', 'target'].includes(key) && ts.isStringLiteral(value) && !value.text.startsWith('/')) check(value, value.text);
      const machineConfig = key === 'name' && ts.isObjectLiteralExpression(node.parent)
        && node.parent.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'runtime');
      const machineProperty = ['machine', 'machineName', 'on', 'spider.machine'].includes(key)
        && !(key === 'machine' && isClockMachine(node));
      if ((machineConfig || machineProperty) && ts.isStringLiteral(value) && value.text !== 'spider.machine') check(value, value.text);
      // Rate-table model aliases are not machine aliases.
      const modelRates = ts.isObjectLiteralExpression(node.parent) && node.parent.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'tiers');
      if (key === 'aliases' && !modelRates && ts.isArrayLiteralExpression(value)) for (const alias of value.elements) if (ts.isStringLiteral(alias)) check(alias, alias.text);
      if (key === 'aliases' && ts.isObjectLiteralExpression(value)) for (const mapping of value.properties) if (ts.isPropertyAssignment(mapping)) {
        check(mapping.name, mapping.name.getText(source).replace(/^['"]|['"]$/g, ''));
        if (ts.isArrayLiteralExpression(mapping.initializer)) for (const alias of mapping.initializer.elements) if (ts.isStringLiteral(alias)) check(alias, alias.text);
      }
    }
    if (ts.isAsExpression(node) && /\bMachineName$/.test(node.type.getText(source)) && ts.isStringLiteral(node.expression)) check(node.expression, node.expression.text);
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && /[/\\]ssh(?:\.exe)?$/i.test(node.arguments[0].text)) {
      failures.push(`${file}: direct absolute SSH executable is forbidden in tests`);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const label of node.text.matchAll(/spider\.machine=([\w.-]+)/g)) check(node, label[1]);
      const parentKey = ts.isPropertyAssignment(node.parent) ? node.parent.name.getText(source) : '';
      const outputAssertion = ts.isCallExpression(node.parent) && ts.isPropertyAccessExpression(node.parent.expression) && node.parent.expression.name.text === 'toBe';
      const testTitle = ts.isCallExpression(node.parent) && node.parent.arguments[0] === node && /^(?:it|test|describe)(?:\.(?:only|skip|todo))?$/.test(node.parent.expression.getText(source));
      if (!testTitle && !['stdout', 'stderr', 'name', 'task', 'text'].includes(parentKey) && !outputAssertion && /\bssh\b/.test(node.text)) {
        let commands: string[][] = [];
        try { commands = shellCommands(node.text); } catch { /* Deliberately malformed parser inputs never execute. */ }
        for (const argv of commands) if (commandName(argv[0]) === 'ssh') {
          for (const route of parseSshDestinations(argv.slice(1))) if (!route.ambiguous) check(node, route.host);
        }
      }
      // Also cover destinations embedded in nested shell/program strings.
      if (!testTitle && !/^git\+ssh:\/\//.test(node.text) && /\b(?:ssh|scp|rsync)\b|sshBinary/.test(node.text)) {
        for (const name of node.text.match(/(?<![\w.-])(?:remote|elsewhere|managed(?:-alias|\.example)?|alias|new-machine|other|host)(?![\w.-])/g) ?? []) check(node, name);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return failures;
}

it('distinguishes clock identities from machine and SSH destinations', () => {
  const text = [
    'const clock: Hlc = { ms: 1, count: 0, stream: "s", machine: "id-1" };',
    'compareHlc({ ...clock, machine: "clock-identity" }, clock);',
    'const destination = { ms: 1, count: 0, stream: "s", machine: "unsafe.example" };',
    'const selection = { on: "unsafe.example" };',
    'const command = "ssh unsafe.example";',
  ].join('\n');
  expect(scanTestSource('fixture.test.ts', text)).toEqual([
    'fixture.test.ts:3: unreserved test machine unsafe.example',
    'fixture.test.ts:4: unreserved test machine unsafe.example',
    'fixture.test.ts:5: unreserved test machine unsafe.example',
  ]);
}, 5000);

it('package test machine names and SSH destinations use reserved domains', async () => {
  const failures: string[] = [];
  const roots = ['packages'];
  for (const root of roots) {
    for (const entry of await readdir(resolve(root), { recursive: true })) {
      if (!/\.(?:ts|mts|js|mjs)$/.test(entry) || !/(?:^|[\\/])__tests__[\\/]|\.(?:test|spec)\./.test(entry)) continue;
      const file = join(root, entry);
      if (file === 'packages/herdr/src/__tests__/reserved-machines.test.ts') continue;
      failures.push(...scanTestSource(file, await readFile(file, 'utf8')));
    }
  }
  expect(failures).toEqual([]);
});
