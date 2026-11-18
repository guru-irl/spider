// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { chmod, lstat, mkdir, open, readdir, unlink, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { HerdrError, object } from '../client/parse.js';
import type { InstallFile } from './installer.js';
import type { MachineName } from '../contracts.js';
import { restoreLayout } from './layout-undo.js';
import { atomicWrite, digest, snapshot, managedProjection, restoredManaged, rejectSymlinks, type ManagedPart, type SetupJournal } from './backup.js';

export interface SavedFile { path: string; hash: string | null; mode: number }
export interface RecordedRemoteWrite { machine: MachineName; path: string }
export interface UpgradeUndoResult { restored: readonly string[]; remoteNotRestored: readonly RecordedRemoteWrite[] }
interface CheckpointRun {
  before: SavedFile[];
  after: SavedFile[] | null;
  written: SavedFile[];
  planned: SavedFile[];
  effects: string[];
  outcome: 'running' | 'failed' | 'complete';
  remoteWrites: RecordedRemoteWrite[];
  directories: { path: string; dev: number | null; ino: number | null }[];
}
export interface UpgradeCheckpoint {
  version: 2;
  state: 'running' | 'complete' | 'undoing' | 'undone' | 'superseded';
  runs: CheckpointRun[];
  undo?: { phase: 'owners' | 'files'; expected: SavedFile[]; targets: SavedFile[] };
}
const checkpointPath = (root: string) => join(root, 'checkpoint.json');
const blobPath = (root: string, hash: string) => join(root, 'backups', 'checkpoint-' + hash);
const invalid = () => new HerdrError('upgrade-checkpoint-invalid', 'Invalid setup checkpoint. Preserve checkpoint.json and backups, then move checkpoint.json aside to start a new sequence; the old sequence cannot be undone until repaired.');
async function saveBlob(root: string, bytes: Buffer, hash: string): Promise<void> {
  const directory = join(root, 'backups');
  await rejectSymlinks(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = blobPath(root, hash), saved = await snapshot(path);
  if (saved.hash === hash) { await chmod(path, 0o600); return; }
  if (saved.bytes !== null) throw new HerdrError('backup-verification-failed', 'Checkpoint blob differs from its content hash');
  try { await atomicWrite(path, bytes, 0o600, null); }
  catch (error) { if ((await snapshot(path)).hash !== hash) throw error; }
}
async function capture(root: string, paths: readonly string[]): Promise<SavedFile[]> {
  return Promise.all([...new Set(paths)].map(async path => {
    const file = await snapshot(path);
    if (file.bytes !== null) await saveBlob(root, file.bytes, file.hash!);
    return { path, hash: file.hash, mode: file.mode };
  }));
}
export async function checkpointBytes(root: string, file: SavedFile): Promise<Buffer | null> {
  if (file.hash === null) return null;
  const saved = await snapshot(blobPath(root, file.hash));
  if (saved.hash !== file.hash) throw new HerdrError('backup-verification-failed', `Checkpoint blob missing or changed for ${file.path}`);
  return saved.bytes;
}
async function parseFiles(root: string, value: unknown, legacy: boolean): Promise<SavedFile[]> {
  if (!Array.isArray(value)) throw invalid();
  const seen = new Set<string>();
  return Promise.all(value.map(async value => {
    const f = object(value);
    if (typeof f.path !== 'string' || !isAbsolute(f.path) || resolve(f.path) !== f.path || f.path.includes('\0') || seen.has(f.path) || !Number.isInteger(f.mode) || (f.mode as number) < 0 || (f.mode as number) > 0o777 || f.hash !== null && (typeof f.hash !== 'string' || !/^[a-f0-9]{64}$/.test(f.hash))) throw invalid();
    seen.add(f.path);
    if (legacy && f.hash === null && f.bytes !== null) throw invalid();
    if (legacy && f.hash !== null) {
      if (typeof f.bytes !== 'string') throw invalid();
      const bytes = Buffer.from(f.bytes, 'base64');
      if (bytes.toString('base64') !== f.bytes || digest(bytes) !== f.hash) throw invalid();
      await saveBlob(root, bytes, f.hash as string);
    }
    return { path: f.path, hash: f.hash as string | null, mode: f.mode as number };
  }));
}
export async function readCheckpoint(root: string): Promise<UpgradeCheckpoint | null> {
  const file = await snapshot(checkpointPath(root));
  if (file.bytes === null) return null;
  try {
    const c = object(JSON.parse(file.bytes.toString('utf8')));
    if (![1, 2].includes(c.version as number) || !['running', 'complete', 'undoing', 'undone', 'superseded'].includes(String(c.state)) || !Array.isArray(c.runs) || !c.runs.length) throw invalid();
    const runs = await Promise.all(c.runs.map(async value => {
      const run = object(value);
      if (!['running', 'failed', 'complete'].includes(String(run.outcome))) throw invalid();
      const remoteWrites = run.remoteWrites ?? [];
      if (!Array.isArray(remoteWrites)) throw invalid();
      const remote = remoteWrites.map(value => {
        const file = object(value);
        if (typeof file.machine !== 'string' || !file.machine || /[\x00-\x1f\x7f]/.test(file.machine) || typeof file.path !== 'string' || !isAbsolute(file.path) || /[\x00-\x1f\x7f]/.test(file.path)) throw invalid();
        return { machine: file.machine as MachineName, path: file.path };
      });
      const directories = run.directories ?? [];
      if (!Array.isArray(directories)) throw invalid();
      const parsedDirectories = directories.map(value => {
        const d = object(value);
        if (typeof d.path !== 'string' || !isAbsolute(d.path) || resolve(d.path) !== d.path || (d.dev !== null && (!Number.isSafeInteger(d.dev) || (d.dev as number) < 0)) || (d.ino !== null && (!Number.isSafeInteger(d.ino) || (d.ino as number) <= 0)) || (d.dev === null) !== (d.ino === null)) throw invalid();
        return { path: d.path, dev: d.dev as number | null, ino: d.ino as number | null };
      });
      const effects = run.effects ?? [];
      if (!Array.isArray(effects) || effects.some(path => typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.includes('\0'))) throw invalid();
      return { effects: effects as string[], planned: await parseFiles(root, run.planned ?? [], c.version === 1), directories: parsedDirectories, before: await parseFiles(root, run.before, c.version === 1), after: run.after === null ? null : await parseFiles(root, run.after, c.version === 1), outcome: run.outcome as CheckpointRun['outcome'], remoteWrites: remote, written: await parseFiles(root, run.written, c.version === 1) };
    }));
    let undo: UpgradeCheckpoint['undo'];
    if (c.state === 'undoing') {
      const value = object(c.undo);
      if (value.phase !== 'owners' && value.phase !== 'files') throw invalid();
      undo = { phase: value.phase, expected: await parseFiles(root, value.expected, c.version === 1), targets: await parseFiles(root, value.targets ?? runs.flatMap(run => run.before), false) };
    }
    return { version: 2, state: c.state as UpgradeCheckpoint['state'], runs, ...(undo ? { undo } : {}) };
  } catch (error) {
    if (error instanceof HerdrError && error.code === 'backup-verification-failed') throw error;
    throw invalid();
  }
}
async function save(root: string, checkpoint: UpgradeCheckpoint): Promise<void> {
  const path = checkpointPath(root), current = await snapshot(path);
  try { await atomicWrite(path, Buffer.from(JSON.stringify(checkpoint) + '\n'), 0o600, current.hash); }
  finally { await collectCheckpointBlobs(root); }
}
/** Caller holds the setup lock; collect against what reached disk, not memory. */
export async function collectCheckpointBlobs(root: string): Promise<void> {
  const checkpoint = await readCheckpoint(root);
  const referenced = new Set<string>();
  if (checkpoint && checkpoint.state !== 'undone' && checkpoint.state !== 'superseded') {
    for (const run of checkpoint.runs) for (const file of [...run.before, ...run.after ?? [], ...run.planned, ...run.written]) if (file.hash) referenced.add(file.hash);
    if (checkpoint.undo) for (const file of [...checkpoint.undo.expected, ...checkpoint.undo.targets]) if (file.hash) referenced.add(file.hash);
  }
  const directory = join(root, 'backups');
  await rejectSymlinks(directory);
  const names = await readdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return [] as string[]; });
  for (const name of names) if (/^checkpoint-[a-f0-9]{64}(?:\.spider-[a-f0-9-]+)?$/.test(name)) {
    if (name.includes('.spider-') || !referenced.has(name.slice('checkpoint-'.length))) await unlink(join(directory, name));
    else { await rejectSymlinks(join(directory, name)); await chmod(join(directory, name), 0o600); }
  }
  if (names.length) await chmod(directory, 0o700);
}
/** A failed batch may have journalled its intent without publishing every file. */
export async function pendingCheckpointBaselines(root: string): Promise<ReadonlyMap<string, string | null>> {
  const checkpoint = await readCheckpoint(root);
  if (checkpoint?.state !== 'running') return new Map();
  const run = checkpoint.runs.at(-1)!;
  return new Map(run.before.filter(before => !run.written.some(file => file.path === before.path) && (!run.after || run.after.some(after => after.path === before.path && matches(after, before)))).map(file => [file.path, file.hash]));
}
export async function assertSetupNotUndoing(root: string): Promise<void> {
  if ((await readCheckpoint(root))?.state === 'undoing') throw new HerdrError('upgrade-undo-in-progress', 'Finish the interrupted rollback --undo-upgrade before running setup');
}
function expectedRun(run: CheckpointRun): SavedFile[] {
  return [...new Map([...run.before, ...run.planned, ...run.written].map(file => [file.path, file])).values()];
}
export function beginRunCheckpoint(root: string, paths: readonly string[]): Promise<UpgradeCheckpoint>;
export function beginRunCheckpoint(root: string, paths: readonly string[], substantive: boolean): Promise<UpgradeCheckpoint | undefined>;
export async function beginRunCheckpoint(root: string, paths: readonly string[], substantive = true): Promise<UpgradeCheckpoint | undefined> {
  const previous = await readCheckpoint(root);
  if (previous?.state === 'undoing') throw new HerdrError('upgrade-undo-in-progress', 'Finish rollback --undo-upgrade before running setup');
  if (!substantive && (!previous || !['running', 'complete'].includes(previous.state))) return undefined;
  const checkpoint: UpgradeCheckpoint = previous && (previous.state === 'running' || previous.state === 'complete' && (!substantive || previous.runs.at(-1)!.outcome !== 'complete')) ? previous : { version: 2, state: 'running', runs: [] };
  for (const run of checkpoint.runs) if (run.after === null) { await settleInterruptedRun(run); run.outcome = 'failed'; }
  const missing = new Set<string>();
  for (const path of paths) {
    for (let directory = dirname(path); dirname(directory) !== directory; directory = dirname(directory)) {
      try { await lstat(directory); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missing.add(directory); }
    }
  }
  checkpoint.runs.push({ before: await capture(root, paths), after: null, outcome: 'running', remoteWrites: [], written: [], planned: [], effects: [], directories: [...missing].map(path => ({ path, dev: null, ino: null })) });
  await save(root, checkpoint);
  return checkpoint;
}
/** Persist content-addressed intents once before a batch, so a kill between writes is safe. */
export async function recordCheckpointIntents(root: string, checkpoint: UpgradeCheckpoint, files: readonly InstallFile[], journal: SetupJournal): Promise<void> {
  const run = checkpoint.runs.at(-1)!;
  const planned = new Map(run.planned.map(file => [file.path, file]));
  for (const file of files) {
    if (file.snapshotOnly || file.updateAfterCutover) continue;
    const before = run.before.find(state => state.path === file.path)!;
    const hash = digest(file.bytes);
    if (before.hash === hash) continue;
    await saveBlob(root, file.bytes, hash);
    const requested = file.mode ?? journal.entries.find(entry => entry.path === file.path)?.mode ?? 0o600;
    planned.set(file.path, { path: file.path, hash, mode: before.hash === null ? requested & ~process.umask() : requested });
  }
  run.planned = [...planned.values()];
  await save(root, checkpoint);
}
/** Record opaque adapter side effects before entering an external writer. */
export async function recordCheckpointEffects(root: string, checkpoint: UpgradeCheckpoint, paths: readonly string[]): Promise<void> {
  const run = checkpoint.runs.at(-1)!;
  run.effects = [...new Set([...run.effects, ...paths])];
  await save(root, checkpoint);
}
async function settleInterruptedRun(run: CheckpointRun): Promise<void> {
  const expected = expectedRun(run);
  run.after = await Promise.all(expected.map(async file => {
    const current = await snapshot(file.path);
    return [file, run.before.find(before => before.path === file.path)!].find(candidate => matches(current, candidate)) ?? file;
  }));
}
/** Called once per write batch. Only completed writes advance ownership. */
export async function recordCheckpointWrites(root: string, checkpoint: UpgradeCheckpoint, paths: readonly string[]): Promise<void> {
  if (!paths.length) return;
  const run = checkpoint.runs[checkpoint.runs.length - 1]!, states = await capture(root, paths);
  const written = new Map(run.written.map(file => [file.path, file]));
  for (const file of states) written.set(file.path, file);
  run.written = [...written.values()];
  await recordDirectories(checkpoint);
  await save(root, checkpoint);
}
export async function recordRemoteWrite(root: string, checkpoint: UpgradeCheckpoint, machine: MachineName, path: string): Promise<void> {
  const run = checkpoint.runs[checkpoint.runs.length - 1]!;
  if (!run.remoteWrites.some(file => file.machine === machine && file.path === path)) run.remoteWrites.push({ machine, path });
  await save(root, checkpoint);
}
async function recordDirectories(checkpoint: UpgradeCheckpoint): Promise<void> {
  for (const run of checkpoint.runs) for (const directory of run.directories) {
    if (directory.ino !== null) continue;
    await rejectSymlinks(directory.path);
    const info = await lstat(directory.path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info?.isDirectory()) { directory.dev = info.dev; directory.ino = info.ino; }
  }
}
export async function finishRunCheckpoint(root: string, checkpoint: UpgradeCheckpoint, complete: boolean): Promise<void> {
  const run = checkpoint.runs[checkpoint.runs.length - 1]!;
  run.after = await capture(root, run.before.map(file => file.path));
  run.outcome = complete ? 'complete' : 'failed';
  await recordDirectories(checkpoint);
  // A metadata-only run joined to a completed sequence cannot reopen that sequence.
  if (checkpoint.state !== 'complete') checkpoint.state = complete ? 'complete' : 'running';
  await save(root, checkpoint);
}
export async function completeDanglingCheckpoint(root: string): Promise<void> {
  const checkpoint = await readCheckpoint(root);
  if (!checkpoint || !['running', 'complete'].includes(checkpoint.state) || checkpoint.state === 'complete' && checkpoint.runs.at(-1)!.outcome === 'complete') return;
  for (const run of checkpoint.runs) if (run.after === null) { await settleInterruptedRun(run); run.outcome = 'complete'; }
  checkpoint.runs.at(-1)!.outcome = 'complete';
  checkpoint.state = 'complete'; await save(root, checkpoint);
}
export async function supersedeCheckpoint(root: string): Promise<void> {
  const checkpoint = await readCheckpoint(root);
  if (!checkpoint || checkpoint.state === 'undone') return;
  checkpoint.state = 'superseded'; delete checkpoint.undo; await save(root, checkpoint);
}
export function checkpointBaseline(checkpoint: UpgradeCheckpoint): SavedFile[] {
  const first = new Map<string, SavedFile>();
  for (const run of checkpoint.runs) for (const file of run.before) if (!first.has(file.path)) first.set(file.path, file);
  return [...first.values()];
}
function lastObserved(checkpoint: UpgradeCheckpoint): SavedFile[] {
  const last = new Map(checkpointBaseline(checkpoint).map(file => [file.path, file]));
  for (const run of checkpoint.runs) for (const file of [...run.planned, ...run.written]) last.set(file.path, file);
  return [...last.values()];
}
function matches(current: { hash: string | null; mode: number }, saved: SavedFile): boolean {
  return current.hash === saved.hash && (current.hash === null || current.mode === saved.mode);
}
async function restore(root: string, file: SavedFile, expected: SavedFile): Promise<boolean> {
  const current = await snapshot(file.path);
  if (matches(current, file)) return false;
  if (!matches(current, expected)) throw new HerdrError('upgrade-checkpoint-changed', `Changed during undo: ${file.path}. Inspect it or retry rollback --undo-upgrade --replace-changed.`);
  const bytes = await checkpointBytes(root, file);
  if (bytes === null) {
    await unlink(file.path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(file.path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } else await atomicWrite(file.path, bytes, file.mode, current.hash, true);
  return true;
}
export async function undoUpgrade(root: string, options: {
  replaceChanged?: boolean;
  ownerPaths: readonly string[];
  managed: ReadonlyMap<string, ManagedPart>;
  runtimePaths: readonly string[];
  runtimeRewrittenPaths: readonly string[];
  releaseOwners(baseline: readonly SavedFile[], beforeClose: () => Promise<void>): Promise<void>;
  unpublish(baseline: readonly SavedFile[], expected: readonly SavedFile[], didWrite: () => Promise<void>): Promise<readonly string[]>;
  cleanup(baseline: readonly SavedFile[]): Promise<void>;
  layoutPath: string;
  runtimeStorePaths: readonly string[];
  removedMods: readonly string[];
  warn(message: string): void;
}): Promise<UpgradeUndoResult> {
  const checkpoint = await readCheckpoint(root);
  if (!checkpoint || checkpoint.state === 'undone' || checkpoint.state === 'superseded') throw new HerdrError('upgrade-checkpoint-missing', 'No setup upgrade checkpoint is available');
  const resumingOwners = checkpoint.state === 'undoing' && checkpoint.undo!.phase === 'owners';
  if (resumingOwners && !options.replaceChanged) throw new HerdrError('upgrade-undo-interrupted', 'Owner teardown was interrupted after a close began; inspect the recorded owners before retrying with --replace-changed');
  const baseline = checkpointBaseline(checkpoint), journalPath = join(root, 'journal.json');
  const runtime = new Set(options.runtimePaths), expected = checkpoint.undo?.expected ?? lastObserved(checkpoint);
  // Never claim edits made between attempts, including edits merged into a later write.
  for (let i = 1; i < checkpoint.runs.length; i++) {
    const previous = checkpoint.runs[i - 1]!;
    if (previous.outcome !== 'failed') continue;
    const after = previous.after ?? expectedRun(previous);
    for (const before of checkpoint.runs[i]!.before) {
      if (before.path === journalPath || before.path === options.layoutPath || runtime.has(before.path) || options.runtimeRewrittenPaths.includes(before.path) || options.runtimeStorePaths.includes(before.path) || options.replaceChanged) continue;
      const prior = after.find(file => file.path === before.path);
      if (!prior) continue;
      const part = options.managed.get(before.path);
      const same = part ? managedProjection(await checkpointBytes(root, before), part) === managedProjection(await checkpointBytes(root, prior), part) : matches(before, prior);
      if (!same) throw new HerdrError('upgrade-checkpoint-changed', `Changed between failed setup attempts: ${before.path}. Inspect it, then retry rollback --undo-upgrade --replace-changed to restore setup's parts.`);
    }
  }
  const targets: SavedFile[] = checkpoint.undo?.targets ?? [];
  const checked: SavedFile[] = checkpoint.undo?.expected ? [...checkpoint.undo.expected] : [];
  if (checkpoint.state !== 'undoing') {
    for (const original of baseline) {
      const file = expected.find(file => file.path === original.path) ?? original, current = await snapshot(original.path);
      if (current.bytes !== null && process.platform !== 'win32' && (await lstat(original.path)).uid !== process.getuid?.()) throw new HerdrError('upgrade-checkpoint-owner', 'Checkpoint target is not owned by the current user');
      if (runtime.has(original.path) || options.runtimeRewrittenPaths.includes(original.path) && !matches(current, file)) continue;
      if (options.runtimeStorePaths.includes(original.path) && !matches(current, file) && !matches(current, original)) { options.warn(`Runtime store retained: ${original.path}`); continue; }
      const part = options.managed.get(original.path);
      let bytes = await checkpointBytes(root, original), mode = original.mode;
      const observed = await checkpointBytes(root, file);
      if (part) {
        const projection = managedProjection(current.bytes, part);
        if (!options.replaceChanged && projection !== managedProjection(observed, part) && projection !== managedProjection(bytes, part)) throw new HerdrError('upgrade-checkpoint-changed', `Managed part changed after setup: ${original.path}`);
        bytes = restoredManaged(current.bytes, bytes, part);
        if (!matches(current, file)) mode = current.mode;
      } else if (original.path === options.layoutPath) {
        // Reverse each attempted transition. A later intent may not have been
        // applied, and a repeat's before-state can contain app or user edits.
        bytes = current.bytes;
        for (const run of [...checkpoint.runs].reverse()) {
          const before = run.before.find(state => state.path === original.path);
          if (!before) continue;
          const after = expectedRun(run).find(state => state.path === original.path) ?? before;
          bytes = restoreLayout(bytes, await checkpointBytes(root, before), await checkpointBytes(root, after), original.path, !!options.replaceChanged);
        }
        if (current.mode !== file.mode) mode = current.mode;
      } else if (original.path !== journalPath && !options.replaceChanged && !matches(current, file) && !matches(current, original)) {
        // A killed run may have stopped before an intended write. Its baseline is safe too.
        throw new HerdrError('upgrade-checkpoint-changed', `Changed after setup: ${original.path}. Inspect it or use rollback --undo-upgrade --replace-changed.`);
      }
      if (bytes !== null) await saveBlob(root, bytes, digest(bytes));
      targets.push({ path: original.path, hash: bytes === null ? null : digest(bytes), mode });
      if (current.bytes !== null) await saveBlob(root, current.bytes, current.hash!);
      checked.push({ path: original.path, hash: current.hash, mode: current.mode });
    }
    let meaningful = false;
    for (const target of targets) if (target.path !== journalPath && !matches(await snapshot(target.path), target)) meaningful = true;
    if (!meaningful) throw new HerdrError('upgrade-checkpoint-bookkeeping-only', 'This sequence would restore only setup bookkeeping; there is no installed upgrade to undo');
  }
  const assertLayoutReferences = async (layout = targets.find(file => file.path === options.layoutPath)) => {
    if (!layout) return;
    const bytes = await checkpointBytes(root, layout);
    if (!bytes) return;
    const visit = (value: unknown, key = ''): void => {
      if (typeof value === 'string' && ['mod', 'modId', 'toast', 'terminal_menu'].includes(key) && options.removedMods.includes(value)) throw new HerdrError('upgrade-layout-reference', `Layout ${options.layoutPath} still references mod ${value}, which undo would remove. Retain the mod under a custom name and update this reference, or move this layout to a .kept file and retry rollback --undo-upgrade --replace-changed.`);
      if (Array.isArray(value)) value.forEach(child => visit(child, key));
      else if (value && typeof value === 'object') for (const [field, child] of Object.entries(value)) visit(child, field);
    };
    visit(JSON.parse(bytes.toString('utf8')));
  };
  await assertLayoutReferences();
  if (checkpoint.state !== 'undoing' || resumingOwners) {
    const state = checkpoint.state;
    let closing = resumingOwners;
    const beforeClose = async () => {
      if (closing) return;
      checkpoint.state = 'undoing'; checkpoint.undo = { phase: 'owners', expected: checked, targets }; await save(root, checkpoint); closing = true;
    };
    try { await options.releaseOwners(baseline, beforeClose); }
    catch (error) {
      if (!closing && !resumingOwners) { checkpoint.state = state; delete checkpoint.undo; await save(root, checkpoint); }
      throw error;
    }
    const ownerStates = await capture(root, options.ownerPaths);
    for (const owner of ownerStates) {
      const index = targets.findIndex(target => target.path === owner.path);
      if (index < 0) continue;
      if (options.runtimeRewrittenPaths.includes(owner.path) && !matches(owner, checked.find(file => file.path === owner.path)!)) targets[index] = owner;
      if (owner.path === options.layoutPath && !matches(owner, checked.find(file => file.path === owner.path)!)) {
        const target = targets[index]!, observed = checked.find(file => file.path === owner.path)!;
        const bytes = restoreLayout(await checkpointBytes(root, owner), await checkpointBytes(root, target), await checkpointBytes(root, observed), owner.path, !!options.replaceChanged);
        if (bytes !== null) await saveBlob(root, bytes, digest(bytes));
        targets[index] = { path: owner.path, hash: bytes === null ? null : digest(bytes), mode: owner.mode === observed.mode ? target.mode : owner.mode };
      }
      const part = options.managed.get(owner.path);
      if (part) {
        const original = baseline.find(file => file.path === owner.path)!;
        const bytes = restoredManaged(await checkpointBytes(root, owner), await checkpointBytes(root, original), part);
        if (bytes !== null) await saveBlob(root, bytes, digest(bytes));
        targets[index] = { path: owner.path, hash: bytes === null ? null : digest(bytes), mode: owner.mode };
      }
    }
    await assertLayoutReferences();
    checkpoint.state = 'undoing';
    checkpoint.undo = { phase: 'files', targets, expected: checked.map(file => ownerStates.find(state => state.path === file.path) ?? file) };
    await save(root, checkpoint);
  }
  await assertLayoutReferences();
  const recordJournalWrite = async () => {
    const journalState = (await capture(root, [journalPath]))[0]!;
    checkpoint.undo!.expected = checkpoint.undo!.expected.map(file => file.path === journalPath ? journalState : file);
    await save(root, checkpoint);
  };
  const restored = [...await options.unpublish(baseline, checkpoint.undo!.expected, recordJournalWrite)];
  for (const file of targets.filter(file => file.path !== journalPath)) {
    const expected = checkpoint.undo!.expected.find(item => item.path === file.path)!;
    if ((options.runtimeRewrittenPaths.includes(file.path) || options.runtimeStorePaths.includes(file.path)) && !matches(await snapshot(file.path), expected) && !matches(await snapshot(file.path), file)) {
      if (options.runtimeStorePaths.includes(file.path)) options.warn(`Runtime store retained: ${file.path}`);
      const current = (await capture(root, [file.path]))[0]!;
      Object.assign(file, current);
      await save(root, checkpoint);
      continue;
    }
    const current = await snapshot(file.path);
    if (!matches(current, file) && !matches(current, expected)) {
      const part = options.managed.get(file.path);
      let bytes = await checkpointBytes(root, file);
      if (file.path === options.layoutPath) bytes = restoreLayout(current.bytes, bytes, await checkpointBytes(root, expected), file.path, !!options.replaceChanged);
      else if (part) {
        const actual = managedProjection(current.bytes, part);
        if (!options.replaceChanged && actual !== managedProjection(bytes, part) && actual !== managedProjection(await checkpointBytes(root, expected), part)) throw new HerdrError('upgrade-checkpoint-changed', `Managed part changed during undo: ${file.path}. Inspect it or retry rollback --undo-upgrade --replace-changed.`);
        bytes = restoredManaged(current.bytes, bytes, part);
      } else if (!options.replaceChanged) throw new HerdrError('upgrade-checkpoint-changed', `Changed during undo: ${file.path}. Inspect it or retry rollback --undo-upgrade --replace-changed.`);
      if (bytes !== null) await saveBlob(root, bytes, digest(bytes));
      if (current.bytes !== null) await saveBlob(root, current.bytes, current.hash!);
      if ((part || file.path === options.layoutPath) && current.hash !== null && current.mode !== expected.mode) file.mode = current.mode;
      const hash = bytes === null ? null : digest(bytes);
      if (file.path === options.layoutPath) await assertLayoutReferences({ ...file, hash });
      file.hash = hash;
      Object.assign(expected, { hash: current.hash, mode: current.mode });
      await save(root, checkpoint);
    }
    if (await restore(root, file, expected)) restored.push(file.path);
  }
  await options.cleanup(baseline);
  const directories = new Map(checkpoint.runs.flatMap(run => run.directories).map(directory => [directory.path, directory]));
  for (const directory of [...directories.values()].sort((a, b) => b.path.length - a.path.length)) {
    if (directory.ino === null) continue;
    await rejectSymlinks(directory.path);
    try {
      const info = await lstat(directory.path);
      if (info.isDirectory() && info.dev === directory.dev && info.ino === directory.ino) await rmdir(directory.path);
    } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  const journal = targets.find(file => file.path === journalPath);
  // This is setup-owned bookkeeping under the setup lock. A crash may have
  // saved the journal without advancing its checkpoint observation.
  if (journal && await restore(root, journal, (await capture(root, [journalPath]))[0]!)) restored.push(journal.path);
  for (const file of targets) if (!matches(await snapshot(file.path), file)) throw new HerdrError('upgrade-checkpoint-changed', `Changed while undo completed: ${file.path}`);
  checkpoint.state = 'undone'; delete checkpoint.undo; await save(root, checkpoint);
  const remoteNotRestored = [...new Map(checkpoint.runs.flatMap(run => run.remoteWrites).map(file => [JSON.stringify([file.machine, file.path]), file])).values()];
  return { restored, remoteNotRestored };
}
/** Full rollback removes the endpoint publication, including legacy installations. */
export async function includeRegistryCheckpoint(root: string, journal: SetupJournal, registry: string): Promise<void> {
  const checkpoint = await readCheckpoint(root);
  if (checkpoint?.state === 'undoing') throw new HerdrError('upgrade-undo-in-progress', 'Finish rollback --undo-upgrade before full rollback');
  if (journal.entries.some(entry => entry.path === registry)) return;
  const expected = checkpoint && checkpoint.state !== 'undone' && checkpoint.state !== 'superseded' ? lastObserved(checkpoint).find(file => file.path === registry) : undefined;
  const current = await snapshot(registry);
  if (expected?.hash === null || !expected && current.hash === null) return;
  journal.entries.push({ path: registry, before: null, after: expected?.hash ?? current.hash!, backup: null, mode: current.mode });
}
