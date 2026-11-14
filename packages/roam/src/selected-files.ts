import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

export interface SelectedFile { path: string; bytes: Buffer; mode: 0o600 | 0o700 }
export interface SelectedFileMetadata { path: string; size: number; mode: 0o600 | 0o700 }
export interface SettingsKeyDigest { path: readonly string[]; sha256: string }
export interface SettingsDestinationPreview { fingerprint: string; changedKeys: readonly string[] }
export interface SettingsDestinationDigests { fingerprint: string; digests: readonly (string | null)[] }
interface SourceFile extends SelectedFile { privateMode: boolean }
export interface PreparedFiles { files: readonly SelectedFile[]; credentialFiles: readonly SelectedFile[]; providers: readonly string[] }
export function describeSelectedFiles(input: PreparedFiles): SelectedFileMetadata[] {
  return [...input.files, ...input.credentialFiles].map(file => ({ path: file.path, size: file.bytes.length, mode: file.mode }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
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

const individual = new Set(["settings.json", "models.json", "keybindings.json", "AGENTS.md"]);
const directories = new Set(["themes", "skills"]);
const excluded = new Set(["auth.json", "mcp.json", ".mcp.json", "mcp-config.json", "mcp-servers.json", "mcp.yaml", "mcp.yml", ".mcp.yaml", ".mcp.yml",
  "mcp-auth.json", "system.md", "append_system.md", "extensions", "prompts",
  "trust.json", "sessions", "cache", "caches", ".cache", ".git", ".spider", ".pi-subagents", "node_modules"]);
const maxFileCount = 10_000;

// Pi 1.2.0 settings reference. The wildcard is a provider/model ID, not a setting.
export const PROVISION_SETTINGS_ALLOWLIST = {
  defaultProvider: "string", defaultModel: "string", defaultThinkingLevel: "string", theme: "string",
  "compaction.enabled": "boolean", "compaction.reserveTokens": "number", "compaction.keepRecentTokens": "number",
  "compaction.modelOverrides.*.reserveTokens": "number", "compaction.modelOverrides.*.keepRecentTokens": "number",
  "retry.enabled": "boolean", "retry.maxRetries": "number", "retry.baseDelayMs": "number", "retry.maxAgentDelayMs": "number",
  "retry.provider.timeoutMs": "number", "retry.provider.maxRetries": "number", "retry.provider.maxRetryDelayMs": "number",
} as const;

function allowed(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.startsWith("/") ||
      /[\\\u0000-\u001f\u007f]/.test(value)) return false;
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || excluded.has(part.toLowerCase()) || /pi-intercom/i.test(part))) return false;
  return parts.length === 1 ? individual.has(value) || value === "themes" : directories.has(parts[0]);
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
function fileStat(stat: Stats, privateMode: boolean, recoverableLink = false): void {
  const mode = stat.mode & 0o7777;
  if (!stat.isFile() || !own(stat) || stat.nlink !== 1 && !(recoverableLink && stat.nlink === 2) ||
      (privateMode ? mode !== 0o600 && mode !== 0o700 : (mode & 0o022) !== 0)) throw new Error("Unsafe file");
}
function readFile(path: string, maximum: number, privateMode = true, recoverTemporary = true, recognizeTemporary = false): { bytes: Buffer; mode: 0o600 | 0o700; privateMode: boolean } {
  const link = lstatSync(path);
  if (link.isSymbolicLink()) throw new Error("Unsafe file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    let stat = fstatSync(fd), recoverableLink = false;
    if ((recoverTemporary || recognizeTemporary) && stat.nlink === 2 && stat.isFile() && own(stat)) {
      for (const entry of readdirSync(dirname(path))) {
        if (!/^\.(?:spider-roam|secret)-[a-f0-9-]{36}\.tmp$/.test(entry)) continue;
        const temporary = join(dirname(path), entry);
        try {
          const info = lstatSync(temporary);
          if (info.isFile() && info.dev === stat.dev && info.ino === stat.ino && info.uid === stat.uid) {
            if (recoverTemporary) unlinkSync(temporary); else recoverableLink = true;
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (recoverTemporary) stat = fstatSync(fd);
    }
    fileStat(stat, privateMode, recoverableLink);
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
      if (explicit && (individual.has(name) && !stat.isFile() || name === "themes" && !stat.isDirectory())) fail("unsafe-file", [name]);
      if (explicit && name.startsWith("skills/")) {
        const definition = join(target, "SKILL.md");
        if (!stat.isDirectory() || !exists(definition) || !lstatSync(definition).isFile() || lstatSync(definition).isSymbolicLink()) fail("selection-not-allowed");
      }
      if (stat.isDirectory()) {
        directory(target, false);
        if (!explicit && name.startsWith("skills/") && exists(join(target, "SKILL.md")) && !names.includes(name)) return;
        for (const entry of readdirSync(target).sort()) visit(`${name}/${entry}`, false);
        return;
      }
      if (result.size >= maxFileCount) fail("selection-too-large");
      const file = readFile(target, maximum - size, false, false);
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

function parseConfig(file: SelectedFile, comments: string[] = []): Record<string, unknown> {
  try {
    let source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    if (file.path === "models.json") {
      // Pi accepts line comments and trailing commas in models.json, but not in settings or keybindings.
      source = source.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, token => {
        if (token.startsWith('"')) return token;
        comments.push(token.slice(2)); return "";
      }).replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, token => token.startsWith('"') ? token : "");
    }
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration");
    return value as Record<string, unknown>;
  } catch { return fail("invalid-configuration", [file.path]); }
}
function rewriteSettings(value: Record<string, unknown>): Buffer {
  const result: Record<string, unknown> = Object.create(null);
  function copy(source: Record<string, unknown>, destination: Record<string, unknown>, parts: readonly string[], type: string, setting: string): void {
    const [part, ...rest] = parts;
    const keys = part === "*" ? Object.keys(source) : Object.hasOwn(source, part) ? [part] : [];
    for (const key of keys) {
      const item = source[key];
      if (!rest.length) {
        if (typeof item !== type || typeof item === "number" && (!Number.isFinite(item) ||
            setting.startsWith("compaction.") && (!Number.isSafeInteger(item) || item < 0)) ||
            setting === "defaultThinkingLevel" && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(item as string)) {
          fail("invalid-configuration", ["settings.json"]);
        }
        destination[key] = item;
      } else {
        if (!item || typeof item !== "object" || Array.isArray(item)) fail("invalid-configuration", ["settings.json"]);
        const child = (destination[key] ?? Object.create(null)) as Record<string, unknown>;
        copy(item as Record<string, unknown>, child, rest, type, setting);
        if (Object.keys(child).length) destination[key] = child;
      }
    }
  }
  for (const [path, type] of Object.entries(PROVISION_SETTINGS_ALLOWLIST)) copy(value, result, path.split("."), type, path);
  return Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
}
function selectedSettings(file: SelectedFile): Record<string, unknown> {
  const value = parseConfig(file), filtered: unknown = JSON.parse(rewriteSettings(value).toString("utf8"));
  if (!isDeepStrictEqual(value, filtered)) fail("selection-not-allowed", ["settings.json"]);
  return value;
}
const rawJson = JSON as unknown as { rawJSON(value: string): unknown; isRawJSON(value: unknown): value is { rawJSON: string } };
function parseDestinationSettings(file: SelectedFile): Record<string, unknown> {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    const parse = JSON.parse as unknown as (text: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown) => unknown;
    const value = parse(source, (_key, item, context) => typeof item === "number" && context.source !== undefined && JSON.stringify(item) !== context.source
      ? rawJson.rawJSON(context.source) : item);
    if (!objectValue(value)) throw new Error("Invalid configuration");
    return value;
  } catch { return fail("invalid-destination-settings", ["settings.json"]); }
}
function objectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !rawJson.isRawJSON(value);
}
function canonicalNumber(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return text;
  let digits = (match[2] + (match[3] ?? "")).replace(/^0+/, "");
  if (!digits) return "0";
  const exponent = match[4] ?? "0";
  if (exponent.replace(/^[+-]?0*/, "").length > 6) return `raw:${text}`;
  let scale = Number(exponent) - (match[3]?.length ?? 0);
  const zeroes = /0+$/.exec(digits)?.[0].length ?? 0;
  if (zeroes) { digits = digits.slice(0, -zeroes); scale += zeroes; }
  return `${match[1]}${digits}e${scale}`;
}
function sameSettingValue(previous: unknown, value: unknown): boolean {
  return typeof value === "number" && rawJson.isRawJSON(previous)
    ? canonicalNumber(previous.rawJSON) === canonicalNumber(JSON.stringify(value)) : previous === value;
}
function overlaySettings(destination: Record<string, unknown>, source: Record<string, unknown>, prefix: string[], changed: string[][]): void {
  for (const [key, value] of Object.entries(source)) {
    const path = [...prefix, key], previous = Object.hasOwn(destination, key) ? destination[key] : undefined;
    if (objectValue(value)) {
      const child: Record<string, unknown> = objectValue(previous) ? previous : Object.create(null);
      if (child !== previous) Object.defineProperty(destination, key, { value: child, enumerable: true, configurable: true, writable: true });
      overlaySettings(child, value, path, changed);
    } else if (!Object.hasOwn(destination, key) || !sameSettingValue(previous, value)) {
      Object.defineProperty(destination, key, { value, enumerable: true, configurable: true, writable: true });
      changed.push(path);
    }
  }
}
function validSettingPath(path: readonly string[]): boolean {
  return Array.isArray(path) && Object.keys(PROVISION_SETTINGS_ALLOWLIST).some(setting => {
    const parts = setting.split(".");
    return parts.length === path.length && parts.every((part, index) => part === "*"
      ? typeof path[index] === "string" && path[index].length > 0 && path[index].length <= 512 && !/[\u0000-\u001f\u007f]/.test(path[index])
      : path[index] === part);
  });
}
function validSettingPaths(value: unknown): value is readonly (readonly string[])[] {
  return Array.isArray(value) && value.length <= maxFileCount && value.every(validSettingPath) &&
    new Set(value.map(path => JSON.stringify(path))).size === value.length;
}
export function validSettingsDigests(value: unknown): value is readonly SettingsKeyDigest[] {
  return Array.isArray(value) && value.length <= maxFileCount && value.every(entry => entry && typeof entry === "object" && !Array.isArray(entry) &&
    Object.keys(entry).sort().join(",") === "path,sha256" && typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256)) &&
    validSettingPaths(value.map(entry => entry.path));
}
function settingsFingerprint(bytes: Buffer | null, mode?: number): string {
  const hash = createHash("sha256").update(`spider-roam-settings-v1\0${bytes === null ? "missing" : `present\0${mode}\0`}`);
  if (bytes) hash.update(bytes);
  return hash.digest("hex");
}
function settingValueDigest(value: unknown): string {
  const encoded = rawJson.isRawJSON(value) ? `number:${canonicalNumber(value.rawJSON)}`
    : typeof value === "number" ? `number:${canonicalNumber(JSON.stringify(value))}` : `json:${JSON.stringify(value)}`;
  return createHash("sha256").update(encoded).digest("hex");
}

/** Describe selected settings by key and value digest, never by value. */
export function selectedSettingsDigests(file: SelectedFile): SettingsKeyDigest[] {
  const value = selectedSettings(file), result: SettingsKeyDigest[] = [];
  function visit(item: Record<string, unknown>, path: string[]): void {
    for (const [key, child] of Object.entries(item)) {
      const next = [...path, key];
      if (objectValue(child)) visit(child, next);
      else {
        if (!validSettingPath(next)) fail("invalid-configuration", ["settings.json"]);
        result.push({ path: next, sha256: settingValueDigest(child) });
      }
    }
  }
  visit(value, []);
  return result.sort((a, b) => JSON.stringify(a.path).localeCompare(JSON.stringify(b.path), "en"));
}

/** Read box settings without creating or changing paths, returning only value digests and a fingerprint. */
export function inspectDestinationSettingsDigests(input: { home: string; destinationRoot: string; paths: readonly (readonly string[])[]; maximum: number }): SettingsDestinationDigests {
  if (!input || !validSettingPaths(input.paths) || !Number.isSafeInteger(input.maximum) || input.maximum <= 0 || input.maximum > 256 * 1024 * 1024) fail("invalid-settings-preview");
  let home: string;
  try { home = rootPath(input.home); } catch { return fail("unsafe-destination"); }
  const root = input.destinationRoot;
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || !root.startsWith(`${home}${sep}`)) fail("unsafe-destination");
  let current = home;
  for (const part of root.slice(home.length + 1).split(sep)) {
    current = join(current, part);
    if (!exists(current)) return { fingerprint: settingsFingerprint(null), digests: input.paths.map(() => null) };
    try { directory(current, false); } catch { return fail("unsafe-destination"); }
  }
  const target = join(root, "settings.json");
  if (!exists(target)) return { fingerprint: settingsFingerprint(null), digests: input.paths.map(() => null) };
  let file: ReturnType<typeof readFile>;
  try { file = readFile(target, input.maximum, true, false, true); } catch { return fail("unsafe-destination", ["settings.json"]); }
  try {
    let destination: Record<string, unknown>;
    try { destination = parseDestinationSettings({ path: "settings.json", bytes: file.bytes, mode: file.mode }); }
    catch { return fail("invalid-destination-settings", ["settings.json"]); }
    const digests = input.paths.map(path => {
      let value: unknown = destination;
      for (const part of path) {
        if (!objectValue(value) || !Object.hasOwn(value, part)) return null;
        value = value[part];
      }
      return settingValueDigest(value);
    });
    return { fingerprint: settingsFingerprint(file.bytes, file.mode), digests };
  } finally { file.bytes.fill(0); }
}

/** Compare source digests locally with the read-only box probe. */
export function inspectDestinationSettings(input: { home: string; destinationRoot: string; entries: readonly SettingsKeyDigest[]; maximum: number }): SettingsDestinationPreview {
  if (!input || !validSettingsDigests(input.entries)) fail("invalid-settings-preview");
  const result = inspectDestinationSettingsDigests({ home: input.home, destinationRoot: input.destinationRoot,
    paths: input.entries.map(entry => entry.path), maximum: input.maximum });
  return { fingerprint: result.fingerprint, changedKeys: input.entries.filter((entry, index) => entry.sha256 !== result.digests[index])
    .map(entry => entry.path.join(".")).sort() };
}
function sensitiveKey(key: string): boolean {
  return /(?:api.?key|access.?token|refresh.?token|authorization|password|secret|credential|private.?key|^token$)/i.test(key);
}
function variable(value: string): boolean { return /^(?:Bearer\s+)?\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/i.test(value); }
function inspectCommentCredentials(comments: readonly string[], providers: Set<string>): void {
  for (const comment of comments) {
    for (const match of comment.matchAll(/(?:^|[\s{,;])["']?([\w.-]+)["']?\s*[:=]\s*["']?([^\s"',;}]+)/g)) {
      if (sensitiveKey(match[1]) && match[2]) providers.add("models.json");
    }
  }
}
function inspectCredentials(value: unknown, file: string, provider: string, providers: Set<string>, key = "", header = false): void {
  if (typeof value === "string") {
    if (header || sensitiveKey(key)) {
      if (value.startsWith("!")) fail("unsupported-credential-command", [file]);
      if (value && !variable(value)) providers.add(provider);
    }
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(value) || /[?&](?:access_token|api_key|token|key|secret|password)=/i.test(value)) providers.add(provider);
    return;
  }
  if (Array.isArray(value)) { for (const item of value) inspectCredentials(item, file, provider, providers, key, header); return; }
  if (!value || typeof value !== "object") return;
  for (const [child, item] of Object.entries(value)) {
    const scoped = file === "models.json" && key === "providers" ? child : provider;
    inspectCredentials(item, file, scoped, providers, child, header || file === "models.json" && key === "headers");
  }
}

function containsCredentialCommandReference(bytes: Buffer): boolean {
  return /(?:^|[\s{,;])["']?[\w.-]*(?:api.?key|token|password|secret|credential|authorization|private.?key)[\w.-]*["']?\s*[:=]\s*["']?\s*(?:!|\$\(|`)/im.test(bytes.toString("utf8"));
}
function containsSourcePath(value: unknown, prefixes: readonly string[]): boolean {
  if (typeof value === "string") return prefixes.some(prefix => value.includes(prefix));
  if (Array.isArray(value)) return value.some(item => containsSourcePath(item, prefixes));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => containsSourcePath(key, prefixes) || containsSourcePath(item, prefixes));
}

function fileCredentialProviders(file: SelectedFile): Set<string> {
  if (!file || !allowed(file.path) || !Buffer.isBuffer(file.bytes) || file.mode !== 0o600 && file.mode !== 0o700) fail("selection-not-allowed");
  if (containsCredentialCommandReference(file.bytes)) fail("unsupported-credential-command", [file.path]);
  const providers = new Set<string>();
  if (["settings.json", "models.json", "keybindings.json"].includes(file.path)) {
    const comments: string[] = [];
    inspectCredentials(parseConfig(file, comments), file.path, file.path === "settings.json" ? "settings" : file.path, providers);
    inspectCommentCredentials(comments, providers);
  }
  return providers;
}

/** Reject credential-bearing configuration before it reaches the public file channel. */
export function assertPublicSelectedFile(file: SelectedFile): void {
  if (fileCredentialProviders(file).size) fail("credential-file-requires-consent", [file.path]);
}

/** Match each private file's credential providers to the providers being consented. */
export function assertCredentialSelectedFile(file: SelectedFile, consented: readonly string[]): void {
  if ([...fileCredentialProviders(file)].some(provider => !consented.includes(provider))) fail("provider-consent-required", [file.path]);
}

/** Snapshot selected files. Credential-bearing configuration is kept separate. */
export function prepareSelectedFiles(input: { sourceRoot: string; selected: readonly string[]; maxBytes: number; sourceHome?: string }): PreparedFiles {
  if (!input || !Array.isArray(input.selected) || input.selected.length > maxFileCount || input.selected.some(value => !allowed(value))) fail("selection-not-allowed");
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || input.maxBytes > 256 * 1024 * 1024) fail("selection-too-large");
  let root: string;
  try { root = rootPath(input.sourceRoot); } catch { return fail("unsafe-source"); }
  const source = sourceFiles(root, input.selected, input.maxBytes);
  const files: SelectedFile[] = [], credentialFiles: SelectedFile[] = [], providers = new Set<string>();
  const foreignHome = String.fromCharCode(47) + "Users" + String.fromCharCode(47);
  const home = input.sourceHome ?? process.env.HOME;
  const prefixes = [foreignHome, ...(home && isAbsolute(home) && home !== "/" ? [home] : [])];
  const pathFiles = new Set<string>(), commandFiles = new Set<string>();
  for (const file of source) {
    let bytes = file.bytes, localProviders = new Set<string>();
    if (prefixes.some(prefix => file.bytes.includes(Buffer.from(prefix)))) pathFiles.add(file.path);
    if (containsCredentialCommandReference(file.bytes)) commandFiles.add(file.path);
    if (["settings.json", "models.json", "keybindings.json"].includes(file.path)) {
      const comments: string[] = [], data = parseConfig(file, comments);
      if (containsSourcePath(data, prefixes)) pathFiles.add(file.path);
      inspectCommentCredentials(comments, localProviders);
      try { inspectCredentials(data, file.path, file.path === "settings.json" ? "settings" : file.path, localProviders); }
      catch (error) {
        if (!(error instanceof SelectedFilesError) || error.code !== "unsupported-credential-command") throw error;
        commandFiles.add(file.path);
      }
      if (file.path === "settings.json") bytes = rewriteSettings(data);
    }
    if (localProviders.size && !file.privateMode) fail("unsafe-file", [file.path]);
    const result: SelectedFile = { path: file.path, mode: file.mode, bytes };
    if (localProviders.size) { credentialFiles.push(result); for (const provider of localProviders) providers.add(provider); }
    else files.push(result);
  }
  if (commandFiles.size) fail("unsupported-credential-command", [...new Set([...commandFiles, ...pathFiles])].sort());
  if (pathFiles.size) fail("unsupported-path", [...pathFiles].sort());
  return { files, credentialFiles, providers: [...providers].sort() };
}

function installFile(root: string, file: SelectedFile, expectedSettingsFingerprint?: string): void {
  const patch = file.path === "settings.json" ? selectedSettings(file) : null;
  const parent = parentPath(root, file.path, true), target = join(parent, file.path.split("/").at(-1)!);
  const backup = `${target}.spider-roam.bak`;
  if (exists(target)) {
    const current = readFile(target, 256 * 1024 * 1024);
    let next: Buffer | null = null;
    try {
      if (patch) {
        let destination: Record<string, unknown>;
        try { destination = parseDestinationSettings({ ...file, bytes: current.bytes }); }
        catch { return fail("invalid-destination-settings", ["settings.json"]); }
        const changed: string[][] = [];
        overlaySettings(destination, patch, [], changed);
        if (expectedSettingsFingerprint && settingsFingerprint(current.bytes, current.mode) !== expectedSettingsFingerprint && (changed.length || current.mode !== file.mode)) {
          fail("settings-preview-changed", ["settings.json"]);
        }
        next = changed.length ? Buffer.from(`${JSON.stringify(destination, null, 2)}\n`) : Buffer.from(current.bytes);
      } else next = Buffer.from(file.bytes);
      if (current.bytes.equals(next) && current.mode === file.mode) return;
      if (exists(backup)) readFile(backup, 256 * 1024 * 1024);
      else atomicWrite(backup, current.bytes, 0o600, true);
      atomicWrite(target, next, file.mode, false);
    } finally { current.bytes.fill(0); next?.fill(0); }
  } else {
    if (patch && expectedSettingsFingerprint && settingsFingerprint(null) !== expectedSettingsFingerprint) fail("settings-preview-changed", ["settings.json"]);
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
export function installSelectedFiles(input: { destinationRoot: string; files: readonly SelectedFile[]; expectedSettingsFingerprint?: string }): void {
  if (!input || input.expectedSettingsFingerprint !== undefined && (typeof input.expectedSettingsFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedSettingsFingerprint)) ||
      !Array.isArray(input.files) || input.files.length > maxFileCount ||
      input.files.some(file => !file || !allowed(file.path) || !Buffer.isBuffer(file.bytes) || file.mode !== 0o600 && file.mode !== 0o700) ||
      new Set(input.files.map(file => file.path)).size !== input.files.length) fail("selection-not-allowed");
  let root: string;
  try { root = rootPath(input.destinationRoot); } catch { return fail("unsafe-destination"); }
  for (const file of input.files) {
    try {
      installFile(root, file, file.path === "settings.json" ? input.expectedSettingsFingerprint : undefined);
    } catch (error) {
      if (error instanceof SelectedFilesError) throw error;
      fail("unsafe-destination", [file.path]);
    }
  }
}
