import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
  const scratch = resolve('.spider/scratch/intercom-parity'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'case-')); roots.push(root);
  cpSync(resolve('packages/intercom/src'), join(root, 'src'), { recursive: true });
  return join(root, 'src');
}
function check(fork?: string, manifest?: string) {
  return spawnSync(process.execPath, [resolve('scripts/check-intercom-parity.mjs'), '--manifest', ...(fork ? ['--fork-dir', fork] : []), ...(manifest ? ['--manifest-file', manifest] : [])], { encoding: 'utf8' });
}
function mutate(root: string, file: string, before: string, after: string) {
  const path = join(root, file), text = readFileSync(path, 'utf8');
  expect(text).toContain(before);
  writeFileSync(path, text.replace(before, after));
}

it('checks all upstream assertions and runtime files against the committed manifest', () => {
  const result = check();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/15 test files/);
}, 5000);

it('rejects a changed assertion even when the assertion count is unchanged', () => {
  const root = fixture();
  mutate(root, 'broker/spawn.test.ts', 'assert.equal(spec.command, "node");', 'assert.equal(spec.command, "not-node");');
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/assertion.*broker\/spawn\.test\.ts/i);
}, 5000);

it('rejects a removed upstream assertion', () => {
  const root = fixture();
  mutate(root, 'broker/spawn.test.ts', 'assert.equal(spec.command, "node");', '');
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/assertion.*broker\/spawn\.test\.ts/i);
}, 5000);

it('rejects a manifest whose source hash does not match the recorded origin', () => {
  const root = fixture(), file = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(resolve('packages/intercom/upstream-assertions.json'), 'utf8'));
  manifest.tests['broker/spawn.test.ts'].sourceSha256 = '0'.repeat(64);
  writeFileSync(file, JSON.stringify(manifest));
  const result = check(root, file);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/provenance.*broker\/spawn\.test\.ts/i);
}, 5000);

it.each([
  ['non-Windows', 'command: getNodeCommand(nodePath),', 'command: nodePath,'],
  ['Windows', 'quoteWindowsArg(getNodeCommand(nodePath)), quoteWindowsArg(brokerPath)', 'quoteWindowsArg(nodePath), quoteWindowsArg(brokerPath)'],
])('rejects a %s broker launch regression', (_platform, before, after) => {
  const root = fixture(); mutate(root, 'broker/spawn.ts', before, after);
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/(?:runtime|implementation).*broker\/spawn\.ts/i);
}, 5000);
