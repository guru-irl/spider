import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS } from "../contracts";
import type { GitPorts, WorkspaceSnapshot } from "../contracts";
import { snapshotWorkspace } from "../workspace";
import { openJournal } from "../journal";
import { openOutgoingStaging, sourceChunk } from "../staging";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Spider roaming snapshot",
  GIT_AUTHOR_EMAIL: "roam@example.invalid",
  GIT_COMMITTER_NAME: "Spider roaming snapshot",
  GIT_COMMITTER_EMAIL: "roam@example.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_CONFIG", "GIT_CONFIG_COUNT"]) delete environment[key];

function command(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Buffer {
  return execFileSync(args[0], args.slice(1), { cwd, env: { ...environment, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}
function git(cwd: string, ...args: string[]): string {
  return command(cwd, ["git", ...args]).toString("utf8").trim();
}

let templateRoot: string, templateShared: string, templateSnapshot: WorkspaceSnapshot, templateFinal: WorkspaceSnapshot, templatePreCommit: string;
beforeAll(async () => {
  templateRoot = mkdtempSync(join(dirname(scratchDbPath("bundle-template")), "bundle-template-"));
  const root = templateRoot, source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "-q", "--initial-branch=main");
  writeFileSync(join(source, "tracked.txt"), "shared\n");
  git(source, "add", "tracked.txt");
  git(source, "commit", "-q", "-m", "shared");
  const shared = git(source, "rev-parse", "HEAD");
  const origin = join(root, "origin.git"), destination = join(root, "destination");
  command(root, ["git", "clone", "--bare", "-q", source, origin]);
  command(root, ["git", "clone", "-q", origin, destination]);
  writeFileSync(join(source, "tracked.txt"), "unpushed\n");
  git(source, "commit", "-q", "-a", "-m", "unpushed");
  const head = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "tracked.txt"), "staged\n");
  git(source, "add", "tracked.txt");
  writeFileSync(join(source, "tracked.txt"), "working\n");
  writeFileSync(join(source, "untracked.bin"), Buffer.from([0, 255, 17]));
  const captureJournal = openJournal(join(root, "snapshot.db"));
  captureJournal.begin({ id: "move-1", kind: "workspace-snapshot", machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: null, args: {} });
  const snapshot = { ...await snapshotWorkspace({ root: source, cwd: source, repoKey: "fixture-repo",
    workspaceId: "fixture-workspace", moveId: "move-1", stage: "pre", writers: [] }, {
    journal: captureJournal, limits: { ...DEFAULT_LIMITS }, scratch: join(root, "capture"), worktreeCommand: null,
    async run(cwd, argv, options) { return execFileSync("git", [...argv], { cwd, env: { ...environment, ...options?.env },
      input: options?.stdin, stdio: ["pipe", "pipe", "pipe"] }); },
  }), prerequisites: [shared] };
  templateSnapshot = snapshot; templateShared = shared;
  {
  const preCommit = git(source, "rev-parse", snapshot.refs[1]);
  const indexCommit = git(source, "rev-parse", snapshot.refs[0]);
  writeFileSync(join(source, "tracked.txt"), "final working content\n");
  const privateIndex = join(dirname(source), "final-index");
  copyFileSync(join(source, ".git", "index"), privateIndex);
  command(source, ["git", "add", "-A"], { GIT_INDEX_FILE: privateIndex });
  const workingTree = command(source, ["git", "write-tree"], { GIT_INDEX_FILE: privateIndex }).toString("utf8").trim();
  const workingCommit = git(source, "commit-tree", workingTree, "-p", indexCommit, "-m", "final working");
  const refs = ["refs/spider-roam/move-1/final/index", "refs/spider-roam/move-1/final/working"];
  git(source, "update-ref", refs[0], indexCommit);
  git(source, "update-ref", refs[1], workingCommit);
  templateFinal = { ...snapshot, stage: "final", refs, workingTree, prerequisites: [shared, preCommit] };
  templatePreCommit = preCommit;
  writeFileSync(join(source, "tracked.txt"), "working\n");
  }
}, 30000);
afterAll(() => { if (templateRoot) rmSync(templateRoot, { recursive: true, force: true }); });

function fixture(): { snapshot: WorkspaceSnapshot; shared: string; destination: string; ports: GitPorts; calls: string[][] } {
  const root = mkdtempSync(join(dirname(scratchDbPath("workspace-bundle")), "workspace-bundle-"));
  roots.push(root);
  const source = join(root, "source"), destination = join(root, "destination"), scratch = join(root, "staging");
  for (const name of ["source", "origin.git", "destination"]) cpSync(join(templateRoot, name), join(root, name), { recursive: true });
  const config = join(destination, ".git", "config");
  writeFileSync(config, readFileSync(config, "utf8").replaceAll(join(templateRoot, "origin.git"), join(root, "origin.git")));
  const snapshot = { ...templateSnapshot, root: source }, shared = templateShared;
  const journal = openJournal(join(root, "journal.db"));
  journal.begin({ id: snapshot.moveId, machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: 1, kind: "move", args: {} });
  const calls: string[][] = [];
  const ports: GitPorts = {
    journal, limits: { ...DEFAULT_LIMITS }, scratch, worktreeCommand: null,
    async run(cwd, argv, options) {
      calls.push([...argv]);
      return command(cwd, argv, options?.env);
    },
  };
  return { snapshot, shared, destination, ports, calls };
}

function finalSnapshot(snapshot: WorkspaceSnapshot, shared: string): { final: WorkspaceSnapshot; preCommit: string } {
  if (shared !== templateShared) throw new Error("fixture prerequisite changed");
  return { final: { ...templateFinal, root: snapshot.root }, preCommit: templatePreCommit };
}

it("missing prerequisites refuse without full-history fallback", async () => {
  const { snapshot, ports, calls } = fixture();
  const { bundleWorkspace } = await import("../git-bundle");
  await expect(bundleWorkspace(snapshot, [], ports)).rejects.toThrow(/prerequisite|fetch|setup/i);
  const fullHistoryFallbackCalls = calls.filter(args => args[0] === "git" && args[1] === "bundle" && args[2] === "create").length;
  expect(fullHistoryFallbackCalls).toBe(0);
}, 5000);

it.each(["foreign ref", "wrong working tree", "wrong parent"] as const)("refuses a snapshot with a %s", async mutation => {
  const { snapshot, shared, ports, calls } = fixture();
  const changed: WorkspaceSnapshot = mutation === "foreign ref" ? { ...snapshot, refs: ["refs/heads/main"] }
    : mutation === "wrong working tree" ? { ...snapshot, workingTree: snapshot.indexTree }
    : { ...snapshot, head: shared };
  const { bundleWorkspace } = await import("../git-bundle");
  await expect(bundleWorkspace(changed, [shared], ports)).rejects.toThrow(/workspace-snapshot-invalid/i);
  expect(calls.some(args => args[0] === "git" && args[1] === "bundle" && args[2] === "create")).toBe(false);
}, 5000);

it("verified shared prerequisites preserve the unpushed commit and both snapshot trees", async () => {
  const { snapshot, shared, destination, ports } = fixture();
  const { bundleWorkspace } = await import("../git-bundle");
  const result = await bundleWorkspace(snapshot, [shared], ports);
  expect(result.bundle.kind).toBe("ready");
  if (result.bundle.kind !== "ready") throw new Error("bundle is not ready");
  const store = openOutgoingStaging(ports.scratch, ports.limits, false);
  let bytes: Buffer;
  try {
    const manifest = store.inspect(result.bundle.artifactId).current;
    if (!manifest) throw new Error("bundle is not staged");
    expect(manifest.kind).toBe("workspace");
    expect(manifest.byteLength).toBe(result.bundle.byteLength);
    bytes = Buffer.concat(manifest.chunks.map(chunk => readFileSync(sourceChunk(ports.scratch, manifest.id, chunk.index, chunk.sha256))));
  } finally { store.close(); }
  const artifact = join(dirname(destination), "received.bundle");
  writeFileSync(artifact, bytes!);
  git(destination, "bundle", "verify", artifact);
  git(destination, "fetch", "-q", artifact, ...snapshot.refs.map(ref => `${ref}:${ref}`));
  expect(git(destination, "rev-parse", `${snapshot.refs[0]}^{tree}`)).toBe(snapshot.indexTree);
  expect(git(destination, "rev-parse", `${snapshot.refs[1]}^{tree}`)).toBe(snapshot.workingTree);
  expect(git(destination, "rev-parse", `${snapshot.refs[0]}^`)).toBe(snapshot.head);
  const empty = join(dirname(destination), "without-prerequisite");
  mkdirSync(empty);
  git(empty, "init", "-q", "--initial-branch=main");
  expect(() => git(empty, "bundle", "verify", artifact)).toThrow();
}, 5000);

function reconstruct(snapshot: WorkspaceSnapshot, ports: GitPorts, file: string): void {
  if (snapshot.bundle.kind !== "ready") throw new Error("bundle is not ready");
  const store = openOutgoingStaging(ports.scratch, ports.limits, false);
  try {
    const manifest = store.inspect(snapshot.bundle.artifactId).current;
    if (!manifest) throw new Error("bundle is not staged");
    writeFileSync(file, Buffer.concat(manifest.chunks.map(chunk => readFileSync(sourceChunk(ports.scratch, manifest.id, chunk.index, chunk.sha256)))));
  } finally { store.close(); }
}

it("final delta advertises an unchanged index whose object is in the pre-stage", async () => {
  const { snapshot, shared, destination, ports } = fixture();
  const { bundleWorkspace } = await import("../git-bundle");
  const pre = await bundleWorkspace(snapshot, [shared], ports);
  const preFile = join(dirname(destination), "pre.bundle");
  reconstruct(pre, ports, preFile);
  git(destination, "fetch", "-q", preFile, ...pre.refs.map(ref => `${ref}:${ref}`));
  const { final, preCommit } = finalSnapshot(snapshot, shared);
  const ready = await bundleWorkspace(final, [shared, preCommit], ports);
  const finalFile = join(dirname(destination), "final.bundle");
  reconstruct(ready, ports, finalFile);
  git(destination, "bundle", "verify", finalFile);
  git(destination, "fetch", "-q", finalFile, ...final.refs.map(ref => `${ref}:${ref}`));
  expect(git(destination, "rev-parse", `${final.refs[0]}^{tree}`)).toBe(final.indexTree);
  expect(git(destination, "rev-parse", `${final.refs[1]}^{tree}`)).toBe(final.workingTree);
}, 5000);

it("unchanged final snapshots use a prerequisite-only bundle, not full history", async () => {
  const { snapshot, shared, destination, ports, calls } = fixture();
  const { bundleWorkspace } = await import("../git-bundle");
  const pre = await bundleWorkspace(snapshot, [shared], ports);
  const preFile = join(dirname(destination), "pre.bundle");
  reconstruct(pre, ports, preFile);
  git(destination, "fetch", "-q", preFile, ...pre.refs.map(ref => `${ref}:${ref}`));
  const preCommit = git(snapshot.root, "rev-parse", snapshot.refs[1]);
  const indexCommit = git(snapshot.root, "rev-parse", snapshot.refs[0]);
  const refs = ["refs/spider-roam/move-1/final/index", "refs/spider-roam/move-1/final/working"];
  git(snapshot.root, "update-ref", refs[0], indexCommit); git(snapshot.root, "update-ref", refs[1], preCommit);
  const final = { ...snapshot, stage: "final" as const, refs, prerequisites: [shared, preCommit] };
  const ready = await bundleWorkspace(final, [shared, preCommit], ports);
  const finalFile = join(dirname(destination), "unchanged.bundle");
  reconstruct(ready, ports, finalFile);
  git(destination, "bundle", "verify", finalFile);
  git(destination, "fetch", "-q", finalFile, ...refs.map(ref => `${ref}:${ref}`));
  expect(git(destination, "rev-parse", `${refs[0]}^{tree}`)).toBe(snapshot.indexTree);
  expect(git(destination, "rev-parse", `${refs[1]}^{tree}`)).toBe(snapshot.workingTree);
  if (pre.bundle.kind !== "ready" || ready.bundle.kind !== "ready") throw new Error("bundle is not ready");
  expect(ready.bundle.byteLength).toBeLessThan(pre.bundle.byteLength);
  const fullHistoryFallbackCalls = calls.filter(args => args[0] === "git" && args[1] === "bundle" && args[2] === "create" &&
    !args.some(arg => arg.startsWith("^"))).length;
  expect(fullHistoryFallbackCalls).toBe(0);
}, 5000);

it("pre-stage plus final delta must fit the combined workspace limit", async () => {
  const { snapshot, shared, ports } = fixture();
  const { bundleWorkspace } = await import("../git-bundle");
  const pre = await bundleWorkspace(snapshot, [shared], ports);
  if (pre.bundle.kind !== "ready") throw new Error("pre-stage bundle is not ready");
  const { final, preCommit } = finalSnapshot(snapshot, shared);
  ports.limits.workspaceBytes = pre.bundle.byteLength + 1;
  await expect(bundleWorkspace(final, [shared, preCommit], ports)).rejects.toThrow(/workspace.*(limit|size)|bundle.*(limit|large)/i);
  const completed = ports.journal.read(snapshot.moveId).filter(row => row.action === "workspace-bundle");
  expect(completed).toHaveLength(1);
  expect(completed[0].result.artifactId).toBe(pre.bundle.artifactId);
}, 5000);
