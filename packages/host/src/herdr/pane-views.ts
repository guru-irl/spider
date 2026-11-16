// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withProcessLock } from '../../../herdr/src/sessions/registry.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { paneId, parsePaneTarget } from '../../../herdr/src/panes/codec.js';
import type { ConsoleId, Generation, Owner, RunId, SessionId, TerminalAddress, ViewerLauncher } from '../../../herdr/src/contracts.js';
import type { PaneActionOutcome, PaneTarget } from '../../../herdr/src/panes/types.js';
export const DISPLAY_LEASE_MS = 20000;
export interface PaneViewPorts {
  /** Source-owned, generation-validated owner; no replica or caller labels. */
  readOwner(sessionId: SessionId, generation: Generation): Promise<Owner | null>;
  ownsRun(owner: Owner, runId: RunId): Promise<boolean>;
  viewerLauncher(owner: Owner, displayLeaseFile: string): ViewerLauncher;
  /** Probe core, incarnation and ownership at the source boundary. */
  readTarget(address: TerminalAddress, owner: Owner, runId: RunId | null, consoleId: ConsoleId | null): Promise<PaneTarget>;
  stopTarget(target: PaneTarget): Promise<void>;
  /** A target recovers a lost reply; null proves absence. Throw when unavailable. Must never launch. */
  recoverTarget?(owner: Owner, runId: RunId | null, consoleId: ConsoleId | null, leaseId: string): Promise<PaneTarget | null>;
  consoleSource?(owner: Owner, machineKey: string, consoleId: ConsoleId): Promise<{ consoleId: ConsoleId; runId: RunId | null; launch(displayLeaseFile: string): Promise<TerminalAddress> } | null>;
  publishLease?(lease: Readonly<ViewLease>): Promise<void>;
  leaseRoot: string;
  clock(): number;
}
export interface ViewLease {
  version: 1; leaseId: string; sessionId: SessionId; generation: Generation; runId: RunId | null; consoleId: ConsoleId | null;
  expiresAt: number; address: TerminalAddress | null; target: PaneTarget | null; state: 'claimed' | 'active' | 'uncertain' | 'stopped';
}
async function privateRoot(root: string): Promise<string> {
  if (!isAbsolute(root) || root.includes('\0')) throw new HerdrError('view-lease-root', 'Invalid view lease root');
  const normalized = resolve(root);
  // Refuse symlinks in every existing ancestor, before mkdir or any write.
  let ancestor = normalized;
  while (true) {
    try { const info = await lstat(ancestor); if (!info.isDirectory() || info.isSymbolicLink()) throw new HerdrError('view-lease-root', 'Unsafe view lease root'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = resolve(ancestor, '..'); if (parent === ancestor) break; ancestor = parent;
  }
  await mkdir(normalized, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && ((await lstat(normalized)).mode & 0o077)) throw new HerdrError('view-lease-root', 'View lease directory is not private');
  return normalized;
}
async function readLease(file: string): Promise<ViewLease | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 65536 || process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Unsafe view lease');
    const value = JSON.parse(await handle.readFile('utf8')) as ViewLease;
    if (value.version !== 1 || paneId(value.leaseId) + '.json' !== file.split(/[\\/]/).at(-1) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0
      || !['claimed', 'active', 'uncertain', 'stopped'].includes(value.state)) throw new Error('Invalid view lease');
    paneId(value.sessionId); paneId(value.generation); if (value.runId !== null) paneId(value.runId); if (value.consoleId !== null) paneId(value.consoleId);
    if (value.target !== null) value.target = parsePaneTarget(value.target);
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}
async function publish(file: string, value: ViewLease, ports: PaneViewPorts): Promise<void> {
  const temporary = file + '.' + randomUUID(); const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); await rename(temporary, file); await ports.publishLease?.(value); }
  finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
async function ownerFor(input: { sessionId: SessionId; generation: Generation }, ports: PaneViewPorts): Promise<Owner> {
  const owner = await ports.readOwner(input.sessionId, input.generation);
  if (!owner || owner.sessionId !== input.sessionId || owner.generation !== input.generation) throw new HerdrError('wrong-generation', 'View owner is no longer current');
  return owner;
}
const outcome = (status: PaneActionOutcome['status'], reason: string): PaneActionOutcome => ({ status, reason, presentation: null });
async function locked<T>(leaseId: string, ports: PaneViewPorts, work: (file: string) => Promise<T>): Promise<T> {
  const root = await privateRoot(ports.leaseRoot), id = paneId(leaseId);
  return withProcessLock(root, 'view-leases', () => work(join(root, id + '.json')));
}
async function retireLease(file: string, lease: ViewLease, ports: PaneViewPorts): Promise<void> {
  if (lease.state !== 'stopped') {
    lease.expiresAt = 0; await publish(file, lease, ports);
    if (lease.target) await ports.stopTarget(lease.target);
    lease.state = 'stopped'; await publish(file, lease, ports);
  } else await ports.publishLease?.(lease);
  await unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
}
async function failedLaunch(file: string, lease: ViewLease, owner: Owner, ports: PaneViewPorts, error: unknown): Promise<void> {
  lease.state = 'uncertain'; await publish(file, lease, ports);
  if (!ports.recoverTarget) throw error;
  let recovered: PaneTarget | null;
  try { recovered = await ports.recoverTarget(owner, lease.runId, lease.consoleId, lease.leaseId); } catch { throw error; }
  if (!recovered) { await retireLease(file, lease, ports); throw error; }
  lease.address = recovered.address; await publish(file, lease, ports);
}
async function exclusiveView<T>(input: { sessionId: SessionId; runId: RunId | null; consoleId: ConsoleId | null; leaseId: string }, ports: PaneViewPorts, work: (file: string) => Promise<T>): Promise<T> {
  const root = await privateRoot(ports.leaseRoot);
  return locked(input.leaseId, ports, async claimedFile => {
    const files = (await readdir(root)).filter(name => name.endsWith('.json'));
    let active = 0, existing = false, conflict = false, index = 0;
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
      while (index < files.length) {
        const name = files[index++], file = join(root, name);
        const previous = await readLease(file);
        if (!previous) continue;
        if (previous.state === 'stopped' || previous.expiresAt <= ports.clock()) { await retireLease(file, previous, ports); continue; }
        active++;
        if (previous.leaseId === input.leaseId) { existing = true; continue; }
        if (previous.sessionId === input.sessionId && previous.runId === input.runId && previous.consoleId === input.consoleId)
          conflict = true;
      }
    }));
    if (conflict) throw new HerdrError('view-already-leased', 'Source view already has an active display lease');
    if (active >= 4096 && !existing) throw new HerdrError('view-lease-limit', 'View lease inventory exceeded its bound');
    return work(claimedFile);
  });
}
export async function launchPaneViewer(input: {sessionId: SessionId; generation: Generation; runId: RunId; leaseId: string}, ports: PaneViewPorts): Promise<PaneTarget> {
  paneId(input.runId);
  const initialOwner = await ownerFor(input, ports);
  if (!await ports.ownsRun(initialOwner, input.runId)) throw new HerdrError('run-not-owned', 'Run does not belong to the source owner');
  return exclusiveView({ ...input, consoleId: null }, ports, async file => {
    const owner = await ownerFor(input, ports);
    if (!await ports.ownsRun(owner, input.runId)) throw new HerdrError('run-not-owned', 'Run does not belong to the source owner');
    let lease = await readLease(file);
    if (lease && (lease.sessionId !== input.sessionId || lease.generation !== input.generation || lease.runId !== input.runId || lease.consoleId !== null))
      throw new HerdrError('view-lease-mismatch', 'Display lease is bound to another view');
    if (lease) {
      if (lease.state === 'stopped' || lease.expiresAt <= ports.clock()) throw new HerdrError('view-lease-expired', 'Reopen the view with a new display lease');
      if (!lease.address) {
        const recovered = await ports.recoverTarget?.(owner, input.runId, null, input.leaseId);
        if (recovered) lease.address = recovered.address;
        else if (ports.recoverTarget) { await retireLease(file, lease, ports); lease = null; }
        else throw new HerdrError('view-launch-uncertain', 'View launch must be reconciled before retry');
      }
    }
    if (!lease) {
      lease = { version: 1, ...input, consoleId: null, expiresAt: ports.clock() + DISPLAY_LEASE_MS, address: null, target: null, state: 'claimed' };
      await publish(file, lease, ports);
      try {
        lease.address = await ports.viewerLauncher(owner, file)(input.runId, owner, undefined, 'explicit');
        await publish(file, lease, ports);
      } catch (error) { await failedLaunch(file, lease, owner, ports, error); }
    }
    const target = await ports.readTarget(lease.address!, owner, input.runId, null);
    await ownerFor(input, ports);
    if (target.kind !== 'subagent' || target.runId !== input.runId || target.sessionId !== input.sessionId || target.generation !== input.generation || target.coreId !== owner.terminal.coreId)
      throw new HerdrError('view-target-mismatch', 'Source viewer identity changed');
    lease.target = target; lease.state = 'active'; await publish(file, lease, ports); return target;
  });
}
export async function openPaneConsole(input: {sessionId: SessionId; generation: Generation; machineKey: string; consoleId: ConsoleId; leaseId: string}, ports: PaneViewPorts): Promise<PaneTarget | null> {
  const owner = await ownerFor(input, ports);
  if (!ports.consoleSource) throw new HerdrError('console-unavailable', 'Source console support is not installed');
  const source = await ports.consoleSource(owner, input.machineKey, input.consoleId); if (!source) return null;
  if (source.consoleId !== input.consoleId) throw new HerdrError('console-identity-mismatch', 'Source console changed');
  return exclusiveView({ ...input, runId: source.runId, consoleId: source.consoleId }, ports, async file => {
    await ownerFor(input, ports); let lease = await readLease(file);
    if (lease && (lease.sessionId !== input.sessionId || lease.generation !== input.generation || lease.consoleId !== source.consoleId || lease.runId !== source.runId))
      throw new HerdrError('view-lease-mismatch', 'Display lease is bound to another console');
    if (lease) {
      if (lease.state === 'stopped' || lease.expiresAt <= ports.clock()) throw new HerdrError('view-lease-expired', 'Reopen the console with a new display lease');
      if (!lease.address) {
        const recovered = await ports.recoverTarget?.(owner, source.runId, source.consoleId, input.leaseId);
        if (recovered) lease.address = recovered.address;
        else if (ports.recoverTarget) { await retireLease(file, lease, ports); lease = null; }
        else throw new HerdrError('view-launch-uncertain', 'Console launch must be reconciled before retry');
      }
    }
    if (!lease) {
      lease = { version: 1, leaseId: input.leaseId, sessionId: input.sessionId, generation: input.generation, runId: source.runId, consoleId: source.consoleId,
        expiresAt: ports.clock() + DISPLAY_LEASE_MS, address: null, target: null, state: 'claimed' };
      await publish(file, lease, ports);
      try { lease.address = await source.launch(file); await publish(file, lease, ports); }
      catch (error) { await failedLaunch(file, lease, owner, ports, error); }
    }
    const target = await ports.readTarget(lease.address!, owner, source.runId, source.consoleId); await ownerFor(input, ports);
    if (target.kind !== 'console' || target.consoleId !== source.consoleId || target.sessionId !== input.sessionId || target.generation !== input.generation)
      throw new HerdrError('view-target-mismatch', 'Source console identity changed');
    lease.target = target; lease.state = 'active'; await publish(file, lease, ports); return target;
  });
}
export async function renewPaneViewers(leases: readonly {leaseId: string; generation: Generation}[], ports: PaneViewPorts): Promise<PaneActionOutcome> {
  if (leases.length > 256 || new Set(leases.map(lease => lease.leaseId)).size !== leases.length) return outcome('refused', 'invalid-lease-batch');
  let refused = false;
  for (const renewal of leases) {
    await locked(renewal.leaseId, ports, async file => {
      const lease = await readLease(file);
      if (!lease || lease.state !== 'active' || lease.generation !== renewal.generation || lease.expiresAt <= ports.clock() || !lease.target) { refused = true; return; }
      try {
        const owner = await ownerFor(lease, ports);
        if (lease.runId && !await ports.ownsRun(owner, lease.runId)) { refused = true; return; }
        const target = await ports.readTarget(lease.target.address, owner, lease.runId, lease.consoleId);
        if (target.coreId !== lease.target.coreId || target.terminalId !== lease.target.terminalId || target.createdMs !== lease.target.createdMs) { refused = true; return; }
        lease.expiresAt = ports.clock() + DISPLAY_LEASE_MS; await publish(file, lease, ports);
      } catch { refused = true; }
    });
  }
  return outcome(refused ? 'refused' : 'complete', refused ? 'view-unavailable' : 'view-leases-renewed');
}
export async function stopPaneViewer(leaseId: string, ports: PaneViewPorts): Promise<PaneActionOutcome> {
  return locked(leaseId, ports, async file => {
    const lease = await readLease(file); if (lease) await retireLease(file, lease, ports);
    return outcome('complete', 'view-stopped');
  });
}
