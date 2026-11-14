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
  cpSync(resolve('packages/intercom/DIVERGENCE.json'), join(root, 'DIVERGENCE.json'));
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

function declareDivergence(root: string, file: string, upstream: string | null = file) {
  const path = resolve(root, '../DIVERGENCE.json');
  const divergence = JSON.parse(readFileSync(path, 'utf8'));
  const manifest = JSON.parse(readFileSync(resolve('packages/intercom/upstream-assertions.json'), 'utf8'));
  divergence.files.push({ path: file, task: '3.6a', reason: 'Exercise a declared fixture change.', upstreamHash: upstream ? manifest.sources[upstream].sourceSha256 : null });
  writeFileSync(path, JSON.stringify(divergence));
}

it('allows a listed runtime change tied to its upstream hash', () => {
  const root = fixture();
  mutate(root, 'broker/spawn.ts', 'args: [brokerPath],', 'args: [brokerPath, "fixture"],');
  declareDivergence(root, 'broker/spawn.ts');
  const result = check(root);
  expect(result.status, result.stderr).toBe(0);
}, 5000);

it('rejects a stale divergence entry', () => {
  const root = fixture(); declareDivergence(root, 'broker/spawn.ts');
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/stale.*broker\/spawn\.ts/i);
}, 5000);

it('rejects a new unlisted runtime file', () => {
  const root = fixture(); writeFileSync(join(root, 'unlisted.ts'), 'export const fixture = true;');
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/unlisted.*unlisted\.ts/i);
}, 5000);

it('rejects a comment-only change to an unlisted original runtime file', () => {
  const root = fixture(), file = join(root, 'broker/paths.ts');
  writeFileSync(file, readFileSync(file, 'utf8') + '\n// undeclared fixture edit\n');
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/unlisted.*runtime.*broker\/paths\.ts/i);
}, 5000);

it('rejects a declaration whose divergent file is missing', () => {
  const root = fixture(); rmSync(join(root, 'local.ts'));
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/missing.*divergent.*local\.ts/i);
}, 5000);

it('allows a listed new file and refuses a forged upstream hash', () => {
  const root = fixture(); writeFileSync(join(root, 'new-runtime.ts'), 'export const fixture = true;');
  declareDivergence(root, 'new-runtime.ts', null);
  expect(check(root).status).toBe(0);
  const file = resolve(root, '../DIVERGENCE.json'), divergence = JSON.parse(readFileSync(file, 'utf8'));
  divergence.files.find((entry: any) => entry.path === 'local.ts').upstreamHash = '0'.repeat(64);
  writeFileSync(file, JSON.stringify(divergence));
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/upstream.*hash|provenance/i);
}, 5000);

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

it('still rejects changed path expectations after fixture normalization', () => {
  const root = fixture();
  mutate(root, 'broker/paths.test.ts', 'join("/home/fixture", ".pi/agent")', 'join("/home/other", ".pi/agent")');
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/assertion.*broker\/paths\.test\.ts/i);
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
