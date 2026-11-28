// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { readJournal, saveJournal } from '../setup/backup.js';
import { rollbackHerdr } from '../setup/installer.js';
import { writePrivateJson } from '../sessions/registry.js';
import { readCutoverRecovery } from '../spaces/setup.js';
import { fixture, until, realCoreAvailable, registerJournalCrashTests } from './production-cutover-fixture.js';

afterEach(() => vi.unstubAllEnvs());

it('rolls back a hand closure during pending cutover and permits a second rollback', async () => {
  const f = await fixture('fake');
  const spacesRoot = join(f.request.config.globalRoot, 'herdr/spaces');
  try {
    const other = join(f.root, 'second.jsonl');
    await writeFile(other, JSON.stringify({ type: 'session', id: 'second', cwd: f.root }) + '\n');
    const config = { ...f.request.config, layout: 'tabs', spaces: [{ name: 'Selected space', sessions: [{ file: f.file }, { file: other }] }] };
    await writeFile(f.request.configPath, JSON.stringify(config));
    const first = await f.run(['setup-cutover']).result; expect(first.code, first.stderr).toBe(0);
    await f.stopOwners();
    const [closed, remaining] = (await readCutoverRecovery(spacesRoot)).createdTabs;
    await f.h.hc.rm(closed.terminal);
    const file = join(f.root, 'layout.json'), layout = JSON.parse(await readFile(file, 'utf8'));
    layout.spaces[0].tabs = layout.spaces[0].tabs.filter((tab: { id: string }) => tab.id !== closed.tab);
    await writeFile(file, JSON.stringify(layout));
    const journal = await readJournal(f.request.journalRoot);
    journal.cutoverPending = true; journal.verified = false; await saveJournal(f.request.journalRoot, journal);

    for (let attempt = 0; attempt < 2; attempt++) {
      const rolledBack = await f.run(['rollback', '--config', f.request.configPath]).result;
      expect(rolledBack.code, rolledBack.stderr).toBe(0);
      expect(await readJournal(f.request.journalRoot)).toMatchObject({ cutoverPending: false, cutover: null });
      expect((await readCutoverRecovery(spacesRoot)).createdTabs).toEqual([]);
      expect(JSON.parse(await readFile(file, 'utf8')).spaces[0].tabs).toEqual([]);
    }
    expect(await f.h.hc.get(remaining.terminal).catch(error => error.code)).toBe('not_found');
  } finally { await f.h.close(); }
}, 60000);

it('full rollback forgets a marked closure so the next setup opens the selection anew', async () => {
  const f = await fixture('fake');
  const spacesRoot = join(f.request.config.globalRoot, 'herdr/spaces');
  try {
    const first = await f.run(['setup-cutover']).result; expect(first.code, first.stderr).toBe(0);
    await f.stopOwners();
    const [closed] = (await readCutoverRecovery(spacesRoot)).createdTabs;
    await f.h.hc.rm(closed.terminal);
    await writeFile(join(f.root, 'layout.json'), '{"spaces":[]}');
    const notice = 'Session "Selected" was closed by hand, so setup leaves it closed. Remove it from the spaces config or reopen it yourself.';
    for (let attempt = 0; attempt < 2; attempt++) {
      const mark = await f.run(['setup-cutover']).result; expect(mark.code, mark.stderr).toBe(0);
      expect(mark.stderr.split('\n').filter(line => line.includes('closed by hand'))).toEqual([notice]);
    }
    expect((await readCutoverRecovery(spacesRoot)).closedEntries?.map(entry => entry.target.sessionId)).toEqual(['selected']);

    const rolledBack = await f.run(['rollback', '--config', f.request.configPath]).result;
    expect(rolledBack.code, rolledBack.stderr).toBe(0);
    expect((await readCutoverRecovery(spacesRoot)).closedEntries).toBeUndefined();
    await writePrivateJson(f.control, {});
    const next = await f.run(['setup-cutover']).result; expect(next.code, next.stderr).toBe(0);
    expect(next.stderr).not.toContain('closed by hand');
    const [reopened] = (await readCutoverRecovery(spacesRoot)).createdTabs;
    expect(reopened.terminal).not.toBe(closed.terminal);
    expect((await readFile(join(f.root, 'launches.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).sessionId)).toEqual(['selected', 'selected']);
    await f.stopOwners();
  } finally { await f.h.close(); }
}, 60000);
it('refuses rollback after a hand merge without closing the merged tab', async () => {
  const f = await fixture('fake');
  try {
    const other = join(f.root, 'second.jsonl');
    await writeFile(other, JSON.stringify({ type: 'session', id: 'second', cwd: f.root }) + '\n');
    const config = { ...f.request.config, layout: 'tabs', spaces: [{ name: 'Selected space', sessions: [{ file: f.file }, { file: other }] }] };
    await writeFile(f.request.configPath, JSON.stringify(config));
    const first = await f.run(['setup-cutover']).result; expect(first.code, first.stderr).toBe(0);
    await f.stopOwners();
    const file = join(f.root, 'layout.json'), layout = JSON.parse(await readFile(file, 'utf8'));
    const [left, right] = layout.spaces[0].tabs;
    left.terminals.push(...right.terminals); layout.spaces[0].tabs = [left];
    const merged = JSON.stringify(layout); await writeFile(file, merged);

    const result = await f.run(['rollback', '--config', f.request.configPath]).result;
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe('cutover-owner-conflict: A setup session was moved by hand. Close its pane before rollback.');
    expect(await readFile(file, 'utf8')).toBe(merged);
  } finally { await f.h.close(); }
}, 60000);

if (process.env.SPIDER_HERDR_E2E === '1' && !realCoreAvailable) console.warn('Skipping isolated core acceptance: hc is not installed');
for (const mode of ['fake', 'hc'] as const) {
  const test = mode === 'hc' ? it.skipIf(process.env.SPIDER_HERDR_E2E !== '1' || !realCoreAvailable) : it;
  registerJournalCrashTests(test, mode, ["spaces:4"]);
  test(`Ctrl-C before the first tab permits rollback then setup (${mode})`, async () => {
    const f = await fixture(mode);
    try {
      const ps = join(f.root, 'bin/ps');
      await writeFile(ps, '#!/bin/sh\nif [ "$1" = -U ]; then printf "999 pi pi\\n"; exit 0; fi\nexec /bin/ps "$@"\n');
      const command = f.run(['setup-cutover']); let output = ''; command.child.stderr.on('data', bytes => output += bytes);
      await until(async () => output.includes('/reload in that session'));
      command.child.kill('SIGINT'); const aborted = await command.result; expect(aborted.code).not.toBe(0);
      expect((await readCutoverRecovery(join(f.request.config.globalRoot, 'herdr/spaces'))).createdTabs).toEqual([]);
      expect((await readJournal(f.request.journalRoot)).cutoverPending).toBe(true);
      const rollback = await f.run(['rollback', '--config', f.request.configPath]).result; expect(rollback.code, rollback.stderr).toBe(0);
      await writeFile(ps, '#!/bin/sh\nif [ "$1" = -U ]; then exit 0; fi\nexec /bin/ps "$@"\n');
      const again = await f.run(['setup-cutover']).result; expect(again.code, again.stderr).toBe(0); await f.stopOwners();
    } finally { await f.h.close(); }
    expect(await f.h.remainingOwnedResources()).toEqual([]);
  }, 60000);
  test(`pending cutover with no tab can rollback and set up again (${mode})`, async () => {
    const f = await fixture(mode); vi.stubEnv('PATH', join(f.root, 'bin') + ':' + process.env.PATH);
    const ports = createProductionHerdrCliPorts(f.root, f.h.localEnv);
    try {
      const journal = await readJournal(f.request.journalRoot); journal.cutoverPending = true; await saveJournal(f.request.journalRoot, journal);
      const parts = await ports.setupParts(f.request);
      expect((await parts.preflight(f.request)).cutoverProvedAbsent).toBe(true);
      await rollbackHerdr(f.request, parts);
      expect((await readJournal(f.request.journalRoot)).cutoverPending).toBe(false);
      const result = await f.run(['setup-cutover']).result; expect(result.code, result.stderr).toBe(0);
      await f.stopOwners();
      const rollback = await f.run(['rollback', '--config', f.request.configPath]).result; expect(rollback.code, rollback.stderr).toBe(0);
      expect((await readCutoverRecovery(join(f.request.config.globalRoot, 'herdr/spaces'))).entries).toEqual([]);
      await writePrivateJson(f.control, {});
      const again = await f.run(['setup-cutover']).result; expect(again.code, again.stderr).toBe(0); await f.stopOwners();
    } finally { await ports.dispose(); await f.h.close(); }
    expect(await f.h.remainingOwnedResources()).toEqual([]);
  }, 60000);
}
