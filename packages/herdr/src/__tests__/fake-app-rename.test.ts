// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHerdrHarness } from './isolated.js';
import { invokeCli } from '../client/cli-transport.js';

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
