// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReplica } from '@spider/db-core/testutil';
import { openDbReadOnly } from '@spider/db-core';
import { mapWorkspace } from '@spider/db-core/roam/repo-map';
import { createHerdrHarness } from '../../../herdr/src/__tests__/isolated.js';
import { createProcessPresence } from '../../../herdr/src/sessions/presence.js';
import { createTerminalRegistry, writePrivateJson } from '../../../herdr/src/sessions/registry.js';
import { withHcOperation } from '../../../herdr/src/client/operation.js';
import { processStartTime } from '../../../subagents/src/process-identity.js';
import type { CoreIdentity, Owner, SessionFeed } from '../../../herdr/src/contracts.js';
import type { PaneTerminalFacts } from '../../../herdr/src/panes/types.js';
import { createSourcePaneFolderPorts, handleRemotePaneRequest, readPaneSourceInventory, resolvePaneSourceOwner, type PaneEndpointPorts, type PaneSourceInventoryPorts } from '../herdr/pane-endpoint.js';

const identity = { coreId: 'core-1', socket: '/home/example/core.sock', sessionNamespace: 'fixture' } as CoreIdentity;
const owner = { sessionId: 'session-1', generation: 'gen-1', terminal: { ...identity, terminalId: 't7', address: 't7' }, cwd: '/home/example/start', sessionFile: '/home/example/session.jsonl', name: 'Old name' } as Owner;
const presence = { version: 1, pid: 7, startIdentity: 'start-1', sessionId: owner.sessionId, sessionFile: owner.sessionFile, sessionName: 'Builder', kind: 'top-level', mode: 'tui', extensionArguments: [], hcAddress: 't7' as Owner['terminal']['address'] } as const;
const feed = { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: 123, owner, lifecycle: 'live', status: { native: 'working', effective: 'working', message: null }, runs: { rows: [{ id: 'run-1', ownerSessionId: 'session-1', name: 'Researcher', status: 'running' }], total: 1, truncated: false }, ipc: { address: '/home/example/private.sock', capabilityFile: '/home/example/capability' }, errors: [{ source: 'feed', message: 'conversation-sentinel' }] } as unknown as SessionFeed;
const facts = { terminal: { address: 't7', parent: null, labels: {}, state: 'live', status: { state: 'working' }, exitCode: null, reason: null, signal: null, finishedAt: null }, currentCwd: '/home/example/work', createdMs: 42, title: 'pi', app: 'pi', status: 'working', identityLabels: {} } as unknown as PaneTerminalFacts;
function source(): PaneSourceInventoryPorts {
  return { identity: async () => identity, listPresence: async () => [presence], listMappings: async () => [{ version: 1, owner, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: '/home/example', extensionArguments: [] } }], probe: async () => ({ kind: 'live', startIdentity: 'start-1' }), readFeed: async () => feed, readTerminal: async () => facts, readConsoles: async () => [], clock: () => 200 };
}
const digest = 'a'.repeat(64);
function endpoint(): PaneEndpointPorts {
  return { protocol: 1, buildDigest: digest, resolveOwner: vi.fn(async () => owner), listRows: vi.fn(async cursor => readPaneSourceInventory(cursor, source())), locateFolder: vi.fn(), resolveFolder: vi.fn(), launchViewer: vi.fn(), renewViewers: vi.fn(), stopViewer: vi.fn(), openConsole: vi.fn(), closeSession: vi.fn() };
}
test('hand started box agent is discovered by actual session name', async () => {
  const page = await readPaneSourceInventory(null, source());
  expect(page.rows[0]).toMatchObject({ name: 'Builder', machineKey: 'core-1', target: { address: 'core-1/t7', cwd: '/home/example/work' } });
  expect(page.rows[0].children).toEqual([{ runId: 'run-1', name: 'Researcher', status: 'running' }]);
  expect(page.complete).toBe(true);
  expect(JSON.stringify(page)).not.toMatch(/capabilityFile|private\.sock|conversation-sentinel/);
});
test('a session with no source status is not reported as working', async () => {
  const p = source(); p.readFeed = async () => ({ ...feed, status: { native: null, effective: null, message: null } });
  const page = await readPaneSourceInventory(null, p);
  expect(page.rows[0].status).toBe('unknown');
});
test('bound source console discovery is included without granting a different owner authority', async () => {
  const console = { coreId: 'core-2', terminalId: 't8', address: 'core-2/t8', createdMs: 43, identityLabels: {}, alias: 'box-2.invalid', machineId: 'machine-2', kind: 'console', sessionId: owner.sessionId, generation: owner.generation, homeEpoch: null, runId: null, consoleId: 'console-' + '1'.repeat(64), name: 'Console', cwd: null } as unknown as import('../../../herdr/src/panes/types.js').PaneTarget;
  const p = source(); p.readConsoles = async () => [{ consoleId: console.consoleId!, machineKey: 'box-2.invalid', name: console.name, target: console }];
  const page = await readPaneSourceInventory(null, p);
  expect(page.complete).toBe(true); expect(page.rows[0].consoles).toEqual([{ consoleId: console.consoleId, machineKey: 'box-2.invalid', name: console.name, target: console }]);
  p.readConsoles = async () => [{ consoleId: console.consoleId!, machineKey: 'box-2.invalid', name: console.name, target: { ...console, sessionId: 'other' as Owner['sessionId'] } }];
  const bad = await readPaneSourceInventory(null, p);
  expect(bad.complete).toBe(false); expect(bad.rows).toEqual([]);
});
test('unavailable console discovery keeps the inventory incomplete', async () => {
  const p = { ...source(), readConsoles: async () => null };
  const page = await readPaneSourceInventory(null, p);
  expect(page.rows[0].name).toBe('Builder'); expect(page.complete).toBe(false);
});
test('plain SSH session is listed but cannot move without hc terminal', async () => {
  const p = source(); p.listPresence = async () => [{ ...presence, hcAddress: null }];
  const page = await readPaneSourceInventory(null, p);
  expect(page.rows[0]).toMatchObject({ name: 'Builder', machineKey: 'core-1', generation: null, owner: null, target: null, status: 'unknown', unavailableReason: 'not-in-hc', children: [], consoles: [] });
});
test('remote list excludes stale owner and proxy duplicates', async () => {
  const p = source(); p.listMappings = async () => [{ version: 1, owner: { ...owner, generation: 'old' as Owner['generation'] }, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: '/home/example', extensionArguments: [] } }];
  const page = await readPaneSourceInventory(null, p);
  expect(page.rows).toEqual([]); expect(page.complete).toBe(false);
});
test('a process that exits during discovery grants no target authority', async () => {
  const p = source(); p.probe = vi.fn().mockResolvedValueOnce({ kind: 'live', startIdentity: 'start-1' }).mockResolvedValue({ kind: 'absent' });
  const page = await readPaneSourceInventory(null, p);
  expect(page.complete).toBe(false); expect(page.rows).toEqual([]);
});
test('a source core that changes during discovery invalidates the page', async () => {
  const p = source(); p.identity = vi.fn().mockResolvedValueOnce(identity).mockResolvedValue({ ...identity, coreId: 'core-new' });
  await expect(readPaneSourceInventory(null, p)).rejects.toThrow();
});
test('malformed presence identity never reaches a source feed lookup', async () => {
  const p = source(); p.listPresence = async () => [{ ...presence, sessionId: '../outside' as Owner['sessionId'] }];
  p.listMappings = async () => [{ version: 1, owner: { ...owner, sessionId: '../outside' as Owner['sessionId'] }, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: '/home/example', extensionArguments: [] } }];
  p.readFeed = vi.fn(async () => feed);
  const page = await readPaneSourceInventory(null, p);
  expect(page.complete).toBe(false); expect(page.rows).toEqual([]); expect(p.readFeed).not.toHaveBeenCalled();
});
test('duplicate live session identities cannot grant authority', async () => {
  const p = source(); p.listPresence = async () => [presence, { ...presence, pid: 8 }];
  const page = await readPaneSourceInventory(null, p);
  expect(page.rows).toEqual([]); expect(page.complete).toBe(false);
});
test('inventory is paged and body free', async () => {
  const p = source(); p.listPresence = async () => Array.from({ length: 270 }, (_, i) => ({ ...presence, pid: i + 1, sessionId: `session-${String(i).padStart(3, '0')}` as Owner['sessionId'], hcAddress: null }));
  const first = await readPaneSourceInventory(null, p);
  expect(first.rows.length).toBeLessThanOrEqual(256); expect(first.next).not.toBeNull();
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(1024 * 1024);
  const second = await readPaneSourceInventory(first.next, p);
  expect(first.rows.length + second.rows.length).toBe(270); expect(second.next).toBeNull();
  await expect(readPaneSourceInventory('broken', p)).rejects.toThrow();
});
test('endpoint handshake rejects incompatible build', async () => {
  const p = endpoint();
  await expect(handleRemotePaneRequest({ version: 1, op: 'handshake', protocol: 1, buildDigest: 'b'.repeat(64) }, p)).rejects.toThrow();
  expect(p.listRows).not.toHaveBeenCalled();
  expect(await handleRemotePaneRequest({ version: 1, op: 'handshake', protocol: 1, buildDigest: digest }, p)).toEqual({ version: 1, op: 'handshake', protocol: 1, buildDigest: digest });
});
test('source owner checks reuse one inventory but recheck the live feed and process', async () => {
  const p = source(); p.readTerminal = vi.fn(p.readTerminal); p.listPresence = vi.fn(p.listPresence);
  let current = feed;
  p.readFeed = async () => current;
  await withHcOperation(async () => {
    expect((await readPaneSourceInventory(null, p)).rows).toHaveLength(1);
    expect(await resolvePaneSourceOwner(owner.sessionId, owner.generation, p)).toEqual(owner);
    expect(await resolvePaneSourceOwner(owner.sessionId, owner.generation, p)).toEqual(owner);
    expect(p.readTerminal).toHaveBeenCalledTimes(1);
    expect(p.listPresence).toHaveBeenCalledTimes(1);
    current = { ...feed, generation: 'changed-generation' as Owner['generation'] };
    await expect(resolvePaneSourceOwner(owner.sessionId, owner.generation, p)).rejects.toThrow();
    current = feed; p.probe = async () => ({ kind: 'absent' });
    await expect(resolvePaneSourceOwner(owner.sessionId, owner.generation, p)).rejects.toThrow();
  });
});
test('production source reads verified private presence mapping and feed without app calls', async () => {
  const h = await createHerdrHarness('fake');
  try {
    await h.start(); const root = h.directories.global, sessionOwner = { ...h.owner!, name: 'Old name' };
    await mkdir(join(root, 'herdr'), { recursive: true });
    await writeFile(join(root, 'herdr/config.json'), JSON.stringify({ mode: 'core-only', core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, globalRoot: root, agentDirectory: h.directories.agent, shellRc: join(h.root, 'shellrc'), machines: [] }));
    const sourceRoot = join(root, 'herdr'), startIdentity = processStartTime(process.pid)!;
    await createProcessPresence(sourceRoot).record({ pid: process.pid, startIdentity, sessionId: sessionOwner.sessionId, sessionFile: null, sessionName: 'Builder', kind: 'top-level', hcAddress: sessionOwner.terminal.address });
    await createTerminalRegistry(sourceRoot).record({ owner: sessionOwner, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: h.directories.agent, extensionArguments: [] } });
    const fullFeed: SessionFeed = { version: 1, sessionId: sessionOwner.sessionId, generation: sessionOwner.generation, revision: 1, updatedAt: Date.now(), owner: sessionOwner, placement: null, lifecycle: 'live', status: { native: 'working', effective: 'working', message: null }, runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], pace: { scope: 'session', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: null }, approvals: [], notifications: [], ipc: null, errors: [] };
    const feedPath = join(sourceRoot, 'sessions', sessionOwner.sessionId, 'session.json');
    await writePrivateJson(feedPath, fullFeed);
    const address = `${sessionOwner.terminal.coreId}/${sessionOwner.terminal.terminalId}`;
    await h.scenario({ steps: [{ argvPrefix: ['get', address], reply: { address, parent: null, labels: {}, state: 'live', status: { state: 'working' }, exit_code: null, reason: null, signal: null, finished_ms: null, created_ms: 42, title: 'pi', app: 'pi', foreground: { cwd: '/home/example/work' } } }] });
    const { createProductionPaneEndpointPorts } = await import('../herdr/bin/pane-endpoint.js');
    const ports = createProductionPaneEndpointPorts(digest, { ...h.localEnv, SPIDER_GLOBAL_ROOT: root });
    const before = h.mutations().length;
    const page = await ports.listRows(null);
    expect(page.rows[0]).toMatchObject({ name: 'Builder', target: { address, cwd: '/home/example/work' } });
    expect(page.complete).toBe(true); expect(h.mutations()).toHaveLength(before);
    await writeFile(feedPath, '{');
    const truncated = await ports.listRows(null);
    expect(truncated.complete).toBe(false); expect(truncated.rows).toEqual([]);
  } finally { await h.close(); }
});
test('JSON entry rejects malformed input before source effects', async () => {
  const { runPaneEndpointCli } = await import('../herdr/bin/pane-endpoint.js');
  const factory = vi.fn(async () => endpoint());
  await expect(runPaneEndpointCli(['--json', '{'], factory)).rejects.toThrow();
  await expect(runPaneEndpointCli(['--json', JSON.stringify({ version: 1, op: 'list', cursor: null, extra: true })], factory)).rejects.toThrow();
  expect(factory).not.toHaveBeenCalled();
  const output = await runPaneEndpointCli(['--json', JSON.stringify({ version: 1, op: 'handshake', protocol: 1, buildDigest: digest })], factory);
  expect(JSON.parse(output)).toEqual({ version: 1, op: 'handshake', protocol: 1, buildDigest: digest });
});
test('folder endpoint distinguishes absent missing mapped and unavailable', async () => {
  const p = endpoint();
  vi.mocked(p.locateFolder).mockResolvedValueOnce({ repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' }).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'));
  const locate = { version: 1, op: 'locate-folder', cwd: '/home/example/work/src' } as const;
  expect(await handleRemotePaneRequest(locate, p)).toEqual({ version: 1, op: 'locate-folder', folder: { repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' }, unavailable: false });
  expect(await handleRemotePaneRequest(locate, p)).toEqual({ version: 1, op: 'locate-folder', folder: null, unavailable: false });
  expect(await handleRemotePaneRequest(locate, p)).toEqual({ version: 1, op: 'locate-folder', folder: null, unavailable: true });
  const resolve = { version: 1, op: 'resolve-folder', repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' } as const;
  vi.mocked(p.resolveFolder).mockResolvedValueOnce({ cwd: null, exists: null }).mockResolvedValueOnce({ cwd: '/home/example/src', exists: false }).mockResolvedValueOnce({ cwd: '/home/example/src', exists: true }).mockRejectedValueOnce(new Error('offline'));
  for (const result of [{ status: 'no-mapping', cwd: null, exists: null }, { status: 'missing', cwd: '/home/example/src', exists: false }, { status: 'mapped', cwd: '/home/example/src', exists: true }, { status: 'unavailable', cwd: null, exists: null }]) expect(await handleRemotePaneRequest(resolve, p)).toEqual({ version: 1, op: 'resolve-folder', result });
});
test('endpoint reads the existing workspace adapter through injected ports', async () => {
  const fixture = createReplica('global', '11111111-1111-4111-8111-111111111111');
  try {
    const root = join(fixture.root, 'checkout'), cwd = join(root, 'src'); await mkdir(cwd, { recursive: true });
    await mapWorkspace(fixture.db, { repoKey: 'repo-1', workspaceId: 'workspace-1', path: root });
    const folders = createSourcePaneFolderPorts(() => openDbReadOnly(fixture.db.raw.name));
    const ports: PaneEndpointPorts = { ...endpoint(), ...folders };
    expect(await handleRemotePaneRequest({ version: 1, op: 'locate-folder', cwd }, ports)).toEqual({ version: 1, op: 'locate-folder', folder: { repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' }, unavailable: false });
    expect(await handleRemotePaneRequest({ version: 1, op: 'resolve-folder', repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' }, ports)).toEqual({ version: 1, op: 'resolve-folder', result: { status: 'mapped', cwd, exists: true } });
  } finally { fixture.close(); }
});
test('endpoint resolves capabilities only on its source', async () => {
  const p = endpoint(); vi.mocked(p.launchViewer).mockResolvedValue(null);
  const request = { version: 1, op: 'launch-viewer', sessionId: owner.sessionId, generation: owner.generation, runId: 'run-1' as never, leaseId: 'lease-1' } as const;
  expect(await handleRemotePaneRequest(request, p)).toEqual({ version: 1, op: 'launch-viewer', target: null });
  expect(p.resolveOwner).toHaveBeenCalledWith(owner.sessionId, owner.generation);
  expect(p.launchViewer).toHaveBeenCalledWith(owner, request);
  vi.mocked(p.resolveOwner).mockResolvedValueOnce({ ...owner, generation: 'stale' as Owner['generation'] });
  await expect(handleRemotePaneRequest(request, p)).rejects.toThrow();
  expect(p.launchViewer).toHaveBeenCalledTimes(1);
});
