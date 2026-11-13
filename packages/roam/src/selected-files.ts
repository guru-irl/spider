import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface SelectedFile { path: string; bytes: Buffer; mode: 0o600 | 0o700 }
interface SourceFile extends SelectedFile { privateMode: boolean }
export interface PreparedFiles { files: readonly SelectedFile[]; credentialFiles: readonly SelectedFile[]; providers: readonly string[] }
export class SelectedFilesError extends Error {
  readonly code: string;
  readonly files: readonly string[];
  constructor(code: string, files: readonly string[]) {
    super(`Cannot provision selected files (${code})`);
    this.name = "SelectedFilesError";
    this.code = code;
    this.files = files;
  }
}

const individual = new Set(["settings.json", "models.json", "keybindings.json", "AGENTS.md", "mcp.json", "SYSTEM.md", "APPEND_SYSTEM.md"]);
const directories = new Set(["themes", "skills", "extensions", "prompts"]);
const excluded = new Set(["auth.json", "mcp-auth.json", "trust.json", "sessions", "cache", "caches", ".cache", ".git", ".spider", ".pi-subagents", "node_modules"]);
const maxFileCount = 10_000;

function allowed(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.startsWith("/") ||
      /[\\\u0000-\u001f\u007f]/.test(value)) return false;
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || excluded.has(part.toLowerCase()) || /pi-intercom/i.test(part))) return false;
  return parts.length === 1 ? individual.has(value) || directories.has(value) : directories.has(parts[0]);
}
function fail(code: string, files: readonly string[] = []): never { throw new SelectedFilesError(code, files); }
function own(stat: Stats): boolean { return typeof process.getuid !== "function" || stat.uid === process.getuid(); }
function directory(path: string, privateMode: boolean): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !own(stat) ||
      (privateMode ? (stat.mode & 0o7777) !== 0o700 : (stat.mode & 0o022) !== 0)) throw new Error("Unsafe directory");
}
function rootPath(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || realpathSync(value) !== value) throw new Error("Unsafe root");
  directory(value, false);
  return value;
}
function fileStat(stat: Stats, privateMode: boolean): void {
  const mode = stat.mode & 0o7777;
  if (!stat.isFile() || !own(stat) || stat.nlink !== 1 ||
      (privateMode ? mode !== 0o600 && mode !== 0o700 : (mode & 0o022) !== 0)) throw new Error("Unsafe file");
}
function readFile(path: string, maximum: number, privateMode = true): { bytes: Buffer; mode: 0o600 | 0o700; privateMode: boolean } {
  const link = lstatSync(path);
  if (link.isSymbolicLink()) throw new Error("Unsafe file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    let stat = fstatSync(fd);
    if (stat.nlink === 2 && stat.isFile() && own(stat)) {
      for (const entry of readdirSync(dirname(path))) {
        if (!/^\.(?:spider-roam|secret)-[a-f0-9-]{36}\.tmp$/.test(entry)) continue;
        const temporary = join(dirname(path), entry);
        try {
          const info = lstatSync(temporary);
          if (info.isFile() && info.dev === stat.dev && info.ino === stat.ino && info.uid === stat.uid) unlinkSync(temporary);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      stat = fstatSync(fd);
    }
    fileStat(stat, privateMode);
    if (stat.dev !== link.dev || stat.ino !== link.ino || !Number.isSafeInteger(stat.size) || stat.size > maximum) throw new Error("Unsafe file");
    const bytes = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < bytes.length) { const size = readSync(fd, bytes, count, bytes.length - count, count); if (!size) break; count += size; }
    const after = fstatSync(fd);
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("Changed file");
    return { bytes: bytes.subarray(0, count), mode: (stat.mode & 0o111) !== 0 ? 0o700 : 0o600, privateMode: (stat.mode & 0o077) === 0 };
  } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function atomicWrite(path: string, bytes: Buffer, mode: 0o600 | 0o700, exclusive: boolean, prefix = ".spider-roam-"): void {
  const parent = dirname(path), temporary = join(parent, `${prefix}${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    try {
      fchmodSync(fd, mode);
      let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (exclusive) linkSync(temporary, path);
    else renameSync(temporary, path);
    syncDirectory(parent);
  } finally { try { unlinkSync(temporary); } catch { /* rename or another cleanup removed it */ } }
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function parentPath(root: string, relative: string, create: boolean): string {
  const parts = relative.split("/"); parts.pop();
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (create && !exists(current)) {
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    directory(current, false);
  }
  return current;
}
function nativeMac(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  return new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]).has(bytes.readUInt32BE(0));
}
function sourceFiles(root: string, names: readonly string[], maximum: number): SourceFile[] {
  const result = new Map<string, SourceFile>(); let size = 0;
  const visit = (name: string, explicit: boolean): void => {
    if (!allowed(name)) { if (explicit) fail("selection-not-allowed"); return; }
    if (result.has(name)) return;
    try {
      parentPath(root, name, false);
      const target = join(root, ...name.split("/")), stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error("Unsafe path");
      if (stat.isDirectory()) {
        directory(target, false);
        for (const entry of readdirSync(target).sort()) visit(`${name}/${entry}`, false);
        return;
      }
      if (result.size >= maxFileCount) fail("selection-too-large");
      const file = readFile(target, maximum - size, false);
      size += file.bytes.length;
      if (nativeMac(file.bytes)) fail("unsupported-binary", [name]);
      result.set(name, { path: name, ...file });
    } catch (error) {
      if (error instanceof SelectedFilesError) throw error;
      fail("unsafe-file", [name]);
    }
  };
  for (const name of names) visit(name, true);
  return [...result.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function parseConfig(file: SelectedFile): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration");
    return value as Record<string, unknown>;
  } catch { return fail("invalid-configuration", [file.path]); }
}
function reference(value: string, selected: readonly SelectedFile[]): boolean {
  const name = value.replace(/^\+/, "").replace(/^\.\//, "");
  return allowed(name) && selected.some(file => file.path === name || file.path.startsWith(`${name}/`));
}
function rewriteSettings(value: Record<string, unknown>, selected: readonly SelectedFile[]): Buffer {
  delete value.defaultProjectTrust;
  delete value.sessionDir;
  for (const key of ["packages", "extensions", "skills", "prompts", "themes"]) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key])) fail("invalid-configuration", ["settings.json"]);
    value[key] = key === "packages" ? [] : value[key].filter((item: unknown) => typeof item === "string" && reference(item, selected));
  }
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}
function sensitiveKey(key: string): boolean {
  return /(?:api.?key|access.?token|refresh.?token|authorization|password|secret|credential|private.?key|^token$)/i.test(key);
}
function variable(value: string): boolean { return /^(?:Bearer\s+)?\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/i.test(value); }
function inspectCredentials(value: unknown, file: string, provider: string, providers: Set<string>, key = ""): void {
  if (typeof value === "string") {
    if (sensitiveKey(key)) {
      if (value.startsWith("!")) fail("unsupported-credential-command", [file]);
      if (value && !variable(value)) providers.add(provider);
    }
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(value) || /[?&](?:access_token|api_key|token|key|secret|password)=/i.test(value)) providers.add(provider);
    return;
  }
  if (Array.isArray(value)) { for (const item of value) inspectCredentials(item, file, provider, providers, key); return; }
  if (!value || typeof value !== "object") return;
  for (const [child, item] of Object.entries(value)) {
    const scoped = (file === "models.json" && key === "providers") ? child :
      (file === "mcp.json" && key === "mcpServers") ? `mcp:${child}` : provider;
    inspectCredentials(item, file, scoped, providers, child);
  }
}

/** Snapshot selected files. Credential-bearing configuration is kept separate. */
export function prepareSelectedFiles(input: { sourceRoot: string; selected: readonly string[]; maxBytes: number }): PreparedFiles {
  if (!input || !Array.isArray(input.selected) || input.selected.length > maxFileCount || input.selected.some(value => !allowed(value))) fail("selection-not-allowed");
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || input.maxBytes > 256 * 1024 * 1024) fail("selection-too-large");
  let root: string;
  try { root = rootPath(input.sourceRoot); } catch { return fail("unsafe-source"); }
  const source = sourceFiles(root, input.selected, input.maxBytes);
  const files: SelectedFile[] = [], credentialFiles: SelectedFile[] = [], providers = new Set<string>();
  const foreignHome = String.fromCharCode(47) + "Users" + String.fromCharCode(47);
  for (const file of source) {
    let bytes = file.bytes, localProviders = new Set<string>();
    if (["settings.json", "models.json", "mcp.json", "keybindings.json"].includes(file.path)) {
      const data = parseConfig(file);
      inspectCredentials(data, file.path, file.path === "settings.json" ? "settings" : file.path, localProviders);
      if (file.path === "settings.json") bytes = rewriteSettings(data, source);
    }
    if (file.bytes.includes(Buffer.from(foreignHome))) fail("unsupported-path", [file.path]);
    if (localProviders.size && !file.privateMode) fail("unsafe-file", [file.path]);
    const result: SelectedFile = { path: file.path, mode: file.mode, bytes };
    if (localProviders.size) { credentialFiles.push(result); for (const provider of localProviders) providers.add(provider); }
    else files.push(result);
  }
  return { files, credentialFiles, providers: [...providers].sort() };
}

function installFile(root: string, file: SelectedFile): void {
  const parent = parentPath(root, file.path, true), target = join(parent, file.path.split("/").at(-1)!);
  const backup = `${target}.spider-roam.bak`;
  if (exists(target)) {
    const current = readFile(target, 256 * 1024 * 1024);
    if (current.bytes.equals(file.bytes) && current.mode === file.mode) return;
    if (exists(backup)) readFile(backup, 256 * 1024 * 1024);
    else atomicWrite(backup, current.bytes, 0o600, true);
    atomicWrite(target, file.bytes, file.mode, false);
  } else {
    atomicWrite(target, file.bytes, file.mode, true);
  }
}

/** Read one direct child of a private agent or staging directory without following links. */
export function readPrivateBytes(root: string, name: string, maximum: number): Buffer | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || !Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 256 * 1024 * 1024) throw new Error("Unsafe private file");
  const path = join(rootPath(root), name);
  if (!exists(path)) return null;
  const file = readFile(path, maximum);
  if (file.mode !== 0o600) throw new Error("Unsafe private file mode");
  return file.bytes;
}

/** Install the private pi authentication file, retaining its first backup. */
export function installPiAuthBytes(destinationRoot: string, bytes: Buffer): void {
  if (!Buffer.isBuffer(bytes)) throw new Error("Invalid private file");
  installFile(rootPath(destinationRoot), { path: "auth.json", bytes, mode: 0o600 });
}

/** Replace selected files only, preserving the first pre-provisioning backup. */
export function installSelectedFiles(input: { destinationRoot: string; files: readonly SelectedFile[] }): void {
  if (!input || !Array.isArray(input.files) || input.files.length > maxFileCount ||
      input.files.some(file => !file || !allowed(file.path) || !Buffer.isBuffer(file.bytes) || file.mode !== 0o600 && file.mode !== 0o700) ||
      new Set(input.files.map(file => file.path)).size !== input.files.length) fail("selection-not-allowed");
  let root: string;
  try { root = rootPath(input.destinationRoot); } catch { return fail("unsafe-destination"); }
  for (const file of input.files) {
    try {
      installFile(root, file);
    } catch (error) {
      if (error instanceof SelectedFilesError) throw error;
      fail("unsafe-destination", [file.path]);
    }
  }
}
