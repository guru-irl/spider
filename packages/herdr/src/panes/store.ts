// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { CoreId, SessionId, TerminalAddress, TerminalId } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { hash, privateDirectory, readPrivateJson, withProcessLock, writePrivateJson } from '../sessions/registry.js';
import { paneId, parseLegacyPlacementState, parsePanePresentation, parsePlacementState } from './codec.js';
import type { LegacyPlacementState, PanePlacementStore, PanePresentation, PlacementState } from './types.js';
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const empty = (): PlacementState => ({ version: 2, revision: 0, slots: [], attempts: [], presentations: [], choices: [], launches: [] });
const statePath = (root: string) => join(root, 'roam-placement.json');
const backupPath = (root: string) => join(root, 'roam-placement.v1.json');
const panesRootFor = (root: string) => join(dirname(dirname(root)), 'herdr', 'panes');
async function checkPrivate(path: string, directory: boolean, missing = false): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
      throw new HerdrError('unsafe-state-path', 'Pane state must be private and owned by this user');
    return true;
  } catch (error) { if (missing && errorCode(error) === 'ENOENT') return false; throw error; }
}
async function prepareRoot(root: string, key: string): Promise<void> {
  if (!isAbsolute(root)) throw new HerdrError('unsafe-state-path', 'Pane state root must be absolute');
  await privateDirectory(root); await checkPrivate(root, true);
  await checkPrivate(join(root, 'locks'), true, true); await checkPrivate(join(root, 'locks', hash(key)), true, true);
}
async function prepareBindings(root: string): Promise<void> {
  if (!isAbsolute(root)) throw new HerdrError('unsafe-state-path', 'Pane binding root must be absolute');
  await privateDirectory(join(root, 'bindings'));
  await checkPrivate(root, true); await checkPrivate(join(root, 'bindings'), true);
}
async function load(root: string): Promise<PlacementState | LegacyPlacementState> {
  const exists = await checkPrivate(statePath(root), false, true);
  if (await checkPrivate(backupPath(root), false, true)) parseLegacyPlacementState(await readPrivateJson(backupPath(root)));
  const value = await readPrivateJson(statePath(root));
  if (value === null) { if (exists) throw new HerdrError('invalid-placement-state', 'A null placement file is not an empty store'); return empty(); }
  if (typeof value === 'object' && value && 'version' in value && value.version === 1) return parseLegacyPlacementState(value);
  return parsePlacementState(value);
}
/** Read diagnostics without migration, projection repair, directory creation or locks. */
export async function inspectPanePlacement(root: string): Promise<PlacementState> {
  if (!isAbsolute(root)) throw new HerdrError('unsafe-state-path', 'Pane state root must be absolute');
  if (!await checkPrivate(root, true, true)) return empty();
  const state = await load(root); return state.version === 1 ? migrate(state) : state;
}
function migrate(before: LegacyPlacementState): PlacementState {
  const state = { ...empty(), revision: 1, slots: before.slots, attempts: before.attempts };
  for (const [index, attempt] of before.attempts.entries()) {
    if (attempt.proxy === null) continue;
    const remote = attempt.remote.split('/'); const terminalId = remote.at(-1)! as TerminalId;
    const slot = before.slots.find(s => s.session === attempt.session);
    const p: PanePresentation = {
      id: attempt.proxy.includes('/') || before.attempts.filter(a => a.proxy === attempt.proxy).length > 1
        ? `legacy-${hash(JSON.stringify([index, attempt.session, attempt.core, attempt.remote, attempt.proxy]))}` : attempt.proxy, revision: 1, mode: 'proxy', role: 'agent',
      target: { coreId: attempt.core as CoreId, terminalId, address: `${attempt.core}/${terminalId}` as TerminalAddress,
        // Legacy claims have no incarnation proof. Source validation must replace these facts before effects.
        createdMs: 0, identityLabels: { 'spider.session': attempt.session }, alias: remote.length === 2 ? remote[0] : null,
        machineId: null, kind: 'session', sessionId: attempt.session as SessionId, generation: null,
        homeEpoch: null, runId: null, consoleId: null, name: null, cwd: null },
      proxy: attempt.proxy as TerminalAddress, slot: slot ? { space: slot.space as NonNullable<PanePresentation['slot']>['space'], tab: slot.tab as NonNullable<PanePresentation['slot']>['tab'], pane: null } : null,
      visibility: attempt.closed ? 'parked' : 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null,
    };
    state.presentations.push(p);
  }
  return parsePlacementState(state);
}
async function publishProjection(root: string, presentation: PanePresentation, authoritative: boolean): Promise<void> {
  const key = `pane-binding:${presentation.id}`;
  await prepareRoot(root, key); await prepareBindings(root);
  const path = join(root, 'bindings', `${presentation.id}.json`);
  await withProcessLock(root, key, async () => {
    await checkPrivate(path, false, true);
    let previous: unknown;
    try { previous = await readPrivateJson(path); }
    catch (error) { if (!authoritative || !(error instanceof SyntaxError)) throw error; }
    if (!authoritative && previous !== null && previous !== undefined) {
      const parsed = parsePanePresentation(previous);
      if (parsed.revision > presentation.revision || parsed.revision === presentation.revision && JSON.stringify(parsed) !== JSON.stringify(presentation))
        throw new HerdrError('stale-pane-binding', 'A stale projection cannot replace a newer binding');
    }
    if (JSON.stringify(previous) !== JSON.stringify(presentation)) await writePrivateJson(path, presentation);
  });
}
async function publishState(root: string, state: PlacementState): Promise<void> {
  const panesRoot = panesRootFor(root);
  for (const presentation of state.presentations) await publishProjection(panesRoot, presentation, true);
}
/**
 * root is the existing placement directory, join(globalRoot, 'roam', 'placement').
 * The authority stays at root/roam-placement.json. Its binding projections use
 * join(globalRoot, 'herdr', 'panes'), derived from the placement root's two parents.
 * A committed authority is repaired on read after an interrupted projection write.
 */
export function createPanePlacementStore(root: string): PanePlacementStore {
  const transact = async (change?: (state: PlacementState) => PlacementState): Promise<PlacementState> => {
    await prepareRoot(root, 'roam-placement');
    await load(root);
    // Reject unsafe projection destinations before any authoritative mutation.
    const panesRoot = panesRootFor(root); await prepareBindings(panesRoot);
    return withProcessLock(root, 'roam-placement', async () => {
      const before = await load(root);
      const state = before.version === 1 ? migrate(before) : before;
      const revision = state.revision + 1;
      const next = change ? parsePlacementState({ ...change(state), revision }) : state;
      for (const presentation of next.presentations) {
        await checkPrivate(join(panesRoot, 'bindings', `${presentation.id}.json`), false, true);
        await prepareRoot(panesRoot, `pane-binding:${presentation.id}`);
      }
      if (before.version === 1 && !await checkPrivate(backupPath(root), false, true)) await writePrivateJson(backupPath(root), before);
      if (change || before.version === 1) await writePrivateJson(statePath(root), next);
      await publishState(root, next);
      return next;
    });
  };
  return { read: () => transact(), update: change => transact(change) };
}
/**
 * root is join(globalRoot, 'herdr', 'panes'), not the placement directory.
 * Writes only root/bindings/<id>.json and its private lock. This projection is
 * not an authority and never reads or writes join(globalRoot, 'roam', 'placement').
 */
export async function writePaneBinding(root: string, presentation: PanePresentation): Promise<void> {
  await publishProjection(root, parsePanePresentation(presentation), false);
}
/**
 * root is join(globalRoot, 'herdr', 'panes'); reads root/bindings/<id>.json only.
 * Composition derives the separate placement root with join(globalRoot, 'roam', 'placement').
 * Run the placement store's read to repair an interrupted binding publication.
 */
export async function readPaneBinding(root: string, id: string): Promise<PanePresentation | null> {
  paneId(id);
  if (!isAbsolute(root)) throw new HerdrError('unsafe-state-path', 'Pane binding root must be absolute');
  if (!await checkPrivate(root, true, true)) return null;
  if (!await checkPrivate(join(root, 'bindings'), true, true)) return null;
  const path = join(root, 'bindings', `${id}.json`);
  if (!await checkPrivate(path, false, true)) return null;
  const value = await readPrivateJson(path);
  if (value === null) return null;
  const binding = parsePanePresentation(value); if (binding.id !== id) throw new HerdrError('invalid-pane-binding', 'Binding ID differs from its file'); return binding;
}
