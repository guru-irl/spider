// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { parseHerdrConfig } from '../config.js';
import type { TerminalAddress } from '../contracts.js';
import { createPanePlacementStore } from '../panes/store.js';
import { parsePanePresentation } from '../panes/codec.js';
import { writePrivateJson } from '../sessions/registry.js';
import { readCutoverRecovery, type LayoutSnapshot } from '../spaces/setup.js';
import { createClientFixture, terminal } from './testutil.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function journalFixture() {
  const client = await createClientFixture(); cleanups.push(() => client.close());
  const config = parseHerdrConfig({
    app: { binary: client.appBinary, home: join(client.root, 'app') },
    core: { binary: client.hcBinary, config: join(client.root, 'core.toml') },
    agentDirectory: client.root, globalRoot: client.root, shellRc: join(client.root, 'rc'), spaces: [], machines: [],
  });
  const ports = createProductionHerdrCliPorts(client.root, client.localEnv); cleanups.push(() => ports.dispose());
  const spaces = ports.spacePorts({ config: config as never, configPath: join(client.root, 'config.json'), packageRoot: client.root, journalRoot: join(client.root, 'setup') });
  const file = join(client.root, 'session.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session', id: 'session-1', cwd: client.root }) + '\n');
  const target = { file, sessionId: 'session-1', name: 'Session', cwd: client.root, spaceName: 'Space', spaceOrder: 0, sessionOrder: 0, extensionArguments: [] };
  const result = { pid: 101, startIdentity: 'start-101', sessionId: 'session-1', sessionFile: file, cwd: client.root };
  const journal = { version: 2, focused: true, spaces: [{ name: 'Space', id: 'space-1', adopted: false }], tabs: [{ space: 'space-1', tab: 'tab-1', name: 'Session', sessions: [{ target, terminal: 'core-remote/t7', result, failure: null }] }] };
  const journalPath = join(spaces.journalRoot, 'spaces.json');
  const snapshot = { spaces: [{ id: 'space-1', name: 'Space', tabs: [{ id: 'tab-1', name: 'Session', terminal: 'proxy-1', ownerSessionId: null, terminals: [{ terminal: 'proxy-1', ownerSessionId: null }] }] }] } as LayoutSnapshot;
  const presentation = parsePanePresentation({
    id: 'presentation-1', revision: 1, mode: 'proxy', role: 'agent',
    target: { coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', createdMs: 17, identityLabels: { 'spider.session': 'session-1' }, alias: 'box-1.invalid', machineId: 'machine-1', kind: 'session', sessionId: 'session-1', generation: 'generation-1', homeEpoch: 1, runId: null, consoleId: null, name: 'Session', cwd: client.root },
    proxy: 'proxy-1', slot: { space: 'space-1', tab: 'tab-1', pane: 'pane-1' }, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null,
  });
  const labels = { 'spider.kind': 'pane-proxy', 'spider.pane-id': 'presentation-1', 'spider.target-core': 'core-remote', 'spider.target-terminal': 't7' };
  const store = createPanePlacementStore(join(client.root, 'roam', 'placement'));
  await writePrivateJson(journalPath, journal);
  return { client, spaces, journal, journalPath, snapshot, presentation, labels, store };
}

test('production observes the remote display without changing its execution terminal', async () => {
  const f = await journalFixture();
  await f.client.configure({ terminals: [{ ...terminal('proxy-1'), labels: f.labels }] });
  await f.store.update(state => ({ ...state, presentations: [f.presentation] }));
  const before = await readFile(f.journalPath, 'utf8');
  const recovery = await readCutoverRecovery(f.spaces.journalRoot, f.snapshot, undefined, f.spaces);
  expect(recovery.entries[0].placement.terminal).toBe('core-remote/t7');
  expect(recovery.entries[0].result?.presentationTerminal).toBe('proxy-1');
  expect(recovery.recoveredCutover?.tabs[0].terminal).toBe('core-remote/t7');
  expect(await readFile(f.journalPath, 'utf8')).toBe(before);
  expect((await f.client.calls()).filter(call => ['run', 'kill', 'rm', 'keep'].includes(call.argv[0]))).toEqual([]);
});

test('a local owner stays native even if a proxy record claims its terminal', async () => {
  const f = await journalFixture();
  const local = { ...f.presentation, target: { ...f.presentation.target, coreId: 'local-core', address: 'local-core/t7' } } as never;
  f.journal.tabs[0].sessions[0].terminal = 'local-core/t7';
  await writePrivateJson(f.journalPath, f.journal);
  await f.client.configure({ terminals: [{ ...terminal('proxy-1'), labels: { ...f.labels, 'spider.target-core': 'local-core' } }] });
  await f.store.update(state => ({ ...state, presentations: [local] }));
  const before = (await f.client.calls()).length;
  const recovery = await readCutoverRecovery(f.spaces.journalRoot, f.snapshot, undefined, f.spaces);
  expect(recovery.entries[0].placement.terminal).toBe('local-core/t7');
  expect(recovery.entries[0].result?.presentationTerminal).toBeUndefined();
  expect((await f.client.calls()).slice(before).filter(call => ['run', 'kill', 'rm', 'keep'].includes(call.argv[0]))).toEqual([]);
});

test('journal records the app-observed spelling of a qualified local proxy', async () => {
  const f = await journalFixture();
  await f.client.configure({ terminals: [{ ...terminal('proxy-1'), labels: f.labels }] });
  await f.store.update(state => ({ ...state, presentations: [{ ...f.presentation, proxy: 'local-core/proxy-1' as TerminalAddress }] }));
  const recovery = await readCutoverRecovery(f.spaces.journalRoot, f.snapshot, undefined, f.spaces);
  expect(recovery.entries[0].placement.terminal).toBe('core-remote/t7');
  expect(recovery.entries[0].result?.presentationTerminal).toBe('proxy-1');
});

test('an ambiguous proxy appearing in two tabs is not journalled', async () => {
  const f = await journalFixture();
  await f.client.configure({ terminals: [{ ...terminal('proxy-1'), labels: f.labels }] });
  await f.store.update(state => ({ ...state, presentations: [f.presentation] }));
  f.snapshot.spaces[0].tabs.push({ id: 'tab-2' as never, name: 'Other', terminal: 'proxy-1' as TerminalAddress, ownerSessionId: 'other', terminals: [{ terminal: 'proxy-1' as TerminalAddress, ownerSessionId: 'other' }] });
  const recovery = await readCutoverRecovery(f.spaces.journalRoot, f.snapshot, undefined, f.spaces);
  expect(recovery.entries[0].result?.presentationTerminal).toBeUndefined();
  expect(recovery.entries[0].placement.terminal).toBe('core-remote/t7');
});

test('a vanished proxy is not observed or recreated during journal recovery', async () => {
  const f = await journalFixture();
  await f.client.configure({ terminals: [] });
  await f.store.update(state => ({ ...state, presentations: [f.presentation] }));
  const recovery = await readCutoverRecovery(f.spaces.journalRoot, f.snapshot, undefined, f.spaces);
  expect(recovery.entries[0].placement.terminal).toBe('core-remote/t7');
  expect(recovery.entries[0].result?.presentationTerminal).toBeUndefined();
  expect((await f.client.calls()).filter(call => ['run', 'kill', 'rm', 'keep'].includes(call.argv[0]))).toEqual([]);
});

test('old journal readers see the target and no recorded presentation', async () => {
  const f = await journalFixture();
  for (const version of [1, 2] as const) {
    const old = version === 1 ? { ...f.journal, version, tabs: [{ target: f.journal.tabs[0].sessions[0].target, placement: { space: 'space-1', tab: 'tab-1', terminal: 'core-remote/t7' }, result: f.journal.tabs[0].sessions[0].result, failure: null }] } : f.journal;
    await writePrivateJson(f.journalPath, old);
    const recovery = await readCutoverRecovery(f.spaces.journalRoot);
    expect(recovery.entries[0].placement.terminal).toBe('core-remote/t7');
    expect(recovery.entries[0].result?.presentationTerminal).toBeUndefined();
    expect(Object.hasOwn(recovery.entries[0].result!, 'presentationTerminal')).toBe(false);
  }
});

test('legacy recovery ports need no display observer or core identity', async () => {
  const f = await journalFixture();
  const { processInventory, terminalState, liveSessionFeed } = f.spaces;
  const legacy = { processInventory, terminalState, liveSessionFeed };
  const recovery = await readCutoverRecovery(f.spaces.journalRoot, f.snapshot, undefined, legacy);
  expect(recovery.entries[0].placement.terminal).toBe('core-remote/t7');
  expect(recovery.entries[0].result?.presentationTerminal).toBeUndefined();
  const extended = structuredClone(f.journal);
  extended.tabs[0].sessions[0].result = { ...extended.tabs[0].sessions[0].result, presentationTerminal: 'proxy-1' } as never;
  await writePrivateJson(f.journalPath, extended);
  const oldReader = await readCutoverRecovery(f.spaces.journalRoot, f.snapshot, undefined, legacy);
  expect(oldReader.entries[0].placement.terminal).toBe('core-remote/t7');
  expect(oldReader.entries[0].result).toMatchObject({ pid: 101, startIdentity: 'start-101', sessionId: 'session-1' });
  expect(oldReader.entries[0].result?.presentationTerminal).toBe('proxy-1');
});

test.each([null, '', 42, '../proxy', 'a/b/c'])('malformed presentation address %j is rejected at the journal boundary', async value => {
  const f = await journalFixture();
  f.journal.tabs[0].sessions[0].result = { ...f.journal.tabs[0].sessions[0].result, presentationTerminal: value } as never;
  await writePrivateJson(f.journalPath, f.journal);
  await expect(readCutoverRecovery(f.spaces.journalRoot)).rejects.toMatchObject({ code: 'invalid-space-journal' });
});
