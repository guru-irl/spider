// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHerdrHarness } from './isolated.js';
import { invokeCli } from '../client/cli-transport.js';
import { createAppClient } from '../client/app.js';

it('the fake app exposes focus and directional neighbors after a split', async () => {
  const h = await createHerdrHarness('fake'); await h.start();
  try {
    const owner = h.owner!;
    const app = createAppClient({ binary: h.appBinary, env: h.localEnv });
    const viewer = await h.hc.run({ argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: null, labels: {}, outliveParent: true, background: true, noNotify: true });
    const ownerPane = await app.ownerPlacement(owner.terminal.address);
    expect(await app.command('pane.focus', { pane: ownerPane.pane })).toEqual({});
    expect(await app.focusedPane()).toEqual(ownerPane);
    expect(await app.command('terminal.keep', { terminal: viewer.address, place: 'down' })).toMatchObject({ pending: true });
    const viewerPane = await app.ownerPlacement(viewer.address);
    expect(viewerPane.tab).toBe(ownerPane.tab);
    await app.command('pane.focus', { pane: ownerPane.pane });
    await app.command('pane.go', { direction: 'down' });
    expect(await app.focusedPane()).toEqual(viewerPane);
  } finally { await h.close(); }
  expect(await h.remainingOwnedResources()).toEqual([]);
});

it('the fake app supports an explicitly positioned tab for a parked terminal', async () => {
  const h = await createHerdrHarness('fake'); await h.start();
  try {
    const app = createAppClient({ binary: h.appBinary, env: h.localEnv });
    const owner = await app.ownerPlacement(h.owner!.terminal.address);
    const viewer = await h.hc.run({ argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: null, labels: {}, outliveParent: true, background: true, noNotify: true });
    const other = await app.command('tab.new', { space: owner.space, mod: 'pane' });
    const created = await app.command('tab.new', { space: owner.space, mod: 'pane' });
    expect(other.tab).toBeTruthy(); expect(created.tab).toBeTruthy(); expect(created.pane).toBeTruthy();
    const target = { space: owner.space, tab: created.tab!, pane: created.pane! };
    await h.hc.setLabels(viewer.address, { 'herdr.space': owner.space, 'herdr.tab': target.tab });
    await app.awaitPane(viewer.address, target, { timeoutMs: 1000 });
    await app.command('pane.close', { pane: target.pane });
    await app.command('tab.move', { id: target.tab, index: 2 });
    expect(await app.tabIndex(target)).toBe(2);
    expect((await app.ownerPlacement(viewer.address)).tab).toBe(target.tab);
  } finally { await h.close(); }
  expect(await h.remainingOwnedResources()).toEqual([]);
});

it('the fake app mirrors tab.rename state and replies', async () => {
  const h = await createHerdrHarness('fake');
  const document = join(h.directories.local, 'app.json');
  const env = { ...h.localEnv, HERDR_APP_HOME: h.directories.app };
  try {
    await writeFile(document, JSON.stringify({ spaces: [{ id: 'space', active: true, name: 'Space', tabs: [{ id: 'tab', active: true, name: 'Old', terminals: [] }] }] }));
    expect(await invokeCli(h.appBinary, ['do', 'tab.rename', '--id', 'tab', '--name', '  New title  '], env)).toEqual({ ok: true });
    const listed = await invokeCli(h.appBinary, ['ls'], env) as { spaces: { tabs: { name: string }[] }[] };
    expect(listed.spaces[0].tabs[0].name).toBe('New title');
    expect(JSON.parse(await readFile(document, 'utf8')).spaces[0].tabs[0].name).toBe('New title');
    expect(await invokeCli(h.appBinary, ['do', 'tab.rename', '--name', ''], env)).toEqual({ ok: true });
    expect((await invokeCli(h.appBinary, ['ls'], env) as typeof listed).spaces[0].tabs[0].name).toBe('1');
    expect(await h.app.command('tab.rename', { id: 'missing', name: 'New' })).toEqual({ error: { code: 'app-error', message: 'no tab "missing"' } });
    expect(await h.app.command('tab.rename', { id: 'tab' })).toEqual({ error: { code: 'app-error', message: 'tab.rename needs name (empty: its number)' } });
  } finally { await h.close(); }
  expect(await h.remainingOwnedResources()).toEqual([]);
});
