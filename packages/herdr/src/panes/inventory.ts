// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { HerdrError, parseJson } from '../client/parse.js';
import type { CoreId, HcArgvClient } from '../contracts.js';
import { privateDirectory, readPrivateJson, withProcessLock, writePrivateJson } from '../sessions/registry.js';
import { encodeRemotePaneRequest, paneId, panePath, paneRecord, paneText, parsePaneInventoryPage, parseRemotePaneReply, PANE_REPLY_LIMIT } from './codec.js';
import type { MachineChoice, PaneAgentRow, PaneInventoryPage } from './types.js';

/** An internal aggregate, never a wire page. Page it before sending it to a mod or service client. */
export interface RemoteInventorySnapshot {
  machineKey: string; coreId: CoreId | null; updatedAt: number | null;
  complete: boolean; stale: boolean; rows: readonly PaneAgentRow[];
}
export interface PaneInventoryPorts {
  readPage(machine: MachineChoice, cursor: string | null): Promise<unknown>;
  readCache(machineKey: string): Promise<{ updatedAt: number; page: RemoteInventorySnapshot } | null>;
  writeCache(machineKey: string, page: RemoteInventorySnapshot, updatedAt: number): Promise<void>;
  clock(): number;
}
const MAX_ROWS = 4096, MAX_PAGES = 32;
type Cache = Record<string, { updatedAt: number; page: RemoteInventorySnapshot }>;
function parseCachedSnapshot(value: unknown): RemoteInventorySnapshot {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > PANE_REPLY_LIMIT) throw new HerdrError('invalid-pane-cache', 'Inventory snapshot exceeds its bound');
  const r = paneRecord(value, ['machineKey', 'coreId', 'updatedAt', 'complete', 'stale', 'rows']);
  const machineKey = paneText(r.machineKey), coreId = paneId(r.coreId) as CoreId;
  if (!Number.isSafeInteger(r.updatedAt) || (r.updatedAt as number) < 0 || r.complete !== true || r.stale !== false || !Array.isArray(r.rows) || r.rows.length > MAX_ROWS) throw new HerdrError('invalid-pane-cache', 'Invalid complete inventory snapshot');
  const rows: PaneAgentRow[] = [], ids = new Set<string>();
  for (let i = 0; i < r.rows.length; i += 256) {
    const page = parsePaneInventoryPage({ version: 1, rows: r.rows.slice(i, i + 256), next: null, complete: true });
    for (const row of page.rows) {
      if (row.machineKey !== coreId || ids.has(row.sessionId) || row.target && (row.target.coreId !== coreId || row.owner.terminal.coreId !== coreId)) throw new HerdrError('invalid-pane-cache', 'Inventory source identity changed');
      ids.add(row.sessionId); rows.push(row);
    }
  }
  return { machineKey, coreId, updatedAt: r.updatedAt as number, complete: true, stale: false, rows };
}
function parseCache(raw: unknown): Cache {
  if (raw === null) return Object.create(null) as Cache;
  const data = paneRecord(raw, ['version', 'machines']);
  if (data.version !== 1 || !data.machines || typeof data.machines !== 'object' || Array.isArray(data.machines)) throw new HerdrError('invalid-pane-cache', 'Invalid inventory cache');
  const result: Cache = Object.create(null);
  for (const [key, value] of Object.entries(data.machines)) {
    const entry = paneRecord(value, ['updatedAt', 'page']);
    const page = parseCachedSnapshot(entry.page);
    if (key !== page.machineKey || entry.updatedAt !== page.updatedAt) throw new HerdrError('invalid-pane-cache', 'Inventory cache identity differs');
    result[key] = { updatedAt: page.updatedAt!, page };
  }
  return result;
}
/** The root is the private herdr/panes directory, not the placement authority. */
export function createPaneInventoryCache(root: string): Pick<PaneInventoryPorts, 'readCache' | 'writeCache'> {
  const file = join(root, 'remote-agents.json');
  const inspect = async (): Promise<boolean> => {
    let directory;
    try { directory = await lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    const uid = process.getuid?.();
    if (!directory.isDirectory() || directory.isSymbolicLink() || process.platform !== 'win32' && (directory.mode & 0o777) !== 0o700 || uid !== undefined && directory.uid !== uid) throw new HerdrError('unsafe-pane-cache', 'Inventory cache directory must be private and owned');
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || process.platform !== 'win32' && (info.mode & 0o777) !== 0o600 || uid !== undefined && info.uid !== uid) throw new HerdrError('unsafe-pane-cache', 'Inventory cache file must be private and owned');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return true;
  };
  return {
    async readCache(key) { if (!await inspect()) return null; return parseCache(await readPrivateJson(file))[key] ?? null; },
    async writeCache(key, page, updatedAt) {
      const checked = parseCachedSnapshot(page);
      if (key !== checked.machineKey || updatedAt !== checked.updatedAt) throw new HerdrError('invalid-pane-cache', 'Inventory cache identity differs');
      await privateDirectory(root); await inspect();
      await withProcessLock(root, 'remote-agents', async () => {
        await inspect();
        const machines = parseCache(await readPrivateJson(file)); machines[key] = { updatedAt, page: checked };
        await writePrivateJson(file, { version: 1, machines });
      });
    },
  };
}
export interface PaneRemoteInventoryTransport {
  exec: HcArgvClient['exec'];
  resolveMachine(machine: MachineChoice): Promise<{ on: string; coreId: CoreId; nodePath: string; endpointPath: string }>;
  buildDigest: string;
}
/** Setup owns installation; refresh only invokes the already installed endpoint. */
export function createRemotePaneInventoryReader(ports: PaneRemoteInventoryTransport): PaneInventoryPorts['readPage'] {
  return async (machine, cursor) => {
    if (machine.state !== 'connected' || !machine.coreId) throw new HerdrError('pane-machine-unavailable', 'Machine identity is unavailable');
    const deadline = performance.now() + 5000;
    const destination = await ports.resolveMachine(machine);
    if (destination.coreId !== machine.coreId || !destination.on || !/^[a-f0-9]{64}$/.test(ports.buildDigest)) throw new HerdrError('pane-machine-mismatch', 'Machine or endpoint identity changed');
    panePath(destination.nodePath); panePath(destination.endpointPath);
    const call = async (request: Parameters<typeof encodeRemotePaneRequest>[0]) => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new HerdrError('pane-inventory-timeout', 'Inventory request timed out');
      const bytes = await ports.exec(destination.on, [destination.nodePath, destination.endpointPath, '--json', encodeRemotePaneRequest(request)], { timeoutMs: remaining, maxBytes: PANE_REPLY_LIMIT });
      if (bytes.length > PANE_REPLY_LIMIT) throw new HerdrError('pane-inventory-too-large', 'Inventory reply exceeds its bound');
      return parseRemotePaneReply(parseJson(bytes));
    };
    const handshake = await call({ version: 1, op: 'handshake', protocol: 1, buildDigest: ports.buildDigest });
    if (handshake.op !== 'handshake' || handshake.protocol !== 1 || handshake.buildDigest !== ports.buildDigest) throw new HerdrError('pane-build-mismatch', 'Pane endpoint build or protocol differs');
    const result = await call({ version: 1, op: 'list', cursor });
    if (result.op !== 'list') throw new HerdrError('invalid-pane-inventory', 'Expected an inventory page');
    const current = await ports.resolveMachine(machine);
    if (current.coreId !== machine.coreId || current.on !== destination.on || current.nodePath !== destination.nodePath || current.endpointPath !== destination.endpointPath || performance.now() > deadline) throw new HerdrError('pane-machine-mismatch', 'Machine identity changed during inventory');
    return result.page;
  };
}
interface Flight { promise: Promise<RemoteInventorySnapshot>; retryAt: number; failed: boolean }
const flights = new WeakMap<PaneInventoryPorts, Map<string, Flight>>();
function validatePage(value: unknown, machine: MachineChoice): PaneInventoryPage {
  const page = parsePaneInventoryPage(value), ids = new Set<string>();
  for (const row of page.rows) {
    if (row.machineKey !== machine.coreId || ids.has(row.sessionId) || row.target && (row.target.coreId !== machine.coreId || row.owner.terminal.coreId !== machine.coreId)) throw new HerdrError('invalid-pane-inventory', 'Inventory core or session identity changed');
    ids.add(row.sessionId);
  }
  return page;
}
function project(row: PaneAgentRow, machine: MachineChoice): PaneAgentRow {
  return row.target ? { ...row, machineKey: machine.key, target: { ...row.target, alias: machine.alias, machineId: machine.machineId } } : { ...row, machineKey: machine.key };
}
function empty(machine: MachineChoice): RemoteInventorySnapshot {
  return { machineKey: machine.key, coreId: machine.coreId, updatedAt: null, complete: false, stale: true, rows: [] };
}
async function unavailable(machine: MachineChoice, ports: PaneInventoryPorts, partial: readonly PaneAgentRow[] = []): Promise<RemoteInventorySnapshot> {
  const cache = await ports.readCache(machine.key);
  if (cache) {
    try {
      const saved = parseCachedSnapshot(cache.page);
      if (saved.coreId === machine.coreId && saved.machineKey === machine.key && saved.updatedAt === cache.updatedAt) return { ...saved, complete: false, stale: true, rows: saved.rows.map(row => ({ ...project(row, machine), status: 'unreachable' })) };
    } catch { /* Do not attribute a cache to a changed source identity. */ }
  }
  return { ...empty(machine), rows: partial.map(row => ({ ...project(row, machine), status: 'unreachable' })) };
}
/** One refresh walks all pages; no partial or mixed snapshot is committed. */
export async function readRemotePaneInventory(machine: MachineChoice, cursor: string | null, ports: PaneInventoryPorts): Promise<RemoteInventorySnapshot> {
  if (cursor !== null) throw new HerdrError('invalid-pane-cursor', 'Inventory refresh must begin at the first page');
  if (!machine.coreId) return empty(machine);
  if (machine.state !== 'connected') return unavailable(machine, ports);
  let map = flights.get(ports); if (!map) { map = new Map(); flights.set(ports, map); }
  const key = JSON.stringify([machine.key, machine.coreId, machine.machineId]);
  const previous = map.get(key);
  if (previous) {
    if (!previous.failed) return previous.promise;
    if (ports.clock() < previous.retryAt) return unavailable(machine, ports);
    map.delete(key);
  }
  const flight: Flight = { promise: Promise.resolve(empty(machine)), retryAt: 0, failed: false };
  map.set(key, flight);
  const partial: PaneAgentRow[] = [], ids = new Set<string>(), cursors = new Set<string>();
  const updatedAt = ports.clock();
  // Reserve room for metadata and for status changes when returning a stale snapshot.
  const metadataBytes = Buffer.byteLength(JSON.stringify({ ...empty(machine), updatedAt })) + 1024;
  let sourceBytes = metadataBytes, projectedBytes = metadataBytes, expired = false;
  const walk = async (): Promise<RemoteInventorySnapshot> => {
    let next: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
      const page = validatePage(await ports.readPage(machine, next), machine);
      if (expired) throw new HerdrError('pane-inventory-timeout', 'Inventory request timed out');
      for (const row of page.rows) {
        if (ids.has(row.sessionId)) throw new HerdrError('invalid-pane-inventory', 'A session occurs on more than one page');
        const sourceSize = Buffer.byteLength(JSON.stringify(row)) + 1;
        const displaySize = Buffer.byteLength(JSON.stringify({ ...project(row, machine), status: 'unreachable' })) + 1;
        if (partial.length >= MAX_ROWS || sourceBytes + sourceSize > PANE_REPLY_LIMIT || projectedBytes + displaySize > PANE_REPLY_LIMIT) throw new HerdrError('pane-inventory-too-large', 'Inventory snapshot exceeds its bound');
        ids.add(row.sessionId); partial.push(row); sourceBytes += sourceSize; projectedBytes += displaySize;
      }
      if (!page.complete) throw new HerdrError('pane-inventory-incomplete', 'Source inventory is incomplete');
      if (page.next === null) return { machineKey: machine.key, coreId: machine.coreId, updatedAt, complete: true, stale: false, rows: partial };
      if (cursors.has(page.next)) throw new HerdrError('invalid-pane-cursor', 'Inventory cursor repeated');
      cursors.add(page.next); next = page.next;
    }
    throw new HerdrError('pane-inventory-too-large', 'Inventory has too many pages');
  };
  const read = Promise.resolve().then(walk);
  let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
  const settledRead = () => { settled = true; if (flight.failed && flight.retryAt === Number.POSITIVE_INFINITY) flight.retryAt = ports.clock() + 5000; };
  void read.then(settledRead, settledRead);
  flight.promise = (async () => {
    try {
      const snapshot = await Promise.race([read, new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new HerdrError('pane-inventory-timeout', 'Inventory request timed out')); }, 5000); })]);
      await ports.writeCache(machine.key, snapshot, updatedAt);
      map!.delete(key);
      return { ...snapshot, rows: snapshot.rows.map(row => project(row, machine)) };
    } catch {
      flight.failed = true;
      // A hung read stays single-flight, even after the visible deadline.
      flight.retryAt = settled ? ports.clock() + 5000 : Number.POSITIVE_INFINITY;
      return unavailable(machine, ports, partial);
    } finally { clearTimeout(timer); }
  })();
  return flight.promise;
}
