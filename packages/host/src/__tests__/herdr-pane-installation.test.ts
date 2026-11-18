// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import * as installation from '../herdr/pane-installation.js';
import { PANE_ENDPOINT_BOOTSTRAP, stagePaneEndpointInstallation, recordPaneInstallation, probeLocalPaneEndpoint } from '../herdr/pane-installation.js';
import { inspectPaneInstallation } from '../herdr/pane-doctor.js';
import { createRemotePaneInventoryReader } from '../../../herdr/src/panes/inventory.js';
import { createPaneFolderRemoteRequest } from '../herdr/pane-folders.js';
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

test('endpoint planning lists publication paths without writing and recognizes an unchanged installation', async () => {
  const f = await fixture(), staged = join(f.packageRoot, 'dist/herdr', `pane-endpoint-${f.digest}.mjs`);
  await rm(staged); await writeFile(f.registry, JSON.stringify({ version: 1, packageRoot: f.packageRoot }), { mode: 0o600 });
  const before = await readFile(f.registry), info = await stat(f.registry);
  const plan = await installation.planPaneEndpointInstallation?.(f.root, f.packageRoot);
  expect(plan).toEqual({ paths: [staged, f.registry], changed: true });
  expect(await readFile(f.registry)).toEqual(before);
  expect((await stat(f.registry)).ino).toBe(info.ino);
  await expect(readFile(staged)).rejects.toMatchObject({ code: 'ENOENT' });
  await stagePaneEndpointInstallation(f.root, f.packageRoot);
  expect(await installation.planPaneEndpointInstallation(f.root, f.packageRoot)).toEqual({ paths: [staged, f.registry], changed: false });
});

test('local installation probe handshakes without source effects or registry writes', async () => {
  const f = await fixture(), before = await readFile(f.registry);
  await probeLocalPaneEndpoint(f.root, f.packageRoot);
  expect(await readFile(f.registry)).toEqual(before); expect(await readFile(f.marker).catch(() => null)).toBeNull();
});

test('a removed local package is an installation failure rather than an unknown probe', async () => {
  const f = await fixture(); await rm(f.packageRoot, { recursive: true });
  await expect(probeLocalPaneEndpoint(f.root, f.packageRoot)).rejects.toMatchObject({ code: 'pane-installation-missing' });
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

test('setup replaces an earlier package root and digest with the current installation', async () => {
  const previous = await fixture(), current = await fixture();
  const entry = join(current.packageRoot, 'dist/herdr/pane-endpoint.mjs');
  await writeFile(entry, (await readFile(entry, 'utf8')) + '\n// current package\n');
  const digest = createHash('sha256').update(await readFile(entry)).digest('hex');
  await stagePaneEndpointInstallation(previous.root, current.packageRoot);
  expect(JSON.parse(await readFile(previous.registry, 'utf8'))).toEqual({ version: 1, packageRoot: current.packageRoot, endpoint: { file: `pane-endpoint-${digest}.mjs`, digest, protocol: 1 } });
  await probeLocalPaneEndpoint(previous.root, current.packageRoot);
  await expect(probeLocalPaneEndpoint(previous.root, previous.packageRoot)).rejects.toMatchObject({ code: 'pane-endpoint-build-mismatch' });
});
test('a rejected replacement endpoint preserves the previous admitted installation', async () => {
  const previous = await fixture(), rejected = await fixture(2), before = await readFile(previous.registry);
  await expect(stagePaneEndpointInstallation(previous.root, rejected.packageRoot)).rejects.toMatchObject({ code: 'pane-endpoint-protocol-mismatch' });
  expect(await readFile(previous.registry)).toEqual(before);
  await probeLocalPaneEndpoint(previous.root, previous.packageRoot);
});
test('activation can report an unsafe package without throwing or changing admission', async () => {
  const f = await fixture(), before = await readFile(f.registry), failures: unknown[] = [];
  await chmod(f.packageRoot, 0o775);
  await recordPaneInstallation(f.root, f.packageRoot, error => { failures.push(error); });
  expect(failures).toHaveLength(1);
  expect(await readFile(f.registry)).toEqual(before);
  expect(f.run().status).toBe(1);
});
test('doctor gives an executable permission repair for a umask 002 deployment', async () => {
  const f = await fixture(), deployed = join(f.root, "deployed package's files");
  expect(spawnSync(process.execPath, ['-e', 'process.umask(0o002);require("node:fs").mkdirSync(process.argv[1])', deployed]).status).toBe(0);
  expect((await stat(deployed)).mode & 0o777).toBe(0o775);
  await cp(join(f.packageRoot, 'dist'), join(deployed, 'dist'), { recursive: true });
  await chmod(join(deployed, 'dist'), 0o775); await chmod(join(deployed, 'dist/herdr'), 0o775);
  const probe = () => probeLocalPaneEndpoint(f.root, deployed);
  const report = await inspectPaneInstallation('local', probe);
  expect(report.failures[0]?.code).toBe('pane-installation-unsafe');
  expect(report.failures[0]?.repair).toContain('chmod go-w ');
  expect(report.failures[0]?.repair).toContain('dist/herdr');
  const repaired = spawnSync('/bin/sh', ['-c', report.failures[0]!.repair], { encoding: 'utf8' });
  expect(repaired.status, repaired.stderr).toBe(0);
  await stagePaneEndpointInstallation(f.root, deployed);
  expect(await inspectPaneInstallation('local', probe)).toEqual({ failures: [] });
});

test.each(['inventory', 'folder'] as const)('the %s reader checks installation before importing endpoint code', async reader => {
  const f = await fixture(), endpoint = join(f.packageRoot, 'dist/herdr/pane-endpoint.mjs');
  await writeFile(endpoint, `import{writeFileSync as mark}from'node:fs';mark(${JSON.stringify(f.marker)},'imported');\n` + await readFile(endpoint, 'utf8'));
  await rm(f.registry);
  const machine = { key: 'box-1.invalid', alias: 'box-1.invalid', label: 'box-1.invalid', coreId: 'core-1' as never, machineId: null, state: 'connected' as const };
  const ports = { buildDigest: f.digest, resolveMachine: async () => ({ on: 'box-1.invalid', coreId: machine.coreId, nodePath: process.execPath, endpointPath: endpoint }), exec: async (_on: string, argv: readonly string[]) => {
    const result = spawnSync(argv[0], argv.slice(1), { env: { ...process.env, SPIDER_GLOBAL_ROOT: f.root }, encoding: 'buffer', timeout: 5000 });
    if (result.status !== 0) throw new Error('admission refused');
    return result.stdout;
  } };
  if (reader === 'inventory') await expect(createRemotePaneInventoryReader(ports)(machine, null)).rejects.toThrow();
  else await expect(createPaneFolderRemoteRequest(ports)(machine, { version: 1, op: 'locate-folder', cwd: '/home/example' })).rejects.toThrow();
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('source refuses a factory build mismatch before any request effect', async () => {
  const f = await fixture(1, 'd'.repeat(64)), result = f.run();
  expect(result.status).toBe(1); expect(result.stderr).toContain('pane-endpoint-build-mismatch'); expect(await readFile(f.marker).catch(() => null)).toBeNull();
});
