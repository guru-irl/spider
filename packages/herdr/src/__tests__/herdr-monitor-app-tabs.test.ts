// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppClient } from '../client/app.js';
import { createClientFixture, terminal } from './testutil.js';
import { cleanup } from './herdr-monitor-fixture.js';

it('terminal.keep creates and focuses a named tab without changing the main pane', async () => {
  const f = await createClientFixture(); cleanup(f.close);
  await f.configure({ terminals: [terminal('t1'), { ...terminal('t2'), name: 'job-output', labels: { 'spider.display-name': 'machine.invalid · command' } }] });
  const main = { terminal: 't1', pane: 'main-pane' };
  await writeFile(join(f.root, 'app.json'), JSON.stringify({ spaces: [{ id: 's1', active: true, tabs: [{ id: 'main-tab', active: true, name: 'Main', terminals: [main] }] }] }));
  const app = createAppClient({ binary: f.appBinary, env: f.localEnv });
  const kept = await app.command('terminal.keep', { terminal: 't2', place: 'tab' });
  expect(kept).toMatchObject({ terminal: 't2', pending: true });
  await app.command('tab.rename', { id: kept.tab, name: 'machine.invalid · command' });
  await app.command('pane.focus', { terminal: 't2' });
  const doc = JSON.parse(await readFile(join(f.root, 'app.json'), 'utf8'));
  expect(doc.spaces[0].tabs).toHaveLength(2);
  expect(doc.spaces[0].tabs[0].terminals).toEqual([main]);
  expect(doc.spaces[0].tabs[1]).toMatchObject({ name: 'machine.invalid · command', active: true, terminals: [{ terminal: 't2' }] });
});

it('fake app replies match app 0.1.11 keep, focus and arbitrary-text tab.rename shapes', async () => {
  const f = await createClientFixture(); cleanup(f.close);
  await f.configure({ terminals: [terminal('t1'), { ...terminal('t2'), name: 'job-output' }] });
  await writeFile(join(f.root, 'app.json'), JSON.stringify({ spaces: [{ id: 's1', active: true, tabs: [{ id: 'main-tab', active: true, terminals: [{ terminal: 't1', pane: 'main-pane' }] }] }] }));
  const raw = (name: string, args: string[]) => JSON.parse(execFileSync(f.appBinary, ['do', name, ...args], { env: f.localEnv, encoding: 'utf8' }));
  const kept = raw('terminal.keep', ['--terminal', 't2', '--place', 'tab']);
  expect(kept).toEqual({ pending: true, terminal: 't2', pane: 'pane-t2', tab: 'kept-tab-1' });
  expect(raw('pane.focus', ['--terminal', 't2'])).toEqual({ ok: true });
  expect(raw('terminal.keep', ['--terminal', 't2', '--place', 'tab'])).toEqual({ pane: 'pane-t2' });
  expect(raw('tab.rename', ['--id', kept.tab, '--name', ' Compile routes ⚙ @ box.invalid '])).toEqual({ ok: true });
  expect(JSON.parse(await readFile(join(f.root, 'app.json'), 'utf8')).spaces[0].tabs[1].name).toBe('Compile routes ⚙ @ box.invalid');
});

it('terminal.keep requires a terminal even when the supplied pane exists', async () => {
  const f = await createClientFixture(); cleanup(f.close);
  await writeFile(join(f.root, 'app.json'), JSON.stringify({ spaces: [{ id: 's1', tabs: [{ id: 'tb1', terminals: [{ terminal: 't1', pane: 'main-pane' }] }] }] }));
  const app = createAppClient({ binary: f.appBinary, env: f.localEnv });
  expect(await app.command('terminal.keep', { pane: 'main-pane', place: 'tab' })).toHaveProperty('error');
});

it.each([{ terminal: 't2', place: 'unknown' }, { place: 'tab' }, { terminal: 'absent', place: 'tab' }])('terminal.keep rejects invalid tab placement %j', async args => {
  const f = await createClientFixture(); cleanup(f.close);
  const app = createAppClient({ binary: f.appBinary, env: f.localEnv });
  expect(await app.command('terminal.keep', args)).toHaveProperty('error');
});
