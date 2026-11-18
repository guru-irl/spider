// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import * as fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { HerdrError } from '../client/parse.js';
import { parseHerdrConfig } from '../config.js';
import { applyFiles, mergeTerminalKeys, prepareBackups, readJournal, saveJournal, snapshot } from '../setup/backup.js';
import { setupHerdr, type InstallFile, type SetupParts, type SetupRequest } from '../setup/installer.js';
export const roots: string[] = [];
export const oldKeys = { 'cmd-shift-a': 'old.a', 'cmd-shift-k': 'old.k', 'cmd-shift-m': 'old.m', 'cmd-shift-o': 'old.o', 'cmd-shift-u': 'old.u' };
export const installedLayout = '{"content":[],"generation":2}\n';
export const nativeLayout = '{"content":[{"size":320}],"generation":2}\n';
export async function put(path: string, bytes: string, mode = 0o600) {
  await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, bytes); await fs.chmod(path, mode);
}
export async function values(paths: readonly string[]) {
  return Promise.all(paths.map(async path => { const s = await snapshot(path); return { path, bytes: s.bytes?.toString('base64') ?? null, mode: s.bytes === null ? null : s.mode }; }));
}
export async function fixture() {
  const parent = resolve('.spider/scratch/checkpoint-fixtures'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(join(parent, 'case-')); roots.push(root);
  const app = join(root, 'app'), global = join(root, 'global'), agent = join(root, 'agent'), journalRoot = join(global, 'herdr/setup');
  await fs.mkdir(global, { recursive: true });
  const paths = { font: join(app, 'fonts/body.ttf'), theme: join(agent, 'themes/dracula-plus-glass.json'), svg: join(app, 'mods/spider-example/icon.svg'),
    main: join(app, 'mods/spider-example/main.js'), manifest: join(app, 'mods/spider-example/mod.json'), layout: join(app, 'layouts/spider-glass.json'),
    keys: join(app, 'keys.json'), settings: join(agent, 'settings.json'), appSettings: join(app, 'settings.json'), notes: join(root, 'core/config.toml'),
    spaces: join(global, 'herdr/spaces/spaces.json'), registry: join(global, 'herdr/installation.json'), journal: join(journalRoot, 'journal.json'),
    added: join(global, 'herdr/instructions/worker.md') };
  const request: SetupRequest = { config: parseHerdrConfig({ app: { binary: '/usr/bin/true', home: app }, core: { binary: '/usr/bin/true', config: paths.notes },
    agentDirectory: agent, globalRoot: global, shellRc: join(root, 'shellrc'), spaces: [], machines: [] }), configPath: join(global, 'herdr/config.json'), packageRoot: root, journalRoot };
  await put(paths.keys, '{\n "terminal": {"ctrl-v":"terminal.paste_image"}, "global": {}\n}\n', 0o644);
  await put(paths.settings, '{ "theme": "dracula", "keep": true }\n', 0o640);
  await put(paths.notes, 'notes = true\n', 0o640);
  const legacy = await readJournal(journalRoot);
  const originalSettings = await snapshot(paths.settings), originalKeys = await snapshot(paths.keys), originalNotes = await snapshot(paths.notes);
  const old: InstallFile[] = [
    { path: paths.font, bytes: Buffer.from('old-font'), expected: null, mode: 0o640 },
    { path: paths.theme, bytes: Buffer.from('old-theme'), expected: null },
    { path: paths.svg, bytes: Buffer.from('<svg/>'), expected: null },
    { path: paths.main, bytes: Buffer.from('old-main'), expected: null },
    { path: paths.manifest, bytes: Buffer.from('{"place":"none"}'), expected: null },
    { path: paths.layout, bytes: Buffer.from('{"content":[],"generation":1}\n'), expected: null, mode: 0o644 },
    { path: paths.settings, bytes: Buffer.from('{ "theme": "dracula-plus-glass", "keep": true }\n'), expected: originalSettings.hash, managed: { kind: 'json', fields: ['theme'] } },
    { path: paths.keys, bytes: mergeTerminalKeys(originalKeys.bytes, oldKeys, {}, true), expected: originalKeys.hash, terminalKeys: oldKeys, managed: { kind: 'json', section: 'terminal', fields: Object.keys(oldKeys) } },
    { path: paths.notes, bytes: Buffer.from('notes = false\n'), expected: originalNotes.hash, managed: { kind: 'notes' } },
  ];
  await prepareBackups(journalRoot, old, legacy); await applyFiles(journalRoot, old, legacy);
  await put(paths.appSettings, '{"layout":"spider-glass","theme":"spider-glass"}\n', 0o644);
  await put(paths.spaces, '{"version":1,"spaces":["existing"],"placements":["old"]}\n', 0o640);
  await put(paths.registry, '{ "version": 1, "packageRoot": "/home/fixture" }\n', 0o600);
  legacy.verified = true; legacy.fingerprint = 'legacy'; legacy.cutover = { terminals: [], identities: { old: 'owner-1' } };
  await saveJournal(journalRoot, legacy);
  // Include non-default writable bits: undo must not lose mode bits to umask.
  await fs.chmod(paths.main, 0o664);
  const all = Object.values(paths), before = await values(all);
  let fail = false, ownerLive = false, verificationFails = false;
  const installed = async (path: string, bytes: string, context: { installed: Readonly<Record<string, string>> }): Promise<InstallFile> => ({ path, bytes: Buffer.from(bytes), expected: context.installed[path] ?? null });
  const parts: SetupParts = {
    preflight: async () => ({ fingerprint: 'assets-2', coreIdentity: { coreId: 'core-1' as import('../contracts.js').CoreId, socket: join(root, 'core.sock'), sessionNamespace: 'fixture' }, mods: [{ directory: dirname(paths.main) }], targets: [], retiredTerminals: [], layoutExport: true,
      recoveredCutover: { terminals: [], identities: { old: 'owner-1' } }, cutoverActions: ['Update fixture'] }),
    stageLook: async (_, context) => [await installed(paths.font, 'old-font', context), await installed(paths.theme, 'old-theme', context), await installed(paths.layout, installedLayout, context)],
    installFiles: async (_, context) => [await installed(paths.svg, '<svg/>', context), await installed(paths.main, 'new-main', context), await installed(paths.manifest, '{"place":"none"}', context),
      { path: paths.keys, bytes: Buffer.alloc(0), expected: (await snapshot(paths.keys)).hash, keys: { terminal: oldKeys, global: { 'cmd-x': 'new.action' } }, collision: 'key' }],
    generateTemplates: async (_, context) => [await installed(paths.added, 'new instructions', context)], installResume: async () => [],
    probeMachineNode: async () => 'v22.19.0', ensureRuntime: async () => [], bootstrapRuntime: async () => {},
    hc: { fileRead: async () => Buffer.alloc(0), fileWrite: async () => {} },
    paneEndpointPlan: async () => ({ paths: [paths.registry], changed: (await snapshot(paths.registry)).bytes?.toString('utf8') !== '{"version":1,"packageRoot":"/home/fixture","endpoint":{"protocol":1}}\n' }),
    stagePaneEndpoint: async () => { const next = '{"version":1,"packageRoot":"/home/fixture","endpoint":{"protocol":1}}\n'; if ((await snapshot(paths.registry)).bytes?.toString('utf8') === next) return []; await put(paths.registry, next); return [paths.registry]; },
    cutover: async () => {
      await put(paths.spaces, '{"version":2,"spaces":["new"],"placements":["new"]}\n');
      if (fail) { await put(paths.layout, nativeLayout, 0o644); throw new Error('injected cutover interruption'); }
      return { terminals: [], identities: { new: 'owner-2' } };
    },
    verify: async () => ({ failures: verificationFails ? [{ item: 'layout', code: 'fixture-failure', message: 'not ready', repair: 'retry' }] : [], warnings: [], probes: [] }),
    rollback: async () => { if (ownerLive) throw new HerdrError('cutover-owner-live', 'owner live'); await put(paths.spaces, '{"version":2,"spaces":[]}\n'); },
    warn: () => {},
  };
  const undoExpected = before.map(file => file.path === paths.spaces ? { ...file, bytes: Buffer.from('{"version":2,"spaces":[]}\n').toString('base64'), mode: 0o600 } : file);
  return { request, parts, paths, all, before, undoExpected, fail: (value: boolean) => { fail = value; }, live: (value: boolean) => { ownerLive = value; }, badDoctor: () => { verificationFails = true; } };
}

export async function metadataRepeat(f: Awaited<ReturnType<typeof fixture>>, replaceChanged = false) {
  const preflight = f.parts.preflight;
  f.parts.preflight = async request => ({ ...await preflight(request), recoveredCutover: (await readJournal(request.journalRoot)).cutover!, cutoverActions: [] });
  const journal = await readJournal(f.request.journalRoot);
  delete journal.cutoverFingerprint;
  await saveJournal(f.request.journalRoot, journal);
  await setupHerdr({ ...f.request, replaceChanged }, f.parts);
}
