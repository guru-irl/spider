// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink, chmod, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { HerdrError, object, text } from '../client/parse.js';
import type { TerminalAddress } from '../contracts.js';
import type { InstallFile, NodeObservation, CutoverResult, RuntimeRootObservation } from './installer.js';
import { isRuntimeRootProbe } from '../remote/node-version.js';
export const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export interface FileSnapshot {
  bytes: Buffer | null;
  hash: string | null;
  mode: number;
}
export type ManagedPart = { kind: 'json'; fields: readonly string[]; section?: string } | { kind: 'notes' } | { kind: 'resume' };
export function managedProjection(bytes: Buffer | null, part: ManagedPart): string {
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
  managed?: ManagedPart;
  managedAfter?: string;
}
export interface SetupJournal {
  version: 1;
  entries: BackupEntry[];
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
    await rename(temporary, path);
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
function parseManagedPart(value: unknown): ManagedPart {
  const part = object(value);
  if (part.kind === 'notes' || part.kind === 'resume') return { kind: part.kind };
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
      for (const [key, value] of Object.entries(object(e.terminalKeys)))
        terminalKeys[key] = text(value);
    return { path: text(e.path), before: e.before === null ? null : text(e.before), after: text(e.after), backup: e.backup === null ? null : text(e.backup), mode: e.mode, ...(e.terminalKeys === undefined ? {} : { terminalKeys }), ...(e.managed === undefined ? {} : { managed: parseManagedPart(e.managed), managedAfter: typeof e.managedAfter === 'string' ? e.managedAfter : text(e.managedAfter) }) };
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
  return { version: 1, entries, probes, cutover, runtimes, ...(j.runtimeRootProbes === undefined ? {} : { runtimeRootProbes: runtimeRootObservations(j.runtimeRootProbes) }), ...(j.cutoverFingerprint === undefined ? {} : { cutoverFingerprint: text(j.cutoverFingerprint) }), ...(j.launcherNodePath === undefined ? {} : { launcherNodePath: text(j.launcherNodePath) }), fingerprint: j.fingerprint === null ? null : text(j.fingerprint), verified: j.verified, cutoverPending: j.cutoverPending, retiredTerminals: j.retiredTerminals.map(v => text(v) as TerminalAddress) };
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
  return managedProjection(f.snapshotOnly && f.expected === null ? null : f.bytes, part);
}
export interface AppSettingsTransition {
  path: string;
  planned: Readonly<{ theme: string; layout: string }>;
}
function matchesAppSettingsTransition(path: string, part: ManagedPart, current: Buffer | null, original: Buffer | null, transition?: AppSettingsTransition): boolean {
  if (!transition || resolve(path) !== resolve(transition.path) || part.kind !== 'json' || part.section !== undefined
    || part.fields.length !== 2 || !part.fields.includes('theme') || !part.fields.includes('layout')) return false;
  const planned = Buffer.from(JSON.stringify(transition.planned));
  // App commands commit these fields separately. No other managed field or foreign value is recoverable.
  return part.fields.every(field => {
    const one = { ...part, fields: [field] }, actual = managedProjection(current, one);
    return actual === managedProjection(original, one) || actual === managedProjection(planned, one);
  });
}
export async function validateFiles(files: readonly InstallFile[], journal: SetupJournal, overwriteKeys = false, appSettings?: AppSettingsTransition): Promise<void> {
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path))
      throw new HerdrError('duplicate-install-path', `Repeated target: ${f.path}`);
    seen.add(f.path);
    const current = await snapshot(f.path);
    const prior = journal.entries.find(e => e.path === f.path);
    if (f.managed && prior) {
      const part = prior.managed ?? f.managed;
      const recorded = prior.managedAfter ?? plannedProjection(f, part);
      const actual = managedProjection(current.bytes, part);
      let restored = !journal.verified && prior.before === current.hash;
      if (!restored && !journal.verified && actual !== recorded) {
        const baseline = prior.backup === null ? null : (await snapshot(prior.backup)).bytes;
        if ((baseline === null ? null : digest(baseline)) !== prior.before) throw new HerdrError('backup-verification-failed', `Cannot verify original managed values: ${f.path}`);
        restored = managedProjection(baseline, part) === actual
          || f.snapshotOnly === true && matchesAppSettingsTransition(f.path, part, current.bytes, baseline, appSettings);
      }
      if (actual !== recorded && !restored)
        throw new HerdrError('managed-artifact-changed', `Managed ${f.managed.kind} content changed in ${f.path}. Restore the recorded managed values ${recorded}, then rerun setup. Unrelated edits are preserved.`);
    }
    const recovering = prior?.after === digest(f.bytes) && (current.hash === prior.after || current.hash === prior.before);
    if (current.hash !== f.expected && !recovering) {
      throw new HerdrError(f.collision === 'key' ? 'key-binding-conflict' : f.collision === 'clone' ? 'unowned-clone-collision' : 'concurrent-settings-edit', `Unowned or changed target: ${f.path}`);
    }
  }
}
export async function prepareBackups(root: string, files: readonly InstallFile[], journal: SetupJournal): Promise<void> {
  for (const f of files) {
    const current = await snapshot(f.path);
    const after = digest(f.bytes);
    const prior = journal.entries.find(e => e.path === f.path);
    if (current.hash === after && prior?.after === after || !f.managed && current.hash === after || prior?.after === after && current.hash === prior.before)
      continue;
    if (current.hash !== f.expected)
      throw new HerdrError('concurrent-settings-edit', `Changed between preflight and backup: ${f.path}`);
    if (prior) {
      prior.after = after;
      if (f.terminalKeys) prior.terminalKeys = f.terminalKeys;
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
    const entry = { path: f.path, before: current.hash, after, backup, mode: current.mode, ...(f.terminalKeys ? { terminalKeys: f.terminalKeys } : {}), ...(f.managed ? { managed: f.managed, managedAfter: plannedProjection(f, f.managed) } : {}) };
    journal.entries = [...journal.entries.filter(e => e.path !== f.path), entry];
  }
  await saveJournal(root, journal);
}
export async function applyFiles(files: readonly InstallFile[], journal: SetupJournal): Promise<string[]> {
  const writes: string[] = [];
  for (const f of files) {
    const current = await snapshot(f.path);
    if (f.snapshotOnly) {
      if (current.hash !== f.expected) throw new HerdrError('concurrent-settings-edit', `Changed after backup: ${f.path}`);
      continue;
    }
    if (current.hash === digest(f.bytes))
      continue;
    const entry = journal.entries.find(e => e.path === f.path)!;
    if (current.hash !== f.expected && !(entry.after === digest(f.bytes) && current.hash === entry.before))
      throw new HerdrError('concurrent-settings-edit', `Changed after backup: ${f.path}`);
    await atomicWrite(f.path, f.bytes, f.mode ?? entry.mode, current.hash);
    writes.push(f.path);
  }
  return writes;
}
function reverseManaged(current: Buffer | null, original: Buffer | null, part: ManagedPart): Buffer | null {
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
  if (part.kind !== 'json' || bytes === null || original === null) return bytes;
  try { return canonicalJson(JSON.parse(bytes.toString('utf8'))) === canonicalJson(JSON.parse(original.toString('utf8'))) ? original : bytes; }
  catch { return bytes; }
}
export async function rollbackFiles(root: string, journal: SetupJournal, options: {
  dependencies?: Readonly<Record<string, readonly string[]>>;
  warn?(message: string): void;
  appSettings?: AppSettingsTransition;
} = {}): Promise<string[]> {
  const restored: string[] = [], keep = new Set<string>(), settled = new Set<string>();
  const plans: { entry: BackupEntry; current: FileSnapshot; original: Buffer | null; conflict: boolean; alreadyRestored: boolean }[] = [];
  // Verify every baseline and decide which referenced files to keep before removing anything.
  for (const entry of [...journal.entries].reverse()) {
    const current = await snapshot(entry.path);
    let original: Buffer | null = null;
    if (entry.backup !== null) {
      if (!entry.backup.startsWith(resolve(root) + '/backups/')) throw new HerdrError('setup-journal-invalid', 'Backup is outside the setup root');
      original = (await snapshot(entry.backup)).bytes;
      if (!original || digest(original) !== entry.before) throw new HerdrError('backup-verification-failed', `Cannot restore: ${entry.path}`);
    }
    let conflict = false, alreadyRestored = current.hash === entry.before;
    if (entry.managed && !alreadyRestored) {
      try {
        const actual = managedProjection(current.bytes, entry.managed);
        alreadyRestored = actual === managedProjection(original, entry.managed);
        conflict = !alreadyRestored && actual !== entry.managedAfter
          && !(!journal.verified && matchesAppSettingsTransition(entry.path, entry.managed, current.bytes, original, options.appSettings));
      } catch { conflict = true; }
      if (conflict) for (const path of options.dependencies?.[entry.path] ?? []) keep.add(path);
    }
    plans.push({ entry, current, original, conflict, alreadyRestored });
  }
  // Shared references are reversed before any of the artifacts they load can be removed.
  plans.sort((a, b) => Number(!!b.entry.managed) - Number(!!a.entry.managed));
  for (const { entry, current, original, conflict, alreadyRestored } of plans) {
    if (alreadyRestored) { settled.add(entry.path); continue; }
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
