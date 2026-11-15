import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Reuse the verifier; the manifest gate separately runs its CLI.
const { verifyManifest } = await import(/* @vite-ignore */ pathToFileURL(resolve('scripts/check-intercom-parity.mjs')).href) as {
  verifyManifest: (manifest: unknown, forkRoot: string) => string;
};

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
  try {
    const data = JSON.parse(readFileSync(manifest ?? resolve('packages/intercom/upstream-assertions.json'), 'utf8'));
    return { status: 0, stdout: verifyManifest(data, fork ?? resolve('packages/intercom/src')), stderr: '' };
  } catch (error) {
    return { status: 1, stdout: '', stderr: `Intercom parity: ${error instanceof Error ? error.message : String(error)}` };
  }
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

it('the CLI rejects an unreadable manifest', () => {
  const root = fixture();
  const result = spawnSync(process.execPath, [resolve('scripts/check-intercom-parity.mjs'), '--manifest', '--manifest-file', join(root, 'missing.json')], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Intercom parity:.*ENOENT/);
}, 5000);

it.runIf(process.platform !== 'win32')('runs the CLI through a symlink', () => {
  const root = fixture();
  const link = join(root, 'checker.mjs');
  symlinkSync(resolve('scripts/check-intercom-parity.mjs'), link);
  const result = spawnSync(process.execPath, [link, '--manifest', '--manifest-file', join(root, 'missing.json')], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Intercom parity:.*ENOENT/);
}, 5000);

it('rechecks a file changed after an earlier successful verification', () => {
  const root = fixture();
  expect(check(root).status).toBe(0);
  mutate(root, 'broker/spawn.test.ts', 'assert.equal(spec.command, "node");', 'assert.equal(spec.command, "not-node");');
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/assertion.*broker\/spawn\.test\.ts/i);
}, 5000);

it('rechecks runtime normalization after a changed file is re-hashed', () => {
  const root = fixture();
  expect(check(root).status).toBe(0);
  mutate(root, 'broker/spawn.ts', 'command: getNodeCommand(nodePath),', 'command: nodePath,');
  const manifest = JSON.parse(readFileSync(resolve('packages/intercom/upstream-assertions.json'), 'utf8'));
  manifest.sources['broker/spawn.ts'].adoptedSha256 = createHash('sha256').update(readFileSync(join(root, 'broker/spawn.ts'))).digest('hex');
  const file = join(root, 'manifest.json');
  writeFileSync(file, JSON.stringify(manifest));
  const result = check(root, file);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/runtime mismatch.*broker\/spawn\.ts/i);
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

it('rejects an undeclared local runtime change', () => {
  const root = fixture(), file = join(root, '..', 'DIVERGENCE.json');
  const divergence = JSON.parse(readFileSync(file, 'utf8'));
  divergence.files = divergence.files.filter((entry: { path: string }) => entry.path !== 'local.ts');
  writeFileSync(file, JSON.stringify(divergence));
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/unlisted runtime change.*index\.ts/i);
}, 5000);

it('rejects a divergence with the wrong upstream hash', () => {
  const root = fixture(), file = join(root, '..', 'DIVERGENCE.json');
  const divergence = JSON.parse(readFileSync(file, 'utf8'));
  divergence.files[0].upstreamHash = '0'.repeat(64);
  writeFileSync(file, JSON.stringify(divergence));
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/divergence upstream hash mismatch/i);
}, 5000);

it('rejects a stale divergence for an unchanged upstream file', () => {
  const root = fixture(), file = join(root, '..', 'DIVERGENCE.json');
  const divergence = JSON.parse(readFileSync(file, 'utf8'));
  const manifest = JSON.parse(readFileSync(resolve('packages/intercom/upstream-assertions.json'), 'utf8'));
  divergence.files.push({ path: 'broker/client.ts', task: '0.1', reason: 'Fixture declaration', upstreamHash: manifest.sources['broker/client.ts'].sourceSha256 });
  writeFileSync(file, JSON.stringify(divergence));
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/stale divergence entry.*broker\/client\.ts/i);
}, 5000);

it('rejects an unlisted new runtime file', () => {
  const root = fixture();
  writeFileSync(join(root, 'undeclared.ts'), 'export const fixture = true;');
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/unlisted new runtime file.*undeclared\.ts/i);
}, 5000);

it('still checks the frozen host adapters outside upstream', () => {
  const root = fixture();
  writeFileSync(join(root, 'single-instance.ts'), 'export const fixture = true;');
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/unlisted runtime change.*single-instance\.ts/i);
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
