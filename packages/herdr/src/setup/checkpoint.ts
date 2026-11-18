// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { lstat, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { HerdrError, object } from '../client/parse.js';
import type { MachineName } from '../contracts.js';
import { atomicWrite, digest, snapshot, type SetupJournal } from './backup.js';

interface SavedFile {
  path: string;
  bytes: string | null;
  hash: string | null;
  mode: number;
}
export interface RecordedRemoteWrite { machine: MachineName; path: string }
export interface UpgradeUndoResult { restored: readonly string[]; remoteNotRestored: readonly RecordedRemoteWrite[] }
interface CheckpointRun {
  before: SavedFile[];
  after: SavedFile[] | null;
  written: SavedFile[];
  outcome: 'running' | 'failed' | 'complete';
  remoteWrites: RecordedRemoteWrite[];
}
export interface UpgradeCheckpoint {
  version: 1;
  state: 'running' | 'complete' | 'undoing' | 'undone';
  runs: CheckpointRun[];
  undo?: { phase: 'owners' | 'files'; expected: SavedFile[] };
}
const checkpointPath = (root: string) => join(root, 'checkpoint.json');
async function capture(paths: readonly string[]): Promise<SavedFile[]> {
  return Promise.all([...new Set(paths)].map(async path => {
    const file = await snapshot(path);
    return { path, bytes: file.bytes?.toString('base64') ?? null, hash: file.hash, mode: file.mode };
  }));
}
function parseFiles(value: unknown): SavedFile[] {
  const invalid = () => new HerdrError('upgrade-checkpoint-invalid', 'Invalid setup checkpoint file');
  if (!Array.isArray(value)) throw invalid();
  const seen = new Set<string>();
  return value.map(value => {
    const f = object(value);
    if (typeof f.path !== 'string' || !isAbsolute(f.path) || resolve(f.path) !== f.path || f.path.includes('\0') || seen.has(f.path) || !Number.isInteger(f.mode) || (f.mode as number) < 0 || (f.mode as number) > 0o777) throw invalid();
    seen.add(f.path);
    if (f.bytes === null && f.hash === null) return { path: f.path, bytes: null, hash: null, mode: f.mode as number };
    if (typeof f.bytes !== 'string' || typeof f.hash !== 'string') throw invalid();
    const bytes = Buffer.from(f.bytes, 'base64');
    if (bytes.toString('base64') !== f.bytes || digest(bytes) !== f.hash) throw invalid();
    return { path: f.path, bytes: f.bytes, hash: f.hash, mode: f.mode as number };
  });
}
export async function readCheckpoint(root: string): Promise<UpgradeCheckpoint | null> {
  const file = await snapshot(checkpointPath(root));
  if (file.bytes === null) return null;
  const c = object(JSON.parse(file.bytes.toString('utf8')));
  if (c.version !== 1 || !['running', 'complete', 'undoing', 'undone'].includes(String(c.state)) || !Array.isArray(c.runs) || !c.runs.length) throw new HerdrError('upgrade-checkpoint-invalid', 'Unknown setup checkpoint format');
  const runs = c.runs.map(value => {
    const run = object(value);
    if (!['running', 'failed', 'complete'].includes(String(run.outcome))) throw new HerdrError('upgrade-checkpoint-invalid', 'Invalid setup run outcome');
    const remoteWrites = run.remoteWrites ?? [];
    if (!Array.isArray(remoteWrites)) throw new HerdrError('upgrade-checkpoint-invalid', 'Invalid recorded remote writes');
    const remote = remoteWrites.map(value => {
      const file = object(value);
      if (typeof file.machine !== 'string' || !file.machine || /[\x00-\x1f\x7f]/.test(file.machine) || typeof file.path !== 'string' || !isAbsolute(file.path) || /[\x00-\x1f\x7f]/.test(file.path)) throw new HerdrError('upgrade-checkpoint-invalid', 'Invalid recorded remote file');
      return { machine: file.machine as MachineName, path: file.path };
    });
    return { before: parseFiles(run.before), after: run.after === null ? null : parseFiles(run.after), outcome: run.outcome as CheckpointRun['outcome'], remoteWrites: remote, written: parseFiles(run.written) };
  });
  let undo: UpgradeCheckpoint['undo'];
  if (c.state === 'undoing') {
    const value = object(c.undo);
    if (value.phase !== 'owners' && value.phase !== 'files') throw new HerdrError('upgrade-checkpoint-invalid', 'Invalid undo progress');
    undo = { phase: value.phase, expected: parseFiles(value.expected) };
  }
  return { version: 1, state: c.state as UpgradeCheckpoint['state'], runs, ...(undo ? { undo } : {}) };
}
async function save(root: string, checkpoint: UpgradeCheckpoint): Promise<void> {
  const path = checkpointPath(root), current = await snapshot(path);
  await atomicWrite(path, Buffer.from(JSON.stringify(checkpoint, null, 2) + '\n'), 0o600, current.hash);
}
export async function assertSetupNotUndoing(root: string): Promise<void> {
  if ((await readCheckpoint(root))?.state === 'undoing') throw new HerdrError('upgrade-undo-in-progress', 'Finish the interrupted rollback --undo-upgrade before running setup');
}
export async function beginRunCheckpoint(root: string, paths: readonly string[]): Promise<UpgradeCheckpoint> {
  const previous = await readCheckpoint(root);
  if (previous?.state === 'undoing') throw new HerdrError('upgrade-undo-in-progress', 'Finish rollback --undo-upgrade before running setup');
  const checkpoint: UpgradeCheckpoint = previous?.state === 'running' ? previous : { version: 1, state: 'running', runs: [] };
  checkpoint.runs.push({ before: await capture(paths), after: null, outcome: 'running', remoteWrites: [], written: [] });
  await save(root, checkpoint);
  return checkpoint;
}
/** Only actual writes advance ownership; observing a user edit on retry does not. */
export async function recordCheckpointWrites(root: string, checkpoint: UpgradeCheckpoint, paths: readonly string[]): Promise<void> {
  if (!paths.length) return;
  const run = checkpoint.runs[checkpoint.runs.length - 1]!, states = await capture(paths);
  const written = new Map(run.written.map(file => [file.path, file]));
  for (const file of states) written.set(file.path, file);
  run.written = [...written.values()];
  await save(root, checkpoint);
}
/** Persist the write intent before sending bytes, so an interrupted upload is never omitted. */
export async function recordRemoteWrite(root: string, checkpoint: UpgradeCheckpoint, machine: MachineName, path: string): Promise<void> {
  const run = checkpoint.runs[checkpoint.runs.length - 1]!;
  if (!run.remoteWrites.some(file => file.machine === machine && file.path === path)) run.remoteWrites.push({ machine, path });
  await save(root, checkpoint);
}
export async function finishRunCheckpoint(root: string, checkpoint: UpgradeCheckpoint, complete: boolean): Promise<void> {
  const run = checkpoint.runs[checkpoint.runs.length - 1]!;
  run.after = await capture(run.before.map(file => file.path));
  run.outcome = complete ? 'complete' : 'failed';
  checkpoint.state = complete ? 'complete' : 'running';
  await save(root, checkpoint);
}
export function checkpointBaseline(checkpoint: UpgradeCheckpoint): SavedFile[] {
  const first = new Map<string, SavedFile>();
  for (const run of checkpoint.runs) for (const file of run.before) if (!first.has(file.path)) first.set(file.path, file);
  return [...first.values()];
}
function lastObserved(checkpoint: UpgradeCheckpoint): SavedFile[] {
  const last = new Map(checkpointBaseline(checkpoint).map(file => [file.path, file]));
  for (const run of checkpoint.runs) for (const file of run.written) last.set(file.path, file);
  return [...last.values()];
}
function matches(current: Awaited<ReturnType<typeof snapshot>>, saved: SavedFile): boolean {
  return current.hash === saved.hash && (current.bytes === null || current.mode === saved.mode);
}
async function restore(file: SavedFile, expected?: SavedFile, replaceChanged = false): Promise<boolean> {
  const current = await snapshot(file.path);
  if (expected && !replaceChanged && !matches(current, file) && !matches(current, expected)) throw new HerdrError('upgrade-checkpoint-changed', `Changed during undo: ${file.path}`);
  if (matches(current, file)) return false;
  if (file.bytes === null) {
    await unlink(file.path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(file.path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } else await atomicWrite(file.path, Buffer.from(file.bytes, 'base64'), file.mode, current.hash);
  return true;
}
export async function undoUpgrade(root: string, options: {
  replaceChanged?: boolean;
  ownerPaths: readonly string[];
  releaseOwners(): Promise<void>;
  cleanup(baseline: readonly SavedFile[]): Promise<void>;
}): Promise<UpgradeUndoResult> {
  const checkpoint = await readCheckpoint(root);
  if (!checkpoint || checkpoint.state === 'undone') throw new HerdrError('upgrade-checkpoint-missing', 'No setup upgrade checkpoint is available');
  if (checkpoint.state === 'undoing' && checkpoint.undo!.phase === 'owners' && !options.replaceChanged) throw new HerdrError('upgrade-undo-interrupted', 'Owner teardown was interrupted; inspect owners before retrying with --replace-changed');
  if (checkpoint.runs.some(run => run.after === null) && !options.replaceChanged) throw new HerdrError('upgrade-checkpoint-incomplete', 'A setup run stopped without a final snapshot; inspect changes before using --replace-changed');
  const baseline = checkpointBaseline(checkpoint), expected = checkpoint.undo?.expected ?? lastObserved(checkpoint);
  // Refuse the entire operation before tearing down owners or restoring the first file.
  for (const file of expected) {
    const current = await snapshot(file.path), original = baseline.find(item => item.path === file.path)!;
    if (!options.replaceChanged && !matches(current, file) && !(checkpoint.state === 'undoing' && checkpoint.undo!.phase === 'files' && matches(current, original)))
      throw new HerdrError('upgrade-checkpoint-changed', `Changed after setup: ${file.path}. Inspect it or use rollback --undo-upgrade --replace-changed.`);
    if (current.bytes !== null && process.platform !== 'win32' && (await lstat(file.path)).uid !== process.getuid?.()) throw new HerdrError('upgrade-checkpoint-owner', 'Checkpoint target is not owned by the current user');
  }
  if (checkpoint.state !== 'undoing' || checkpoint.undo!.phase === 'owners') {
    const previousState = checkpoint.state === 'complete' ? 'complete' : 'running';
    checkpoint.state = 'undoing'; checkpoint.undo = { phase: 'owners', expected };
    await save(root, checkpoint);
    try { await options.releaseOwners(); }
    catch (error) {
      if (error instanceof HerdrError && ['cutover-owner-live', 'cutover-owner-conflict', 'cutover-reconciliation-required'].includes(error.code)) {
        checkpoint.state = previousState; delete checkpoint.undo; await save(root, checkpoint);
      }
      throw error;
    }
    const ownerStates = await capture(options.ownerPaths);
    checkpoint.undo = { phase: 'files', expected: expected.map(file => ownerStates.find(state => state.path === file.path) ?? file) };
    await save(root, checkpoint);
  }
  const restored: string[] = [], journalPath = join(root, 'journal.json');
  for (const file of baseline.filter(file => file.path !== journalPath)) {
    const expected = checkpoint.undo!.expected.find(item => item.path === file.path)!;
    if (await restore(file, expected, options.replaceChanged)) restored.push(file.path);
  }
  await options.cleanup(baseline);
  const journal = baseline.find(file => file.path === journalPath);
  if (journal && await restore(journal, checkpoint.undo!.expected.find(file => file.path === journalPath), options.replaceChanged)) restored.push(journal.path);
  for (const file of baseline)
    if (!matches(await snapshot(file.path), file)) throw new HerdrError('upgrade-checkpoint-changed', `Changed while undo completed: ${file.path}`);
  checkpoint.state = 'undone'; delete checkpoint.undo; await save(root, checkpoint);
  const remoteNotRestored = [...new Map(checkpoint.runs.flatMap(run => run.remoteWrites).map(file => [JSON.stringify([file.machine, file.path]), file])).values()];
  return { restored, remoteNotRestored };
}
/** Add the endpoint to ordinary full rollback, including its conflict and retry handling. */
export async function includeRegistryCheckpoint(root: string, journal: SetupJournal, registry: string): Promise<void> {
  const checkpoint = await readCheckpoint(root);
  if (!checkpoint || checkpoint.state === 'undone') return;
  if (checkpoint.state === 'undoing') throw new HerdrError('upgrade-undo-in-progress', 'Finish rollback --undo-upgrade before full rollback');
  const original = checkpointBaseline(checkpoint).find(file => file.path === registry), expected = lastObserved(checkpoint).find(file => file.path === registry);
  if (!original || !expected || expected.hash === null) return;
  const backup = original.bytes === null ? null : join(root, 'backups', digest(Buffer.from(registry)) + '-' + original.hash);
  if (backup && original.bytes !== null) {
    const saved = await snapshot(backup);
    if (saved.hash !== original.hash) await atomicWrite(backup, Buffer.from(original.bytes, 'base64'), 0o600, saved.hash);
  }
  journal.entries = [...journal.entries.filter(entry => entry.path !== registry), { path: registry, before: original.hash, after: expected.hash, backup, mode: original.mode }];
}
