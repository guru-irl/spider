// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';
import type { Db } from '@spider/db-core';
import { resolveWorkspace } from '@spider/db-core/roam/repo-map';
import type { CoreId, CoreIdentity, HcArgvClient } from '../../../herdr/src/contracts.js';
import { HerdrError, parseJson } from '../../../herdr/src/client/parse.js';
import { encodeRemotePaneRequest, panePath, paneText, parseRemotePaneReply, PANE_REPLY_LIMIT } from '../../../herdr/src/panes/codec.js';
import type { FolderChoice, FolderMapPort, MachineChoice, PaneTarget, PortablePaneFolder, RemotePaneRequest } from '../../../herdr/src/panes/types.js';

export interface PaneFolderMapPorts {
  locator(source: PaneTarget): Promise<PortablePaneFolder | null>;
  resolve(machine: MachineChoice, repoKey: string, workspaceId: string, relativeCwd: string): Promise<string | null>;
  directoryExists(machine: MachineChoice, path: string): Promise<boolean>;
}
function relativeParts(value: string): string[] {
  paneText(value, true);
  if (posix.isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new HerdrError('invalid-pane-folder', 'Folder must be relative to a checkout');
  const parts = value.split(/[\\/]/).filter(part => part && part !== '.');
  if (parts.some(part => part === '..')) throw new HerdrError('invalid-pane-folder', 'Folder escapes its checkout');
  return parts;
}
function pathApi(path: string): typeof posix | typeof win32 {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') ? win32 : posix;
}
function checkoutFromCwd(cwd: string, relativeCwd: string): { root: string; relativeCwd: string } {
  panePath(cwd); const parts = relativeParts(relativeCwd), api = pathApi(cwd);
  let root = cwd; for (const _part of parts) root = api.dirname(root);
  const expected = api.resolve(root, ...parts), actual = api.resolve(cwd);
  if ((api === win32 ? expected.toLowerCase() : expected) !== (api === win32 ? actual.toLowerCase() : actual)) throw new HerdrError('invalid-pane-folder', 'Resolved folder is outside its checkout');
  return { root, relativeCwd: parts.join('/') };
}
export function createPaneFolderMap(ports: PaneFolderMapPorts): FolderMapPort {
  return { async matchingCheckout(source, machine) {
    const locator = await ports.locator(source); if (!locator) return null;
    const relativeCwd = relativeParts(locator.relativeCwd).join('/');
    const cwd = await ports.resolve(machine, locator.repoKey, locator.workspaceId, relativeCwd);
    if (cwd === null) return null;
    const result = checkoutFromCwd(cwd, relativeCwd);
    if (!await ports.directoryExists(machine, cwd)) throw new HerdrError('pane-folder-unavailable', 'Mapped directory is unavailable');
    return result;
  } };
}
export async function choosePaneFolder(input: { focused: PaneTarget | null; chosen: MachineChoice }, map: FolderMapPort): Promise<FolderChoice> {
  const { focused, chosen } = input;
  if (chosen.state !== 'connected' || !chosen.coreId) throw new HerdrError('pane-machine-unavailable', 'Machine identity is unavailable');
  if (!focused?.cwd) return { cwd: null, reason: 'home' };
  if (focused.coreId === chosen.coreId) return { cwd: panePath(focused.cwd), reason: 'focused' };
  const mapped = await map.matchingCheckout(focused, chosen);
  if (!mapped) return { cwd: null, reason: 'home' };
  const parts = relativeParts(mapped.relativeCwd), api = pathApi(panePath(mapped.root));
  const cwd = api.resolve(mapped.root, ...parts);
  if (checkoutFromCwd(cwd, mapped.relativeCwd).root !== api.resolve(mapped.root)) throw new HerdrError('invalid-pane-folder', 'Mapped folder escapes its checkout');
  return { cwd, reason: 'mapped' };
}
export interface SourcePaneFolders {
  locateFolder(cwd: string): Promise<PortablePaneFolder | null>;
  resolveFolder(repoKey: string, workspaceId: string, relativeCwd: string): Promise<{ cwd: string | null; exists: boolean | null }>;
}
function inside(root: string, child: string): boolean {
  const suffix = relative(root, child); return suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix);
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR'; }
/** Read the existing roaming workspace map; this never creates a mapping or a database. */
export function createSourcePaneFolderPorts(openGlobal: () => Db | undefined): SourcePaneFolders {
  const withDb = async <T>(fallback: T, read: (db: Db) => Promise<T>): Promise<T> => {
    const db = openGlobal(); if (!db) return fallback;
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_workspace_maps'").get()) return fallback;
      return await read(db);
    } finally { db.close(); }
  };
  return {
    async locateFolder(cwd) {
      panePath(cwd);
      return withDb(null, async db => {
        const current = await realpath(cwd);
        const mappings = db.prepare('SELECT repo_key,workspace_id,path FROM roam_workspace_maps').all() as { repo_key: string; workspace_id: string; path: string }[];
        const matches: PortablePaneFolder[] = [];
        for (const mapping of mappings) {
          paneText(mapping.repo_key); paneText(mapping.workspace_id); panePath(mapping.path);
          if (resolveWorkspace(db, mapping.repo_key, mapping.workspace_id) !== mapping.path) throw new HerdrError('invalid-pane-folder', 'Workspace mapping changed');
          let root: string;
          try { root = await realpath(mapping.path); } catch (error) { if (missing(error)) continue; throw error; }
          if (inside(root, current)) matches.push({ repoKey: mapping.repo_key, workspaceId: mapping.workspace_id, relativeCwd: relative(root, current).split(sep).join('/') });
        }
        return matches.length === 1 ? matches[0] : null;
      });
    },
    async resolveFolder(repoKey, workspaceId, relativeCwd) {
      paneText(repoKey); paneText(workspaceId); const parts = relativeParts(relativeCwd);
      return withDb({ cwd: null, exists: null } as { cwd: string | null; exists: boolean | null }, async db => {
        const mapped = resolveWorkspace(db, repoKey, workspaceId); if (mapped === null) return { cwd: null, exists: null };
        panePath(mapped); const cwd = resolve(mapped, ...parts);
        if (!inside(resolve(mapped), cwd)) throw new HerdrError('invalid-pane-folder', 'Folder escapes its workspace');
        try {
          const rootStat = await lstat(mapped);
          if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { cwd, exists: false };
          const root = await realpath(mapped), target = await realpath(cwd), info = await stat(cwd);
          return { cwd, exists: info.isDirectory() && inside(root, target) };
        } catch (error) { if (missing(error)) return { cwd, exists: false }; throw error; }
      });
    },
  };
}
export interface PaneFolderMachine { coreId: CoreId; alias: string | null; machineId: string | null }
export interface PaneFolderTransport {
  local: CoreIdentity; localFolders: SourcePaneFolders;
  /** This read-only request verifies the enrolled core before and after each call. */
  request(machine: PaneFolderMachine, request: RemotePaneRequest): Promise<unknown>;
}
/** Local and remote mapping reads stay on the machine that owns each path. */
export function createPaneFolderPorts(ports: PaneFolderTransport): PaneFolderMapPorts {
  const resolved = new Map<string, { ref: { repoKey: string; workspaceId: string; relativeCwd: string }; count: number }>();
  const destination = async (machine: PaneFolderMachine, ref: { repoKey: string; workspaceId: string; relativeCwd: string }): Promise<string | null> => {
    if (machine.coreId === ports.local.coreId) {
      const result = await ports.localFolders.resolveFolder(ref.repoKey, ref.workspaceId, ref.relativeCwd);
      if (result.cwd === null && result.exists === null) return null;
      if (result.cwd === null || result.exists !== true) throw new HerdrError('pane-folder-unavailable', 'Mapped directory is unavailable');
      return result.cwd;
    }
    const reply = parseRemotePaneReply(await ports.request(machine, { version: 1, op: 'resolve-folder', ...ref }));
    if (reply.op !== 'resolve-folder') throw new HerdrError('invalid-pane-folder', 'Expected a folder reply');
    if (reply.result.status === 'no-mapping') return null;
    if (reply.result.status !== 'mapped') throw new HerdrError('pane-folder-unavailable', 'Mapped directory is unavailable');
    return reply.result.cwd;
  };
  return {
    async locator(source) {
      if (!source.cwd) return null;
      if (source.coreId === ports.local.coreId) return ports.localFolders.locateFolder(source.cwd);
      const reply = parseRemotePaneReply(await ports.request(source, { version: 1, op: 'locate-folder', cwd: source.cwd }));
      if (reply.op !== 'locate-folder') throw new HerdrError('invalid-pane-folder', 'Expected a folder reply');
      if (reply.unavailable) throw new HerdrError('pane-folder-unavailable', 'Source mapping is unavailable');
      return reply.folder;
    },
    async resolve(machine, repoKey, workspaceId, relativeCwd) {
      if (!machine.coreId) throw new HerdrError('pane-machine-unavailable', 'Machine identity is unavailable');
      const ref = { repoKey, workspaceId, relativeCwd }, cwd = await destination({ ...machine, coreId: machine.coreId }, ref);
      if (cwd !== null) {
        checkoutFromCwd(cwd, relativeCwd);
        const key = JSON.stringify([machine.coreId, cwd]), existing = resolved.get(key);
        if (existing && JSON.stringify(existing.ref) !== JSON.stringify(ref)) throw new HerdrError('pane-folder-unavailable', 'Conflicting folder mappings');
        if (existing) existing.count++;
        else {
          if (resolved.size >= 256) resolved.delete(resolved.keys().next().value!);
          resolved.set(key, { ref, count: 1 });
        }
      }
      return cwd;
    },
    async directoryExists(machine, path) {
      if (!machine.coreId) throw new HerdrError('pane-machine-unavailable', 'Machine identity is unavailable');
      const key = JSON.stringify([machine.coreId, path]), entry = resolved.get(key);
      if (!entry) throw new HerdrError('pane-folder-unavailable', 'Folder was not resolved on this machine');
      if (--entry.count === 0) resolved.delete(key);
      return await destination({ ...machine, coreId: machine.coreId }, entry.ref) === path;
    },
  };
}
export interface PaneFolderRemoteTransport {
  exec: HcArgvClient['exec']; buildDigest: string; timeoutMs?: number;
  resolveMachine(machine: PaneFolderMachine): Promise<{ on: string; coreId: CoreId; nodePath: string; endpointPath: string }>;
}
/** Invoke only the installed endpoint, with a build handshake and core checks around the read. */
export function createPaneFolderRemoteRequest(ports: PaneFolderRemoteTransport): PaneFolderTransport['request'] {
  return async (machine, request) => {
    if (request.op !== 'locate-folder' && request.op !== 'resolve-folder') throw new HerdrError('invalid-pane-folder', 'Only folder reads are permitted');
    const timeout = ports.timeoutMs ?? 5000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 5000) throw new HerdrError('invalid-pane-folder', 'Invalid folder request timeout');
    const deadline = performance.now() + timeout;
    const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new HerdrError('pane-folder-unavailable', 'Folder request timed out');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HerdrError('pane-folder-unavailable', 'Folder request timed out')), remaining); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    const destination = await bounded(() => ports.resolveMachine(machine));
    if (destination.coreId !== machine.coreId || !destination.on || !/^[a-f0-9]{64}$/.test(ports.buildDigest)) throw new HerdrError('pane-machine-mismatch', 'Machine identity changed');
    panePath(destination.nodePath); panePath(destination.endpointPath);
    const invoke = async (value: RemotePaneRequest) => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new HerdrError('pane-folder-unavailable', 'Folder request timed out');
      const bytes = await bounded(() => ports.exec(destination.on, [destination.nodePath, destination.endpointPath, '--json', encodeRemotePaneRequest(value)], { timeoutMs: remaining, maxBytes: PANE_REPLY_LIMIT }));
      if (bytes.length > PANE_REPLY_LIMIT) throw new HerdrError('invalid-pane-folder', 'Folder reply is too large');
      return parseRemotePaneReply(parseJson(bytes));
    };
    const hello = await invoke({ version: 1, op: 'handshake', protocol: 1, buildDigest: ports.buildDigest });
    if (hello.op !== 'handshake' || hello.protocol !== 1 || hello.buildDigest !== ports.buildDigest) throw new HerdrError('pane-build-mismatch', 'Pane endpoint build or protocol differs');
    const reply = await invoke(request), current = await bounded(() => ports.resolveMachine(machine));
    if (current.coreId !== machine.coreId || current.on !== destination.on || current.nodePath !== destination.nodePath || current.endpointPath !== destination.endpointPath || performance.now() > deadline) throw new HerdrError('pane-machine-mismatch', 'Machine identity changed during folder read');
    return reply;
  };
}
