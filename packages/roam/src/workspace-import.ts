import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, createReadStream, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { devNull } from "node:os";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import type { PreparedWorkspace, RestoreAdjustment, WorkspaceImportPorts, WorkspaceSnapshot } from "./contracts";
import { bundleHeads, snapshotPrivateRefs, verifySnapshotObjects } from "./git-bundle";
import { artifactId, privateDirectory } from "./staging";
import { isUnsafeWorktreeConfig, recordMoveSnapshotRefs } from "./workspace";

type Trees = { head: string; indexTree: string; workingTree: string };
// A globbed dot keeps ignored directories from becoming explicit add inputs.
const localMetadataPathspecs = ["spider", "pi-subagents"].flatMap(name => [
  `:(top,exclude,glob)[.]${name}`, `:(top,exclude,glob)[.]${name}/**`,
]);

function checkPath(path: string, kind: "directory" | "file", allowMissing = false): boolean {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("workspace-path-unsafe");
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(current); }
    catch (error) {
      if (allowMissing && current === path && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error("workspace-path-missing");
    }
    if (stat.isSymbolicLink() || current !== path && !stat.isDirectory()) throw new Error("workspace-path-unsafe");
    if (current === path) {
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if ((kind === "directory" ? !stat.isDirectory() : !stat.isFile()) ||
          (process.platform !== "win32" && uid !== undefined && stat.uid !== uid)) throw new Error("workspace-path-unsafe");
      if (kind === "file" && process.platform !== "win32" && (stat.mode & 0o7777) !== 0o600) throw new Error("workspace-artifact-unsafe");
    }
  }
  return true;
}

function validSparse(value: unknown): value is WorkspaceSnapshot["sparse"] {
  if (!value || typeof value !== "object") return false;
  const sparse = value as { enabled?: unknown; cone?: unknown };
  return typeof sparse.enabled === "boolean" && (sparse.cone === null || typeof sparse.cone === "boolean");
}

function validateSnapshot(snapshot: WorkspaceSnapshot): void {
  if (!snapshot || snapshot.bundle?.kind !== "ready") throw new Error("workspace-unbundled: create and transfer a verified bundle first");
  artifactId(snapshot.bundle.artifactId);
  snapshotPrivateRefs(snapshot);
  if (!Number.isSafeInteger(snapshot.bundle.byteLength) || snapshot.bundle.byteLength < 1 ||
      !snapshot.repoKey || !snapshot.workspaceId || !snapshot.moveId ||
      (snapshot.stage !== "pre" && snapshot.stage !== "final") || !snapshot.normalization ||
      !(snapshot.normalization.autocrlf === null || typeof snapshot.normalization.autocrlf === "string") ||
      !(snapshot.normalization.eol === null || typeof snapshot.normalization.eol === "string") ||
      !(snapshot.worktreeConfig === null || typeof snapshot.worktreeConfig === "string" && !snapshot.worktreeConfig.includes("\0")) ||
      !(snapshot.sparsePatterns === null || typeof snapshot.sparsePatterns === "string" && !snapshot.sparsePatterns.includes("\0"))) throw new Error("workspace-snapshot-invalid");
  const oid = snapshot.objectFormat === "sha1" ? /^[a-f0-9]{40}$/ : snapshot.objectFormat === "sha256" ? /^[a-f0-9]{64}$/ : null;
  if (!oid || ![snapshot.head, snapshot.indexTree, snapshot.workingTree, ...snapshot.prerequisites].every(value => oid.test(value))) {
    throw new Error("workspace-snapshot-invalid");
  }
  if (isAbsolute(snapshot.relativeCwd) || snapshot.relativeCwd.split(/[\\/]/).includes("..")) throw new Error("workspace-cwd-unsafe");
}

async function git(ports: WorkspaceImportPorts, cwd: string, argv: readonly string[], index?: string, stdin?: Buffer): Promise<Buffer> {
  const options = index || stdin ? { ...(index ? { env: { GIT_INDEX_FILE: index } } : {}), ...(stdin ? { stdin } : {}) } : undefined;
  return ports.run(cwd, ["git", ...argv], options);
}
function text(bytes: Buffer): string { return bytes.toString("utf8").trim(); }

async function assertCheckoutRoot(root: string, ports: WorkspaceImportPorts): Promise<void> {
  let top: string;
  try { top = text(await git(ports, root, ["rev-parse", "--path-format=absolute", "--show-toplevel"])); }
  catch { throw new Error("workspace-checkout-root-mismatch"); }
  if (realpathSync(top) !== realpathSync(root)) throw new Error("workspace-checkout-root-mismatch");
}

// Move composition takes session ownership locks first. Public workspace operations acquire this lock themselves;
// callers must not hold it already. Locked operations call internal helpers instead of re-entering the lock.
async function withCheckoutLock<T>(destination: string, repository: string, ports: WorkspaceImportPorts,
  work: (common: string) => Promise<T>): Promise<T> {
  checkPath(repository, "directory");
  checkPath(dirname(destination), "directory");
  const exists = checkPath(destination, "directory", true);
  const canonical = exists ? realpathSync(destination) : join(realpathSync(dirname(destination)), basename(destination));
  const key = process.platform === "darwin" ? canonical.normalize("NFC").toLowerCase() : canonical;
  const common = text(await git(ports, repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  checkPath(common, "directory");
  const realCommon = realpathSync(common), lockRoot = join(realCommon, "spider-roam");
  privateDirectory(lockRoot);
  return withProcessLock(lockRoot, `checkout:${key}`, async () => {
    const currentCommon = text(await git(ports, repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    if (realpathSync(currentCommon) !== realCommon) throw new Error("workspace-repository-mismatch");
    const currentExists = checkPath(destination, "directory", true);
    const currentPath = currentExists ? realpathSync(destination) : join(realpathSync(dirname(destination)), basename(destination));
    const currentKey = process.platform === "darwin" ? currentPath.normalize("NFC").toLowerCase() : currentPath;
    if (currentKey !== key) throw new Error("workspace-checkout-root-mismatch");
    return work(realCommon);
  }, { reclaimReusedOwner: true });
}

async function withObjectQuarantine<T>(root: string, ports: WorkspaceImportPorts, inspect: (quarantine: WorkspaceImportPorts) => Promise<T>): Promise<T> {
  const alternate = text(await git(ports, root, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]));
  checkPath(alternate, "directory");
  privateDirectory(ports.scratch);
  const directory = mkdtempSync(join(ports.scratch, ".workspace-objects-"));
  const objects = join(directory, "objects");
  mkdirSync(objects, { mode: 0o700 });
  mkdirSync(join(objects, "pack"), { mode: 0o700 });
  mkdirSync(join(objects, "info"), { mode: 0o700 });
  const alternates = alternate.includes(":") || alternate.startsWith('"') ? JSON.stringify(alternate) : alternate;
  const quarantine: WorkspaceImportPorts = {
    ...ports,
    run(cwd, argv, options) {
      return ports.run(cwd, argv, { ...options, env: { ...options?.env,
        GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates } });
    },
  };
  try { return await inspect(quarantine); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

async function inspectTrees(root: string, ports: WorkspaceImportPorts): Promise<Trees> {
  const head = text(await git(ports, root, ["rev-parse", "--verify", "HEAD"]));
  const sourceIndex = text(await git(ports, root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
  const stat = lstatSync(sourceIndex);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("workspace-index-unsafe");
  return withObjectQuarantine(root, ports, async quarantine => {
    const directory = mkdtempSync(join(ports.scratch, ".workspace-inspect-"));
    const index = join(directory, "index");
    try {
      copyFileSync(sourceIndex, index);
      chmodSync(index, 0o600);
      const indexTree = text(await git(quarantine, root, ["write-tree"], index));
      copyFileSync(sourceIndex, index);
      const entries = nulFields(await git(quarantine, root, ["ls-files", "-v", "-z"], index));
      const assumed = entries.filter(entry => entry.length > 2 && entry[0] >= 97 && entry[0] <= 122 && entry[1] === 32)
        .map(entry => entry.subarray(2));
      if (assumed.length) {
        const stdin = Buffer.concat(assumed.flatMap(path => [path, Buffer.from([0])]));
        await git(quarantine, root, ["update-index", "--no-assume-unchanged", "-z", "--stdin"], index, stdin);
      }
      chmodSync(index, 0o600);
      utimesSync(index, stat.atime, stat.mtime);
      await git(quarantine, root, ["-c", "core.fsmonitor=false", "-c", "core.trustctime=true", "-c", "core.checkStat=default",
        "add", "-A", "--", ".", ...localMetadataPathspecs], index);
      const workingTree = text(await git(quarantine, root, ["write-tree"], index));
      return { head, indexTree, workingTree };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

function assertTrees(actual: Trees, expected: WorkspaceSnapshot, prefix: string): void {
  const differences = [actual.head !== expected.head && "HEAD", actual.indexTree !== expected.indexTree && "index",
    actual.workingTree !== expected.workingTree && "working tree"].filter(Boolean);
  if (differences.length) throw new Error(`${prefix}: ${differences.join(", ")} differs`);
}

/** Git exits 1 for an index whose staged and working versions intentionally differ. */
async function refreshIndex(root: string, ports: WorkspaceImportPorts, index?: string): Promise<void> {
  try { await git(ports, root, ["update-index", "--refresh"], index); }
  catch (error) {
    if (!error || typeof error !== "object") throw new Error("workspace-index-refresh-failed");
    const detail = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
    if (detail.status !== 1 || !Buffer.isBuffer(detail.stdout) || !Buffer.isBuffer(detail.stderr) || detail.stderr.length) {
      throw new Error("workspace-index-refresh-failed");
    }
    const stdout = detail.stdout;
    const names = await git(ports, root, ["diff-files", "--name-only", "-z"], index);
    const parts: Buffer[] = [];
    let start = 0;
    for (let at = 0; at < names.length; at++) if (names[at] === 0) {
      parts.push(names.subarray(start, at), Buffer.from(": needs update\n"));
      start = at + 1;
    }
    if (!parts.length || start !== names.length || !Buffer.concat(parts).equals(stdout)) throw new Error("workspace-index-refresh-failed");
  }
}

async function validateWorktreeConfig(snapshot: WorkspaceSnapshot, ports: WorkspaceImportPorts): Promise<void> {
  if (snapshot.worktreeConfig === null) return;
  if (typeof snapshot.worktreeConfig !== "string") throw new Error("workspace-config-invalid");
  privateDirectory(ports.scratch);
  const directory = mkdtempSync(join(ports.scratch, ".workspace-config-"));
  const file = join(directory, "config");
  try {
    writeFileSync(file, snapshot.worktreeConfig, { flag: "wx", mode: 0o600 });
    let contents: Buffer;
    try { contents = await git(ports, ports.scratch, ["config", "--null", "--file", file, "--list"]); }
    catch { throw new Error("workspace-config-invalid"); }
    for (const entry of nulFields(contents)) {
      const separator = entry.indexOf(10);
      if (separator <= 0) throw new Error("workspace-config-invalid");
      if (isUnsafeWorktreeConfig(entry.subarray(0, separator).toString("utf8"), entry.subarray(separator + 1).toString("utf8"))) {
        throw new Error("workspace-config-unsafe: remove sensitive or executable worktree settings");
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function nulFields(bytes: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let at = 0; at < bytes.length; at++) if (bytes[at] === 0) {
    fields.push(bytes.subarray(start, at));
    start = at + 1;
  }
  if (start !== bytes.length) throw new Error("workspace-lfs-inspection-failed");
  return fields;
}

type LfsObject = { oid: string; size: number };
function parseLfsPointer(bytes: Buffer): LfsObject {
  const lines = bytes.toString("utf8").split("\n");
  if (lines[0] !== "version https://git-lfs.github.com/spec/v1" || lines.at(-1) !== "") throw new Error("workspace-lfs-pointer-invalid");
  let oid: string | null = null, size: number | null = null;
  for (const line of lines.slice(1, -1)) {
    const digest = /^oid sha256:([a-f0-9]{64})$/.exec(line);
    const length = /^size (0|[1-9][0-9]*)$/.exec(line);
    if (digest && oid === null) oid = digest[1];
    else if (length && size === null) size = Number(length[1]);
    else if (!/^ext-[0-9]+-[A-Za-z0-9.-]+ [^\r\n]+$/.test(line)) throw new Error("workspace-lfs-pointer-invalid");
  }
  if (oid === null || size === null || !Number.isSafeInteger(size)) throw new Error("workspace-lfs-pointer-invalid");
  return { oid, size };
}

async function verifyLfsFile(file: string, object: LfsObject): Promise<void> {
  if (!isAbsolute(file) || resolve(file) !== file) throw new Error("workspace-lfs-object-invalid");
  const root = parse(file).root;
  let current = root;
  for (const part of file.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("workspace-lfs-object-missing: install the LFS object on the destination");
      throw new Error("workspace-lfs-object-invalid");
    }
    if (stat.isSymbolicLink() || current !== file && !stat.isDirectory()) throw new Error("workspace-lfs-object-invalid");
  }
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new Error("workspace-lfs-object-invalid"); }
  try {
    const stat = fstatSync(fd), uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!stat.isFile() || stat.size !== object.size ||
        (process.platform !== "win32" && uid !== undefined && stat.uid !== uid)) throw new Error("workspace-lfs-object-invalid");
    const digest = createHash("sha256");
    try {
      for await (const chunk of createReadStream(file, { fd, autoClose: false })) digest.update(chunk as Buffer);
    } catch { throw new Error("workspace-lfs-object-invalid"); }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || digest.digest("hex") !== object.oid) {
      throw new Error("workspace-lfs-object-invalid");
    }
  } finally { closeSync(fd); }
}

/** Inspect Git attributes in each recorded tree and verify LFS content in the destination's object store. */
async function verifyLfs(snapshot: WorkspaceSnapshot, repository: string, common: string, ports: WorkspaceImportPorts): Promise<void> {
  privateDirectory(ports.scratch);
  const directory = mkdtempSync(join(ports.scratch, ".workspace-lfs-"));
  const index = join(directory, "index"), objects = new Map<string, number>();
  try {
    for (const tree of new Set([snapshot.head, snapshot.indexTree, snapshot.workingTree])) {
      await git(ports, repository, ["read-tree", tree], index);
      chmodSync(index, 0o600);
      const entries: { oid: string; size: number; path: Buffer }[] = [];
      for (const entry of nulFields(await git(ports, repository, ["ls-tree", "-r", "-l", "-z", "--full-tree", tree]))) {
        const tab = entry.indexOf(9);
        if (tab < 0) throw new Error("workspace-lfs-inspection-failed");
        const header = entry.subarray(0, tab).toString("ascii");
        const match = /^(100644|100755) blob ([a-f0-9]{40,64}) +([0-9]+)$/.exec(header);
        if (match) entries.push({ oid: match[2], size: Number(match[3]), path: entry.subarray(tab + 1) });
      }
      for (let offset = 0; offset < entries.length; offset += 128) {
        const batch = entries.slice(offset, offset + 128);
        const input = Buffer.concat(batch.flatMap(entry => [entry.path, Buffer.from([0])]));
        const attributes = nulFields(await git(ports, repository, ["check-attr", "--cached", "-z", "--stdin", "filter"], index, input));
        if (attributes.length !== batch.length * 3) throw new Error("workspace-lfs-inspection-failed");
        for (let position = 0; position < batch.length; position++) {
          const entry = batch[position], field = position * 3;
          if (!attributes[field].equals(entry.path) || attributes[field + 1].toString("utf8") !== "filter") {
            throw new Error("workspace-lfs-inspection-failed");
          }
          if (attributes[field + 2].toString("utf8") !== "lfs") continue;
          if (!Number.isSafeInteger(entry.size) || entry.size > 1024) throw new Error("workspace-lfs-pointer-invalid");
          const object = parseLfsPointer(await git(ports, repository, ["cat-file", "blob", entry.oid]));
          const previous = objects.get(object.oid);
          if (previous !== undefined && previous !== object.size) throw new Error("workspace-lfs-pointer-invalid");
          objects.set(object.oid, object.size);
        }
      }
    }
    if (!objects.size) return;
    let storage = join(common, "lfs");
    const missing = "__spider_roam_missing_lfs_storage__";
    let configured: string;
    try { configured = text(await git(ports, repository, ["config", "--path", "--get", `--default=${missing}`, "lfs.storage"])); }
    catch { throw new Error("workspace-lfs-storage-invalid"); }
    if (!configured) throw new Error("workspace-lfs-storage-invalid");
    if (configured !== missing) storage = isAbsolute(configured) ? resolve(configured) : resolve(common, configured);
    for (const [oid, size] of objects) {
      await verifyLfsFile(join(storage, "objects", oid.slice(0, 2), oid.slice(2, 4), oid), { oid, size });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function displayedPath(path: Buffer): string {
  const decoded = path.toString("utf8");
  return Buffer.from(decoded).equals(path) ? JSON.stringify(decoded) : `bytes:${path.toString("hex")}`;
}

async function guardAddedPaths(root: string, before: string, after: string, ports: WorkspaceImportPorts): Promise<void> {
  const fields = nulFields(await git(ports, root, ["diff-tree", "--name-status", "--no-renames", "-r", "-z", "--diff-filter=AMT", before, after]));
  if (fields.length % 2 !== 0) throw new Error("workspace-snapshot-invalid");
  const conflicts = new Set<string>();
  let more = false;
  const add = (path: Buffer): void => {
    const label = displayedPath(path);
    if (conflicts.has(label)) return;
    if (conflicts.size < 20) conflicts.add(label); else more = true;
  };
  for (let field = 0; field < fields.length; field += 2) {
    const status = fields[field].toString("ascii"), relative = fields[field + 1];
    if (!["A", "M", "T"].includes(status)) throw new Error("workspace-snapshot-invalid");
    const components: Buffer[] = [];
    let start = 0;
    for (let at = 0; at <= relative.length; at++) if (at === relative.length || relative[at] === 47) {
      const component = relative.subarray(start, at);
      if (!component.length || component.equals(Buffer.from(".")) || component.equals(Buffer.from(".."))) throw new Error("workspace-snapshot-invalid");
      components.push(component); start = at + 1;
    }
    let current = Buffer.from(`${root}${sep}`);
    for (let index = 0; index < components.length; index++) {
      current = Buffer.concat([current, index ? Buffer.from(sep) : Buffer.alloc(0), components[index]]);
      let stat: ReturnType<typeof lstatSync>;
      try { stat = lstatSync(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") add(relative);
        break;
      }
      if (index < components.length - 1) {
        if (stat.isSymbolicLink() || !stat.isDirectory()) { add(relative); break; }
      } else if (status === "A") {
        if (!stat.isDirectory()) { add(relative); break; }
        const name = relative.toString("utf8");
        if (!Buffer.from(name).equals(relative)) { add(relative); break; }
        const literal = `:(literal)${name}`;
        const tracked = await git(ports, root, ["ls-tree", "-r", "-z", before, "--", literal]);
        if (!tracked.length) { add(relative); break; }
        const ordinary = await git(ports, root, ["ls-files", "--others", "--exclude-standard", "-z", "--", literal]);
        const ignored = await git(ports, root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", literal]);
        for (const path of [...nulFields(ordinary), ...nulFields(ignored)]) add(path);
      } else if (stat.isDirectory()) {
        add(relative);
      } else if (stat.isSymbolicLink()) {
        const name = relative.toString("utf8");
        if (!Buffer.from(name).equals(relative)) { add(relative); break; }
        const tracked = await git(ports, root, ["ls-tree", "-z", before, "--", `:(literal)${name}`]);
        if (!tracked.subarray(0, 7).equals(Buffer.from("120000 "))) add(relative);
      }
    }
  }
  if (conflicts.size) throw new Error(`workspace-apply-refused: conflicting paths ${[...conflicts].join(", ")}${more ? ", and more" : ""}`);
}

async function nonConeIncluded(root: string, patterns: string, paths: readonly Buffer[], ports: WorkspaceImportPorts): Promise<Set<string>> {
  privateDirectory(ports.scratch);
  const directory = mkdtempSync(join(ports.scratch, ".workspace-sparse-rules-")), rules = join(directory, "rules");
  try {
    writeFileSync(rules, patterns, { flag: "wx", mode: 0o600 });
    const stdin = Buffer.concat(paths.flatMap(path => [path, Buffer.from([0])]));
    let output: Buffer;
    try {
      output = await git(ports, root, ["-c", "core.sparseCheckout=true", "sparse-checkout", "check-rules", "--no-cone", `--rules-file=${rules}`, "-z"], undefined, stdin);
    } catch { throw new Error("workspace-sparse-inspection-unavailable: Git 2.41 or later is required for non-cone sparse rules"); }
    const available = new Set(paths.map(path => path.toString("hex"))), result = new Set<string>();
    for (const path of nulFields(output)) {
      const key = path.toString("hex");
      if (!available.has(key)) throw new Error("workspace-sparse-inspection-failed");
      result.add(key);
    }
    return result;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

type SparsePath = { path: Buffer; included: boolean };

/** Cone rules include a directory recursively, then optionally exclude its child directories. */
function coneTreePaths(patterns: string, paths: readonly Buffer[], ignoreCase: boolean): SparsePath[] | null {
  const fold = (value: string) => ignoreCase ? value.replace(/[A-Z]/g, character => character.toLowerCase()) : value;
  const rules: Array<{ prefix: string; childrenOnly: boolean; included: boolean }> = [];
  for (const pattern of patterns.split(/\r?\n/)) {
    if (!pattern || pattern.startsWith("#")) continue;
    if (pattern === "/*" || pattern === "!/*/") {
      rules.push({ prefix: "", childrenOnly: pattern === "!/*/", included: pattern === "/*" });
      continue;
    }
    const childrenOnly = pattern.startsWith("!/") && pattern.endsWith("/*/");
    if (!childrenOnly && !(pattern.startsWith("/") && pattern.endsWith("/"))) return null;
    const encoded = childrenOnly ? pattern.slice(2, -3) : pattern.slice(1, -1);
    let directory = "";
    for (let at = 0; at < encoded.length; at++) {
      const character = encoded[at];
      if (character === "\\") {
        if (++at === encoded.length) return null;
        directory += encoded[at];
      } else {
        if ("*?[".includes(character)) return null;
        directory += character;
      }
    }
    if (!directory) return null;
    // Compare bytes so an undecodable tree name cannot alias a different UTF-8 path.
    rules.push({ prefix: fold(Buffer.from(`${directory}/`).toString("latin1")), childrenOnly, included: !childrenOnly });
  }
  return paths.map(path => {
    const name = fold(path.toString("latin1")); let included = false;
    for (const rule of rules) if (name.startsWith(rule.prefix) && (!rule.childrenOnly || name.includes("/", rule.prefix.length))) included = rule.included;
    return { path, included };
  });
}

// Match patterns against tree paths without checking out blobs or trusting Git's index-only sparse bits.
async function sparseTreePaths(root: string, tree: string,
  view: Pick<WorkspaceSnapshot, "objectFormat" | "sparse" | "sparsePatterns">, ports: WorkspaceImportPorts): Promise<SparsePath[]> {
  if (view.sparsePatterns === null) throw new Error("workspace-config-invalid: sparsePatterns");
  const paths = nulFields(await git(ports, root, ["ls-tree", "--full-tree", "-r", "-z", "--name-only", tree]));
  if (view.sparse.cone === true) {
    const ignoreCase = text(await git(ports, root, ["config", "--type=bool", "--get", "--default=false", "core.ignoreCase"])) === "true";
    const cone = coneTreePaths(view.sparsePatterns, paths, ignoreCase);
    if (cone) return cone;
  }
  // Non-canonical patterns in a cone-configured checkout still need Git's full matcher.
  const included = new Set<string>();
  for (let start = 0; start < paths.length; start += 256)
    for (const path of await nonConeIncluded(root, view.sparsePatterns, paths.slice(start, start + 256), ports)) included.add(path);
  return paths.map(path => ({ path, included: included.has(path.toString("hex")) }));
}

async function guardSparseExpansion(root: string, before: WorkspaceSnapshot, after: WorkspaceSnapshot, ports: WorkspaceImportPorts): Promise<void> {
  if (!before.sparse.enabled || before.sparsePatterns === after.sparsePatterns && before.sparse.enabled === after.sparse.enabled &&
      before.sparse.cone === after.sparse.cone) return;
  if (before.sparsePatterns === null || after.sparse.enabled && after.sparsePatterns === null) throw new Error("workspace-config-invalid: sparsePatterns");
  const paths = nulFields(await git(ports, root, ["ls-tree", "--full-tree", "-r", "-z", "--name-only", after.workingTree]));
  if (!paths.length) return;
  const coneIncluded = async (patterns: string): Promise<Set<string>> => {
    const entries = await sparseTreePaths(root, after.workingTree, { ...after, sparse: { enabled: true, cone: true }, sparsePatterns: patterns }, ports);
    const available = new Set(paths.map(path => path.toString("hex"))), result = new Set<string>();
    for (const entry of entries) {
      const key = entry.path.toString("hex");
      if (!available.has(key)) throw new Error("workspace-sparse-inspection-failed");
      if (entry.included) result.add(key);
    }
    if (entries.length !== available.size) throw new Error("workspace-sparse-inspection-failed");
    return result;
  };
  const oldCone = before.sparse.cone === true ? await coneIncluded(before.sparsePatterns) : null;
  const targetCone = after.sparse.enabled && after.sparse.cone === true ? await coneIncluded(after.sparsePatterns!) : null;
  const conflicts = new Set<string>(); let more = false;
  for (let start = 0; start < paths.length && !more; start += 256) {
    const batch = paths.slice(start, start + 256);
    const oldIncluded = oldCone ?? await nonConeIncluded(root, before.sparsePatterns, batch, ports);
    const targetIncluded = !after.sparse.enabled ? new Set(batch.map(path => path.toString("hex"))) :
      targetCone ?? await nonConeIncluded(root, after.sparsePatterns!, batch, ports);
    for (const relative of batch) {
      const key = relative.toString("hex");
      if (oldIncluded.has(key) || !targetIncluded.has(key)) continue;
      const components: Buffer[] = []; let begin = 0;
      for (let at = 0; at <= relative.length; at++) if (at === relative.length || relative[at] === 47) {
        const component = relative.subarray(begin, at);
        if (!component.length || component.equals(Buffer.from(".")) || component.equals(Buffer.from(".."))) throw new Error("workspace-snapshot-invalid");
        components.push(component); begin = at + 1;
      }
      let current = Buffer.from(`${root}${sep}`), collision = false;
      for (let index = 0; index < components.length; index++) {
        current = Buffer.concat([current, index ? Buffer.from(sep) : Buffer.alloc(0), components[index]]);
        let stat: ReturnType<typeof lstatSync>;
        try { stat = lstatSync(current); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") collision = true; break; }
        if (index === components.length - 1 || stat.isSymbolicLink() || !stat.isDirectory()) { collision = true; break; }
      }
      if (collision) {
        const label = displayedPath(relative);
        if (!conflicts.has(label)) { if (conflicts.size < 20) conflicts.add(label); else more = true; }
      }
    }
  }
  if (conflicts.size) throw new Error(`workspace-apply-refused: conflicting paths ${[...conflicts].join(", ")}${more ? ", and more" : ""}`);
}

type PortableAttributes = { eol: string; text: string; crlf: string; filter: string };
function parseAttributes(bytes: Buffer, paths: readonly Buffer[]): Map<string, PortableAttributes> {
  const fields = nulFields(bytes), expected = new Set(paths.map(path => path.toString("hex")));
  if (fields.length % 3 !== 0) throw new Error("workspace-attributes-unavailable");
  const partial = new Map<string, Partial<PortableAttributes>>();
  for (let at = 0; at < fields.length; at += 3) {
    const path = fields[at].toString("hex"), name = fields[at + 1].toString("ascii"), value = fields[at + 2].toString("utf8");
    if (!expected.has(path) || (name !== "eol" && name !== "text" && name !== "crlf" && name !== "filter")) throw new Error("workspace-attributes-unavailable");
    const attrs = partial.get(path) ?? {};
    attrs[name] = value; partial.set(path, attrs);
  }
  const result = new Map<string, PortableAttributes>();
  for (const path of expected) {
    const attrs = partial.get(path);
    if (attrs?.eol === undefined || attrs.text === undefined || attrs.crlf === undefined || attrs.filter === undefined) throw new Error("workspace-attributes-unavailable");
    result.set(path, { eol: attrs.eol, text: attrs.text, crlf: attrs.crlf, filter: attrs.filter });
  }
  return result;
}

async function verifyNormalization(snapshot: WorkspaceSnapshot, base: WorkspaceSnapshot | null, repository: string, checkout: string, ports: WorkspaceImportPorts): Promise<void> {
  const missing = "__spider_roam_missing_normalization_value__";
  const readSetting = async (key: string): Promise<string | null> => {
    let value: string;
    try { value = text(await git(ports, checkout, ["config", "--get", `--default=${missing}`, key])); }
    catch { throw new Error("workspace-normalization-unavailable"); }
    return value === missing ? null : value;
  };
  const destination = { autocrlf: await readSetting("core.autocrlf"), eol: await readSetting("core.eol") };
  const normalizationDiffers = destination.autocrlf !== snapshot.normalization.autocrlf || destination.eol !== snapshot.normalization.eol;

  const headTree = text(await git(ports, repository, ["rev-parse", "--verify", `${snapshot.head}^{tree}`]));
  const pairs: [string, string][] = [[headTree, snapshot.indexTree], [headTree, snapshot.workingTree]];
  if (base) pairs.push([base.workingTree, snapshot.workingTree]);
  const changed = new Map<string, Buffer>(), checkoutPaths = new Set<string>();
  for (const [before, after] of pairs) {
    const fields = nulFields(await git(ports, repository, ["diff-tree", "--name-status", "--no-renames", "-r", "-z", "--diff-filter=AMTD", before, after]));
    if (fields.length % 2 !== 0) throw new Error("workspace-attributes-unavailable");
    for (let at = 0; at < fields.length; at += 2) {
      const status = fields[at].toString("ascii"), path = fields[at + 1], key = path.toString("hex");
      if (!["A", "M", "T", "D"].includes(status)) throw new Error("workspace-attributes-unavailable");
      changed.set(key, path);
      if (status !== "D") checkoutPaths.add(key);
    }
  }
  const paths = [...changed.values()];
  if (!paths.length) return;

  privateDirectory(ports.scratch);
  const directory = mkdtempSync(join(ports.scratch, ".workspace-attributes-"));
  const bare = join(directory, "tracked.git"), template = join(directory, "empty-template");
  const trackedIndex = join(directory, "tracked-index"), effectiveIndex = join(directory, "effective-index");
  const unpinned: Buffer[] = [], attributeDifferences: Buffer[] = [];
  try {
    mkdirSync(template, { mode: 0o700 });
    await git(ports, repository, ["init", "--quiet", "--bare", `--object-format=${snapshot.objectFormat}`, `--template=${template}`, bare]);
    await git(ports, repository, ["read-tree", snapshot.workingTree], trackedIndex); chmodSync(trackedIndex, 0o600);
    copyFileSync(trackedIndex, effectiveIndex); chmodSync(effectiveIndex, 0o600);
    const added = nulFields(await git(ports, repository, ["diff-tree", "--name-only", "--no-renames", "-r", "-z", "--diff-filter=A", snapshot.indexTree, snapshot.workingTree]));
    const untrackedAttributes = added.filter(path => path.subarray(path.lastIndexOf(47) + 1).equals(Buffer.from(".gitattributes")));
    if (untrackedAttributes.length) {
      const stdin = Buffer.concat(untrackedAttributes.flatMap(path => [path, Buffer.from([0])]));
      await git(ports, repository, ["update-index", "--force-remove", "-z", "--stdin"], trackedIndex, stdin);
      chmodSync(trackedIndex, 0o600);
    }
    for (let start = 0; start < paths.length && attributeDifferences.length <= 20; start += 128) {
      const batch = paths.slice(start, start + 128);
      const stdin = Buffer.concat(batch.flatMap(path => [path, Buffer.from([0])]));
      const trackedBytes = await ports.run(directory, ["git", `--git-dir=${bare}`, `--work-tree=${directory}`,
        "-c", `core.attributesFile=${devNull}`, "check-attr", "--cached", "-z", "--stdin", "eol", "text", "crlf", "filter"], {
        env: { GIT_INDEX_FILE: trackedIndex, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" }, stdin,
      });
      const effectiveBytes = await git(ports, checkout, ["check-attr", "--cached", "-z", "--stdin", "eol", "text", "crlf", "filter"], effectiveIndex, stdin);
      const tracked = parseAttributes(trackedBytes, batch), effective = parseAttributes(effectiveBytes, batch);
      for (const path of batch) {
        const key = path.toString("hex"), source = tracked.get(key), target = effective.get(key);
        if (!source || !target) throw new Error("workspace-attributes-unavailable");
        if (source.eol !== target.eol || source.text !== target.text || source.crlf !== target.crlf || source.filter !== target.filter) {
          attributeDifferences.push(path); continue;
        }
        const pinned = source.text === "unset" || source.eol === "lf" || source.eol === "crlf";
        if (normalizationDiffers && checkoutPaths.has(key) && !pinned) unpinned.push(path);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
  if (attributeDifferences.length) {
    throw new Error(`workspace-attributes-mismatch: destination attributes differ from tracked .gitattributes; paths ${attributeDifferences.slice(0, 20).map(displayedPath).join(", ")}${attributeDifferences.length > 20 ? ", and more" : ""}`);
  }
  if (unpinned.length) {
    const value = (setting: string | null): string => setting === null ? "null" : JSON.stringify(setting);
    throw new Error(`workspace-normalization-mismatch: source core.autocrlf=${value(snapshot.normalization.autocrlf)} core.eol=${value(snapshot.normalization.eol)}; ` +
      `destination core.autocrlf=${value(destination.autocrlf)} core.eol=${value(destination.eol)}; paths ${unpinned.slice(0, 20).map(displayedPath).join(", ")}${unpinned.length > 20 ? ", and more" : ""}`);
  }
}

async function restoreSparseBits(root: string, snapshot: WorkspaceSnapshot, ports: WorkspaceImportPorts, index?: string): Promise<void> {
  const entries = nulFields(await git(ports, root, ["ls-files", "-t", "-z"], index));
  const paths: Buffer[] = [], skipped: Buffer[] = [];
  for (const entry of entries) {
    if (entry.length < 3 || entry[1] !== 32) throw new Error("workspace-sparse-inspection-failed");
    const path = entry.subarray(2); paths.push(path);
    if (entry[0] === 83 || entry[0] === 115) skipped.push(path);
  }
  if (!snapshot.sparse.enabled) {
    if (skipped.length) await git(ports, root, ["update-index", "--no-skip-worktree", "-z", "--stdin"], index,
      Buffer.concat(skipped.flatMap(path => [path, Buffer.from([0])])));
    return;
  }
  if (snapshot.sparsePatterns === null) throw new Error("workspace-config-invalid: sparsePatterns");
  const included = new Set<string>();
  if (snapshot.sparse.cone === true) {
    const tree = text(await git(ports, root, ["write-tree"], index));
    for (const entry of await sparseTreePaths(root, tree, snapshot, ports)) if (entry.included) included.add(entry.path.toString("hex"));
  } else for (let start = 0; start < paths.length; start += 256) {
    for (const path of await nonConeIncluded(root, snapshot.sparsePatterns, paths.slice(start, start + 256), ports)) included.add(path);
  }
  const show = paths.filter(path => included.has(path.toString("hex")));
  const hide = paths.filter(path => !included.has(path.toString("hex")));
  if (show.length) await git(ports, root, ["update-index", "--no-skip-worktree", "-z", "--stdin"], index,
    Buffer.concat(show.flatMap(path => [path, Buffer.from([0])])));
  if (hide.length) await git(ports, root, ["update-index", "--skip-worktree", "-z", "--stdin"], index,
    Buffer.concat(hide.flatMap(path => [path, Buffer.from([0])])));
}

async function finishTrees(root: string, after: WorkspaceSnapshot, ports: WorkspaceImportPorts): Promise<void> {
  await git(ports, root, ["read-tree", "--reset", "-i", after.indexTree]);
  await restoreSparseBits(root, after, ports);
  await refreshIndex(root, ports);
  await git(ports, root, ["update-ref", "--no-deref", "HEAD", after.head]);
}

type SettingWriteJournal = { root: string; moveId: string; transitionId: string; ports: WorkspaceImportPorts; state: SettingState };
type SettingTransition = { settings: MappedSettings; plan: SettingPlan; modes: SettingModes; journal?: SettingWriteJournal };
async function applyTrees(root: string, before: WorkspaceSnapshot, after: WorkspaceSnapshot, ports: WorkspaceImportPorts, transition?: SettingTransition): Promise<void> {
  await guardAddedPaths(root, before.workingTree, after.workingTree, ports);
  await guardSparseExpansion(root, before, after, ports);
  privateDirectory(ports.scratch);
  const directory = mkdtempSync(join(ports.scratch, ".workspace-apply-"));
  const index = join(directory, "index");
  try {
    await git(ports, root, ["read-tree", "--reset", "-i", before.workingTree], index);
    await restoreSparseBits(root, before, ports, index);
    chmodSync(index, 0o600);
    await refreshIndex(root, ports, index);
    if (transition) installSettings(transition.settings, transition.plan.temporary ?? transition.plan.target,
      transition.plan.temporary ? undefined : transition.modes, transition.journal, transition.plan.temporary ? "temporary" : "target");
    await git(ports, root, ["read-tree", "-m", "-u", before.workingTree, after.workingTree], index);
    if (transition?.plan.temporary) installSettings(transition.settings, transition.plan.target, transition.modes, transition.journal, "target");
    await finishTrees(root, after, ports);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

type LocalSetting = { value: string | null; mode: number | null };
type MappedSettings = { configPath: string; sparsePath: string; config: LocalSetting; sparse: LocalSetting;
  effectiveSparse: { enabled: boolean; cone: boolean | null } };

function readLocalSetting(path: string): LocalSetting {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("workspace-config-unsafe");
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: null, mode: null };
      throw new Error("workspace-config-unavailable");
    }
    if (stat.isSymbolicLink() || current !== path && !stat.isDirectory()) throw new Error("workspace-config-unsafe");
    if (current === path) {
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (!stat.isFile() || process.platform !== "win32" && uid !== undefined && stat.uid !== uid) throw new Error("workspace-config-unsafe");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd), bytes = readFileSync(fd), value = bytes.toString("utf8");
        if (!opened.isFile() || !Buffer.from(value).equals(bytes)) throw new Error("workspace-config-invalid");
        return { value, mode: opened.mode & 0o7777 };
      } finally { closeSync(fd); }
    }
  }
  throw new Error("workspace-config-unsafe");
}

async function mappedSettings(root: string, ports: WorkspaceImportPorts): Promise<MappedSettings> {
  const configPath = text(await git(ports, root, ["rev-parse", "--path-format=absolute", "--git-path", "config.worktree"]));
  const sparsePath = text(await git(ports, root, ["rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout"]));
  const missing = "__spider_roam_missing_sparse_setting__";
  const read = async (key: string): Promise<boolean | null> => {
    try {
      const value = text(await git(ports, root, ["config", "--get", `--default=${missing}`, key]));
      return value === missing ? null : gitBoolean(value);
    } catch { throw new Error("workspace-config-invalid"); }
  };
  const enabled = await read("core.sparseCheckout"), cone = await read("core.sparseCheckoutCone");
  return { configPath, sparsePath, config: readLocalSetting(configPath), sparse: readLocalSetting(sparsePath),
    effectiveSparse: { enabled: enabled ?? false, cone } };
}

function assertMappedSettings(actual: MappedSettings, expected: SettingValues & { sparse?: WorkspaceSnapshot["sparse"] }, reason = "workspace-config-diverged"): void {
  const differences = [actual.config.value !== expected.worktreeConfig && "worktreeConfig",
    actual.sparse.value !== expected.sparsePatterns && "sparsePatterns",
    expected.sparse && actual.effectiveSparse.enabled !== expected.sparse.enabled && "sparse.enabled",
    expected.sparse && actual.effectiveSparse.cone !== expected.sparse.cone && "sparse.cone"].filter(Boolean);
  if (differences.length) throw new Error(`${reason}: ${differences.join(", ")}`);
}

function writeLocalSetting(path: string, value: string | null, mode: number | null, expected?: LocalSetting): void {
  const checkExpected = (): LocalSetting => {
    const current = readLocalSetting(path);
    if (expected && (current.value !== expected.value || current.mode !== expected.mode)) throw new Error("workspace-recovery-diverged: settings changed");
    return current;
  };
  const current = checkExpected();
  if (current.value === value && (value === null || mode === null || current.mode === mode)) return;
  if (value === null) {
    if (current.value !== null) {
      unlinkSync(path);
      const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    return;
  }
  const parent = dirname(path);
  try { checkPath(parent, "directory"); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "workspace-path-missing") throw error;
    privateDirectory(parent);
  }
  const temporary = join(parent, `.${basename(path)}.roam-${randomUUID()}`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, value);
    if (mode !== null && process.platform !== "win32") fchmodSync(fd, mode);
    fsyncSync(fd); closeSync(fd); fd = null;
    if (expected) checkExpected();
    renameSync(temporary, path);
    const directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

type SettingValues = { worktreeConfig: string | null; sparsePatterns: string | null };
type SettingModes = { worktreeMode: number | null; sparseMode: number | null };
type SettingPlan = { target: SettingValues; temporary: SettingValues | null; original: SettingValues; modes: SettingModes };

function journalSettings(result: Record<string, unknown>): SettingValues {
  if (!(result.worktreeConfig === null || typeof result.worktreeConfig === "string") ||
      !(result.sparsePatterns === null || typeof result.sparsePatterns === "string")) throw new Error("workspace-journal-invalid");
  return { worktreeConfig: result.worktreeConfig, sparsePatterns: result.sparsePatterns };
}
function journalSparse(result: Record<string, unknown>): WorkspaceSnapshot["sparse"] {
  if (typeof result.sparseEnabled !== "boolean" || !(result.sparseCone === null || typeof result.sparseCone === "boolean")) {
    throw new Error("workspace-journal-invalid");
  }
  return { enabled: result.sparseEnabled, cone: result.sparseCone };
}
function expectedInstalled(snapshot: WorkspaceSnapshot, root: string, ports: WorkspaceImportPorts): SettingValues & { sparse: WorkspaceSnapshot["sparse"] } {
  const actions = ports.journal.read(snapshot.moveId);
  const installed = actions.filter(row => row.action === "workspace-config-installed" && row.result.root === root &&
    row.result.digest === snapshotDigest(snapshot)).at(-1);
  if (installed) return { ...journalSettings(installed.result), sparse: journalSparse(installed.result) };
  const target = actions.filter(row => row.action === "workspace-config-target" && row.result.root === root &&
    row.result.digest === snapshotDigest(snapshot)).at(-1);
  if (target) return { ...journalSettings(target.result), sparse: { enabled: snapshot.sparse.enabled,
    cone: snapshot.sparse.enabled && snapshot.sparse.cone === null ? false : snapshot.sparse.cone } };
  return { worktreeConfig: snapshot.worktreeConfig, sparsePatterns: snapshot.sparsePatterns, sparse: snapshot.sparse };
}
function journalModes(result: Record<string, unknown>): SettingModes {
  const valid = (value: unknown): value is number | null => value === null ||
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0o7777;
  if (!valid(result.worktreeMode) || !valid(result.sparseMode)) throw new Error("workspace-journal-invalid");
  return { worktreeMode: result.worktreeMode, sparseMode: result.sparseMode };
}

function gitBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on"].includes(normalized)) return true;
  if (["", "false", "no", "off"].includes(normalized)) return false;
  if (/^[+-]?\d+$/.test(normalized)) return BigInt(normalized) !== 0n;
  throw new Error("workspace-config-invalid");
}

async function sparseFlags(contents: string | null, ports: WorkspaceImportPorts): Promise<{ enabled: boolean | null; cone: boolean | null }> {
  if (contents === null) return { enabled: null, cone: null };
  privateDirectory(ports.scratch);
  const directory = mkdtempSync(join(ports.scratch, ".workspace-sparse-config-")), file = join(directory, "config");
  try {
    writeFileSync(file, contents, { flag: "wx", mode: 0o600 });
    const entries = nulFields(await git(ports, ports.scratch, ["config", "--null", "--file", file, "--list"]));
    let enabled: boolean | null = null, cone: boolean | null = null;
    for (const entry of entries) {
      const separator = entry.indexOf(10);
      if (separator <= 0) throw new Error("workspace-config-invalid");
      const key = entry.subarray(0, separator).toString("utf8").toLowerCase();
      if (key === "core.sparsecheckout") enabled = gitBoolean(entry.subarray(separator + 1).toString("utf8"));
      else if (key === "core.sparsecheckoutcone") cone = gitBoolean(entry.subarray(separator + 1).toString("utf8"));
    }
    return { enabled, cone };
  } catch { throw new Error("workspace-config-invalid"); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

async function settingsPlan(snapshot: WorkspaceSnapshot, settings: MappedSettings, root: string, ports: WorkspaceImportPorts, exact = false): Promise<SettingPlan | null> {
  let config = snapshot.worktreeConfig;
  const { enabled, cone } = await sparseFlags(config, ports);
  const targetSparse = snapshot.sparse.enabled;
  if (targetSparse && snapshot.sparsePatterns === null) throw new Error("workspace-config-invalid: sparsePatterns");
  const currentSparse = settings.effectiveSparse.enabled;
  const setEnabled = !exact && (enabled === null ? targetSparse || currentSparse : enabled !== targetSparse);
  const targetCone = snapshot.sparse.cone ?? (targetSparse ? false : null);
  const setCone = !exact && targetCone !== null && cone !== targetCone;
  const unsetCone = !exact && targetCone === null && cone !== null;
  if (unsetCone) {
    privateDirectory(ports.scratch);
    const directory = mkdtempSync(join(ports.scratch, ".workspace-sparse-target-")), file = join(directory, "config");
    try {
      writeFileSync(file, config ?? "", { flag: "wx", mode: 0o600 });
      await git(ports, ports.scratch, ["config", "--file", file, "--unset-all", "core.sparseCheckoutCone"]);
      config = readFileSync(file, "utf8");
    } catch { throw new Error("workspace-config-invalid: sparsePatterns"); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
  if (setEnabled || setCone) {
    config = `${config ?? ""}\n[core]\n${setEnabled ? `\tsparseCheckout = ${targetSparse}\n` : ""}${setCone ? `\tsparseCheckoutCone = ${targetCone}\n` : ""}`;
  }
  const target = { worktreeConfig: config, sparsePatterns: snapshot.sparsePatterns };
  const original = { worktreeConfig: settings.config.value, sparsePatterns: settings.sparse.value };
  if (target.worktreeConfig === original.worktreeConfig && target.sparsePatterns === original.sparsePatterns) return null;
  const temporary = currentSparse && !targetSparse ? {
    worktreeConfig: `${target.worktreeConfig ?? ""}\n[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = false\n`,
    sparsePatterns: "/*\n",
  } : null;
  return { target, temporary, original, modes: { worktreeMode: settings.config.mode, sparseMode: settings.sparse.mode } };
}

function installSettings(settings: MappedSettings, values: SettingValues, modes: SettingModes = { worktreeMode: 0o600, sparseMode: 0o600 },
  journal?: SettingWriteJournal, phase: "temporary" | "target" = "target"): void {
  const write = (step: string, path: string, value: string | null, mode: number | null): void => {
    const before = journal && readRecoveryState(settings);
    if (journal && before && !sameSettings(before, journal.state)) throw new Error("workspace-config-diverged: settings changed");
    if (journal) journal.ports.journal.record(journal.moveId, "workspace-settings-write-start", { root: journal.root, transitionId: journal.transitionId, step });
    if (journal && before && !sameSettings(readRecoveryState(settings), before)) throw new Error("workspace-config-diverged: settings changed");
    const expected = before && (step.endsWith("-sparse") ? { value: before.sparsePatterns, mode: before.sparseMode }
      : { value: before.worktreeConfig, mode: before.worktreeMode });
    writeLocalSetting(path, value, mode, expected);
    if (journal) {
      journal.state = step.endsWith("-sparse") ? { ...journal.state, sparsePatterns: value, sparseMode: mode }
        : { ...journal.state, worktreeConfig: value, worktreeMode: mode };
      journal.ports.journal.record(journal.moveId, "workspace-settings-write-complete", { root: journal.root, transitionId: journal.transitionId, step });
    }
  };
  write(`${phase}-sparse`, settings.sparsePath, values.sparsePatterns, values.sparsePatterns === null ? null : modes.sparseMode ?? 0o600);
  write(`${phase}-config`, settings.configPath, values.worktreeConfig, values.worktreeConfig === null ? null : modes.worktreeMode ?? 0o600);
}

function missingConfig(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const detail = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
  return detail.status === 1 && Buffer.isBuffer(detail.stdout) && detail.stdout.length === 0 &&
    Buffer.isBuffer(detail.stderr) && detail.stderr.length === 0;
}

function writeNewFile(file: string, contents: string): void {
  try { writeFileSync(file, contents, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    checkPath(file, "file");
    if (readFileSync(file, "utf8") !== contents) throw new Error("workspace-config-conflict");
  }
}

async function enableWorktreeConfig(repository: string, moveId: string, ports: WorkspaceImportPorts): Promise<void> {
  let previous: string | null = null;
  try { previous = text(await git(ports, repository, ["config", "--local", "--bool", "--get", "extensions.worktreeConfig"])); }
  catch (error) { if (!missingConfig(error)) throw new Error("workspace-shared-config-unavailable"); }
  if (previous !== "true") {
    ports.journal.record(moveId, "workspace-shared-config-change", { repository, key: "extensions.worktreeConfig", previous });
    await git(ports, repository, ["config", "--local", "extensions.worktreeConfig", "true"]);
  }
}

async function createCheckout(snapshot: WorkspaceSnapshot, destination: string, repository: string, common: string, ports: WorkspaceImportPorts, resume = false): Promise<SettingWriteJournal | undefined> {
  checkPath(dirname(destination), "directory");
  const creation = ports.worktreeCommand === null
    ? ["git", "worktree", "add", "--detach", "--no-checkout", destination, snapshot.head]
    : [...ports.worktreeCommand, "--detach", "--no-checkout", destination, snapshot.head];
  if (!creation[0]) throw new Error("workspace-worktree-command-invalid");
  if (!resume) await ports.run(repository, creation);
  checkPath(destination, "directory");
  const actualCommon = text(await git(ports, destination, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const top = text(await git(ports, destination, ["rev-parse", "--path-format=absolute", "--show-toplevel"]));
  if (realpathSync(actualCommon) !== realpathSync(common) || realpathSync(top) !== realpathSync(destination) ||
      text(await git(ports, destination, ["rev-parse", "--verify", "HEAD"])) !== snapshot.head ||
      (await git(ports, destination, ["ls-files", "-z"])).length !== 0 ||
      (await git(ports, destination, ["ls-files", "--others", "--exclude-standard", "-z"])).length !== 0 ||
      (await git(ports, destination, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).length !== 0) {
    throw new Error("workspace-no-checkout-invalid");
  }
  await enableWorktreeConfig(repository, snapshot.moveId, ports);
  const settings = await mappedSettings(destination, ports);
  const plan = await settingsPlan(snapshot, settings, destination, ports);
  let journal: SettingWriteJournal | undefined;
  if (plan) {
    journal = beginSettingsTransition(snapshot, destination, common, settings, plan, await treeEvidence(destination, ports), false, false, ports);
    ports.journal.record(snapshot.moveId, "workspace-config-target", { root: destination, digest: snapshotDigest(snapshot), ...plan.target });
    installSettings(settings, plan.target, undefined, journal);
  }
  await git(ports, destination, ["read-tree", "-m", "-u", snapshot.workingTree]);
  await finishTrees(destination, snapshot, ports);
  return journal;
}

async function savedBranchValue(root: string, snapshot: WorkspaceSnapshot, ports: WorkspaceImportPorts): Promise<string | null> {
  const branch = snapshot.branch;
  if (branch === null) return null;
  if (!branch.startsWith("refs/heads/")) throw new Error("workspace-branch-invalid");
  try { await git(ports, root, ["check-ref-format", branch]); }
  catch { throw new Error("workspace-branch-invalid"); }
  let output: string;
  try { output = text(await git(ports, root, ["for-each-ref", "--format=%(refname) %(objectname)", branch])); }
  catch { throw new Error("workspace-branch-unavailable"); }
  let value: string | null = null;
  for (const line of output ? output.split("\n") : []) {
    const match = /^(refs\/[^\s]+) ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(line);
    if (!match) throw new Error("workspace-branch-unavailable");
    if (match[1] === branch) {
      if (value !== null || match[2].length !== snapshot.head.length) throw new Error("workspace-branch-unavailable");
      value = match[2];
    }
  }
  return value;
}

async function restoreBranch(root: string, snapshot: WorkspaceSnapshot, ports: WorkspaceImportPorts, moveId = snapshot.moveId): Promise<void> {
  if (snapshot.branch === null) return;
  const branch = snapshot.branch, value = await savedBranchValue(root, snapshot, ports);
  const worktrees = (await git(ports, root, ["worktree", "list", "--porcelain", "-z"])).toString("utf8").split("\0");
  let other = false, current = "";
  for (const field of worktrees) {
    if (field.startsWith("worktree ")) current = field.slice("worktree ".length);
    else if (field === `branch ${branch}` && current !== root) other = true;
  }
  if (other || value !== null && value !== snapshot.head) {
    ports.journal.record(moveId, "workspace-branch-conflict", { root, savedBranch: branch });
    return;
  }
  if (value === null) await git(ports, root, ["update-ref", branch, snapshot.head, "0".repeat(snapshot.head.length)]);
  await git(ports, root, ["symbolic-ref", "HEAD", branch]);
}

function snapshotDigest(snapshot: WorkspaceSnapshot): string {
  return createHash("sha256").update(JSON.stringify([
    snapshot.repoKey, snapshot.workspaceId, snapshot.moveId, snapshot.stage, snapshot.head, snapshot.branch,
    snapshot.objectFormat, snapshot.indexTree, snapshot.workingTree, snapshot.relativeCwd, snapshot.sparsePatterns,
    snapshot.worktreeConfig,
    { autocrlf: snapshot.normalization.autocrlf, eol: snapshot.normalization.eol },
    { enabled: snapshot.sparse.enabled, cone: snapshot.sparse.cone },
    snapshot.refs, snapshot.prerequisites,
    snapshot.bundle.kind === "ready" ? { kind: "ready", artifactId: snapshot.bundle.artifactId, byteLength: snapshot.bundle.byteLength } : { kind: "unbundled" },
  ])).digest("hex");
}

type RecordedPreparation = { snapshot: WorkspaceSnapshot; previous: WorkspaceSnapshot | null; digest: string };
function decodePreparation(result: Record<string, unknown>, moveId: string, root: string): RecordedPreparation {
  if (typeof result.snapshotJson !== "string" || !(result.previousJson === null || typeof result.previousJson === "string") ||
      typeof result.digest !== "string") throw new Error("workspace-journal-invalid");
  try {
    const snapshot = JSON.parse(result.snapshotJson) as WorkspaceSnapshot;
    const previous = result.previousJson === null ? null : JSON.parse(result.previousJson) as WorkspaceSnapshot;
    validateSnapshot(snapshot);
    if (snapshot.moveId !== moveId || snapshotDigest(snapshot) !== result.digest ||
        previous && (previous.root !== root || previous.repoKey !== snapshot.repoKey || previous.workspaceId !== snapshot.workspaceId || !validSparse(previous.sparse))) {
      throw new Error("invalid");
    }
    return { snapshot, previous, digest: result.digest };
  } catch { throw new Error("workspace-journal-invalid"); }
}
function preparedRecord(moveId: string, root: string, ports: WorkspaceImportPorts): RecordedPreparation | null {
  const row = ports.journal.read(moveId).filter(entry => entry.action === "workspace-prepared" && entry.result.root === root).at(-1);
  return row ? decodePreparation(row.result, moveId, root) : null;
}
function startedRecord(snapshot: WorkspaceSnapshot, root: string, ports: WorkspaceImportPorts): RecordedPreparation | null {
  const row = ports.journal.read(snapshot.moveId).filter(entry => entry.action === "workspace-prepare-start" &&
    entry.result.root === root && entry.result.stage === snapshot.stage).at(-1);
  if (!row) return null;
  const started = decodePreparation(row.result, snapshot.moveId, root);
  if (started.digest !== snapshotDigest(snapshot)) throw new Error("workspace-preparation-conflict");
  return started;
}

type SettingState = SettingValues & SettingModes;
type TreeEvidence = { head: string; indexTree: string | null; workingTree: string | null };
type WorkingView = Pick<WorkspaceSnapshot, "objectFormat" | "workingTree" | "sparse" | "sparsePatterns">;
type SettingsJournal = {
  transitionId: string; root: string; common: string; stage: WorkspaceSnapshot["stage"]; digest: string;
  snapshotJson: string; snapshot: WorkspaceSnapshot; original: SettingState; temporary: SettingState | null;
  target: SettingState; before: TreeEvidence; beforeApplied: boolean; beforeView: WorkingView | null;
};
type SettingsReplay = {
  transition: SettingsJournal; installCompleted: number; installPending: string | null;
  recoveryFrom: SettingState | null; recoveryCompleted: number; recoveryPending: string | null;
  prepared: boolean; closed: boolean;
};

function journalObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace-journal-invalid");
  return value as Record<string, unknown>;
}
function settingState(values: SettingValues, modes: SettingModes): SettingState {
  if ((values.worktreeConfig === null) !== (modes.worktreeMode === null) ||
      (values.sparsePatterns === null) !== (modes.sparseMode === null)) throw new Error("workspace-journal-invalid");
  return { ...values, ...modes };
}
function decodeSettingState(values: unknown, modes: unknown): SettingState {
  return settingState(journalSettings(journalObject(values)), journalModes(journalObject(modes)));
}
function stateValues(state: SettingState): SettingValues {
  return { worktreeConfig: state.worktreeConfig, sparsePatterns: state.sparsePatterns };
}
function stateModes(state: SettingState): SettingModes {
  return { worktreeMode: state.worktreeMode, sparseMode: state.sparseMode };
}
function sameSettings(a: SettingState, b: SettingState): boolean {
  return a.worktreeConfig === b.worktreeConfig && a.sparsePatterns === b.sparsePatterns &&
    a.worktreeMode === b.worktreeMode && a.sparseMode === b.sparseMode;
}
export function settingsDigest(t: SettingsJournal): string {
  const state = (s: SettingState | null): unknown => s && [s.worktreeConfig, s.sparsePatterns, s.worktreeMode, s.sparseMode];
  const view = t.beforeView && [t.beforeView.objectFormat, t.beforeView.workingTree, t.beforeView.sparse.enabled,
    t.beforeView.sparse.cone, t.beforeView.sparsePatterns];
  return createHash("sha256").update(JSON.stringify([1, t.transitionId, t.root, t.common, t.stage, t.digest, t.snapshotJson,
    state(t.original), state(t.temporary), state(t.target), [t.before.head, t.before.indexTree, t.before.workingTree], t.beforeApplied, view])).digest("hex");
}
function plannedState(values: SettingValues, modes: SettingModes = { worktreeMode: 0o600, sparseMode: 0o600 }): SettingState {
  return settingState(values, { worktreeMode: values.worktreeConfig === null ? null : modes.worktreeMode ?? 0o600,
    sparseMode: values.sparsePatterns === null ? null : modes.sparseMode ?? 0o600 });
}
function beginSettingsTransition(snapshot: WorkspaceSnapshot, root: string, common: string, settings: MappedSettings, plan: SettingPlan,
  before: TreeEvidence, temporary: boolean, beforeApplied: boolean, ports: WorkspaceImportPorts): SettingWriteJournal {
  const beforeView: WorkingView | null = before.workingTree === null ? null : beforeApplied
    ? { objectFormat: snapshot.objectFormat, workingTree: snapshot.workingTree, sparse: snapshot.sparse, sparsePatterns: snapshot.sparsePatterns }
    : { objectFormat: snapshot.objectFormat, workingTree: before.workingTree, sparse: settings.effectiveSparse, sparsePatterns: settings.sparse.value };
  if (beforeView?.sparse.enabled && beforeView.sparsePatterns === null) throw new Error("workspace-config-invalid: sparsePatterns");
  const t: SettingsJournal = { transitionId: randomUUID(), root, common: realpathSync(common), stage: snapshot.stage,
    digest: snapshotDigest(snapshot), snapshotJson: JSON.stringify(snapshot), snapshot,
    original: settingState(plan.original, plan.modes), temporary: temporary && plan.temporary ? plannedState(plan.temporary) : null,
    target: plannedState(plan.target), before, beforeApplied, beforeView };
  if (!sameSettings(readRecoveryState(settings), t.original)) throw new Error("workspace-config-diverged: settings changed");
  ports.journal.record(snapshot.moveId, "workspace-settings-transition", {
    version: 1, transitionId: t.transitionId, root: t.root, common: t.common, stage: t.stage, digest: t.digest,
    snapshotJson: t.snapshotJson, original: stateValues(t.original), modes: stateModes(t.original),
    temporary: t.temporary && stateValues(t.temporary), temporaryModes: t.temporary && stateModes(t.temporary),
    target: stateValues(t.target), targetModes: stateModes(t.target), before: t.before, beforeApplied: t.beforeApplied,
    beforeView: t.beforeView, checksum: settingsDigest(t),
  });
  return { root, moveId: snapshot.moveId, transitionId: t.transitionId, ports, state: t.original };
}
function decodeSettingsTransition(result: Record<string, unknown>, moveId: string): SettingsJournal {
  if (result.version !== 1 || typeof result.transitionId !== "string" || !/^[a-f0-9-]{36}$/.test(result.transitionId) ||
      typeof result.root !== "string" || !isAbsolute(result.root) || resolve(result.root) !== result.root ||
      typeof result.common !== "string" || !isAbsolute(result.common) || resolve(result.common) !== result.common ||
      (result.stage !== "pre" && result.stage !== "final") || typeof result.digest !== "string" ||
      typeof result.snapshotJson !== "string" || typeof result.checksum !== "string" || typeof result.beforeApplied !== "boolean") throw new Error("workspace-journal-invalid");
  let snapshot: WorkspaceSnapshot;
  try { snapshot = JSON.parse(result.snapshotJson) as WorkspaceSnapshot; validateSnapshot(snapshot); }
  catch { throw new Error("workspace-journal-invalid"); }
  if (snapshot.moveId !== moveId || snapshot.stage !== result.stage || snapshotDigest(snapshot) !== result.digest) throw new Error("workspace-journal-invalid");
  const original = decodeSettingState(result.original, result.modes), target = decodeSettingState(result.target, result.targetModes);
  const temporary = result.temporary === null && result.temporaryModes === null ? null : decodeSettingState(result.temporary, result.temporaryModes);
  const evidence = journalObject(result.before);
  const oid = snapshot.objectFormat === "sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (typeof evidence.head !== "string" || !oid.test(evidence.head) ||
      !(evidence.indexTree === null || typeof evidence.indexTree === "string" && oid.test(evidence.indexTree)) ||
      !(evidence.workingTree === null || typeof evidence.workingTree === "string" && oid.test(evidence.workingTree)) ||
      (evidence.indexTree === null) !== (evidence.workingTree === null)) throw new Error("workspace-journal-invalid");
  const before = { head: evidence.head, indexTree: evidence.indexTree, workingTree: evidence.workingTree };
  let beforeView: WorkingView | null = null;
  if (result.beforeView !== null) {
    const view = journalObject(result.beforeView);
    if (view.objectFormat !== snapshot.objectFormat || typeof view.workingTree !== "string" || !oid.test(view.workingTree) ||
        !validSparse(view.sparse) || !(view.sparsePatterns === null || typeof view.sparsePatterns === "string") ||
        view.sparse.enabled && view.sparsePatterns === null) throw new Error("workspace-journal-invalid");
    beforeView = { objectFormat: snapshot.objectFormat, workingTree: view.workingTree, sparse: view.sparse, sparsePatterns: view.sparsePatterns };
  }
  if ((before.workingTree === null) !== (beforeView === null)) throw new Error("workspace-journal-invalid");
  const t: SettingsJournal = { transitionId: result.transitionId, root: result.root, common: result.common, stage: result.stage,
    digest: result.digest, snapshotJson: result.snapshotJson, snapshot, original, temporary, target, before, beforeApplied: result.beforeApplied, beforeView };
  if (settingsDigest(t) !== result.checksum || target.sparsePatterns !== snapshot.sparsePatterns) throw new Error("workspace-journal-invalid");
  return t;
}
function installSteps(t: SettingsJournal): string[] {
  return t.temporary ? ["temporary-sparse", "temporary-config", "target-sparse", "target-config"] : ["target-sparse", "target-config"];
}
function nextSettingState(t: SettingsJournal, current: SettingState, step: string): SettingState {
  const target = step.startsWith("recovery-") ? t.original : step.startsWith("temporary-") ? t.temporary : t.target;
  if (!target) throw new Error("workspace-journal-invalid");
  return step.endsWith("-sparse") ? { ...current, sparsePatterns: target.sparsePatterns, sparseMode: target.sparseMode }
    : { ...current, worktreeConfig: target.worktreeConfig, worktreeMode: target.worktreeMode };
}
function possibleSettings(t: SettingsJournal, from: SettingState, steps: readonly string[], completed: number, pending: string | null): SettingState[] {
  let state = from;
  for (const step of steps.slice(0, completed)) state = nextSettingState(t, state, step);
  return pending ? [state, nextSettingState(t, state, pending)] : [state];
}
function settingsReplay(snapshot: WorkspaceSnapshot, root: string, ports: WorkspaceImportPorts): SettingsReplay | null {
  const rows = ports.journal.read(snapshot.moveId);
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.action !== "string" ||
      !row.result || typeof row.result !== "object" || Array.isArray(row.result))) throw new Error("workspace-journal-invalid");
  let current: SettingsReplay | null = null, strictDigest: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const { action, result } = rows[i];
    if (action === "workspace-prepare-start" && result.root === root) {
      if (result.settingsJournalVersion !== undefined && result.settingsJournalVersion !== 1) throw new Error("workspace-journal-invalid");
      strictDigest = result.settingsJournalVersion === 1 && typeof result.digest === "string" ? result.digest : null;
    } else if (action === "workspace-config-target" && result.root === root) {
      if (typeof result.digest !== "string") throw new Error("workspace-journal-invalid");
      const transition = current && !current.closed && current.transition.digest === result.digest;
      if (!transition) {
        const completed = rows.slice(i + 1).some(row => row.action === "workspace-prepared" && row.result.root === root && row.result.digest === result.digest);
        if (result.digest === strictDigest || !completed) throw new Error("workspace-journal-invalid");
      }
    }
    if (action.startsWith("workspace-settings-")) {
      if (typeof result.root !== "string" || !isAbsolute(result.root) || resolve(result.root) !== result.root) throw new Error("workspace-journal-invalid");
      if (result.root !== root) continue;
      if (action === "workspace-settings-transition") {
        if (current && !current.closed) throw new Error("workspace-journal-invalid");
        const transition = decodeSettingsTransition(result, snapshot.moveId);
        if (transition.snapshot.repoKey !== snapshot.repoKey || transition.snapshot.workspaceId !== snapshot.workspaceId) throw new Error("workspace-journal-invalid");
        const start = rows.slice(0, i).filter(row => row.action === "workspace-prepare-start" && row.result.root === root &&
          row.result.stage === transition.stage).at(-1);
        if (!start || decodePreparation(start.result, snapshot.moveId, root).digest !== transition.digest) throw new Error("workspace-journal-invalid");
        current = { transition, installCompleted: 0, installPending: null, recoveryFrom: null,
          recoveryCompleted: 0, recoveryPending: null, prepared: false, closed: false };
        continue;
      }
      if (!current || current.closed || result.transitionId !== current.transition.transitionId) throw new Error("workspace-journal-invalid");
      const t = current.transition;
      if (action === "workspace-settings-write-start" || action === "workspace-settings-write-complete") {
        const recovery = current.recoveryFrom !== null;
        const steps = recovery ? ["recovery-sparse", "recovery-config"] : installSteps(t);
        const completed = recovery ? current.recoveryCompleted : current.installCompleted;
        const pending = recovery ? current.recoveryPending : current.installPending;
        if (current.prepared || typeof result.step !== "string" || result.step !== steps[completed]) throw new Error("workspace-journal-invalid");
        if (action === "workspace-settings-write-start") {
          if (pending !== null) throw new Error("workspace-journal-invalid");
          if (recovery) current.recoveryPending = result.step; else current.installPending = result.step;
        } else {
          if (pending !== result.step) throw new Error("workspace-journal-invalid");
          if (recovery) { current.recoveryPending = null; current.recoveryCompleted++; }
          else { current.installPending = null; current.installCompleted++; }
        }
      } else if (action === "workspace-settings-recovery-start") {
        if (current.recoveryFrom || current.prepared) throw new Error("workspace-journal-invalid");
        const from = decodeSettingState(result.from, result.modes);
        if (!possibleSettings(t, t.original, installSteps(t), current.installCompleted, current.installPending).some(value => sameSettings(value, from))) {
          throw new Error("workspace-journal-invalid");
        }
        current.recoveryFrom = from;
      } else if (action === "workspace-settings-recovery-complete") {
        if (!current.recoveryFrom || current.recoveryCompleted !== 2 || current.recoveryPending ||
            result.digest !== t.digest || typeof result.workingApplied !== "boolean") throw new Error("workspace-journal-invalid");
        current.closed = true;
      } else if (action === "workspace-settings-transition-complete") {
        if (!current.prepared || current.recoveryFrom || current.installPending || current.installCompleted !== installSteps(t).length) {
          throw new Error("workspace-journal-invalid");
        }
        current.closed = true;
      } else throw new Error("workspace-journal-invalid");
    } else if (action === "workspace-prepared" && current && !current.closed && result.root === root) {
      if (current.recoveryFrom || current.installPending || current.installCompleted !== installSteps(current.transition).length ||
          decodePreparation(result, snapshot.moveId, root).digest !== current.transition.digest) throw new Error("workspace-journal-invalid");
      current.prepared = true;
    }
  }
  return current && !current.closed ? current : null;
}
async function treeEvidence(root: string, ports: WorkspaceImportPorts): Promise<TreeEvidence> {
  const index = text(await git(ports, root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
  try { lstatSync(index); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const head = text(await git(ports, root, ["rev-parse", "--verify", "HEAD"]));
    if ((await git(ports, root, ["ls-files", "-z"])).length ||
        (await git(ports, root, ["ls-files", "--others", "--exclude-standard", "-z"])).length ||
        (await git(ports, root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).length) {
      throw new Error("workspace-recovery-diverged: checkout has unexpected files");
    }
    return { head, indexTree: null, workingTree: null };
  }
  return inspectTrees(root, ports);
}
async function recoveryHeadIndex(root: string, ports: WorkspaceImportPorts): Promise<TreeEvidence> {
  const indexPath = text(await git(ports, root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
  try { lstatSync(indexPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return treeEvidence(root, ports);
    throw error;
  }
  const head = text(await git(ports, root, ["rev-parse", "--verify", "HEAD"]));
  const stat = lstatSync(indexPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("workspace-index-unsafe");
  return withObjectQuarantine(root, ports, async quarantine => {
    const directory = mkdtempSync(join(ports.scratch, ".workspace-recovery-index-")), index = join(directory, "index");
    try {
      copyFileSync(indexPath, index); chmodSync(index, 0o600);
      return { head, indexTree: text(await git(quarantine, root, ["write-tree"], index)), workingTree: null };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
function workingMayBeApplied(replay: SettingsReplay): boolean {
  return replay.transition.beforeApplied || (replay.transition.temporary
    ? replay.installCompleted > 2 || replay.installCompleted === 2 && replay.installPending === "target-sparse"
    : replay.installCompleted === 2 && replay.installPending === null);
}
function absentSparsePath(root: string, relative: Buffer): boolean {
  let current = Buffer.from(`${root}${sep}`), start = 0;
  for (let at = 0; at <= relative.length; at++) if (at === relative.length || relative[at] === 47) {
    const component = relative.subarray(start, at);
    if (!component.length || component.equals(Buffer.from(".")) || component.equals(Buffer.from(".."))) return false;
    current = Buffer.concat([current, start ? Buffer.from(sep) : Buffer.alloc(0), component]);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(current); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    if (at === relative.length || stat.isSymbolicLink() || !stat.isDirectory()) return false;
    start = at + 1;
  }
  return false;
}
async function matchesWorkingView(root: string, view: WorkingView, ports: WorkspaceImportPorts): Promise<boolean> {
  return withObjectQuarantine(root, ports, async quarantine => {
    const directory = mkdtempSync(join(ports.scratch, ".workspace-recovery-inspect-")), index = join(directory, "index");
    try {
      await git(quarantine, root, ["-c", "core.sparseCheckout=false", "read-tree", "--reset", "-i", view.workingTree], index);
      if (view.sparse.enabled) {
        const hidden: Buffer[] = [];
        for (const entry of await sparseTreePaths(root, view.workingTree, view, quarantine)) {
          if (entry.included) continue;
          if (!absentSparsePath(root, entry.path)) return false;
          hidden.push(entry.path);
        }
        if (hidden.length) await git(quarantine, root, ["update-index", "--skip-worktree", "-z", "--stdin"], index,
          Buffer.concat(hidden.flatMap(path => [path, Buffer.from([0])])));
      }
      await git(quarantine, root, ["-c", "core.sparseCheckout=false", "-c", "core.fsmonitor=false", "add", "-A", "--", ".",
        ...localMetadataPathspecs], index);
      return text(await git(quarantine, root, ["write-tree"], index)) === view.workingTree;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
async function recoveryTreeState(root: string, replay: SettingsReplay, ports: WorkspaceImportPorts): Promise<boolean> {
  const { transition: t } = replay, before = t.before, target = t.snapshot;
  const actual = await recoveryHeadIndex(root, ports);
  const beforeHeadIndex = actual.head === before.head && actual.indexTree === before.indexTree;
  const indexKnown = actual.indexTree === before.indexTree || actual.indexTree === target.indexTree ||
    before.indexTree === null && actual.indexTree === target.workingTree;
  const headKnown = actual.head === before.head || actual.head === target.head && actual.indexTree === target.indexTree;
  if (replay.prepared && (actual.head !== target.head || actual.indexTree !== target.indexTree)) {
    throw new Error("workspace-recovery-diverged: checkout changed");
  }
  if (workingMayBeApplied(replay) && indexKnown && headKnown && await matchesWorkingView(root, target, ports)) return true;
  if (beforeHeadIndex && !t.beforeApplied && !replay.prepared &&
      (t.beforeView === null ? actual.workingTree === null : await matchesWorkingView(root, t.beforeView, ports))) return false;
  throw new Error("workspace-recovery-diverged: checkout changed");
}
type SettingPaths = { configPath: string; sparsePath: string };
function readRecoveryState(paths: SettingPaths): SettingState {
  try {
    const config = readLocalSetting(paths.configPath), sparse = readLocalSetting(paths.sparsePath);
    return settingState({ worktreeConfig: config.value, sparsePatterns: sparse.value }, { worktreeMode: config.mode, sparseMode: sparse.mode });
  } catch { throw new Error("workspace-recovery-diverged: settings unavailable or unsafe"); }
}
async function recoverySettingPaths(root: string, ports: WorkspaceImportPorts): Promise<SettingPaths> {
  try {
    return {
      configPath: text(await git(ports, root, ["rev-parse", "--path-format=absolute", "--git-path", "config.worktree"])),
      sparsePath: text(await git(ports, root, ["rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout"])),
    };
  } catch { throw new Error("workspace-recovery-diverged: settings unavailable or unsafe"); }
}

/** Recover a journaled settings installation before retry or startup reconciliation. */
export async function recoverInterruptedWorkspace(snapshot: WorkspaceSnapshot, destination: string, repository: string, ports: WorkspaceImportPorts): Promise<void> {
  validateSnapshot(snapshot);
  await withCheckoutLock(destination, repository, ports, async common => {
    if (checkPath(destination, "directory", true)) {
      await assertCheckoutRoot(destination, ports);
      const actualCommon = text(await git(ports, destination, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
      if (realpathSync(actualCommon) !== common) throw new Error("workspace-repository-mismatch");
    }
    await recoverInterruptedWorkspaceLocked(snapshot, destination, common, ports);
  });
}
async function recoverInterruptedWorkspaceLocked(snapshot: WorkspaceSnapshot, destination: string, common: string, ports: WorkspaceImportPorts,
  finishInstalled = false): Promise<void> {
  const replay = settingsReplay(snapshot, destination, ports);
  if (!replay) return;
  if (!checkPath(destination, "directory", true)) throw new Error("workspace-preparation-missing");
  if (common !== replay.transition.common) throw new Error("workspace-repository-mismatch");
  const t = replay.transition, recoverySteps = ["recovery-sparse", "recovery-config"];
  const paths = await recoverySettingPaths(destination, ports), state = readRecoveryState(paths);
  const allowed = replay.recoveryFrom ? possibleSettings(t, replay.recoveryFrom, recoverySteps, replay.recoveryCompleted, replay.recoveryPending)
    : possibleSettings(t, t.original, installSteps(t), replay.installCompleted, replay.installPending);
  if (!allowed.some(value => sameSettings(value, state))) throw new Error("workspace-recovery-diverged: settings changed");
  let workingApplied: boolean;
  try { workingApplied = await recoveryTreeState(destination, replay, ports); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("workspace-")) throw error;
    throw new Error("workspace-recovery-diverged: checkout unavailable or changed");
  }
  if (replay.prepared) {
    if (!sameSettings(state, t.target)) throw new Error("workspace-recovery-diverged: settings changed");
    ports.journal.record(snapshot.moveId, "workspace-settings-transition-complete", { root: destination, transitionId: t.transitionId });
    return;
  }
  if (finishInstalled && snapshotDigest(snapshot) === t.digest && !replay.recoveryFrom && !replay.installPending &&
      replay.installCompleted === installSteps(t).length) {
    const rows = ports.journal.read(snapshot.moveId);
    // Move diagnostics may follow installation without changing this checkout.
    const installed = rows.filter(row => row.action.startsWith("workspace-") && row.result.root === destination).at(-1);
    if (installed?.action === "workspace-config-installed" && installed.result.digest === t.digest &&
        !rows.some(row => row.action === "workspace-aborted" && row.result.root === destination)) {
      if (!workingApplied || !sameSettings(state, t.target)) throw new Error("workspace-recovery-diverged: checkout changed");
      const started = startedRecord(t.snapshot, destination, ports);
      if (!started || t.snapshot.bundle.kind !== "ready") throw new Error("workspace-journal-invalid");
      const prepared: PreparedWorkspace = { root: destination, snapshot: t.snapshot, previous: started.previous,
        moveId: snapshot.moveId, adjustments: [] };
      await verifyWorkspace(prepared, ports);
      if (installed.result.sparseEnabled !== t.snapshot.sparse.enabled || t.snapshot.sparse.enabled &&
          installed.result.sparseCone !== (t.snapshot.sparse.cone ?? false)) throw new Error("workspace-journal-invalid");
      if (!sameSettings(readRecoveryState(paths), t.target)) throw new Error("workspace-recovery-diverged: settings changed");
      ports.journal.record(snapshot.moveId, "workspace-prepared", {
        root: destination, stage: t.stage, digest: t.digest, snapshotJson: t.snapshotJson,
        previousJson: started.previous === null ? null : JSON.stringify(started.previous), artifactId: t.snapshot.bundle.artifactId,
      });
      ports.journal.record(snapshot.moveId, "workspace-settings-transition-complete", { root: destination, transitionId: t.transitionId });
      return;
    }
  }
  if (!replay.recoveryFrom) {
    ports.journal.record(snapshot.moveId, "workspace-settings-recovery-start", { root: destination, transitionId: t.transitionId,
      from: stateValues(state), modes: stateModes(state) });
    replay.recoveryFrom = state;
  }
  for (let i = replay.recoveryCompleted; i < recoverySteps.length; i++) {
    const step = recoverySteps[i];
    const actual = readRecoveryState(paths);
    const expected = possibleSettings(t, replay.recoveryFrom, recoverySteps, i, replay.recoveryPending);
    if (!expected.some(value => sameSettings(value, actual))) throw new Error("workspace-recovery-diverged: settings changed");
    if (!replay.recoveryPending) ports.journal.record(snapshot.moveId, "workspace-settings-write-start", { root: destination, transitionId: t.transitionId, step });
    if (!sameSettings(readRecoveryState(paths), actual)) throw new Error("workspace-recovery-diverged: settings changed");
    if (step === "recovery-sparse") writeLocalSetting(paths.sparsePath, t.original.sparsePatterns, t.original.sparseMode,
      { value: actual.sparsePatterns, mode: actual.sparseMode });
    else writeLocalSetting(paths.configPath, t.original.worktreeConfig, t.original.worktreeMode,
      { value: actual.worktreeConfig, mode: actual.worktreeMode });
    ports.journal.record(snapshot.moveId, "workspace-settings-write-complete", { root: destination, transitionId: t.transitionId, step });
    replay.recoveryPending = null; replay.recoveryCompleted++;
  }
  if (!sameSettings(readRecoveryState(paths), t.original)) throw new Error("workspace-recovery-diverged: settings changed");
  ports.journal.record(snapshot.moveId, "workspace-settings-recovery-complete", {
    root: destination, transitionId: t.transitionId, digest: t.digest, workingApplied,
  });
}

function verifyReceivedLimit(snapshot: WorkspaceSnapshot, ports: WorkspaceImportPorts): void {
  const bundles = new Map<string, number>();
  const add = (value: WorkspaceSnapshot): void => {
    if (value.bundle?.kind !== "ready" || typeof value.bundle.artifactId !== "string" ||
        !Number.isSafeInteger(value.bundle.byteLength) || value.bundle.byteLength < 1) throw new Error("workspace-bundle-journal-invalid");
    const known = bundles.get(value.bundle.artifactId);
    if (known !== undefined && known !== value.bundle.byteLength) throw new Error("workspace-bundle-conflict");
    bundles.set(value.bundle.artifactId, value.bundle.byteLength);
  };
  add(snapshot);
  for (const { action, result } of ports.journal.read(snapshot.moveId)) {
    if (action !== "workspace-prepare-start" && action !== "workspace-prepared") continue;
    if (typeof result.snapshotJson !== "string") throw new Error("workspace-bundle-journal-invalid");
    let saved: WorkspaceSnapshot;
    try { saved = JSON.parse(result.snapshotJson) as WorkspaceSnapshot; }
    catch { throw new Error("workspace-bundle-journal-invalid"); }
    if (saved && saved.repoKey === snapshot.repoKey && saved.workspaceId === snapshot.workspaceId && saved.moveId === snapshot.moveId) add(saved);
  }
  const total = [...bundles.values()].reduce((sum, size) => sum + size, 0), limit = ports.limits.workspaceBytes;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(limit) || limit <= 0 || total > limit) {
    throw new Error("workspace-bundle-limit: fetch the missing commits or increase the configured limit");
  }
}

/** Verify the recorded HEAD, staged tree, and nonignored working tree without changing the real index. */
export async function verifyWorkspace(prepared: PreparedWorkspace, ports: WorkspaceImportPorts): Promise<void> {
  checkPath(prepared.root, "directory");
  await assertCheckoutRoot(prepared.root, ports);
  assertMappedSettings(await mappedSettings(prepared.root, ports), expectedInstalled(prepared.snapshot, prepared.root, ports), "workspace-verification-failed");
  assertTrees(await inspectTrees(prepared.root, ports), prepared.snapshot, "workspace-verification-failed");
}

/** Import an incremental artifact and prepare an existing mapped checkout. */
export async function prepareWorkspace(snapshot: WorkspaceSnapshot, destination: string, ports: WorkspaceImportPorts): Promise<PreparedWorkspace> {
  validateSnapshot(snapshot);
  verifyReceivedLimit(snapshot, ports);
  await validateWorktreeConfig(snapshot, ports);
  const ready = snapshot.bundle;
  if (ready.kind !== "ready") throw new Error("workspace-unbundled");
  let artifact: string | null;
  try { artifact = await ports.verifiedArtifactPath(ready.artifactId); }
  catch { throw new Error("workspace-artifact-unavailable"); }
  if (artifact === null) throw new Error("workspace-artifact-missing");
  checkPath(artifact, "file");
  if (lstatSync(artifact).size !== ready.byteLength) throw new Error("workspace-artifact-invalid");
  let repository: string | null;
  try { repository = await ports.resolveCommonRepository({ repoKey: snapshot.repoKey, workspaceId: snapshot.workspaceId, destination, sourceRoot: snapshot.root, moveId: snapshot.moveId }); }
  catch { throw new Error("workspace-repository-unavailable"); }
  if (repository === null) throw new Error("workspace-repository-unmapped");
  const mappedRepository = repository;
  return withCheckoutLock(destination, mappedRepository, ports, async repositoryCommon => {
    await savedBranchValue(mappedRepository, snapshot, ports);
    const exists = checkPath(destination, "directory", true);
    if (exists) await assertCheckoutRoot(destination, ports);
    if (exists) {
      const mappedCommon = text(await git(ports, destination, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
      if (realpathSync(mappedCommon) !== realpathSync(repositoryCommon)) throw new Error("workspace-repository-mismatch");
    }
    await recoverInterruptedWorkspaceLocked(snapshot, destination, repositoryCommon, ports, true);
    const actions = ports.journal.read(snapshot.moveId);
    if (actions.some(entry => entry.action === "workspace-aborted" && entry.result.root === destination)) throw new Error("workspace-aborted");
    const recorded = preparedRecord(snapshot.moveId, destination, ports);
    const started = startedRecord(snapshot, destination, ports);
    const recovered = actions.filter(row => row.action === "workspace-settings-recovery-complete" && row.result.root === destination &&
      row.result.digest === snapshotDigest(snapshot)).at(-1);
    const adjustments: readonly RestoreAdjustment[] = snapshot.sparse.enabled && snapshot.sparse.cone === null
      ? ["sparse-cone-defaulted-to-false"] : [];
    let previous: WorkspaceSnapshot | null = null, base: WorkspaceSnapshot | null = null;
    let divergence = "workspace-diverged", resumeWorking = false, resumeEmpty = false;
    if (recorded) {
      if (!exists) throw new Error("workspace-preparation-missing");
      if (recorded.snapshot.repoKey !== snapshot.repoKey || recorded.snapshot.workspaceId !== snapshot.workspaceId) throw new Error("workspace-preparation-conflict");
      divergence = "workspace-preparation-diverged";
      if (recorded.digest === snapshotDigest(snapshot)) {
        assertMappedSettings(await mappedSettings(destination, ports), expectedInstalled(recorded.snapshot, destination, ports), divergence);
        assertTrees(await inspectTrees(destination, ports), recorded.snapshot, divergence);
        return { root: destination, snapshot, previous: recorded.previous, moveId: snapshot.moveId, adjustments };
      }
      if (recorded.snapshot.stage !== "pre" || snapshot.stage !== "final") throw new Error("workspace-preparation-conflict");
      previous = recorded.previous;
      base = recorded.snapshot;
    } else if (exists && started) {
      if (snapshot.stage !== "pre") throw new Error("workspace-prestage-missing");
      previous = started.previous;
      base = previous;
      divergence = "workspace-preparation-diverged";
    } else if (exists) {
      try { previous = await ports.lastExportedSnapshot({ repoKey: snapshot.repoKey, workspaceId: snapshot.workspaceId, root: destination }); }
      catch { throw new Error("workspace-baseline-unavailable"); }
      if (previous === null) throw new Error("workspace-baseline-missing");
      if (previous.repoKey !== snapshot.repoKey || previous.workspaceId !== snapshot.workspaceId || previous.root !== destination) {
        throw new Error("workspace-baseline-invalid");
      }
      if (snapshot.stage !== "pre") throw new Error("workspace-prestage-missing");
      base = previous;
    } else if (snapshot.stage !== "pre") throw new Error("workspace-prestage-missing");
    if (started && JSON.stringify(started.previous) !== JSON.stringify(previous)) throw new Error("workspace-journal-invalid");
    if (started && exists) {
      const indexPath = text(await git(ports, destination, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
      let indexExists = true;
      try { lstatSync(indexPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") indexExists = false; else throw error;
      }
      if (!base && !indexExists) {
        const head = text(await git(ports, destination, ["rev-parse", "--verify", "HEAD"]));
        if (head !== snapshot.head || (await git(ports, destination, ["ls-files", "-z"])).length ||
            (await git(ports, destination, ["ls-files", "--others", "--exclude-standard", "-z"])).length ||
            (await git(ports, destination, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).length) {
          throw new Error("workspace-preparation-diverged: interrupted checkout has unexpected changes");
        }
        resumeEmpty = true;
      } else {
        const actual = await inspectTrees(destination, ports);
        if (base) {
          const before = actual.head === base.head && actual.indexTree === base.indexTree && actual.workingTree === base.workingTree;
          const indexKnown = actual.indexTree === base.indexTree || actual.indexTree === snapshot.indexTree;
          const headKnown = actual.head === base.head || actual.head === snapshot.head && actual.indexTree === snapshot.indexTree;
          const afterWorking = actual.workingTree === snapshot.workingTree && indexKnown && headKnown;
          if (recovered?.result.workingApplied === true) {
            if (!indexKnown || !headKnown || !await matchesWorkingView(destination, snapshot, ports)) {
              throw new Error("workspace-preparation-diverged: interrupted checkout has unexpected changes");
            }
            resumeWorking = true;
          } else if (!before && !recovered && afterWorking) resumeWorking = true;
          else if (!before) throw new Error("workspace-preparation-diverged: interrupted checkout has unexpected changes");
        } else {
          const emptyTree = createHash(snapshot.objectFormat).update("tree 0\0").digest("hex");
          if (actual.head !== snapshot.head) throw new Error("workspace-preparation-diverged: interrupted checkout has unexpected changes");
          if (recovered?.result.workingApplied === true && (actual.indexTree === snapshot.workingTree || actual.indexTree === snapshot.indexTree) &&
              await matchesWorkingView(destination, snapshot, ports)) resumeWorking = true;
          else if (actual.indexTree === emptyTree && actual.workingTree === emptyTree) resumeEmpty = true;
          else if (!recovered && actual.workingTree === snapshot.workingTree && (actual.indexTree === emptyTree || actual.indexTree === snapshot.indexTree)) resumeWorking = true;
          else throw new Error("workspace-preparation-diverged: interrupted checkout has unexpected changes");
        }
      }
    }
    if (base && !validSparse(base.sparse)) throw new Error("workspace-baseline-invalid");
    const settings = base || resumeWorking ? await mappedSettings(destination, ports) : null;
    const refs = snapshotPrivateRefs(snapshot);
    await withObjectQuarantine(repository, ports, async quarantine => {
      try {
        for (const prerequisite of snapshot.prerequisites) await git(quarantine, repository, ["cat-file", "-e", `${prerequisite}^{commit}`]);
        await git(quarantine, repository, ["bundle", "verify", artifact]);
      } catch { throw new Error("workspace-prerequisite-missing: fetch the required commits on the destination"); }
      const heads = await bundleHeads(snapshot, artifact, repository, quarantine);
      try { await git(quarantine, repository, ["bundle", "unbundle", artifact]); }
      catch { throw new Error("workspace-bundle-invalid"); }
      await verifySnapshotObjects(snapshot, repository, heads, quarantine);
      if (snapshot.sparse.enabled && snapshot.sparse.cone !== true) {
        if (snapshot.sparsePatterns === null) throw new Error("workspace-config-invalid: sparsePatterns");
        await nonConeIncluded(repository, snapshot.sparsePatterns, [], quarantine);
      }
      if (base && !resumeWorking) {
        await guardAddedPaths(destination, base.workingTree, snapshot.workingTree, quarantine);
        await guardSparseExpansion(destination, base, snapshot, quarantine);
      }
      if (base && settings) {
        assertMappedSettings(settings, expectedInstalled(started && resumeWorking && !recovered ? snapshot : base, destination, ports));
      }
      await verifyNormalization(snapshot, base, repository, exists ? destination : repository, quarantine);
      await verifyLfs(snapshot, repository, repositoryCommon, quarantine);
    });
    if (base && !resumeWorking) assertTrees(await inspectTrees(destination, ports), base, divergence);
    if (base) await validateWorktreeConfig(base, ports);
    const plan = settings ? await settingsPlan(snapshot, settings, destination, ports) : null;
    try {
      if (snapshot.stage === "pre") await git(ports, repository, ["fetch", "--quiet", "origin"]);
      for (const prerequisite of snapshot.prerequisites) await git(ports, repository, ["cat-file", "-e", `${prerequisite}^{commit}`]);
      await git(ports, repository, ["bundle", "verify", artifact]);
    } catch { throw new Error("workspace-prerequisite-missing: fetch the required commits on the destination"); }
    const heads = await bundleHeads(snapshot, artifact, repository, ports);
    try { await git(ports, repository, ["bundle", "unbundle", artifact]); }
    catch { throw new Error("workspace-bundle-invalid"); }
    await verifySnapshotObjects(snapshot, repository, heads, ports);
    recordMoveSnapshotRefs(destination, snapshot.moveId, [{ ref: refs.index, oid: heads.index }, { ref: refs.working, oid: heads.working }], ports);
    const creates: string[] = [];
    for (const [ref, head] of [[refs.index, heads.index], [refs.working, heads.working]] as const) {
      let existing: string | null = null;
      try { existing = text(await git(ports, repository, ["rev-parse", "--verify", "--quiet", ref])); }
      catch (error) { if (!missingConfig(error)) throw new Error("workspace-ref-unavailable"); }
      if (existing !== null && existing !== head) throw new Error("workspace-ref-conflict");
      if (existing === null) creates.push(`create ${ref} ${head}\n`);
    }
    if (creates.length) {
      try { await git(ports, repository, ["update-ref", "--stdin"], undefined, Buffer.from(`start\n${creates.join("")}prepare\ncommit\n`)); }
      catch { throw new Error("workspace-ref-conflict"); }
    }
    if (!started) ports.journal.record(snapshot.moveId, "workspace-prepare-start", {
      root: destination, stage: snapshot.stage, digest: snapshotDigest(snapshot), snapshotJson: JSON.stringify(snapshot),
      previousJson: previous === null ? null : JSON.stringify(previous), settingsJournalVersion: 1,
    });
    if (adjustments.length && !ports.journal.read(snapshot.moveId).some(row => row.action === "workspace-sparse-cone-override" &&
        row.result.root === destination && row.result.digest === snapshotDigest(snapshot))) {
      ports.journal.record(snapshot.moveId, "workspace-sparse-cone-override", { root: destination, digest: snapshotDigest(snapshot), value: false });
    }
    let settingsJournal: SettingWriteJournal | undefined;
    if (plan && settings) {
      if (!ports.journal.read(snapshot.moveId).some(row => row.action === "workspace-config-change" && row.result.root === destination)) {
        ports.journal.record(snapshot.moveId, "workspace-config-change", { root: destination, ...plan.original, ...plan.modes });
      }
      const before = await treeEvidence(destination, ports);
      if (!resumeWorking && base) assertTrees(before as Trees, base, divergence);
      settingsJournal = beginSettingsTransition(snapshot, destination, repositoryCommon, settings, plan, before, !resumeWorking, resumeWorking, ports);
      ports.journal.record(snapshot.moveId, "workspace-config-target", {
        root: destination, digest: snapshotDigest(snapshot), ...plan.target,
      });
      if (plan.target.worktreeConfig !== null) await enableWorktreeConfig(repository, snapshot.moveId, ports);
    }
    if (resumeWorking) {
      if (plan && settings) installSettings(settings, plan.target, undefined, settingsJournal);
      await finishTrees(destination, snapshot, ports);
    } else if (base) {
      const transition = plan && settings ? { settings, plan, modes: { worktreeMode: 0o600, sparseMode: 0o600 }, journal: settingsJournal } : undefined;
      await applyTrees(destination, base, snapshot, ports, transition);
    } else settingsJournal = await createCheckout(snapshot, destination, repository, repositoryCommon, ports, resumeEmpty);
    await restoreBranch(destination, snapshot, ports);
    const prepared: PreparedWorkspace = { root: destination, snapshot, previous, moveId: snapshot.moveId, adjustments };
    await verifyWorkspace(prepared, ports);
    const installed = await mappedSettings(destination, ports);
    if (installed.effectiveSparse.enabled !== snapshot.sparse.enabled || snapshot.sparse.enabled &&
        installed.effectiveSparse.cone !== (snapshot.sparse.cone ?? false)) throw new Error("workspace-verification-failed: sparse settings");
    ports.journal.record(snapshot.moveId, "workspace-config-installed", {
      root: destination, digest: snapshotDigest(snapshot), worktreeConfig: installed.config.value, sparsePatterns: installed.sparse.value,
      sparseEnabled: installed.effectiveSparse.enabled, sparseCone: installed.effectiveSparse.cone,
    });
    ports.journal.record(snapshot.moveId, "workspace-prepared", {
      root: destination, stage: snapshot.stage, digest: snapshotDigest(snapshot), snapshotJson: JSON.stringify(snapshot),
      previousJson: previous === null ? null : JSON.stringify(previous), artifactId: ready.artifactId,
    });
    if (settingsJournal) ports.journal.record(snapshot.moveId, "workspace-settings-transition-complete", {
      root: destination, transitionId: settingsJournal.transitionId,
    });
    return prepared;
  });
}

/** Restore the prior checkout only while the journaled preparation remains unchanged. */
export async function abortWorkspace(prepared: PreparedWorkspace, ports: WorkspaceImportPorts): Promise<void> {
  checkPath(prepared.root, "directory");
  await withCheckoutLock(prepared.root, prepared.root, ports, async () => {
    await assertCheckoutRoot(prepared.root, ports);
    if (prepared.moveId !== prepared.snapshot.moveId) throw new Error("workspace-preparation-conflict");
    const recorded = preparedRecord(prepared.moveId, prepared.root, ports);
    if (!recorded || recorded.digest !== snapshotDigest(prepared.snapshot) ||
        JSON.stringify(recorded.previous) !== JSON.stringify(prepared.previous)) throw new Error("workspace-preparation-conflict");
    const actions = ports.journal.read(prepared.moveId);
    const aborted = actions.some(entry => entry.action === "workspace-aborted" && entry.result.root === prepared.root);
    const originalRow = actions.find(entry => entry.action === "workspace-config-change" && entry.result.root === prepared.root);
    let transition: SettingTransition | undefined;
    if (!aborted && recorded.previous && actions.some(entry => entry.action === "workspace-abort-start" && entry.result.root === prepared.root)) {
      let restored = false;
      try {
        assertMappedSettings(await mappedSettings(prepared.root, ports), recorded.previous, "workspace-abort-diverged");
        assertTrees(await inspectTrees(prepared.root, ports), recorded.previous, "workspace-abort-diverged");
        restored = true;
      } catch (error) { if (!(error instanceof Error) || !error.message.startsWith("workspace-abort-diverged")) throw error; }
      if (restored) {
        await restoreBranch(prepared.root, recorded.previous, ports, prepared.moveId);
        ports.journal.record(prepared.moveId, "workspace-aborted", { root: prepared.root, retained: false });
        return;
      }
    }
    if (recorded.previous) {
      const settings = await mappedSettings(prepared.root, ports);
      const expected = aborted ? recorded.previous : expectedInstalled(recorded.snapshot, prepared.root, ports);
      assertMappedSettings(settings, expected, "workspace-abort-diverged");
      if (!aborted && originalRow) {
        const original = journalSettings(originalRow.result), modes = journalModes(originalRow.result);
        if (original.worktreeConfig !== recorded.previous.worktreeConfig || original.sparsePatterns !== recorded.previous.sparsePatterns) {
          throw new Error("workspace-journal-invalid");
        }
        const plan = await settingsPlan(recorded.previous, settings, prepared.root, ports, true);
        if (plan) transition = { settings, plan, modes };
      }
    }
    if (aborted) {
      assertTrees(await inspectTrees(prepared.root, ports), recorded.previous ?? recorded.snapshot, "workspace-abort-diverged");
      return;
    }
    assertTrees(await inspectTrees(prepared.root, ports), recorded.snapshot, "workspace-abort-diverged");
    ports.journal.record(prepared.moveId, "workspace-abort-start", { root: prepared.root });
    if (recorded.previous) {
      const common = text(await git(ports, prepared.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
      await verifyLfs(recorded.previous, prepared.root, common, ports);
      await applyTrees(prepared.root, recorded.snapshot, recorded.previous, ports, transition);
      await restoreBranch(prepared.root, recorded.previous, ports, prepared.moveId);
      assertTrees(await inspectTrees(prepared.root, ports), recorded.previous, "workspace-abort-failed");
    }
    ports.journal.record(prepared.moveId, "workspace-aborted", { root: prepared.root, retained: recorded.previous === null });
  });
}
