// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, link, unlink, chmod, realpath, rmdir, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HerdrError, object, text } from '../client/parse.js';
import type { TerminalAddress } from '../contracts.js';
import type { InstallFile, NodeObservation, CutoverResult, RuntimeRootObservation } from './installer.js';
import { changedSetupFilesNotice } from '../notices.js';
import { isRuntimeRootProbe } from '../remote/node-version.js';
export const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export interface FileSnapshot {
  bytes: Buffer | null;
  hash: string | null;
  mode: number;
}
export const missingKeyMapMessage = 'Open Herdr once so it creates its default key map, then rerun setup.';
export type KeyBinding = string | { command: string; args: Record<string, unknown> };
export type KeySections = Readonly<Record<string, Readonly<Record<string, KeyBinding>>>>;
export type KeyFields = Readonly<Record<string, readonly string[]>>;
type KeyBaseline = { present: false } | { present: true; value: unknown };
type KeyBaselines = Readonly<Record<string, Readonly<Record<string, KeyBaseline>>>>;
type PathBaseline = ({ present: false } | { present: true; value: unknown }) & { parents: readonly boolean[] };
type PathBaselines = Readonly<Record<string, PathBaseline>>;
export type ManagedPart = { kind: 'json'; fields: readonly string[]; section?: string } | { kind: 'json-paths'; paths: readonly string[] } | { kind: 'keys'; sections: KeyFields } | { kind: 'notes' } | { kind: 'resume' };
function pathParts(path: string): string[] {
  const parts = path.split('.');
  if (!parts.length || parts.some(part => !/^[a-zA-Z0-9_-]+$/.test(part) || ['__proto__', 'prototype', 'constructor'].includes(part))) throw new HerdrError('setup-journal-invalid', 'Invalid managed JSON path');
  return parts;
}
function pathBaseline(bytes: Buffer | null, path: string): PathBaseline {
  const parts = pathParts(path), parents: boolean[] = [];
  let value: unknown = bytes === null ? {} : object(JSON.parse(bytes.toString('utf8')));
  for (let i = 0; i < parts.length; i++) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HerdrError('invalid-app-settings', `Expected an object while reading ${path}`);
    const source = value as Record<string, unknown>, present = Object.hasOwn(source, parts[i]);
    if (i < parts.length - 1) parents.push(present);
    if (!present) return { present: false, parents: [...parents, ...Array(parts.length - 1 - parents.length).fill(false)] };
    value = source[parts[i]];
  }
  return { present: true, value, parents };
}
function samePath(a: PathBaseline, b: PathBaseline): boolean {
  return a.present === b.present && (!a.present || b.present && canonicalJson(a.value) === canonicalJson(b.value));
}
function restorePath(json: Record<string, unknown>, path: string, baseline: PathBaseline): void {
  const parts = pathParts(path), parents: { source: Record<string, unknown>; key: string }[] = [];
  let source = json;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!Object.hasOwn(source, key)) { if (!baseline.present) return; source[key] = {}; }
    const next = source[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new HerdrError('invalid-app-settings', `Expected an object while restoring ${path}`);
    parents.push({ source, key }); source = next as Record<string, unknown>;
  }
  const key = parts[parts.length - 1];
  if (baseline.present) source[key] = baseline.value; else delete source[key];
  for (let i = parents.length - 1; i >= 0; i--) {
    const parent = parents[i], child = parent.source[parent.key] as Record<string, unknown>;
    if (!baseline.parents[i] && Object.keys(child).length === 0) delete parent.source[parent.key];
  }
}
interface JsonField { name: string; keyStart: number; valueStart: number; valueEnd: number; commaBefore?: number; commaAfter?: number }
function jsonStringEnd(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === '"') return i + 1;
  }
  throw new HerdrError('invalid-app-settings', 'Unterminated JSON string');
}
function jsonValueEnd(source: string, start: number): number {
  if (source[start] === '"') return jsonStringEnd(source, start);
  if (source[start] !== '{' && source[start] !== '[') { let i = start; while (i < source.length && !/[\s,}\]]/.test(source[i])) i++; return i; }
  const stack: string[] = [];
  for (let i = start; i < source.length; i++) {
    if (source[i] === '"') { i = jsonStringEnd(source, i) - 1; continue; }
    if (source[i] === '{' || source[i] === '[') stack.push(source[i]);
    if (source[i] === '}' || source[i] === ']') { stack.pop(); if (!stack.length) return i + 1; }
  }
  throw new HerdrError('invalid-app-settings', 'Unterminated JSON value');
}
function jsonFields(source: string, start: number): JsonField[] {
  if (source[start] !== '{') throw new HerdrError('invalid-app-settings', 'Expected a JSON object');
  const fields: JsonField[] = []; let i = start + 1, previous: number | undefined;
  const whitespace = () => { while (/\s/.test(source[i] ?? '') && i < source.length) i++; };
  whitespace();
  while (source[i] !== '}') {
    const keyStart = i, keyEnd = jsonStringEnd(source, i), name = JSON.parse(source.slice(i, keyEnd)) as string;
    i = keyEnd; whitespace(); if (source[i++] !== ':') throw new HerdrError('invalid-app-settings', 'Invalid JSON field');
    whitespace(); const valueStart = i, valueEnd = jsonValueEnd(source, i); i = valueEnd; whitespace();
    const commaAfter = source[i] === ',' ? i : undefined;
    fields.push({ name, keyStart, valueStart, valueEnd, commaBefore: previous, commaAfter });
    if (commaAfter === undefined) break;
    previous = commaAfter; i++; whitespace();
  }
  return fields;
}
function jsonField(source: string, start: number, name: string): JsonField | undefined {
  const matches = jsonFields(source, start).filter(field => field.name === name);
  if (matches.length > 1) throw new HerdrError('invalid-app-settings', `Duplicate managed JSON field: ${name}`);
  return matches[0];
}
function removeJsonField(source: string, field: JsonField): string {
  const start = field.commaAfter === undefined && field.commaBefore !== undefined ? field.commaBefore : field.keyStart;
  const end = field.commaAfter === undefined ? field.valueEnd : field.commaAfter + 1;
  return source.slice(0, start) + source.slice(end);
}
function editJsonPath(source: string, path: string, baseline: PathBaseline): string {
  object(JSON.parse(source));
  const parts = pathParts(path); let start = source.search(/\S/);
  for (let i = 0; i < parts.length; i++) {
    const field = jsonField(source, start, parts[i]);
    if (i === parts.length - 1) {
      if (baseline.present) {
        const value = JSON.stringify(baseline.value);
        if (field) return source.slice(0, field.valueStart) + value + source.slice(field.valueEnd);
        const fields = jsonFields(source, start), at = fields.length ? fields[fields.length - 1].valueEnd : start + 1;
        return source.slice(0, at) + (fields.length ? ',' : '') + JSON.stringify(parts[i]) + ':' + value + source.slice(at);
      }
      if (!field) return source;
      source = removeJsonField(source, field);
      for (let depth = parts.length - 2; depth >= 0; depth--) {
        if (baseline.parents[depth]) break;
        let parent = source.search(/\S/), target: JsonField | undefined;
        for (let j = 0; j <= depth; j++) { target = jsonField(source, parent, parts[j]); if (!target) break; if (j < depth) parent = target.valueStart; }
        if (!target || source[target.valueStart] !== '{' || jsonFields(source, target.valueStart).length) break;
        source = removeJsonField(source, target);
      }
      return source;
    }
    if (!field) {
      if (!baseline.present) return source;
      let value: unknown = baseline.value;
      for (let j = parts.length - 1; j > i; j--) value = { [parts[j]]: value };
      const fields = jsonFields(source, start), at = fields.length ? fields[fields.length - 1].valueEnd : start + 1;
      return source.slice(0, at) + (fields.length ? ',' : '') + JSON.stringify(parts[i]) + ':' + JSON.stringify(value) + source.slice(at);
    }
    start = field.valueStart;
  }
  return source;
}
export function managedProjection(bytes: Buffer | null, part: ManagedPart): string {
  if (part.kind === 'json-paths') return JSON.stringify(part.paths.map(path => { const baseline = pathBaseline(bytes, path); return [path, baseline.present, baseline.present ? baseline.value : undefined]; }));
  if (part.kind === 'keys') {
    const json = bytes === null ? {} : object(JSON.parse(bytes.toString('utf8')));
    return canonicalJson(Object.entries(part.sections).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([section, keys]) => {
      const source = object(json[section] ?? {});
      return [section, [...keys].sort().map(key => [key, Object.hasOwn(source, key), source[key]])];
    }));
  }
  if (part.kind === 'json') {
    const json = bytes === null ? {} : object(JSON.parse(bytes.toString('utf8')));
    const source = part.section ? object(json[part.section] ?? {}) : json;
    return JSON.stringify(part.fields.map(field => [field, Object.hasOwn(source, field), source[field]]));
  }
  const source = bytes?.toString('utf8') ?? '';
  if (part.kind === 'resume') {
    const blocks = source.match(/^# spider:resume:start\n[\s\S]*?^# spider:resume:end(?:\n|$)/gm) ?? [];
    const starts = source.split('# spider:resume:start').length - 1, ends = source.split('# spider:resume:end').length - 1;
    if (blocks.length > 1 || starts !== ends || starts !== blocks.length) throw new HerdrError('managed-artifact-changed', 'Restore one recorded spider resume block before rerunning setup');
    return blocks[0]?.trimEnd() ?? '';
  }
  return JSON.stringify(rootNotesValue(bytes));
}
function scanRootToml(bytes: Buffer | null): { input: string; rootEnd: number; keys: { start: number; line: string }[] } {
  const input = bytes?.toString('utf8') ?? '', keys: { start: number; line: string }[] = [];
  let quote: string | null = null, triple = false, depth = 0, offset = 0;
  for (const line of input.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (quote === null && depth === 0) {
      if (/^\s*\[/.test(line)) return { input, rootEnd: offset, keys };
      if (/^\s*(?:notes|"notes"|'notes')\s*=/.test(line)) keys.push({ start: offset, line });
    }
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quote !== null) {
        if (quote === '"' && char === '\\') { i++; continue; }
        if (triple ? line.startsWith(quote.repeat(3), i) : char === quote) {
          if (triple) i += 2;
          quote = null; triple = false;
        }
      } else if (char === '#') break;
      else if (char === '"' || char === "'") {
        quote = char; triple = line.startsWith(char.repeat(3), i);
        if (triple) i += 2;
      } else if (char === '[') depth++;
      else if (char === ']') depth--;
    }
    offset += line.length;
  }
  return { input, rootEnd: input.length, keys };
}
export function rootToml(bytes: Buffer | null): string {
  const scan = scanRootToml(bytes); return scan.input.slice(0, scan.rootEnd);
}
export function rootNotesValue(bytes: Buffer | null): boolean | null {
  const { keys } = scanRootToml(bytes);
  if (keys.length > 1) throw new HerdrError('duplicate-notes-key', 'Duplicate root notes key; repair the TOML before setup');
  if (!keys.length) return null;
  const value = /^\s*(?:notes|"notes"|'notes')\s*=\s*(true|false)\s*(?:#.*)?$/.exec(keys[0].line.trimEnd());
  if (!value) throw new HerdrError('invalid-notes-key', 'Root notes must be a TOML boolean');
  return value[1] === 'true';
}
export interface BackupEntry {
  path: string;
  before: string | null;
  after: string;
  backup: string | null;
  mode: number;
  terminalKeys?: Readonly<Record<string, string>>;
  keys?: KeySections;
  keysBefore?: KeyBaselines;
  keySectionsBefore?: Readonly<Record<string, boolean>>;
  pathsBefore?: PathBaselines;
  soundApplied?: boolean;
  soundDeferred?: boolean;
  soundIntent?: string;
  managed?: ManagedPart;
  managedAfter?: string;
  previous?: { before: string | null; backup: string | null; mode: number }[];
}
export interface SetupJournal {
  version: 1;
  entries: BackupEntry[];
  modDirectories?: { path: string; dev: number; ino: number }[];
  modStages?: { path: string; destination: string; dev: number; ino: number }[];
  fingerprint: string | null;
  probes: NodeObservation[];
  runtimeRootProbes?: RuntimeRootObservation[];
  cutover: CutoverResult | null;
  cutoverFingerprint?: string;
  launcherNodePath?: string;
  verified: boolean;
  cutoverPending: boolean;
  retiredTerminals: TerminalAddress[];
  runtimes: {
    machine: NodeObservation['machine'];
    path: string;
    before: string | null;
    after: string;
  }[];
}
export async function assertGlobalRoot(configured: string, effective?: string): Promise<void> {
  if (effective === undefined) return;
  const canonical = (path: string) => realpath(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path);
    throw error;
  });
  if (await canonical(configured) !== await canonical(effective)) throw new HerdrError('global-root-mismatch', `Configured globalRoot ${configured} differs from spider's global root ${effective}. Set globalRoot to ${effective}, then rerun setup or doctor.`);
}
export async function rejectSymlinks(path: string): Promise<void> {
  if (!isAbsolute(path))
    throw new HerdrError('setup-path-relative', 'Setup paths must be absolute');
  for (let p = resolve(path);; p = dirname(p)) {
    try {
      if ((await lstat(p)).isSymbolicLink())
        throw new HerdrError('destination-symlink', `Refusing symlink: ${p}`);
    }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw e;
    }
    if (dirname(p) === p)
      break;
  }
}
export async function snapshot(path: string): Promise<FileSnapshot> {
  await rejectSymlinks(path);
  try {
    const stat = await lstat(path);
    if (!stat.isFile())
      throw new HerdrError('destination-not-file', `Not a file: ${path}`);
    const bytes = await readFile(path);
    return { bytes, hash: digest(bytes), mode: stat.mode & 0o777 };
  }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      throw e;
    return { bytes: null, hash: null, mode: 0o600 };
  }
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32')
    return;
  const dir = await open(path, 'r');
  try {
    await dir.sync();
  }
  finally {
    await dir.close();
  }
}
export async function atomicWrite(path: string, bytes: Buffer, mode = 0o600, expected?: string | null): Promise<void> {
  await rejectSymlinks(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rejectSymlinks(path);
  const temporary = path + '.spider-' + randomUUID();
  const file = await open(temporary, 'wx', mode);
  try {
    await file.writeFile(bytes);
    await file.sync();
  }
  finally {
    await file.close();
  }
  try {
    await rejectSymlinks(path);
    if (expected !== undefined && (await snapshot(path)).hash !== expected)
      throw new HerdrError('concurrent-settings-edit', `Changed after preflight: ${path}`);
    if (expected === null) {
      try { await link(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HerdrError('concurrent-settings-edit', `Changed after preflight: ${path}`);
        throw error;
      }
    } else await rename(temporary, path);
    await syncDirectory(dirname(path));
  }
  finally {
    await unlink(temporary).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      throw e; });
  }
}
export async function withSetupLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  await rejectSymlinks(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'lock');
  const token = `${process.pid}:${randomUUID()}`;
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
      throw e;
    // Claim reclamation separately before reading the stale lock. Otherwise two reclaimers
    // can both prove the old PID absent and one can unlink the other's new live lock.
    const reclaimPath = join(root, 'lock-reclaim');
    const reclaim = await open(reclaimPath, 'wx', 0o600).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error;
      throw new HerdrError('setup-locked', 'Lock recovery is active or needs manual inspection');
    });
    try {
      await reclaim.writeFile(token);
      await reclaim.sync();
      const before = (await snapshot(path)).bytes;
      const pid = Number(before?.toString('utf8').split(':')[0]);
      if (!Number.isInteger(pid) || pid <= 0)
        throw new HerdrError('setup-locked', 'An uncertain setup lock needs manual inspection');
      try {
        process.kill(pid, 0);
        throw new HerdrError('setup-locked', `Setup may still be running: PID ${pid}`);
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          throw error;
      }
      if (!(await readFile(path)).equals(before!))
        throw new HerdrError('setup-locked', 'Setup lock changed');
      await unlink(path);
      handle = await open(path, 'wx', 0o600);
    }
    finally {
      await reclaim.close();
      if ((await readFile(reclaimPath, 'utf8').catch(() => '')) === token)
        await unlink(reclaimPath);
    }
  }
  try {
    await handle.writeFile(token);
    await handle.sync();
    return await work();
  }
  finally {
    await handle.close();
    if ((await readFile(path, 'utf8').catch(() => '')) === token)
      await unlink(path);
  }
}
function journalObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HerdrError('setup-journal-invalid', 'Invalid managed key ownership');
  return value as Record<string, unknown>;
}
function journalKeyName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || ['__proto__', 'prototype', 'constructor'].includes(value))
    throw new HerdrError('setup-journal-invalid', 'Invalid managed key name');
  return value;
}
function parseKeyFields(value: unknown): KeyFields {
  return Object.fromEntries(Object.entries(journalObject(value)).map(([section, fields]) => {
    journalKeyName(section);
    if (!Array.isArray(fields)) throw new HerdrError('setup-journal-invalid', 'Invalid managed key fields');
    const keys = fields.map(journalKeyName);
    if (new Set(keys).size !== keys.length) throw new HerdrError('setup-journal-invalid', 'Duplicate managed key');
    return [section, keys];
  }));
}
function parseKeySections(value: unknown): KeySections {
  return Object.fromEntries(Object.entries(journalObject(value)).map(([section, fields]) => {
    journalKeyName(section);
    return [section, Object.fromEntries(Object.entries(journalObject(fields)).map(([key, binding]) => {
      journalKeyName(key);
      if (!isKeyBinding(binding)) throw new HerdrError('setup-journal-invalid', 'Invalid managed key binding');
      return [key, binding];
    }))];
  }));
}
function parseKeyBaselines(value: unknown): KeyBaselines {
  return Object.fromEntries(Object.entries(journalObject(value)).map(([section, fields]) => {
    journalKeyName(section);
    return [section, Object.fromEntries(Object.entries(journalObject(fields)).map(([key, value]) => {
      journalKeyName(key);
      const baseline = journalObject(value);
      if (baseline.present === false && Object.keys(baseline).length === 1) return [key, { present: false }];
      if (baseline.present === true && Object.hasOwn(baseline, 'value') && Object.keys(baseline).length === 2) return [key, { present: true, value: baseline.value }];
      throw new HerdrError('setup-journal-invalid', 'Invalid managed key baseline');
    }))];
  }));
}
function parseManagedPart(value: unknown): ManagedPart {
  const part = object(value);
  if (part.kind === 'notes' || part.kind === 'resume') return { kind: part.kind };
  if (part.kind === 'keys') return { kind: 'keys', sections: parseKeyFields(part.sections) };
  if (part.kind === 'json-paths') {
    if (!Array.isArray(part.paths) || !part.paths.length) throw new HerdrError('setup-journal-invalid', 'Invalid managed JSON paths');
    const paths = part.paths.map(value => { const path = text(value); pathParts(path); return path; });
    if (new Set(paths).size !== paths.length || paths.some(a => paths.some(b => a !== b && b.startsWith(a + '.')))) throw new HerdrError('setup-journal-invalid', 'Overlapping managed JSON paths');
    return { kind: 'json-paths', paths };
  }
  if (part.kind !== 'json' || !Array.isArray(part.fields)) throw new HerdrError('setup-journal-invalid', 'Unknown managed file projection');
  return { kind: 'json', fields: part.fields.map(field => text(field)), ...(part.section === undefined ? {} : { section: text(part.section) }) };
}
function runtimeRootObservations(value: unknown): RuntimeRootObservation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const p = value as Record<string, unknown>;
    if (typeof p.machine !== 'string' || !p.machine || typeof p.nodePath !== 'string' || !p.nodePath || typeof p.runtimeHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.runtimeHash) || typeof p.root !== 'string' || !isAbsolute(p.root) || !isRuntimeRootProbe(p.result, p.root)) return [];
    const result = p.result;
    return [{ machine: p.machine as RuntimeRootObservation['machine'], nodePath: p.nodePath, runtimeHash: p.runtimeHash, root: p.root,
      result: { directory: result.directory, uid: result.uid, mode: result.mode, nodeVersion: result.nodeVersion, nodePath: result.nodePath } }];
  });
}
export async function readJournal(root: string): Promise<SetupJournal> {
  const bytes = (await snapshot(join(root, 'journal.json'))).bytes;
  if (!bytes)
    return { version: 1, entries: [], fingerprint: null, probes: [], cutover: null, verified: false, cutoverPending: false, retiredTerminals: [], runtimes: [] };
  const j = object(JSON.parse(bytes.toString('utf8')));
  if (j.version !== 1 || !Array.isArray(j.entries) || !Array.isArray(j.probes) || typeof j.verified !== 'boolean')
    throw new HerdrError('setup-journal-invalid', 'Unknown or malformed setup journal');
  const entries = j.entries.map(value => {
    const e = object(value);
    if (typeof e.mode !== 'number' || !Number.isInteger(e.mode))
      throw new HerdrError('setup-journal-invalid', 'Invalid backup mode');
    const terminalKeys: Record<string, string> = {};
    if (e.terminalKeys !== undefined)
      for (const [key, value] of Object.entries(journalObject(e.terminalKeys))) {
        journalKeyName(key);
        if (typeof value !== 'string' || !value || value.includes('\0')) throw new HerdrError('setup-journal-invalid', 'Invalid legacy key binding');
        terminalKeys[key] = value;
      }
    const previous = e.previous === undefined ? undefined : (() => {
      if (!Array.isArray(e.previous)) throw new HerdrError('setup-journal-invalid', 'Invalid previous backups');
      return e.previous.map(value => {
        const baseline = object(value);
        if (typeof baseline.mode !== 'number' || !Number.isInteger(baseline.mode)) throw new HerdrError('setup-journal-invalid', 'Invalid previous backup mode');
        return { before: baseline.before === null ? null : text(baseline.before), backup: baseline.backup === null ? null : text(baseline.backup), mode: baseline.mode };
      });
    })();
    const keys = e.keys === undefined ? undefined : parseKeySections(e.keys);
    const keysBefore = e.keysBefore === undefined ? undefined : parseKeyBaselines(e.keysBefore);
    const keySectionsBefore = e.keySectionsBefore === undefined ? undefined : Object.fromEntries(Object.entries(journalObject(e.keySectionsBefore)).map(([section, present]) => {
      journalKeyName(section);
      if (typeof present !== 'boolean') throw new HerdrError('setup-journal-invalid', 'Invalid managed key section baseline');
      return [section, present];
    }));
    const managed = e.managed === undefined ? undefined : parseManagedPart(e.managed);
    if (e.soundApplied !== undefined && typeof e.soundApplied !== 'boolean') throw new HerdrError('setup-journal-invalid', 'Invalid sound compare-write marker');
    if (e.soundDeferred !== undefined && typeof e.soundDeferred !== 'boolean') throw new HerdrError('setup-journal-invalid', 'Invalid deferred sound marker');
    if (e.soundIntent !== undefined && (typeof e.soundIntent !== 'string' || !/^[a-f0-9]{64}$/.test(e.soundIntent))) throw new HerdrError('setup-journal-invalid', 'Invalid sound write intent');
    const pathsBefore: PathBaselines | undefined = e.pathsBefore === undefined ? undefined : Object.fromEntries(Object.entries(journalObject(e.pathsBefore)).map(([path, value]) => {
      const parts = pathParts(path), baseline = journalObject(value), parents = baseline.parents;
      if (!Array.isArray(parents) || parents.length !== parts.length - 1 || parents.some(parent => typeof parent !== 'boolean') || typeof baseline.present !== 'boolean' || (baseline.present ? !Object.hasOwn(baseline, 'value') : Object.hasOwn(baseline, 'value'))) throw new HerdrError('setup-journal-invalid', 'Invalid managed path baseline');
      return [path, baseline.present ? { present: true, value: baseline.value, parents } : { present: false, parents }];
    }));
    if (pathsBefore && (managed?.kind !== 'json-paths' || canonicalJson(Object.keys(pathsBefore).sort()) !== canonicalJson([...managed.paths].sort()))) throw new HerdrError('setup-journal-invalid', 'Managed path baselines do not match their projection');
    const fieldNames = (sections: Readonly<Record<string, Readonly<Record<string, unknown>>>>) => canonicalJson(Object.fromEntries(Object.entries(sections).map(([section, values]) => [section, Object.keys(values).sort()])));
    if (keys && (managed?.kind !== 'keys' || fieldNames(keys) !== canonicalJson(Object.fromEntries(Object.entries(managed.sections).map(([section, values]) => [section, [...values].sort()])))))
      throw new HerdrError('setup-journal-invalid', 'Managed key fields do not match their bindings');
    if (managed?.kind === 'keys' && (!keys || typeof e.managedAfter !== 'string' || e.managedAfter !== managedProjection(Buffer.from(JSON.stringify(keys)), managed)))
      throw new HerdrError('setup-journal-invalid', 'Managed key values do not match the journal');
    if (keysBefore && (!keys || fieldNames(keysBefore) !== fieldNames(keys))) throw new HerdrError('setup-journal-invalid', 'Managed key baselines do not match their bindings');
    if (keySectionsBefore && (!keys || canonicalJson(Object.keys(keySectionsBefore).sort()) !== canonicalJson(Object.keys(keys).sort()))) throw new HerdrError('setup-journal-invalid', 'Managed key section baselines do not match their bindings');
    return { ...(previous ? { previous } : {}), path: text(e.path), before: e.before === null ? null : text(e.before), after: text(e.after), backup: e.backup === null ? null : text(e.backup), mode: e.mode, ...(e.terminalKeys === undefined ? {} : { terminalKeys }), ...(keys === undefined ? {} : { keys }), ...(keysBefore === undefined ? {} : { keysBefore }), ...(keySectionsBefore === undefined ? {} : { keySectionsBefore }), ...(pathsBefore === undefined ? {} : { pathsBefore }), ...(e.soundApplied === undefined ? {} : { soundApplied: e.soundApplied as boolean }), ...(e.soundDeferred === undefined ? {} : { soundDeferred: e.soundDeferred as boolean }), ...(e.soundIntent === undefined ? {} : { soundIntent: e.soundIntent as string }), ...(managed === undefined ? {} : { managed, managedAfter: typeof e.managedAfter === 'string' ? e.managedAfter : text(e.managedAfter) }) };
  });
  const probes = j.probes.map(value => { const p = object(value); return { machine: text(p.machine) as NodeObservation['machine'], nodePath: text(p.nodePath), version: text(p.version), coreStartedAt: text(p.coreStartedAt) }; });
  let cutover: CutoverResult | null = null;
  if (j.cutover !== null) {
    const c = object(j.cutover);
    if (!Array.isArray(c.terminals))
      throw new HerdrError('setup-journal-invalid', 'Invalid cutover terminals');
    const identities: Record<string, string> = {};
    for (const [key, value] of Object.entries(object(c.identities)))
      identities[key] = text(value);
    cutover = { terminals: c.terminals.map(v => text(v) as CutoverResult['terminals'][number]), identities };
  }
  if (typeof j.cutoverPending !== 'boolean' || !Array.isArray(j.retiredTerminals))
    throw new HerdrError('setup-journal-invalid', 'Invalid cutover intent');
  if (!Array.isArray(j.runtimes))
    throw new HerdrError('setup-journal-invalid', 'Invalid runtime journal');
  const runtimes = j.runtimes.map(value => { const r = object(value); return { machine: text(r.machine) as NodeObservation['machine'], path: text(r.path), before: r.before === null ? null : text(r.before), after: text(r.after) }; });
  const modDirectories = j.modDirectories === undefined ? undefined : (() => {
    if (!Array.isArray(j.modDirectories)) throw new HerdrError('setup-journal-invalid', 'Invalid mod directories');
    const seen = new Set<string>();
    return j.modDirectories.map(value => {
      const directory = object(value), path = text(directory.path);
      if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0') || seen.has(path) || !Number.isSafeInteger(directory.dev) || !Number.isSafeInteger(directory.ino) || (directory.dev as number) < 0 || (directory.ino as number) <= 0) throw new HerdrError('setup-journal-invalid', 'Invalid mod directory identity');
      seen.add(path); return { path, dev: directory.dev as number, ino: directory.ino as number };
    });
  })();
  const modStages = j.modStages === undefined ? undefined : (() => {
    if (!Array.isArray(j.modStages)) throw new HerdrError('setup-journal-invalid', 'Invalid mod staging directories');
    const seen = new Set<string>();
    return j.modStages.map(value => {
      const stage = object(value), path = text(stage.path), destination = text(stage.destination);
      if (!isAbsolute(path) || resolve(path) !== path || !/^\.spider-mod-[a-f0-9-]+$/.test(relative(dirname(path), path)) || dirname(destination) !== join(dirname(path), 'mods') || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(relative(dirname(destination), destination)) || seen.has(destination) || !Number.isSafeInteger(stage.dev) || !Number.isSafeInteger(stage.ino) || (stage.ino as number) <= 0) throw new HerdrError('setup-journal-invalid', 'Invalid mod staging identity');
      seen.add(destination);
      return { path, destination, dev: stage.dev as number, ino: stage.ino as number };
    });
  })();
  return { version: 1, entries, probes, cutover, runtimes, ...(modStages === undefined ? {} : { modStages }), ...(modDirectories === undefined ? {} : { modDirectories }), ...(j.runtimeRootProbes === undefined ? {} : { runtimeRootProbes: runtimeRootObservations(j.runtimeRootProbes) }), ...(j.cutoverFingerprint === undefined ? {} : { cutoverFingerprint: text(j.cutoverFingerprint) }), ...(j.launcherNodePath === undefined ? {} : { launcherNodePath: text(j.launcherNodePath) }), fingerprint: j.fingerprint === null ? null : text(j.fingerprint), verified: j.verified, cutoverPending: j.cutoverPending, retiredTerminals: j.retiredTerminals.map(v => text(v) as TerminalAddress) };
}
export async function saveJournal(root: string, journal: SetupJournal): Promise<void> {
  const path = join(root, 'journal.json');
  const bytes = Buffer.from(JSON.stringify(journal, null, 2) + '\n');
  const current = await snapshot(path);
  if (current.hash !== digest(bytes))
    await atomicWrite(path, bytes, 0o600, current.hash);
}
/** The planned content's managed part. A snapshot-only plan of an absent file is the absent state, not empty JSON. */
function plannedProjection(f: InstallFile, part: ManagedPart): string {
  if (part.kind === 'keys' && f.keys && f.retainedKeys) return managedProjection(Buffer.from(JSON.stringify(f.keys)), part);
  return managedProjection(f.snapshotOnly && f.expected === null ? null : f.bytes, part);
}
function priorManagedPart(prior: BackupEntry, fallback: ManagedPart): ManagedPart {
  return prior.managed ?? (prior.terminalKeys ? { kind: 'json', section: 'terminal', fields: Object.keys(prior.terminalKeys) } : fallback);
}
function priorKeyFields(prior: BackupEntry): KeyFields {
  if (prior.managed?.kind === 'keys') return prior.managed.sections;
  if (prior.managed?.kind === 'json' && prior.managed.section === 'terminal') return { terminal: prior.managed.fields };
  return prior.terminalKeys ? { terminal: Object.keys(prior.terminalKeys) } : {};
}
function keyBaseline(bytes: Buffer | null, section: string, key: string): KeyBaseline {
  const json = bytes === null ? {} : object(JSON.parse(bytes.toString('utf8')));
  const values = object(json[section] ?? {});
  return Object.hasOwn(values, key) ? { present: true, value: values[key] } : { present: false };
}
async function verifiedBackup(root: string, backup: string | null, before: string | null): Promise<Buffer | null> {
  if (backup === null) {
    if (before !== null) throw new HerdrError('backup-verification-failed', 'A recorded backup is missing');
    return null;
  }
  if (!backup.startsWith(resolve(root) + '/backups/')) throw new HerdrError('setup-journal-invalid', 'Backup is outside the setup root');
  const bytes = (await snapshot(backup)).bytes;
  if (!bytes || digest(bytes) !== before) throw new HerdrError('backup-verification-failed', `Cannot restore: ${backup}`);
  return bytes;
}
function hasKeySection(bytes: Buffer | null, section: string): boolean {
  return bytes !== null && Object.hasOwn(object(JSON.parse(bytes.toString('utf8'))), section);
}
async function keyBaselines(root: string, current: Buffer | null, part: Extract<ManagedPart, { kind: 'keys' }>, prior: BackupEntry | undefined, replace: boolean, retained?: KeySections): Promise<KeyBaselines> {
  const oldFields = prior ? priorKeyFields(prior) : {};
  const original = prior && !prior.keysBefore ? await verifiedBackup(root, prior.backup, prior.before) : null;
  return Object.fromEntries(Object.entries(part.sections).map(([section, keys]) => [section, Object.fromEntries(keys.map(key => {
    const currentValue = keyBaseline(current, section, key);
    const oldBinding = prior?.keys?.[section]?.[key] ?? (section === 'terminal' ? prior?.terminalKeys?.[key] : undefined);
    const preserve = prior && oldFields[section]?.includes(key) && (Object.hasOwn(retained?.[section] ?? {}, key) || !replace || currentValue.present && canonicalJson(currentValue.value) === canonicalJson(oldBinding));
    return [key, preserve ? prior.keysBefore?.[section]?.[key] ?? keyBaseline(original, section, key) : currentValue];
  }))]));
}
async function keySectionBaselines(root: string, current: Buffer | null, part: Extract<ManagedPart, { kind: 'keys' }>, prior: BackupEntry | undefined, replace: boolean, retained?: KeySections): Promise<Readonly<Record<string, boolean>>> {
  const oldFields = prior ? priorKeyFields(prior) : {};
  const original = prior && !prior.keySectionsBefore ? await verifiedBackup(root, prior.backup, prior.before) : null;
  return Object.fromEntries(Object.entries(part.sections).map(([section, keys]) => {
    const preserve = prior && keys.some(key => {
      const currentValue = keyBaseline(current, section, key);
      const oldBinding = prior.keys?.[section]?.[key] ?? (section === 'terminal' ? prior.terminalKeys?.[key] : undefined);
      return oldFields[section]?.includes(key) && (Object.hasOwn(retained?.[section] ?? {}, key) || !replace || currentValue.present && canonicalJson(currentValue.value) === canonicalJson(oldBinding));
    });
    return [section, preserve ? prior.keySectionsBefore?.[section] ?? hasKeySection(original, section) : hasKeySection(current, section)];
  }));
}
function priorPaths(prior: BackupEntry): readonly string[] {
  if (prior.managed?.kind === 'json-paths') return prior.managed.paths;
  if (prior.managed?.kind === 'json' && prior.managed.section === undefined) return prior.managed.fields;
  return [];
}
function recordedPath(entry: BackupEntry, path: string): PathBaseline {
  let rows: unknown;
  try { rows = JSON.parse(entry.managedAfter ?? ''); } catch { throw new HerdrError('setup-journal-invalid', 'Invalid recorded path projection'); }
  if (!Array.isArray(rows)) throw new HerdrError('setup-journal-invalid', 'Invalid recorded path projection');
  const matching = rows.filter(row => Array.isArray(row) && row[0] === path);
  if (matching.length !== 1 || typeof matching[0][1] !== 'boolean') throw new HerdrError('setup-journal-invalid', `Invalid recorded path ${path}`);
  return matching[0][1] ? { present: true, value: matching[0][2], parents: [] } : { present: false, parents: [] };
}
async function pathBaselines(root: string, current: Buffer | null, part: Extract<ManagedPart, { kind: 'json-paths' }>, prior: BackupEntry | undefined, replace: boolean): Promise<PathBaselines> {
  const oldPaths = prior ? priorPaths(prior) : [];
  const original = prior && !prior.pathsBefore ? await verifiedBackup(root, prior.backup, prior.before) : null;
  return Object.fromEntries(part.paths.map(path => {
    const actual = pathBaseline(current, path);
    const preserve = prior && oldPaths.includes(path) && (!replace || samePath(actual, recordedPath(prior, path)));
    return [path, preserve ? prior.pathsBefore?.[path] ?? pathBaseline(original, path) : actual];
  }));
}
export interface AppSettingsTransition {
  path: string;
  planned: Readonly<{ theme: string; layout: string; sounds: { enabled: false } }>;
}
function soundOwned(entry: BackupEntry, currentHash: string | null, journal: SetupJournal): boolean {
  return entry.soundApplied === true || currentHash !== null && currentHash === entry.soundIntent || !entry.soundDeferred && (currentHash === entry.after || journal.cutoverPending);
}
function matchesAppSettingsTransition(path: string, part: ManagedPart, current: Buffer | null, original: Buffer | null, transition?: AppSettingsTransition, soundOwned = false): boolean {
  if (!transition || resolve(path) !== resolve(transition.path)) return false;
  const planned = Buffer.from(JSON.stringify(transition.planned));
  if (part.kind === 'json' && part.section === undefined && part.fields.length === 2 && part.fields.includes('theme') && part.fields.includes('layout')) {
    return part.fields.every(field => {
      const one = { ...part, fields: [field] }, actual = managedProjection(current, one);
      return actual === managedProjection(original, one) || actual === managedProjection(planned, one);
    });
  }
  if (part.kind !== 'json-paths' || part.paths.some(path => !['theme', 'layout', 'sounds.enabled'].includes(path))) return false;
  return part.paths.every(path => {
    const actual = pathBaseline(current, path);
    return samePath(actual, pathBaseline(original, path)) || (path !== 'sounds.enabled' || soundOwned) && samePath(actual, pathBaseline(planned, path));
  });
}
export interface FileAction {
  path: string;
  action: 'adopt' | 'write' | 'replace' | 'unchanged';
  refusal?: { code: string; message: string };
}
export async function validateFiles(files: readonly InstallFile[], journal: SetupJournal, overwriteKeys = false, appSettings?: AppSettingsTransition, options: { replaceChanged?: boolean; planOnly?: boolean } = {}): Promise<FileAction[]> {
  const actions: FileAction[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path))
      throw new HerdrError('duplicate-install-path', `Repeated target: ${f.path}`);
    seen.add(f.path);
    const current = await snapshot(f.path);
    if (f.copyFrom) { actions.push({ path: f.path, action: current.bytes === null ? 'write' : 'unchanged' }); continue; }
    const prior = journal.entries.find(e => e.path === f.path);
    const identical = current.hash === digest(f.bytes);
    let refusal = f.refusal, unsafeSound = false;
    if ((!identical || f.snapshotOnly || f.updateAfterCutover) && f.managed && prior) {
      const originalPart = priorManagedPart(prior, f.managed);
      const part: ManagedPart = originalPart.kind === 'keys' && f.retainedKeys ? { kind: 'keys', sections: Object.fromEntries(Object.entries(originalPart.sections).map(([section, keys]) => [section, keys.filter(key => !Object.hasOwn(f.retainedKeys?.[section] ?? {}, key))])) } : originalPart;
      const recorded = part !== originalPart && prior.keys ? managedProjection(Buffer.from(JSON.stringify(prior.keys)), part) : prior.managedAfter ?? (prior.terminalKeys && part.kind === 'json' && part.section === 'terminal'
        ? managedProjection(Buffer.from(JSON.stringify({ terminal: prior.terminalKeys })), part) : plannedProjection(f, part));
      const actual = managedProjection(current.bytes, part);
      if (!journal.verified && f.managed.kind === 'json-paths' && part.kind === 'json' && part.section === undefined && f.managed.paths.includes('sounds.enabled') && appSettings && resolve(f.path) === resolve(appSettings.path)) {
        const baseline = prior.backup === null ? null : (await snapshot(prior.backup)).bytes;
        if ((baseline === null ? null : digest(baseline)) !== prior.before) throw new HerdrError('backup-verification-failed', `Cannot verify original managed values: ${f.path}`);
        if (!samePath(pathBaseline(current.bytes, 'sounds.enabled'), pathBaseline(baseline, 'sounds.enabled'))) { unsafeSound = true; refusal = { code: 'managed-artifact-changed', message: `Unowned sound changed during an unfinished selection: ${f.path}` }; }
      }
      if (!journal.verified && part.kind === 'json-paths' && part.paths.includes('sounds.enabled') && appSettings && resolve(f.path) === resolve(appSettings.path)) {
        const baseline = prior.backup === null ? null : (await snapshot(prior.backup)).bytes;
        if ((baseline === null ? null : digest(baseline)) !== prior.before) throw new HerdrError('backup-verification-failed', `Cannot verify original managed values: ${f.path}`);
        const sound = pathBaseline(current.bytes, 'sounds.enabled'), planned = pathBaseline(Buffer.from(JSON.stringify(appSettings.planned)), 'sounds.enabled');
        if (!samePath(sound, pathBaseline(baseline, 'sounds.enabled')) && (!soundOwned(prior, current.hash, journal) || !samePath(sound, planned))) { unsafeSound = true; refusal = { code: 'managed-artifact-changed', message: `Unowned sound changed during an unfinished selection: ${f.path}` }; }
      }
      let restored = !journal.verified && prior.before === current.hash;
      if (!restored && !journal.verified && actual !== recorded) {
        const baseline = prior.backup === null ? null : (await snapshot(prior.backup)).bytes;
        if ((baseline === null ? null : digest(baseline)) !== prior.before) throw new HerdrError('backup-verification-failed', `Cannot verify original managed values: ${f.path}`);
        restored = managedProjection(baseline, part) === actual
          || (f.snapshotOnly === true || f.updateAfterCutover === true) && matchesAppSettingsTransition(f.path, part, current.bytes, baseline, appSettings, soundOwned(prior, current.hash, journal));
      }
      if (actual !== recorded && !restored)
        refusal = { code: 'managed-artifact-changed', message: `Managed content changed in ${f.path}. Restore these recorded managed values: ${recorded}` };
    }
    const recovering = !journal.verified && prior?.after === digest(f.bytes) && (current.hash === prior.after || current.hash === prior.before);
    if (!identical && current.hash !== f.expected && !recovering) {
      if (!f.collision && f.managed) throw new HerdrError('concurrent-settings-edit', `Changed after preflight: ${f.path}`);
      refusal ??= { code: f.collision === 'key' ? 'key-binding-conflict' : 'unowned-clone-collision', message: `Changed target ${f.path}` };
    }
    const owned = prior && (prior.after === current.hash || f.managed && prior.managedAfter !== undefined && prior.managedAfter === managedProjection(current.bytes, priorManagedPart(prior, f.managed)));
    const action = (identical || f.snapshotOnly) && owned && !refusal ? 'unchanged'
      : refusal ? 'replace' : identical ? 'adopt' : 'write';
    const keyPlan = f.terminalKeys !== undefined || f.keys !== undefined;
    const authorized = !unsafeSound && !f.refusalRequired && (keyPlan && refusal?.code === 'key-binding-conflict' ? overwriteKeys : options.replaceChanged || keyPlan && overwriteKeys);
    actions.push({ path: f.path, action, ...(refusal && !authorized ? { refusal } : {}) });
    if (identical || refusal && authorized) {
      f.expected = current.hash;
      if (refusal && authorized) f.replaceBaseline = true;
    }
  }
  const refused = actions.filter(action => action.refusal);
  if (refused.length && !options.planOnly)
    throw new HerdrError(refused[0].refusal!.code, changedSetupFilesNotice(refused), { files: refused });
  return actions;
}
export async function prepareBackups(root: string, files: readonly InstallFile[], journal: SetupJournal): Promise<void> {
  for (const f of files) {
    if (f.copyFrom) continue;
    const current = await snapshot(f.path);
    const after = digest(f.bytes);
    const prior = journal.entries.find(e => e.path === f.path);
    const keyPart = f.keys && f.managed?.kind === 'keys' ? f.managed : undefined;
    const pathPart = f.managed?.kind === 'json-paths' ? f.managed : undefined;
    const oldFields = prior ? priorKeyFields(prior) : {}, oldPaths = prior ? priorPaths(prior) : [];
    const expanded = !!(prior && (keyPart && Object.entries(keyPart.sections).some(([section, keys]) => keys.some(key => !oldFields[section]?.includes(key))) || pathPart && pathPart.paths.some(path => !oldPaths.includes(path))));
    const migrating = !!(prior && (keyPart && (!prior.keys || expanded) || pathPart && (!prior.pathsBefore || expanded)));
    if (f.deferredSoundApplied === undefined && !f.replaceBaseline && !migrating && (current.hash === after && prior?.after === after || prior?.after === after && current.hash === prior.before))
      continue;
    if (current.hash !== f.expected)
      throw new HerdrError('concurrent-settings-edit', `Changed between preflight and backup: ${f.path}`);
    const keysBefore = keyPart ? await keyBaselines(root, current.bytes, keyPart, prior, !!f.replaceBaseline, f.retainedKeys) : undefined;
    const keySectionsBefore = keyPart ? await keySectionBaselines(root, current.bytes, keyPart, prior, !!f.replaceBaseline, f.retainedKeys) : undefined;
    const pathsBefore = pathPart ? await pathBaselines(root, current.bytes, pathPart, prior, !!f.replaceBaseline) : undefined;
    if (prior && !f.replaceBaseline && !expanded) {
      prior.after = after;
      if (f.terminalKeys) prior.terminalKeys = f.terminalKeys;
      if (f.keys) prior.keys = f.keys;
      if (keysBefore) prior.keysBefore = keysBefore;
      if (keySectionsBefore) prior.keySectionsBefore = keySectionsBefore;
      if (pathsBefore) prior.pathsBefore = pathsBefore;
      if (f.updateAfterCutover) {
        prior.soundApplied = f.deferredSoundApplied ?? false;
        if (f.deferredSoundApplied !== undefined) prior.soundDeferred = true;
      }
      if (f.managed) { prior.managed = f.managed; prior.managedAfter = plannedProjection(f, f.managed); }
      continue;
    }
    const backup = current.bytes === null ? null : join(root, 'backups', digest(Buffer.from(f.path)) + '-' + current.hash);
    if (backup && current.bytes) {
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
      await rejectSymlinks(backup);
      const handle = await open(backup, 'wx', 0o600).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
        throw e; return null; });
      if (handle)
        try {
          await handle.writeFile(current.bytes);
          await handle.sync();
        }
        finally {
          await handle.close();
        }
      const saved = await snapshot(backup);
      if (!saved.bytes?.equals(current.bytes))
        await atomicWrite(backup, current.bytes, 0o600, saved.hash);
      if (!(await readFile(backup)).equals(current.bytes))
        throw new HerdrError('backup-verification-failed', `Backup differs: ${f.path}`);
      const verified = await open(backup, 'r');
      try {
        await verified.sync();
      }
      finally {
        await verified.close();
      }
      await syncDirectory(dirname(backup));
    }
    const previous = prior && (f.replaceBaseline || expanded) ? [...(prior.previous ?? []), { before: prior.before, backup: prior.backup, mode: prior.mode }] : undefined;
    const terminalKeys = f.terminalKeys ?? prior?.terminalKeys;
    const entry = { ...(previous ? { previous } : {}), path: f.path, before: current.hash, after, backup, mode: current.mode, ...(terminalKeys ? { terminalKeys } : {}), ...(f.keys ? { keys: f.keys } : {}), ...(keysBefore ? { keysBefore } : {}), ...(keySectionsBefore ? { keySectionsBefore } : {}), ...(pathsBefore ? { pathsBefore } : {}), ...(f.updateAfterCutover ? { soundApplied: f.deferredSoundApplied ?? false, ...(f.deferredSoundApplied === undefined ? {} : { soundDeferred: true }) } : {}), ...(f.managed ? { managed: f.managed, managedAfter: plannedProjection(f, f.managed) } : {}) };
    journal.entries = [...journal.entries.filter(e => e.path !== f.path), entry];
  }
  await saveJournal(root, journal);
}
export async function prepareModDirectories(root: string, appHome: string, files: readonly InstallFile[], journal: SetupJournal): Promise<void> {
  const mods = resolve(appHome, 'mods'), directories = new Set<string>();
  for (const file of files) {
    const parts = relative(mods, resolve(file.path)).split(sep);
    if (parts.length < 2 || !parts[0]!.startsWith('spider-') || parts.some(part => part === '..' || !part)) continue;
    for (let i = 1; i < parts.length; i++) directories.add(join(mods, ...parts.slice(0, i)));
  }
  if (directories.size) { await rejectSymlinks(mods); await mkdir(mods, { recursive: true, mode: 0o700 }); }
  for (const path of [...directories].sort((a, b) => a.length - b.length)) {
    await rejectSymlinks(path);
    const top = join(mods, relative(mods, path).split(sep)[0]!);
    let stage = journal.modStages?.find(entry => entry.destination === top);
    if (stage) {
      const staged = await lstat(stage.path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return null; });
      const published = await lstat(top).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return null; });
      if (published) {
        if (staged || !published.isDirectory() || published.dev !== stage.dev || published.ino !== stage.ino) throw new HerdrError('mod-publication-conflict', 'Published mod directory changed');
        journal.modStages = journal.modStages!.filter(entry => entry !== stage);
        stage = undefined;
        await saveJournal(root, journal);
      } else if (!staged?.isDirectory() || staged.isSymbolicLink() || staged.dev !== stage.dev || staged.ino !== stage.ino) throw new HerdrError('mod-publication-conflict', 'Mod staging directory changed');
    }
    if (path === top && !stage) {
      try { await lstat(top); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Outside the watched mods tree, on the same filesystem for one rename.
        const temporary = join(resolve(appHome), '.spider-mod-' + randomUUID());
        await mkdir(temporary, { mode: 0o700 });
        const info = await lstat(temporary);
        stage = { path: temporary, destination: top, dev: info.dev, ino: info.ino };
        journal.modStages = [...journal.modStages ?? [], stage];
        journal.modDirectories = [...journal.modDirectories ?? [], { path: top, dev: info.dev, ino: info.ino }];
        await saveJournal(root, journal);
      }
    }
    const physical = stage ? join(stage.path, relative(top, path)) : path;
    await rejectSymlinks(physical);
    let created = false;
    try { await mkdir(physical, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const actual = await lstat(physical);
    if (!actual.isDirectory() || actual.isSymbolicLink()) throw new HerdrError('unsafe-path', `Not a mod directory: ${path}`);
    if (created) {
      journal.modDirectories = [...(journal.modDirectories ?? []).filter(entry => entry.path !== path), { path, dev: actual.dev, ino: actual.ino }];
      await saveJournal(root, journal);
    }
  }
}

async function discardModStages(journal: SetupJournal): Promise<void> {
  for (const stage of journal.modStages ?? []) {
    await rejectSymlinks(stage.path);
    const info = await lstat(stage.path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return null; });
    if (!info) continue; // Rename completed; normal file rollback owns the published directory.
    if (!info.isDirectory() || info.dev !== stage.dev || info.ino !== stage.ino) throw new HerdrError('mod-publication-conflict', 'Mod staging directory changed');
    const remove: string[] = [], directories: string[] = [];
    const inspect = async (directory: string): Promise<void> => {
      for (const name of await readdir(directory)) {
        const path = join(directory, name), stat = await lstat(path);
        if (stat.isDirectory() && !stat.isSymbolicLink()) { await inspect(path); directories.push(path); continue; }
        const entry = journal.entries.find(entry => entry.path === join(stage.destination, relative(stage.path, path)));
        if (!entry || stat.isSymbolicLink() || (await snapshot(path)).hash !== entry.after) throw new HerdrError('mod-publication-conflict', 'Unrecognized file in mod staging directory');
        remove.push(path);
      }
    };
    await inspect(stage.path);
    for (const path of remove) await unlink(path);
    for (const path of directories) await rmdir(path);
    await rmdir(stage.path);
  }
  delete journal.modStages;
}

export async function rollbackModDirectories(appHome: string, journal: SetupJournal, warn?: (message: string) => void): Promise<void> {
  const mods = resolve(appHome, 'mods'), retained: NonNullable<SetupJournal['modDirectories']> = [];
  for (const directory of [...journal.modDirectories ?? []].sort((a, b) => b.path.length - a.path.length)) {
    const parts = relative(mods, directory.path).split(sep);
    if (!parts[0]?.startsWith('spider-') || parts.some(part => part === '..' || !part)) throw new HerdrError('setup-journal-invalid', 'Mod directory outside the managed root');
    if (journal.entries.some(entry => resolve(entry.path).startsWith(directory.path + sep))) { retained.push(directory); continue; }
    try {
      await rejectSymlinks(directory.path);
      const current = await lstat(directory.path);
      if (!current.isDirectory() || current.dev !== directory.dev || current.ino !== directory.ino) { warn?.(`${directory.path} was replaced; leaving it untouched.`); continue; }
      await rmdir(directory.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') warn?.(`${directory.path} could not be removed; leaving it untouched.`);
      retained.push(directory);
    }
  }
  if (retained.length) journal.modDirectories = retained;
  else delete journal.modDirectories;
}

export async function applyFiles(files: readonly InstallFile[], journal: SetupJournal): Promise<string[]> {
  const writes: string[] = [];
  // Placement must be known before any executable change can trigger a reload.
  const ordered = [...files].sort((a, b) => Number(b.path.endsWith('/mod.json')) - Number(a.path.endsWith('/mod.json')));
  for (const f of ordered) {
    const stage = journal.modStages?.find(stage => f.path.startsWith(stage.destination + sep));
    const target = stage ? join(stage.path, relative(stage.destination, f.path)) : f.path;
    const current = await snapshot(target);
    if (f.copyFrom) {
      if (current.bytes !== null) continue;
      const source = await snapshot(f.copyFrom);
      if (source.bytes === null) continue;
      try { await atomicWrite(f.path, source.bytes, f.mode, null); writes.push(f.path); }
      catch (error) { if (!(error instanceof HerdrError) || error.code !== 'concurrent-settings-edit') throw error; }
      continue;
    }
    if (f.snapshotOnly) {
      if (current.hash !== f.expected) throw new HerdrError('concurrent-settings-edit', `Changed after backup: ${f.path}`);
      continue;
    }
    if (current.hash === digest(f.bytes))
      continue;
    const entry = journal.entries.find(e => e.path === f.path)!;
    if (current.hash !== f.expected && !(entry.after === digest(f.bytes) && current.hash === entry.before))
      throw new HerdrError('concurrent-settings-edit', `Changed after backup: ${f.path}`);
    await atomicWrite(target, f.bytes, f.mode ?? entry.mode, current.hash);
    writes.push(f.path);
  }
  for (const stage of journal.modStages ?? []) {
    if (!files.some(file => file.path.startsWith(stage.destination + sep))) continue;
    await rejectSymlinks(stage.path);
    const info = await lstat(stage.path);
    if (!info.isDirectory() || info.dev !== stage.dev || info.ino !== stage.ino) throw new HerdrError('mod-publication-conflict', 'Mod staging directory changed');
    if ((await snapshot(join(stage.path, 'mod.json'))).bytes === null) throw new HerdrError('mod-manifest-missing', 'A new mod needs a placement manifest before publication');
    for (const entry of journal.entries.filter(entry => entry.path.startsWith(stage.destination + sep)))
      if ((await snapshot(join(stage.path, relative(stage.destination, entry.path)))).hash !== entry.after) throw new HerdrError('mod-publication-conflict', 'Staged mod is incomplete');
    await rejectSymlinks(stage.destination);
    if (await lstat(stage.destination).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })) throw new HerdrError('mod-publication-conflict', 'Mod appeared during publication');
    await rename(stage.path, stage.destination);
    await syncDirectory(dirname(stage.destination));
  }
  return writes;
}
function reverseManaged(current: Buffer | null, original: Buffer | null, part: ManagedPart): Buffer | null {
  if (part.kind === 'json-paths') {
    const json = current === null ? {} : object(JSON.parse(current.toString('utf8')));
    for (const path of part.paths) restorePath(json, path, pathBaseline(original, path));
    return original === null && !Object.keys(json).length ? null : Buffer.from(JSON.stringify(json, null, 2) + '\n');
  }
  if (part.kind === 'keys') {
    const json = object(JSON.parse(current?.toString('utf8') ?? '{}'));
    const before = object(JSON.parse(original?.toString('utf8') ?? '{}'));
    for (const [section, keys] of Object.entries(part.sections)) {
      const source = object(json[section] ?? {}), baseline = object(before[section] ?? {});
      for (const key of keys) {
        if (Object.hasOwn(baseline, key)) source[key] = baseline[key];
        else delete source[key];
      }
      if (Object.keys(source).length || Object.hasOwn(before, section)) json[section] = source;
      else delete json[section];
    }
    return original === null && !Object.keys(json).length ? null : Buffer.from(JSON.stringify(json, null, 2) + '\n');
  }
  if (part.kind === 'json') {
    const json = object(JSON.parse(current?.toString('utf8') ?? '{}'));
    const before = object(JSON.parse(original?.toString('utf8') ?? '{}'));
    const source = part.section ? object(json[part.section] ?? {}) : json;
    const baseline = part.section ? object(before[part.section] ?? {}) : before;
    for (const field of part.fields) {
      if (Object.hasOwn(baseline, field)) source[field] = baseline[field];
      else delete source[field];
    }
    if (part.section) {
      if (Object.keys(source).length || Object.hasOwn(before, part.section)) json[part.section] = source;
      else delete json[part.section];
    }
    return original === null && !Object.keys(json).length ? null : Buffer.from(JSON.stringify(json, null, 2) + '\n');
  }
  let source = current?.toString('utf8') ?? '';
  if (part.kind === 'resume') {
    const baseline = original?.toString('utf8').match(/^# spider:resume:start\n[\s\S]*?^# spider:resume:end(?:\n|$)/m)?.[0] ?? '';
    source = source.replace(/^# spider:resume:start\n[\s\S]*?^# spider:resume:end(?:\n|$)/m, () => baseline);
  } else {
    const scan = scanRootToml(current), baseline = scanRootToml(original).keys[0]?.line ?? '';
    if (scan.keys.length) {
      const key = scan.keys[0]; source = source.slice(0, key.start) + baseline + source.slice(key.start + key.line.length);
    } else if (baseline) source = baseline + source;
  }
  return original === null && !source ? null : Buffer.from(source);
}
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
/** Reverse only spider's part. Keep the original bytes when the result means the same, so formatting survives an untouched file. */
function restoredManaged(current: Buffer | null, original: Buffer | null, part: ManagedPart): Buffer | null {
  const bytes = reverseManaged(current, original, part);
  // Appending a resume block adds a separator to an rc without a final newline.
  // Keep later user edits: restore whole bytes only when that separator is the sole difference.
  if (part.kind === 'resume' && original !== null && !original.toString('utf8').endsWith('\n') && bytes?.equals(Buffer.concat([original, Buffer.from('\n')]))) return original;
  if (part.kind !== 'json' && part.kind !== 'json-paths' && part.kind !== 'keys' || bytes === null || original === null) return bytes;
  try { return canonicalJson(JSON.parse(bytes.toString('utf8'))) === canonicalJson(JSON.parse(original.toString('utf8'))) ? original : bytes; }
  catch { return bytes; }
}
interface PathRollbackPlan {
  bytes: Buffer | null;
  changed: boolean;
  released: string[];
}
function planPathRollback(current: Buffer | null, original: Buffer | null, entry: BackupEntry, candidates: readonly (Buffer | null)[], transition?: AppSettingsTransition, soundOwned = true): PathRollbackPlan {
  const part = entry.managed as Extract<ManagedPart, { kind: 'json-paths' }>;
  let source = current?.toString('utf8') ?? '{}';
  const released: string[] = []; let changed = false;
  for (const path of part.paths) {
    const baseline = entry.pathsBefore?.[path] ?? pathBaseline(original, path);
    const actual = pathBaseline(current, path);
    if (transition && samePath(actual, baseline)) continue;
    if (path === 'sounds.enabled' && !soundOwned && !samePath(actual, baseline)) { released.push(path); continue; }
    const installed = transition && (path === 'theme' || path === 'layout') && samePath(actual, pathBaseline(Buffer.from(JSON.stringify(transition.planned)), path)) ? actual : recordedPath(entry, path);
    if (!samePath(actual, installed)) { released.push(path); continue; }
    if (samePath(actual, baseline)) continue;
    source = editJsonPath(source, path, baseline); changed = true;
  }
  let bytes = changed ? original === null && !Object.keys(object(JSON.parse(source))).length ? null : Buffer.from(source) : current;
  if (changed && bytes && !released.length && (current !== null && digest(current) === entry.after || transition)) {
    const result = canonicalJson(JSON.parse(bytes.toString('utf8')));
    bytes = candidates.find(candidate => candidate && canonicalJson(JSON.parse(candidate.toString('utf8'))) === result) ?? bytes;
  }
  return { bytes, changed, released };
}
async function verifyPathBaselines(root: string, entry: BackupEntry, original: Buffer | null): Promise<(Buffer | null)[]> {
  const candidates = [...await Promise.all((entry.previous ?? []).map(previous => verifiedBackup(root, previous.backup, previous.before))), original];
  for (const [path, baseline] of Object.entries(entry.pathsBefore ?? {})) if (!candidates.some(bytes => canonicalJson(pathBaseline(bytes, path)) === canonicalJson(baseline))) throw new HerdrError('backup-verification-failed', `Cannot verify original path ${path}`);
  return candidates;
}
interface KeyRollbackPlan {
  bytes: Buffer | null;
  changed: boolean;
  keys: KeySections;
  baselines: KeyBaselines;
  released: string[];
}
function planKeyRollback(current: Buffer | null, original: Buffer | null, entry: BackupEntry, candidates: readonly (Buffer | null)[]): KeyRollbackPlan {
  const part = entry.managed as Extract<ManagedPart, { kind: 'keys' }>;
  if (current === null) return { bytes: null, changed: false, keys: {}, baselines: {}, released: Object.entries(part.sections).flatMap(([section, keys]) => keys.map(key => `${section}.${key}`)) };
  const json = current === null ? {} : object(JSON.parse(current.toString('utf8')));
  const before = original === null ? {} : object(JSON.parse(original.toString('utf8')));
  const remaining: Record<string, Record<string, KeyBinding>> = {};
  const baselines: Record<string, Record<string, KeyBaseline>> = {};
  let changed = false;
  for (const [section, fields] of Object.entries(part.sections)) {
    const source = object(json[section] ?? {});
    for (const key of fields) {
      const baseline = entry.keysBefore?.[section]?.[key] ?? keyBaseline(original, section, key);
      const actual: KeyBaseline = Object.hasOwn(source, key) ? { present: true, value: source[key] } : { present: false };
      if (canonicalJson(actual) === canonicalJson(baseline)) continue;
      const installed = entry.keys![section][key];
      if (actual.present && canonicalJson(actual.value) === canonicalJson(installed)) {
        if (baseline.present) source[key] = baseline.value;
        else delete source[key];
        changed = true;
      } else {
        (remaining[section] ??= {})[key] = installed;
        (baselines[section] ??= {})[key] = baseline;
      }
    }
    if (Object.keys(source).length || (entry.keySectionsBefore?.[section] ?? Object.hasOwn(before, section))) json[section] = source;
    else delete json[section];
  }
  let bytes = changed ? original === null && !Object.keys(json).length ? null : Buffer.from(JSON.stringify(json, null, 2) + '\n') : current;
  if (bytes) {
    const result = canonicalJson(JSON.parse(bytes.toString('utf8')));
    bytes = candidates.find(candidate => candidate && canonicalJson(JSON.parse(candidate.toString('utf8'))) === result) ?? bytes;
  }
  return { bytes, changed, keys: remaining, baselines, released: [] };
}
async function verifyKeyBaselines(root: string, entry: BackupEntry, original: Buffer | null): Promise<(Buffer | null)[]> {
  const candidates = [...await Promise.all((entry.previous ?? []).map(previous => verifiedBackup(root, previous.backup, previous.before))), original];
  for (const [section, values] of Object.entries(entry.keysBefore ?? {})) for (const [key, baseline] of Object.entries(values)) {
    if (!candidates.some(bytes => canonicalJson(keyBaseline(bytes, section, key)) === canonicalJson(baseline)))
      throw new HerdrError('backup-verification-failed', `Cannot verify original key ${section}.${key}`);
  }
  for (const [section, present] of Object.entries(entry.keySectionsBefore ?? {}))
    if (!candidates.some(bytes => hasKeySection(bytes, section) === present)) throw new HerdrError('backup-verification-failed', `Cannot verify original key section ${section}`);
  return candidates;
}
export async function rollbackFiles(root: string, journal: SetupJournal, options: {
  dependencies?: Readonly<Record<string, readonly string[]>>;
  warn?(message: string): void;
  appSettings?: AppSettingsTransition;
} = {}): Promise<string[]> {
  await discardModStages(journal);
  const restored: string[] = [], keep = new Set<string>(), settled = new Set<string>();
  const plans: { entry: BackupEntry; current: FileSnapshot; original: Buffer | null; conflict: boolean; alreadyRestored: boolean; keyPlan?: KeyRollbackPlan; pathPlan?: PathRollbackPlan }[] = [];
  // Verify every baseline and decide which referenced files to keep before removing anything.
  for (const entry of [...journal.entries].reverse()) {
    const current = await snapshot(entry.path);
    const original = await verifiedBackup(root, entry.backup, entry.before);
    let conflict = false, alreadyRestored = current.hash === entry.before;
    let keyPlan: KeyRollbackPlan | undefined, pathPlan: PathRollbackPlan | undefined;
    if (entry.managed?.kind === 'json-paths') {
      const candidates = await verifyPathBaselines(root, entry, original);
      try {
        const partial = !journal.verified && options.appSettings && resolve(entry.path) === resolve(options.appSettings.path);
        const ownsSound = !partial || soundOwned(entry, current.hash, journal);
        pathPlan = planPathRollback(current.bytes, original, entry, candidates, partial ? options.appSettings : undefined, ownsSound);
        alreadyRestored = !pathPlan.changed && pathPlan.released.length === 0;
      } catch { conflict = true; alreadyRestored = false; }
    } else if (entry.managed?.kind === 'keys') {
      const candidates = await verifyKeyBaselines(root, entry, original);
      try {
        keyPlan = planKeyRollback(current.bytes, original, entry, candidates);
        conflict = Object.keys(keyPlan.keys).length > 0;
        alreadyRestored = !conflict && !keyPlan.changed && keyPlan.released.length === 0;
      } catch { conflict = true; alreadyRestored = false; }
    } else if (entry.managed && !alreadyRestored) {
      try {
        const actual = managedProjection(current.bytes, entry.managed);
        alreadyRestored = actual === managedProjection(original, entry.managed);
        conflict = !alreadyRestored && actual !== entry.managedAfter
          && !(!journal.verified && matchesAppSettingsTransition(entry.path, entry.managed, current.bytes, original, options.appSettings));
      } catch { conflict = true; }
    }
    if (conflict) for (const path of options.dependencies?.[entry.path] ?? []) keep.add(path);
    plans.push({ entry, current, original, conflict, alreadyRestored, keyPlan, pathPlan });
  }
  // Shared references are reversed before any of the artifacts they load can be removed.
  plans.sort((a, b) => Number(!!b.entry.managed) - Number(!!a.entry.managed));
  for (const { entry, current, original, conflict, alreadyRestored, keyPlan, pathPlan } of plans) {
    if (alreadyRestored) { settled.add(entry.path); continue; }
    if (pathPlan && !keep.has(entry.path)) {
      if (pathPlan.changed) {
        if (pathPlan.bytes === null) {
          if ((await snapshot(entry.path)).hash !== current.hash) throw new HerdrError('concurrent-settings-edit', `Changed during rollback: ${entry.path}`);
          await unlink(entry.path); await syncDirectory(dirname(entry.path));
        } else await atomicWrite(entry.path, pathPlan.bytes, current.mode, current.hash);
        restored.push(entry.path);
      }
      for (const path of pathPlan.released) options.warn?.(`${entry.path}: ${path} was changed by the user and released without restoring it.`);
      settled.add(entry.path);
      continue;
    }
    if (keyPlan && !keep.has(entry.path)) {
      if (keyPlan.released.length) {
        if ((await snapshot(entry.path)).hash !== current.hash) throw new HerdrError('concurrent-settings-edit', `Changed during rollback: ${entry.path}`);
        options.warn?.(`${entry.path} was deleted by the user; released ${keyPlan.released.join(', ')} without restoring it.`);
      }
      if (keyPlan.changed) {
        if (keyPlan.bytes === null) {
          if ((await snapshot(entry.path)).hash !== current.hash) throw new HerdrError('concurrent-settings-edit', `Changed during rollback: ${entry.path}`);
          await unlink(entry.path); await syncDirectory(dirname(entry.path));
        } else await atomicWrite(entry.path, keyPlan.bytes, current.mode, current.hash);
        restored.push(entry.path);
      }
      if (conflict) {
        entry.keys = keyPlan.keys;
        entry.keysBefore = keyPlan.baselines;
        if (entry.keySectionsBefore) entry.keySectionsBefore = Object.fromEntries(Object.keys(keyPlan.keys).map(section => [section, entry.keySectionsBefore![section]]));
        delete entry.terminalKeys;
        entry.managed = { kind: 'keys', sections: Object.fromEntries(Object.entries(keyPlan.keys).map(([section, values]) => [section, Object.keys(values)])) };
        entry.managedAfter = managedProjection(Buffer.from(JSON.stringify(keyPlan.keys)), entry.managed);
        entry.after = keyPlan.bytes === null ? digest(Buffer.alloc(0)) : digest(keyPlan.bytes);
        options.warn?.(`${entry.path} partially restored: managed content was changed by the user. Repair the retained keys and rerun rollback.`);
      } else settled.add(entry.path);
      continue;
    }
    if (conflict || keep.has(entry.path) || !entry.managed && current.hash !== entry.after) {
      options.warn?.(`${entry.path} not restored: ${conflict ? 'managed content was changed by the user' : keep.has(entry.path) ? 'a retained managed part still references this file' : 'file was changed by the user'}. Repair the retained parts and rerun rollback.`);
      continue;
    }
    // A managed file is shared with the user. After any re-plan `after` includes later user edits, so
    // writing the whole original back would discard them. Only spider's own files are restored whole.
    const bytes = entry.managed ? restoredManaged(current.bytes, original, entry.managed) : original;
    if (bytes === null) {
      if ((await snapshot(entry.path)).hash !== current.hash) throw new HerdrError('concurrent-settings-edit', `Changed during rollback: ${entry.path}`);
      await unlink(entry.path);
      await syncDirectory(dirname(entry.path));
    } else {
      await atomicWrite(entry.path, bytes, entry.mode, current.hash);
      await chmod(entry.path, entry.mode);
    }
    restored.push(entry.path); settled.add(entry.path);
  }
  // The next setup takes a fresh baseline for every settled path; only retained files stay journalled.
  journal.entries = journal.entries.filter(entry => !settled.has(entry.path));
  return restored;
}
function isNativeKeyBinding(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0 && !value.includes('\0');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return Object.keys(binding).every(key => key === 'command' || key === 'args')
    && typeof binding.command === 'string' && binding.command.length > 0 && !binding.command.includes('\0')
    && (binding.args === undefined || !!binding.args && typeof binding.args === 'object' && !Array.isArray(binding.args));
}
function isKeyBinding(value: unknown): value is KeyBinding {
  return isNativeKeyBinding(value) && (typeof value === 'string' || Object.hasOwn(value as object, 'args'));
}
export function mergeKeys(bytes: Buffer | null, desiredSections: KeySections, ownedSections: KeySections, overwrite: boolean, options: { ignoredKeys?: KeyFields } = {}): Buffer {
  if (bytes === null) throw new HerdrError('keys-defaults-missing', missingKeyMapMessage);
  let settings: Record<string, unknown>;
  try { settings = object(JSON.parse(bytes.toString('utf8'))); }
  catch { throw new HerdrError('key-binding-conflict', 'The keys file is malformed'); }
  const sectionValues = (section: string): Record<string, unknown> => {
    if (!Object.hasOwn(settings, section)) return {};
    try { return object(settings[section]); }
    catch { throw new HerdrError('key-binding-conflict', `Invalid key section: ${section}`); }
  };
  if (desiredSections['layout:spider-glass']?.['cmd-shift-e'] !== undefined) {
    for (const section of ['global', 'terminal'])
      if (!options.ignoredKeys?.[section]?.includes('cmd-shift-e') && sectionValues(section)['cmd-shift-e'] !== undefined)
        throw new HerdrError('key-binding-conflict', `Competing ${section}.cmd-shift-e needs repair`);
    for (const section of ['global', 'terminal', 'layout:spider-glass']) {
      const close = sectionValues(section)['cmd-shift-w'];
      if (!options.ignoredKeys?.[section]?.includes('cmd-shift-w') && close !== undefined && close !== 'pane.close' && !(section === 'layout:spider-glass' && desiredSections[section]?.['cmd-shift-w'] === 'spider-pane.close' && close === 'spider-pane.close'))
        throw new HerdrError('key-binding-conflict', `${section}.cmd-shift-w needs repair`);
    }
  }
  for (const [section, desired] of Object.entries(desiredSections)) {
    const currentSection = sectionValues(section);
    for (const [key, value] of Object.entries(desired)) {
      const current = currentSection[key];
      const owned = ownedSections[section]?.[key];
      if (!isKeyBinding(value) || owned !== undefined && !isKeyBinding(owned))
        throw new HerdrError('setup-journal-invalid', 'Invalid managed key binding');
      if (current !== undefined && !isNativeKeyBinding(current))
        throw new HerdrError('key-binding-conflict', `Invalid ${section} key: ${key}`);
      const creationBaseline: Readonly<Record<string, string>> = { 'cmd-t': 'tab.new', 'cmd-d': 'pane.split:right', 'cmd-shift-d': 'pane.split:down' };
      const strict = section === 'global' && Object.hasOwn(creationBaseline, key) || section === 'layout:spider-glass' && key === 'cmd-shift-w';
      const bStock = section === 'global' && Object.hasOwn(creationBaseline, key) && current === creationBaseline[key] || section === 'layout:spider-glass' && key === 'cmd-shift-w' && current === 'pane.close';
      const stock = bStock || section === 'global' && (key === 'cmd-p' && current === 'mod.open:picker' || key === 'cmd-n' && current === 'space.new');
      if (current !== undefined && canonicalJson(current) !== canonicalJson(value) && (strict || canonicalJson(current) !== canonicalJson(owned)) && !stock && (!overwrite || strict))
        throw new HerdrError('key-binding-conflict', `Unowned ${section} key: ${key}`);
      currentSection[key] = value;
    }
    settings[section] = Object.fromEntries(Object.entries(currentSection).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  return Buffer.from(JSON.stringify(settings, null, 2) + '\n');
}
export function mergeTerminalKeys(bytes: Buffer | null, desired: Readonly<Record<string, string>>, owned: Readonly<Record<string, string>>, overwrite: boolean): Buffer {
  const settings = bytes === null ? {} : object(JSON.parse(bytes.toString('utf8')));
  const terminal = object(settings.terminal ?? {});
  for (const [key, value] of Object.entries(desired)) {
    const current = terminal[key];
    if (current !== undefined && current !== value && current !== owned[key] && !overwrite)
      throw new HerdrError('key-binding-conflict', `Unowned terminal key: ${key}`);
  }
  return Buffer.from(JSON.stringify({ ...settings, terminal: { ...terminal, ...desired } }, null, 2) + '\n');
}
export function mergeTheme(bytes: Buffer | null): Buffer {
  const settings = bytes === null ? {} : object(JSON.parse(bytes.toString('utf8')));
  return Buffer.from(JSON.stringify({ ...settings, theme: 'dracula-plus-glass' }, null, 2) + '\n');
}
export function disableRootNotes(bytes: Buffer | null): Buffer {
  const scan = scanRootToml(bytes), value = rootNotesValue(bytes);
  if (value === null) return Buffer.from('notes = false\n' + scan.input);
  if (!value) return Buffer.from(scan.input);
  const key = scan.keys[0];
  const line = key.line.replace(/^(\s*(?:notes|"notes"|'notes')\s*=\s*)true/, '$1false');
  return Buffer.from(scan.input.slice(0, key.start) + line + scan.input.slice(key.start + key.line.length));
}
