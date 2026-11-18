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

type Step = 'setup' | 'replace' | 'fail-retry' | 'bookkeeping' | 'remote' | 'layout-only' | 'shell' | 'keys' | 'settings' | 'pi' | 'app' | 'template' | 'move' | 'journal-crash' | 'batch-crash' | 'cutover-crash' | 'undo-crash' | 'pi-during-undo' | 'doctor' | 'undo' | 'undo-replace' | 'rollback';
const commands: readonly Step[] = ['setup', 'replace', 'fail-retry', 'bookkeeping', 'remote', 'layout-only', 'shell', 'keys', 'settings', 'pi', 'app', 'template', 'move', 'journal-crash', 'batch-crash', 'cutover-crash', 'undo-crash', 'pi-during-undo', 'doctor', 'undo', 'undo-replace', 'rollback'];
const seeds = [1, 17, 182, 116, 4093, 65537, 0x12345678, 0xdeadbeef];
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
  for (const name of names) expect((await fs.stat(join(directory, name))).mode & 0o777).toBe(0o600);
}

/** Each prefix is checked on disk, then restored at the same absolute paths. */
async function model(steps: readonly Step[], checkPrefixes = true) {
  const f = await fixture(), root = f.request.packageRoot;
  const owned = [f.paths.font, f.paths.theme, f.paths.svg, f.paths.main, f.paths.manifest, f.paths.appSettings, f.paths.notes, f.paths.registry];
  let baseline = await values(owned);
  let settingsBaseline = JSON.parse(await fs.readFile(f.paths.settings, 'utf8'));
  let keysBaseline = JSON.parse(await fs.readFile(f.paths.keys, 'utf8'));
  let layoutBaseline: string | null = (await snapshot(f.paths.layout)).bytes?.toString() ?? null;
  let instructionBaseline: string | null = null;
  const rememberBaseline = async () => {
    baseline = await values(owned);
    settingsBaseline = JSON.parse(await fs.readFile(f.paths.settings, 'utf8'));
    keysBaseline = JSON.parse(await fs.readFile(f.paths.keys, 'utf8'));
    layoutBaseline = (await snapshot(f.paths.layout)).bytes?.toString() ?? null;
    instructionBaseline = (await snapshot(f.paths.added)).bytes?.toString() ?? null;
  };
  const preflight = f.parts.preflight;
  f.parts.preflight = async (...args) => ({ ...await preflight(...args), cutoverProvedAbsent: true });
  const oldLayout = JSON.stringify({ content: [{ id: 'pane', mod: 'spider-example', props: { version: 1 } }], generation: 1 });
  const nextLayout = { content: [{ id: 'pane', mod: 'spider-example', props: { version: 2 } }], generation: 2 };
  await put(f.paths.layout, oldLayout);
  const legacy = await readJournal(f.request.journalRoot); legacy.entries.find(entry => entry.path === f.paths.layout)!.after = digest(Buffer.from(oldLayout)); await saveJournal(f.request.journalRoot, legacy);
  layoutBaseline = oldLayout;
  const storeCopy = join(f.request.config.app.home, 'data/spider-example', modStoreFileName({ version: 2 }));
  await put(join(dirname(storeCopy), modStoreFileName({ version: 1 })), 'old store');
  const stage = f.parts.stageLook;
  f.parts.stageLook = async (...args) => (await stage(...args)).map(file => file.path === f.paths.layout ? { ...file, bytes: Buffer.from(JSON.stringify(nextLayout)) } : file);
  let shellEdit = false, settingsEdit = false, keysEdit = false, move = false, templateEdit = false, appEdit = false, failedAttempt = false;
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
    try { await undoHerdrUpgrade({ ...f.request, replaceChanged }, f.parts); }
    catch (error) {
      expect(error).toBeInstanceOf(HerdrError);
      const e = error as HerdrError;
      if (e.code === 'upgrade-checkpoint-missing') return false;
      if (e.code === 'upgrade-checkpoint-bookkeeping-only') { expect(await values(owned), 'an installed upgrade still needs its baseline').toEqual(baseline); return false; }
      expect(['upgrade-checkpoint-changed', 'upgrade-undo-interrupted']).toContain(e.code);
      if (e.code === 'upgrade-checkpoint-changed') expect(e.message).toMatch(/\/(?:[^\s]+) /);
      await undoHerdrUpgrade({ ...f.request, replaceChanged: true }, f.parts);
    }
    expect(await values(owned)).toEqual(baseline);
    if (shellEdit) expect(await fs.readFile(shell, 'utf8')).toContain('alias user=true');
    expect(JSON.parse(await fs.readFile(f.paths.settings, 'utf8'))).toEqual({ ...settingsBaseline, ...(settingsEdit ? { user: 'keep' } : {}) });
    expect(JSON.parse(await fs.readFile(f.paths.keys, 'utf8'))).toEqual({ ...keysBaseline, global: { ...keysBaseline.global, ...(keysEdit ? { 'ctrl-z': 'user.action' } : {}) } });
    if (move) expect(await fs.readFile(f.paths.spaces, 'utf8')).toContain('moved');
    expect((await snapshot(f.paths.added)).bytes?.toString() ?? null).toBe(templateEdit ? 'runtime instructions' : instructionBaseline);
    const layout = (await snapshot(f.paths.layout)).bytes?.toString() ?? '';
    const expectedLayout = layoutBaseline === null ? null : JSON.parse(layoutBaseline);
    expect(layout ? JSON.parse(layout) : null).toEqual(appEdit ? { ...expectedLayout, userSize: 321 } : expectedLayout);
    if (appEdit) expect(await fs.readFile(storeCopy, 'utf8')).toBe('runtime store');
    const names = [...layout.matchAll(/spider-[a-z-]+/g)].map(match => match[0]);
    for (const name of names) expect((await snapshot(join(f.request.config.app.home, 'mods', name, 'mod.json'))).hash, `layout reference ${name}`).not.toBeNull();
    if (checkPrefixes) await blobs(f);
    return true;
  };
  const probe = async () => {
    const copy = root + '-probe';
    await fs.cp(root, copy, { recursive: true, preserveTimestamps: true });
    try {
      const undone = await attemptUndo();
      if (undone && !shellEdit && !settingsEdit && !keysEdit && !templateEdit && !move && !appEdit) {
        await rollbackHerdr(f.request, f.parts);
        expect((await snapshot(f.paths.registry)).hash, 'full rollback after undo removes the registry').toBeNull();
        expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); await real.rename(copy, root); }
  };
  const interrupted = async (work: () => Promise<unknown>, matches: (target: string) => boolean, after: boolean) => {
    let fired = false;
    const hook = (operation: typeof real.rename) => async (from: Parameters<typeof real.rename>[0], to: Parameters<typeof real.rename>[1]) => {
      if (fired) throw new Error('model crash');
      const hit = matches(String(to));
      if (hit && !after) { fired = true; throw new Error('model crash'); }
      await operation(from, to);
      if (hit) { fired = true; throw new Error('model crash'); }
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
        try { await setupHerdr({ ...f.request, replaceChanged }, f.parts); }
        catch (error) {
          if (!(error instanceof HerdrError) || !['unowned-clone-collision', 'managed-artifact-changed'].includes(error.code)) throw error;
          expect(error.message).toContain('--replace-changed');
          await setupHerdr({ ...f.request, replaceChanged: true }, f.parts);
        }
        failedAttempt = false;
      };
      if ((!cp || ['undone', 'superseded'].includes(cp.state)) && ['bookkeeping', 'journal-crash'].includes(step)) await rememberBaseline();
      switch (step) {
        case 'setup': case 'replace': await setup(step === 'replace'); break;
        case 'bookkeeping': try { await metadataRepeat(f); } catch (error) { if (!(error instanceof HerdrError) || !['unowned-clone-collision', 'managed-artifact-changed'].includes(error.code)) throw error; expect(error.message).toContain('--replace-changed'); await metadataRepeat(f, true); } failedAttempt = false; break;
        case 'remote': {
          const bytes = Buffer.from('runtime-v2'), machine = 'box-1.invalid' as import('../contracts.js').MachineName;
          let remote: Buffer | null = null;
          f.parts.ensureRuntime = async () => [{ machine, path: '/home/fixture/runtime.mjs', bytes, sha256: digest(bytes) }];
          f.parts.hc = { fileRead: async () => { if (!remote) throw new HerdrError('file-not-found', 'absent'); return remote; }, fileWrite: async (_, __, bytes) => { remote = bytes; } };
          await setup(); break;
        }
        case 'layout-only': {
          const stage = f.parts.stageLook;
          f.parts.stageLook = async (...args) => (await stage(...args)).map(file => file.path === f.paths.layout ? { ...file, bytes: Buffer.from(JSON.stringify({ ...nextLayout, generation: 3 })) } : file);
          await setup(); break;
        }
        case 'shell': shellEdit = true; await fs.appendFile(shell, 'alias user=true\n'); break;
        case 'settings': case 'pi': settingsEdit = true; await put(f.paths.settings, JSON.stringify({ ...JSON.parse(await fs.readFile(f.paths.settings, 'utf8')), user: 'keep' })); break;
        case 'keys': { keysEdit = true; const keys = JSON.parse(await fs.readFile(f.paths.keys, 'utf8')); keys.global['ctrl-z'] = 'user.action'; await put(f.paths.keys, JSON.stringify(keys)); break; }
        case 'app': { const current = await snapshot(f.paths.layout); if (!current.bytes) break; appEdit = true; await put(f.paths.layout, JSON.stringify({ ...JSON.parse(current.bytes.toString()), userSize: 321 })); await put(storeCopy, 'runtime store'); break; }
        case 'template': templateEdit = true; await put(f.paths.added, 'runtime instructions'); f.parts.generateTemplates = async () => [{ path: f.paths.added, expected: (await snapshot(f.paths.added)).hash, bytes: Buffer.from('runtime instructions') }]; { const journal = await readJournal(f.request.journalRoot), entry = journal.entries.find(entry => entry.path === f.paths.added); if (entry) { entry.after = digest(Buffer.from('runtime instructions')); await saveJournal(f.request.journalRoot, journal); } } break;
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
          f.fail(false); failedAttempt = true; break;
        }
        case 'undo-crash': case 'pi-during-undo': {
          if (cp && !['undone', 'superseded'].includes(cp.state)) {
            await interrupted(() => undoHerdrUpgrade(f.request, f.parts), target => target === f.paths.main, false);
            if (step === 'pi-during-undo') { await put(f.paths.added, 'runtime instructions'); templateEdit = true; f.parts.generateTemplates = async () => [{ path: f.paths.added, expected: (await snapshot(f.paths.added)).hash, bytes: Buffer.from('runtime instructions') }]; }
          } break;
        }
        case 'doctor': { const report = await doctorHerdr(f.request, { targets: async () => [], inspect: async () => ({ failures: [] }), launchHistory: async () => [], probeMachineNode: async () => 'v22.19.0' }); expect(report.failures.map(failure => failure.code)).toEqual((await fs.readFile(f.paths.notes, 'utf8')).includes('notes = true') ? ['native-notes-enabled'] : []); break; }
        case 'undo': case 'undo-replace': if (await attemptUndo(step === 'undo-replace')) failedAttempt = false; break;
        case 'rollback': if (cp?.state === 'undoing') await attemptUndo(true); await rollbackHerdr(f.request, f.parts); expect((await snapshot(f.paths.registry)).hash).toBeNull(); failedAttempt = false; templateEdit = templateEdit && (await snapshot(f.paths.added)).hash !== null; break;
      }
      if (checkPrefixes) { await blobs(f); await probe(); }
    } catch (error) { throw new Error(`Sequence: ${steps.slice(0, index + 1).join(' → ')}\n${String(error)}`, { cause: error }); }
  }
}

test('N1 minimal: setup → settings → bookkeeping → undo', () => model(['setup', 'settings', 'bookkeeping', 'undo'], false));
test('N2 minimal: setup → remote → undo', () => model(['setup', 'remote', 'undo'], false));
test('N6 minimal: setup → undo → full rollback', () => model(['setup', 'undo', 'rollback'], false));
test('N2 minimal: failed join → killed retry → undo retains the original layout', () => model(['setup', 'cutover-crash', 'batch-crash', 'undo'], false));
for (const seed of seeds) {
  const next = random(seed);
  for (let sequence = 0; sequence < 32; sequence++) {
    const steps: Step[] = ['setup', ...Array.from({ length: 3 + next() % 3 }, () => commands[next() % commands.length]!)];
    test(`model seed=${seed} sequence=${sequence}: ${steps.join(',')}`, () => model(steps));
  }
}
