// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as backup from '../setup/backup.js';
import type { InstallFile } from '../setup/installer.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fx() {
  const parent = join(process.env.SPIDER_GLOBAL_ROOT!, 'setup-upgrade'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-')); roots.push(root);
  return { root, path: join(root, 'keys.json'), journal: await backup.readJournal(root) };
}
const desired = JSON.parse(await readFile(join(process.cwd(), 'packages/herdr/assets/keys.json'), 'utf8'));
async function publish(root: string, file: InstallFile, journal: backup.SetupJournal) {
  await backup.validateFiles([file], journal); await backup.prepareBackups(root, [file], journal); return backup.applyFiles([file], journal);
}
test('keys: pre-A install, A upgrade, rollback without user edits restores the pre-spider bytes', async () => {
  const { root, path, journal } = await fx();
  // Herdr's own order (not alphabetical), as in the shipped default map.
  const pristine = Buffer.from('{\n  "global": {\n    "cmd-shift-w": "pane.close",\n    "cmd-p": "mod.open:picker",\n    "cmd-n": "space.new"\n  },\n  "terminal": {\n    "ctrl-v": "terminal.paste_image"\n  }\n}\n');
  await writeFile(path, pristine);
  const legacyKeys = desired.terminal as Record<string, string>;
  const legacy: InstallFile = { path, expected: backup.digest(pristine), bytes: backup.mergeTerminalKeys(pristine, legacyKeys, {}, true), terminalKeys: legacyKeys, managed: { kind: 'json', section: 'terminal', fields: Object.keys(legacyKeys) } };
  await publish(root, legacy, journal); journal.verified = true; await backup.saveJournal(root, journal);
  const before = await readFile(path);
  const sections = Object.fromEntries(Object.entries(desired).map(([s, b]) => [s, Object.keys(b as object)]));
  const next = { path, expected: backup.digest(before), bytes: backup.mergeKeys(before, desired, { terminal: legacyKeys }, false), keys: desired, managed: { kind: 'keys', sections } } as unknown as InstallFile;
  await publish(root, next, await backup.readJournal(root).then(j => { Object.assign(journal, j); return journal; }));
  const restored = await backup.rollbackFiles(root, await backup.readJournal(root));
  const after = await readFile(path);
  expect(JSON.parse(after.toString())).toEqual(JSON.parse(pristine.toString()));
  expect(after.toString()).toBe(pristine.toString());
});
test('keys: fresh A install then rollback restores bytes (control)', async () => {
  const { root, path, journal } = await fx();
  const pristine = Buffer.from('{\n  "global": {\n    "cmd-shift-w": "pane.close",\n    "cmd-p": "mod.open:picker",\n    "cmd-n": "space.new"\n  },\n  "terminal": {\n    "ctrl-v": "terminal.paste_image"\n  }\n}\n');
  await writeFile(path, pristine);
  const sections = Object.fromEntries(Object.entries(desired).map(([s, b]) => [s, Object.keys(b as object)]));
  const next = { path, expected: backup.digest(pristine), bytes: backup.mergeKeys(pristine, desired, {}, false), keys: desired, managed: { kind: 'keys', sections } } as unknown as InstallFile;
  await publish(root, next, journal);
  await backup.rollbackFiles(root, await backup.readJournal(root));
  expect((await readFile(path)).toString()).toBe(pristine.toString());
});
test('settings: pre-A install, A upgrade, rollback without user edits restores the pre-spider bytes', async () => {
  const { root, journal } = await fx(), path = join(root, 'settings.json');
  const pristine = '{\n    "zoom": 1.25,\n    "theme": "stock",\n    "layout": "main"\n}';
  await writeFile(path, pristine);
  // Pre-A: the app commits theme and layout itself (compact, as the fake app does).
  const legacyInstalled = Buffer.from(JSON.stringify({ zoom: 1.25, theme: 'spider-glass', layout: 'spider-glass' }));
  const legacy: InstallFile = { path, expected: backup.digest(Buffer.from(pristine)), bytes: legacyInstalled, managed: { kind: 'json', fields: ['theme', 'layout'] } };
  await publish(root, legacy, journal); journal.verified = true; await backup.saveJournal(root, journal);
  const current = await readFile(path);
  // A's production installFiles bytes: JSON.stringify(..., null, 2) + newline.
  const installed = Buffer.from(JSON.stringify({ ...JSON.parse(current.toString()), sounds: { enabled: false } }, null, 2) + '\n');
  const next = { path, expected: backup.digest(current), bytes: installed, managed: { kind: 'json-paths', paths: ['theme', 'layout', 'sounds.enabled'] } } as unknown as InstallFile;
  await publish(root, next, journal); await backup.saveJournal(root, journal);
  const saved = await backup.readJournal(root);
  await backup.rollbackFiles(root, saved);
  const after = (await readFile(path)).toString();
  expect(JSON.parse(after)).toEqual(JSON.parse(pristine));
  expect(after).toBe(pristine);
});
test('keys: rollback after the user deleted keys.json', async () => {
  const { root, path, journal } = await fx();
  const pristine = Buffer.from(JSON.stringify({ global: { 'cmd-p': 'mod.open:picker', 'cmd-n': 'space.new', 'cmd-shift-w': 'pane.close' }, terminal: { 'ctrl-v': 'terminal.paste_image' } }));
  await writeFile(path, pristine);
  const sections = Object.fromEntries(Object.entries(desired).map(([s, b]) => [s, Object.keys(b as object)]));
  const next = { path, expected: backup.digest(pristine), bytes: backup.mergeKeys(pristine, desired, {}, false), keys: desired, managed: { kind: 'keys', sections } } as unknown as InstallFile;
  await publish(root, next, journal);
  await rm(path);
  const warnings: string[] = [];
  const saved = await backup.readJournal(root);
  await backup.rollbackFiles(root, saved, { warn: w => warnings.push(w) });
  await backup.rollbackFiles(root, saved, { warn: w => warnings.push(w) });
  expect(saved.entries).toEqual([]);
  expect(warnings).toEqual([expect.stringMatching(/keys\.json.*deleted.*released/i)]);
  expect(await readFile(path).then(() => true, () => false)).toBe(false);
});
