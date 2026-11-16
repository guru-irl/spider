import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS } from "../contracts";
import type { WorkspaceImportPorts, WorkspaceSnapshot } from "../contracts";
import { openJournal } from "../journal";
import { snapshotWorkspace } from "../workspace";
import { recoverInterruptedWorkspace } from "../workspace-import";
import * as moveRecovery from "../move-recovery";

const env: NodeJS.ProcessEnv = {
  ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_CONFIG", "GIT_CONFIG_COUNT"]) delete env[key];
function command(cwd: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }): Buffer {
  return execFileSync(argv[0], argv.slice(1), { cwd, env: { ...env, ...options?.env }, input: options?.stdin,
    stdio: [options?.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
}
function git(cwd: string, ...args: string[]): string { return command(cwd, ["git", ...args]).toString("utf8").trim(); }
const config = "[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n";
const patterns = "/*\n!/*/\n/keep/\n";
let template: string, head: string, tree: string, captured: WorkspaceSnapshot;
const roots: string[] = [];
beforeAll(async () => {
  template = mkdtempSync(join(dirname(scratchDbPath("recovery-template")), "recovery-template-"));
  const repo = join(template, "repo"); mkdirSync(repo);
  git(repo, "init", "-q", "--initial-branch=main");
  mkdirSync(join(repo, "keep")); mkdirSync(join(repo, "skip"));
  writeFileSync(join(repo, "keep", "item.txt"), "keep\n");
  writeFileSync(join(repo, "skip", "item.txt"), "skip\n");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "initial");
  head = git(repo, "rev-parse", "HEAD"); tree = git(repo, "write-tree");
  const captureJournal = openJournal(join(template, "capture.db"));
  captureJournal.begin({ id: "recovery-move", kind: "workspace-snapshot", machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: null, args: {} });
  captured = await snapshotWorkspace({ root: repo, cwd: repo, repoKey: "fixture-repo", workspaceId: "fixture-workspace",
    moveId: "recovery-move", stage: "pre", writers: [] }, {
    journal: captureJournal, limits: { ...DEFAULT_LIMITS }, scratch: join(template, "capture"), worktreeCommand: null,
    async run(cwd, argv, options) { return command(cwd, ["git", ...argv], options); },
  });
  git(repo, "config", "--local", "extensions.worktreeConfig", "true");
  const privateIndex = join(template, "index");
  copyFileSync(join(repo, ".git", "index"), privateIndex);
  writeFileSync(join(repo, ".git", "info", "sparse-checkout"), patterns, { mode: 0o600 });
  writeFileSync(join(repo, ".git", "config.worktree"), config, { mode: 0o600 });
  command(repo, ["git", "read-tree", "-m", "-u", tree, tree], { env: { GIT_INDEX_FILE: privateIndex } });
  if (existsSync(join(repo, "skip", "item.txt"))) throw new Error("fixture did not apply sparse checkout");
});
afterAll(() => { if (template) rmSync(template, { recursive: true, force: true }); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { repo: string; snapshot: WorkspaceSnapshot; ports: WorkspaceImportPorts } {
  const root = mkdtempSync(join(dirname(scratchDbPath("recovery-case")), "recovery-case-")); roots.push(root);
  const repo = join(root, "repo"); cpSync(join(template, "repo"), repo, { recursive: true });
  const snapshot: WorkspaceSnapshot = {
    ...captured, root: repo, repoKey: "fixture-repo", workspaceId: "fixture-workspace", moveId: "recovery-move", stage: "pre",
    head, branch: null, objectFormat: "sha1", indexTree: tree, workingTree: tree, relativeCwd: ".",
    sparsePatterns: patterns, worktreeConfig: config, normalization: { autocrlf: null, eol: null },
    sparse: { enabled: true, cone: true }, refs: ["refs/spider-roam/recovery-move/pre/index", "refs/spider-roam/recovery-move/pre/working"],
    prerequisites: [], bundle: { kind: "ready", artifactId: "fixture-bundle", byteLength: 1 },
  };
  const previous = { ...snapshot, moveId: "previous", stage: "final" as const, sparsePatterns: null, worktreeConfig: null,
    sparse: { enabled: false, cone: null } };
  const snapshotJson = JSON.stringify(snapshot);
  const digest = createHash("sha256").update(JSON.stringify([
    snapshot.repoKey, snapshot.workspaceId, snapshot.moveId, snapshot.stage, snapshot.head, snapshot.branch,
    snapshot.objectFormat, snapshot.indexTree, snapshot.workingTree, snapshot.relativeCwd, snapshot.sparsePatterns,
    snapshot.worktreeConfig, snapshot.normalization, snapshot.sparse, snapshot.refs, snapshot.prerequisites, snapshot.bundle,
  ])).digest("hex");
  const transitionId = "00000000-0000-4000-8000-000000000001", common = join(repo, ".git");
  const original = { worktreeConfig: null, sparsePatterns: null }, modes = { worktreeMode: null, sparseMode: null };
  const target = { worktreeConfig: config, sparsePatterns: patterns }, targetModes = { worktreeMode: 0o600, sparseMode: 0o600 };
  const before = { head, indexTree: tree, workingTree: tree };
  const beforeView = { objectFormat: "sha1", workingTree: tree, sparse: { enabled: false, cone: null }, sparsePatterns: null };
  const checksum = createHash("sha256").update(JSON.stringify([1, transitionId, repo, common, "pre", digest, snapshotJson,
    [null, null, null, null], null, [config, patterns, 0o600, 0o600], [head, tree, tree], false, ["sha1", tree, false, null, null]])).digest("hex");
  const journal = openJournal(join(root, "journal.db"));
  journal.begin({ id: snapshot.moveId, machineId: "00000000-0000-4000-8000-000000000002", expectedEpoch: 1, kind: "move", args: {} });
  journal.record(snapshot.moveId, "workspace-prepare-start", { root: repo, stage: "pre", digest, snapshotJson,
    previousJson: JSON.stringify(previous), settingsJournalVersion: 1 });
  journal.record(snapshot.moveId, "workspace-settings-transition", { version: 1, transitionId, root: repo, common, stage: "pre", digest,
    snapshotJson, original, modes, temporary: null, temporaryModes: null, target, targetModes, before, beforeApplied: false, beforeView, checksum });
  journal.record(snapshot.moveId, "workspace-config-target", { root: repo, digest, ...target });
  for (const step of ["target-sparse", "target-config"]) {
    journal.record(snapshot.moveId, "workspace-settings-write-start", { root: repo, transitionId, step });
    journal.record(snapshot.moveId, "workspace-settings-write-complete", { root: repo, transitionId, step });
  }
  const ports: WorkspaceImportPorts = {
    scratch: join(root, "scratch"), journal, limits: { ...DEFAULT_LIMITS }, worktreeCommand: null,
    async run(cwd, argv, options) { return command(cwd, argv, options); },
    async resolveCommonRepository() { return repo; },
    async lastExportedSnapshot() { return previous; },
    async verifiedArtifactPath() { return null; },
  };
  return { repo, snapshot, ports };
}

it("recovers settings after a sparse working tree was applied before its index", async () => {
  const { repo, snapshot, ports } = fixture();
  await recoverInterruptedWorkspace(snapshot, repo, repo, ports);
  expect(existsSync(join(repo, ".git", "config.worktree"))).toBe(false);
  expect(existsSync(join(repo, ".git", "info", "sparse-checkout"))).toBe(false);
  expect(readFileSync(join(repo, "keep", "item.txt"), "utf8")).toBe("keep\n");
  expect(existsSync(join(repo, "skip", "item.txt"))).toBe(false);
}, 5000);

it("serializes concurrent recovery for the same checkout", async () => {
  const { repo, snapshot, ports } = fixture();
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const run = ports.run;
  let firstPaused = false, secondEntered = false;
  const firstPorts: WorkspaceImportPorts = { ...ports, async run(cwd, argv, options) {
    if (!firstPaused && argv.includes("config.worktree")) { firstPaused = true; entered(); await paused; }
    return run(cwd, argv, options);
  } };
  const secondPorts: WorkspaceImportPorts = { ...ports, async run(cwd, argv, options) {
    if (argv.includes("config.worktree")) secondEntered = true;
    return run(cwd, argv, options);
  } };
  const first = recoverInterruptedWorkspace(snapshot, repo, repo, firstPorts);
  await reached;
  const second = recoverInterruptedWorkspace(snapshot, repo, repo, secondPorts);
  await new Promise<void>(resolve => setTimeout(resolve, 400));
  const enteredWhileHeld = secondEntered;
  release();
  const outcomes = await Promise.allSettled([first, second]);
  expect(enteredWhileHeld).toBe(false);
  expect(outcomes.map(outcome => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(existsSync(join(repo, ".git", "config.worktree"))).toBe(false);
  expect(existsSync(join(repo, ".git", "info", "sparse-checkout"))).toBe(false);
}, 5000);

it("refuses a settings edit made as recovery starts a write", async () => {
  const { repo, snapshot, ports } = fixture();
  const sparse = join(repo, ".git", "info", "sparse-checkout");
  const record = ports.journal.record.bind(ports.journal);
  ports.journal.record = (id, action, result) => {
    record(id, action, result);
    if (action === "workspace-settings-write-start" && result.step === "recovery-sparse") writeFileSync(sparse, "/user-edit/\n");
  };
  await expect(recoverInterruptedWorkspace(snapshot, repo, repo, ports)).rejects.toThrow(/workspace-recovery-diverged/i);
  expect(readFileSync(sparse, "utf8")).toBe("/user-edit/\n");
  expect(readFileSync(join(repo, ".git", "config.worktree"), "utf8")).toBe(config);
}, 5000);

it("refuses a malformed transition payload without changing settings", async () => {
  const { repo, snapshot, ports } = fixture();
  const read = ports.journal.read.bind(ports.journal);
  ports.journal.read = id => read(id).map(row => row.action === "workspace-settings-transition"
    ? { ...row, result: null as unknown as typeof row.result } : row);
  await expect(recoverInterruptedWorkspace(snapshot, repo, repo, ports)).rejects.toThrow(/workspace-journal-invalid/i);
  expect(readFileSync(join(repo, ".git", "config.worktree"), "utf8")).toBe(config);
}, 5000);

it("refuses a corrupted transition checksum without changing settings", async () => {
  const { repo, snapshot, ports } = fixture();
  const read = ports.journal.read.bind(ports.journal);
  ports.journal.read = id => read(id).map(row => row.action === "workspace-settings-transition"
    ? { ...row, result: { ...row.result, checksum: "0".repeat(64) } } : row);
  await expect(recoverInterruptedWorkspace(snapshot, repo, repo, ports)).rejects.toThrow(/workspace-journal-invalid/i);
  expect(readFileSync(join(repo, ".git", "config.worktree"), "utf8")).toBe(config);
  expect(readFileSync(join(repo, ".git", "info", "sparse-checkout"), "utf8")).toBe(patterns);
}, 5000);

it("refuses settings changed after interruption without overwriting them", async () => {
  const { repo, snapshot, ports } = fixture();
  const file = join(repo, ".git", "config.worktree");
  writeFileSync(file, "[checkout]\n\tworkers = 99\n");
  await expect(recoverInterruptedWorkspace(snapshot, repo, repo, ports)).rejects.toThrow(/workspace-recovery-diverged/i);
  expect(readFileSync(file, "utf8")).toBe("[checkout]\n\tworkers = 99\n");
  expect(readFileSync(join(repo, ".git", "info", "sparse-checkout"), "utf8")).toBe(patterns);
}, 5000);

it("refuses an edit to a hidden tracked path after sparse checkout", async () => {
  const { repo, snapshot, ports } = fixture();
  const hidden = join(repo, "skip", "item.txt"); mkdirSync(dirname(hidden), { recursive: true });
  writeFileSync(hidden, "user edit\n"); chmodSync(hidden, 0o644);
  await expect(recoverInterruptedWorkspace(snapshot, repo, repo, ports)).rejects.toThrow(/workspace-recovery-diverged/i);
  expect(readFileSync(hidden, "utf8")).toBe("user edit\n");
  expect(readFileSync(join(repo, ".git", "config.worktree"), "utf8")).toBe(config);
  expect(readFileSync(join(repo, ".git", "info", "sparse-checkout"), "utf8")).toBe(patterns);
}, 5000);

it("move startup recovers interrupted settings under participant locks", async () => {
  const { repo, snapshot, ports } = fixture();
  let locked = false;
  const run = ports.run;
  ports.run = async (...args) => { expect(locked).toBe(true); return run(...args); };
  await moveRecovery.recoverWorkspaceRestores([{ snapshot, destination: repo, repository: repo, ports,
    async withBothLocks(effect) { locked = true; try { return await effect(); } finally { locked = false; } },
  }]);
  expect(locked).toBe(false);
  expect(existsSync(join(repo, ".git", "config.worktree"))).toBe(false);
  expect(existsSync(join(repo, ".git", "info", "sparse-checkout"))).toBe(false);
  expect(readFileSync(join(repo, "keep", "item.txt"), "utf8")).toBe("keep\n");
}, 5000);
