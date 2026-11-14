// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { AppClient, HcClient, Owner, OwnerPlacement, SpaceId, TabId, TerminalAddress, TerminalSummary } from './contracts.js';
import { HERDR_LABELS } from './contracts.js';
import { HerdrError } from './client/parse.js';
import { placePaneWithoutFocus } from './jobs/placement.js';
import { hash, privateDirectory, readPrivateJson, withProcessLock, writePrivateJson, type TerminalRegistry } from './sessions/registry.js';

type Slot = Pick<OwnerPlacement, 'space' | 'tab'>;
import type { Readiness } from "@spider/db-core/roam/types";
type LaunchFailure = { attempts: number; retryable: boolean };
type Attempt = { session: string; remote: string; core: string; proxy: string | null; closed: boolean; localOwners: string[]; failure?: LaunchFailure };
type State = { version: 1; slots: { session: string; space: string; tab: string }[]; attempts: Attempt[] };
const MAX_LAUNCH_ATTEMPTS = 2;
type Options = { app: AppClient | null; hc: HcClient; registry: TerminalRegistry; hcBinary: string; stateRoot: string;
  removedSessions?: (sessions: readonly string[]) => Promise<ReadonlySet<string>> };
const stateFile = (root: string) => join(root, 'roam-placement.json');
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined;
export function launchNotStarted(error: unknown): boolean {
  if (!(error instanceof HerdrError)) return false;
  if (['core-unavailable', 'core-mismatch'].includes(error.code) && error.details === undefined) return true;
  const details = error.details;
  return ['missing-hc', 'spawn-error'].includes(error.code) && !!details && typeof details === 'object' &&
    Object.hasOwn(details, 'pid') && (details as { pid?: unknown }).pid === undefined;
}
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
  if (create) await prepareRoot(root);
  else {
    if (!isAbsolute(root)) throw new HerdrError('unsafe-state-path', 'Placement state root must be absolute');
    try { await checkPrivate(root, true); }
    catch (error) { if (errorCode(error) === 'ENOENT') return { version: 1, slots: [], attempts: [] }; throw error; }
  }
  const path = stateFile(root);
  try { await checkPrivate(path, false); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  const value = await readPrivateJson(path);
  if (value === null) return { version: 1, slots: [], attempts: [] };
  const state = value as State;
  if (!state || state.version !== 1 || !Array.isArray(state.slots) || !Array.isArray(state.attempts) || state.slots.some(s => !s || typeof s.session !== 'string' || typeof s.space !== 'string' || typeof s.tab !== 'string' || !localSlot(s)) || state.attempts.some(a => !a || typeof a.session !== 'string' || typeof a.remote !== 'string' || typeof a.core !== 'string' || !(a.proxy === null || typeof a.proxy === 'string') || typeof a.closed !== 'boolean' || !Array.isArray(a.localOwners) || a.localOwners.some(key => typeof key !== 'string') ||
    a.failure !== undefined && (!a.failure || !Number.isSafeInteger(a.failure.attempts) || a.failure.attempts < 1 || a.failure.attempts > MAX_LAUNCH_ATTEMPTS || typeof a.failure.retryable !== 'boolean')))
    throw new HerdrError('invalid-placement-state', 'Invalid roaming placement state');
  return state;
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
function getSlot(state: State, session: string): Slot | null {
  const slot = state.slots.find(s => s.session === session);
  return slot ? { space: slot.space as SpaceId, tab: slot.tab as TabId } : null;
}
async function save(root: string, state: State): Promise<void> { await writePrivateJson(stateFile(root), state); }
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
  await withProcessLock(stateRoot, 'roam-placement', async () => {
    const state = await load(stateRoot); setSlot(state, session, slot); await save(stateRoot, state);
  });
}

export function createRoamPlacement(options: Options): { reconcile(rows: readonly Readiness[]): Promise<{ pending: readonly string[] }> } {
  const { app, hc, registry, stateRoot, hcBinary } = options;
  if (!isAbsolute(hcBinary) || hcBinary.includes('\0')) throw new HerdrError('invalid-hc-binary', 'Placement requires an absolute hc binary');
  return {
    async reconcile(rows) {
      const identity = await hc.identity();
      await prepareRoot(stateRoot);
      return withProcessLock(stateRoot, 'roam-placement', async () => {
        const state = await load(stateRoot);
        if (state.attempts.some(attempt => !attempt.proxy && !attempt.closed)) {
          for (const terminal of await snapshot(hc)) {
            if (terminal.address.includes('/') || terminal.labels[HERDR_LABELS.kind] !== 'roam-proxy') continue;
            const attempt = state.attempts.find(a => !a.proxy && !a.closed && a.session === terminal.labels[HERDR_LABELS.session] && a.remote === terminal.labels[HERDR_LABELS.ownerTerminal] && a.core === terminal.labels[HERDR_LABELS.ownerCore]);
            if (attempt) { attempt.proxy = terminal.address; delete attempt.failure; }
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
        await save(stateRoot, state);
        const pending: string[] = [];
        for (const row of rows) {
          let remote = row.terminal;
          if (!remote.includes('/')) {
            const matches = (await hc.machines()).filter(machine => machine.id === row.core && machine.state === 'connected');
            if (matches.length !== 1 || !remote) { pending.push(row.terminal); continue; }
            remote = `${matches[0].name}/${remote}`;
          }
          if (!remote || remote.startsWith('/') || remote.endsWith('/') || remote.split('/').length !== 2) { pending.push(row.terminal); continue; }
          const terminalId = remote.slice(remote.indexOf('/') + 1);
          let attempt = state.attempts.find(a => a.core === row.core && a.remote.slice(a.remote.indexOf('/') + 1) === terminalId);
          if (attempt) {
            if (attempt.session !== row.sessionId) { pending.push(row.terminal); continue; }
            if (attempt.proxy || attempt.closed) continue;
            if (!attempt.failure?.retryable || attempt.failure.attempts >= MAX_LAUNCH_ATTEMPTS) { pending.push(row.terminal); continue; }
          }
          const slot = getSlot(state, row.sessionId);
          if (!slot) { pending.push(row.terminal); continue; }
          const localOwners = records.filter(record => record.owner.sessionId === row.sessionId && record.owner.terminal.coreId === identity.coreId && !record.owner.terminal.address.includes('/')).map(record => ownerKey(record.owner));
          if (!attempt) {
            attempt = { session: row.sessionId, core: row.core, remote, proxy: null, closed: false, localOwners };
            state.attempts.push(attempt);
          } else { attempt.remote = remote; attempt.localOwners = localOwners; }
          // A crash or lost reply leaves an uncertain claim, not permission to relaunch.
          attempt.failure = { attempts: (attempt.failure?.attempts ?? 0) + 1, retryable: false };
          await save(stateRoot, state);
          let launched;
          try {
            launched = await hc.run({ argv: [hcBinary, 'attach', '--history', '100', ...(remote.startsWith('-') ? ['--'] : []), remote], cwd: null, labels: {
              [HERDR_LABELS.kind]: 'roam-proxy', [HERDR_LABELS.session]: row.sessionId, [HERDR_LABELS.ownerTerminal]: remote, [HERDR_LABELS.ownerCore]: row.core,
              [HERDR_LABELS.space]: slot.space, [HERDR_LABELS.tab]: slot.tab,
            }, parent: null, outliveParent: true, background: true, noNotify: true });
            if (launched.address.includes('/') || launched.coreId !== identity.coreId) throw new HerdrError('invalid-proxy', 'Proxy terminal must belong to the local core');
          } catch (error) {
            // These transport errors prove the hc run process did not start.
            attempt.failure.retryable = launchNotStarted(error);
            await save(stateRoot, state);
            throw error;
          }
          attempt.proxy = launched.address;
          delete attempt.failure;
          await save(stateRoot, state);
          if (app) {
            // Label adoption uses the space and tab. The helper does not use the anchor pane.
            try { await placePaneWithoutFocus(hc, app, launched.address, { ...slot, pane: '' as OwnerPlacement['pane'] }, { timeoutMs: 1000 }); }
            catch (error) { if (!appUnavailable(error)) throw error; }
          }
        }
        return { pending };
      });
    },
  };
}
