import { setTimeout as retryDelay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, utimes } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Blocker } from "@spider/db-core/roam/types";
import type { GitPorts, WorkspaceSnapshot } from "./contracts";

interface SnapshotInput {
  root: string;
  cwd: string;
  repoKey: string;
  workspaceId: string;
  moveId: string;
  stage: "pre" | "final";
  writers: readonly Blocker[];
}

const PRIVATE_IDENTITY = {
  GIT_AUTHOR_NAME: "Spider roaming snapshot",
  GIT_AUTHOR_EMAIL: "roam@example.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Spider roaming snapshot",
  GIT_COMMITTER_EMAIL: "roam@example.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

async function git(ports: GitPorts, root: string, argv: readonly string[], options: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer } = {}): Promise<Buffer> {
  try {
    return await ports.run(root, ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...argv], { ...options, env: {
      GIT_INDEX_FILE: undefined, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined,
      GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_OPTIONAL_LOCKS: "0", ...options.env,
    } });
  } catch {
    // Git and configured filters can write private contents to stderr.
    throw new Error(`Git ${argv[0]} failed`);
  }
}
async function gitText(ports: GitPorts, root: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }): Promise<string> {
  return (await git(ports, root, argv, options)).toString("utf8").replace(/\n$/, "");
}
async function gitPath(ports: GitPorts, root: string, name: string): Promise<string> {
  return resolve(root, await gitText(ports, root, ["rev-parse", "--git-path", name]));
}
async function optionalGitConfig(ports: GitPorts, root: string, key: string): Promise<string | null> {
  const missing = `__spider_unset_${randomUUID()}__`;
  const values = nulFields(await git(ports, root, ["config", "--null", "--get", `--default=${missing}`, key]));
  if (values.length !== 1) throw new Error("invalid Git config response");
  return values[0] === missing ? null : values[0];
}
async function sparseGitConfig(ports: GitPorts, root: string): Promise<{ enabled: boolean; cone: boolean | null }> {
  const enabled = await gitText(ports, root, ["config", "--get", "--type=bool", "--default=false", "core.sparseCheckout"]);
  const configuredCone = await optionalGitConfig(ports, root, "core.sparseCheckoutCone");
  const cone = configuredCone === null ? null : await gitText(ports, root, ["config", "--get", "--type=bool", "core.sparseCheckoutCone"]);
  if ((enabled !== "true" && enabled !== "false") || (cone !== null && cone !== "true" && cone !== "false")) throw new Error("invalid sparse Git config response");
  return { enabled: enabled === "true", cone: cone === null ? null : cone === "true" };
}
async function optionalText(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

const UNSAFE_VALUES: readonly { test: RegExp; pattern: string }[] = [
  { test: /^\s*\//, pattern: "^[[:space:]]*/" },
  { test: /^\s*~/, pattern: "^[[:space:]]*~" },
  { test: /^\s*\.\.?[\\/]/, pattern: "^[[:space:]]*\\.\\.?[/\\\\]" },
  { test: /^\s*[A-Za-z]:/, pattern: "^[[:space:]]*[A-Za-z]:" },
  { test: /^\s*\\\\/, pattern: "^[[:space:]]*\\\\\\\\" },
  { test: /^\s*\$HOME(?:[\\/]|$)/, pattern: "^[[:space:]]*\\$HOME([/\\\\]|$)" },
  { test: /^\s*\$\{HOME\}(?:[\\/]|$)/, pattern: "^[[:space:]]*\\$\\{HOME\\}([/\\\\]|$)" },
  { test: /^\s*file:\/\//i, pattern: "^[[:space:]]*[Ff][Ii][Ll][Ee]://" },
  { test: /^\s*[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s]*@/, pattern: "^[[:space:]]*[A-Za-z][A-Za-z0-9+.-]*://[^/[:space:]]*@" },
  { test: /[?&](?:token|access[_-]?token|password|api[_-]?key)=/i, pattern: "[?&]([Tt][Oo][Kk][Ee][Nn]|[Aa][Cc][Cc][Ee][Ss][Ss][_-]?[Tt][Oo][Kk][Ee][Nn]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy])=" },
];
const RELATIVE_PATH_VALUE = { test: /^\s*[^/\\:\s][^:]*[/\\]/, pattern: "^[[:space:]]*[^/\\\\:[:space:]][^:]*[/\\\\]" };
function semanticRefValue(name: string): boolean {
  return /^(remote\..*\.(fetch|push)|branch\..*\.merge)$/.test(name);
}
function sensitiveSubsection(name: string): boolean {
  const first = name.indexOf("."), last = name.lastIndexOf(".");
  if (first < 0 || last === first) return false;
  const subsection = name.slice(first + 1, last);
  return UNSAFE_VALUES.some(({ test }) => test.test(subsection))
    || /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s]*@/.test(subsection)
    || /[?&](?:token|access[_-]?token|password|api[_-]?key)=/i.test(subsection);
}
function unsafeConfigKey(name: string): boolean {
  return sensitiveSubsection(name) || /^(user|author|committer|credential|url|include|includeif)\./.test(name)
    || /(?:^|\.)(?:signingkey|signkey|[^.]*(?:token|password|passwd|secret|apikey|api[_-]?key|authorization)[^.]*)$/.test(name)
    || /^http\..*extraheader$/.test(name)
    || /^remote\..*\.(url|pushurl)$/.test(name)
    || /^core\.(sshcommand|hookspath|fsmonitor|worktree|bare|editor|pager)$/.test(name)
    || /^(sequence\.editor|interactive\.difffilter)$/.test(name)
    || /^merge\..*\.driver$/.test(name)
    || /^(diff|merge)tool\..*\.cmd$/.test(name)
    || /(?:^|\.)gpgsign$/.test(name)
    || /^gpg\./.test(name)
    || /\.(?:command|path)$/.test(name)
    || /(?:file|directory|dir|template|cert)$/.test(name)
    || /^filter\..*\.(clean|smudge|process)$/.test(name)
    || /^diff\..*\.textconv$/.test(name)
    || /^gpg(?:\..*)?\.program$/.test(name);
}
/** Classify a parsed Git config entry without retaining or exposing its value. */
export function isUnsafeWorktreeConfig(key: string, value: string): boolean {
  const name = key.toLowerCase();
  return unsafeConfigKey(name) || UNSAFE_VALUES.some(({ test }) => test.test(value))
    || (!semanticRefValue(name) && RELATIVE_PATH_VALUE.test.test(value))
    || (name.startsWith("alias.") && value.trimStart().startsWith("!"));
}
function reportedConfigKey(name: string): string {
  const lower = name.toLowerCase(), first = name.indexOf("."), last = name.lastIndexOf(".");
  if (first !== last && (sensitiveSubsection(name) || /^(http|credential|url|includeif)\./.test(lower))) {
    return `${name.slice(0, first)}.<redacted>.${name.slice(last + 1)}`;
  }
  if (lower.startsWith("remote.") && first !== last && /[:@/?#]/.test(name.slice(first + 1, last))) {
    return `remote.<redacted>.${name.slice(last + 1)}`;
  }
  return name;
}
function stripConfigComments(config: string): string {
  let result = "", quoted = false, escaped = false, comment = false;
  for (const char of config) {
    if (comment) {
      if (char === "\n") { comment = false; result += char; }
    } else if (escaped) {
      result += char; escaped = false;
    } else if (char === "\\") {
      result += char; escaped = true;
    } else if (char === '"') {
      result += char; quoted = !quoted;
    } else if (!quoted && (char === "#" || char === ";")) {
      comment = true;
    } else result += char;
  }
  return result;
}
async function filteredWorktreeConfig(ports: GitPorts, root: string, source: string, privateDir: string): Promise<{ config: string | null; dropped: string[] }> {
  if (!(await present(source))) return { config: null, dropped: [] };
  const info = await lstat(source);
  if (!info.isFile()) throw new Error("worktree config must be a regular file");
  const file = join(privateDir, "worktree-config");
  await copyFile(source, file); await chmod(file, 0o600);
  const base = ["config", "--file", file, "--no-includes"];
  const records = nulFields(await git(ports, root, [...base, "--null", "--list"]));
  const settings = new Map<string, string[]>();
  for (const record of records) {
    const split = record.indexOf("\n");
    const name = split < 0 ? record : record.slice(0, split), value = split < 0 ? "" : record.slice(split + 1);
    const values = settings.get(name) ?? [];
    values.push(value); settings.set(name, values);
  }
  const dropped: string[] = [];
  for (const [name, values] of settings) {
    if (!values.some(value => isUnsafeWorktreeConfig(name, value))) continue;
    if (unsafeConfigKey(name.toLowerCase())) await git(ports, root, [...base, "--unset-all", name]);
    else {
      const patterns = UNSAFE_VALUES.filter(({ test }) => values.some(value => test.test(value))).map(({ pattern }) => pattern);
      if (!semanticRefValue(name.toLowerCase()) && values.some(value => RELATIVE_PATH_VALUE.test.test(value))) patterns.push(RELATIVE_PATH_VALUE.pattern);
      if (name.toLowerCase().startsWith("alias.") && values.some(value => value.trimStart().startsWith("!"))) patterns.push("^[[:space:]]*!");
      await git(ports, root, [...base, "--unset-all", name, `(${patterns.join("|")})`]);
    }
    const reported = reportedConfigKey(name);
    if (!dropped.includes(reported)) dropped.push(reported);
  }
  // Comments are not Git settings and may themselves contain credentials.
  return { config: stripConfigComments(await readFile(file, "utf8")), dropped };
}
interface Entry { mode: string; oid: string; path: string; stage: number }
const decoder = new TextDecoder("utf-8", { fatal: true });

function nulFields(bytes: Buffer): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      fields.push(decoder.decode(bytes.subarray(start, i)));
      start = i + 1;
    }
  }
  if (start !== bytes.length) throw new Error("invalid Git output");
  return fields;
}
function entries(bytes: Buffer, tree: boolean): Entry[] {
  return nulFields(bytes).map(record => {
    const match = tree
      ? /^(\d{6}) (?:blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(record)
      : /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("invalid Git tree or index entry");
    return { mode: match[1], oid: match[2], stage: tree ? 0 : Number(match[3]), path: tree ? match[3] : match[4] };
  });
}
function localState(path: string): boolean {
  return path.split("/").some(part => [".spider", ".pi-subagents"].includes(part.normalize("NFD").toLowerCase()));
}
async function validateEntries(ports: GitPorts, root: string, list: readonly Entry[]): Promise<void> {
  const names = new Map<string, string>();
  const links = new Map<string, string>();
  for (const entry of list) {
    const parts = entry.path.split("/");
    if (parts.some(part => !part || part === "." || part === "..")) throw new Error("invalid Git path");
    if (entry.stage !== 0) throw new Error(`unresolved index: ${entry.path}`);
    if (entry.mode === "160000") throw new Error(`submodule is unsupported: ${entry.path}`);
    if (!["100644", "100755", "120000"].includes(entry.mode)) throw new Error(`unsupported file type: ${entry.path}`);
    if (localState(entry.path)) throw new Error(`tracked local state: ${entry.path}`);
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join("/");
      // Fold conservatively across case-insensitive Unicode filesystems.
      const folded = name.normalize("NFD").toLowerCase().toUpperCase().toLowerCase().normalize("NFD");
      const previous = names.get(folded);
      if (previous !== undefined && previous !== name) throw new Error(`case-fold collision: ${previous} and ${name}`);
      names.set(folded, name);
    }
    if (entry.mode === "120000") links.set(entry.path, decoder.decode(await git(ports, root, ["cat-file", "blob", entry.oid])));
  }
  const treePaths = new Set(names.values());
  for (const [path, target] of links) {
    const portableTarget = target.replace(/\\/g, "/");
    if (portableTarget.startsWith("/") || /^[A-Za-z]:/.test(portableTarget)) throw new Error(`escaping symlink: ${path}`);
    const pending = [...path.split("/").slice(0, -1), ...portableTarget.split("/")];
    const resolved: string[] = [];
    let followed = 0;
    while (pending.length) {
      const part = pending.shift()!;
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!resolved.length) throw new Error(`escaping symlink: ${path}`);
        resolved.pop();
        continue;
      }
      resolved.push(part);
      const current = resolved.join("/");
      let next = links.get(current);
      if (next === undefined && !treePaths.has(current)) {
        const file = join(root, ...resolved);
        try { if ((await lstat(file)).isSymbolicLink()) next = await readlink(file); }
        catch (error) {
          if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
      if (next !== undefined) {
        if (++followed > 40) throw new Error(`cyclic symlink: ${path}`);
        resolved.pop();
        const portable = next.replace(/\\/g, "/");
        if (/^[A-Za-z]:/.test(portable)) throw new Error(`escaping symlink: ${path}`);
        if (isAbsolute(portable)) {
          if (!inside(root, portable)) throw new Error(`escaping symlink: ${path}`);
          resolved.length = 0;
          pending.unshift(...relative(root, portable).split(sep));
        } else pending.unshift(...portable.split("/"));
      }
    }
  }
}
async function validateWorkingLinks(root: string, list: readonly Entry[]): Promise<void> {
  for (const entry of list) {
    if (entry.mode !== "120000") continue;
    const pending = entry.path.split("/"), resolved: string[] = [];
    let followed = 0;
    while (pending.length) {
      const part = pending.shift()!;
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!resolved.length) throw new Error(`escaping symlink: ${entry.path}`);
        resolved.pop();
        continue;
      }
      resolved.push(part);
      const file = join(root, ...resolved);
      let info;
      try { info = await lstat(file); }
      catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        throw error;
      }
      if (!info.isSymbolicLink()) continue;
      if (++followed > 40) throw new Error(`cyclic symlink: ${entry.path}`);
      const target = (await readlink(file)).replace(/\\/g, "/");
      resolved.pop();
      if (/^[A-Za-z]:/.test(target)) throw new Error(`escaping symlink: ${entry.path}`);
      if (isAbsolute(target)) {
        if (!inside(root, target)) throw new Error(`escaping symlink: ${entry.path}`);
        resolved.length = 0;
        pending.unshift(...relative(root, target).split(sep));
      } else pending.unshift(...target.split("/"));
    }
  }
}
async function clearAssumedFlags(ports: GitPorts, root: string, env: Readonly<NodeJS.ProcessEnv>): Promise<string[]> {
  const records = nulFields(await git(ports, root, ["ls-files", "-v", "-z"], { env }));
  const assumed = records.filter(record => /^[a-z] /.test(record)).map(record => record.slice(2));
  if (assumed.length) await git(ports, root, ["update-index", "-z", "--no-assume-unchanged", "--stdin"], { env, stdin: Buffer.from(`${assumed.join("\0")}\0`) });
  const materialized: string[] = [];
  for (const record of records) {
    if (/^[sS] /.test(record) && await present(join(root, ...record.slice(2).split("/")))) materialized.push(record.slice(2));
  }
  return materialized;
}
async function overlayMaterialized(ports: GitPorts, root: string, env: Readonly<NodeJS.ProcessEnv>, source: readonly Entry[], paths: readonly string[], exclusions: readonly string[]): Promise<void> {
  const original = new Map(source.map(entry => [entry.path, entry])), materialized = new Set(paths);
  const files: string[] = [], directories: string[] = [], possibleLinks: string[] = [];
  for (const path of paths) {
    const info = await lstat(join(root, ...path.split("/")));
    if (info.isDirectory()) directories.push(path);
    else if (info.isFile() && original.get(path)?.mode === "120000") possibleLinks.push(path);
    else files.push(path);
  }
  const symlinks = possibleLinks.length ? await gitText(ports, root, ["config", "--type=bool", "--get", "--default=true", "core.symlinks"]) : "true";
  if (symlinks === "true") files.push(...possibleLinks);
  await git(ports, root, ["update-index", "--force-remove", "-z", "--stdin"], { env, stdin: Buffer.from(`${paths.join("\0")}\0`) });
  if (files.length) {
    const pathspecs = files.map(path => `:(top,literal)${path}`);
    await git(ports, root, ["add", "--sparse", "-f", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, stdin: Buffer.from(`${pathspecs.join("\0")}\0`) });
  }
  if (symlinks === "false") {
    for (const path of possibleLinks) {
      const oid = await gitText(ports, root, ["hash-object", "-w", "--no-filters", "--", path]);
      await git(ports, root, ["update-index", "--add", "--cacheinfo", `120000,${oid},${path}`], { env });
    }
  }
  for (const path of directories) {
    const pathspec = `:(top,literal)${path}`;
    const visible = nulFields(await git(ports, root, ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec, ...exclusions], { env }));
    if (visible.length) await git(ports, root, ["add", "--sparse", "-A", "--", pathspec, ...exclusions], { env });
  }
  const updated = entries(await git(ports, root, ["ls-files", "--stage", "-z"], { env }), false);
  const mismatch = updated.filter(entry => materialized.has(entry.path) && ["100644", "100755"].includes(entry.mode)
    && ["100644", "100755"].includes(original.get(entry.path)?.mode ?? "") && entry.mode !== original.get(entry.path)?.mode);
  if (mismatch.length && await gitText(ports, root, ["config", "--type=bool", "--get", "--default=true", "core.filemode"]) === "false") {
    for (const mode of ["100644", "100755"]) {
      const selected = mismatch.filter(entry => original.get(entry.path)?.mode === mode).map(entry => entry.path);
      if (selected.length) await git(ports, root, ["update-index", mode === "100755" ? "--chmod=+x" : "--chmod=-x", "-z", "--stdin"], { env, stdin: Buffer.from(`${selected.join("\0")}\0`) });
    }
  }
}
interface LfsPointer { hash: string; size: number }
function parseLfsPointer(bytes: Buffer): LfsPointer | null {
  const prefix = "version https://git-lfs.github.com/spec/v1\n";
  if (!bytes.subarray(0, prefix.length).equals(Buffer.from(prefix))) return null;
  const match = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n(?:ext-[^\n]+\n)*oid sha256:([0-9a-f]{64})\nsize (0|[1-9][0-9]*)\n$/.exec(bytes.toString("utf8"));
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error("invalid LFS pointer");
  return { hash: match[1], size: Number(match[2]) };
}
async function lfsPointers(ports: GitPorts, root: string, list: readonly Entry[]): Promise<Map<string, LfsPointer>> {
  const ids = [...new Set(list.filter(entry => entry.mode === "100644" || entry.mode === "100755").map(entry => entry.oid))];
  const pointers = new Map<string, LfsPointer>();
  // Read only small blobs that could be LFS pointers, in bounded batches.
  for (let start = 0; start < ids.length; start += 256) {
    const group = ids.slice(start, start + 256);
    const input = Buffer.from(`${group.join("\n")}\n`);
    const sizes = (await git(ports, root, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { stdin: input })).toString("ascii").trim().split("\n");
    if (sizes.length !== group.length) throw new Error("invalid Git object size response");
    const small: string[] = [];
    for (let i = 0; i < sizes.length; i++) {
      const match = /^([0-9a-f]+) blob ([0-9]+)$/.exec(sizes[i]);
      if (!match || match[1] !== group[i]) throw new Error("invalid Git object size response");
      if (Number(match[2]) <= 1024) small.push(group[i]);
    }
    if (!small.length) continue;
    const content = await git(ports, root, ["cat-file", "--batch"], { stdin: Buffer.from(`${small.join("\n")}\n`) });
    let offset = 0;
    for (const id of small) {
      const end = content.indexOf(10, offset);
      if (end < 0) throw new Error("invalid Git object response");
      const header = /^([0-9a-f]+) blob ([0-9]+)$/.exec(content.subarray(offset, end).toString("ascii"));
      if (!header || header[1] !== id) throw new Error("invalid Git object response");
      const size = Number(header[2]);
      const first = end + 1, last = first + size;
      if (last >= content.length || content[last] !== 10) throw new Error("invalid Git object response");
      const pointer = parseLfsPointer(content.subarray(first, last));
      if (pointer) pointers.set(id, pointer);
      offset = last + 1;
    }
    if (offset !== content.length) throw new Error("invalid Git object response");
  }
  return pointers;
}
async function filterAttributes(ports: GitPorts, root: string, list: readonly Entry[], env: Readonly<NodeJS.ProcessEnv>, cached: boolean): Promise<Map<string, string>> {
  const paths = list.filter(entry => entry.mode === "100644" || entry.mode === "100755").map(entry => entry.path);
  if (!paths.length) return new Map();
  const args = ["check-attr", "-z", ...(cached ? ["--cached"] : []), "--stdin", "filter"];
  const output = nulFields(await git(ports, root, args, { env, stdin: Buffer.from(`${paths.join("\0")}\0`) }));
  if (output.length !== paths.length * 3) throw new Error("invalid Git attributes response");
  const result = new Map<string, string>();
  for (let i = 0; i < output.length; i += 3) {
    if (output[i] !== paths[i / 3] || output[i + 1] !== "filter") throw new Error("invalid Git attributes response");
    result.set(output[i], output[i + 2]);
  }
  return result;
}
async function fileDigest(file: string): Promise<{ hash: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    const bytes = chunk as Buffer;
    hash.update(bytes); size += bytes.length;
  }
  return { hash: hash.digest("hex"), size };
}
async function validateLfs(ports: GitPorts, root: string, list: readonly Entry[], env: Readonly<NodeJS.ProcessEnv>, cached: boolean, working: boolean): Promise<{ paths: Set<string>; filters: Map<string, string> }> {
  const pointers = await lfsPointers(ports, root, list);
  const attributes = await filterAttributes(ports, root, list, env, cached);
  const actual = new Set<string>();
  let storage: string | null = null;
  const verified = new Map<string, number>();
  for (const entry of list) {
    const pointer = pointers.get(entry.oid);
    if (!pointer && attributes.get(entry.path) !== "lfs") continue;
    if (!pointer || attributes.get(entry.path) !== "lfs") throw new Error(`LFS content or attributes are invalid: ${entry.path}`);
    actual.add(entry.path);
    if (storage === null) {
      const configured = await gitText(ports, root, ["config", "--path", "--get", "--default=", "lfs.storage"]);
      storage = configured ? resolve(root, configured, "objects") : join(resolve(root, await gitText(ports, root, ["rev-parse", "--git-common-dir"])), "lfs", "objects");
    }
    const verifiedSize = verified.get(pointer.hash);
    if (verifiedSize !== undefined && verifiedSize !== pointer.size) throw new Error(`LFS pointer size conflicts: ${entry.path}`);
    if (verifiedSize === undefined) {
      const object = join(storage, pointer.hash.slice(0, 2), pointer.hash.slice(2, 4), pointer.hash);
      let info;
      try { info = await lstat(object); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`LFS object is missing: ${entry.path}`);
        throw error;
      }
      if (!info.isFile()) throw new Error(`LFS object is not a regular file: ${entry.path}`);
      const digest = await fileDigest(object);
      if (digest.hash !== pointer.hash || digest.size !== pointer.size) throw new Error(`LFS object is corrupt: ${entry.path}`);
      verified.set(pointer.hash, pointer.size);
    }
    if (working) {
      const file = join(root, ...entry.path.split("/"));
      if (!(await present(file))) continue;
      const info = await lstat(file);
      if (!info.isFile()) throw new Error(`LFS file is not materialized: ${entry.path}`);
      const digest = await fileDigest(file);
      if (digest.hash !== pointer.hash || digest.size !== pointer.size) throw new Error(`LFS file is not materialized: ${entry.path}`);
    }
  }
  return { paths: actual, filters: attributes };
}
async function trackedEolPins(ports: GitPorts, root: string, privateDir: string, format: "sha1" | "sha256", index: string, source: readonly Entry[], working: readonly Entry[], paths: readonly string[]): Promise<Map<string, string>> {
  const isAttributes = (path: string) => path === ".gitattributes" || path.endsWith("/.gitattributes");
  const tracked = new Set(source.filter(entry => isAttributes(entry.path)).map(entry => entry.path));
  if (!tracked.size) return new Map(paths.map(path => [path, "unspecified"]));
  const untracked = working.filter(entry => isAttributes(entry.path) && !tracked.has(entry.path)).map(entry => entry.path);
  let attributesIndex = index;
  if (untracked.length) {
    attributesIndex = join(privateDir, "attributes-index");
    await copyFile(index, attributesIndex);
    await git(ports, root, ["update-index", "--force-remove", "-z", "--stdin"], {
      env: { GIT_INDEX_FILE: attributesIndex }, stdin: Buffer.from(`${untracked.join("\0")}\0`),
    });
  }
  const gitDir = join(privateDir, "attributes.git");
  const isolated = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_ATTR_NOSYSTEM: "1" };
  await git(ports, root, ["init", "--bare", "--quiet", `--object-format=${format}`, "--template=", gitDir], { env: isolated });
  const objects = await gitPath(ports, root, "objects");
  const env = { ...isolated, GIT_DIR: gitDir, GIT_WORK_TREE: root, GIT_INDEX_FILE: attributesIndex, GIT_OBJECT_DIRECTORY: objects };
  const fields = nulFields(await git(ports, root, ["check-attr", "--cached", "-z", "--stdin", "eol"], { env, stdin: Buffer.from(`${paths.join("\0")}\0`) }));
  if (fields.length !== paths.length * 3) throw new Error("invalid tracked EOL attributes response");
  const result = new Map<string, string>();
  for (let i = 0; i < fields.length; i += 3) {
    if (fields[i] !== paths[i / 3] || fields[i + 1] !== "eol") throw new Error("invalid tracked EOL attributes response");
    result.set(fields[i], fields[i + 2]);
  }
  return result;
}
async function effectiveEol(ports: GitPorts, root: string, paths: readonly string[], env: Readonly<NodeJS.ProcessEnv>): Promise<Map<string, string>> {
  const fields = nulFields(await git(ports, root, ["check-attr", "-z", "--stdin", "eol"], { env, stdin: Buffer.from(`${paths.join("\0")}\0`) }));
  if (fields.length !== paths.length * 3) throw new Error("invalid effective EOL attributes response");
  const result = new Map<string, string>();
  for (let i = 0; i < fields.length; i += 3) {
    if (fields[i] !== paths[i / 3] || fields[i + 1] !== "eol") throw new Error("invalid effective EOL attributes response");
    result.set(fields[i], fields[i + 2]);
  }
  return result;
}
async function validateRoundTrips(ports: GitPorts, root: string, privateDir: string, format: "sha1" | "sha256", head: string, indexTree: string, workingTree: string, source: readonly Entry[], list: readonly Entry[], lfs: { paths: ReadonlySet<string>; filters: ReadonlyMap<string, string> }, env: { GIT_INDEX_FILE: string }): Promise<void> {
  const changed = new Set<string>();
  for (const base of [head, indexTree]) {
    for (const path of nulFields(await git(ports, root, ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", base, workingTree], { env }))) changed.add(path);
  }
  const attributeRoots = [...changed].filter(path => path === ".gitattributes" || path.endsWith("/.gitattributes"))
    .map(path => path.slice(0, -".gitattributes".length));
  const custom: string[] = [], normalized: string[] = [];
  let changedByFilters: string | null = null;
  let filterFailure: Error | null = null;
  for (const entry of list) {
    if ((!changed.has(entry.path) && !attributeRoots.some(prefix => entry.path.startsWith(prefix)))
      || lfs.paths.has(entry.path) || (entry.mode !== "100644" && entry.mode !== "100755")) continue;
    const file = join(root, ...entry.path.split("/"));
    if (!(await present(file))) continue;
    const bytes = await readFile(file);
    const filter = lfs.filters.get(entry.path);
    if (changed.has(entry.path)) {
      const rawOid = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (rawOid !== entry.oid) {
        if (filter && filter !== "unspecified" && filter !== "unset") { custom.push(entry.path); continue; }
        normalized.push(entry.path);
      }
    }
    try {
      const restored = await git(ports, root, ["cat-file", "--filters", `--path=${entry.path}`, entry.oid], { env });
      if (!bytes.equals(restored) && changedByFilters === null) changedByFilters = entry.path;
    } catch (error) {
      if (filterFailure === null) filterFailure = error as Error;
    }
  }
  if (custom.length) throw new Error(`custom-filtered files cannot move: ${custom.map(path => JSON.stringify(path)).join(", ")}. Commit or stash these files first.`);
  if (normalized.length) {
    const pins = await trackedEolPins(ports, root, privateDir, format, env.GIT_INDEX_FILE, source, list, normalized);
    const effective = await effectiveEol(ports, root, normalized, env);
    const unpinned = normalized.filter(path => !["lf", "crlf"].includes(pins.get(path) ?? "") || pins.get(path) !== effective.get(path));
    if (unpinned.length) throw new Error(`normalized files lack a tracked EOL pin: ${unpinned.map(path => JSON.stringify(path)).join(", ")}. Commit these files first.`);
  }
  if (filterFailure) throw filterFailure;
  if (changedByFilters !== null) throw new Error(`filter or normalization changes file bytes: ${changedByFilters}`);
}
async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function checkOperation(gitDir: string): Promise<void> {
  for (const [path, reason] of [["MERGE_HEAD", "merge"], ["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["REBASE_HEAD", "rebase"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["sequencer", "sequencer"]]) {
    if (await present(join(gitDir, path))) throw new Error(`${reason} in progress`);
  }
}
async function checkFileTypes(ports: GitPorts, root: string, env: Readonly<NodeJS.ProcessEnv>): Promise<void> {
  const ignored = new Set(nulFields(await git(ports, root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { env })));
  const special: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || localState(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignored.has(`${path}/`)) await walk(join(directory, entry.name), path);
      } else if (!entry.isFile() && !entry.isSymbolicLink()) special.push(path);
    }
  };
  await walk(root, "");
  if (!special.length) return;
  let excluded: Set<string>;
  try {
    excluded = new Set(nulFields(await git(ports, root, ["check-ignore", "-z", "--stdin"], { env, stdin: Buffer.from(`${special.join("\0")}\0`) })));
  } catch {
    // No matches and an unreadable ignore configuration both fail closed.
    throw new Error(`unsupported file type: ${special[0]}`);
  }
  const unsupported = special.find(path => !excluded.has(path));
  if (unsupported) throw new Error(`unsupported file type: ${unsupported}`);
}

async function publishRefs(ports: GitPorts, root: string, refs: readonly string[], commits: readonly string[]): Promise<void> {
  const existing = async (): Promise<Map<string, string>> => {
    const output = await gitText(ports, root, ["for-each-ref", "--format=%(refname) %(objectname)", ...refs]);
    const result = new Map<string, string>();
    for (const line of output.split("\n")) {
      const split = line.indexOf(" ");
      if (split !== -1) result.set(line.slice(0, split), line.slice(split + 1));
    }
    return result;
  };
  const current = await existing();
  const creates: string[] = [];
  for (let i = 0; i < refs.length; i++) {
    const previous = current.get(refs[i]);
    if (previous && previous !== commits[i]) throw new Error(`snapshot ref already exists: ${refs[i]}`);
    if (!previous) creates.push(`create ${refs[i]} ${commits[i]}`);
  }
  if (creates.length === 0) return;
  try {
    await git(ports, root, ["update-ref", "--stdin"], { stdin: Buffer.from(`${creates.join("\n")}\n`) });
  } catch (error) {
    const after = await existing();
    if (!refs.every((ref, i) => after.get(ref) === commits[i])) throw error;
  }
}

export async function snapshotWorkspace(input: SnapshotInput, ports: GitPorts): Promise<WorkspaceSnapshot> {
  if (input.writers.length) throw new Error(`workspace writers are active: ${input.writers.map(writer => writer.id).join(", ")}`);
  if (input.stage !== "pre" && input.stage !== "final") throw new Error("invalid snapshot stage");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.moveId) || input.moveId.includes("..") || input.moveId.endsWith(".") || input.moveId.endsWith(".lock")) {
    throw new Error("invalid move ID for snapshot refs");
  }
  const root = await realpath(input.root);
  const cwd = await realpath(input.cwd);
  if (!inside(root, cwd)) throw new Error("workspace cwd is outside the root");
  const gitRoot = await realpath(await gitText(ports, root, ["rev-parse", "--show-toplevel"]));
  if (gitRoot !== root) throw new Error("workspace root does not match Git root");
  const gitDir = dirname(await gitPath(ports, root, "MERGE_HEAD"));
  await checkOperation(gitDir);
  const head = await gitText(ports, root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const symbolic = await gitText(ports, root, ["rev-parse", "--symbolic-full-name", "HEAD"]);
  const branch = symbolic === "HEAD" ? null : symbolic;
  const format = await gitText(ports, root, ["rev-parse", "--show-object-format"]);
  if (format !== "sha1" && format !== "sha256") throw new Error("unsupported Git object format");
  const normalization = { autocrlf: await optionalGitConfig(ports, root, "core.autocrlf"), eol: await optionalGitConfig(ports, root, "core.eol") };
  const sparse = await sparseGitConfig(ports, root);
  const sourceIndex = await gitPath(ports, root, "index");
  const sparsePatterns = await optionalText(join(gitDir, "info", "sparse-checkout"));
  const configPath = join(gitDir, "config.worktree");
  await mkdir(ports.scratch, { recursive: true, mode: 0o700 });
  const privateDir = await mkdtemp(join(ports.scratch, "workspace-"));
  try {
    const index = join(privateDir, "index"), working = join(privateDir, "working-index");
    const { config: worktreeConfig, dropped: droppedConfigKeys } = await filteredWorktreeConfig(ports, root, configPath, privateDir);
    const sourceIndexTime = await stat(sourceIndex);
    const sourceIndexBytes = await readFile(sourceIndex);
    await copyFile(sourceIndex, index); await chmod(index, 0o600);
    if (!sourceIndexBytes.equals(await readFile(index))) throw new Error("source index changed during snapshot");
    const indexEnv = { GIT_INDEX_FILE: index };
    const indexEntries = entries(await git(ports, root, ["ls-files", "--stage", "-z"], { env: indexEnv }), false);
    await validateEntries(ports, root, indexEntries);
    await validateEntries(ports, root, entries(await git(ports, root, ["ls-tree", "-r", "-z", head]), true));
    await checkFileTypes(ports, root, indexEnv);
    await validateLfs(ports, root, indexEntries, indexEnv, true, false);
    const indexTree = await gitText(ports, root, ["write-tree"], { env: indexEnv });
    await copyFile(index, working); await chmod(working, 0o600);
    let env = { GIT_INDEX_FILE: working };
    const materialized = await clearAssumedFlags(ports, root, env);
    // A fresh copy's mtime hides Git's racy-index entries. Make it older than
    // the source index so Git checks their bytes instead of trusting their stat cache.
    await utimes(working, sourceIndexTime.atime, new Date(sourceIndexTime.mtimeMs - 1000));
    const exclusions = [":(exclude,glob)**/.spider", ":(exclude,glob)**/.spider/**", ":(exclude,glob)**/.pi-subagents", ":(exclude,glob)**/.pi-subagents/**"];
    const realPrivateDir = await realpath(privateDir);
    if (inside(root, realPrivateDir)) exclusions.push(`:(top,exclude,literal)${relative(root, realPrivateDir).split(sep).join("/")}`);
    await git(ports, root, ["add", "--sparse", "-A", "--", ".", ...exclusions], { env });
    if (materialized.length) {
      // Keep sparse flags on the working index and restage only present paths in an overlay.
      const overlay = join(privateDir, "materialized-index");
      await copyFile(working, overlay); await chmod(overlay, 0o600);
      env = { GIT_INDEX_FILE: overlay };
      await overlayMaterialized(ports, root, env, indexEntries, materialized, exclusions);
    }
    const workingEntries = entries(await git(ports, root, ["ls-files", "--stage", "-z"], { env }), false);
    await validateEntries(ports, root, workingEntries);
    await validateWorkingLinks(root, workingEntries);
    const workingLfs = await validateLfs(ports, root, workingEntries, env, false, true);
    const workingTree = await gitText(ports, root, ["write-tree"], { env });
    await validateRoundTrips(ports, root, privateDir, format, head, indexTree, workingTree, indexEntries, workingEntries, workingLfs, env);
    const indexCommit = await gitText(ports, root, ["commit-tree", indexTree, "-p", head, "-m", "Spider roaming index snapshot"], { env: PRIVATE_IDENTITY });
    const workingCommit = await gitText(ports, root, ["commit-tree", workingTree, "-p", indexCommit, "-m", "Spider roaming working snapshot"], { env: PRIVATE_IDENTITY });
    const refs = [`refs/spider-roam/${input.moveId}/${input.stage}/index`, `refs/spider-roam/${input.moveId}/${input.stage}/working`];
    if (!sourceIndexBytes.equals(await readFile(sourceIndex))) throw new Error("source index changed during snapshot");
    if (await gitText(ports, root, ["rev-parse", "--verify", "HEAD^{commit}"]) !== head
      || await gitText(ports, root, ["rev-parse", "--symbolic-full-name", "HEAD"]) !== symbolic) throw new Error("source HEAD changed during snapshot");
    if (await optionalGitConfig(ports, root, "core.autocrlf") !== normalization.autocrlf
      || await optionalGitConfig(ports, root, "core.eol") !== normalization.eol) throw new Error("source Git normalization changed during snapshot");
    const sparseAfter = await sparseGitConfig(ports, root);
    if (sparse.enabled !== sparseAfter.enabled || sparse.cone !== sparseAfter.cone) throw new Error("source Git sparse configuration changed during snapshot");
    if (await optionalText(join(gitDir, "info", "sparse-checkout")) !== sparsePatterns) throw new Error("source sparse patterns changed during snapshot");
    await checkOperation(gitDir);
    recordMoveSnapshotRefs(root, input.moveId, [{ ref: refs[0], oid: indexCommit }, { ref: refs[1], oid: workingCommit }], ports);
    await publishRefs(ports, root, refs, [indexCommit, workingCommit]);
    return {
      root, repoKey: input.repoKey, workspaceId: input.workspaceId, moveId: input.moveId, stage: input.stage,
      head, branch, objectFormat: format, indexTree, workingTree, relativeCwd: relative(root, cwd),
      sparsePatterns, worktreeConfig, droppedConfigKeys, normalization, sparse, refs, prerequisites: [], bundle: { kind: "unbundled" },
    };
  } finally { await rm(privateDir, { recursive: true, force: true }); }
}

export function recordMoveSnapshotRefs(root: string, moveId: string, refs: readonly { ref: string; oid: string }[], ports: GitPorts): void {
  const prior = ports.journal.read(moveId).filter(row => row.action === "workspace-snapshot-refs" && row.result.root === root).flatMap(row => row.result.refs as unknown as { ref: string; oid: string }[]);
  if (refs.some(row => prior.some(saved => saved.ref === row.ref && saved.oid !== row.oid))) throw new Error("workspace-ref-conflict");
  if (refs.some(row => !prior.some(saved => saved.ref === row.ref))) ports.journal.record(moveId, "workspace-snapshot-refs", { root, refs: [...refs] });
}

export interface MoveRefCleanupResult {
  removed: readonly string[];
  leftovers: readonly { ref: string; reason: "move-ref-cleanup-pending" | "move-ref-cleanup-changed" | "move-ref-cleanup-unproved"; retryable: true }[];
}
/** Remove only recorded move snapshot refs. A user's Git locks and replaced refs always win. */
export async function cleanupMoveRefs(root: string, moveId: string, ports: GitPorts, canClean: () => boolean): Promise<MoveRefCleanupResult> {
  if (!isAbsolute(root) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(moveId) || moveId.includes("..") || moveId.endsWith(".lock") || !canClean()) throw new Error("move-cleanup-unproved");
  const prefix = `refs/spider-roam/${moveId}/`, allowed = new Set(["pre", "final"].flatMap(stage => ["index", "working"].map(kind => `${prefix}${stage}/${kind}`)));
  const read = async () => {
    const output = (await git(ports, root, ["for-each-ref", "--format=%(refname) %(objectname)", prefix])).toString().trim();
    const refs = output ? output.split("\n").map(line => { const [ref, oid, extra] = line.split(" "); if (!allowed.has(ref) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) || extra) throw new Error("move-cleanup-unproved"); return { ref, oid }; }) : [];
    return refs;
  };
  const recorded = ports.journal.read(moveId).filter(row => row.action === "workspace-snapshot-refs" && row.result.root === root).flatMap(row => row.result.refs as unknown as { ref: string; oid: string }[]);
  const refs = [...new Map(recorded.map(row => [row.ref, row])).values()];
  if (refs.some(row => !allowed.has(row.ref) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.oid) || recorded.some(other => other.ref === row.ref && other.oid !== row.oid))) throw new Error("move-cleanup-unproved");
  const removed: string[] = [], leftovers: MoveRefCleanupResult["leftovers"][number][] = (await read()).filter(row => !refs.some(saved => saved.ref === row.ref)).map(row => ({ ref: row.ref, reason: "move-ref-cleanup-unproved", retryable: true }));
  for (const { ref, oid } of refs) {
    let complete = false, changed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!canClean()) throw new Error("move-cleanup-unproved");
      try {
        await git(ports, root, ["-c", "core.packedRefsTimeout=0", "-c", "core.filesRefLockTimeout=0", "update-ref", "-d", ref, oid]);
        removed.push(ref); complete = true; break;
      } catch {
        const current = (await read()).find(row => row.ref === ref);
        if (!current) { complete = true; break; }
        if (current.oid !== oid) { changed = true; break; }
        if (attempt < 2) await retryDelay(10 * (attempt + 1));
      }
    }
    if (!complete) leftovers.push({ ref, reason: changed ? "move-ref-cleanup-changed" : "move-ref-cleanup-pending", retryable: true });
  }
  return { removed, leftovers };
}
