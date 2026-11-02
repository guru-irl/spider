// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { join, isAbsolute } from 'node:path';
import { unlink } from 'node:fs/promises';
import type { ProcessPresence, SessionId } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { canonicalSessionFile, recordedExtensionArguments, hash, jsonFiles, readPrivateJson, writePrivateJson } from './registry.js';
export interface PresenceRecord extends ProcessPresence { version: 1; sessionId: SessionId | null; mode: string; extensionArguments: readonly string[] }
export interface ProcessPresenceStore {
  record(record: ProcessPresence & { sessionId?: SessionId | null; mode?: string; extensionArguments?: readonly string[] }): Promise<void>;
  list(): Promise<PresenceRecord[]>;
  remove(identity: { pid: number; startIdentity: string }): Promise<void>;
}
function validate(value: unknown): PresenceRecord {
  const r = value as PresenceRecord;
  if (!r || r.version !== 1 || !Number.isInteger(r.pid) || r.pid <= 0 || typeof r.startIdentity !== 'string' || !r.startIdentity || !(r.sessionFile === null || typeof r.sessionFile === 'string' && isAbsolute(r.sessionFile)) || !(r.sessionId === null || typeof r.sessionId === 'string' && r.sessionId.length > 0) || !(r.sessionName === null || typeof r.sessionName === 'string') || !['top-level', 'child'].includes(r.kind) || typeof r.mode !== 'string' || !(r.hcAddress === null || typeof r.hcAddress === 'string')) throw new HerdrError('invalid-process-presence', 'Process presence has an invalid shape');
  recordedExtensionArguments(r.extensionArguments); return r;
}
export function createProcessPresence(root: string): ProcessPresenceStore {
  const directory = join(root, 'processes'); const path = (id: { pid: number; startIdentity: string }) => join(directory, `${id.pid}-${hash(id.startIdentity)}.json`);
  return {
    async record(r) { await writePrivateJson(path(r), validate({ version: 1, sessionId: r.sessionId ?? null, pid: r.pid, startIdentity: r.startIdentity, sessionFile: r.sessionFile === null ? null : await canonicalSessionFile(r.sessionFile), sessionName: r.sessionName, kind: r.kind, mode: r.mode ?? 'unknown', extensionArguments: recordedExtensionArguments(r.extensionArguments ?? []), hcAddress: r.hcAddress })); },
    async list() { const records = []; for (const p of await jsonFiles(directory)) { const r = await readPrivateJson(p); if (r !== null) records.push(validate(r)); } return records; },
    async remove(id) { await unlink(path(id)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); },
  };
}
