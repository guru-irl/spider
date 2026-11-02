// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppClient } from '../client/app.js';
import { createHcClient } from '../client/hc.js';
import { createClientFixture, createHerdrHarness, terminal } from './testutil.js';

async function fixture() {
  const f = await createClientFixture();
  const owner = terminal('t1'), viewer = { ...terminal('t2'), keep: true, labels: { 'spider.kind': 'remote-observer', 'spider.job': 'job', 'herdr.space': 's1', 'herdr.tab': 'tb1' } };
  await f.configure({ terminals: [owner, viewer] });
  const layout = { spaces: [{ id: 's1', tabs: [{ id: 'tb1', terminals: [{ terminal: 't1', pane: 'p1' }, { terminal: 't2', pane: 'p2' }] }] }] };
  await writeFile(join(f.root, 'app.json'), JSON.stringify(layout));
  return { ...f, owner, viewer, layout, app: createAppClient({ binary: f.appBinary, env: f.localEnv }), hc: createHcClient({ binary: f.hcBinary, env: f.localEnv }) };
}

test('fake terminal.park matches the native pending reply, core events and persistent pane removal', async () => {
  const f = await fixture();
  try {
    const before = await f.app.ownerPlacement(f.address('t1'));
    expect(await f.app.command('terminal.park', { terminal: 't2' })).toEqual({ pending: true, terminal: 't2' });
    await expect(f.app.ownerPlacement(f.address('t2'))).rejects.toMatchObject({ code: 'owner-unplaced' });
    expect(await f.app.ownerPlacement(f.address('t1'))).toEqual(before);
    const state = JSON.parse(await readFile(join(f.root, 'core.json'), 'utf8'));
    expect(state.terminals.find((t: { address: string }) => t.address === 't2')).toMatchObject({ state: 'live', keep: false, labels: { 'spider.kind': 'remote-observer', 'spider.job': 'job' } });
    expect(state.terminals.find((t: { address: string }) => t.address === 't2').labels).not.toHaveProperty('herdr.space');
    expect(state.terminals.find((t: { address: string }) => t.address === 't2').labels).not.toHaveProperty('herdr.tab');
    expect(state.terminals.find((t: { address: string }) => t.address === 't1')).toEqual(f.owner);
    expect(JSON.parse(await readFile(join(f.root, 'app.json'), 'utf8'))).toEqual({ spaces: [{ id: 's1', tabs: [{ id: 'tb1', terminals: [{ terminal: 't1', pane: 'p1' }] }] }] });
    const events = (await readFile(join(f.root, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events).toEqual([
      { jsonrpc: '2.0', method: 'event', params: { type: 'labels', seq: 1, terminal: 't2', data: { labels: { 'spider.kind': 'remote-observer', 'spider.job': 'job' } } } },
      { jsonrpc: '2.0', method: 'event', params: { type: 'keep', seq: 2, terminal: 't2', data: { keep: false } } },
    ]);
    expect((await f.calls()).some(c => ['kill', 'rm'].includes(c.argv[0]))).toBe(false);
  } finally { await f.hc.dispose(); await f.close(); }
});

test('daemon-backed fake app removes a labelled pane without killing its live terminal', async () => {
  const h = await createHerdrHarness('fake');
  try {
    await h.start();
    const app = createAppClient({ binary: h.appBinary!, env: h.localEnv });
    const ownerPlacement = await app.ownerPlacement(h.owner!.terminal.address);
    const viewer = await h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(() => {}, 1000)'], cwd: h.root, parent: null,
      labels: { 'spider.kind': 'remote-observer', 'spider.job': 'job', 'herdr.space': ownerPlacement.space, 'herdr.tab': ownerPlacement.tab }, outliveParent: true, background: true, noNotify: true });
    await app.awaitPane(viewer.address, ownerPlacement, { timeoutMs: 1000 });
    expect(await app.command('terminal.park', { terminal: viewer.address })).toMatchObject({ pending: true, terminal: viewer.address });
    await expect(app.ownerPlacement(viewer.address)).rejects.toMatchObject({ code: 'owner-unplaced' });
    const original = await h.hc.get(viewer.address);
    expect(original.state).toBe('live'); expect(original.labels).not.toHaveProperty('herdr.space'); expect(original.labels).not.toHaveProperty('herdr.tab');
    expect(await app.ownerPlacement(h.owner!.terminal.address)).toEqual(ownerPlacement);
  } finally { await h.close(); }
  expect(await h.remainingOwnedResources()).toEqual([]);
  expect(h.cleanupProof).toMatchObject({ remaining: [], defaultCoreUnchanged: true });
}, 10000);

test('a failed background core change leaves the pane present instead of falsely acknowledging removal', async () => {
  const f = await fixture();
  try {
    await f.configure({ failure: { kind: 'transport_error', message: 'Isolated core unavailable', hint: null } });
    expect(await f.app.command('terminal.park', { terminal: 't2' })).toEqual({ pending: true, terminal: 't2' });
    expect(await f.app.ownerPlacement(f.address('t2'))).toEqual({ space: 's1', tab: 'tb1', pane: 'p2' });
    expect(JSON.parse(await readFile(join(f.root, 'app.json'), 'utf8'))).toEqual(f.layout);
    expect((await readFile(join(f.root, 'app-change-errors.jsonl'), 'utf8'))).toContain('Isolated core unavailable');
  } finally { await f.hc.dispose(); await f.close(); }
});

test('tab inventory reads all panes in the chosen tab and never substitutes another tab', async () => {
  const f = await fixture();
  try {
    const placement = await f.app.ownerPlacement(f.address('t1'));
    expect(await f.app.tabTerminals(placement)).toEqual(['t1', 't2']);
    await f.app.command('terminal.park', { terminal: 't2' });
    expect(await f.app.tabTerminals(placement)).toEqual(['t1']);
    await expect(f.app.tabTerminals({ ...placement, tab: 'missing' as never })).rejects.toMatchObject({ code: 'owner-unplaced' });
  } finally { await f.hc.dispose(); await f.close(); }
});
