// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { isDeepStrictEqual } from 'node:util';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { AppClient, HcClient, Owner, OwnerPlacement, SessionId, SpaceId, TabId, TerminalAddress, TerminalSummary } from './contracts.js';
import type { PaneActionOutcome, PanePresentation, PaneServiceReply, PaneServiceRequest, PaneTarget } from './panes/types.js';
import { samePaneTarget } from './panes/lifecycle.js';
import { HERDR_LABELS } from './contracts.js';
import { HerdrError } from './client/parse.js';
import { placePaneWithoutFocus } from './jobs/placement.js';
import { createPanePlacementStore, inspectPanePlacement } from './panes/store.js';
import { parsePaneServiceRequest } from './panes/codec.js';
import { hash, privateDirectory, readPrivateJson, writePrivateJson, withProcessLock, type TerminalRegistry } from './sessions/registry.js';

type Slot = Pick<OwnerPlacement, 'space' | 'tab'>;
import type { Readiness } from "@spider/db-core/roam/types";
type LaunchFailure = { attempts: number; retryable: boolean };
type Attempt = { session: string; remote: string; core: string; proxy: string | null; closed: boolean; localOwners: string[]; failure?: LaunchFailure };
type State = { slots: { session: string; space: string; tab: string }[]; attempts: Attempt[] };
const MAX_LAUNCH_ATTEMPTS = 2;
type Options = { app: AppClient | null; hc: HcClient; registry: TerminalRegistry; hcBinary: string; stateRoot: string;
  removedSessions?: (sessions: readonly string[]) => Promise<ReadonlySet<string>>;
  presentation?: { resolveTarget(ready: Readiness): Promise<PaneTarget | null>; presentReadyTarget(target: PaneTarget): Promise<PaneActionOutcome> } };
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined;
export { launchNotStarted } from './client/launch-outcome.js';
const appUnavailable = (error: unknown) => ['owner-unplaced', 'app-disconnected', 'cli-exit', 'missing-app', 'pane-timeout'].includes(String(errorCode(error)));
const localSlot = (slot: { space: string; tab: string }) => !!slot.space && !!slot.tab && !slot.space.includes('/') && !slot.tab.includes('/');
const ownerKey = (owner: Owner) => hash(JSON.stringify([owner.terminal.coreId, owner.terminal.terminalId, owner.terminal.socket, owner.terminal.sessionNamespace]));

async function checkPrivate(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())))
    throw new HerdrError('unsafe-state-path', 'Placement state must be private and owned by this user');
}
async function prepareRoot(root: string): Promise<void> {
  if (!isAbsolute(root)) throw new HerdrError('unsafe-state-path', 'Placement state root must be absolute');
  await privateDirectory(root);
  await checkPrivate(root, true);
  for (const directory of [join(root, 'locks'), join(root, 'locks', hash('roam-placement'))]) {
    try { await checkPrivate(directory, true); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  }
}
async function load(root: string, create = true): Promise<State> {
  return create ? createPanePlacementStore(root).read() : inspectPanePlacement(root);
}

/** Inspect placement failures without creating the directory or acquiring a write lock. */
export async function inspectRoamPlacement(root: string): Promise<Array<{ session: string; remote: string; status: 'retryable' | 'exhausted' | 'uncertain' }>> {
  const state = await load(root, false);
  return state.attempts.filter(attempt => !attempt.proxy && !attempt.closed).map(attempt => ({
    session: attempt.session, remote: attempt.remote,
    status: !attempt.failure?.retryable ? 'uncertain' : attempt.failure.attempts < MAX_LAUNCH_ATTEMPTS ? 'retryable' : 'exhausted',
  }));
}
function setSlot(state: State, session: string, slot: Slot): void {
  if (!session || !localSlot(slot)) throw new HerdrError('invalid-placement-slot', 'Placement requires a local space and tab');
  const previous = state.slots.find(s => s.session === session);
  if (previous) { previous.space = slot.space; previous.tab = slot.tab; }
  else state.slots.push({ session, space: slot.space, tab: slot.tab });
}
function mergeChanges<T>(current: T[], before: T[], next: T[], key: (value: T) => string): T[] {
  const old = new Map(before.map(row => [key(row), row])), desired = new Map(next.map(row => [key(row), row]));
  const result = current.filter(row => desired.has(key(row)) || !old.has(key(row)) || !isDeepStrictEqual(row, old.get(key(row))));
  for (const row of next) {
    if (isDeepStrictEqual(row, old.get(key(row)))) continue;
    const index = result.findIndex(existing => key(existing) === key(row));
    if (index < 0) result.push(row);
    else if (isDeepStrictEqual(result[index], old.get(key(row)))) result[index] = row;
  }
  return result;
}
async function save(root: string, state: State, before: State): Promise<void> {
  const committed = await createPanePlacementStore(root).update(current => ({ ...current,
    slots: mergeChanges(current.slots, before.slots, state.slots, row => row.session),
    attempts: mergeChanges(current.attempts, before.attempts, state.attempts, row => JSON.stringify([row.session, row.core, row.remote.split('/').at(-1)])),
  }));
  state.slots = committed.slots;
}

async function snapshot(hc: HcClient): Promise<readonly TerminalSummary[]> {
  const events = hc.events();
  let resolve!: (rows: readonly TerminalSummary[]) => void;
  const observed = new Promise<readonly TerminalSummary[]>(done => { resolve = done; });
  const unsubscribe = events.subscribe(event => { if (event.type === 'snapshot' || event.type === 'missed') resolve(event.terminals); });
  try { await events.ready; return await observed; } finally { unsubscribe(); }
}

/** Phase 4 can preserve the local slot before the source terminal exits. */
export async function rememberRoamSlot(stateRoot: string, session: string, slot: Slot): Promise<void> {
  await prepareRoot(stateRoot);
  await withProcessLock(stateRoot, 'roam-placement-effects', async () => {
    await createPanePlacementStore(stateRoot).update(state => { setSlot(state, session, slot); return state; });
  });
}

export interface RoamPresentationOperations {
  prepareHandoff(sessionId: SessionId, source: PaneTarget): Promise<PaneActionOutcome>;
  presentReadyTarget(target: PaneTarget): Promise<PaneActionOutcome>;
}
/** Presentation effects belong to the existing service, never to the execution owner. */
export function createRoamPresentationOperations(options: {
  stateRoot: string; hc: HcClient; app: AppClient | null;
  request(request: PaneServiceRequest): Promise<PaneServiceReply>;
}): RoamPresentationOperations {
  const store = createPanePlacementStore(options.stateRoot);
  const result = (status: PaneActionOutcome['status'], reason: string, presentation: PanePresentation | null = null): PaneActionOutcome => ({ status, reason, presentation });
  const presentations = async (session: SessionId) => (await store.read()).presentations.filter(p => p.role === 'agent' && p.target.sessionId === session && p.visibility !== 'ended');
  const request = async (input: PaneServiceRequest, p: PanePresentation): Promise<PaneActionOutcome> => {
    try { const reply = await options.request(input); return reply.kind === 'outcome' ? reply.outcome : result('refused', 'presentation-reply-mismatch', p); }
    catch { return result('pending', 'presentation-unavailable', p); }
  };
  return {
    async prepareHandoff(session, source) {
      if (source.sessionId !== session || source.kind !== 'session' || !source.generation || source.homeEpoch === null || source.createdMs <= 0) return result('refused', 'handoff-unverified');
      let matches = await presentations(session);
      if (matches.length > 1) return result('refused', 'presentation-ambiguous');
      if (!matches.length) {
        if (source.coreId !== (await options.hc.identity()).coreId || !options.app) return result('pending', 'source-view-unavailable');
        let slot: OwnerPlacement;
        try { slot = await options.app.ownerPlacement(source.terminalId as unknown as TerminalAddress); }
        catch { return result('pending', 'source-view-unavailable'); }
        if (!localSlot(slot)) return result('refused', 'invalid-placement-slot');
        const seeded: PanePresentation = { id: 'session-' + hash(JSON.stringify([session, source.generation])), revision: 1, mode: 'native', role: 'agent', target: source,
          proxy: null, slot, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null };
        await store.update(state => {
          if (state.presentations.some(p => p.role === 'agent' && p.target.sessionId === session && p.visibility !== 'ended')) return state;
          setSlot(state, session, slot); return { ...state, presentations: [...state.presentations, seeded] };
        });
        matches = await presentations(session);
      }
      if (matches.length !== 1) return result('refused', 'presentation-ambiguous');
      const p = matches[0];
      if (p.visibility === 'closing') return result('refused', 'Session changed. Close again.', p);
      if (!samePaneTarget(p.target, source)) return result('refused', 'handoff-unverified', p);
      if (p.slot) await rememberRoamSlot(options.stateRoot, session, p.slot);
      return request({ version: 1, operationId: 'handoff-' + hash(JSON.stringify([p.id, p.revision, source])), op: 'prepare-handoff', presentationId: p.id,
        expectedRevision: p.revision, sessionId: session, generation: source.generation, homeEpoch: source.homeEpoch }, p);
    },
    async presentReadyTarget(target) {
      if (target.kind !== 'session' || !target.sessionId || !target.generation || target.homeEpoch === null || target.createdMs <= 0) return result('refused', 'readiness-unverified');
      const matches = await presentations(target.sessionId);
      if (matches.length !== 1) return result(matches.length ? 'refused' : 'pending', matches.length ? 'presentation-ambiguous' : 'source-view-unavailable');
      const p = matches[0];
      if (p.visibility === 'closing') return result('refused', 'Session changed. Close again.', p);
      return withProcessLock(options.stateRoot, 'ready-' + hash(p.id), async () => {
        const directory = join(options.stateRoot, 'ready-requests'); await privateDirectory(directory);
        const file = join(directory, hash(p.id) + '.json');
        const saved = await readPrivateJson(file) as { request?: unknown; retry?: boolean } | null;
        let previous: Extract<PaneServiceRequest, { op: 'present-ready' }> | null = null;
        if (saved?.request) { const parsed = parsePaneServiceRequest(saved.request); if (parsed.op === 'present-ready') previous = parsed; }
        const input: Extract<PaneServiceRequest, { op: 'present-ready' }> = previous && !saved?.retry && isDeepStrictEqual(previous.target, target) ? previous : {
          version: 1, operationId: 'ready-' + hash(JSON.stringify([p.id, p.revision, target, previous?.operationId ?? null])), op: 'present-ready', presentationId: p.id, expectedRevision: p.revision, target,
        };
        await writePrivateJson(file, { request: input, retry: false });
        try {
          const reply = await options.request(input);
          const outcome = reply.kind === 'outcome' ? reply.outcome : result('refused', 'presentation-reply-mismatch', p);
          await writePrivateJson(file, { request: input, retry: outcome.status !== 'complete' });
          return outcome;
        } catch { return result('pending', 'presentation-unavailable', p); }
      });
    },
  };
}

export function createRoamPlacement(options: Options): { reconcile(rows: readonly Readiness[]): Promise<{ pending: readonly string[] }> } {
  const { app, hc, registry, stateRoot, hcBinary } = options;
  if (!isAbsolute(hcBinary) || hcBinary.includes('\0')) throw new HerdrError('invalid-hc-binary', 'Placement requires an absolute hc binary');
  return {
    async reconcile(rows) {
      const identity = await hc.identity();
      await prepareRoot(stateRoot);
      return withProcessLock(stateRoot, 'roam-placement-effects', async () => {
        const state = await load(stateRoot);
        let committed = structuredClone(state);
        const saveState = async () => { await save(stateRoot, state, committed); committed = structuredClone(state); };
        if (state.attempts.some(attempt => !attempt.proxy && !attempt.closed)) {
          for (const terminal of await snapshot(hc)) {
            if (terminal.address.includes('/') || terminal.labels[HERDR_LABELS.kind] !== 'roam-proxy') continue;
            const attempt = state.attempts.find(a => !a.proxy && !a.closed && a.session === terminal.labels[HERDR_LABELS.session] && a.remote === terminal.labels[HERDR_LABELS.ownerTerminal] && a.core === terminal.labels[HERDR_LABELS.ownerCore]);
            if (attempt) { attempt.proxy = terminal.address; if (!options.presentation || attempt.failure?.retryable) delete attempt.failure; }
          }
        }
        const records = (await registry.list()).sort((a, b) => a.recordedAt - b.recordedAt);
        // Old local owners must not overwrite the last observed proxy slot.
        if (app) {
          for (const record of records) {
            const owner = record.owner;
            if (owner.terminal.coreId !== identity.coreId || owner.terminal.address.includes('/') || state.attempts.some(attempt => attempt.session === owner.sessionId && attempt.localOwners.includes(ownerKey(owner)))) continue;
            try {
              if ((await hc.get(owner.terminal.address)).state !== 'live') continue;
              const observed = await app.ownerPlacement(owner.terminal.address);
              if (localSlot(observed)) setSlot(state, owner.sessionId, observed);
            } catch (error) { if (errorCode(error) !== 'not_found' && !appUnavailable(error)) throw error; }
          }
        }
        for (const attempt of state.attempts) {
          if (!attempt.proxy || attempt.closed) continue;
          const address = attempt.proxy as TerminalAddress;
          let terminal;
          try { terminal = await hc.get(address); }
          catch (error) { if (errorCode(error) !== 'not_found') throw error; attempt.closed = true; continue; }
          if (terminal.labels[HERDR_LABELS.kind] !== 'roam-proxy' || terminal.labels[HERDR_LABELS.session] !== attempt.session || terminal.labels[HERDR_LABELS.ownerTerminal] !== attempt.remote || terminal.labels[HERDR_LABELS.ownerCore] !== attempt.core) continue;
          if (terminal.state === 'finished') { await hc.rm(address); attempt.closed = true; continue; }
          if (options.presentation && attempt.failure?.retryable === false && app) {
            const slot = await app.ownerPlacement(address).catch(() => null);
            if (!slot) continue;
            const reply = await app.command('terminal.park', { terminal: address });
            if (reply.error || (await app.tabTerminals(slot)).includes(address)) continue;
            const current = await hc.get(address);
            if (current.labels[HERDR_LABELS.kind] !== 'roam-proxy' || current.labels[HERDR_LABELS.session] !== attempt.session || current.labels[HERDR_LABELS.ownerTerminal] !== attempt.remote || current.labels[HERDR_LABELS.ownerCore] !== attempt.core) continue;
            await hc.kill(address); await hc.rm(address); attempt.closed = true; continue;
          }
          if (app) {
            try { const observed = await app.ownerPlacement(address); if (localSlot(observed)) setSlot(state, attempt.session, observed); }
            catch (error) { if (!appUnavailable(error)) throw error; }
          }
        }
        if (options.removedSessions) {
          const active = new Set([...rows.map(row => row.sessionId),
            ...state.attempts.filter(attempt => attempt.proxy && !attempt.closed).map(attempt => attempt.session)]);
          const candidates = [...new Set(state.slots.map(slot => slot.session).filter(session => !active.has(session)))];
          if (candidates.length) {
            try {
              const removed = await options.removedSessions(candidates);
              for (const { owner } of records) {
                if (!removed.has(owner.sessionId) || active.has(owner.sessionId)) continue;
                if (owner.terminal.coreId !== identity.coreId || owner.terminal.address.includes('/')) { active.add(owner.sessionId); continue; }
                try { if ((await hc.get(owner.terminal.address)).state === 'live') active.add(owner.sessionId); }
                catch (error) { if (errorCode(error) !== 'not_found') active.add(owner.sessionId); }
              }
              state.slots = state.slots.filter(slot => active.has(slot.session) || !removed.has(slot.session));
            } catch { /* An incomplete session inventory cannot prove a slot is removable. */ }
          }
        }
        await saveState();
        const pending: string[] = [];
        for (const row of rows) {
          if (!options.presentation || state.attempts.some(attempt => !attempt.closed && attempt.session === row.sessionId && attempt.core === row.core && attempt.remote.split('/').at(-1) === row.terminal.split('/').at(-1) && attempt.failure?.retryable === false)) { pending.push(row.terminal); continue; }
          try {
            const target = await options.presentation.resolveTarget(row);
            if (!target || target.kind !== 'session' || target.sessionId !== row.sessionId || target.coreId !== row.core || target.terminalId !== row.terminal.split('/').at(-1) || target.homeEpoch !== row.epoch || !target.generation || target.createdMs <= 0) { pending.push(row.terminal); continue; }
            const result = await options.presentation.presentReadyTarget(target);
            if (result.status !== 'complete') pending.push(row.terminal);
            else for (const attempt of state.attempts) {
              if (attempt.session === row.sessionId && attempt.core === target.coreId && attempt.remote.split('/').at(-1) === target.terminalId && !attempt.proxy && attempt.failure?.retryable) attempt.closed = true;
            }
          } catch { pending.push(row.terminal); }
        }
        await saveState();
        return { pending };
      });
    },
  };
}
