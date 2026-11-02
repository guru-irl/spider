// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, fixture } from './herdr-setup-fixture.js';
import { writePrivateJson } from '../../../herdr/src/sessions/registry.js';
import { readCutoverRecovery, recordSessionMove } from '../../../herdr/src/spaces/setup.js';
import { createProcessPresence } from '../../../herdr/src/sessions/presence.js';
import { processStartTime } from '../../../subagents/src/process-identity.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function mergedFixture() {
  const f = await fixture(), root = join(f.h.directories.global, 'herdr');
  const targets = [];
  for (let i = 0; i < 3; i++) {
    const file = join(f.h.directories.agent, `sessions/session-${i}.jsonl`);
    await writeFile(file, JSON.stringify({ type: 'session', id: `session-${i}`, cwd: f.h.root }) + '\n');
    targets.push({ file, sessionId: `session-${i}`, cwd: f.h.root, name: `Session ${i}`, spaceName: 'Group', spaceOrder: 0, sessionOrder: i, extensionArguments: [] });
  }
  f.request.config.spaces = [{ name: 'Group', sessions: targets.map(({ file }) => ({ file })) }];
  await writePrivateJson(join(root, 'spaces/spaces.json'), {
    version: 1, focused: true, intents: [], retired: [], spaces: [{ name: 'Group', id: 'group', adopted: false }],
    tabs: targets.map((target, i) => ({ target, placement: { space: 'group', tab: `tab-${i}`, terminal: `terminal-${i}` }, result: null, failure: null })),
  });
  const layoutPath = join(f.h.root, 'merged-layout.json'), closes = join(f.h.root, 'closed-tabs.json');
  const layout = { spaces: [{ id: 'group', name: 'Group', tabs: [{ id: 'tab-0', name: 'Group', terminals: [2, 0, 1].map(i => ({ terminal: `terminal-${i}`, pane: `pane-${i}` })) }] }] };
  await writeFile(layoutPath, JSON.stringify(layout)); await writeFile(closes, '[]');
  const script = join(f.h.root, 'merged-app.mjs'), binary = join(f.h.root, 'merged-app');
  await writeFile(script, `import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), path = ${JSON.stringify(layoutPath)}, closes = ${JSON.stringify(closes)};
const doc = JSON.parse(readFileSync(path, 'utf8'));
if (args[0] === 'ls') console.log(JSON.stringify(doc));
else if (args[1] === 'tab.close') {
  const id = args[args.indexOf('--id') + 1];
  const found = doc.spaces.some(space => space.tabs.some(tab => tab.id === id));
  if (!found) { console.log(JSON.stringify({ error: { code: 'already-closed', message: 'Tab already closed' } })); }
  else {
    const ids = JSON.parse(readFileSync(closes, 'utf8')); ids.push(id); writeFileSync(closes, JSON.stringify(ids));
    for (const space of doc.spaces) space.tabs = space.tabs.filter(tab => tab.id !== id);
    writeFileSync(path, JSON.stringify(doc)); console.log('{}');
  }
} else throw new Error('Unexpected app write ' + args[1]);
`);
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o700 });
  f.request.config.app.binary = binary;
  return { ...f, root, layout, layoutPath, closes, targets };
}

test('production snapshot retains every terminal, and rollback adopts a legacy merge and closes its shared tab once', async () => {
  const f = await mergedFixture(), spaces = f.ports.spacePorts(f.request);
  const snapshot = await spaces.layoutSnapshot();
  expect(snapshot.spaces[0].tabs[0].terminals?.map(row => row.terminal)).toEqual(['terminal-2', 'terminal-0', 'terminal-1']);
  const parts = await f.ports.setupParts(f.request);
  await parts.rollback({ terminals: ['terminal-0', 'terminal-1', 'terminal-2'] as never, identities: {} });
  expect(JSON.parse(await readFile(f.closes, 'utf8'))).toEqual(['tab-0']);
  expect((await readCutoverRecovery(spaces.journalRoot)).entries).toEqual([]);
});

test('rollback preserves the user tab a session moved into', async () => {
  const f = await mergedFixture(), spaces = f.ports.spacePorts(f.request);
  f.layout.spaces[0].tabs[0].terminals = f.layout.spaces[0].tabs[0].terminals.filter(row => row.terminal !== 'terminal-0');
  f.layout.spaces.push({ id: 'user-space', name: 'User space', tabs: [{ id: 'user-tab', name: 'User tab', terminals: [{ terminal: 'shell', pane: 'shell-pane' }, { terminal: 'terminal-0', pane: 'moved-pane' }] }] });
  await writeFile(f.layoutPath, JSON.stringify(f.layout));
  await recordSessionMove(spaces.journalRoot, { sessionId: 'session-0', terminal: 'terminal-0' as never }, () => spaces.layoutSnapshot());
  f.layout.spaces[1].tabs[0].terminals = [{ terminal: 'shell', pane: 'shell-pane' }];
  await writeFile(f.layoutPath, JSON.stringify(f.layout));
  const parts = await f.ports.setupParts(f.request);
  await parts.rollback({ terminals: ['terminal-0', 'terminal-1', 'terminal-2'] as never, identities: {} });
  expect(JSON.parse(await readFile(f.closes, 'utf8'))).toEqual(['tab-0']);
  expect(JSON.parse(await readFile(f.layoutPath, 'utf8')).spaces[1].tabs[0].terminals).toEqual([{ terminal: 'shell', pane: 'shell-pane' }]);
  expect((await readCutoverRecovery(spaces.journalRoot)).entries).toEqual([]);
});

test('a live owner in a non-first pane prevents rollback of the whole shared tab', async () => {
  const f = await mergedFixture();
  await createProcessPresence(f.root).record({ pid: process.pid, startIdentity: processStartTime(process.pid)!, sessionId: 'other' as never, sessionFile: null, sessionName: null, kind: 'top-level', hcAddress: 'terminal-1' as never });
  const parts = await f.ports.setupParts(f.request);
  await expect(parts.rollback({ terminals: ['terminal-0', 'terminal-1', 'terminal-2'] as never, identities: {} })).rejects.toMatchObject({ code: 'cutover-owner-live' });
  expect(JSON.parse(await readFile(f.closes, 'utf8'))).toEqual([]);
});

test('a foreign pane is left alone by adoption and blocks rollback without closing anything', async () => {
  const f = await mergedFixture(), spaces = f.ports.spacePorts(f.request);
  f.layout.spaces[0].tabs[0].terminals.push({ terminal: 'foreign-terminal', pane: 'foreign-pane' });
  await writeFile(f.layoutPath, JSON.stringify(f.layout));
  const before = await readFile(f.layoutPath, 'utf8');
  const recovery = await readCutoverRecovery(spaces.journalRoot, await spaces.layoutSnapshot());
  expect(recovery.entries.map(entry => entry.placement.tab)).toEqual(['tab-0', 'tab-0', 'tab-0']);
  expect(recovery.createdTabs.map(entry => entry.terminal)).toEqual(['terminal-0', 'terminal-1', 'terminal-2']);
  expect(await readFile(f.layoutPath, 'utf8')).toBe(before);
  const parts = await f.ports.setupParts(f.request);
  await expect(parts.rollback({ terminals: ['terminal-0', 'terminal-1', 'terminal-2'] as never, identities: {} })).rejects.toMatchObject({ code: 'cutover-owner-conflict', message: expect.stringMatching(/Group[\s\S]*foreign-terminal[\s\S]*move or close/i) });
  expect(JSON.parse(await readFile(f.closes, 'utf8'))).toEqual([]);
});
