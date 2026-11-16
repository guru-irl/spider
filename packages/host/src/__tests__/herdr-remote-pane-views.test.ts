// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launchPaneViewer, openPaneConsole, renewPaneViewers, stopPaneViewer, type PaneViewPorts } from '../herdr/pane-views.js';
import { createViewerLauncher } from '../../../herdr/src/viewers/register.js';
import type { Owner, HcClient, HcRunRequest, TerminalAddress, TerminalSummary, RunId, CoreId } from '../../../herdr/src/contracts.js';
import type { PaneTarget } from '../../../herdr/src/panes/types.js';
const runId = 'run-one' as RunId;
async function fixture() {
  const base = resolve('.spider/scratch/source-view-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'f-')); let now = 100000, current = true;
  const owner = { sessionId: 'session-one', generation: 'generation-one', cwd: root, name: 'Writer', sessionFile: null,
    terminal: { coreId: 'box-core', terminalId: 't7', address: 't7', socket: '/fixture/core.sock', sessionNamespace: 'fixture' } } as Owner;
  const launches: HcRunRequest[] = [], killed: TerminalAddress[] = [], terminals = new Map<TerminalAddress, TerminalSummary>();
  const hc: HcClient = {
    identity: async () => ({ coreId: owner.terminal.coreId, socket: '/fixture/core.sock', sessionNamespace: 'fixture' }),
    caller: async () => { throw new Error('No caller lookup'); }, machines: async () => [], read: async () => '',
    setLabels: async () => {}, fileRead: async () => { throw new Error('No remote files'); }, fileWrite: async () => { throw new Error('No remote files'); },
    run: async (request: HcRunRequest) => { launches.push(request); const address = `t${launches.length+7}` as TerminalAddress;
      terminals.set(address, { address, parent: request.parent ?? null, labels: request.labels ?? {}, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null, cols: 80, rows: 24 });
      return { address, coreId: owner.terminal.coreId }; },
    get: async (address: TerminalAddress) => { const terminal = terminals.get(address); if (!terminal) throw new Error('missing'); return terminal; },
    kill: async (address: TerminalAddress) => { killed.push(address); terminals.delete(address); }, rm: async () => {},
    events: () => ({ ready: Promise.resolve(), lookup: async address => terminals.get(address) ?? null, subscribe(listener: Parameters<ReturnType<HcClient['events']>['subscribe']>[0]) { listener({ type: 'snapshot', seq: 1, terminals: [...terminals.values()] }); return () => {}; }, dispose() {} }),
  };
  const readTarget: PaneViewPorts['readTarget'] = async (address, actualOwner, id, consoleId) => {
    const terminal = await hc.get(address);
    return { coreId: owner.terminal.coreId, terminalId: String(address) as PaneTarget['terminalId'], address, createdMs: 100,
      identityLabels: terminal.labels, alias: null, machineId: null, kind: consoleId ? 'console' : 'subagent', sessionId: actualOwner.sessionId,
      generation: actualOwner.generation, homeEpoch: null, runId: id, consoleId, name: 'Child', cwd: root };
  };
  const ports: PaneViewPorts = { leaseRoot: join(root, 'leases'), clock: () => now,
    readOwner: async (session, generation) => current && session === owner.sessionId && generation === owner.generation ? owner : null,
    ownsRun: async (_owner, id) => id === runId,
    viewerLauncher: (actualOwner, file) => createViewerLauncher({ hc, owner: () => current ? owner : null,
      ipcDescriptor: () => ({ version: 1, sessionId: owner.sessionId, generation: owner.generation, address: '/fixture/ipc', capabilityFile: '/fixture/cap' }),
      feedRoot: root, viewerExecutable: '/fixture/viewer.mjs', displayLeaseFile: file, runInfo: async () => ({ status: 'running', steer: 'rpc' }) }),
    readTarget, stopTarget: async target => { await hc.kill(target.address); await hc.rm(target.address); },
  };
  const input = { sessionId: owner.sessionId, generation: owner.generation, runId, leaseId: 'lease-one' };
  return { root, owner, ports, input, hc, launches, killed, terminals, setNow: (value: number) => { now = value; }, stale: () => { current = false; }, close: () => rm(root, { recursive: true, force: true }) };
}
test('core only viewer launch does not request app placement', async () => {
  const f = await fixture();
  try {
    const target = await launchPaneViewer(f.input, f.ports);
    expect(target).toMatchObject({ kind: 'subagent', runId, generation: f.owner.generation });
    expect(f.launches).toHaveLength(1); expect(f.launches[0].argv).toContain('--display-lease');
    expect(f.launches[0].argv).toContain('--generation'); expect(f.launches[0].parent).toBe('t7');
    expect(f.launches[0]).toMatchObject({ background: true, noNotify: true, outliveParent: true });
    expect(f.launches[0].labels?.['spider.steer']).toBe('rpc');
  } finally { await f.close(); }
});
test('concurrent explicit open and lost reply reconcile one source viewer', async () => {
  const f = await fixture();
  try {
    const [first, second] = await Promise.all([launchPaneViewer(f.input, f.ports), launchPaneViewer(f.input, f.ports)]);
    expect(second).toEqual(first); expect(f.launches).toHaveLength(1);
    await stopPaneViewer(f.input.leaseId, f.ports);
    const original = f.ports.readTarget; let lost = true;
    f.ports.readTarget = async (...args) => { if (lost) { lost = false; throw new Error('reply lost'); } return original(...args); };
    await expect(launchPaneViewer({ ...f.input, leaseId: 'lease-two' }, f.ports)).rejects.toThrow('reply lost');
    expect((await launchPaneViewer({ ...f.input, leaseId: 'lease-two' }, f.ports)).runId).toBe(runId);
    expect(f.launches).toHaveLength(2);
  } finally { await f.close(); }
});
test('stale generation refuses view and lease renewal', async () => {
  const f = await fixture();
  try {
    await launchPaneViewer(f.input, f.ports); const before = await readFile(join(f.ports.leaseRoot, 'lease-one.json'), 'utf8'); f.stale(); f.setNow(105000);
    await expect(launchPaneViewer({ ...f.input, leaseId: 'lease-two' }, f.ports)).rejects.toMatchObject({ code: 'wrong-generation' });
    expect((await renewPaneViewers([{ leaseId: f.input.leaseId, generation: f.input.generation }], f.ports)).status).toBe('refused');
    expect(await readFile(join(f.ports.leaseRoot, 'lease-one.json'), 'utf8')).toBe(before);
    expect(f.launches).toHaveLength(1);
  } finally { await f.close(); }
});
test('reopened saved view uses source transcript and a fresh lease', async () => {
  const f = await fixture();
  try {
    const first = await launchPaneViewer(f.input, f.ports); await stopPaneViewer(f.input.leaseId, f.ports);
    expect(f.killed).toEqual([first.address]);
    const reopened = await launchPaneViewer({ ...f.input, leaseId: 'lease-two' }, f.ports);
    expect(reopened.runId).toBe(runId); expect(f.launches[1].argv).toContain(f.root);
    expect(f.launches[1].argv).toContain('--intent'); expect(f.launches[1].argv).toContain('explicit');
  } finally { await f.close(); }
});
test('unowned source run refuses before launch', async () => {
  const f = await fixture();
  try { await expect(launchPaneViewer({ ...f.input, runId: 'foreign-run' as RunId }, f.ports)).rejects.toMatchObject({ code: 'run-not-owned' }); expect(f.launches).toEqual([]); }
  finally { await f.close(); }
});
test('different leases cannot start two live viewers of one source run', async () => {
  const f = await fixture();
  try { await launchPaneViewer(f.input, f.ports);
    await expect(launchPaneViewer({ ...f.input, leaseId: 'lease-two' }, f.ports)).rejects.toMatchObject({ code: 'view-already-leased' });
    expect(f.launches).toHaveLength(1);
  } finally { await f.close(); }
});
test('source installation failure retains uncertain claim and never duplicates a launch', async () => {
  const f = await fixture(); let calls = 0;
  f.ports.viewerLauncher = () => async () => { calls++; throw new Error('runtime missing'); };
  try {
    await expect(launchPaneViewer(f.input, f.ports)).rejects.toThrow('runtime missing');
    await expect(launchPaneViewer(f.input, f.ports)).rejects.toMatchObject({ code: 'view-launch-uncertain' });
    expect(calls).toBe(1);
  } finally { await f.close(); }
});

test('closing a source view deletes its lease and a new view opens in the same generation', async () => {
  const f = await fixture();
  try {
    await launchPaneViewer(f.input, f.ports); await stopPaneViewer(f.input.leaseId, f.ports);
    expect((await readdir(f.ports.leaseRoot)).filter(name => name.endsWith('.json'))).toEqual([]);
    expect(await launchPaneViewer({ ...f.input, leaseId: 'reopened' }, f.ports)).toMatchObject({ generation: f.owner.generation });
    expect(f.launches).toHaveLength(2);
  } finally { await f.close(); }
});
test('a proved absent failed launch deletes its claim so the same lease can retry', async () => {
  const f = await fixture(); const original = f.ports.viewerLauncher; let fail = true;
  f.ports.viewerLauncher = (...args) => { if (!fail) return original(...args); return async () => { fail = false; throw new Error('installation failed'); }; };
  f.ports.recoverTarget = async () => null;
  try {
    await expect(launchPaneViewer(f.input, f.ports)).rejects.toThrow('installation failed');
    expect((await readdir(f.ports.leaseRoot)).filter(name => name.endsWith('.json'))).toEqual([]);
    expect(await launchPaneViewer(f.input, f.ports)).toMatchObject({ runId });
    expect(f.launches).toHaveLength(1);
  } finally { await f.close(); }
});
test('expired uncertain leases do not block a later view and are deleted', async () => {
  const f = await fixture(); const original = f.ports.viewerLauncher;
  f.ports.viewerLauncher = () => async () => { throw new Error('reply lost'); };
  try {
    await expect(launchPaneViewer(f.input, f.ports)).rejects.toThrow('reply lost');
    f.setNow(120001); f.ports.viewerLauncher = original;
    expect(await launchPaneViewer({ ...f.input, leaseId: 'later' }, f.ports)).toMatchObject({ runId });
    expect((await readdir(f.ports.leaseRoot)).filter(name => name.endsWith('.json'))).toEqual(['later.json']);
  } finally { await f.close(); }
});
test('4097 stopped lease files are pruned before the live lease bound is checked', async () => {
  const f = await fixture(); await mkdir(f.ports.leaseRoot, { mode: 0o700 });
  try {
    const stopped = { version: 1, sessionId: f.owner.sessionId, generation: f.owner.generation, runId, consoleId: null, expiresAt: 0, address: null, target: null, state: 'stopped' };
    for (let start = 0; start < 4097; start += 32) await Promise.all(Array.from({ length: Math.min(32, 4097 - start) }, (_, offset) => {
      const leaseId = `stopped-${start + offset}`; return writeFile(join(f.ports.leaseRoot, leaseId + '.json'), JSON.stringify({ ...stopped, leaseId }), { mode: 0o600 });
    }));
    expect(await launchPaneViewer(f.input, f.ports)).toMatchObject({ runId });
    expect((await readdir(f.ports.leaseRoot)).filter(name => name.endsWith('.json'))).toEqual(['lease-one.json']);
  } finally { await f.close(); }
});
test('closed and failed console views can reopen in the same generation', async () => {
  const f = await fixture(), consoleId = ('console-' + 'c'.repeat(64)) as import('../../../herdr/src/contracts.js').ConsoleId;
  const input = { sessionId: f.owner.sessionId, generation: f.owner.generation, machineKey: 'console.invalid', consoleId, leaseId: 'console-lease' };
  let fail = true;
  f.ports.recoverTarget = async () => null;
  f.ports.consoleSource = async () => ({ consoleId, runId: null, launch: async () => {
    if (fail) { fail = false; throw new Error('console unavailable'); }
    return (await f.hc.run({ argv: ['console'], cwd: null, labels: {}, parent: null })).address;
  } });
  try {
    await expect(openPaneConsole(input, f.ports)).rejects.toThrow('console unavailable');
    expect(await openPaneConsole(input, f.ports)).toMatchObject({ kind: 'console', generation: f.owner.generation });
    await stopPaneViewer(input.leaseId, f.ports);
    expect((await readdir(f.ports.leaseRoot)).filter(name => name.endsWith('.json'))).toEqual([]);
    expect(await openPaneConsole({ ...input, leaseId: 'reopened-console' }, f.ports)).toMatchObject({ kind: 'console' });
    expect(f.launches).toHaveLength(2);
  } finally { await f.close(); }
});
test('console open revalidates generation and opaque ID before any source launch', async () => {
  const f = await fixture(), consoleId = ('console-' + 'a'.repeat(64)) as import('../../../herdr/src/contracts.js').ConsoleId;
  let calls = 0;
  f.ports.consoleSource = async () => ({ consoleId, runId: null, launch: async () => { calls++; throw new Error('Must not launch'); } });
  const input = { sessionId: f.owner.sessionId, generation: f.owner.generation, machineKey: 'console.invalid', consoleId, leaseId: 'console-lease' };
  try {
    await expect(openPaneConsole({ ...input, consoleId: ('console-' + 'b'.repeat(64)) as typeof consoleId }, f.ports)).rejects.toMatchObject({ code: 'console-identity-mismatch' });
    await expect(openPaneConsole({ ...input, generation: 'foreign-generation' as typeof input.generation }, f.ports)).rejects.toMatchObject({ code: 'wrong-generation' });
    f.ports.consoleSource = async () => { f.stale(); return { consoleId, runId: null, launch: async () => { calls++; throw new Error('Must not launch'); } }; };
    await expect(openPaneConsole(input, f.ports)).rejects.toMatchObject({ code: 'wrong-generation' });
    expect(calls).toBe(0); expect(f.launches).toEqual([]);
  } finally { await f.close(); }
});
