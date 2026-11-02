// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { HerdrConfig, SessionId } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { canonicalSessionFile, type TerminalRegistry } from '../sessions/registry.js';
import { assessSessionLiveness, inventorySnapshot, type ProcessInventoryPorts } from '../sessions/lease.js';
import { readSessionHeader } from '../sessions/launcher.js';
export interface SessionDiscoveryPorts { processInventory: ProcessInventoryPorts; registry: TerminalRegistry; listSessionFiles(config: HerdrConfig): Promise<readonly string[]>; reportSkipped?(count: number): void }
/** Unselected recorded owners are irrelevant; unrecorded pi remains blocking for a nonempty selection. */
export function selectedProcessInventory(config: HerdrConfig, inventory: ProcessInventoryPorts, selections: readonly { file: string | null; sessionId: SessionId | null }[] = []): ProcessInventoryPorts {
  const selectors = config.spaces.flatMap(space => space.sessions);
  const files = new Set([...selectors.flatMap(selector => 'file' in selector ? [selector.file] : []), ...selections.flatMap(s => s.file ? [s.file] : [])]);
  const ids = new Set([...selectors.flatMap(selector => 'name' in selector && selector.sessionId ? [selector.sessionId] : []), ...selections.flatMap(s => s.sessionId ? [s.sessionId] : [])]);
  const selected = async (record: import('../sessions/presence.js').PresenceRecord) => {
    if (record.sessionId && ids.has(record.sessionId)) return true;
    if (record.sessionFile) { const canonical = await canonicalSessionFile(record.sessionFile); for (const file of files) if (canonical === await canonicalSessionFile(file)) return true; }
    return selectors.some(selector => 'name' in selector && selector.name === record.sessionName && (!selector.sessionId || selector.sessionId === record.sessionId));
  };
  return { ...inventory,
    probe: async pid => {
      const process = await inventory.probe(pid);
      if (process.kind === 'live') {
        const current = (await inventory.presence.list()).find(record => record.pid === pid && record.startIdentity === process.startIdentity);
        if (current && !await selected(current)) return { kind: 'absent' };
      }
      return process;
    },
    presence: { ...inventory.presence, list: async () => selectors.length ? (await Promise.all((await inventory.presence.list()).map(async record => await selected(record) ? record : null))).filter(record => record !== null) : [] },
    processes: async () => {
      if (!selectors.length) return [];
      const records = await inventory.presence.list(), result = [];
      for (const process of await inventory.processes()) {
        const record = records.find(record => record.pid === process.pid && record.startIdentity === process.startIdentity);
        if (!record || await selected(record)) result.push(process);
      }
      return result;
    },
  };
}
export interface SessionSelection { file: string | null; sessionId: SessionId | null; name: string | null; cwd: string | null; spaceName: string; spaceOrder: number; sessionOrder: number; extensionArguments: readonly string[] }
export interface ResolvedSession extends SessionSelection { file: string; sessionId: SessionId; cwd: string }
export interface SessionManifest { config: HerdrConfig; sessions: SessionSelection[]; unresolved: boolean }
/** Scan the whole snapshot in fixed chunks. Oversized message records never accumulate in memory. */
export async function readSessionMetadata(file: string): Promise<{ file: string; sessionId: SessionId; name: string | null; cwd: string }> {
  const header = await readSessionHeader(file); const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = (await handle.stat()).size, maxRecord = 1024 * 1024;
    const buffer = Buffer.alloc(65536);
    let position = 0, pending: Buffer = Buffer.alloc(0), skipping = false, name: string | null = null;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) throw new HerdrError('session-metadata-changed', 'Session changed during metadata lookup');
      position += bytesRead;
      let start = 0;
      while (start < bytesRead) {
        const newline = buffer.indexOf(10, start), end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
        if (!skipping) {
          if (pending.length + end - start > maxRecord) { pending = Buffer.alloc(0); skipping = true; }
          else pending = Buffer.concat([pending, buffer.subarray(start, end)]);
        }
        if (end === bytesRead) break;
        if (!skipping) {
          const line = pending.toString('utf8');
          if (/"type"\s*:\s*"session_info"/.test(line)) {
            const value = JSON.parse(line) as { type?: unknown; name?: unknown };
            if (value.type === 'session_info') {
              if (!(value.name === undefined || typeof value.name === 'string')) throw new HerdrError('session-metadata-invalid', 'Session name is invalid');
              name = value.name ?? null;
            }
          }
        }
        pending = Buffer.alloc(0); skipping = false; start = end + 1;
      }
    }
    // The final fragment is not a committed record.
    return { file, sessionId: header.id, name, cwd: header.cwd };
  } finally { await handle.close(); }
}
export async function discoverSessions(config: HerdrConfig, ports: SessionDiscoveryPorts): Promise<SessionManifest> {
  if (!config.spaces.some(space => space.sessions.length)) return { config, sessions: [], unresolved: false };
  const allRecords = await ports.processInventory.presence.list();
  const liveRecords = [];
  for (const record of allRecords) {
    const process = await ports.processInventory.probe(record.pid);
    if (process.kind === 'absent' || process.kind === 'live' && process.startIdentity !== record.startIdentity && allRecords.some(current => current.pid === record.pid && current.startIdentity === process.startIdentity)) continue;
    liveRecords.push(record);
  }
  const inventory = selectedProcessInventory(config, ports.processInventory);
  const snapshot = await inventorySnapshot(inventory); const mappings = await ports.registry.list();
  const needsNames = config.spaces.some(space => space.sessions.some(selector => 'name' in selector));
  const candidates = new Set(needsNames ? await ports.listSessionFiles(config) : []);
  const explicit = new Set(config.spaces.flatMap(space => space.sessions.flatMap(selector => 'file' in selector ? [selector.file] : [])));
  let skipped = 0;
  for (const space of config.spaces) for (const selector of space.sessions) if ('file' in selector) candidates.add(selector.file);
  for (const r of liveRecords) if (r.sessionFile !== null) candidates.add(r.sessionFile);
  const rows: { file: string; sessionId: SessionId | null; name: string | null; cwd: string | null; extensionArguments: readonly string[] }[] = [];
  const unsafe = snapshot.unknownPids.length > 0 || snapshot.uncertainPids.length > 0;
  for (const path of candidates) {
    try {
    const file = await canonicalSessionFile(path); if (rows.some(r => r.file === file)) continue;
    const live = liveRecords.filter(r => r.sessionFile === file);
    const mapping = mappings.filter(m => m.owner.sessionFile === file).sort((a, b) => b.recordedAt - a.recordedAt)[0];
    const extensionArguments = live.length ? live.flatMap(r => r.extensionArguments) : mapping?.environment.extensionArguments ?? [];
    if (live.length || unsafe || (await assessSessionLiveness(file, inventory)).kind !== 'free') {
      rows.push({ file, sessionId: live[0]?.sessionId ?? mapping?.owner.sessionId ?? null, name: live[0]?.sessionName ?? mapping?.owner.name ?? null, cwd: mapping?.owner.cwd ?? null, extensionArguments });
    } else rows.push({ ...await readSessionMetadata(file), extensionArguments });
    } catch (error) { if (explicit.has(path)) throw error; skipped++; }
  }
  if (skipped) ports.reportSkipped?.(skipped);
  const sessions: SessionSelection[] = []; let unresolved = false;
  for (const [spaceOrder, space] of config.spaces.entries()) for (const [sessionOrder, selector] of space.sessions.entries()) {
    const selectedFile = 'file' in selector ? await canonicalSessionFile(selector.file) : null;
    const matches = rows.filter(r => selectedFile !== null ? r.file === selectedFile : 'name' in selector && r.name === selector.name && (!selector.sessionId || r.sessionId === null || r.sessionId === selector.sessionId));
    if (matches.length > 1) throw new HerdrError('session-selector-ambiguous', 'Duplicate session names require an exact session ID');
    if (!matches.length && !unsafe) throw new HerdrError('session-selector-missing', 'Configured session selector has no match');
    const row = matches[0] ?? { file: selectedFile, sessionId: 'sessionId' in selector ? selector.sessionId as SessionId ?? null : null, name: 'name' in selector ? selector.name : null, cwd: null, extensionArguments: [] };
    if (row.file !== null && sessions.some(s => s.file === row.file)) throw new HerdrError('session-selector-duplicate', 'A session file cannot occupy two configured tabs');
    unresolved ||= row.file === null || row.sessionId === null || row.cwd === null;
    sessions.push({ ...row, spaceName: space.name, spaceOrder, sessionOrder });
  }
  return { config, sessions, unresolved };
}
