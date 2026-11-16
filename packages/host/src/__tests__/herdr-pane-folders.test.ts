// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createReplica } from '@spider/db-core/testutil';
import { openDbReadOnly } from '@spider/db-core';
import { mapWorkspace } from '@spider/db-core/roam/repo-map';
import type { CoreId } from '../../../herdr/src/contracts.js';
import type { MachineChoice, PaneTarget, RemotePaneRequest } from '../../../herdr/src/panes/types.js';
import { PANE_ENDPOINT_BOOTSTRAP } from '../herdr/pane-installation.js';
import { choosePaneFolder, createPaneFolderMap, createPaneFolderPorts, createPaneFolderRemoteRequest, createSourcePaneFolderPorts, type PaneFolderMapPorts } from '../herdr/pane-folders.js';

const source = { coreId: 'core-1', terminalId: 't7', address: 'core-1/t7', createdMs: 42, identityLabels: {}, alias: 'box-1.invalid', machineId: 'machine-1', kind: 'session', sessionId: 'session-1', generation: 'gen-1', homeEpoch: null, runId: null, consoleId: null, name: 'Builder', cwd: '/home/example/work/src' } as PaneTarget;
const remote: MachineChoice = { key: 'box-2.invalid', alias: 'box-2.invalid', label: 'box-2.invalid', coreId: 'core-2' as CoreId, machineId: 'machine-2', state: 'connected' };
function port(): PaneFolderMapPorts {
  return { locator: vi.fn(async () => ({ repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' })), resolve: vi.fn(async () => '/home/example/checkout/src'), directoryExists: vi.fn(async () => true) };
}
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

test('same machine uses actual foreground cwd', async () => {
  const p = port(); const chosen = { ...remote, coreId: source.coreId, alias: source.alias };
  expect(await choosePaneFolder({ focused: source, chosen }, createPaneFolderMap(p))).toEqual({ cwd: '/home/example/work/src', reason: 'focused' });
  expect(p.locator).not.toHaveBeenCalled();
});
test('different machine uses matching checkout and contained relative cwd', async () => {
  const p = port();
  expect(await choosePaneFolder({ focused: source, chosen: remote }, createPaneFolderMap(p))).toEqual({ cwd: '/home/example/checkout/src', reason: 'mapped' });
  expect(p.resolve).toHaveBeenCalledWith(remote, 'repo-1', 'workspace-1', 'src');
  expect(p.directoryExists).toHaveBeenCalledWith(remote, '/home/example/checkout/src');
});
test('missing or ambiguous mapping uses destination home', async () => {
  const p = port(); vi.mocked(p.locator).mockResolvedValueOnce(null);
  expect(await choosePaneFolder({ focused: source, chosen: remote }, createPaneFolderMap(p))).toEqual({ cwd: null, reason: 'home' });
  vi.mocked(p.resolve).mockResolvedValueOnce(null);
  expect(await choosePaneFolder({ focused: source, chosen: remote }, createPaneFolderMap(p))).toEqual({ cwd: null, reason: 'home' });
  expect(await choosePaneFolder({ focused: null, chosen: remote }, createPaneFolderMap(p))).toEqual({ cwd: null, reason: 'home' });
});
test('removed mapped directory refuses launch rather than using local path', async () => {
  const p = port(); vi.mocked(p.directoryExists).mockResolvedValue(false);
  await expect(choosePaneFolder({ focused: source, chosen: remote }, createPaneFolderMap(p))).rejects.toThrow();
});
test('unavailable mapping and escaping relative cwd refuse', async () => {
  const p = port(); vi.mocked(p.locator).mockRejectedValueOnce(new Error('unavailable'));
  await expect(choosePaneFolder({ focused: source, chosen: remote }, createPaneFolderMap(p))).rejects.toThrow();
  vi.mocked(p.locator).mockResolvedValueOnce({ repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: '../outside' });
  await expect(choosePaneFolder({ focused: source, chosen: remote }, createPaneFolderMap(p))).rejects.toThrow();
  expect(p.resolve).not.toHaveBeenCalled();
});
test('existing workspace mappings supply source locators and destination checks', async () => {
  const f = createReplica('global', '11111111-1111-4111-8111-111111111111'); fixtures.push(f);
  const first = join(f.root, 'checkout-a'), second = join(f.root, 'checkout-b');
  mkdirSync(join(first, 'src'), { recursive: true }); mkdirSync(join(second, 'src'), { recursive: true });
  await mapWorkspace(f.db, { repoKey: 'repo-1', workspaceId: 'workspace-1', path: first });
  await mapWorkspace(f.db, { repoKey: 'repo-1', workspaceId: 'workspace-2', path: second });
  const access = createSourcePaneFolderPorts(() => openDbReadOnly(f.db.raw.name));
  expect(await access.locateFolder(join(first, 'src'))).toEqual({ repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' });
  expect(await access.locateFolder(join(second, 'src'))).toEqual({ repoKey: 'repo-1', workspaceId: 'workspace-2', relativeCwd: 'src' });
  expect(await access.resolveFolder('repo-1', 'workspace-1', 'src')).toEqual({ cwd: join(first, 'src'), exists: true });
  renameSync(join(first, 'src'), join(first, 'renamed'));
  expect(await access.resolveFolder('repo-1', 'workspace-1', 'src')).toEqual({ cwd: join(first, 'src'), exists: false });
  expect(await access.resolveFolder('repo-1', 'missing', 'src')).toEqual({ cwd: null, exists: null });
  mkdirSync(join(f.root, 'outside')); symlinkSync(join(f.root, 'outside'), join(first, 'escape'));
  expect(await access.resolveFolder('repo-1', 'workspace-1', 'escape')).toEqual({ cwd: join(first, 'escape'), exists: false });
  expect(await access.locateFolder(join(first, 'escape'))).toBeNull();
  expect(await access.locateFolder(f.root)).toBeNull();
});
test('nested overlapping mappings are ambiguous rather than guessed', async () => {
  const f = createReplica('global', '11111111-1111-4111-8111-111111111111'); fixtures.push(f);
  const parent = join(f.root, 'parent'), nested = join(parent, 'nested'); mkdirSync(nested, { recursive: true });
  await mapWorkspace(f.db, { repoKey: 'repo-1', workspaceId: 'parent', path: parent });
  await mapWorkspace(f.db, { repoKey: 'repo-1', workspaceId: 'nested', path: nested });
  const access = createSourcePaneFolderPorts(() => openDbReadOnly(f.db.raw.name));
  expect(await access.locateFolder(nested)).toBeNull();
});
test('Windows checkout paths are handled lexically without local filesystem access', async () => {
  const p = port(); vi.mocked(p.resolve).mockResolvedValue('C:\\work\\checkout\\src');
  expect(await choosePaneFolder({ focused: source, chosen: remote }, createPaneFolderMap(p))).toEqual({ cwd: 'C:\\work\\checkout\\src', reason: 'mapped' });
});
test('concurrent folder checks consume only their own resolved entries', async () => {
  const local = { coreId: 'core-2' as CoreId, socket: '/home/example/core.sock', sessionNamespace: 'fixture' };
  const localFolders = { locateFolder: vi.fn(), resolveFolder: vi.fn(async () => ({ cwd: '/home/example/checkout/src', exists: true })) };
  const p = createPaneFolderPorts({ local, localFolders, request: vi.fn() });
  await Promise.all([p.resolve(remote, 'repo-1', 'workspace-1', 'src'), p.resolve(remote, 'repo-1', 'workspace-1', 'src')]);
  expect(await Promise.all([p.directoryExists(remote, '/home/example/checkout/src'), p.directoryExists(remote, '/home/example/checkout/src')])).toEqual([true, true]);
  await expect(p.directoryExists(remote, '/home/example/checkout/src')).rejects.toThrow();
});
test('destination disappearance between mapping and verification refuses', async () => {
  const local = { coreId: 'core-local' as CoreId, socket: '/home/example/core.sock', sessionNamespace: 'fixture' };
  let calls = 0;
  const request = vi.fn(async (_identity: unknown, input: { op: string }) => input.op === 'locate-folder'
    ? { version: 1, op: 'locate-folder', folder: { repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' }, unavailable: false }
    : { version: 1, op: 'resolve-folder', result: ++calls === 1 ? { status: 'mapped', cwd: '/home/example/checkout/src', exists: true } : { status: 'missing', cwd: '/home/example/checkout/src', exists: false } });
  const p = createPaneFolderPorts({ local, localFolders: { locateFolder: vi.fn(), resolveFolder: vi.fn() }, request });
  await expect(choosePaneFolder({ focused: source, chosen: remote }, createPaneFolderMap(p))).rejects.toThrow();
});
test('remote folder requests use endpoint argv, handshake, and core checks', async () => {
  const digest = 'a'.repeat(64), identity = { coreId: 'core-2' as CoreId, alias: 'box-2.invalid', machineId: 'machine-2' };
  const resolveMachine = vi.fn(async () => ({ on: 'box-2.invalid', coreId: identity.coreId, nodePath: '/usr/bin/node', endpointPath: '/home/example/pane-endpoint.cjs' }));
  const exec = vi.fn(async (_on: string, args: string[]) => {
    const request = JSON.parse(args.at(-1)!);
    return Buffer.from(JSON.stringify(request.op === 'handshake' ? { version: 1, op: 'handshake', protocol: 1, buildDigest: digest } : { version: 1, op: 'resolve-folder', result: { status: 'no-mapping', cwd: null, exists: null } }));
  });
  const request = createPaneFolderRemoteRequest({ exec, resolveMachine, buildDigest: digest });
  expect(await request(identity, { version: 1, op: 'resolve-folder', repoKey: 'https://example.invalid/team/repo.git', workspaceId: 'workspace-1', relativeCwd: 'src' })).toMatchObject({ result: { status: 'no-mapping' } });
  expect(exec).toHaveBeenCalledTimes(2);
  expect(exec.mock.calls[1][0]).toBe('box-2.invalid');
  expect(exec.mock.calls[1][1].slice(0, 3)).toEqual(['/usr/bin/node', '-e', PANE_ENDPOINT_BOOTSTRAP]);
  expect(JSON.parse(exec.mock.calls[1][1].at(-1)!)).toMatchObject({ op: 'resolve-folder', repoKey: 'https://example.invalid/team/repo.git' });
  expect(resolveMachine).toHaveBeenCalledTimes(2);
  resolveMachine.mockResolvedValueOnce({ on: 'box-2.invalid', coreId: 'different-core' as CoreId, nodePath: '/usr/bin/node', endpointPath: '/home/example/pane-endpoint.cjs' });
  await expect(request(identity, { version: 1, op: 'locate-folder', cwd: '/home/example/work' })).rejects.toThrow();
  expect(exec).toHaveBeenCalledTimes(2);
});
test('remote folder reads time out even when identity resolution stalls', async () => {
  const request = createPaneFolderRemoteRequest({ buildDigest: 'a'.repeat(64), timeoutMs: 30, exec: vi.fn(), resolveMachine: () => new Promise(() => {}) });
  await expect(request({ coreId: 'core-2' as CoreId, alias: 'box-2.invalid', machineId: 'machine-2' }, { version: 1, op: 'locate-folder', cwd: '/home/example/work' })).rejects.toThrow(/timed out/);
});
test('oversized endpoint reply is refused before JSON decoding', async () => {
  const request = createPaneFolderRemoteRequest({ buildDigest: 'a'.repeat(64), exec: vi.fn(async () => Buffer.alloc(1024 * 1024 + 1, 0x20)), resolveMachine: vi.fn(async () => ({ on: 'box-2.invalid', coreId: 'core-2' as CoreId, nodePath: '/usr/bin/node', endpointPath: '/home/example/pane-endpoint.cjs' })) });
  await expect(request({ coreId: 'core-2' as CoreId, alias: 'box-2.invalid', machineId: 'machine-2' }, { version: 1, op: 'locate-folder', cwd: '/home/example/work' })).rejects.toThrow(/large/i);
});
test('box to Mac folder mapping reads source locator on box', async () => {
  const local = { coreId: 'core-local' as CoreId, socket: '/home/example/core.sock', sessionNamespace: 'fixture' };
  const chosen = { ...remote, key: 'local', alias: null, coreId: local.coreId, machineId: null };
  const localFolders = { locateFolder: vi.fn(), resolveFolder: vi.fn(async () => ({ cwd: '/home/example/checkout/src', exists: true })) };
  const request = vi.fn(async (_machine: { coreId: CoreId; alias: string | null; machineId: string | null }, _input: RemotePaneRequest) => ({ version: 1, op: 'locate-folder', folder: { repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' }, unavailable: false }));
  const result = await choosePaneFolder({ focused: source, chosen }, createPaneFolderMap(createPaneFolderPorts({ local, localFolders, request })));
  expect(result).toEqual({ cwd: '/home/example/checkout/src', reason: 'mapped' });
  expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0][0]).toMatchObject({ coreId: 'core-1', alias: 'box-1.invalid' });
  expect(localFolders.locateFolder).not.toHaveBeenCalled(); expect(localFolders.resolveFolder).toHaveBeenCalledTimes(2);
});
test('Mac to box resolves destination map on box', async () => {
  const local = { coreId: 'core-local' as CoreId, socket: '/home/example/core.sock', sessionNamespace: 'fixture' };
  const focused = { ...source, coreId: local.coreId, alias: null, machineId: null };
  const localFolders = { locateFolder: vi.fn(async () => ({ repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' })), resolveFolder: vi.fn() };
  const request = vi.fn(async (_machine: { coreId: CoreId; alias: string | null; machineId: string | null }, _input: RemotePaneRequest) => ({ version: 1, op: 'resolve-folder', result: { status: 'mapped', cwd: '/home/example/checkout/src', exists: true } }));
  const result = await choosePaneFolder({ focused, chosen: remote }, createPaneFolderMap(createPaneFolderPorts({ local, localFolders, request })));
  expect(result).toEqual({ cwd: '/home/example/checkout/src', reason: 'mapped' });
  expect(localFolders.locateFolder).toHaveBeenCalledWith(focused.cwd); expect(localFolders.resolveFolder).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(2); expect(request.mock.calls[0][0]).toMatchObject({ coreId: 'core-2', alias: 'box-2.invalid' });
  expect(request.mock.calls[0][1]).toMatchObject({ op: 'resolve-folder', repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' });
});
test('disabled roaming on an ordinary configured machine falls back to home', async () => {
  const local = { coreId: 'core-local' as CoreId, socket: '/home/example/core.sock', sessionNamespace: 'fixture' };
  const folders = createSourcePaneFolderPorts(() => undefined), request = vi.fn();
  const focused = { ...source, coreId: local.coreId, alias: null, machineId: null };
  expect(await choosePaneFolder({ focused, chosen: remote }, createPaneFolderMap(createPaneFolderPorts({ local, localFolders: folders, request })))).toEqual({ cwd: null, reason: 'home' });
  expect(request).not.toHaveBeenCalled();
});
test('a removed mapped directory never reaches the launch callback', async () => {
  const p = port(); vi.mocked(p.directoryExists).mockResolvedValue(false); const launch = vi.fn();
  try { const folder = await choosePaneFolder({ focused: source, chosen: remote }, createPaneFolderMap(p)); await launch(folder); } catch { /* No launch is allowed after folder refusal. */ }
  expect(launch).not.toHaveBeenCalled();
});
test('box to box mapping never probes the Mac filesystem', async () => {
  const local = { coreId: 'core-local' as CoreId, socket: '/home/example/core.sock', sessionNamespace: 'fixture' };
  const locateFolder = vi.fn(), resolveFolder = vi.fn();
  const request = vi.fn(async (identity: { coreId: CoreId }, input: { op: string }) => input.op === 'locate-folder'
    ? { version: 1, op: 'locate-folder', folder: { repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' }, unavailable: false }
    : { version: 1, op: 'resolve-folder', result: { status: 'mapped', cwd: '/home/example/checkout/src', exists: true } });
  const p = createPaneFolderPorts({ local, localFolders: { locateFolder, resolveFolder }, request });
  const result = await choosePaneFolder({ focused: source, chosen: remote }, createPaneFolderMap(p));
  expect(result).toEqual({ cwd: '/home/example/checkout/src', reason: 'mapped' });
  expect(locateFolder).not.toHaveBeenCalled(); expect(resolveFolder).not.toHaveBeenCalled();
  expect(request.mock.calls[0][0].coreId).toBe('core-1'); expect(request.mock.calls[1][0].coreId).toBe('core-2');
  expect(request.mock.calls[1][1]).toMatchObject({ op: 'resolve-folder', repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' });
});
