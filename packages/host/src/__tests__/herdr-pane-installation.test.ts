// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { PANE_ENDPOINT_BOOTSTRAP, stagePaneEndpointInstallation, recordPaneInstallation, probeLocalPaneEndpoint } from '../herdr/pane-installation.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(protocol = 1, reportedDigest?: string) {
  const base = resolve('.spider/scratch/pane-installation-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'source-')); roots.push(root);
  const packageRoot = join(root, 'package'), registry = join(root, 'herdr/installation.json'), marker = join(root, 'effects');
  await mkdir(join(root, 'herdr'), { mode: 0o700 }); await mkdir(join(packageRoot, 'dist/herdr'), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`import{appendFileSync}from'node:fs';export const createProductionPaneEndpointPorts=()=>({protocol:${protocol},buildDigest:DIGEST});export const runPaneEndpointCli=async(args,create)=>{const p=await create(),r=JSON.parse(args[1]);if(r.op==='handshake')return JSON.stringify({version:1,op:'handshake',protocol:p.protocol,buildDigest:p.buildDigest});appendFileSync(${JSON.stringify(marker)},'effect');return JSON.stringify({version:1,op:'renew-viewers',renewed:[]})};`);
  // Digest is supplied to the production factory, not embedded in its own bytes.
  const code = bytes.toString().replace('()=>({protocol:', '(digest)=>({protocol:').replace('buildDigest:DIGEST', reportedDigest ? `buildDigest:${JSON.stringify(reportedDigest)}` : 'buildDigest:digest');
  await writeFile(join(packageRoot, 'dist/herdr/pane-endpoint.mjs'), code, { mode: 0o600 });
  await writeFile(registry, JSON.stringify({ version: 1, packageRoot }), { mode: 0o600 });
  const digest = createHash('sha256').update(code).digest('hex');
  await writeFile(join(packageRoot, 'dist/herdr', `pane-endpoint-${digest}.mjs`), code, { mode: 0o600 });
  await writeFile(registry, JSON.stringify({ version: 1, packageRoot, endpoint: { file: `pane-endpoint-${digest}.mjs`, digest, protocol: 1 } }), { mode: 0o600 });
  const run = (wanted = digest, expectedProtocol = 1) => spawnSync(process.execPath, ['-e', PANE_ENDPOINT_BOOTSTRAP, wanted, String(expectedProtocol), JSON.stringify({ version: 1, op: 'renew-viewers', leases: [] })], { env: { ...process.env, SPIDER_GLOBAL_ROOT: root }, encoding: 'utf8', timeout: 5000 });
  return { root, packageRoot, registry, marker, digest, run };
}
test('installed endpoint checks digest and protocol before source action', async () => {
  const f = await fixture(); const reply = f.run(); expect(reply.status).toBe(0); expect(JSON.parse(reply.stdout).op).toBe('renew-viewers'); expect(await readFile(f.marker, 'utf8')).toBe('effect');
});
test.each(['missing-registry', 'missing-root', 'missing-endpoint', 'unsafe-registry', 'unsafe-root', 'digest', 'protocol'])('installed endpoint %s refuses without effects', async failure => {
  const f = await fixture(failure === 'protocol' ? 2 : 1);
  if (failure === 'missing-registry') await rm(f.registry);
  if (failure === 'missing-root') await rm(f.packageRoot, { recursive: true });
  if (failure === 'missing-endpoint') await rm(join(f.packageRoot, 'dist/herdr/pane-endpoint.mjs'));
  if (failure === 'unsafe-registry') await chmod(f.registry, 0o644);
  if (failure === 'unsafe-root') {
    // The system root exists but is not owned by the interactive user.
    if (process.getuid?.() === 0) { await chmod(f.packageRoot, 0o777); } else await writeFile(f.registry, JSON.stringify({ version: 1, packageRoot: '/' }));
  }
  const reply = f.run(failure === 'digest' ? 'f'.repeat(64) : f.digest);
  expect(reply.status).toBe(1); expect(reply.stderr).toMatch(/pane-(installation-(missing|unsafe)|endpoint-(build|protocol)-mismatch)/);
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('explicit local setup stages from its owned installation and records a verified private digest', async () => {
  const f = await fixture(), staged = join(f.packageRoot, 'dist/herdr', `pane-endpoint-${f.digest}.mjs`);
  await rm(staged); await writeFile(f.registry, JSON.stringify({ version: 1, packageRoot: f.packageRoot }), { mode: 0o600 });
  const writes = await stagePaneEndpointInstallation(f.root, f.packageRoot);
  expect(writes).toContain(staged); expect(await readFile(staged)).toEqual(await readFile(join(f.packageRoot, 'dist/herdr/pane-endpoint.mjs')));
  const registry = JSON.parse(await readFile(f.registry, 'utf8')); expect(registry.endpoint).toEqual({ file: `pane-endpoint-${f.digest}.mjs`, digest: f.digest, protocol: 1 });
  await expect((await import('node:fs/promises')).stat(f.registry).then(s => s.mode & 0o777)).resolves.toBe(0o600);
  expect(await stagePaneEndpointInstallation(f.root, f.packageRoot)).toEqual([]);
  expect(await readFile(f.marker).catch(() => null)).toBeNull();
  await writeFile(staged, 'tampered'); await expect(stagePaneEndpointInstallation(f.root, f.packageRoot)).rejects.toMatchObject({ code: 'pane-endpoint-build-mismatch' });
});

test('local installation probe handshakes without source effects or registry writes', async () => {
  const f = await fixture(), before = await readFile(f.registry);
  await probeLocalPaneEndpoint(f.root, f.packageRoot);
  expect(await readFile(f.registry)).toEqual(before); expect(await readFile(f.marker).catch(() => null)).toBeNull();
});

test('concurrent explicit setup and activation preserve the verified endpoint registration', async () => {
  const f = await fixture(), staged = join(f.packageRoot, 'dist/herdr', `pane-endpoint-${f.digest}.mjs`); await rm(staged);
  await writeFile(f.registry, JSON.stringify({ version: 1, packageRoot: f.packageRoot }), { mode: 0o600 });
  await Promise.all([stagePaneEndpointInstallation(f.root, f.packageRoot), stagePaneEndpointInstallation(f.root, f.packageRoot), ...Array.from({ length: 4 }, () => recordPaneInstallation(f.root, f.packageRoot))]);
  expect(JSON.parse(await readFile(f.registry, 'utf8')).endpoint.digest).toBe(f.digest); expect(await stagePaneEndpointInstallation(f.root, f.packageRoot)).toEqual([]);
});
test('explicit setup refuses an unsafe registry before copying an endpoint', async () => {
  const f = await fixture(), staged = join(f.packageRoot, 'dist/herdr', `pane-endpoint-${f.digest}.mjs`); await rm(staged); await chmod(f.registry, 0o644);
  await expect(stagePaneEndpointInstallation(f.root, f.packageRoot)).rejects.toMatchObject({ code: 'pane-installation-unsafe' });
  await expect(readFile(staged)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('explicit setup names an unsafe private registry directory without following it', async () => {
  const f = await fixture(), { rename, symlink } = await import('node:fs/promises'), root = join(f.root, 'herdr'), moved = join(f.root, 'retained-herdr');
  const staged = join(f.packageRoot, 'dist/herdr', `pane-endpoint-${f.digest}.mjs`); await rm(staged); await rename(root, moved); await symlink(moved, root);
  await expect(stagePaneEndpointInstallation(f.root, f.packageRoot)).rejects.toMatchObject({ code: 'pane-installation-unsafe' });
  await expect(readFile(staged)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('source refuses a factory build mismatch before any request effect', async () => {
  const f = await fixture(1, 'd'.repeat(64)), result = f.run();
  expect(result.status).toBe(1); expect(result.stderr).toContain('pane-endpoint-build-mismatch'); expect(await readFile(f.marker).catch(() => null)).toBeNull();
});
