import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS } from "../contracts";
import type { WorkspaceImportPorts, WorkspaceSnapshot } from "../contracts";
import { snapshotWorkspace } from "../workspace";
import { openJournal } from "../journal";

const settingsFault = vi.hoisted(() => ({ afterWrite: null as null | ((path: string) => void) }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync(from: import("node:fs").PathLike, to: import("node:fs").PathLike) {
      fs.renameSync(from, to);
      settingsFault.afterWrite?.(String(to));
    },
    unlinkSync(path: import("node:fs").PathLike) {
      fs.unlinkSync(path);
      settingsFault.afterWrite?.(String(path));
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  settingsFault.afterWrite = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Spider roaming snapshot", GIT_AUTHOR_EMAIL: "roam@example.invalid",
  GIT_COMMITTER_NAME: "Spider roaming snapshot", GIT_COMMITTER_EMAIL: "roam@example.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_CONFIG", "GIT_CONFIG_COUNT"]) delete environment[key];

function command(cwd: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }): Buffer {
  return execFileSync(argv[0], argv.slice(1), {
    cwd, env: { ...environment, ...options?.env }, input: options?.stdin, stdio: [options?.stdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
}
function git(cwd: string, ...args: string[]): string {
  return command(cwd, ["git", ...args]).toString("utf8").trim();
}
function tree(cwd: string, root: string): string {
  const index = join(root, "observed-index");
  copyFileSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "index"), index);
  try {
    command(cwd, ["git", "add", "-A", "--", ".", ":(exclude).spider", ":(exclude).pi-subagents"], { env: { GIT_INDEX_FILE: index } });
    return command(cwd, ["git", "write-tree"], { env: { GIT_INDEX_FILE: index } }).toString("utf8").trim();
  } finally { rmSync(index, { force: true }); }
}
function digest(file: string): string { return createHash("sha256").update(readFileSync(file)).digest("hex"); }

type LfsLocation = "both" | "staged" | "working";
type LfsVariant = { indexTree: string; workingTree: string; refs: readonly string[]; artifact: string; byteLength: number };
const lfsBytes = Buffer.from([0, 3, 255, 17, 0, 128, 12, 9]);
const templateLfs = new Map<LfsLocation, LfsVariant>();
let templateRoot: string, templateHead: string, templateTree: string;
let templateSnapshot: WorkspaceSnapshot, templatePrevious: WorkspaceSnapshot, templateFinal: WorkspaceSnapshot, templateFinalArtifact: string;
let templateSparse: WorkspaceSnapshot, templateSparseArtifact: string;
let templateSparseFull: WorkspaceSnapshot, templateSparseFullArtifact: string;
let templatePreparedDigest: string, templateSparsePreparedDigest: string;
beforeAll(async () => {
  templateRoot = mkdtempSync(join(dirname(scratchDbPath("workspace-template")), "workspace-template-"));
  const source = join(templateRoot, "source"), origin = join(templateRoot, "origin.git");
  mkdirSync(source);
  git(source, "init", "-q", "--initial-branch=main");
  writeFileSync(join(source, "tracked.txt"), "shared\n");
  writeFileSync(join(source, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(source, "staged-only.txt"), "original\n");
  writeFileSync(join(source, "delete.txt"), "delete\n");
  writeFileSync(join(source, "rename-from.txt"), "rename\n");
  writeFileSync(join(source, "mode.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  writeFileSync(join(source, ".gitignore"), "*.generated\nlinkdir\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "shared");
  templateHead = git(source, "rev-parse", "HEAD");
  templateTree = git(source, "write-tree");
  command(templateRoot, ["git", "clone", "--bare", "-q", source, origin]);
  const destination = join(templateRoot, "destination"), unrelated = join(templateRoot, "unrelated");
  command(templateRoot, ["git", "clone", "-q", origin, destination]);
  command(templateRoot, ["git", "clone", "-q", origin, unrelated]);
  writeFileSync(join(unrelated, "sentinel"), "untouched\n");
  const capturePorts = {
    journal: openJournal(join(templateRoot, "capture.db")), limits: { ...DEFAULT_LIMITS }, scratch: join(templateRoot, "capture"), worktreeCommand: null,
    async run(cwd: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }) {
      return command(cwd, ["git", ...argv], options);
    },
  };
  for (const id of ["previous-move", "move-1"]) capturePorts.journal.begin({ id, kind: "workspace-snapshot", machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: null, args: {} });
  templatePrevious = { ...await snapshotWorkspace({ root: destination, cwd: destination, repoKey: "fixture-repo",
    workspaceId: "fixture-workspace", moveId: "previous-move", stage: "final", writers: [] }, capturePorts),
    refs: [], bundle: { kind: "ready", artifactId: "previous-bundle", byteLength: 1 } };
  writeFileSync(join(source, "tracked.txt"), "unpushed\n");
  git(source, "commit", "-q", "-a", "-m", "unpushed");
  const head = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "binary.bin"), Buffer.from([0, 127, 128, 255, 4]));
  git(source, "add", "binary.bin");
  writeFileSync(join(source, "binary.bin"), Buffer.from([255, 9, 0]));
  writeFileSync(join(source, "untracked.bin"), Buffer.from([42, 0, 99]));
  const captured = await snapshotWorkspace({ root: source, cwd: source, repoKey: templatePrevious.repoKey,
    workspaceId: templatePrevious.workspaceId, moveId: "move-1", stage: "pre", writers: [] }, capturePorts);
  const artifact = join(templateRoot, "received.bundle");
  git(source, "bundle", "create", artifact, ...captured.refs, `^${templateHead}`); chmodSync(artifact, 0o600);
  templateSnapshot = { ...captured, prerequisites: [templateHead],
    bundle: { kind: "ready", artifactId: "incoming-bundle", byteLength: statSync(artifact).size } };
  for (const location of ["both", "staged", "working"] as const) buildLfsTemplate(location);
  buildFinalTemplate();
  buildSparseTemplate();
  await buildPreparedTemplate();
  await buildSparsePreparedTemplate();
}, 60000);
afterAll(() => { if (templateRoot) rmSync(templateRoot, { recursive: true, force: true }); });

function buildLfsTemplate(location: LfsLocation): void {
  const source = join(templateRoot, `lfs-source-${location}`);
  cpSync(join(templateRoot, "source"), source, { recursive: true });
  const oid = createHash("sha256").update(lfsBytes).digest("hex");
  writeFileSync(join(source, ".gitattributes"), "lfs.dat filter=lfs -text\n");
  writeFileSync(join(source, "lfs.dat"), `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${lfsBytes.length}\n`);
  git(source, "add", ".gitattributes");
  if (location !== "working") git(source, "add", "lfs.dat");
  if (location === "staged") rmSync(join(source, "lfs.dat"));
  const indexTree = git(source, "write-tree");
  const indexCommit = git(source, "commit-tree", indexTree, "-p", templateSnapshot.head, "-m", "lfs index");
  const workingTree = tree(source, templateRoot);
  const workingCommit = git(source, "commit-tree", workingTree, "-p", indexCommit, "-m", "lfs working");
  const refs = ["refs/spider-roam/move-lfs/pre/index", "refs/spider-roam/move-lfs/pre/working"];
  git(source, "update-ref", refs[0], indexCommit); git(source, "update-ref", refs[1], workingCommit);
  const artifact = join(templateRoot, `lfs-${location}.bundle`);
  git(source, "bundle", "create", artifact, ...refs, `^${templateHead}`); chmodSync(artifact, 0o600);
  templateLfs.set(location, { indexTree, workingTree, refs, artifact, byteLength: statSync(artifact).size });
  rmSync(source, { recursive: true, force: true });
}

function buildFinalTemplate(): void {
  const source = join(templateRoot, "final-source");
  cpSync(join(templateRoot, "source"), source, { recursive: true });
  const preCommit = git(source, "rev-parse", templateSnapshot.refs[1]);
  writeFileSync(join(source, "binary.bin"), Buffer.from([8, 7, 6, 5])); git(source, "add", "binary.bin");
  const indexTree = git(source, "write-tree");
  const indexCommit = git(source, "commit-tree", indexTree, "-p", templateSnapshot.head, "-m", "final index");
  writeFileSync(join(source, "binary.bin"), Buffer.from([4, 3, 2, 1, 0]));
  const workingTree = tree(source, templateRoot);
  if (!command(source, ["git", "show", `${workingTree}:binary.bin`]).equals(Buffer.from([4, 3, 2, 1, 0]))) {
    throw new Error("final fixture did not capture unstaged binary bytes");
  }
  const workingCommit = git(source, "commit-tree", workingTree, "-p", indexCommit, "-m", "final working");
  const refs = ["refs/spider-roam/move-1/final/index", "refs/spider-roam/move-1/final/working"];
  git(source, "update-ref", refs[0], indexCommit); git(source, "update-ref", refs[1], workingCommit);
  templateFinalArtifact = join(templateRoot, "final.bundle");
  git(source, "bundle", "create", templateFinalArtifact, ...refs, `^${templateHead}`, `^${preCommit}`);
  chmodSync(templateFinalArtifact, 0o600);
  templateFinal = { ...templateSnapshot, stage: "final", indexTree, workingTree, refs, prerequisites: [templateHead, preCommit],
    bundle: { kind: "ready", artifactId: "final-bundle", byteLength: statSync(templateFinalArtifact).size } };
  rmSync(source, { recursive: true, force: true });
}

function buildSparseTemplate(): void {
  const source = join(templateRoot, "sparse-source");
  cpSync(join(templateRoot, "source"), source, { recursive: true });
  mkdirSync(join(source, "keep")); mkdirSync(join(source, "skip"));
  writeFileSync(join(source, "keep", "item.txt"), "included\n");
  writeFileSync(join(source, "skip", "item.txt"), "excluded\n");
  git(source, "add", "keep/item.txt", "skip/item.txt");
  const indexTree = git(source, "write-tree");
  const indexCommit = git(source, "commit-tree", indexTree, "-p", templateSnapshot.head, "-m", "sparse index");
  const workingTree = tree(source, templateRoot);
  const workingCommit = git(source, "commit-tree", workingTree, "-p", indexCommit, "-m", "sparse working");
  const refs = ["refs/spider-roam/move-sparse/pre/index", "refs/spider-roam/move-sparse/pre/working"];
  git(source, "update-ref", refs[0], indexCommit); git(source, "update-ref", refs[1], workingCommit);
  templateSparseArtifact = join(templateRoot, "sparse.bundle");
  git(source, "bundle", "create", templateSparseArtifact, ...refs, `^${templateHead}`); chmodSync(templateSparseArtifact, 0o600);
  templateSparse = { ...templateSnapshot, moveId: "move-sparse", indexTree, workingTree, refs,
    sparsePatterns: "/*\n!/*/\n/keep/\n", worktreeConfig: "[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n", sparse: { enabled: true, cone: true },
    bundle: { kind: "ready", artifactId: "incoming-bundle", byteLength: statSync(templateSparseArtifact).size } };
  const finalIndex = git(source, "commit-tree", indexTree, "-p", templateSnapshot.head, "-m", "full index");
  const finalWorking = git(source, "commit-tree", workingTree, "-p", finalIndex, "-m", "full working");
  const finalRefs = ["refs/spider-roam/move-sparse/final/index", "refs/spider-roam/move-sparse/final/working"];
  git(source, "update-ref", finalRefs[0], finalIndex); git(source, "update-ref", finalRefs[1], finalWorking);
  templateSparseFullArtifact = join(templateRoot, "sparse-full.bundle");
  git(source, "bundle", "create", templateSparseFullArtifact, ...finalRefs, `^${templateHead}`, `^${workingCommit}`);
  chmodSync(templateSparseFullArtifact, 0o600);
  templateSparseFull = { ...templateSparse, stage: "final", refs: finalRefs, prerequisites: [templateHead, workingCommit],
    sparsePatterns: null, worktreeConfig: "[core]\n\tsparseCheckout = false\n", sparse: { enabled: false, cone: null },
    bundle: { kind: "ready", artifactId: "sparse-final-bundle", byteLength: statSync(templateSparseFullArtifact).size } };
  rmSync(source, { recursive: true, force: true });
}

async function buildPreparedTemplate(): Promise<void> {
  const f = fixture();
  const { prepareWorkspace } = await import("../workspace-import");
  await prepareWorkspace(f.snapshot, f.destination, f.ports);
  const row = f.ports.journal.read(f.snapshot.moveId).find(entry => entry.action === "workspace-prepared");
  if (!row || typeof row.result.digest !== "string") throw new Error("missing prepared fixture journal");
  templatePreparedDigest = row.result.digest;
  const destination = join(templateRoot, "prepared-destination");
  cpSync(f.destination, destination, { recursive: true });
  const config = join(destination, ".git", "config");
  writeFileSync(config, readFileSync(config, "utf8").replaceAll(join(f.root, "origin.git"), join(templateRoot, "origin.git")));
  const partial = join(templateRoot, "working-applied-destination");
  cpSync(destination, partial, { recursive: true });
  git(partial, "read-tree", templatePrevious.indexTree);
  git(partial, "update-ref", "--no-deref", "HEAD", templatePrevious.head);
  rmSync(f.root, { recursive: true, force: true });
  roots.splice(roots.indexOf(f.root), 1);
}

async function buildSparsePreparedTemplate(): Promise<void> {
  const f = fixture(), snapshot = sparseSnapshot(f);
  const { prepareWorkspace } = await import("../workspace-import");
  await prepareWorkspace(snapshot, f.destination, f.ports);
  const row = f.ports.journal.read(snapshot.moveId).find(entry => entry.action === "workspace-prepared");
  if (!row || typeof row.result.digest !== "string") throw new Error("missing sparse prepared fixture journal");
  templateSparsePreparedDigest = row.result.digest;
  const destination = join(templateRoot, "sparse-prepared-destination");
  cpSync(f.destination, destination, { recursive: true });
  const config = join(destination, ".git", "config");
  writeFileSync(config, readFileSync(config, "utf8").replaceAll(join(f.root, "origin.git"), join(templateRoot, "origin.git")));
  rmSync(f.root, { recursive: true, force: true });
  roots.splice(roots.indexOf(f.root), 1);
}

interface Fixture {
  root: string; destination: string; unrelated: string; snapshot: WorkspaceSnapshot; previous: WorkspaceSnapshot;
  ports: WorkspaceImportPorts; calls: string[][];
  setRepository(value: string | null): void; setPrevious(value: WorkspaceSnapshot | null): void; setArtifact(value: string | null, id?: string): void;
}
function fixture(state: "base" | "prepared" | "completed-unrecorded" | "working-applied" | "sparse-prepared" | "sparse-unrecorded" = "base"): Fixture {
  const root = mkdtempSync(join(dirname(scratchDbPath("workspace-import")), "workspace-import-"));
  roots.push(root);
  const source = join(root, "source"), origin = join(root, "origin.git"), destination = join(root, "destination"), unrelated = join(root, "unrelated");
  for (const name of ["source", "origin.git", "destination", "unrelated", "received.bundle"]) {
    const templateName = name !== "destination" || state === "base" ? name : state === "sparse-prepared" || state === "sparse-unrecorded" ? "sparse-prepared-destination" :
      state === "working-applied" ? "working-applied-destination" : "prepared-destination";
    cpSync(join(templateRoot, templateName), join(root, name), { recursive: true });
  }
  for (const checkout of [destination, unrelated]) {
    const config = join(checkout, ".git", "config");
    writeFileSync(config, readFileSync(config, "utf8").replaceAll(join(templateRoot, "origin.git"), origin));
  }
  const artifact = join(root, "received.bundle");
  const previous: WorkspaceSnapshot = { ...templatePrevious, root: destination };
  const snapshot: WorkspaceSnapshot = { ...(state === "sparse-prepared" || state === "sparse-unrecorded" ? templateSparse : templateSnapshot), root: source };
  const journal = openJournal(join(root, "journal.db"));
  journal.begin({ id: snapshot.moveId, machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: 1, kind: "move", args: {} });
  if (state === "sparse-prepared" || state === "sparse-unrecorded") {
    journal.record(snapshot.moveId, "workspace-config-change", { root: destination, worktreeConfig: null, sparsePatterns: null, worktreeMode: null, sparseMode: null });
    journal.record(snapshot.moveId, "workspace-config-target", { root: destination, digest: templateSparsePreparedDigest,
      worktreeConfig: snapshot.worktreeConfig, sparsePatterns: snapshot.sparsePatterns });
  }
  if (state !== "base") journal.record(snapshot.moveId, state === "prepared" || state === "sparse-prepared" ? "workspace-prepared" : "workspace-prepare-start", {
    root: destination, stage: "pre", digest: state === "sparse-prepared" || state === "sparse-unrecorded" ? templateSparsePreparedDigest : templatePreparedDigest,
    snapshotJson: JSON.stringify(snapshot), previousJson: JSON.stringify(previous), artifactId: "incoming-bundle",
  });
  let repository: string | null = destination, exported: WorkspaceSnapshot | null = previous;
  const received = new Map<string, string | null>([["incoming-bundle", artifact]]);
  const calls: string[][] = [];
  const ports: WorkspaceImportPorts = {
    scratch: join(root, "scratch"), journal, limits: { ...DEFAULT_LIMITS }, worktreeCommand: null,
    async run(cwd, argv, options) { calls.push([...argv]); return command(cwd, argv, options); },
    async resolveCommonRepository(mapping) {
      return mapping.repoKey === snapshot.repoKey && mapping.workspaceId === snapshot.workspaceId ? repository : null;
    },
    async lastExportedSnapshot(checkout) {
      return checkout.repoKey === snapshot.repoKey && checkout.workspaceId === snapshot.workspaceId && checkout.root === destination ? exported : null;
    },
    async verifiedArtifactPath(id) { return received.get(id) ?? null; },
  };
  return {
    root, destination, unrelated, snapshot, previous, ports, calls,
    setRepository(value) { repository = value; }, setPrevious(value) { exported = value; },
    setArtifact(value, id = "incoming-bundle") { received.set(id, value); },
  };
}

function withLfs(f: Fixture, location: LfsLocation = "both"): { snapshot: WorkspaceSnapshot; object: string; bytes: Buffer } {
  const variant = templateLfs.get(location);
  if (!variant) throw new Error("missing LFS fixture");
  const bytes = Buffer.from(lfsBytes), oid = createHash("sha256").update(bytes).digest("hex");
  const artifact = join(f.root, "lfs.bundle"); copyFileSync(variant.artifact, artifact); chmodSync(artifact, 0o600);
  f.setArtifact(artifact);
  f.ports.journal.begin({ id: "move-lfs", machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: 1, kind: "move", args: {} });
  const snapshot: WorkspaceSnapshot = {
    ...f.snapshot, moveId: "move-lfs", indexTree: variant.indexTree, workingTree: variant.workingTree, refs: variant.refs,
    bundle: { kind: "ready", artifactId: "incoming-bundle", byteLength: variant.byteLength },
  };
  const storage = join(f.destination, ".git", "lfs", "objects");
  const object = join(storage, oid.slice(0, 2), oid.slice(2, 4), oid);
  const filter = join(f.root, "fixture-lfs.cjs");
  writeFileSync(filter, `const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
const input = fs.readFileSync(0), text = input.toString('utf8');
if (process.argv[2] === 'smudge') {
  const oid = /^oid sha256:([a-f0-9]{64})$/m.exec(text)?.[1];
  process.stdout.write(fs.readFileSync(path.join(${JSON.stringify(storage)}, oid.slice(0, 2), oid.slice(2, 4), oid)));
} else if (text.startsWith('version https://git-lfs.github.com/spec/v1\\n')) process.stdout.write(input);
else {
  const oid = crypto.createHash('sha256').update(input).digest('hex');
  process.stdout.write('version https://git-lfs.github.com/spec/v1\\noid sha256:' + oid + '\\nsize ' + input.length + '\\n');
}\n`);
  const clean = `${JSON.stringify(process.execPath)} ${JSON.stringify(filter)} clean`;
  const smudge = `${JSON.stringify(process.execPath)} ${JSON.stringify(filter)} smudge`;
  appendFileSync(join(f.destination, ".git", "config"), `\n[filter "lfs"]\n\tclean = ${JSON.stringify(clean)}\n\tsmudge = ${JSON.stringify(smudge)}\n\trequired = true\n`);
  return { snapshot, object, bytes };
}

it.each([
  ["user.name", "Name"], ["user.email", "fixture@example.invalid"], ["author.name", "Name"],
  ["committer.email", "fixture@example.invalid"], ["commit.gpgsign", "true"], ["tag.gpgsign", "true"],
  ["gpg.format", "ssh"], ["gpg.program", "signer"], ["credential.helper", "helper"],
  ["http.extraheader", "secret"], ["http.https://code.example.invalid/.extraheader", "secret"],
  ["url.https://code.example.invalid/.insteadof", "ssh://code.example.invalid/"],
  ["remote.origin.url", "https://code.example.invalid/repo"], ["remote.origin.pushurl", "https://code.example.invalid/repo"],
  ["core.sshcommand", "ssh"], ["core.hookspath", "hooks"], ["core.fsmonitor", "monitor"],
  ["core.editor", "editor"], ["core.pager", "pager"], ["sequence.editor", "editor"],
  ["interactive.difffilter", "filter"], ["merge.custom.driver", "driver"], ["difftool.custom.cmd", "command"],
  ["mergetool.custom.cmd", "command"],
  ["core.worktree", "../outside"], ["core.bare", "true"], ["core.excludesfile", "ignore"],
  ["core.attributesfile", "attributes"], ["commit.template", "template"], ["tool.example.path", "outside"],
  ["tool.build.command", "tool"], ["filter.lfs.clean", "clean"], ["filter.lfs.smudge", "smudge"],
  ["filter.lfs.process", "process"], ["diff.custom.textconv", "convert"], ["alias.shell", "!run"],
  ["include.path", "extra"], ["includeif.gitdir:fixture.path", "extra"],
] as const)("rejects unsafe worktree config key %s", async (key, value) => {
  const { isUnsafeWorktreeConfig } = await import("../workspace");
  expect(isUnsafeWorktreeConfig(key, value)).toBe(true);
}, 5000);

it.each([
  ["core.sparsecheckout", "true"], ["core.sparsecheckoutcone", "true"], ["core.autocrlf", "false"],
  ["filter.lfs.required", "true"], ["alias.short", "status --short"], ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
] as const)("allows non-sensitive worktree config key %s", async (key, value) => {
  const { isUnsafeWorktreeConfig } = await import("../workspace");
  expect(isUnsafeWorktreeConfig(key, value)).toBe(false);
}, 5000);

it.each(["sshCommand = secret-command", "worktree = ../outside"])(
  "refuses unsafe worktree config %s without installing it or checking out files", async setting => {
    const f = fixture();
    const { prepareWorkspace } = await import("../workspace-import");
    const snapshot = { ...f.snapshot, worktreeConfig: `[core]\n  ${setting}\n` };
    await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-config-unsafe/i);
    expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("shared\n");
    expect(f.calls.some(args => args[0] === "git" && args[1] === "fetch")).toBe(false);
  }, 5000,
);

it.each(["missing", "corrupt"] as const)("refuses a %s destination LFS object before checkout", async state => {
  const f = fixture();
  const { snapshot, object, bytes } = withLfs(f);
  if (state === "corrupt") {
    mkdirSync(dirname(object), { recursive: true, mode: 0o700 });
    const changed = Buffer.from(bytes); changed[0] ^= 1;
    writeFileSync(object, changed, { mode: 0o600 });
  }
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow(
    state === "missing" ? /workspace-lfs-object-missing/i : /workspace-lfs-object-invalid/i,
  );
  expect(git(f.destination, "rev-parse", "HEAD")).toBe(f.previous.head);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("shared\n");
  expect(existsSync(join(f.destination, "lfs.dat"))).toBe(false);
  expect(f.calls.some(args => args[0] === "git" && args[1] === "read-tree" && args.includes("-u"))).toBe(false);
}, 5000);

it.each(["staged", "working"] as const)("refuses a missing LFS object present only in the %s tree", async location => {
  const f = fixture();
  const { snapshot } = withLfs(f, location);
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-lfs-object-missing/i);
  expect(git(f.destination, "rev-parse", "HEAD")).toBe(f.previous.head);
  expect(existsSync(join(f.destination, "lfs.dat"))).toBe(false);
}, 5000);

it.each([
  ["base", true], ["base", false], ["completed-unrecorded", true], ["completed-unrecorded", false],
] as const)("%s import excludes machine state (ignored: %s)", async (state, ignored) => {
  const { prepareWorkspace, verifyWorkspace } = await import("../workspace-import");
  const f = fixture(state);
  if (ignored) appendFileSync(join(f.destination, ".git", "info", "exclude"), "\n.spider/\n.pi-subagents/\n");
  const localFiles = [".spider/state.db", ".pi-subagents/run.json"];
  for (const relative of localFiles) {
    const file = join(f.destination, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "machine-local\n");
  }
  const index = join(f.destination, ".git", "index"), before = digest(index);
  const prepared = await prepareWorkspace(f.snapshot, f.destination, f.ports);
  await verifyWorkspace(prepared, f.ports);
  expect(git(f.destination, "write-tree")).toBe(f.snapshot.indexTree);
  expect(git(f.destination, "ls-files").split("\n").filter(path => localFiles.includes(path))).toEqual([]);
  expect(command(f.destination, ["git", "show", ":binary.bin"])).toEqual(Buffer.from([0, 127, 128, 255, 4]));
  for (const relative of localFiles) expect(readFileSync(join(f.destination, relative), "utf8")).toBe("machine-local\n");
  const installed = digest(index);
  await verifyWorkspace(prepared, f.ports);
  expect(digest(index)).toBe(installed);
  if (state === "base") expect(installed).not.toBe(before);
});

it("propagates a real Git staging error instead of accepting an incomplete tree", async () => {
  const f = fixture(), run = f.ports.run;
  f.ports.run = async (cwd, argv, options) => {
    if (argv.includes("add") && options?.env?.GIT_INDEX_FILE) {
      writeFileSync(`${options.env.GIT_INDEX_FILE}.lock`, "occupied\n", { flag: "wx" });
    }
    return run(cwd, argv, options);
  };
  const index = join(f.destination, ".git", "index"), before = digest(index);
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(f.snapshot, f.destination, f.ports)).rejects.toThrow(/index\.lock.*File exists/s);
  expect(f.calls.some(argv => argv.includes("add"))).toBe(true);
  expect(digest(index)).toBe(before);
  expect(git(f.destination, "rev-parse", "HEAD")).toBe(f.previous.head);
});

it("uses a destination LFS object only after its content hash is verified", async () => {
  const f = fixture();
  const { snapshot, object, bytes } = withLfs(f);
  mkdirSync(dirname(object), { recursive: true, mode: 0o700 });
  writeFileSync(object, bytes, { mode: 0o600 });
  const { prepareWorkspace, verifyWorkspace } = await import("../workspace-import");
  const prepared = await prepareWorkspace(snapshot, f.destination, f.ports);
  await verifyWorkspace(prepared, f.ports);
  expect(readFileSync(join(prepared.root, "lfs.dat"))).toEqual(bytes);
}, 5000);

it("returning home reuses the mapped checkout", async () => {
  const f = fixture();
  const { prepareWorkspace, verifyWorkspace } = await import("../workspace-import");
  const previousMappedRoot = f.destination;
  const unrelatedRootDigestBefore = digest(join(f.unrelated, "sentinel"));
  const prepared = await prepareWorkspace(f.snapshot, f.destination, f.ports);
  expect(f.ports.journal.read(f.snapshot.moveId).filter(row => row.action === "workspace-snapshot-refs")).toEqual([{ action: "workspace-snapshot-refs", result: { root: f.destination, refs: f.snapshot.refs.map(ref => ({ ref, oid: git(f.destination, "rev-parse", ref) })) } }]);
  await verifyWorkspace(prepared, f.ports);
  const returnedRoot = prepared.root;
  const destinationHead = git(returnedRoot, "rev-parse", "HEAD");
  const destinationIndexTree = git(returnedRoot, "write-tree");
  const destinationWorkingTree = tree(returnedRoot, f.root);
  const unrelatedRootDigestAfter = digest(join(f.unrelated, "sentinel"));
  expect(destinationHead).toBe(f.snapshot.head);
  expect(destinationIndexTree).toBe(f.snapshot.indexTree);
  expect(destinationWorkingTree).toBe(f.snapshot.workingTree);
  expect(returnedRoot).toBe(previousMappedRoot);
  expect(unrelatedRootDigestAfter).toBe(unrelatedRootDigestBefore);
  expect(readFileSync(join(returnedRoot, "binary.bin"))).toEqual(Buffer.from([255, 9, 0]));
  expect(readFileSync(join(returnedRoot, "untracked.bin"))).toEqual(Buffer.from([42, 0, 99]));
}, 5000);

it("sparse cone and alternate-backed creation installs config before checkout", async () => {
  const f = fixture();
  const artifact = join(f.root, "sparse.bundle"); copyFileSync(templateSparseArtifact, artifact); chmodSync(artifact, 0o600);
  f.setArtifact(artifact);
  f.ports.journal.begin({ id: "move-sparse", machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: 1, kind: "move", args: {} });
  const snapshot: WorkspaceSnapshot = { ...templateSparse, root: f.snapshot.root };
  const alternate = join(f.root, "alternate");
  command(f.root, ["git", "clone", "--shared", "-q", join(f.root, "origin.git"), alternate]);
  expect(existsSync(join(alternate, ".git", "objects", "info", "alternates"))).toBe(true);
  f.setRepository(alternate);
  const target = join(f.root, "new-sparse");
  let configuredBeforeCheckout = false;
  const originalRun = f.ports.run;
  f.ports.run = async (cwd, argv, options) => {
    if (cwd === target && argv[0] === "git" && argv[1] === "read-tree" && argv.includes("-u")) {
      const config = git(target, "rev-parse", "--path-format=absolute", "--git-path", "config.worktree");
      const sparse = git(target, "rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout");
      configuredBeforeCheckout = readFileSync(config, "utf8").includes("sparseCheckoutCone") &&
        readFileSync(sparse, "utf8") === snapshot.sparsePatterns;
    }
    return originalRun(cwd, argv, options);
  };
  const { prepareWorkspace, verifyWorkspace } = await import("../workspace-import");
  const prepared = await prepareWorkspace(snapshot, target, f.ports);
  await verifyWorkspace(prepared, f.ports);
  expect(configuredBeforeCheckout).toBe(true);
  expect(prepared.root).toBe(target);
  expect(git(target, "rev-parse", "HEAD")).toBe(snapshot.head);
  expect(git(target, "write-tree")).toBe(snapshot.indexTree);
  expect(tree(target, f.root)).toBe(snapshot.workingTree);
  expect(readFileSync(join(target, "keep", "item.txt"), "utf8")).toBe("included\n");
  expect(existsSync(join(target, "skip", "item.txt"))).toBe(false);
  expect(git(target, "ls-files", "-t", "--", "skip/item.txt")).toBe("S skip/item.txt");
  expect(git(alternate, "config", "--get", "extensions.worktreeConfig")).toBe("true");
  expect(f.ports.journal.read(snapshot.moveId).some(row => row.action === "workspace-shared-config-change")).toBe(true);
}, 5000);

function withMappedConfig(f: Fixture, config: string | null, sparse: string | null): WorkspaceSnapshot {
  appendFileSync(join(f.destination, ".git", "config"), "\n[extensions]\n\tworktreeConfig = true\n");
  if (config !== null) writeFileSync(join(f.destination, ".git", "config.worktree"), config, { mode: 0o600 });
  if (sparse !== null) writeFileSync(join(f.destination, ".git", "info", "sparse-checkout"), sparse, { mode: 0o600 });
  const previous = { ...f.previous, worktreeConfig: config, sparsePatterns: sparse };
  f.previous = previous; f.setPrevious(previous);
  return previous;
}
function sparseSnapshot(f: Fixture): WorkspaceSnapshot {
  const artifact = join(f.root, "sparse.bundle"); copyFileSync(templateSparseArtifact, artifact); chmodSync(artifact, 0o600);
  f.setArtifact(artifact);
  f.ports.journal.begin({ id: "move-sparse", machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: 1, kind: "move", args: {} });
  return { ...templateSparse, root: f.snapshot.root };
}

it("refuses an invalid saved branch before touching the checkout", async () => {
  const f = fixture(), snapshot = { ...f.snapshot, branch: "refs/heads/bad..name" };
  const before = readFileSync(join(f.destination, ".git", "index"));
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-branch-invalid/i);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("shared\n");
  expect(readFileSync(join(f.destination, ".git", "index"))).toEqual(before);
  expect(f.ports.journal.read(snapshot.moveId)).toEqual([]);
}, 5000);

it("refuses an unreadable saved branch before touching the checkout", async () => {
  const f = fixture(), run = f.ports.run;
  f.ports.run = async (cwd, argv, options) => {
    if (argv[0] === "git" && (argv.includes("rev-parse") || argv.includes("for-each-ref")) && argv.includes("refs/heads/main")) {
      throw new Error("synthetic ref read failure");
    }
    return run(cwd, argv, options);
  };
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(f.snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-branch-unavailable/i);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("shared\n");
  expect(f.ports.journal.read(f.snapshot.moveId)).toEqual([]);
}, 5000);

it("refuses a mapped destination that is not the Git worktree root", async () => {
  const f = fixture(), nested = join(f.destination, "nested");
  mkdirSync(nested); writeFileSync(join(f.destination, "tracked.txt"), "local unrelated edit\n");
  f.ports.lastExportedSnapshot = async () => ({ ...f.previous, root: nested });
  const before = readFileSync(join(f.destination, ".git", "index"));
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(f.snapshot, nested, f.ports)).rejects.toThrow(/workspace-checkout-root-mismatch/i);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("local unrelated edit\n");
  expect(readFileSync(join(f.destination, ".git", "index"))).toEqual(before);
  expect(f.ports.journal.read(f.snapshot.moveId)).toEqual([]);
}, 5000);

it("refuses a mapped checkout whose effective sparse cone setting changed since export", async () => {
  const f = fixture();
  appendFileSync(join(f.destination, ".git", "config"), "\n[core]\n\tsparseCheckoutCone = true\n");
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(f.snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-config-diverged.*sparse\.cone/i);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("shared\n");
  expect(f.ports.journal.read(f.snapshot.moveId)).toEqual([]);
}, 5000);

it("refuses a snapshot missing its effective sparse settings", async () => {
  const f = fixture(), snapshot = { ...f.snapshot };
  Reflect.deleteProperty(snapshot, "sparse");
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-snapshot-invalid/i);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("shared\n");
}, 5000);

it("installs source effective cone settings when portable config omits them", async () => {
  const f = fixture(), snapshot = { ...sparseSnapshot(f), worktreeConfig: "[checkout]\n\tworkers = 2\n" };
  const { prepareWorkspace } = await import("../workspace-import");
  await prepareWorkspace(snapshot, f.destination, f.ports);
  expect(git(f.destination, "config", "--worktree", "--type=bool", "--get", "core.sparseCheckout")).toBe("true");
  expect(git(f.destination, "config", "--worktree", "--type=bool", "--get", "core.sparseCheckoutCone")).toBe("true");
  expect(existsSync(join(f.destination, "skip", "item.txt"))).toBe(false);
}, 5000);

it("overrides inherited cone=true when the enabled source left cone unset", async () => {
  const f = fixture();
  appendFileSync(join(f.destination, ".git", "config"), "\n[core]\n\tsparseCheckoutCone = true\n");
  f.previous = { ...f.previous, sparse: { enabled: false, cone: true } }; f.setPrevious(f.previous);
  const snapshot = { ...sparseSnapshot(f), worktreeConfig: "[checkout]\n\tworkers = 2\n", sparse: { enabled: true, cone: null } };
  const { prepareWorkspace } = await import("../workspace-import");
  const prepared = await prepareWorkspace(snapshot, f.destination, f.ports);
  expect(git(f.destination, "config", "--worktree", "--type=bool", "--get", "core.sparseCheckoutCone")).toBe("false");
  expect(prepared.snapshot.sparse.cone).toBeNull();
  expect(prepared.adjustments).toEqual(["sparse-cone-defaulted-to-false"]);
  expect(f.ports.journal.read(snapshot.moveId).some(row => row.action === "workspace-sparse-cone-override" &&
    row.result.root === f.destination && row.result.value === false)).toBe(true);
}, 5000);

it("abort removes a defaulted cone override and preserves the inherited true value", async () => {
  const f = fixture("sparse-prepared");
  appendFileSync(join(f.destination, ".git", "config"), "\n[core]\n\tsparseCheckoutCone = true\n");
  f.previous = { ...f.previous, sparse: { enabled: false, cone: true } }; f.setPrevious(f.previous);
  const snapshot = { ...f.snapshot, worktreeConfig: "[checkout]\n\tworkers = 2\n", sparse: { enabled: true, cone: null } };
  const config = "[checkout]\n\tworkers = 2\n[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = false\n";
  writeFileSync(join(f.destination, ".git", "config.worktree"), config, { mode: 0o600 });
  const digest = createHash("sha256").update(JSON.stringify([
    snapshot.repoKey, snapshot.workspaceId, snapshot.moveId, snapshot.stage, snapshot.head, snapshot.branch,
    snapshot.objectFormat, snapshot.indexTree, snapshot.workingTree, snapshot.relativeCwd, snapshot.sparsePatterns,
    snapshot.worktreeConfig, snapshot.normalization, snapshot.sparse, snapshot.refs, snapshot.prerequisites, snapshot.bundle,
  ])).digest("hex");
  f.ports.journal.record(snapshot.moveId, "workspace-config-target", { root: f.destination, digest,
    worktreeConfig: config, sparsePatterns: snapshot.sparsePatterns });
  f.ports.journal.record(snapshot.moveId, "workspace-prepared", { root: f.destination, stage: "pre", digest,
    snapshotJson: JSON.stringify(snapshot), previousJson: JSON.stringify(f.previous), artifactId: "incoming-bundle" });
  const { abortWorkspace } = await import("../workspace-import");
  await abortWorkspace({ root: f.destination, snapshot, previous: f.previous, moveId: snapshot.moveId,
    adjustments: ["sparse-cone-defaulted-to-false"] }, f.ports);
  expect(existsSync(join(f.destination, ".git", "config.worktree"))).toBe(false);
  expect(git(f.destination, "config", "--local", "--type=bool", "--get", "core.sparseCheckoutCone")).toBe("true");
}, 5000);

it("replaces matching mapped sparse patterns and safe worktree config", async () => {
  const f = fixture(), oldConfig = "[core]\n\tsparseCheckout = false\n[checkout]\n\tworkers = 2\n", oldSparse = "/*\n!/*/\n/old/\n";
  withMappedConfig(f, oldConfig, oldSparse);
  const snapshot = sparseSnapshot(f);
  const { prepareWorkspace } = await import("../workspace-import");
  const prepared = await prepareWorkspace(snapshot, f.destination, f.ports);
  expect(prepared.root).toBe(f.destination);
  expect(readFileSync(join(f.destination, ".git", "config.worktree"), "utf8")).toBe(snapshot.worktreeConfig);
  expect(readFileSync(join(f.destination, ".git", "info", "sparse-checkout"), "utf8")).toBe(snapshot.sparsePatterns);
  expect(readFileSync(join(f.destination, "keep", "item.txt"), "utf8")).toBe("included\n");
  expect(existsSync(join(f.destination, "skip", "item.txt"))).toBe(false);
  expect(f.ports.journal.read(snapshot.moveId).some(row => row.action === "workspace-config-change" &&
    row.result.worktreeConfig === oldConfig && row.result.sparsePatterns === oldSparse)).toBe(true);
}, 5000);

it("refuses an existing file in a path newly materialized by sparse expansion", async () => {
  const f = fixture("sparse-prepared");
  const { prepareWorkspace } = await import("../workspace-import");
  const local = join(f.destination, "skip", "item.txt");
  mkdirSync(dirname(local), { recursive: true }); writeFileSync(local, "local data\n");
  const configBefore = readFileSync(join(f.destination, ".git", "config.worktree"));
  const patternsBefore = readFileSync(join(f.destination, ".git", "info", "sparse-checkout"));
  const writes: string[] = [];
  settingsFault.afterWrite = path => {
    if (path === join(f.destination, ".git", "config.worktree") || path === join(f.destination, ".git", "info", "sparse-checkout")) writes.push(path);
  };
  const run = f.ports.run; let checkedRules = false;
  f.ports.run = async (cwd, argv, options) => {
    if (argv.includes("check-rules")) { checkedRules = true; throw new Error("unsupported git command"); }
    return run(cwd, argv, options);
  };
  const artifact = join(f.root, "sparse-full.bundle"); copyFileSync(templateSparseFullArtifact, artifact); chmodSync(artifact, 0o600);
  f.setArtifact(artifact, "sparse-final-bundle");
  await expect(prepareWorkspace({ ...templateSparseFull, root: f.snapshot.root }, f.destination, f.ports))
    .rejects.toThrow(/workspace-apply-refused.*skip\/item\.txt/i);
  expect(readFileSync(local, "utf8")).toBe("local data\n");
  expect(readFileSync(join(f.destination, ".git", "config.worktree"))).toEqual(configBefore);
  expect(readFileSync(join(f.destination, ".git", "info", "sparse-checkout"))).toEqual(patternsBefore);
  expect(checkedRules).toBe(false);
  expect(writes).toEqual([]);
}, 5000);

it("expands a cone checkout to full without requiring check-rules", async () => {
  const f = fixture("sparse-prepared");
  const { prepareWorkspace } = await import("../workspace-import");
  const run = f.ports.run; let checkedRules = false;
  f.ports.run = async (cwd, argv, options) => {
    if (argv.includes("check-rules")) { checkedRules = true; throw new Error("unsupported git command"); }
    return run(cwd, argv, options);
  };
  const artifact = join(f.root, "sparse-full.bundle"); copyFileSync(templateSparseFullArtifact, artifact); chmodSync(artifact, 0o600);
  f.setArtifact(artifact, "sparse-final-bundle");
  await prepareWorkspace({ ...templateSparseFull, root: f.snapshot.root }, f.destination, f.ports);
  expect(checkedRules).toBe(false);
  expect(readFileSync(join(f.destination, "skip", "item.txt"), "utf8")).toBe("excluded\n");
  expect(git(f.destination, "ls-files", "-t", "--", "skip/item.txt")).toBe("H skip/item.txt");
  expect(existsSync(join(f.destination, ".git", "info", "sparse-checkout"))).toBe(false);
}, 5000);

it("restores cone sparse bits when index-only resets leave every path included", async () => {
  const f = fixture(), snapshot = sparseSnapshot(f);
  const { prepareWorkspace } = await import("../workspace-import");
  const run = f.ports.run;
  f.ports.run = async (cwd, argv, options) => {
    const result = await run(cwd, argv, options);
    if (argv.includes("read-tree") && argv.includes("-i")) {
      const paths = command(cwd, ["git", "ls-files", "-z"], options);
      if (paths.length) command(cwd, ["git", "update-index", "--no-skip-worktree", "-z", "--stdin"], { ...options, stdin: paths });
    }
    return result;
  };
  await prepareWorkspace(snapshot, f.destination, f.ports);
  expect(git(f.destination, "ls-files", "-t", "--", "skip/item.txt")).toBe("S skip/item.txt");
  expect(readFileSync(join(f.destination, "keep", "item.txt"), "utf8")).toBe("included\n");
  expect(existsSync(join(f.destination, "skip", "item.txt"))).toBe(false);
}, 5000);

it("restores a non-cone checkout with excluded paths marked skip-worktree", async () => {
  const f = fixture(), snapshot = { ...sparseSnapshot(f),
    worktreeConfig: "[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = false\n", sparse: { enabled: true, cone: false } };
  const { prepareWorkspace } = await import("../workspace-import");
  const prepared = await prepareWorkspace(snapshot, f.destination, f.ports);
  expect(prepared.adjustments).toEqual([]);
  expect(readFileSync(join(f.destination, "keep", "item.txt"), "utf8")).toBe("included\n");
  expect(existsSync(join(f.destination, "skip", "item.txt"))).toBe(false);
  expect(git(f.destination, "ls-files", "-t", "--", "skip/item.txt")).toBe("S skip/item.txt");
}, 5000);

it("requires Git 2.41 for non-cone sparse rules without mutating the checkout", async () => {
  const f = fixture("sparse-prepared");
  const { prepareWorkspace } = await import("../workspace-import");
  const configBefore = readFileSync(join(f.destination, ".git", "config.worktree"));
  const run = f.ports.run;
  f.ports.run = async (cwd, argv, options) => {
    if (argv.includes("check-rules")) throw new Error("unsupported git command");
    return run(cwd, argv, options);
  };
  const artifact = join(f.root, "sparse-full.bundle"); copyFileSync(templateSparseFullArtifact, artifact); chmodSync(artifact, 0o600);
  f.setArtifact(artifact, "sparse-final-bundle");
  const final = { ...templateSparseFull, root: f.snapshot.root, sparsePatterns: "/keep/\n/skip/\n",
    worktreeConfig: "[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = false\n", sparse: { enabled: true, cone: false } };
  await expect(prepareWorkspace(final, f.destination, f.ports)).rejects.toThrow(/workspace-sparse-inspection-unavailable.*2\.41/i);
  expect(readFileSync(join(f.destination, ".git", "config.worktree"))).toEqual(configBefore);
  expect(existsSync(join(f.destination, "skip", "item.txt"))).toBe(false);
}, 5000);

it("abort restores prior mapped sparse and worktree config byte for byte", async () => {
  const f = fixture(), oldConfig = "[core]\n\tsparseCheckout = false\n[checkout]\n\tworkers = 2\n", oldSparse = "/*\n!/*/\n/old/\n";
  withMappedConfig(f, oldConfig, oldSparse);
  const snapshot = sparseSnapshot(f);
  const { prepareWorkspace, abortWorkspace } = await import("../workspace-import");
  const prepared = await prepareWorkspace(snapshot, f.destination, f.ports);
  expect(readFileSync(join(f.destination, ".git", "config.worktree"), "utf8")).toBe(snapshot.worktreeConfig);
  await abortWorkspace(prepared, f.ports);
  expect(readFileSync(join(f.destination, ".git", "config.worktree"), "utf8")).toBe(oldConfig);
  expect(readFileSync(join(f.destination, ".git", "info", "sparse-checkout"), "utf8")).toBe(oldSparse);
  expect(tree(f.destination, f.root)).toBe(f.previous.workingTree);
}, 5000);

it.each(["worktreeConfig", "sparsePatterns"] as const)("refuses a mapped checkout with changed %s without listing values", async setting => {
  const f = fixture(), oldConfig = "[core]\n\tsparseCheckout = false\n", oldSparse = "/*\n!/*/\n/old/\n";
  withMappedConfig(f, oldConfig, oldSparse);
  const file = setting === "worktreeConfig" ? join(f.destination, ".git", "config.worktree") : join(f.destination, ".git", "info", "sparse-checkout");
  writeFileSync(file, setting === "worktreeConfig" ? "[core]\n\tsparseCheckout = false\n[fixture]\n\tmarker = PRIVATE-VALUE\n" : "/PRIVATE-VALUE/\n");
  const { prepareWorkspace } = await import("../workspace-import");
  let failure: unknown;
  try { await prepareWorkspace(f.snapshot, f.destination, f.ports); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("changed configuration was not refused");
  expect(failure.message).toMatch(/workspace-config-diverged/i);
  expect(failure.message).toContain(setting);
  expect(failure.message).not.toContain("PRIVATE-VALUE");
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("shared\n");
  expect(f.ports.journal.read(f.snapshot.moveId)).toEqual([]);
}, 5000);

it("custom worktree command preserves no-checkout order", async () => {
  const f = fixture(), target = join(f.root, "custom-checkout"), script = join(f.root, "worktree-tool.sh");
  writeFileSync(script, "#!/bin/sh\nexec git worktree add \"$@\"\n", { mode: 0o700 });
  f.ports.worktreeCommand = ["/bin/sh", script];
  let noCheckoutObserved = false;
  const originalRun = f.ports.run;
  f.ports.run = async (cwd, argv, options) => {
    const result = await originalRun(cwd, argv, options);
    if (argv[0] === "/bin/sh" && argv[1] === script) {
      noCheckoutObserved = !existsSync(join(target, "tracked.txt")) && git(target, "ls-files") === "";
    }
    return result;
  };
  const { prepareWorkspace } = await import("../workspace-import");
  const prepared = await prepareWorkspace(f.snapshot, target, f.ports);
  expect(noCheckoutObserved).toBe(true);
  expect(f.calls.some(args => args[0] === "/bin/sh" && args[1] === script &&
    args[2] === "--detach" && args[3] === "--no-checkout")).toBe(true);
  expect(git(prepared.root, "rev-parse", "HEAD")).toBe(f.snapshot.head);
  expect(tree(prepared.root, f.root)).toBe(f.snapshot.workingTree);
}, 5000);

it("restores staged-only binary, deletion, rename, mode and ignored-file behavior", async () => {
  const f = fixture(), source = f.snapshot.root;
  writeFileSync(join(source, "staged-only.txt"), "staged version\n");
  git(source, "add", "staged-only.txt");
  writeFileSync(join(source, "staged-only.txt"), "original\n");
  git(source, "rm", "-q", "delete.txt");
  git(source, "mv", "rename-from.txt", "renamed.txt");
  chmodSync(join(source, "mode.sh"), 0o755); git(source, "add", "mode.sh");
  writeFileSync(join(source, "ignored.generated"), "not transferred\n");
  const indexTree = git(source, "write-tree");
  const indexCommit = git(source, "commit-tree", indexTree, "-p", f.snapshot.head, "-m", "complex index");
  const workingTree = tree(source, f.root);
  const workingCommit = git(source, "commit-tree", workingTree, "-p", indexCommit, "-m", "complex working");
  const refs = ["refs/spider-roam/move-complex/pre/index", "refs/spider-roam/move-complex/pre/working"];
  git(source, "update-ref", refs[0], indexCommit); git(source, "update-ref", refs[1], workingCommit);
  const artifact = join(f.root, "complex.bundle");
  git(source, "bundle", "create", artifact, ...refs, `^${f.previous.head}`); chmodSync(artifact, 0o600);
  f.setArtifact(artifact);
  f.ports.journal.begin({ id: "move-complex", machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: 1, kind: "move", args: {} });
  const snapshot: WorkspaceSnapshot = {
    ...f.snapshot, moveId: "move-complex", indexTree, workingTree, refs,
    bundle: { kind: "ready", artifactId: "incoming-bundle", byteLength: statSync(artifact).size },
  };
  const { prepareWorkspace } = await import("../workspace-import");
  const prepared = await prepareWorkspace(snapshot, f.destination, f.ports);
  expect(git(prepared.root, "write-tree")).toBe(indexTree);
  expect(tree(prepared.root, f.root)).toBe(workingTree);
  expect(git(prepared.root, "show", ":staged-only.txt")).toBe("staged version");
  expect(readFileSync(join(prepared.root, "staged-only.txt"), "utf8")).toBe("original\n");
  expect(existsSync(join(prepared.root, "delete.txt"))).toBe(false);
  expect(existsSync(join(prepared.root, "rename-from.txt"))).toBe(false);
  expect(readFileSync(join(prepared.root, "renamed.txt"), "utf8")).toBe("rename\n");
  expect(statSync(join(prepared.root, "mode.sh")).mode & 0o111).not.toBe(0);
  expect(existsSync(join(prepared.root, "ignored.generated"))).toBe(false);
}, 5000);

it("a prepared checkout retry recognizes its journaled trees", async () => {
  const f = fixture();
  const { prepareWorkspace } = await import("../workspace-import");
  const first = await prepareWorkspace(f.snapshot, f.destination, f.ports);
  const fetchCount = f.calls.filter(args => args[0] === "git" && args[1] === "fetch").length;
  const second = await prepareWorkspace(f.snapshot, f.destination, f.ports);
  expect(second).toEqual(first);
  expect(f.calls.filter(args => args[0] === "git" && args[1] === "fetch")).toHaveLength(fetchCount);
  expect(tree(f.destination, f.root)).toBe(f.snapshot.workingTree);
}, 5000);

it("final delta reuses the prepared tree and preserves the original abort baseline", async () => {
  const f = fixture("prepared");
  const { prepareWorkspace, abortWorkspace } = await import("../workspace-import");
  const originFetches = f.calls.filter(args => args[0] === "git" && args[1] === "fetch" && args.includes("origin")).length;
  const artifact = join(f.root, "final.bundle"); copyFileSync(templateFinalArtifact, artifact); chmodSync(artifact, 0o600);
  f.setArtifact(artifact, "final-bundle");
  const final: WorkspaceSnapshot = { ...templateFinal, root: f.snapshot.root };
  const prepared = await prepareWorkspace(final, f.destination, f.ports);
  expect(prepared.previous).toEqual(f.previous);
  expect(git(f.destination, "write-tree")).toBe(final.indexTree);
  expect(tree(f.destination, f.root)).toBe(final.workingTree);
  expect(readFileSync(join(f.destination, "binary.bin"))).toEqual(Buffer.from([4, 3, 2, 1, 0]));
  expect(f.calls.filter(args => args[0] === "git" && args[1] === "fetch" && args.includes("origin"))).toHaveLength(originFetches);
  await abortWorkspace(prepared, f.ports);
  expect(git(f.destination, "rev-parse", "HEAD")).toBe(f.previous.head);
  expect(tree(f.destination, f.root)).toBe(f.previous.workingTree);
}, 5000);

it("retries a completed preparation if its final journal record was interrupted", async () => {
  const f = fixture("completed-unrecorded");
  const { prepareWorkspace } = await import("../workspace-import");
  const prepared = await prepareWorkspace(f.snapshot, f.destination, f.ports);
  expect(prepared.previous).toEqual(f.previous);
  expect(git(f.destination, "rev-parse", "HEAD")).toBe(f.snapshot.head);
  expect(git(f.destination, "write-tree")).toBe(f.snapshot.indexTree);
  expect(tree(f.destination, f.root)).toBe(f.snapshot.workingTree);
  expect(f.ports.journal.read(f.snapshot.moveId).some(row => row.action === "workspace-prepared")).toBe(true);
}, 5000);

it("refuses an old partial settings journal without transition evidence", async () => {
  const f = fixture("sparse-unrecorded");
  const artifact = join(f.root, "sparse.bundle"); copyFileSync(templateSparseArtifact, artifact); chmodSync(artifact, 0o600);
  f.setArtifact(artifact);
  const before = observeSettings(f.destination);
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(f.snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-journal-invalid/i);
  expect(observeSettings(f.destination)).toEqual(before);
}, 5000);

it("retries a journaled configuration already installed before interruption", async () => {
  const f = fixture(), snapshot = sparseSnapshot(f);
  const { prepareWorkspace } = await import("../workspace-import");
  const record = f.ports.journal.record.bind(f.ports.journal);
  f.ports.journal.record = (id, action, result) => {
    record(id, action, result);
    if (action === "workspace-config-installed") throw new Error("simulated preparation interruption");
  };
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow("simulated preparation interruption");
  f.ports.journal.record = record;
  f.ports.journal.record(snapshot.moveId, "move-transfer-diagnostic", { phase: "participant-import" });
  f.ports.journal.record(snapshot.moveId, "move-import-intent", { root: f.destination });
  const run = f.ports.run;
  f.ports.run = async (cwd, argv, options) => {
    if (argv[0] === "git" && (argv[1] === "fetch" || argv[1] === "bundle")) throw new Error("import source offline");
    return run(cwd, argv, options);
  };
  const prepared = await prepareWorkspace(snapshot, f.destination, f.ports);
  expect(prepared.previous).toEqual(f.previous);
  expect(readFileSync(join(f.destination, ".git", "config.worktree"), "utf8")).toBe(snapshot.worktreeConfig);
  expect(git(f.destination, "ls-files", "-t", "--", "skip/item.txt")).toBe("S skip/item.txt");
}, 5000);

async function interruptedInstalledFixture() {
  const f = fixture(), snapshot = sparseSnapshot(f);
  const { prepareWorkspace } = await import("../workspace-import");
  const record = f.ports.journal.record.bind(f.ports.journal);
  f.ports.journal.record = (id, action, result) => {
    record(id, action, result);
    if (action === "workspace-config-installed") throw new Error("simulated preparation interruption");
  };
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow("simulated preparation interruption");
  f.ports.journal.record = record;
  return { f, snapshot, prepareWorkspace };
}

it.each(["config", "tracked", "hidden"] as const)("refuses a %s edit after configuration installation was interrupted", async edit => {
  const { f, snapshot, prepareWorkspace } = await interruptedInstalledFixture();
  const file = edit === "config" ? join(f.destination, ".git", "config.worktree")
    : edit === "tracked" ? join(f.destination, "tracked.txt") : join(f.destination, "skip", "item.txt");
  mkdirSync(dirname(file), { recursive: true });
  const edited = edit === "config" ? "[core]\n\tsparseCheckout = false\n" : "user edit\n";
  writeFileSync(file, edited);
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-recovery-diverged/i);
  expect(readFileSync(file, "utf8")).toBe(edited);
}, 5000);

it("finishes an installed configuration after the preparation record reply is interrupted", async () => {
  const { f, snapshot, prepareWorkspace } = await interruptedInstalledFixture();
  const run = f.ports.run;
  f.ports.run = async (cwd, argv, options) => {
    if (argv[0] === "git" && argv[1] === "fetch") throw new Error("origin offline");
    return run(cwd, argv, options);
  };
  const record = f.ports.journal.record.bind(f.ports.journal);
  f.ports.journal.record = (id, action, result) => {
    record(id, action, result);
    if (action === "workspace-prepared") throw new Error("simulated journal reply interruption");
  };
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow("simulated journal reply interruption");
  f.ports.journal.record = record;
  const prepared = await prepareWorkspace(snapshot, f.destination, f.ports);
  expect(prepared.previous).toEqual(f.previous);
  expect(f.ports.journal.read(snapshot.moveId).filter(row => row.action === "workspace-prepared")).toHaveLength(1);
  expect(git(f.destination, "ls-files", "-t", "--", "skip/item.txt")).toBe("S skip/item.txt");
}, 5000);

it("aborts a resumed installed configuration back to the original checkout", async () => {
  const { f, snapshot, prepareWorkspace } = await interruptedInstalledFixture();
  const { abortWorkspace } = await import("../workspace-import");
  const prepared = await prepareWorkspace(snapshot, f.destination, f.ports);
  await abortWorkspace(prepared, f.ports);
  expect(git(f.destination, "rev-parse", "HEAD")).toBe(f.previous.head);
  expect(git(f.destination, "write-tree")).toBe(f.previous.indexTree);
  expect(tree(f.destination, f.root)).toBe(f.previous.workingTree);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("shared\n");
}, 5000);

it("retries an installed final-stage configuration without reimporting its bundle", async () => {
  const f = fixture("sparse-prepared"), artifact = join(f.root, "sparse-full.bundle");
  copyFileSync(templateSparseFullArtifact, artifact); chmodSync(artifact, 0o600);
  f.setArtifact(artifact, "sparse-final-bundle");
  const snapshot = { ...templateSparseFull, root: f.snapshot.root };
  const { prepareWorkspace, abortWorkspace } = await import("../workspace-import");
  const record = f.ports.journal.record.bind(f.ports.journal);
  f.ports.journal.record = (id, action, result) => {
    record(id, action, result);
    if (action === "workspace-config-installed") throw new Error("simulated preparation interruption");
  };
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow("simulated preparation interruption");
  f.ports.journal.record = record;
  const run = f.ports.run;
  f.ports.run = async (cwd, argv, options) => {
    if (argv[0] === "git" && argv[1] === "bundle") throw new Error("bundle unavailable");
    return run(cwd, argv, options);
  };
  const prepared = await prepareWorkspace(snapshot, f.destination, f.ports);
  expect(prepared.previous).toEqual(f.previous);
  expect(readFileSync(join(f.destination, "skip", "item.txt"), "utf8")).toBe("excluded\n");
  await abortWorkspace(prepared, f.ports);
  expect(tree(f.destination, f.root)).toBe(f.previous.workingTree);
}, 5000);

it("startup recovery rolls installed settings back without completing preparation", async () => {
  const { f, snapshot } = await interruptedInstalledFixture();
  const { recoverInterruptedWorkspace } = await import("../workspace-import");
  await recoverInterruptedWorkspace(snapshot, f.destination, f.destination, f.ports);
  expect(existsSync(join(f.destination, ".git", "config.worktree"))).toBe(false);
  expect(existsSync(join(f.destination, ".git", "info", "sparse-checkout"))).toBe(false);
  expect(f.ports.journal.read(snapshot.moveId).some(row => row.action === "workspace-prepared")).toBe(false);
}, 5000);

it("resumes a rollback started after installation instead of completing it forward", async () => {
  const { f, snapshot, prepareWorkspace } = await interruptedInstalledFixture();
  const { recoverInterruptedWorkspace } = await import("../workspace-import");
  const record = f.ports.journal.record.bind(f.ports.journal);
  f.ports.journal.record = (id, action, result) => {
    record(id, action, result);
    if (action === "workspace-settings-recovery-start") throw new Error("simulated recovery interruption");
  };
  await expect(recoverInterruptedWorkspace(snapshot, f.destination, f.destination, f.ports)).rejects.toThrow("simulated recovery interruption");
  f.ports.journal.record = record;
  const prepared = await prepareWorkspace(snapshot, f.destination, f.ports);
  expect(prepared.previous).toEqual(f.previous);
  expect(f.ports.journal.read(snapshot.moveId).some(row => row.action === "workspace-settings-recovery-complete")).toBe(true);
  expect(git(f.destination, "ls-files", "-t", "--", "skip/item.txt")).toBe("S skip/item.txt");
}, 5000);

it("resumes after the working tree is applied but before the real index is written", async () => {
  const f = fixture("working-applied");
  const { prepareWorkspace } = await import("../workspace-import");
  expect(git(f.destination, "write-tree")).toBe(f.previous.indexTree);
  const prepared = await prepareWorkspace(f.snapshot, f.destination, f.ports);
  expect(prepared.previous).toEqual(f.previous);
  expect(git(f.destination, "rev-parse", "HEAD")).toBe(f.snapshot.head);
  expect(git(f.destination, "write-tree")).toBe(f.snapshot.indexTree);
  expect(tree(f.destination, f.root)).toBe(f.snapshot.workingTree);
}, 5000);

it("resumes an interrupted new no-checkout worktree without recreating it", async () => {
  const f = fixture("prepared"), destination = join(f.root, "created-worktree");
  f.setRepository(f.destination);
  git(f.destination, "worktree", "add", "--detach", "--no-checkout", destination, f.snapshot.head);
  f.ports.journal.record(f.snapshot.moveId, "workspace-prepare-start", {
    root: destination, stage: "pre", digest: templatePreparedDigest, snapshotJson: JSON.stringify(f.snapshot), previousJson: null,
  });
  const { prepareWorkspace } = await import("../workspace-import");
  expect(existsSync(destination)).toBe(true);
  expect(existsSync(join(destination, "tracked.txt"))).toBe(false);
  const createdBefore = f.calls.filter(args => args[0] === "git" && args[1] === "worktree" && args[2] === "add").length;
  const prepared = await prepareWorkspace(f.snapshot, destination, f.ports);
  expect(prepared.previous).toBeNull();
  expect(f.calls.filter(args => args[0] === "git" && args[1] === "worktree" && args[2] === "add")).toHaveLength(createdBefore);
  expect(git(destination, "write-tree")).toBe(f.snapshot.indexTree);
  expect(tree(destination, f.root)).toBe(f.snapshot.workingTree);
}, 5000);

it("a prepared checkout accepts an equivalent snapshot after JSON key reordering", async () => {
  const f = fixture();
  const { prepareWorkspace, verifyWorkspace } = await import("../workspace-import");
  const first = await prepareWorkspace(f.snapshot, f.destination, f.ports);
  const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, reorder(item)])) : value;
  const restored = reorder(JSON.parse(JSON.stringify(f.snapshot))) as WorkspaceSnapshot;
  const retried = await prepareWorkspace(restored, f.destination, f.ports);
  await verifyWorkspace(retried, f.ports);
  const reversed: WorkspaceSnapshot = { ...restored, normalization: { eol: restored.normalization.eol, autocrlf: restored.normalization.autocrlf } };
  await verifyWorkspace(await prepareWorkspace(reversed, f.destination, f.ports), f.ports);
  expect(retried.snapshot).toEqual(first.snapshot);
  expect(git(f.destination, "rev-parse", "HEAD")).toBe(f.snapshot.head);
  expect(git(f.destination, "write-tree")).toBe(f.snapshot.indexTree);
  expect(tree(f.destination, f.root)).toBe(f.snapshot.workingTree);
}, 5000);

it("abort restores unchanged prepared trees to the prior mapped checkout", async () => {
  const f = fixture();
  const { prepareWorkspace, abortWorkspace } = await import("../workspace-import");
  const prepared = await prepareWorkspace(f.snapshot, f.destination, f.ports);
  await abortWorkspace(prepared, f.ports);
  expect(git(f.destination, "rev-parse", "HEAD")).toBe(f.previous.head);
  expect(git(f.destination, "write-tree")).toBe(f.previous.indexTree);
  expect(tree(f.destination, f.root)).toBe(f.previous.workingTree);
  expect(git(f.destination, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(existsSync(join(f.destination, "untracked.bin"))).toBe(false);
}, 5000);

it("verification refuses sparse configuration changed after preparation", async () => {
  const f = fixture("prepared");
  writeFileSync(join(f.destination, ".git", "info", "sparse-checkout"), "/changed/\n", { mode: 0o600 });
  const { verifyWorkspace } = await import("../workspace-import");
  await expect(verifyWorkspace({ root: f.destination, snapshot: f.snapshot, previous: f.previous, moveId: f.snapshot.moveId,
    adjustments: [] }, f.ports)).rejects.toThrow(/workspace-verification-failed.*sparsePatterns/i);
  expect(readFileSync(join(f.destination, ".git", "info", "sparse-checkout"), "utf8")).toBe("/changed/\n");
}, 5000);

it("abort refuses when a prepared checkout has new user edits", async () => {
  const f = fixture();
  const { prepareWorkspace, abortWorkspace } = await import("../workspace-import");
  const prepared = await prepareWorkspace(f.snapshot, f.destination, f.ports);
  writeFileSync(join(f.destination, "tracked.txt"), "new destination edit\n");
  await expect(abortWorkspace(prepared, f.ports)).rejects.toThrow(/workspace-abort-diverged/i);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("new destination edit\n");
  expect(git(f.destination, "rev-parse", "HEAD")).toBe(f.snapshot.head);
}, 5000);

it.each(["missing status", "non-buffer stdout"] as const)("fails closed on refresh errors with %s", async defect => {
  const f = fixture(), run = f.ports.run;
  f.ports.run = async (cwd, argv, options) => {
    if (cwd === f.destination && argv[0] === "git" && argv[1] === "update-index" && argv[2] === "--refresh" && !options?.env?.GIT_INDEX_FILE) {
      const names = await run(cwd, ["git", "diff-files", "--name-only", "-z"]);
      const stdoutBytes = Buffer.concat(names.toString("utf8").split("\0").filter(Boolean).map(name => Buffer.from(`${name}: needs update\n`)));
      if (!stdoutBytes.length) throw new Error("fixture expected a dirty staged path");
      const stdout = defect === "non-buffer stdout" ? stdoutBytes.toString("utf8") : stdoutBytes;
      throw Object.assign(new Error("synthetic refresh failure"), {
        ...(defect === "missing status" ? { code: 1 } : { status: 1 }), stdout, stderr: Buffer.alloc(0),
      });
    }
    return run(cwd, argv, options);
  };
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(f.snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-index-refresh-failed/i);
}, 5000);

it("refuses a locally edited assume-unchanged file before updating the checkout", async () => {
  const f = fixture();
  git(f.destination, "update-index", "--assume-unchanged", "tracked.txt");
  writeFileSync(join(f.destination, "tracked.txt"), "local changed content\n");
  const before = readFileSync(join(f.destination, ".git", "index"));
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(f.snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-diverged/i);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("local changed content\n");
  expect(readFileSync(join(f.destination, ".git", "index"))).toEqual(before);
}, 5000);

it("refuses an incoming bundle larger than the destination workspace limit", async () => {
  const f = fixture();
  if (f.snapshot.bundle.kind !== "ready") throw new Error("fixture bundle is not ready");
  f.ports.limits.workspaceBytes = f.snapshot.bundle.byteLength - 1;
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(f.snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-bundle-limit/i);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("shared\n");
  expect(f.calls.some(args => args[0] === "git" && args[1] === "fetch")).toBe(false);
}, 5000);

it("refuses a final bundle when both received stages exceed the workspace limit", async () => {
  const f = fixture("prepared");
  if (f.snapshot.bundle.kind !== "ready" || templateFinal.bundle.kind !== "ready") throw new Error("fixture bundles are not ready");
  const artifact = join(f.root, "final.bundle"); copyFileSync(templateFinalArtifact, artifact); chmodSync(artifact, 0o600);
  f.setArtifact(artifact, "final-bundle");
  f.ports.limits.workspaceBytes = f.snapshot.bundle.byteLength + templateFinal.bundle.byteLength - 1;
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace({ ...templateFinal, root: f.snapshot.root }, f.destination, f.ports)).rejects.toThrow(/workspace-bundle-limit/i);
  expect(tree(f.destination, f.root)).toBe(f.snapshot.workingTree);
}, 5000);

it("refuses a destination missing a declared prerequisite before applying the bundle", async () => {
  const f = fixture();
  const { prepareWorkspace } = await import("../workspace-import");
  const missing = "f".repeat(40);
  await expect(prepareWorkspace({ ...f.snapshot, prerequisites: [...f.snapshot.prerequisites, missing] }, f.destination, f.ports))
    .rejects.toThrow(/workspace-prerequisite-missing/i);
  expect(git(f.destination, "rev-parse", "HEAD")).toBe(f.previous.head);
  expect(f.calls.some(args => args[0] === "git" && args[1] === "bundle" && args[2] === "unbundle")).toBe(false);
}, 5000);

function withAddedPaths(f: Fixture, paths: readonly string[], moveId: string): WorkspaceSnapshot {
  const source = f.snapshot.root;
  for (const path of paths) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), "source tracked\n");
  }
  git(source, "add", "-f", "--", ...paths);
  return snapshotCurrent(f, moveId);
}
function snapshotCurrent(f: Fixture, moveId: string): WorkspaceSnapshot {
  const source = f.snapshot.root;
  const indexTree = git(source, "write-tree");
  const indexCommit = git(source, "commit-tree", indexTree, "-p", f.snapshot.head, "-m", "added index");
  const workingTree = tree(source, f.root);
  const workingCommit = git(source, "commit-tree", workingTree, "-p", indexCommit, "-m", "added working");
  const refs = [`refs/spider-roam/${moveId}/pre/index`, `refs/spider-roam/${moveId}/pre/working`];
  git(source, "update-ref", refs[0], indexCommit); git(source, "update-ref", refs[1], workingCommit);
  const artifact = join(f.root, `${moveId}.bundle`);
  git(source, "bundle", "create", artifact, ...refs, `^${f.previous.head}`); chmodSync(artifact, 0o600);
  f.setArtifact(artifact);
  f.ports.journal.begin({ id: moveId, machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: 1, kind: "move", args: {} });
  return { ...f.snapshot, moveId, indexTree, workingTree, refs,
    bundle: { kind: "ready", artifactId: "incoming-bundle", byteLength: statSync(artifact).size } };
}

it.each(["ignored file", "ignored symlink", "symlinked parent"] as const)(
  "refuses an incoming path colliding with an %s before touching the checkout", async kind => {
    const f = fixture(), outside = join(f.root, "outside");
    mkdirSync(outside); writeFileSync(join(outside, "sentinel"), "outside unchanged\n");
    const incoming = kind === "symlinked parent" ? "linkdir/data.txt" : "local.generated";
    const snapshot = withAddedPaths(f, [incoming], "move-collision");
    const collision = kind === "symlinked parent" ? join(f.destination, "linkdir") : join(f.destination, "local.generated");
    if (kind === "ignored file") writeFileSync(collision, "local ignored data\n");
    else symlinkSync(kind === "symlinked parent" ? outside : join(outside, "sentinel"), collision);
    const index = git(f.destination, "rev-parse", "--path-format=absolute", "--git-path", "index");
    const beforeIndex = readFileSync(index);
    const beforeRefs = git(f.destination, "for-each-ref", "--format=%(refname) %(objectname)");
    const { prepareWorkspace } = await import("../workspace-import");
    let failure: unknown;
    try { await prepareWorkspace(snapshot, f.destination, f.ports); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("collision was not refused");
    expect(failure.message).toMatch(/workspace-apply-refused/i);
    expect(failure.message).toContain(kind === "symlinked parent" ? "linkdir" : "local.generated");
    expect(readFileSync(index)).toEqual(beforeIndex);
    expect(git(f.destination, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(beforeRefs);
    expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("shared\n");
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside unchanged\n");
    if (kind === "ignored file") expect(readFileSync(collision, "utf8")).toBe("local ignored data\n");
    else expect(lstatSync(collision).isSymbolicLink()).toBe(true);
    expect(f.ports.journal.read(snapshot.moveId)).toEqual([]);
    expect(f.calls.some(args => args[0] === "git" && args[1] === "fetch")).toBe(false);
    expect(f.calls.some(args => args[0] === "git" && args[1] === "update-ref")).toBe(false);
  }, 5000,
);

it.each(["symlink", "directory"] as const)("refuses a local %s replacing a tracked incoming path", async kind => {
  const f = fixture(), snapshot = withAddedPaths(f, ["tracked.txt"], "move-replaced-path");
  const outside = join(f.root, "outside-file"), local = join(f.destination, "tracked.txt");
  writeFileSync(outside, "outside unchanged\n"); rmSync(local);
  if (kind === "symlink") symlinkSync(outside, local); else mkdirSync(local);
  const before = readFileSync(join(f.destination, ".git", "index"));
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-apply-refused.*tracked\.txt/i);
  expect(readFileSync(join(f.destination, ".git", "index"))).toEqual(before);
  expect(readFileSync(outside, "utf8")).toBe("outside unchanged\n");
  expect(kind === "symlink" ? lstatSync(local).isSymbolicLink() : lstatSync(local).isDirectory()).toBe(true);
  expect(f.ports.journal.read(snapshot.moveId)).toEqual([]);
}, 5000);

it("refuses a collision before running a destination clean filter", async () => {
  const f = fixture(), snapshot = withAddedPaths(f, ["local.generated"], "move-filter-collision");
  writeFileSync(join(f.destination, "local.generated"), "local data\n");
  writeFileSync(join(f.destination, "tracked.txt"), "local modified\n");
  const sentinel = join(f.root, "filter-ran"), filter = join(f.root, "clean-filter.cjs");
  writeFileSync(filter, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(sentinel)},'ran');process.stdout.write(fs.readFileSync(0));`);
  writeFileSync(join(f.destination, ".git", "info", "attributes"), "tracked.txt filter=probe\n");
  appendFileSync(join(f.destination, ".git", "config"), `\n[filter "probe"]\n\tclean = node ${JSON.stringify(filter)}\n`);
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-apply-refused.*local\.generated/i);
  expect(existsSync(sentinel)).toBe(false);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("local modified\n");
  expect(readFileSync(join(f.destination, "local.generated"), "utf8")).toBe("local data\n");
}, 5000);

it("lists at most twenty conflicting paths without overwriting any of them", async () => {
  const f = fixture();
  const paths = Array.from({ length: 22 }, (_, index) => `local-${String(index).padStart(2, "0")}.generated`);
  const snapshot = withAddedPaths(f, paths, "move-many");
  for (const path of paths) writeFileSync(join(f.destination, path), "local data\n");
  const { prepareWorkspace } = await import("../workspace-import");
  let failure: unknown;
  try { await prepareWorkspace(snapshot, f.destination, f.ports); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("collision was not refused");
  expect(failure.message).toContain("local-00.generated");
  expect(failure.message).toContain("local-19.generated");
  expect(failure.message).not.toContain("local-20.generated");
  expect(readFileSync(join(f.destination, "local-21.generated"), "utf8")).toBe("local data\n");
  expect(f.ports.journal.read(snapshot.moveId)).toEqual([]);
}, 5000);

function setEolConfig(root: string, autocrlf: string, eol: string): void {
  appendFileSync(join(root, ".git", "config"), `\n[core]\n\tautocrlf = ${autocrlf}\n\teol = ${eol}\n`);
}
function normalizationSnapshot(f: Fixture, pinned = false): WorkspaceSnapshot {
  const source = f.snapshot.root;
  setEolConfig(source, "false", "lf");
  if (pinned) {
    writeFileSync(join(source, ".gitattributes"), ".gitattributes text eol=lf\n*.txt text eol=lf\n*.bin -text\n");
    git(source, "add", ".gitattributes");
  }
  return { ...withAddedPaths(f, ["staged-only.txt"], pinned ? "move-pinned" : "move-normalization"),
    normalization: { autocrlf: "false", eol: "lf" } };
}

it("refuses unpinned changed files for different effective EOL settings", async () => {
  const f = fixture(), snapshot = normalizationSnapshot(f);
  setEolConfig(f.destination, "true", "crlf");
  const beforeIndex = readFileSync(join(f.destination, ".git", "index"));
  const { prepareWorkspace } = await import("../workspace-import");
  let failure: unknown;
  try { await prepareWorkspace(snapshot, f.destination, f.ports); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("normalization mismatch was not refused");
  expect(failure.message).toMatch(/workspace-normalization-mismatch/i);
  expect(failure.message).toContain("core.autocrlf"); expect(failure.message).toContain("core.eol");
  expect(failure.message).toContain("staged-only.txt");
  expect(readFileSync(join(f.destination, ".git", "index"))).toEqual(beforeIndex);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("shared\n");
  expect(f.ports.journal.read(snapshot.moveId)).toEqual([]);
}, 5000);

it("restores changed files when the effective EOL settings agree", async () => {
  const f = fixture(), snapshot = normalizationSnapshot(f);
  setEolConfig(f.destination, "false", "lf");
  const { prepareWorkspace } = await import("../workspace-import");
  const prepared = await prepareWorkspace(snapshot, f.destination, f.ports);
  expect(prepared.snapshot.normalization).toEqual({ autocrlf: "false", eol: "lf" });
  expect(readFileSync(join(f.destination, "staged-only.txt"), "utf8")).toBe("source tracked\n");
}, 5000);

it("refuses a destination info/attributes override of a tracked EOL pin", async () => {
  const f = fixture(), snapshot = normalizationSnapshot(f, true);
  setEolConfig(f.destination, "true", "crlf");
  writeFileSync(join(f.destination, ".git", "info", "attributes"), "staged-only.txt text eol=crlf\n");
  const { prepareWorkspace } = await import("../workspace-import");
  let failure: unknown;
  try { await prepareWorkspace(snapshot, f.destination, f.ports); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("destination attribute override was not refused");
  expect(failure.message).toMatch(/workspace-attributes-mismatch/i);
  expect(failure.message).toContain("staged-only.txt");
  expect(readFileSync(join(f.destination, "staged-only.txt"), "utf8")).toBe("original\n");
}, 5000);

it.each([
  ["eol", "eol=crlf"], ["text", "-text"], ["crlf", "crlf"], ["filter", "filter=custom"],
] as const)("refuses an info/attributes %s override even when EOL settings agree", async (_attribute, override) => {
  const f = fixture(), snapshot = normalizationSnapshot(f, true);
  setEolConfig(f.destination, "false", "lf");
  writeFileSync(join(f.destination, ".git", "info", "attributes"), `staged-only.txt ${override}\n`);
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-attributes-mismatch.*staged-only\.txt/i);
  expect(readFileSync(join(f.destination, "staged-only.txt"), "utf8")).toBe("original\n");
  expect(f.ports.journal.read(snapshot.moveId)).toEqual([]);
}, 5000);

it("refuses an override from the destination core.attributesFile", async () => {
  const f = fixture(), snapshot = normalizationSnapshot(f, true);
  setEolConfig(f.destination, "false", "lf");
  const attributes = join(f.root, "global-attributes");
  writeFileSync(attributes, "staged-only.txt filter=custom\n");
  appendFileSync(join(f.destination, ".git", "config"), `\n[core]\n\tattributesFile = ${JSON.stringify(attributes)}\n`);
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-attributes-mismatch.*staged-only\.txt/i);
  expect(readFileSync(join(f.destination, "staged-only.txt"), "utf8")).toBe("original\n");
}, 5000);

it("does not reject an unpinned deletion solely because EOL settings differ", async () => {
  const f = fixture(), source = f.snapshot.root;
  git(source, "reset", "--hard", f.previous.head); rmSync(join(source, "untracked.bin"));
  setEolConfig(source, "false", "lf"); setEolConfig(f.destination, "true", "crlf");
  git(source, "rm", "-q", "delete.txt");
  f.snapshot = { ...f.snapshot, head: f.previous.head, normalization: { autocrlf: "false", eol: "lf" } };
  const snapshot = snapshotCurrent(f, "move-only-delete");
  const { prepareWorkspace } = await import("../workspace-import");
  await prepareWorkspace(snapshot, f.destination, f.ports);
  expect(existsSync(join(f.destination, "delete.txt"))).toBe(false);
}, 5000);

it("checks destination attributes for deleted paths before removing them", async () => {
  const f = fixture(), source = f.snapshot.root;
  git(source, "rm", "-q", "delete.txt");
  const snapshot = withAddedPaths(f, ["staged-only.txt"], "move-deleted-attr");
  writeFileSync(join(f.destination, ".git", "info", "attributes"), "delete.txt filter=custom\n");
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-attributes-mismatch.*delete\.txt/i);
  expect(readFileSync(join(f.destination, "delete.txt"), "utf8")).toBe("delete\n");
}, 5000);

it("does not treat an untracked source .gitattributes as a tracked pin", async () => {
  const f = fixture(), source = f.snapshot.root;
  setEolConfig(source, "false", "lf"); setEolConfig(f.destination, "false", "lf");
  writeFileSync(join(source, ".gitattributes"), "staged-only.txt text eol=lf\n");
  const snapshot = { ...withAddedPaths(f, ["staged-only.txt"], "move-untracked-attrs"),
    normalization: { autocrlf: "false", eol: "lf" } };
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-attributes-mismatch.*staged-only\.txt/i);
}, 5000);

it("honors tracked EOL pins despite differing Git settings", async () => {
  const f = fixture(), snapshot = normalizationSnapshot(f, true);
  setEolConfig(f.destination, "true", "crlf");
  const { prepareWorkspace } = await import("../workspace-import");
  await prepareWorkspace(snapshot, f.destination, f.ports);
  expect(readFileSync(join(f.destination, "staged-only.txt"), "utf8")).toBe("source tracked\n");
}, 5000);

it("uses destination global Git config when checking EOL normalization", async () => {
  const f = fixture(), source = f.snapshot.root;
  setEolConfig(source, "false", "lf");
  const snapshot = { ...withAddedPaths(f, ["staged-only.txt"], "move-global-eol"),
    normalization: { autocrlf: "false", eol: "lf" } };
  const global = join(f.root, "global.gitconfig");
  writeFileSync(global, "[core]\n\tautocrlf = true\n\teol = crlf\n");
  const run = f.ports.run;
  f.ports.run = (cwd, argv, options) => run(cwd, argv, { ...options, env: { ...options?.env, GIT_CONFIG_GLOBAL: global } });
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-normalization-mismatch.*staged-only\.txt/i);
  expect(readFileSync(join(f.destination, "staged-only.txt"), "utf8")).toBe("original\n");
}, 5000);

it("refuses an incoming snapshot that names a non-roaming ref", async () => {
  const f = fixture();
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace({ ...f.snapshot, refs: ["refs/heads/main"] }, f.destination, f.ports))
    .rejects.toThrow(/workspace-snapshot-invalid/i);
  expect(f.calls).toEqual([]);
  expect(git(f.destination, "rev-parse", "HEAD")).toBe(f.previous.head);
}, 5000);

it("refuses an incoming bundle whose recorded tree does not match its refs", async () => {
  const f = fixture();
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace({ ...f.snapshot, workingTree: f.snapshot.indexTree }, f.destination, f.ports))
    .rejects.toThrow(/workspace-snapshot-invalid/i);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("shared\n");
  expect(f.calls.some(args => args[0] === "git" && args[1] === "read-tree" && args.includes("-u"))).toBe(false);
}, 5000);

it("diverged mapped checkout refuses with a diff summary", async () => {
  const f = fixture();
  const { prepareWorkspace } = await import("../workspace-import");
  writeFileSync(join(f.destination, "tracked.txt"), "destination edit\n");
  const before = readFileSync(join(f.destination, "tracked.txt"));
  const unrelatedRootDigestBefore = digest(join(f.unrelated, "sentinel"));
  await expect(prepareWorkspace(f.snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-diverged.*working/i);
  expect(readFileSync(join(f.destination, "tracked.txt"))).toEqual(before);
  expect(digest(join(f.unrelated, "sentinel"))).toBe(unrelatedRootDigestBefore);
  expect(f.calls.some(args => args[0] === "git" && args[1] === "fetch")).toBe(false);
}, 5000);

it("branch conflict remains detached", async () => {
  const f = fixture();
  const { prepareWorkspace } = await import("../workspace-import");
  const previousBranchHead = git(f.destination, "rev-parse", "refs/heads/main");
  const prepared = await prepareWorkspace(f.snapshot, f.destination, f.ports);
  expect(git(prepared.root, "rev-parse", "HEAD")).toBe(f.snapshot.head);
  expect(() => git(prepared.root, "symbolic-ref", "-q", "HEAD")).toThrow();
  expect(git(prepared.root, "rev-parse", "refs/heads/main")).toBe(previousBranchHead);
  expect(f.ports.journal.read(f.snapshot.moveId)).toContainEqual({
    action: "workspace-branch-conflict", result: { root: prepared.root, savedBranch: "refs/heads/main" },
  });
}, 5000);

it("a detached source remains detached at its commit", async () => {
  const f = fixture();
  const { prepareWorkspace } = await import("../workspace-import");
  const prepared = await prepareWorkspace({ ...f.snapshot, branch: null }, f.destination, f.ports);
  expect(git(prepared.root, "rev-parse", "HEAD")).toBe(f.snapshot.head);
  expect(() => git(prepared.root, "symbolic-ref", "-q", "HEAD")).toThrow();
  expect(f.ports.journal.read(f.snapshot.moveId).some(row => row.action === "workspace-branch-conflict")).toBe(false);
}, 5000);

it("unbundled snapshots refuse before destination effects", async () => {
  const f = fixture();
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace({ ...f.snapshot, bundle: { kind: "unbundled" } }, f.destination, f.ports))
    .rejects.toThrow(/workspace.*unbundled/i);
  expect(f.calls).toEqual([]);
}, 5000);

it.each(["artifact", "repository", "baseline"] as const)("reports a failed %s lookup without changing the checkout", async which => {
  const f = fixture();
  if (which === "artifact") f.ports.verifiedArtifactPath = async () => { throw new Error("fixture failure"); };
  if (which === "repository") f.ports.resolveCommonRepository = async () => { throw new Error("fixture failure"); };
  if (which === "baseline") f.ports.lastExportedSnapshot = async () => { throw new Error("fixture failure"); };
  const { prepareWorkspace } = await import("../workspace-import");
  await expect(prepareWorkspace(f.snapshot, f.destination, f.ports)).rejects.toThrow(new RegExp(`workspace-${which}-unavailable`, "i"));
  expect(git(f.destination, "rev-parse", "HEAD")).toBe(f.previous.head);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("shared\n");
  expect(f.calls.some(args => args[0] === "git" && args[1] === "fetch")).toBe(false);
}, 5000);

it("missing destination evidence refuses rather than guessing", async () => {
  const f = fixture();
  const { prepareWorkspace } = await import("../workspace-import");
  f.setArtifact(null);
  await expect(prepareWorkspace(f.snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-artifact-missing/i);
  expect(f.calls).toEqual([]);
  f.setArtifact(join(f.root, "received.bundle"));
  f.setRepository(null);
  await expect(prepareWorkspace(f.snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-repository-unmapped/i);
  expect(f.calls).toEqual([]);
  f.setRepository(f.destination);
  f.setPrevious(null);
  await expect(prepareWorkspace(f.snapshot, f.destination, f.ports)).rejects.toThrow(/workspace-baseline-missing/i);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("shared\n");
}, 5000);

type RecoveryCase = "pre-direct" | "pre-temporary" | "final-direct" | "final-temporary" | "created";
type ObservedSetting = { bytes: Buffer | null; mode: number | null };
type ObservedSettings = { config: ObservedSetting; sparse: ObservedSetting };

function settingPaths(destination: string): { config: string; sparse: string } {
  return {
    config: git(destination, "rev-parse", "--path-format=absolute", "--git-path", "config.worktree"),
    sparse: git(destination, "rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout"),
  };
}
function observeSettings(destination: string): ObservedSettings {
  const paths = settingPaths(destination);
  const read = (file: string): ObservedSetting => existsSync(file)
    ? { bytes: readFileSync(file), mode: statSync(file).mode & 0o7777 }
    : { bytes: null, mode: null };
  return { config: read(paths.config), sparse: read(paths.sparse) };
}
function interruptSettingsWrite(root: string, count: number): void {
  let writes = 0;
  settingsFault.afterWrite = path => {
    if (!path.startsWith(`${root}/`) || !(path.endsWith("/config.worktree") || path.endsWith("/info/sparse-checkout"))) return;
    if (++writes === count) {
      settingsFault.afterWrite = null;
      throw new Error("simulated settings interruption");
    }
  };
}
function recoveryCase(kind: RecoveryCase): { f: Fixture; snapshot: WorkspaceSnapshot; destination: string; before: ObservedSettings } {
  const f = fixture(kind === "pre-temporary" || kind === "final-temporary" ? "sparse-prepared" : kind === "final-direct" ? "prepared" : "base");
  let snapshot: WorkspaceSnapshot;
  let destination = f.destination;
  if (kind === "pre-direct" || kind === "created") {
    if (kind === "pre-direct") {
      withMappedConfig(f, "[core]\r\n\tsparseCheckout = false\r\n[checkout]\r\n\tworkers = 2\r\n", "/old/\r\n");
    } else destination = join(f.root, "created-worktree");
    snapshot = sparseSnapshot(f);
  } else if (kind === "pre-temporary") {
    f.previous = { ...f.snapshot, root: f.destination }; f.setPrevious(f.previous);
    f.ports.journal.begin({ id: templateSnapshot.moveId, machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: 1, kind: "move", args: {} });
    snapshot = { ...templateSnapshot, root: f.snapshot.root };
  } else {
    const artifact = join(f.root, "final.bundle");
    copyFileSync(kind === "final-direct" ? templateFinalArtifact : templateSparseFullArtifact, artifact);
    chmodSync(artifact, 0o600);
    const final = kind === "final-direct" ? templateFinal : templateSparseFull;
    f.setArtifact(artifact, final.bundle.kind === "ready" ? final.bundle.artifactId : "invalid");
    snapshot = kind === "final-direct" ? { ...final, root: f.snapshot.root, sparsePatterns: "/*\n!/*/\n/never/\n",
      worktreeConfig: "[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n", sparse: { enabled: true, cone: true } }
      : { ...final, root: f.snapshot.root };
  }
  if (kind !== "created") {
    const paths = settingPaths(destination);
    if (existsSync(paths.config)) chmodSync(paths.config, 0o640);
    if (existsSync(paths.sparse)) chmodSync(paths.sparse, 0o604);
  }
  const before = kind === "created" ? { config: { bytes: null, mode: null }, sparse: { bytes: null, mode: null } } : observeSettings(destination);
  return { f, snapshot, destination, before };
}

const interruptionSteps: readonly [RecoveryCase, number][] = [
  ["pre-direct", 1], ["pre-direct", 2],
  ["pre-temporary", 1], ["pre-temporary", 2], ["pre-temporary", 3], ["pre-temporary", 4],
  ["final-direct", 1], ["final-direct", 2],
  ["final-temporary", 1], ["final-temporary", 2], ["final-temporary", 3], ["final-temporary", 4],
  ["created", 1], ["created", 2],
];
it.each(interruptionSteps)("automatically recovers %s after settings write %i", async (kind, step) => {
  const { f, snapshot, destination, before } = recoveryCase(kind);
  const { prepareWorkspace } = await import("../workspace-import");
  interruptSettingsWrite(f.root, step);
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow("simulated settings interruption");
  let beforeRetry: ObservedSettings | null = null;
  const run = f.ports.run;
  f.ports.run = async (cwd, argv, options) => {
    if (argv[0] === "git" && argv[1] === "bundle" && argv[2] === "verify" && beforeRetry === null) {
      beforeRetry = observeSettings(destination);
    }
    return run(cwd, argv, options);
  };
  const prepared = await prepareWorkspace(snapshot, destination, f.ports);
  expect(beforeRetry).toEqual(before);
  expect(prepared.root).toBe(destination);
  expect(git(destination, "rev-parse", "HEAD")).toBe(snapshot.head);
  expect(git(destination, "write-tree")).toBe(snapshot.indexTree);
  expect(tree(destination, f.root)).toBe(snapshot.workingTree);
}, 5000);

it.each(["config", "sparse", "working tree"] as const)("refuses a user edit to %s after a settings interruption", async edited => {
  const { f, snapshot, destination } = recoveryCase("pre-direct");
  const { prepareWorkspace } = await import("../workspace-import");
  interruptSettingsWrite(f.root, 2);
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow("simulated settings interruption");
  const paths = settingPaths(destination);
  const file = edited === "config" ? paths.config : edited === "sparse" ? paths.sparse : join(destination, "tracked.txt");
  const contents = edited === "config" ? "[checkout]\n\tworkers = 99\n" : edited === "sparse" ? "/user-edit/\n" : "user working edit\n";
  writeFileSync(file, contents);
  const interrupted = observeSettings(destination);
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow(/workspace-recovery-diverged/i);
  expect(readFileSync(file, "utf8")).toBe(contents);
  expect(observeSettings(destination)).toEqual(interrupted);
}, 5000);

it("retries safely after recovery itself is interrupted", async () => {
  const { f, snapshot, destination, before } = recoveryCase("pre-direct");
  const { prepareWorkspace } = await import("../workspace-import");
  interruptSettingsWrite(f.root, 2);
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow("simulated settings interruption");
  interruptSettingsWrite(f.root, 1);
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow("simulated settings interruption");
  let restored: ObservedSettings | null = null;
  const run = f.ports.run;
  f.ports.run = async (cwd, argv, options) => {
    if (argv[0] === "git" && argv[1] === "bundle" && argv[2] === "verify" && restored === null) restored = observeSettings(destination);
    return run(cwd, argv, options);
  };
  await prepareWorkspace(snapshot, destination, f.ports);
  expect(restored).toEqual(before);
  expect(tree(destination, f.root)).toBe(snapshot.workingTree);
}, 5000);

it("serializes startup recovery with an abort of the same checkout", async () => {
  const f = fixture("prepared");
  const { abortWorkspace, recoverInterruptedWorkspace } = await import("../workspace-import");
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const run = f.ports.run;
  const aborting: WorkspaceImportPorts = { ...f.ports, async run(cwd, argv, options) {
    if (cwd === f.destination && argv[1] === "rev-parse" && argv.includes("HEAD")) {
      entered(); await paused; throw new Error("stop abort before effects");
    }
    return run(cwd, argv, options);
  } };
  const first = abortWorkspace({ root: f.destination, snapshot: f.snapshot, previous: f.previous, moveId: f.snapshot.moveId, adjustments: [] }, aborting).catch(error => error);
  await reached;
  let recoveryEntered = false;
  const journal = { ...f.ports.journal, read(id: string) { recoveryEntered = true; return f.ports.journal.read(id); } };
  const second = recoverInterruptedWorkspace(f.snapshot, f.destination, f.destination, { ...f.ports, journal });
  await new Promise<void>(resolve => setTimeout(resolve, 400));
  const enteredWhileHeld = recoveryEntered;
  release();
  const [failure] = await Promise.all([first, second]);
  expect(enteredWhileHeld).toBe(false);
  expect(failure).toBeInstanceOf(Error);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("unpushed\n");
}, 5000);

it("serializes startup recovery with a restore of the same checkout", async () => {
  const { f, snapshot, destination } = recoveryCase("pre-direct");
  const { prepareWorkspace, recoverInterruptedWorkspace } = await import("../workspace-import");
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const run = f.ports.run;
  const restoring: WorkspaceImportPorts = { ...f.ports, async run(cwd, argv, options) {
    if (argv[0] === "git" && argv[1] === "bundle" && argv[2] === "verify") {
      entered(); await paused; throw new Error("stop restore before effects");
    }
    return run(cwd, argv, options);
  } };
  const first = prepareWorkspace(snapshot, destination, restoring).catch(error => error);
  await reached;
  let recoveryEntered = false;
  const journal = { ...f.ports.journal, read(id: string) { recoveryEntered = true; return f.ports.journal.read(id); } };
  const second = recoverInterruptedWorkspace(snapshot, destination, f.destination, { ...f.ports, journal });
  await new Promise<void>(resolve => setTimeout(resolve, 400));
  const enteredWhileHeld = recoveryEntered;
  release();
  const [failure] = await Promise.all([first, second]);
  expect(enteredWhileHeld).toBe(false);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toMatch(/workspace-prerequisite-missing/i);
  expect(readFileSync(join(destination, "tracked.txt"), "utf8")).toBe("shared\n");
}, 5000);

it("refuses a settings edit between recovery and the retry write", async () => {
  const { f, snapshot, destination } = recoveryCase("pre-direct");
  const { prepareWorkspace } = await import("../workspace-import");
  interruptSettingsWrite(f.root, 2);
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow("simulated settings interruption");
  const sparse = settingPaths(destination).sparse;
  const record = f.ports.journal.record.bind(f.ports.journal);
  let recovered = false;
  f.ports.journal.record = (id, action, result) => {
    record(id, action, result);
    if (action === "workspace-settings-recovery-complete") recovered = true;
    if (recovered && action === "workspace-settings-write-start" && result.step === "target-sparse") writeFileSync(sparse, "/user-edit/\n");
  };
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow(/workspace-(config|recovery)-diverged/i);
  expect(readFileSync(sparse, "utf8")).toBe("/user-edit/\n");
}, 5000);

it("refuses a new edit after recovery itself is interrupted", async () => {
  const { f, snapshot, destination } = recoveryCase("pre-direct");
  const { prepareWorkspace } = await import("../workspace-import");
  interruptSettingsWrite(f.root, 2);
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow("simulated settings interruption");
  interruptSettingsWrite(f.root, 1);
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow("simulated settings interruption");
  const path = settingPaths(destination).config;
  writeFileSync(path, "[checkout]\n\tworkers = 99\n");
  const interrupted = observeSettings(destination);
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow(/workspace-recovery-diverged/i);
  expect(observeSettings(destination)).toEqual(interrupted);
}, 5000);

it("restores special permission bits on interrupted settings", async () => {
  const { f, snapshot, destination } = recoveryCase("pre-direct");
  const paths = settingPaths(destination);
  chmodSync(paths.config, 0o1640); chmodSync(paths.sparse, 0o1604);
  const before = observeSettings(destination);
  const { prepareWorkspace, recoverInterruptedWorkspace } = await import("../workspace-import");
  interruptSettingsWrite(f.root, 2);
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow("simulated settings interruption");
  await recoverInterruptedWorkspace(snapshot, destination, f.destination, f.ports);
  expect(observeSettings(destination)).toEqual(before);
}, 5000);

it("running interrupted workspace recovery twice preserves the original settings", async () => {
  const { f, snapshot, destination, before } = recoveryCase("pre-direct");
  const { prepareWorkspace, recoverInterruptedWorkspace } = await import("../workspace-import");
  interruptSettingsWrite(f.root, 2);
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow("simulated settings interruption");
  await recoverInterruptedWorkspace(snapshot, destination, f.destination, f.ports);
  expect(observeSettings(destination)).toEqual(before);
  await recoverInterruptedWorkspace(snapshot, destination, f.destination, f.ports);
  expect(observeSettings(destination)).toEqual(before);
  await prepareWorkspace(snapshot, destination, f.ports);
  expect(tree(destination, f.root)).toBe(snapshot.workingTree);
}, 5000);

it.each([false, true])("recovers an applied sparse working tree without overwriting a hidden edit: %s", async editHidden => {
  const { f, snapshot, destination, before } = recoveryCase("pre-direct");
  const { prepareWorkspace } = await import("../workspace-import");
  const run = f.ports.run;
  f.ports.run = async (cwd, argv, options) => {
    if (cwd === destination && argv[0] === "git" && argv[1] === "read-tree" && argv.includes("--reset") && !options?.env?.GIT_INDEX_FILE) {
      throw new Error("simulated index interruption");
    }
    return run(cwd, argv, options);
  };
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow("simulated index interruption");
  f.ports.run = run;
  if (editHidden) {
    const hidden = join(destination, "skip", "item.txt");
    mkdirSync(dirname(hidden), { recursive: true }); writeFileSync(hidden, "hidden user edit\n");
    const interrupted = observeSettings(destination);
    await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow(/workspace-recovery-diverged/i);
    expect(readFileSync(hidden, "utf8")).toBe("hidden user edit\n");
    expect(observeSettings(destination)).toEqual(interrupted);
  } else {
    let restored: ObservedSettings | null = null;
    f.ports.run = async (cwd, argv, options) => {
      if (argv[0] === "git" && argv[1] === "bundle" && argv[2] === "verify" && restored === null) restored = observeSettings(destination);
      return run(cwd, argv, options);
    };
    await prepareWorkspace(snapshot, destination, f.ports);
    expect(restored).toEqual(before);
    expect(git(destination, "write-tree")).toBe(snapshot.indexTree);
    expect(readFileSync(join(destination, "keep", "item.txt"), "utf8")).toBe("included\n");
    expect(existsSync(join(destination, "skip", "item.txt"))).toBe(false);
  }
}, 5000);

it("refuses an edit to a sparse-expanded path before rolling back settings", async () => {
  const { f, snapshot, destination } = recoveryCase("final-temporary");
  const { prepareWorkspace } = await import("../workspace-import");
  interruptSettingsWrite(f.root, 3);
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow("simulated settings interruption");
  const file = join(destination, "skip", "item.txt");
  writeFileSync(file, "user sparse edit\n");
  const interrupted = observeSettings(destination);
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow(/workspace-recovery-diverged/i);
  expect(readFileSync(file, "utf8")).toBe("user sparse edit\n");
  expect(observeSettings(destination)).toEqual(interrupted);
}, 5000);

it.each(["missing original", "bad mode", "wrong digest", "missing transition"] as const)("refuses a partial settings journal with %s", async defect => {
  const { f, snapshot, destination } = recoveryCase("pre-direct");
  const { prepareWorkspace } = await import("../workspace-import");
  interruptSettingsWrite(f.root, 1);
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow("simulated settings interruption");
  const interrupted = observeSettings(destination);
  const read = f.ports.journal.read.bind(f.ports.journal);
  f.ports.journal.read = id => read(id).filter(row => defect !== "missing transition" || row.action !== "workspace-settings-transition")
    .map(row => row.action !== "workspace-settings-transition" ? row : {
      ...row, result: { ...row.result, ...(defect === "missing original" ? { original: null } :
        defect === "bad mode" ? { modes: { worktreeMode: -1, sparseMode: null } } : { digest: "bad" }) },
    });
  await expect(prepareWorkspace(snapshot, destination, f.ports)).rejects.toThrow(/workspace-journal-invalid/i);
  expect(observeSettings(destination)).toEqual(interrupted);
}, 5000);

it("abort resumes when the prior checkout was restored before the completion journal reply", async () => {
  const f = fixture("prepared"), { abortWorkspace } = await import("../workspace-import");
  const prepared = { root: f.destination, snapshot: f.snapshot, previous: f.previous, moveId: f.snapshot.moveId, adjustments: [] };
  const record = f.ports.journal.record.bind(f.ports.journal); let fail = true;
  f.ports.journal.record = (id, action, result) => { if (action === "workspace-aborted" && fail) { fail = false; throw new Error("lost abort completion"); } record(id, action, result); };
  await expect(abortWorkspace(prepared, f.ports)).rejects.toThrow("lost abort completion");
  await abortWorkspace(prepared, f.ports);
  expect(git(f.destination, "write-tree")).toBe(f.previous.indexTree);
  expect(tree(f.destination, f.root)).toBe(f.previous.workingTree);
  expect(git(f.destination, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
}, 5000);

it.each([".spider", ".pi-subagents"])("nested tracked %s fixtures remain part of workspace verification", async name => {
  const { verifyWorkspace } = await import("../workspace-import"), f = fixture();
  const relative = `nested/${name}/fixture.txt`, file = join(f.destination, relative);
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "original fixture\n");
  git(f.destination, "add", "--", relative);
  const baseline = git(f.destination, "write-tree"), snapshot = { ...f.previous, root: f.destination, indexTree: baseline, workingTree: baseline };
  const prepared = { root: f.destination, moveId: snapshot.moveId, previous: null, adjustments: [], snapshot };
  await verifyWorkspace(prepared, f.ports);
  writeFileSync(file, "edited fixture\n");
  await expect(verifyWorkspace(prepared, f.ports)).rejects.toThrow("workspace-verification-failed");
  expect(readFileSync(file, "utf8")).toBe("edited fixture\n");
}, 5000);
