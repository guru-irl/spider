// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { posix, win32 } from 'node:path';
import type { ConsoleId, CoreId, CoreIdentity, Generation, Owner, OwnerPlacement, PaneId, RunId, SessionId, SpaceId, TabId, TerminalAddress, TerminalId, TerminalSummary } from '../contracts.js';
import { HerdrError, integer, object, parseTerminal } from '../client/parse.js';
import type { LegacyPlacementState, PlacementState, PaneTargetLaunch, ManualPaneChoice, FolderChoice, MachineChoice, PaneActionOutcome, PaneAgentRow, PaneConsoleRow, PaneInventoryPage, PaneOpenIntent, PanePresentation, PaneServiceReply, PaneServiceRequest, PaneSlot, PaneTarget, PaneTerminalFacts, RemotePaneReply, RemotePaneRequest } from './types.js';
export const PANE_REPLY_LIMIT: number = 1024 * 1024;
const invalid = (message: string): never => { throw new HerdrError('invalid-pane-data', message); };
export function paneText(value: unknown, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || /[\x00-\x1f\x7f-\x9f]/.test(value) || Buffer.byteLength(value) > 16384) return invalid('Invalid pane text');
  return value;
}
export function paneId(value: unknown): string {
  const id = paneText(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id) || id === '.' || id === '..') return invalid('Invalid pane identifier'); return id;
}
export const parseConsoleId = (value: unknown): ConsoleId => { const id = paneId(value); return /^console-[a-f0-9]{64}$/.test(id) ? id as ConsoleId : invalid('Invalid source console identifier'); };
export function panePath(value: unknown): string {
  const path = paneText(value);
  if (!posix.isAbsolute(path) && !/^[A-Za-z]:[\\/]/.test(path) && !/^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(path)) return invalid('Pane folder must be absolute');
  return path;
}
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);
const bool = (value: unknown): boolean => typeof value === 'boolean' ? value : invalid('Expected a boolean');
export function paneNumber(value: unknown): number { const n = integer(value); return n >= 0 ? n : invalid('Expected a nonnegative integer'); }
const tag = <T extends string>(value: unknown, tags: readonly T[]): T => tags.includes(value as T) ? value as T : invalid('Unknown pane variant');
export function paneRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const record = object(value); if (Object.keys(record).some(key => !fields.includes(key))) return invalid('Unknown pane field'); return record;
}
const list = <T>(value: unknown, parse: (item: unknown) => T, max = 256): T[] => {
  if (!Array.isArray(value) || value.length > max) return invalid('Pane list exceeds its bound'); return value.map(item => parse(item));
};
const labels = (value: unknown): Readonly<Record<string, string>> => {
  const result: Record<string, string> = Object.create(null); const record = object(value);
  if (Object.keys(record).length > 256) return invalid('Too many identity labels');
  for (const [k, v] of Object.entries(record)) result[paneText(k)] = paneText(v, true); return result;
};
export function paneAddress(value: unknown): TerminalAddress {
  const address = paneText(value); const parts = address.split('/');
  if (parts.length > 2) return invalid('Invalid terminal address'); parts.forEach(paneId); return address as TerminalAddress;
}
function summary(value: unknown): TerminalSummary {
  const s = object(value); const status = s.status === null ? null : object(s.status);
  if (status) { paneText(status.state); if (status.msg !== undefined) paneText(status.msg, true); }
  return { address: paneAddress(s.address), parent: nullable(s.parent, paneAddress), labels: labels(s.labels),
    state: tag(s.state, ['live', 'finished']), status: parseTerminal({ ...s, exit_code: s.exitCode, finished_ms: s.finishedAt }).status,
    exitCode: nullable(s.exitCode, integer), reason: nullable(s.reason, v => paneText(v, true)), signal: nullable(s.signal, integer), finishedAt: nullable(s.finishedAt, paneNumber),
    ...(s.notify === undefined ? {} : { notify: bool(s.notify) }), ...(s.cols === undefined ? {} : { cols: paneNumber(s.cols) }), ...(s.rows === undefined ? {} : { rows: paneNumber(s.rows) }) };
}
export function parsePaneTerminal(value: unknown): PaneTerminalFacts {
  const raw = object(value); const parsed = parseTerminal(raw); const foreground = raw.foreground == null ? null : object(raw.foreground);
  const terminal = { ...parsed, address: paneAddress(parsed.address), parent: nullable(parsed.parent, paneAddress), labels: labels(parsed.labels) };
  if (terminal.status?.msg !== undefined) paneText(terminal.status.msg, true);
  if (terminal.reason !== null) paneText(terminal.reason, true);
  return { terminal, currentCwd: foreground?.cwd == null ? null : panePath(foreground.cwd), createdMs: paneNumber(raw.created_ms),
    title: raw.title == null ? '' : paneText(raw.title, true), app: raw.app == null ? null : paneText(raw.app), status: terminal.status?.state ?? null, identityLabels: terminal.labels };
}
export function parseMachineChoices(value: unknown, configured: readonly string[], local: CoreIdentity): MachineChoice[] {
  const coreId = paneId(local.coreId) as CoreId;
  const rows = Array.isArray(value) ? value : object(value).machines;
  const machines = list(rows, value => {
    const row = object(value); const name = paneText(row.name); const aliases = row.aliases === undefined ? [] : list(row.aliases, paneText);
    if (row.target && typeof row.target === 'string') aliases.push(paneText(row.target));
    return { name, aliases, state: tag(row.state, ['connected', 'disconnected']), coreId: row.id == null ? null : paneId(row.id) as CoreId, machineId: row.machine_id == null && row.machineId == null ? null : paneId(row.machine_id ?? row.machineId) };
  });
  for (const machine of machines) if (machine.state === 'connected' && machine.coreId === null) invalid('Connected machine has no core identity');
  const choices: MachineChoice[] = [{ key: coreId, alias: null, label: 'This computer', coreId, machineId: null, state: 'connected' }];
  const keys = new Set<string>([coreId]);
  for (const configuredKey of configured) {
    const key = paneText(configuredKey); if (keys.has(key)) return invalid('Duplicate machine key'); keys.add(key);
    const matching = machines.filter(row => row.name === key || row.aliases.includes(key));
    if (matching.length > 1) return invalid('Ambiguous machine alias');
    const machine = matching[0]; if (machine?.coreId === coreId) continue;
    choices.push({ key, alias: key, label: key, coreId: machine?.coreId ?? null, machineId: machine?.machineId ?? null, state: machine?.state ?? 'disconnected' });
  }
  return choices;
}
export function parseMachineChoice(value: unknown): MachineChoice {
  const r = paneRecord(value, ['key', 'alias', 'label', 'coreId', 'machineId', 'state']);
  const result: MachineChoice = { key: paneText(r.key), alias: nullable(r.alias, paneText), label: paneText(r.label), coreId: nullable(r.coreId, paneId) as CoreId | null, machineId: nullable(r.machineId, paneId), state: tag(r.state, ['connected', 'disconnected']) };
  if (result.state === 'connected' && result.coreId === null) return invalid('Connected machine has no identity'); return result;
}
export function parsePaneTarget(value: unknown): PaneTarget {
  const r = paneRecord(value, ['coreId', 'terminalId', 'address', 'createdMs', 'identityLabels', 'alias', 'machineId', 'kind', 'sessionId', 'generation', 'homeEpoch', 'runId', 'consoleId', 'name', 'cwd']);
  const target: PaneTarget = { coreId: paneId(r.coreId) as CoreId, terminalId: paneId(r.terminalId) as TerminalId, address: paneAddress(r.address), createdMs: paneNumber(r.createdMs), identityLabels: labels(r.identityLabels), alias: nullable(r.alias, paneText), machineId: nullable(r.machineId, paneId), kind: tag(r.kind, ['terminal', 'session', 'subagent', 'console']), sessionId: nullable(r.sessionId, paneId) as SessionId | null, generation: nullable(r.generation, paneId) as Generation | null, homeEpoch: nullable(r.homeEpoch, paneNumber), runId: nullable(r.runId, paneId) as RunId | null, consoleId: nullable(r.consoleId, parseConsoleId), name: nullable(r.name, paneText), cwd: nullable(r.cwd, panePath) };
  if (target.address !== `${target.coreId}/${target.terminalId}` && !(target.alias === null && target.address === String(target.terminalId))) return invalid('Target address differs from core identity');
  if (target.kind !== 'terminal' && target.sessionId === null || target.kind === 'subagent' && target.runId === null || target.kind === 'console' && target.consoleId === null) return invalid('Target lacks source identity');
  return target;
}
export function parsePaneSlot(value: unknown): PaneSlot {
  const r = paneRecord(value, ['space', 'tab', 'pane']); return { space: paneId(r.space) as SpaceId, tab: paneId(r.tab) as TabId, pane: nullable(r.pane, paneId) as PaneId | null };
}
const placement = (value: unknown): OwnerPlacement => { const slot = parsePaneSlot(value); if (slot.pane === null) return invalid('Anchor lacks a pane'); return { ...slot, pane: slot.pane }; };
export function parsePaneOpenIntent(value: unknown): PaneOpenIntent {
  const r = paneRecord(value, ['operationId', 'space', 'place', 'anchor', 'program']);
  const p = object(r.program); const kind = tag(p.kind, ['shell', 'agent']); paneRecord(p, kind === 'shell' ? ['kind'] : ['kind', 'key']);
  const intent: PaneOpenIntent = { operationId: paneId(r.operationId), space: paneId(r.space) as SpaceId, place: tag(r.place, ['tab', 'right', 'down']), anchor: nullable(r.anchor, placement), program: kind === 'shell' ? { kind } : { kind, key: paneText(p.key) } };
  if (intent.place !== 'tab' && (!intent.anchor || intent.anchor.space !== intent.space)) return invalid('Split requires its captured anchor'); return intent;
}
export function parseFolderChoice(value: unknown): FolderChoice { const r = paneRecord(value, ['cwd', 'reason']); return { cwd: nullable(r.cwd, panePath), reason: tag(r.reason, ['focused', 'mapped', 'home']) }; }
export function parsePanePresentation(value: unknown): PanePresentation {
  const r = paneRecord(value, ['id', 'revision', 'mode', 'role', 'target', 'proxy', 'slot', 'visibility', 'launch', 'closeOperationId', 'conversion', 'proxyLaunchAttempts']);
  let conversion: PanePresentation['conversion'] = null;
  if (r.conversion !== null) {
    const c = paneRecord(r.conversion, ['source', 'sourceFocused', 'state', 'destination']);
    const source = placement(c.source), sourceFocused = bool(c.sourceFocused);
    if (c.state === 'waiting-readiness') { if (c.destination !== null) return invalid('Readiness has no destination'); conversion = { source, sourceFocused, state: c.state, destination: null }; }
    else if (c.state === 'waiting-focus') conversion = { source, sourceFocused, state: c.state, destination: parsePaneTarget(c.destination) };
    else return invalid('Unknown conversion state');
  }
  const result: PanePresentation = { id: paneId(r.id), revision: paneNumber(r.revision), mode: tag(r.mode, ['native', 'proxy']), role: tag(r.role, ['shell', 'agent', 'subagent', 'console']), target: parsePaneTarget(r.target), proxy: nullable(r.proxy, paneAddress), slot: nullable(r.slot, parsePaneSlot), visibility: tag(r.visibility, ['visible', 'parked', 'closing', 'ended']), launch: tag(r.launch, ['none', 'claimed', 'acknowledged', 'uncertain']), closeOperationId: nullable(r.closeOperationId, paneId), conversion };
  if (r.proxyLaunchAttempts !== undefined) {
    const count = paneNumber(r.proxyLaunchAttempts);
    if (count > 2) return invalid('Invalid proxy launch count');
    result.proxyLaunchAttempts = count;
  }
  if (result.visibility === 'closing' && result.closeOperationId === null) return invalid('Closing requires confirmed intent'); return result;
}
function owner(value: unknown): Owner {
  const r = paneRecord(value, ['sessionId', 'generation', 'terminal', 'cwd', 'sessionFile', 'name']);
  const t = paneRecord(r.terminal, ['coreId', 'socket', 'sessionNamespace', 'terminalId', 'address']);
  const coreId = paneId(t.coreId) as CoreId, terminalId = paneId(t.terminalId) as TerminalId, address = paneAddress(t.address);
  if (address !== String(terminalId) && address !== `${coreId}/${terminalId}`) return invalid('Owner address differs from identity');
  return { sessionId: paneId(r.sessionId) as SessionId, generation: paneId(r.generation) as Generation, terminal: { coreId, terminalId, address, socket: panePath(t.socket), sessionNamespace: paneId(t.sessionNamespace) }, cwd: panePath(r.cwd), sessionFile: nullable(r.sessionFile, panePath), name: nullable(r.name, paneText) };
}
export function parsePaneConsoleRow(value: unknown): PaneConsoleRow {
  const r = paneRecord(value, ['consoleId', 'machineKey', 'name', 'target']);
  const consoleId = parseConsoleId(r.consoleId), target = nullable(r.target, parsePaneTarget);
  if (target && (target.kind !== 'console' || target.consoleId !== consoleId)) return invalid('Console descriptor target differs');
  return { consoleId, machineKey: paneText(r.machineKey), name: nullable(r.name, paneText), target };
}
export function parsePaneAgentRow(value: unknown): PaneAgentRow {
  const r = paneRecord(value, ['sessionId', 'generation', 'name', 'owner', 'target', 'status', 'updatedAt', 'machineKey', 'unavailableReason', 'children', 'consoles']);
  const base = { sessionId: paneId(r.sessionId) as SessionId, name: nullable(r.name, paneText), status: paneText(r.status), updatedAt: paneNumber(r.updatedAt), machineKey: paneText(r.machineKey) };
  const generation = nullable(r.generation, paneId) as Generation | null;
  const sourceOwner = nullable(r.owner, owner), target = nullable(r.target, parsePaneTarget);
  const children = list(r.children, v => { const c = paneRecord(v, ['runId', 'name', 'status']); return { runId: paneId(c.runId) as RunId, name: nullable(c.name, paneText), status: paneText(c.status) }; });
  const consoles = list(r.consoles, parsePaneConsoleRow);
  const unavailableReason = nullable(r.unavailableReason, v => tag(v, ['not-in-hc']));
  if (unavailableReason === 'not-in-hc') {
    if (sourceOwner !== null || target !== null || children.length || consoles.length) return invalid('Display-only inventory cannot carry authority');
    return { ...base, generation, owner: null, target: null, unavailableReason, children: [], consoles: [] };
  }
  if (!generation || !sourceOwner || !target) return invalid('Inventory availability contradicts identity');
  if (sourceOwner.sessionId !== base.sessionId || sourceOwner.generation !== generation || target.sessionId !== base.sessionId || target.generation !== generation) return invalid('Inventory source identity differs');
  if (consoles.some(console => console.target && (console.target.sessionId !== base.sessionId || console.target.generation !== generation))) return invalid('Console source identity differs');
  if (new Set(consoles.map(console => console.consoleId)).size !== consoles.length) return invalid('Duplicate source console identifier');
  return { ...base, generation, owner: sourceOwner, target, unavailableReason: null, children, consoles };
}
export function parsePaneInventoryPage(value: unknown): PaneInventoryPage {
  bounded(value); const r = paneRecord(value, ['version', 'rows', 'next', 'complete']); version(r);
  return { version: 1, rows: list(r.rows, parsePaneAgentRow), next: nullable(r.next, v => cursor(v)), complete: bool(r.complete) };
}
const outcome = (value: unknown): PaneActionOutcome => { const r = paneRecord(value, ['status', 'reason', 'presentation']); return { status: tag(r.status, ['complete', 'pending', 'refused']), reason: paneText(r.reason, true), presentation: nullable(r.presentation, parsePanePresentation) }; };
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value) ?? '') > PANE_REPLY_LIMIT) invalid('Pane payload exceeds 1 MiB'); }
function version(r: Record<string, unknown>): void { if (r.version !== 1) invalid('Unsupported pane protocol'); }
function cursor(value: unknown): string { const s = paneText(value); if (Buffer.byteLength(s) > 1024) return invalid('Cursor exceeds 1024 bytes'); return s; }
function digest(value: unknown): string { const s = paneText(value); return /^[a-f0-9]{64}$/.test(s) ? s : invalid('Invalid build digest'); }
function relativeCwd(value: unknown): string { const s = paneText(value, true); if (posix.isAbsolute(s) || win32.isAbsolute(s) || /^[A-Za-z]:/.test(s) || s.split(/[\\/]/).includes('..')) return invalid('Invalid checkout-relative folder'); return s; }
function verifiedTarget(value: unknown): PaneTarget { const target = parsePaneTarget(value); if (target.kind !== 'terminal' && target.generation === null) return invalid('Unverified generation cannot authorize mutation'); return target; }
export function parsePaneServiceRequest(value: unknown): PaneServiceRequest {
  bounded(value); const r = object(value); version(r); const base = { version: 1 as const, operationId: paneId(r.operationId) };
  const fields = ['version', 'operationId', 'op'];
  const check = (...extra: string[]) => paneRecord(r, [...fields, ...extra]);
  const bound = () => ({ ...base, presentationId: paneId(r.presentationId), expectedRevision: paneNumber(r.expectedRevision) });
  switch (r.op) {
    case 'snapshot': check(); return { ...base, op: r.op };
    case 'open': { check('intent', 'machineKey', 'coreId', 'machineId'); const intent = parsePaneOpenIntent(r.intent); if (intent.operationId !== base.operationId) return invalid('Creation operation differs'); return { ...base, op: r.op, intent, machineKey: paneText(r.machineKey), coreId: paneId(r.coreId) as CoreId, machineId: nullable(r.machineId, paneId) }; }
    case 'open-existing':
      if ('presentationId' in r) {
        check('presentationId', 'expectedRevision', 'targetIncarnation');
        const t = paneRecord(r.targetIncarnation, ['coreId', 'terminalId', 'createdMs']);
        return { ...bound(), op: r.op, targetIncarnation: { coreId: paneId(t.coreId) as CoreId, terminalId: paneId(t.terminalId) as TerminalId, createdMs: paneNumber(t.createdMs) } };
      }
      check('sessionId', 'generation', 'slot'); return { ...base, op: r.op, sessionId: paneId(r.sessionId) as SessionId, generation: paneId(r.generation) as Generation, slot: nullable(r.slot, parsePaneSlot) };
    case 'open-auxiliary': { check('sessionId', 'generation', 'mode', 'view'); const v = object(r.view); const kind = tag(v.kind, ['subagent', 'console']); paneRecord(v, kind === 'subagent' ? ['kind', 'runId'] : ['kind', 'machineKey', 'consoleId']); return { ...base, op: r.op, sessionId: paneId(r.sessionId) as SessionId, generation: paneId(r.generation) as Generation, ...('mode' in r ? { mode: tag(r.mode, ['automatic', 'explicit'] as const) } : {}), view: kind === 'subagent' ? { kind, runId: paneId(v.runId) as RunId } : { kind, machineKey: paneText(v.machineKey), consoleId: parseConsoleId(v.consoleId) } }; }
    case 'move': check('presentationId', 'expectedRevision', 'slot'); return { ...bound(), op: r.op, slot: parsePaneSlot(r.slot) };
    case 'park': check('presentationId', 'expectedRevision'); return { ...bound(), op: r.op };
    case 'close-confirmed': case 'present-ready': check('presentationId', 'expectedRevision', 'target'); return { ...bound(), op: r.op, target: verifiedTarget(r.target) };
    case 'prepare-handoff': check('presentationId', 'expectedRevision', 'sessionId', 'generation', 'homeEpoch'); return { ...bound(), op: r.op, sessionId: paneId(r.sessionId) as SessionId, generation: paneId(r.generation) as Generation, homeEpoch: paneNumber(r.homeEpoch) };
    default: return invalid('Unknown pane operation');
  }
}
export function parseRemotePaneRequest(value: unknown): RemotePaneRequest {
  bounded(value); const r = object(value); version(r);
  const check = (...extra: string[]) => paneRecord(r, ['version', 'op', ...extra]);
  const session = () => ({ sessionId: paneId(r.sessionId) as SessionId, generation: paneId(r.generation) as Generation });
  const base = { version: 1 as const };
  switch (r.op) {
    case 'handshake': check('protocol', 'buildDigest'); return { ...base, op: r.op, protocol: paneNumber(r.protocol), buildDigest: digest(r.buildDigest) };
    case 'list': check('cursor'); return { ...base, op: r.op, cursor: nullable(r.cursor, cursor) };
    case 'locate-folder': check('cwd'); return { ...base, op: r.op, cwd: panePath(r.cwd) };
    case 'resolve-folder': check('repoKey', 'workspaceId', 'relativeCwd'); return { ...base, op: r.op, repoKey: paneText(r.repoKey), workspaceId: paneText(r.workspaceId), relativeCwd: relativeCwd(r.relativeCwd) };
    case 'launch-viewer': check('sessionId', 'generation', 'runId', 'leaseId'); return { ...base, op: r.op, ...session(), runId: paneId(r.runId) as RunId, leaseId: paneId(r.leaseId) };
    case 'renew-viewers': check('leases'); return { ...base, op: r.op, leases: list(r.leases, value => { const lease = paneRecord(value, ['leaseId', 'generation']); return { leaseId: paneId(lease.leaseId), generation: paneId(lease.generation) as Generation }; }) };
    case 'stop-viewer': check('leaseId'); return { ...base, op: r.op, leaseId: paneId(r.leaseId) };
    case 'open-console': check('sessionId', 'generation', 'machineKey', 'consoleId', 'leaseId'); return { ...base, op: r.op, ...session(), machineKey: paneText(r.machineKey), consoleId: parseConsoleId(r.consoleId), leaseId: paneId(r.leaseId) };
    case 'close-session': check('sessionId', 'generation', 'homeEpoch', 'operationId'); return { ...base, op: r.op, ...session(), homeEpoch: paneNumber(r.homeEpoch), operationId: paneId(r.operationId) };
    default: return invalid('Unknown remote pane operation');
  }
}
export function parsePaneServiceReply(value: unknown): PaneServiceReply {
  bounded(value); const r = object(value); version(r);
  if (r.kind === 'outcome') { paneRecord(r, ['version', 'kind', 'outcome']); return { version: 1, kind: r.kind, outcome: outcome(r.outcome) }; }
  if (r.kind !== 'snapshot') return invalid('Unknown pane reply');
  paneRecord(r, ['version', 'kind', 'revision', 'machines', 'presentations', 'rows', 'targetFacts', 'complete', 'omittedRows']);
  const targetFacts: Record<string, PaneTerminalFacts> = Object.create(null);
  for (const [key, value] of Object.entries(object(r.targetFacts))) {
    if (!key.includes('/')) return invalid('Facts key must be core-qualified'); paneAddress(key);
    const f = paneRecord(value, ['terminal', 'currentCwd', 'createdMs', 'title', 'app', 'status', 'identityLabels']);
    targetFacts[key] = { terminal: summary(f.terminal), currentCwd: nullable(f.currentCwd, panePath), createdMs: paneNumber(f.createdMs), title: paneText(f.title, true), app: nullable(f.app, paneText), status: nullable(f.status, paneText), identityLabels: labels(f.identityLabels) };
  }
  const complete = bool(r.complete), omittedRows = paneNumber(r.omittedRows);
  if (complete && omittedRows !== 0) return invalid('Complete display snapshot cannot omit rows');
  return { version: 1, kind: r.kind, complete, omittedRows, revision: paneNumber(r.revision), machines: list(r.machines, parseMachineChoice), presentations: list(r.presentations, parsePanePresentation), rows: list(r.rows, parsePaneAgentRow), targetFacts };
}
export function parseRemotePaneReply(value: unknown): RemotePaneReply {
  bounded(value); const r = object(value); version(r); const check = (...fields: string[]) => paneRecord(r, ['version', 'op', ...fields]);
  const base = { version: 1 as const };
  switch (r.op) {
    case 'handshake': check('protocol', 'buildDigest'); return { ...base, op: r.op, protocol: paneNumber(r.protocol), buildDigest: digest(r.buildDigest) };
    case 'list': check('page'); return { ...base, op: r.op, page: parsePaneInventoryPage(r.page) };
    case 'locate-folder': { check('folder', 'unavailable'); const folder = nullable(r.folder, v => { const f = paneRecord(v, ['repoKey', 'workspaceId', 'relativeCwd']); return { repoKey: paneText(f.repoKey), workspaceId: paneText(f.workspaceId), relativeCwd: relativeCwd(f.relativeCwd) }; }); const unavailable = bool(r.unavailable); if (unavailable && folder) return invalid('Unavailable folder has no mapping'); return { ...base, op: r.op, folder, unavailable }; }
    case 'resolve-folder': { check('result'); const f = paneRecord(r.result, ['status', 'cwd', 'exists']); const status = tag(f.status, ['no-mapping', 'unavailable', 'missing', 'mapped']); if (status === 'no-mapping' || status === 'unavailable') { if (f.cwd !== null || f.exists !== null) return invalid('Unresolved folder has no path'); return { ...base, op: r.op, result: { status, cwd: null, exists: null } }; } if (f.exists !== (status === 'mapped')) return invalid('Folder existence contradicts status'); return { ...base, op: r.op, result: status === 'mapped' ? { status, cwd: panePath(f.cwd), exists: true } : { status, cwd: panePath(f.cwd), exists: false } }; }
    case 'launch-viewer': case 'open-console': check('target'); return { ...base, op: r.op, target: nullable(r.target, verifiedTarget) };
    case 'renew-viewers': case 'stop-viewer': case 'close-session': check('outcome'); return { ...base, op: r.op, outcome: outcome(r.outcome) };
    default: return invalid('Unknown remote pane reply');
  }
}
function legacyAddress(value: unknown): TerminalAddress {
  const address = paneText(value); const parts = address.split('/');
  if (parts.length === 2 && /^-[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(parts[0])) { paneId(parts[1]); return address as TerminalAddress; }
  return paneAddress(address);
}
export function parseLegacyPlacementState(value: unknown): LegacyPlacementState {
  bounded(value); const r = paneRecord(value, ['version', 'slots', 'attempts']);
  if (r.version !== 1) return invalid('Unsupported placement schema');
  const slots = list(r.slots, value => { const s = paneRecord(value, ['session', 'space', 'tab']); return { session: paneId(s.session), space: paneId(s.space), tab: paneId(s.tab) }; }, 4096);
  const attempts = list(r.attempts, value => {
    const a = paneRecord(value, ['session', 'remote', 'core', 'proxy', 'closed', 'localOwners', 'failure']);
    const failure = a.failure === undefined ? undefined : (() => { const f = paneRecord(a.failure, ['attempts', 'retryable']); const count = paneNumber(f.attempts); if (count < 1 || count > 2) return invalid('Invalid legacy launch count'); return { attempts: count, retryable: bool(f.retryable) }; })();
    return { session: paneId(a.session), remote: legacyAddress(a.remote), core: paneId(a.core), proxy: nullable(a.proxy, paneAddress), closed: bool(a.closed), localOwners: list(a.localOwners, paneText, 4096), ...(failure === undefined ? {} : { failure }) };
  }, 4096);
  return { version: 1, slots, attempts };
}
export function parsePlacementState(value: unknown): PlacementState {
  bounded(value); const r = paneRecord(value, ['version', 'revision', 'slots', 'attempts', 'presentations', 'choices', 'launches']);
  if (r.version !== 2) return invalid('Unsupported placement schema');
  const legacy = parseLegacyPlacementState({ version: 1, slots: r.slots, attempts: r.attempts });
  const presentations = list(r.presentations, parsePanePresentation, 4096);
  const choices = list(r.choices, (value): ManualPaneChoice => { const c = paneRecord(value, ['session', 'space', 'tab', 'revision']); return { session: paneId(c.session) as SessionId, space: paneId(c.space) as SpaceId, tab: paneId(c.tab) as TabId, revision: paneNumber(c.revision) }; }, 4096);
  const launches = list(r.launches, (value): PaneTargetLaunch => {
    const l = paneRecord(value, ['operationId', 'coreId', 'machineKey', 'intent', 'folder', 'state', 'target', 'failure']);
    const launch: PaneTargetLaunch = { operationId: paneId(l.operationId), coreId: paneId(l.coreId) as CoreId, machineKey: paneText(l.machineKey), intent: parsePaneOpenIntent(l.intent), folder: parseFolderChoice(l.folder), state: tag(l.state, ['claimed', 'not-started', 'uncertain', 'observed']), target: nullable(l.target, parsePaneTarget), failure: nullable(l.failure, paneText) };
    if (launch.operationId !== launch.intent.operationId || launch.state === 'observed' && !launch.target || launch.state === 'not-started' && launch.target) return invalid('Launch claim contradicts its observation');
    if (launch.target && (launch.target.coreId !== launch.coreId || launch.target.identityLabels['spider.pane-operation'] !== launch.operationId)) return invalid('Launch target lacks verified operation identity');
    return launch;
  }, 4096);
  const unique = (keys: readonly string[]) => { if (new Set(keys).size !== keys.length) invalid('Duplicate placement record'); };
  unique(presentations.map(p => p.id)); unique(choices.map(c => c.session)); unique(launches.map(l => l.operationId));
  return { version: 2, revision: paneNumber(r.revision), slots: legacy.slots, attempts: legacy.attempts, presentations, choices, launches };
}
export const encodePaneServiceRequest = (value: PaneServiceRequest): string => JSON.stringify(parsePaneServiceRequest(value));
export const encodePaneServiceReply = (value: PaneServiceReply): string => JSON.stringify(parsePaneServiceReply(value));
export const encodeRemotePaneRequest = (value: RemotePaneRequest): string => JSON.stringify(parseRemotePaneRequest(value));
export const encodeRemotePaneReply = (value: RemotePaneReply): string => JSON.stringify(parseRemotePaneReply(value));
