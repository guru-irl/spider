// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import type { CoreIdentity, Generation, Owner, SessionFeed, SessionId } from '../../../herdr/src/contracts.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { operationObservation, withHcOperation } from '../../../herdr/src/client/operation.js';
import { paneId, parsePaneInventoryPage, parseRemotePaneReply, parseRemotePaneRequest, PANE_REPLY_LIMIT } from '../../../herdr/src/panes/codec.js';
import type { PaneActionOutcome, PaneAgentRow, PaneInventoryPage, PaneConsoleRow, PaneTarget, PaneTerminalFacts, RemotePaneReply, RemotePaneRequest } from '../../../herdr/src/panes/types.js';
import type { ProcessProbe } from '../../../herdr/src/sessions/lease.js';
import type { PresenceRecord } from '../../../herdr/src/sessions/presence.js';
import type { TerminalAssociation } from '../../../herdr/src/sessions/registry.js';
export { createSourcePaneFolderPorts } from './pane-folders.js';

type Request<Op extends RemotePaneRequest['op']> = Extract<RemotePaneRequest, { op: Op }>;
export interface PaneEndpointPorts {
  protocol: number; buildDigest: string; dispose?(): Promise<void>;
  resolveOwner(sessionId: SessionId, generation: Generation): Promise<Owner>;
  listRows(cursor: string | null): Promise<PaneInventoryPage>;
  locateFolder(cwd: string): Promise<{ repoKey: string; workspaceId: string; relativeCwd: string } | null>;
  resolveFolder(repoKey: string, workspaceId: string, relativeCwd: string): Promise<{ cwd: string | null; exists: boolean | null }>;
  launchViewer(owner: Owner, request: Request<'launch-viewer'>): Promise<PaneTarget | null>;
  renewViewers(leases: Request<'renew-viewers'>['leases']): Promise<PaneActionOutcome>;
  stopViewer(leaseId: string): Promise<PaneActionOutcome>;
  openConsole(owner: Owner, request: Request<'open-console'>): Promise<PaneTarget | null>;
  closeSession(owner: Owner, request: Request<'close-session'>): Promise<PaneActionOutcome>;
}
export interface PaneSourceInventoryPorts {
  identity(): Promise<CoreIdentity>;
  listPresence(): Promise<readonly PresenceRecord[]>;
  listMappings(): Promise<readonly TerminalAssociation[]>;
  probe(pid: number): Promise<ProcessProbe>;
  /** Returns only a valid, fresh, source-local feed. */
  readFeed(sessionId: SessionId): Promise<SessionFeed | null>;
  readTerminal(owner: Owner): Promise<PaneTerminalFacts>;
  /** Null means console inventory is unavailable, not empty. */
  readConsoles(owner: Owner): Promise<readonly PaneConsoleRow[] | null>;
  readHomeEpoch?(sessionId: SessionId): Promise<number>;
  clock(): number;
}
function sameCore(owner: Owner, identity: CoreIdentity): boolean {
  return owner.terminal.coreId === identity.coreId && owner.terminal.socket === identity.socket && owner.terminal.sessionNamespace === identity.sessionNamespace;
}
function terminalAddress(identity: CoreIdentity, id: string): string { return `${identity.coreId}/${id}`; }
function matchingOwner(a: Owner, b: Owner): boolean {
  return a.sessionId === b.sessionId && a.generation === b.generation && a.terminal.coreId === b.terminal.coreId && a.terminal.socket === b.terminal.socket && a.terminal.sessionNamespace === b.terminal.sessionNamespace && a.terminal.terminalId === b.terminal.terminalId && a.sessionFile === b.sessionFile;
}
function sourceSnapshot(ports: PaneSourceInventoryPorts) {
  return operationObservation(ports, async () => {
    const [identity, presence, mappings] = await Promise.all([ports.identity(), ports.listPresence(), ports.listMappings()]);
    return { identity, presence, mappings, facts: new Map<string, Promise<PaneTerminalFacts>>(), pages: new Map<string, Promise<PaneInventoryPage>>() };
  });
}
/** Build a page once per operation, retaining fresh feed and process checks at launch. */
export function readPaneSourceInventory(cursor: string | null, ports: PaneSourceInventoryPorts, includeConsoles = true): Promise<PaneInventoryPage> {
  return sourceSnapshot(ports).then(snapshot => {
    const page = JSON.stringify([cursor, includeConsoles]);
    let result = snapshot.pages.get(page);
    if (!result) { result = buildPaneSourceInventory(cursor, ports, includeConsoles, snapshot); snapshot.pages.set(page, result); }
    return result;
  });
}
async function buildPaneSourceInventory(cursor: string | null, ports: PaneSourceInventoryPorts, includeConsoles: boolean, snapshot: Awaited<ReturnType<typeof sourceSnapshot>>): Promise<PaneInventoryPage> {
  const { identity, presence, mappings } = snapshot;
  let complete = true;
  const live: PresenceRecord[] = [];
  for (const item of presence) {
    if (item.kind !== 'top-level' || !item.sessionId) continue;
    try { paneId(item.sessionId); } catch { complete = false; continue; }
    const probe = await ports.probe(item.pid);
    if (probe.kind === 'unknown') { complete = false; continue; }
    if (probe.kind === 'live' && probe.startIdentity === item.startIdentity) live.push(item);
  }
  const counts = new Map<string, number>();
  for (const item of live) counts.set(item.sessionId!, (counts.get(item.sessionId!) ?? 0) + 1);
  const rows: PaneAgentRow[] = [];
  for (const item of live) {
    const sessionId = item.sessionId!;
    if (counts.get(sessionId)! > 1) { complete = false; continue; }
    if (!item.hcAddress) {
      rows.push({ sessionId, generation: null, name: item.sessionName, owner: null, target: null, status: 'unknown', updatedAt: 0, machineKey: identity.coreId, unavailableReason: 'not-in-hc', children: [], consoles: [] });
      continue;
    }
    const possible = mappings.filter(mapping => mapping.owner.sessionId === sessionId && sameCore(mapping.owner, identity) && mapping.owner.sessionFile === item.sessionFile && (mapping.owner.terminal.address === item.hcAddress || terminalAddress(identity, mapping.owner.terminal.terminalId) === item.hcAddress));
    if (possible.length !== 1) { complete = false; continue; }
    const owner = possible[0].owner;
    try {
      const feed = await ports.readFeed(sessionId);
      if (!feed || feed.lifecycle !== 'live' || !matchingOwner(owner, feed.owner) || feed.sessionId !== sessionId || feed.generation !== owner.generation) { complete = false; continue; }
      const factKey = JSON.stringify([owner.sessionId, owner.generation, owner.terminal.coreId, owner.terminal.terminalId]);
      let observed = snapshot.facts.get(factKey);
      if (!observed) { observed = ports.readTerminal(owner); snapshot.facts.set(factKey, observed); }
      const facts = await observed;
      if (facts.terminal.state !== 'live' || (facts.terminal.address !== owner.terminal.address && facts.terminal.address !== terminalAddress(identity, owner.terminal.terminalId))) { complete = false; continue; }
      if (['pane-proxy', 'roam-proxy'].includes(facts.identityLabels['spider.kind'] ?? '')) { complete = false; continue; }
      const target: PaneTarget = { coreId: identity.coreId, terminalId: owner.terminal.terminalId, address: terminalAddress(identity, owner.terminal.terminalId) as PaneTarget['address'], createdMs: facts.createdMs, identityLabels: facts.identityLabels, alias: null, machineId: null, kind: 'session', sessionId, generation: owner.generation, homeEpoch: await ports.readHomeEpoch?.(sessionId) ?? 0, runId: null, consoleId: null, name: item.sessionName, cwd: facts.currentCwd };
      if (feed.runs.truncated) complete = false;
      let consoles: readonly PaneConsoleRow[] | null;
      try { consoles = includeConsoles ? await ports.readConsoles(owner) : []; } catch { consoles = null; }
      if (consoles === null) complete = false;
      if (consoles?.some(console => console.target && (console.target.kind !== 'console' || console.target.sessionId !== sessionId || console.target.generation !== owner.generation || console.target.consoleId !== console.consoleId))) throw new HerdrError('invalid-pane-console', 'Console does not belong to the source session');
      rows.push({ sessionId, generation: owner.generation, name: item.sessionName, owner, target, status: feed.status.effective ?? feed.status.native ?? 'unknown', updatedAt: feed.updatedAt, machineKey: identity.coreId, unavailableReason: null, children: feed.runs.rows.map(run => ({ runId: run.id, name: run.name, status: run.status })), consoles: consoles ?? [] });
    } catch { complete = false; }
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const item = live.find(record => record.sessionId === rows[i].sessionId)!;
    const current = await ports.probe(item.pid);
    if (current.kind !== 'live' || current.startIdentity !== item.startIdentity) { rows.splice(i, 1); complete = false; }
  }
  const currentCore = await ports.identity();
  if (currentCore.coreId !== identity.coreId || currentCore.socket !== identity.socket || currentCore.sessionNamespace !== identity.sessionNamespace) throw new HerdrError('core-mismatch', 'Source core changed during inventory');
  rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const fingerprint = createHash('sha256').update(JSON.stringify([identity.coreId, rows, complete])).digest('hex');
  let offset = 0;
  if (cursor !== null) {
    const match = /^v1:([a-f0-9]{64}):(\d+)$/.exec(cursor);
    if (!match || match[1] !== fingerprint || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0 || Number(match[2]) >= rows.length) throw new HerdrError('invalid-pane-cursor', 'Inventory cursor is invalid or stale');
    offset = Number(match[2]);
  }
  const selected: PaneAgentRow[] = [];
  for (const row of rows.slice(offset, offset + 256)) {
    const next = `v1:${fingerprint}:${offset + selected.length + 1}`;
    const candidate = { version: 1 as const, rows: [...selected, row], next, complete };
    if (Buffer.byteLength(JSON.stringify(candidate)) > PANE_REPLY_LIMIT) {
      if (!selected.length) throw new HerdrError('pane-inventory-too-large', 'An inventory row exceeds the page limit');
      break;
    }
    selected.push(row);
  }
  const end = offset + selected.length;
  return parsePaneInventoryPage({ version: 1, rows: selected, next: end < rows.length ? `v1:${fingerprint}:${end}` : null, complete });
}
export async function resolvePaneSourceOwner(sessionId: SessionId, generation: Generation, ports: PaneSourceInventoryPorts): Promise<Owner> {
  let cursor: string | null = null;
  do {
    const page = await readPaneSourceInventory(cursor, ports, false);
    if (!page.complete) throw new HerdrError('pane-inventory-incomplete', 'Source inventory is incomplete');
    const match = page.rows.find(row => row.sessionId === sessionId && row.generation === generation && row.unavailableReason === null);
    if (match?.owner) {
      const owner = match.owner, feed = await ports.readFeed(sessionId);
      if (!feed || feed.lifecycle !== 'live' || feed.sessionId !== sessionId || feed.generation !== generation || !matchingOwner(owner, feed.owner)) throw new HerdrError('stale-pane-owner', 'Source session changed');
      const presence = (await sourceSnapshot(ports)).presence.filter(item => item.kind === 'top-level' && item.sessionId === sessionId);
      if (presence.length !== 1) throw new HerdrError('stale-pane-owner', 'Source process is ambiguous');
      const probe = await ports.probe(presence[0].pid);
      if (probe.kind !== 'live' || probe.startIdentity !== presence[0].startIdentity) throw new HerdrError('stale-pane-owner', 'Source process changed');
      return owner;
    }
    cursor = page.next;
  } while (cursor !== null);
  throw new HerdrError('stale-pane-owner', 'Source owner is unavailable');
}
async function ownerFor(request: { sessionId: SessionId; generation: Generation }, ports: PaneEndpointPorts): Promise<Owner> {
  const owner = await ports.resolveOwner(request.sessionId, request.generation);
  if (owner.sessionId !== request.sessionId || owner.generation !== request.generation) throw new HerdrError('stale-pane-owner', 'Session generation changed');
  return owner;
}
/** Requests are decoded again at the source boundary before any effect is delegated. */
export function handleRemotePaneRequest(input: RemotePaneRequest, ports: PaneEndpointPorts): Promise<RemotePaneReply> {
  return withHcOperation(() => applyRemotePaneRequest(input, ports));
}
async function applyRemotePaneRequest(input: RemotePaneRequest, ports: PaneEndpointPorts): Promise<RemotePaneReply> {
  const request = parseRemotePaneRequest(input);
  let reply: RemotePaneReply;
  switch (request.op) {
    case 'handshake':
      if (request.protocol !== ports.protocol || request.buildDigest !== ports.buildDigest) throw new HerdrError('pane-build-mismatch', 'Pane endpoint build or protocol differs');
      reply = { version: 1, op: request.op, protocol: ports.protocol, buildDigest: ports.buildDigest }; break;
    case 'list': reply = { version: 1, op: request.op, page: await ports.listRows(request.cursor) }; break;
    case 'launch-viewer': reply = { version: 1, op: request.op, target: await ports.launchViewer(await ownerFor(request, ports), request) }; break;
    case 'open-console': reply = { version: 1, op: request.op, target: await ports.openConsole(await ownerFor(request, ports), request) }; break;
    case 'close-session': reply = { version: 1, op: request.op, outcome: await ports.closeSession(await ownerFor(request, ports), request) }; break;
    case 'renew-viewers': reply = { version: 1, op: request.op, outcome: await ports.renewViewers(request.leases) }; break;
    case 'stop-viewer': reply = { version: 1, op: request.op, outcome: await ports.stopViewer(request.leaseId) }; break;
    case 'locate-folder': {
      let folder: Awaited<ReturnType<PaneEndpointPorts['locateFolder']>>;
      try { folder = await ports.locateFolder(request.cwd); }
      catch { reply = { version: 1, op: request.op, folder: null, unavailable: true }; break; }
      reply = { version: 1, op: request.op, folder, unavailable: false }; break;
    }
    case 'resolve-folder': {
      let folder: Awaited<ReturnType<PaneEndpointPorts['resolveFolder']>>;
      try { folder = await ports.resolveFolder(request.repoKey, request.workspaceId, request.relativeCwd); }
      catch { reply = { version: 1, op: request.op, result: { status: 'unavailable', cwd: null, exists: null } }; break; }
      if (folder.cwd === null && folder.exists === null) reply = { version: 1, op: request.op, result: { status: 'no-mapping', cwd: null, exists: null } };
      else if (folder.cwd !== null && folder.exists === true) reply = { version: 1, op: request.op, result: { status: 'mapped', cwd: folder.cwd, exists: true } };
      else if (folder.cwd !== null && folder.exists === false) reply = { version: 1, op: request.op, result: { status: 'missing', cwd: folder.cwd, exists: false } };
      else throw new HerdrError('invalid-pane-folder', 'Folder result is inconsistent');
      break;
    }
  }
  return parseRemotePaneReply(reply);
}
