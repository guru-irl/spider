// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { HerdrError } from '../client/parse.js';
import { digest, readJournal, saveJournal, snapshot } from '../setup/backup.js';
import { modStoreFileName } from '../setup/mod-storage.js';
import { readCheckpoint } from '../setup/checkpoint.js';
import { doctorHerdr } from '../setup/doctor.js';
import { rollbackHerdr, setupHerdr, undoHerdrUpgrade } from '../setup/installer.js';
import { verifiedHerdrFile } from '../../../host/src/herdr/ports.js';
import { fixture, metadataRepeat, put, roots, values } from './setup-checkpoint-fixture.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename), link: vi.fn(actual.link) };
});
const real = await vi.importActual<typeof fs>('node:fs/promises');
afterEach(async () => {
  vi.mocked(fs.rename).mockImplementation(real.rename); vi.mocked(fs.link).mockImplementation(real.link);
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

type Step = 'setup' | 'replace' | 'fail-retry' | 'bookkeeping' | 'remote' | 'layout-only' | 'shell' | 'keys' | 'settings' | 'pi' | 'app' | 'template' | 'move' | 'journal-crash' | 'batch-crash' | 'cutover-crash' | 'undo-crash' | 'pi-during-undo' | 'doctor' | 'undo' | 'undo-replace' | 'layout-reference' | 'rollback';
const commands: readonly Step[] = ['setup', 'replace', 'fail-retry', 'bookkeeping', 'remote', 'layout-only', 'shell', 'keys', 'settings', 'pi', 'app', 'template', 'move', 'journal-crash', 'batch-crash', 'cutover-crash', 'undo-crash', 'pi-during-undo', 'doctor', 'undo', 'undo-replace', 'rollback'];
function random(seed: number) { let state = seed >>> 0; return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }; }

async function blobs(f: Awaited<ReturnType<typeof fixture>>) {
  const cp = await readCheckpoint(f.request.journalRoot), active = cp && !['undone', 'superseded'].includes(cp.state);
  const references = new Set<string>();
  if (active) for (const run of cp.runs) for (const file of [...run.before, ...run.after ?? [], ...run.planned, ...run.written]) if (file.hash) references.add(file.hash);
  if (active && cp.undo) for (const file of [...cp.undo.expected, ...cp.undo.targets]) if (file.hash) references.add(file.hash);
  const directory = join(f.request.journalRoot, 'backups');
  const names = (await fs.readdir(directory)).filter(name => name.startsWith('checkpoint-'));
  expect(names.every(name => references.has(name.slice('checkpoint-'.length))), 'only restorable blobs are retained').toBe(true);
  expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
  for (const hash of references) {
    const file = await snapshot(join(directory, 'checkpoint-' + hash));
    expect(file.hash).toBe(hash);
    expect(file.mode).toBe(0o600);
  }
}

/** Translate only directory identities in the probe copy, including saved journals. */
async function probeCopy(original: string, root: string, journalRoot: string) {
  const identities = new Map<string, { dev: number; ino: number }>();
  const walk = async (relative = '') => {
    const before = await fs.stat(join(original, relative)), after = await fs.stat(join(root, relative));
    identities.set(`${before.dev}:${before.ino}`, { dev: after.dev, ino: after.ino });
    for (const entry of await fs.readdir(join(original, relative), { withFileTypes: true })) if (entry.isDirectory()) await walk(join(relative, entry.name));
  };
  await walk();
  const translate = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(translate); return; }
    const row = value as Record<string, unknown>;
    if (typeof row.dev === 'number' && typeof row.ino === 'number') Object.assign(row, identities.get(`${row.dev}:${row.ino}`) ?? {});
    Object.values(row).forEach(translate);
  };
  const path = join(journalRoot, 'checkpoint.json'), checkpoint = await readCheckpoint(journalRoot);
  if (!checkpoint) return;
  translate(checkpoint);
  const active = !['undone', 'superseded'].includes(checkpoint.state);
  const journals = new Map<string, string>();
  const rewrite = (bytes: Buffer) => { const value: unknown = JSON.parse(bytes.toString()); translate(value); return Buffer.from(JSON.stringify(value) + '\n'); };
  for (const run of active ? checkpoint.runs : []) for (const file of [...run.before, ...run.after ?? [], ...run.written, ...run.planned]) {
    if (file.path !== join(journalRoot, 'journal.json') || !file.hash) continue;
    const saved = file.hash;
    if (!journals.has(saved)) {
      const bytes = rewrite(await fs.readFile(join(journalRoot, 'backups', 'checkpoint-' + saved)));
      const hash = digest(bytes); await put(join(journalRoot, 'backups', 'checkpoint-' + hash), bytes.toString()); journals.set(saved, hash);
    }
    file.hash = journals.get(saved)!;
  }
  if (active && checkpoint.undo) for (const file of [...checkpoint.undo.expected, ...checkpoint.undo.targets]) if (file.path === join(journalRoot, 'journal.json') && file.hash) {
    const saved = file.hash;
    if (!journals.has(saved)) {
      const bytes = rewrite(await fs.readFile(join(journalRoot, 'backups', 'checkpoint-' + saved)));
      const hash = digest(bytes); await put(join(journalRoot, 'backups', 'checkpoint-' + hash), bytes.toString()); journals.set(saved, hash);
    }
    file.hash = journals.get(saved)!;
  }
  const journal = await snapshot(join(journalRoot, 'journal.json'));
  if (journal.bytes) await fs.writeFile(join(journalRoot, 'journal.json'), rewrite(journal.bytes));
  await put(path, JSON.stringify(checkpoint));
}

/** Each prefix is checked on disk, then restored at the same absolute paths. */
export async function model(steps: readonly Step[], checkPrefixes = true): Promise<void> {
  const f = await fixture(), root = f.request.packageRoot;
  const addedMod = join(f.request.config.app.home, 'mods/spider-added');
  const addedMain = join(addedMod, 'main.js'), addedManifest = join(addedMod, 'mod.json');
  const install = f.parts.installFiles;
  f.parts.installFiles = async (request, context) => [...await install(request, context), ...[
    { path: addedMain, bytes: Buffer.from('added main'), expected: context.installed[addedMain] ?? null },
    { path: addedManifest, bytes: Buffer.from('{"place":"none"}'), expected: context.installed[addedManifest] ?? null },
  ]];
  const owned = [addedMain, addedManifest, f.paths.font, f.paths.theme, f.paths.svg, f.paths.main, f.paths.manifest, f.paths.appSettings, f.paths.notes, f.paths.registry];
  let baseline = await values(owned);
  let settingsBaseline = JSON.parse(await fs.readFile(f.paths.settings, 'utf8'));
  let keysBaseline = JSON.parse(await fs.readFile(f.paths.keys, 'utf8'));
  let layoutBaseline: string | null = (await snapshot(f.paths.layout)).bytes?.toString() ?? null;
  let instructionBaseline: string | null = null, roleBaseline: string | null = null;
  let instructionSetup: string | null = null, roleSetup: string | null = null;
  let checkpointExpected = false;
  let storeBaseline: string | null = null;
  let resumeBaseline: string | null = null;
  const rememberBaseline = async () => {
    baseline = await values(owned);
    settingsBaseline = JSON.parse(await fs.readFile(f.paths.settings, 'utf8'));
    keysBaseline = JSON.parse(await fs.readFile(f.paths.keys, 'utf8'));
    layoutBaseline = (await snapshot(f.paths.layout)).bytes?.toString() ?? null;
    instructionBaseline = (await snapshot(f.paths.added)).bytes?.toString() ?? null;
    roleBaseline = (await snapshot(f.paths.roleTemplate)).bytes?.toString() ?? null;
    storeBaseline = (await snapshot(storeCopy)).bytes?.toString() ?? null;
    resumeBaseline = (await fs.readFile(f.request.config.shellRc, 'utf8')).match(/^# spider:resume:start\n[\s\S]*?^# spider:resume:end(?:\n|$)/m)?.[0] ?? null;
  };
  const preflight = f.parts.preflight;
  f.parts.preflight = async (...args) => { const result = await preflight(...args); return { ...result, cutoverProvedAbsent: true, mods: [...result.mods, { directory: addedMod }] }; };
  const oldLayout = JSON.stringify({ content: [{ id: 'pane', mod: 'spider-example', props: { version: 1 } }], generation: 1 });
  const nextLayout = { content: [{ id: 'pane', mod: 'spider-example', props: { version: 2 } }, { id: 'added', mod: 'spider-added' }], generation: 2 };
  await put(f.paths.layout, oldLayout);
  const legacy = await readJournal(f.request.journalRoot); legacy.entries.find(entry => entry.path === f.paths.layout)!.after = digest(Buffer.from(oldLayout)); await saveJournal(f.request.journalRoot, legacy);
  layoutBaseline = oldLayout;
  const storeCopy = join(f.request.config.app.home, 'data/spider-example', modStoreFileName({ version: 2 }));
  await put(join(dirname(storeCopy), modStoreFileName({ version: 1 })), 'old store');
  const stage = f.parts.stageLook;
  f.parts.stageLook = async (...args) => (await stage(...args)).map(file => file.path === f.paths.layout ? { ...file, bytes: Buffer.from(JSON.stringify({ ...nextLayout, ...(appEdit ? { userSize: 321 } : {}) })) } : file);
  let shellEdits = 0, settingsEdit = false, keysEdit = false, move = false, appEdit = false, failedAttempt = false;
  let templateGeneration = 0, cutoverExport = false;
  const piFiles = () => [{ path: f.paths.added, bytes: Buffer.from(`runtime instructions ${templateGeneration}`) }, { path: f.paths.roleTemplate, bytes: Buffer.from(`runtime role ${templateGeneration}`) }];
  const piWrite = async (file: ReturnType<typeof piFiles>[number]) => verifiedHerdrFile(f.request.journalRoot, { ...file, expected: (await snapshot(file.path)).hash, collision: 'clone' });
  const templateValues = () => values([f.paths.added, f.paths.roleTemplate]);
  const observeSetup = async () => {
    checkpointExpected = true;
    const checkpoint = await readCheckpoint(f.request.journalRoot);
    expect(checkpoint, 'setup must retain its upgrade checkpoint').not.toBeNull();
    expect((await snapshot(storeCopy)).bytes?.toString() ?? null, 'the upgrade really plans and installs a store copy').toBe(appEdit ? 'runtime store' : storeBaseline ?? (layoutBaseline?.includes('"version":1') ? 'old store' : null));
    if (storeBaseline === null && !appEdit && layoutBaseline?.includes('"version":1')) expect(checkpoint!.runs.some(run => run.before.some(file => file.path === storeCopy)), 'the store copy is part of the checkpoint').toBe(true);
  };
  const observeTemplates = async (before: Awaited<ReturnType<typeof templateValues>>) => {
    const after = await templateValues();
    if (after[0]!.bytes !== before[0]!.bytes) instructionSetup = (await snapshot(f.paths.added)).bytes?.toString() ?? null;
    if (after[1]!.bytes !== before[1]!.bytes) roleSetup = (await snapshot(f.paths.roleTemplate)).bytes?.toString() ?? null;
  };
  const cutover = f.parts.cutover;
  f.parts.cutover = async (...args) => {
    const previous = await fs.readFile(f.paths.spaces).catch(() => null);
    try { return await cutover(...args); }
    finally { if (move && previous) await fs.writeFile(f.paths.spaces, previous); }
  };
  const rollback = f.parts.rollback;
  f.parts.rollback = async (...args) => {
    const previous = await fs.readFile(f.paths.spaces).catch(() => null);
    await rollback(...args);
    if (move && previous) await fs.writeFile(f.paths.spaces, previous);
  };
  const shell = f.request.config.shellRc;
  await put(shell, 'alias original=true\n');
  f.parts.installResume = async () => {
    const current = await snapshot(shell), text = current.bytes?.toString() ?? '';
    return [{ path: shell, expected: current.hash, bytes: Buffer.from(text.includes('# spider:resume:start') ? text : text + '# spider:resume:start\nsetup hook\n# spider:resume:end\n'), managed: { kind: 'resume' } }];
  };
  const attemptUndo = async (replaceChanged = false) => {
    const checkpoint = await readCheckpoint(f.request.journalRoot);
    if (!checkpointExpected) {
      expect(!checkpoint || ['undone', 'superseded'].includes(checkpoint.state), 'no active upgrade remains').toBe(true);
      await expect(undoHerdrUpgrade({ ...f.request, replaceChanged }, f.parts)).rejects.toMatchObject({ code: 'upgrade-checkpoint-missing' });
      return false;
    }
    expect(checkpoint, 'an installed upgrade must have a checkpoint').not.toBeNull();
    const instructions = (await snapshot(f.paths.added)).bytes?.toString() ?? null;
    const role = (await snapshot(f.paths.roleTemplate)).bytes?.toString() ?? null;
    await undoHerdrUpgrade({ ...f.request, replaceChanged }, f.parts);
    checkpointExpected = false;
    expect(await values(owned)).toEqual(baseline);
    const shellBytes = await fs.readFile(shell, 'utf8'), block = /^# spider:resume:start\n[\s\S]*?^# spider:resume:end(?:\n|$)/m;
    expect(shellBytes.replace(block, '')).toBe('alias original=true\n' + 'alias user=true\n'.repeat(shellEdits));
    expect(shellBytes.match(block)?.[0] ?? null).toBe(resumeBaseline);
    expect(JSON.parse(await fs.readFile(f.paths.settings, 'utf8'))).toEqual({ ...settingsBaseline, ...(settingsEdit ? { user: 'keep' } : {}) });
    expect(JSON.parse(await fs.readFile(f.paths.keys, 'utf8'))).toEqual({ ...keysBaseline, global: { ...keysBaseline.global, ...(keysEdit ? { 'ctrl-z': 'user.action' } : {}) } });
    if (move) expect(await fs.readFile(f.paths.spaces, 'utf8')).toContain('moved');
    expect((await snapshot(f.paths.added)).bytes?.toString() ?? null).toBe(instructions !== instructionSetup ? instructions : instructionBaseline);
    expect((await snapshot(f.paths.roleTemplate)).bytes?.toString() ?? null).toBe(role !== roleSetup ? role : roleBaseline);
    const layout = (await snapshot(f.paths.layout)).bytes?.toString() ?? '';
    const expectedLayout = layoutBaseline === null ? null : JSON.parse(layoutBaseline);
    expect(layout ? JSON.parse(layout) : null).toEqual(appEdit ? { ...expectedLayout, userSize: 321 } : expectedLayout);
    expect((await snapshot(storeCopy)).bytes?.toString() ?? null, 'unchanged copies are removed and runtime stores are retained').toBe(appEdit ? 'runtime store' : storeBaseline);
    expect(await fs.readFile(join(dirname(storeCopy), modStoreFileName({ version: 1 })), 'utf8')).toBe('old store');
    const names = [...layout.matchAll(/spider-[a-z-]+/g)].map(match => match[0]);
    for (const name of names) expect((await snapshot(join(f.request.config.app.home, 'mods', name, 'mod.json'))).hash, `layout reference ${name}`).not.toBeNull();
    if (checkPrefixes) await blobs(f);
    return true;
  };
  const warnings: string[] = []; f.parts.warn = message => warnings.push(message);
  const probe = async () => {
    const original = root + '-original', identity = await fs.stat(root), expected = checkpointExpected;
    await real.rename(root, original);
    try {
      await fs.cp(original, root, { recursive: true });
      await probeCopy(original, root, f.request.journalRoot);
      const undone = await attemptUndo();
      if (undone) {
        const start = warnings.length;
        await rollbackHerdr(f.request, f.parts);
        expect((await snapshot(f.paths.registry)).hash, 'full rollback after undo removes the registry').toBeNull();
        const retained = (await readJournal(f.request.journalRoot)).entries;
        const kept: { path: string; bytes: Buffer; mode: number }[] = [];
        for (const entry of retained) {
          expect(warnings.slice(start).some(message => message.includes(entry.path)), 'retained paths have a named repair').toBe(true);
          const current = await snapshot(entry.path);
          expect(current.bytes).not.toBeNull();
          const path = entry.path + '.kept'; await real.rename(entry.path, path);
          kept.push({ path, bytes: current.bytes!, mode: current.mode });
        }
        if (retained.length) await rollbackHerdr(f.request, f.parts);
        expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
        for (const file of kept) { expect(await fs.readFile(file.path)).toEqual(file.bytes); expect((await fs.stat(file.path)).mode & 0o777).toBe(file.mode); }
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); await real.rename(original, root); checkpointExpected = expected; }
    expect((await fs.stat(root)).ino, 'probing never changes the original directory identity').toBe(identity.ino);
  };
  const interrupted = async (work: () => Promise<unknown>, matches: (target: string) => boolean | Promise<boolean>, after: boolean) => {
    let fired = false;
    const hook = (operation: typeof real.rename) => async (from: Parameters<typeof real.rename>[0], to: Parameters<typeof real.rename>[1]) => {
      if (fired) throw new Error('model crash');
      const hit = !after && await matches(String(to));
      if (hit) { fired = true; throw new Error('model crash'); }
      await operation(from, to);
      if (after && await matches(String(to))) { fired = true; throw new Error('model crash'); }
    };
    vi.mocked(fs.rename).mockImplementation(hook(real.rename)); vi.mocked(fs.link).mockImplementation(hook(real.link));
    try { await work(); } catch (error) { expect(String(error)).toContain('model crash'); }
    finally { vi.mocked(fs.rename).mockImplementation(real.rename); vi.mocked(fs.link).mockImplementation(real.link); }
    return fired;
  };
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    try {
      let cp = await readCheckpoint(f.request.journalRoot);
      if (cp?.state === 'undoing' && ['setup', 'replace', 'fail-retry', 'bookkeeping', 'remote', 'layout-only', 'journal-crash', 'batch-crash', 'cutover-crash'].includes(step)) {
        await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'upgrade-undo-in-progress' });
        if (await attemptUndo(true)) failedAttempt = false;
        cp = await readCheckpoint(f.request.journalRoot);
      }
      const setup = async (replaceChanged = false) => {
        const current = await readCheckpoint(f.request.journalRoot);
        if (!current || ['undone', 'superseded'].includes(current.state)) await rememberBaseline();
        const before = await templateValues();
        // The app step deliberately changes the fixture's exported layout.
        // Authorize that known replacement up front, never retry a refusal.
        try { await setupHerdr({ ...f.request, replaceChanged: replaceChanged || appEdit || cutoverExport }, f.parts); }
        finally { await observeTemplates(before); }
        await observeSetup();
        cutoverExport = false; failedAttempt = false;
      };
      if ((!cp || ['undone', 'superseded'].includes(cp.state)) && ['bookkeeping', 'journal-crash'].includes(step)) await rememberBaseline();
      switch (step) {
        case 'setup': case 'replace': await setup(step === 'replace'); break;
        case 'bookkeeping': {
          const before = await templateValues();
          try { await metadataRepeat(f, appEdit || cutoverExport); } finally { await observeTemplates(before); }
          await observeSetup(); failedAttempt = false; break;
        }
        case 'remote': {
          const bytes = Buffer.from('runtime-v2'), machine = 'box-1.invalid' as import('../contracts.js').MachineName;
          let remote: Buffer | null = null;
          f.parts.ensureRuntime = async () => [{ machine, path: '/home/fixture/runtime.mjs', bytes, sha256: digest(bytes) }];
          f.parts.hc = { fileRead: async () => { if (!remote) throw new HerdrError('file-not-found', 'absent'); return remote; }, fileWrite: async (_, __, bytes) => { remote = bytes; } };
          await setup(); break;
        }
        case 'layout-only': {
          const stage = f.parts.stageLook;
          f.parts.stageLook = async (...args) => (await stage(...args)).map(file => file.path === f.paths.layout ? { ...file, bytes: Buffer.from(JSON.stringify({ ...nextLayout, generation: 3, ...(appEdit ? { userSize: 321 } : {}) })) } : file);
          await setup(); break;
        }
        case 'shell': shellEdits++; await fs.appendFile(shell, 'alias user=true\n'); break;
        case 'settings': settingsEdit = true; await put(f.paths.settings, JSON.stringify({ ...JSON.parse(await fs.readFile(f.paths.settings, 'utf8')), user: 'keep' })); break;
        case 'keys': { keysEdit = true; const keys = JSON.parse(await fs.readFile(f.paths.keys, 'utf8')); keys.global['ctrl-z'] = 'user.action'; await put(f.paths.keys, JSON.stringify(keys)); break; }
        case 'app': { const current = await snapshot(f.paths.layout); if (!current.bytes) break; appEdit = true; await put(f.paths.layout, JSON.stringify({ ...JSON.parse(current.bytes.toString()), userSize: 321 })); await put(storeCopy, 'runtime store'); break; }
        case 'pi': case 'template': {
          templateGeneration++;
          if (cp?.state === 'undoing') {
            for (const file of piFiles()) await expect(piWrite(file)).rejects.toMatchObject({ code: 'upgrade-undo-in-progress' });
            break;
          }
          for (const file of piFiles()) await piWrite(file);
          f.parts.generateTemplates = async () => Promise.all(piFiles().map(async file => ({ ...file, expected: (await snapshot(file.path)).hash })));
          break;
        }
        case 'layout-reference': {
          const checkpoint = await readCheckpoint(f.request.journalRoot);
          if (!checkpointExpected || checkpoint?.state === 'undoing' || !checkpoint?.runs[0]!.before.some(file => file.path === addedManifest && file.hash === null)) break;
          const layout = await fs.readFile(f.paths.layout, 'utf8');
          await put(f.paths.layout, JSON.stringify({ ...JSON.parse(layout), toast: 'spider-added' }));
          const before = await values([f.paths.layout, addedMain, addedManifest]);
          await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toMatchObject({ code: 'upgrade-layout-reference' });
          expect(await values([f.paths.layout, addedMain, addedManifest]), 'unsafe references refuse before any file is removed').toEqual(before);
          await put(f.paths.layout, layout);
          break;
        }
        case 'move': move = true; await put(f.paths.spaces, '{"placements":["moved"]}'); break;
        case 'fail-retry': {
          const verify = f.parts.verify; f.parts.verify = async () => { throw new Error('model failure'); };
          await expect(setup(true)).rejects.toThrow('model failure'); f.parts.verify = verify; await setup(true); break;
        }
        case 'journal-crash': {
          await interrupted(() => metadataRepeat(f, true), target => target === join(f.request.journalRoot, 'checkpoint.json'), false); break;
        }
        case 'batch-crash': case 'cutover-crash': {
          f.fail(step === 'cutover-crash');
          if (step === 'batch-crash') {
            if (cp?.state === 'complete' && !failedAttempt) await rememberBaseline();
            const install = f.parts.installFiles;
            f.parts.installFiles = async (...args) => (await install(...args)).map(file => file.path === f.paths.main ? { ...file, bytes: Buffer.from(`model-main-${index}`) } : file);
            expect(await interrupted(() => setup(true), target => target === f.paths.main, true)).toBe(true);
          }
          else { const journal = await readJournal(f.request.journalRoot); journal.verified = false; await saveJournal(f.request.journalRoot, journal); await expect(setup(true)).rejects.toThrow('injected cutover interruption'); }
          f.fail(false); cutoverExport ||= step === 'cutover-crash'; failedAttempt = true; checkpointExpected = true; break;
        }
        case 'undo-crash': case 'pi-during-undo': {
          if (cp && !['undone', 'superseded'].includes(cp.state)) {
            expect(await interrupted(() => undoHerdrUpgrade(f.request, f.parts), async target => target === join(f.request.journalRoot, 'checkpoint.json') && (await readCheckpoint(f.request.journalRoot))?.state === 'undoing', true)).toBe(true);
            if (step === 'pi-during-undo') {
              expect((await readCheckpoint(f.request.journalRoot))?.state).toBe('undoing');
              templateGeneration++;
              for (const file of piFiles()) {
                const before = await values([file.path, f.paths.journal]);
                await expect(piWrite(file)).rejects.toMatchObject({ code: 'upgrade-undo-in-progress' });
                expect(await values([file.path, f.paths.journal]), 'pi cannot publish during unfinished undo').toEqual(before);
              }
            }
          } break;
        }
        case 'doctor': { const report = await doctorHerdr(f.request, { targets: async () => [], inspect: async () => ({ failures: [] }), launchHistory: async () => [], probeMachineNode: async () => 'v22.19.0' }); expect(report.failures.map(failure => failure.code)).toEqual((await fs.readFile(f.paths.notes, 'utf8')).includes('notes = true') ? ['native-notes-enabled'] : []); break; }
        case 'undo': case 'undo-replace': if (await attemptUndo(step === 'undo-replace')) failedAttempt = false; break;
        case 'rollback': if (cp?.state === 'undoing') await attemptUndo(true); await rollbackHerdr(f.request, f.parts); expect((await snapshot(f.paths.registry)).hash).toBeNull(); failedAttempt = false; checkpointExpected = false; break;
      }
      if (checkpointExpected) expect(await readCheckpoint(f.request.journalRoot), 'every upgrade prefix retains a checkpoint').not.toBeNull();
      if (checkPrefixes) { await blobs(f); await probe(); }
    } catch (error) { throw new Error(`Sequence: ${steps.slice(0, index + 1).join(' → ')}\n${String(error)}`, { cause: error }); }
  }
}

export type CheckpointModelShard = 0 | 1 | 2 | 3;

export function checkpointModelCases(seed: number, shard: CheckpointModelShard): { sequence: number; steps: Step[] }[] {
  const next = random(seed);
  const cases: { sequence: number; steps: Step[] }[] = [];
  for (let sequence = 0; sequence < 32; sequence++) {
    const steps: Step[] = ['setup', ...Array.from({ length: 3 + next() % 3 }, () => commands[next() % commands.length]!)];
    if (sequence % 4 === shard) cases.push({ sequence, steps });
  }
  return cases;
}

export function registerCheckpointModelSeed(seed: number, shard: CheckpointModelShard): void {
  for (const { sequence, steps } of checkpointModelCases(seed, shard)) {
    test(`model seed=${seed} sequence=${sequence}: ${steps.join(',')}`, () => model(steps));
  }
}
