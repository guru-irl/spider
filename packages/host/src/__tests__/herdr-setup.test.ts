import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal, rootNotesValue } from '../../../herdr/src/setup/backup.js';
import { cleanup, fixture } from './herdr-setup-fixture.js';

// An isolated fixture has no selected pi processes. Do not inventory unrelated host sessions.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

type Fixture = Awaited<ReturnType<typeof fixture>>;
const exists = (path: string) => readFile(path).then(() => true, () => false);
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
async function update(path: string, change: (value: Record<string, unknown>) => void) {
  const value = await exists(path) ? await json(path) : {}; change(value); await writeFile(path, JSON.stringify(value));
}
/** A user edit outside spider's managed part, in every kind of file setup shares with the user. */
async function editEveryKind(f: Fixture) {
  await update(join(f.h.directories.agent, 'settings.json'), s => { s.defaultModel = 'user-choice'; });
  await writeFile(f.request.config.shellRc, (await readFile(f.request.config.shellRc, 'utf8').catch(() => '')) + 'export USER_LATER=1\n');
  await writeFile(f.request.config.core.config, (await readFile(f.request.config.core.config, 'utf8').catch(() => '')) + '\n[custom]\nlater = 42\n');
  await update(join(f.h.directories.app, 'keys.json'), k => { k.global = { 'ctrl-q': 'user.action' }; });
  await update(join(f.h.directories.app, 'settings.json'), s => { s.zoom = 2; });
  await update(join(f.h.directories.global, 'config.json'), c => { c.userChoice = 'keep'; });
}
async function upgradeMods(f: Fixture) {
  const source = join(f.root, 'packages/herdr/assets/mods/spider/main.js');
  await writeFile(source, (await readFile(source, 'utf8')) + '\n// next version\n');
}
async function expectEditsKept(f: Fixture, notesBefore: boolean | null) {
  expect(await json(join(f.h.directories.agent, 'settings.json'))).toEqual({ theme: 'stock', unrelated: true, defaultModel: 'user-choice' });
  expect(await exists(f.request.config.shellRc)).toBe(true);
  const rc = await readFile(f.request.config.shellRc, 'utf8');
  expect(rc).toContain('export USER_LATER=1');
  expect(rc).not.toContain('spider:resume');
  const notes = await readFile(f.request.config.core.config, 'utf8');
  expect(notes).toContain('later = 42');
  expect(rootNotesValue(Buffer.from(notes))).toBe(notesBefore);
  const keys = await json(join(f.h.directories.app, 'keys.json'));
  expect(keys.global).toEqual({ 'ctrl-q': 'user.action' });
  expect(Object.keys(keys.terminal ?? {})).toEqual([]);
  expect(await json(join(f.h.directories.app, 'settings.json'))).toEqual({ zoom: 2, theme: 'stock' });
  const global = await json(join(f.h.directories.global, 'config.json'));
  expect(global.userChoice).toBe('keep');
  expect(global['herdr.config']).toBeUndefined();
  for (const created of [join(f.h.directories.app, 'mods/spider-panel/main.js'), join(f.h.directories.global, 'herdr/resume.sh'), join(f.h.directories.agent, 'themes/dracula-plus-glass.json')])
    expect(await exists(created), created).toBe(false);
}
const notesValue = async (f: Fixture) => rootNotesValue(await readFile(f.request.config.core.config).catch(() => null));

test('user edits made after setup survive rollback in every managed file kind after an upgrade re-runs setup', async () => {
  const f = await fixture(); const notesBefore = await notesValue(f);
  await setupHerdr(f.request, f.parts);
  await editEveryKind(f);
  await upgradeMods(f);
  await setupHerdr(f.request, f.parts);
  await rollbackHerdr(f.request, f.parts);
  await expectEditsKept(f, notesBefore);
});

test('user edits survive setup, rollback, setup, rollback in every managed file kind', async () => {
  const f = await fixture(); const notesBefore = await notesValue(f);
  await setupHerdr(f.request, f.parts);
  await rollbackHerdr(f.request, f.parts);
  await editEveryKind(f);
  await setupHerdr(f.request, f.parts);
  await rollbackHerdr(f.request, f.parts);
  await expectEditsKept(f, notesBefore);
});

test('setup verification reuses the root probe that bootstrap just ran', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const probes = (await f.h.calls()).filter(call => call.argv[0] === 'run' && call.argv.includes('--probe'));
  expect(probes).toHaveLength(f.request.config.machines.length);
});

test('a recovered tab whose pi switched sessions is identified by its own process at once', async () => {
  const f = await fixture();
  const { createProcessPresence } = await import('../../../herdr/src/sessions/presence.js');
  const { processStartTime } = await import('../../../subagents/src/process-identity.js');
  const terminal = await f.h.hc.run({ argv: [f.h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: f.h.root, labels: {}, background: true, outliveParent: true, noNotify: true });
  cleanup.push(async () => { await f.h.hc.kill(terminal.address).catch(() => {}); await f.h.hc.rm(terminal.address).catch(() => {}); });
  const file = join(f.h.directories.agent, 'sessions/selected.jsonl'), other = join(f.h.directories.agent, 'sessions/other.jsonl');
  for (const [path, id] of [[file, 'selected'], [other, 'other']]) await writeFile(path, JSON.stringify({ type: 'session', version: 3, id, cwd: f.h.root }) + '\n');
  // The tab's pi ran /new: its presence names another session, on the same terminal and process.
  const identity = { pid: process.pid, startIdentity: processStartTime(process.pid)! };
  await createProcessPresence(join(f.h.directories.global, 'herdr')).record({ ...identity, sessionId: 'other' as never, sessionFile: other, sessionName: null, kind: 'top-level', hcAddress: terminal.address });
  const target = { file, sessionId: 'selected' as never, cwd: f.h.root, spaceName: 'Space', spaceOrder: 0, sessionOrder: 0, name: null } as never;
  const placement = { space: 'space-1' as never, tab: 'tab-1' as never, terminal: terminal.address };
  const started = Date.now();
  const result = await f.ports.spacePorts(f.request).verifyOwner(target, placement);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(result).toEqual({ ...identity, sessionFile: file, sessionId: 'selected', cwd: f.h.root });
  // While the target session is held elsewhere, the switch is reported at once instead of waiting.
  f.request.config.spaces = [{ name: 'Space', sessions: [{ file }] }] as never;
  await createProcessPresence(join(f.h.directories.global, 'herdr')).record({ pid: process.ppid, startIdentity: processStartTime(process.ppid)!, sessionId: 'selected' as never, sessionFile: file, sessionName: null, kind: 'top-level', hcAddress: null });
  const again = Date.now();
  await expect(f.ports.spacePorts(f.request).verifyOwner(target, placement)).rejects.toMatchObject({ code: 'owner-session-switched' });
  expect(Date.now() - again).toBeLessThan(10_000);
}, 90_000);

test('rollback never closes a created tab whose pi switched sessions and still runs', async () => {
  const f = await fixture();
  const { createProcessPresence } = await import('../../../herdr/src/sessions/presence.js');
  const { writePrivateJson } = await import('../../../herdr/src/sessions/registry.js');
  const { processStartTime } = await import('../../../subagents/src/process-identity.js');
  const terminal = await f.h.hc.run({ argv: [f.h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: f.h.root, labels: {}, background: true, outliveParent: true, noNotify: true });
  cleanup.push(async () => { await f.h.hc.kill(terminal.address).catch(() => {}); await f.h.hc.rm(terminal.address).catch(() => {}); });
  const file = join(f.h.directories.agent, 'sessions/selected.jsonl'), other = join(f.h.directories.agent, 'sessions/other.jsonl');
  for (const [path, id] of [[file, 'selected'], [other, 'other']]) await writeFile(path, JSON.stringify({ type: 'session', version: 3, id, cwd: f.h.root }) + '\n');
  const placement = { space: 'space-1', tab: 'tab-1', terminal: terminal.address };
  // A crash before the result was saved leaves the entry without a recorded process identity.
  await writePrivateJson(join(f.h.directories.global, 'herdr/spaces/spaces.json'), { version: 1, spaces: [{ name: 'Space', id: 'space-1', adopted: false }], tabs: [{ target: { file, sessionId: 'selected', cwd: f.h.root, spaceName: 'Space', spaceOrder: 0, sessionOrder: 0, name: null, extensionArguments: [] }, placement, result: null, failure: null }], intents: [], retired: [], focused: true });
  const app = join(f.h.root, 'app-layout.mjs'), closed = join(f.h.root, 'closed');
  await writeFile(app, `import { writeFileSync } from 'node:fs';\nconst a = process.argv.slice(2);\nif (a[0] === 'ls') console.log(JSON.stringify({ spaces: [{ id: 'space-1', name: 'Space', tabs: [{ id: 'tab-1', name: 'selected', terminals: [{ terminal: ${JSON.stringify(terminal.address)} }] }] }] }));\nelse { if (a.includes('tab.close')) writeFileSync(${JSON.stringify(closed)}, 'closed'); console.log('{}'); }\n`);
  const binary = join(f.h.root, 'app-layout'); await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${app}' "$@"\n`, { mode: 0o700 });
  f.request.config.app.binary = binary;
  await createProcessPresence(join(f.h.directories.global, 'herdr')).record({ pid: process.pid, startIdentity: processStartTime(process.pid)!, sessionId: 'other' as never, sessionFile: other, sessionName: null, kind: 'top-level', hcAddress: terminal.address });
  const parts = await f.ports.setupParts(f.request);
  await expect(parts.rollback({ terminals: [terminal.address], identities: {} })).rejects.toMatchObject({ code: 'cutover-owner-live' });
  expect(await exists(closed)).toBe(false);
});

test('a fresh app home without settings.json sets up and rolls back to no settings file', async () => {
  const f = await fixture();
  const { unlink } = await import('node:fs/promises');
  const settings = join(f.h.directories.app, 'settings.json');
  await unlink(settings);
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(await json(settings)).toMatchObject({ theme: 'spider-glass', layout: 'spider-glass' });
  await rollbackHerdr(f.request, f.parts);
  expect(await exists(settings)).toBe(false);
});

test('a fresh app home keeps settings the user added after setup through rollback', async () => {
  const f = await fixture();
  const { unlink } = await import('node:fs/promises');
  const settings = join(f.h.directories.app, 'settings.json');
  await unlink(settings);
  await setupHerdr(f.request, f.parts);
  await update(settings, s => { s.zoom = 2; });
  await rollbackHerdr(f.request, f.parts);
  expect(await json(settings)).toEqual({ zoom: 2 });
});

test('setup after rollback and an upgrade takes a fresh baseline instead of refusing spider\'s removed files', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  await rollbackHerdr(f.request, f.parts);
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
  await upgradeMods(f);
  const result = await setupHerdr(f.request, f.parts);
  expect(result.writes).toContain(join(f.h.directories.app, 'mods/spider-panel/main.js'));
  expect(result.doctor.failures).toEqual([]);
});

test('rollback keeps journal entries only for files it could not restore', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  f.parts.warn = () => {};
  await writeFile(join(f.h.directories.agent, 'settings.json'), '{"theme":"user-theme"}');
  await rollbackHerdr(f.request, f.parts);
  const kept = (await readJournal(f.request.journalRoot)).entries.map(entry => entry.path).sort();
  expect(kept).toEqual([join(f.h.directories.agent, 'settings.json'), join(f.h.directories.agent, 'themes/dracula-plus-glass.json')].sort());
});

test('a rollback that fails after closing tabs can be retried without closing them again', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const settings = join(f.h.directories.agent, 'settings.json');
  const entry = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === settings)!;
  const backup = await readFile(entry.backup!);
  await writeFile(entry.backup!, 'damaged');
  const rollback = vi.spyOn(f.parts, 'rollback');
  await expect(rollbackHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'backup-verification-failed' });
  expect(rollback).toHaveBeenCalledTimes(1);
  const journal = await readJournal(f.request.journalRoot);
  expect(journal.cutover).toBeNull();
  expect(journal.verified).toBe(false);
  await writeFile(entry.backup!, backup);
  await rollbackHerdr(f.request, f.parts);
  expect(rollback).toHaveBeenCalledTimes(1);
  expect(await json(settings)).toEqual({ theme: 'stock', unrelated: true });
});
