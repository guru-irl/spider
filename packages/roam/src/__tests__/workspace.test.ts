import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Blocker } from "@spider/db-core/roam/types";
import { DEFAULT_LIMITS } from "../contracts";
import type { GitPorts } from "../contracts";
import { isUnsafeWorktreeConfig, snapshotWorkspace } from "../workspace";

interface Fixture { base: string; root: string; origin: string; scratch: string; ports: GitPorts }
const roots: string[] = [];

function runGit(cwd: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }): Buffer {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  for (const key of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  Object.assign(env, options?.env);
  const result = spawnSync("git", [...argv], { cwd, env, input: options?.stdin, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`git ${argv[0]} failed: ${result.error?.message ?? result.stderr.toString()}`);
  return result.stdout;
}
function text(cwd: string, ...args: string[]): string { return runGit(cwd, args).toString().trim(); }
function git(f: Fixture, ...args: string[]): string { return text(f.root, ...args); }
function gitPath(f: Fixture, name: string): string { return resolve(f.root, git(f, "rev-parse", "--git-path", name)); }
function privateIndexTree(f: Fixture, index = gitPath(f, "index")): string {
  const copy = join(f.scratch, "assert-index");
  copyFileSync(index, copy);
  return runGit(f.root, ["write-tree"], { env: { GIT_INDEX_FILE: copy } }).toString().trim();
}
function fixture(minimal = false): Fixture {
  const parent = join(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider", "scratch", "workspace-tests");
  mkdirSync(parent, { recursive: true });
  const base = mkdtempSync(join(parent, "git-"));
  roots.push(base);
  const root = join(base, "checkout"), origin = join(base, "origin.git"), scratch = join(base, "scratch");
  mkdirSync(root); mkdirSync(scratch);
  text(root, "init", "-b", "main");
  appendFileSync(join(root, ".git", "config"), "\n[user]\n\tname = Fixture Author\n\temail = fixture@example.invalid\n[core]\n\tfilemode = true\n");
  writeFileSync(join(root, ".gitignore"), "ignored.log\n");
  writeFileSync(join(root, "binary.dat"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(root, "reverted.dat"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(root, "delete.dat"), Buffer.from([4, 0, 5]));
  writeFileSync(join(root, "old-name.dat"), Buffer.from([6, 0, 7]));
  writeFileSync(join(root, "script.sh"), "#!/bin/sh\nexit 0\n");
  if (minimal) writeFileSync(join(root, "unpushed.txt"), "local commit\n");
  text(root, "add", "--all"); text(root, "commit", "-m", "initial");
  if (!minimal) {
    text(base, "clone", "--bare", root, origin);
    text(root, "remote", "add", "origin", origin);
    writeFileSync(join(root, "unpushed.txt"), "local commit\n");
    text(root, "add", "unpushed.txt"); text(root, "commit", "-m", "local commit");
  }
  const ports: GitPorts = {
    run: async (cwd, argv, options) => runGit(cwd, argv, options),
    journal: { begin: () => ({ kind: "new", result: null }), record: () => {}, read: () => [] },
    limits: { ...DEFAULT_LIMITS }, scratch, worktreeCommand: null,
  };
  return { base, root, origin, scratch, ports };
}
function input(f: Fixture, writers: readonly Blocker[] = []) {
  return { root: f.root, cwd: f.root, repoKey: "repo-1", workspaceId: "workspace-1", moveId: "move-1", stage: "pre" as const, writers };
}
function treeFiles(f: Fixture, tree: string): string[] {
  return git(f, "ls-tree", "-r", "--name-only", tree).split("\n").filter(Boolean);
}
function blob(f: Fixture, tree: string, file: string): Buffer { return runGit(f.root, ["show", `${tree}:${file}`]); }

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("snapshot preserves real index bytes and untracked bytes", async () => {
  const f = fixture();
  const staged = Buffer.from([0, 254, 1, 3]), working = Buffer.from([0, 253, 2, 4]), untracked = Buffer.from([255, 0, 1, 128]);
  writeFileSync(join(f.root, "binary.dat"), staged); git(f, "add", "binary.dat");
  writeFileSync(join(f.root, "binary.dat"), working); writeFileSync(join(f.root, "new.dat"), untracked);
  writeFileSync(join(f.root, "ignored.log"), "ignored output\n");
  mkdirSync(join(f.root, ".spider")); writeFileSync(join(f.root, ".spider", "state"), "local only\n");
  mkdirSync(join(f.root, ".pi-subagents")); writeFileSync(join(f.root, ".pi-subagents", "state"), "local only\n");
  mkdirSync(join(f.root, "nested"));
  const head = git(f, "rev-parse", "HEAD");
  expect(() => text(f.origin, "cat-file", "-e", `${head}^{commit}`)).toThrow();
  const index = gitPath(f, "index"), sourceIndexBytesBefore = readFileSync(index);
  const sourceIndexTreeBefore = privateIndexTree(f, index);
  git(f, "config", "--remove-section", "user");

  const snapshot = await snapshotWorkspace({ ...input(f), cwd: join(f.root, "nested") }, f.ports);
  const sourceIndexBytesAfter = readFileSync(index);
  const sourceIndexTreeAfter = privateIndexTree(f, index);
  expect(sourceIndexBytesAfter).toEqual(sourceIndexBytesBefore);
  expect(sourceIndexTreeAfter).toBe(sourceIndexTreeBefore);
  expect(snapshot).toMatchObject({ root: f.root, head, branch: "refs/heads/main", objectFormat: "sha1", relativeCwd: "nested", bundle: { kind: "unbundled" }, prerequisites: [], normalization: { autocrlf: null, eol: null }, sparse: { enabled: false, cone: null } });
  expect(snapshot.indexTree).toBe(sourceIndexTreeBefore);
  expect(blob(f, snapshot.indexTree, "binary.dat")).toEqual(staged);
  expect(blob(f, snapshot.workingTree, "binary.dat")).toEqual(working);
  expect(blob(f, snapshot.workingTree, "new.dat")).toEqual(untracked);
  expect(readFileSync(join(f.root, "binary.dat"))).toEqual(working);
  expect(readFileSync(join(f.root, "new.dat"))).toEqual(untracked);
  const files = treeFiles(f, snapshot.workingTree);
  expect(files).not.toContain("ignored.log");
  expect(files.some(p => p.startsWith(".spider/") || p.startsWith(".pi-subagents/"))).toBe(false);
  expect(snapshot.refs).toEqual(["refs/spider-roam/move-1/pre/index", "refs/spider-roam/move-1/pre/working"]);
  const [indexRef, workingRef] = snapshot.refs;
  const [indexRefTree, indexParent, workingRefTree, workingParent, indexCommit] = git(f, "rev-parse", `${indexRef}^{tree}`, `${indexRef}^`, `${workingRef}^{tree}`, `${workingRef}^`, indexRef).split("\n");
  expect(indexRefTree).toBe(snapshot.indexTree);
  expect(indexParent).toBe(head);
  expect(workingRefTree).toBe(snapshot.workingTree);
  expect(workingParent).toBe(indexCommit);
  expect(git(f, "show", "-s", "--format=%an <%ae> %aI%n%cn <%ce> %cI", indexRef)).toBe(
    "Spider roaming snapshot <roam@example.invalid> 2000-01-01T00:00:00Z\nSpider roaming snapshot <roam@example.invalid> 2000-01-01T00:00:00Z",
  );
}, 5000);

it("captures staged-only binary deletion rename and mode changes", async () => {
  const f = fixture();
  const staged = Buffer.from([9, 0, 250]), working = Buffer.from([8, 0, 251]);
  writeFileSync(join(f.root, "binary.dat"), staged);
  writeFileSync(join(f.root, "reverted.dat"), Buffer.from([7, 0, 7]));
  git(f, "add", "binary.dat", "reverted.dat");
  writeFileSync(join(f.root, "binary.dat"), working);
  writeFileSync(join(f.root, "reverted.dat"), Buffer.from([1, 2, 0, 3]));
  git(f, "rm", "delete.dat"); git(f, "mv", "old-name.dat", "new-name.dat");
  chmodSync(join(f.root, "script.sh"), 0o755); git(f, "add", "script.sh");
  const sourceIndexBytesBefore = readFileSync(gitPath(f, "index"));
  const sourceIndexTreeBefore = privateIndexTree(f);
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  const sourceIndexBytesAfter = readFileSync(gitPath(f, "index"));
  const sourceIndexTreeAfter = privateIndexTree(f);
  expect(sourceIndexBytesAfter).toEqual(sourceIndexBytesBefore);
  expect(sourceIndexTreeAfter).toBe(sourceIndexTreeBefore);
  expect(blob(f, snapshot.indexTree, "binary.dat")).toEqual(staged);
  expect(blob(f, snapshot.workingTree, "binary.dat")).toEqual(working);
  expect(blob(f, snapshot.indexTree, "reverted.dat")).toEqual(Buffer.from([7, 0, 7]));
  expect(blob(f, snapshot.workingTree, "reverted.dat")).toEqual(Buffer.from([1, 2, 0, 3]));
  for (const tree of [snapshot.indexTree, snapshot.workingTree]) {
    expect(treeFiles(f, tree)).not.toContain("delete.dat");
    expect(treeFiles(f, tree)).not.toContain("old-name.dat");
    expect(blob(f, tree, "new-name.dat")).toEqual(Buffer.from([6, 0, 7]));
    expect(git(f, "ls-tree", tree, "script.sh")).toMatch(/^100755 /);
  }
}, 5000);

it("captures same-stat working edits from a racy copied index", async () => {
  const f = fixture(true);
  git(f, "config", "core.trustctime", "false");
  const file = join(f.root, "binary.dat"), time = Math.floor(Date.now() / 1000) - 30;
  writeFileSync(file, Buffer.from([1, 0, 2, 3]));
  utimesSync(file, time, time);
  git(f, "add", "binary.dat");
  writeFileSync(file, Buffer.from([9, 0, 8, 7]));
  utimesSync(file, time, time);
  utimesSync(gitPath(f, "index"), time, time);
  const indexBefore = readFileSync(gitPath(f, "index"));
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(blob(f, snapshot.indexTree, "binary.dat")).toEqual(Buffer.from([1, 0, 2, 3]));
  expect(blob(f, snapshot.workingTree, "binary.dat")).toEqual(Buffer.from([9, 0, 8, 7]));
  expect(readFileSync(gitPath(f, "index"))).toEqual(indexBefore);
}, 5000);

it("captures edits hidden by assume-unchanged without changing source flags", async () => {
  const f = fixture(true);
  git(f, "update-index", "--assume-unchanged", "binary.dat");
  const sourceIndexBytesBefore = readFileSync(gitPath(f, "index"));
  writeFileSync(join(f.root, "binary.dat"), Buffer.from([9, 8, 7]));
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(blob(f, snapshot.workingTree, "binary.dat")).toEqual(Buffer.from([9, 8, 7]));
  expect(readFileSync(gitPath(f, "index"))).toEqual(sourceIndexBytesBefore);
  expect(git(f, "ls-files", "-v", "binary.dat")).toMatch(/^h /);
}, 5000);

it("disables fsmonitor and untracked-cache shortcuts for source capture", async () => {
  const f = fixture(true), marker = join(f.base, "hook-ran"), hook = join(f.base, "fsmonitor-hook");
  writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`); chmodSync(hook, 0o755);
  git(f, "config", "core.fsmonitor", hook); git(f, "config", "core.untrackedCache", "true");
  writeFileSync(join(f.root, "new.txt"), "new content\n");
  const original = f.ports.run, calls: string[][] = [];
  const ports: GitPorts = { ...f.ports, run: (cwd, argv, options) => {
    calls.push([...argv]); return original(cwd, argv, options);
  } };
  const snapshot = await snapshotWorkspace(input(f), ports);
  expect(existsSync(marker)).toBe(false);
  expect(blob(f, snapshot.workingTree, "new.txt").toString()).toBe("new content\n");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(argv => argv.slice(0, 4).join(" ") === "-c core.fsmonitor=false -c core.untrackedCache=false")).toBe(true);
}, 5000);

it("snapshots materialized LFS content only after verifying its source object", async () => {
  const f = fixture(true);
  const content = Buffer.from([0, 9, 255, 7]), pointer = lfsPointer(content);
  installLfsClean(f);
  git(f, "config", "filter.lfs.required", "true");
  writeFileSync(join(f.root, ".gitattributes"), "*.lfs filter=lfs\n");
  writeFileSync(join(f.root, "asset.lfs"), content);
  const hash = createHash("sha256").update(content).digest("hex");
  const object = join(gitPath(f, "lfs/objects"), hash.slice(0, 2), hash.slice(2, 4), hash);
  mkdirSync(dirname(object), { recursive: true }); writeFileSync(object, content);
  git(f, "add", ".gitattributes", "asset.lfs");
  const indexBefore = readFileSync(gitPath(f, "index"));
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(blob(f, snapshot.indexTree, "asset.lfs").toString()).toBe(pointer);
  expect(blob(f, snapshot.workingTree, "asset.lfs").toString()).toBe(pointer);
  expect(readFileSync(join(f.root, "asset.lfs"))).toEqual(content);
  expect(readFileSync(gitPath(f, "index"))).toEqual(indexBefore);
}, 5000);

it("verifies linked-worktree LFS objects in the common repository", async () => {
  const f = fixture(true), linked = join(f.base, "linked-lfs");
  git(f, "worktree", "add", "--detach", linked, "HEAD");
  const content = Buffer.from([8, 0, 9]), hash = createHash("sha256").update(content).digest("hex");
  writeFileSync(join(linked, ".gitattributes"), "*.lfs filter=lfs\n");
  writeFileSync(join(linked, "asset.lfs"), lfsPointer(content));
  text(linked, "add", ".gitattributes", "asset.lfs"); writeFileSync(join(linked, "asset.lfs"), content);
  const object = join(gitPath(f, "lfs/objects"), hash.slice(0, 2), hash.slice(2, 4), hash);
  mkdirSync(dirname(object), { recursive: true }); writeFileSync(object, content);
  installLfsClean(f);
  const snapshot = await snapshotWorkspace({ ...input(f), root: linked, cwd: linked }, f.ports);
  expect(runGit(linked, ["show", `${snapshot.workingTree}:asset.lfs`]).toString()).toBe(lfsPointer(content));
  expect(readFileSync(join(linked, "asset.lfs"))).toEqual(content);
}, 5000);

it("records detached HEAD in a linked worktree without changing either index", async () => {
  const f = fixture(true);
  const linked = join(f.base, "linked");
  git(f, "worktree", "add", "--detach", linked, "HEAD");
  const linkedIndex = resolve(linked, text(linked, "rev-parse", "--git-path", "index"));
  const sourceIndexBytesBefore = readFileSync(gitPath(f, "index"));
  const linkedIndexBytesBefore = readFileSync(linkedIndex);
  const head = text(linked, "rev-parse", "HEAD");
  const snapshot = await snapshotWorkspace({ ...input(f), root: linked, cwd: linked }, f.ports);
  expect(snapshot.head).toBe(head);
  expect(snapshot.branch).toBeNull();
  expect(snapshot.root).toBe(linked);
  expect(snapshot.relativeCwd).toBe("");
  expect(readFileSync(linkedIndex)).toEqual(linkedIndexBytesBefore);
  expect(readFileSync(gitPath(f, "index"))).toEqual(sourceIndexBytesBefore);
}, 5000);

function withPublishedSnapshot(name: string, verify: (f: Fixture, first: Awaited<ReturnType<typeof snapshotWorkspace>>, before: string[]) => Promise<void>): void {
  describe(name, () => {
    let f: Fixture, first: Awaited<ReturnType<typeof snapshotWorkspace>>, before: string[];
    beforeAll(async () => {
      f = fixture(true); first = await snapshotWorkspace(input(f), f.ports);
      before = first.refs.map(ref => git(f, "rev-parse", ref));
    }, 5000);
    it("keeps the existing refs intact", async () => verify(f, first, before), 5000);
  });
}
withPublishedSnapshot("retries identical snapshots without replacing immutable refs", async (f, first, before) => {
  const retry = await snapshotWorkspace(input(f), f.ports);
  expect(retry).toEqual(first);
  expect(first.refs.map(ref => git(f, "rev-parse", ref))).toEqual(before);
});
withPublishedSnapshot("refuses conflicting snapshots without replacing immutable refs", async (f, first, before) => {
  writeFileSync(join(f.root, "binary.dat"), "later edit\n");
  await expect(snapshotWorkspace(input(f), f.ports)).rejects.toThrow(/ref|snapshot|already/i);
  expect(first.refs.map(ref => git(f, "rev-parse", ref))).toEqual(before);
});
withPublishedSnapshot("keeps pre-stage refs while capturing a later final stage", async (f, first, before) => {
  writeFileSync(join(f.root, "binary.dat"), "later edit\n");
  const final = await snapshotWorkspace({ ...input(f), stage: "final" }, f.ports);
  expect(final.refs).toEqual(["refs/spider-roam/move-1/final/index", "refs/spider-roam/move-1/final/working"]);
  expect(first.refs.map(ref => git(f, "rev-parse", ref))).toEqual(before);
  expect(blob(f, final.workingTree, "binary.dat")).toEqual(Buffer.from("later edit\n"));
});

const configCases: readonly { category: string; cases: readonly [string, string, boolean][] }[] = [
  { category: "identity and signing", cases: [
    ["user.Email", "fixture@example.invalid", true], ["AUTHOR.name", "name", true],
    ["committer.email", "fixture@example.invalid", true], ["gpg.ssh.signingKey", "key", true],
  ] },
  { category: "credentials", cases: [
    ["credential.helper", "helper", true], ["http.https://example.invalid/.extraHeader", "secret", true],
    ["auth.accessToken", "secret", true], ["auth.password", "secret", true], ["auth.apiKey", "secret", true],
    ["auth.secret", "secret", true], ["http.proxy", "https://account:secret@example.invalid", true],
    ["custom.endpoint", "https://example.invalid/?access_token=secret", true],
    ["custom.endpoint", "https://example.invalid/", false], ["http.sslverify", "true", false],
    ["http.https://account:secret@example.invalid/.sslverify", "true", true],
  ] },
  { category: "URLs and subsections", cases: [
    ["URL.https://example.invalid/.insteadOf", "x", true], ["remote.Private.Name.url", "x", true],
    ["remote.Private.Name.pushurl", "x", true], ["remote.Private.Name.fetch", "x", false],
  ] },
  { category: "commands", cases: [
    ["core.sshCommand", "x", true], ["core.hooksPath", "x", true], ["core.fsmonitor", "x", true],
    ["x.y.command", "x", true], ["filter.My.Filter.clean", "x", true], ["filter.My.Filter.smudge", "x", true],
    ["filter.My.Filter.process", "x", true], ["diff.custom.textconv", "x", true], ["gpg.program", "x", true],
    ["alias.shell", "!run", true], ["alias.shell", "  !run", true], ["alias.short", "log --oneline", false],
    ["filter.my.required", "true", false],
  ] },
  { category: "includes", cases: [
    ["include.path", "file", true], ["IncludeIf.gitdir:/example/.path", "file", true], ["core.filemode", "true", false],
  ] },
  { category: "source-machine paths", cases: [
    ["core.worktree", "../source", true], ["CORE.BARE", "true", true], ["core.excludesFile", "~/.gitignore", true],
    ["core.attributesFile", "attributes", true], ["commit.template", "template.txt", true],
    ["custom.subsection.path", "relative", true], ["custom.certFile", "relative/cert", true],
    ["custom.note", "/source/private", true], ["custom.note", "../source", true], ["custom.note", "C:relative", true], ["custom.note", "plain", false],
    ["custom.note", "private/source", true], ["custom.note", "private\\source", true], ["custom./source/private.note", "plain", true],
    ["core.quotePath", "false", false], ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*", false], ["branch.main.merge", "refs/heads/main", false],
  ] },
];
describe.each(configCases)("worktree config $category", ({ cases }) => {
  it("classifies unsafe keys without consulting the environment", () => {
    for (const [key, value, expected] of cases) expect(isUnsafeWorktreeConfig(key, value), key).toBe(expected);
  }, 5000);
});

it("copies safe worktree config and reports dropped key names without values", async () => {
  const f = fixture(true);
  git(f, "config", "extensions.worktreeConfig", "true");
  const original = [
    "# private-comment", "[core]", "\tfilemode = true # private-inline-comment", "\thooksPath = private-hook", "[user]",
    "\temail = private@example.invalid", '[remote "Private.Name"]', "\turl = https://private@example.invalid/repo",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*", '[filter "My.Filter"]', "\tclean = private-command",
    "\trequired = true", '[custom "A.B"]', '\tvalue = "literal#and;semicolons"', "\tnote = /private/source", "\tnote = safe-note",
    '[custom "/private/source"]', "\tnote = safe-value", "[alias]", "\tdual = log --oneline", "\tdual = !private-command",
    '[http "https://account:password@example.invalid/"]', "\textraHeader = private-header", "\tsslVerify = true", "[include]", "\tpath = absent-private-file", "",
  ].join("\n");
  const config = gitPath(f, "config.worktree");
  writeFileSync(config, original);
  const sourceIndexBytesBefore = readFileSync(gitPath(f, "index"));
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(snapshot.droppedConfigKeys).toEqual(["core.hookspath", "user.email", "remote.Private.Name.url", "filter.My.Filter.clean", "custom.A.B.note", "custom.<redacted>.note", "alias.dual", "http.<redacted>.extraheader", "http.<redacted>.sslverify", "include.path"]);
  expect(JSON.stringify(snapshot.droppedConfigKeys)).not.toContain("password");
  expect(snapshot.worktreeConfig).not.toContain("private-hook");
  expect(snapshot.worktreeConfig).not.toContain("private@example.invalid");
  expect(snapshot.worktreeConfig).not.toContain("private-command");
  expect(snapshot.worktreeConfig).not.toContain("password");
  expect(snapshot.worktreeConfig).not.toContain("private-comment");
  expect(snapshot.worktreeConfig).not.toContain("private-inline-comment");
  expect(snapshot.worktreeConfig).not.toContain("/private/source");
  expect(snapshot.worktreeConfig).toContain("\tnote = safe-note\n");
  expect(snapshot.worktreeConfig).toContain("literal#and;semicolons");
  expect(snapshot.worktreeConfig).toContain("\tfilemode = true ");
  expect(snapshot.worktreeConfig).toContain("\tfetch = +refs/heads/*:refs/remotes/origin/*\n");
  expect(snapshot.worktreeConfig).toContain("\tdual = log --oneline\n");
  expect(snapshot.worktreeConfig).toContain("\trequired = true\n");
  expect(readFileSync(config, "utf8")).toBe(original);
  expect(readFileSync(gitPath(f, "index"))).toEqual(sourceIndexBytesBefore);
}, 5000);

it("removes source path values while retaining other values of the same key", async () => {
  const f = fixture(true);
  git(f, "config", "extensions.worktreeConfig", "true");
  const config = gitPath(f, "config.worktree");
  const values = ["safe", "$HOMELY", "${HOME}LESS", "/private/source", "../private", "./private", "private/source", "private\\source", "~/private", "C:\\private", "\\\\server\\share", "$HOME/private", "${HOME}/private", "file:///private", "https://account:secret@example.invalid", "https://example.invalid/?access_token=secret"];
  writeFileSync(config, `[custom]\n${values.map(value => `\tnote = ${JSON.stringify(value)}`).join("\n")}\n`);
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  const result = join(f.base, "filtered-config"); writeFileSync(result, snapshot.worktreeConfig!);
  expect(text(f.root, "config", "--file", result, "--get-all", "custom.note")).toBe("safe\n$HOMELY\n${HOME}LESS");
  expect(snapshot.droppedConfigKeys).toEqual(["custom.note"]);
}, 5000);

it("records effective sparse settings from repository config", async () => {
  const f = fixture(true);
  git(f, "config", "core.sparseCheckout", "yes"); git(f, "config", "core.sparseCheckoutCone", "no");
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(snapshot.sparse).toEqual({ enabled: true, cone: false });
}, 5000);

it("records effective sparse settings from worktree config over repository config", async () => {
  const f = fixture(true);
  git(f, "config", "core.sparseCheckout", "true"); git(f, "config", "core.sparseCheckoutCone", "true");
  git(f, "config", "extensions.worktreeConfig", "true");
  git(f, "config", "--worktree", "core.sparseCheckout", "false"); git(f, "config", "--worktree", "core.sparseCheckoutCone", "false");
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(snapshot.sparse).toEqual({ enabled: false, cone: false });
}, 5000);

it("records effective sparse settings from global config", async () => {
  const f = fixture(true), config = join(f.base, "global-config"), original = f.ports.run;
  writeFileSync(config, "[core]\n\tsparseCheckout = yes\n\tsparseCheckoutCone = no\n");
  const ports: GitPorts = { ...f.ports, run: (cwd, argv, options) => original(cwd, argv, {
    ...options, env: { GIT_CONFIG_GLOBAL: config, ...options?.env },
  }) };
  const snapshot = await snapshotWorkspace(input(f), ports);
  expect(snapshot.sparse).toEqual({ enabled: true, cone: false });
}, 5000);

it("refuses invalid sparse Git booleans without publishing refs", async () => {
  const f = fixture(true), index = gitPath(f, "index"), before = readFileSync(index);
  git(f, "config", "core.sparseCheckoutCone", "not-a-boolean");
  await expect(snapshotWorkspace(input(f), f.ports)).rejects.toThrow(/git (?:config|rev-parse) failed/i);
  expect(readFileSync(index)).toEqual(before);
  git(f, "config", "--unset", "core.sparseCheckoutCone");
  expect(git(f, "for-each-ref", "--format=%(refname)", "refs/spider-roam/")).toBe("");
}, 5000);

it("retains sparse checkout patterns and omitted sparse files", async () => {
  const f = fixture(true);
  mkdirSync(join(f.root, "inside")); mkdirSync(join(f.root, "outside"));
  writeFileSync(join(f.root, "inside", "keep"), "keep\n"); writeFileSync(join(f.root, "outside", "hidden"), "hidden\n");
  git(f, "add", "inside", "outside"); git(f, "commit", "-m", "sparse files");
  git(f, "sparse-checkout", "init", "--cone"); git(f, "sparse-checkout", "set", "inside");
  const patterns = readFileSync(gitPath(f, "info/sparse-checkout"), "utf8");
  const before = readFileSync(gitPath(f, "index"));
  expect(existsSync(join(f.root, "outside", "hidden"))).toBe(false);
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(snapshot.sparsePatterns).toBe(patterns);
  expect(snapshot.sparse).toEqual({ enabled: true, cone: true });
  expect(snapshot.worktreeConfig).toContain("sparseCheckout = true");
  expect(blob(f, snapshot.workingTree, "outside/hidden").toString()).toBe("hidden\n");
  expect(readFileSync(gitPath(f, "index"))).toEqual(before);
}, 5000);

it("captures an edited materialized path outside the sparse cone", async () => {
  const f = fixture(true);
  mkdirSync(join(f.root, "inside")); mkdirSync(join(f.root, "outside"));
  writeFileSync(join(f.root, "inside", "keep"), "keep\n"); writeFileSync(join(f.root, "outside", "hidden"), "old\n");
  writeFileSync(join(f.root, "outside", "absent"), "keep omitted\n");
  git(f, "add", "inside", "outside"); git(f, "commit", "-m", "sparse files");
  git(f, "sparse-checkout", "init", "--cone"); git(f, "sparse-checkout", "set", "inside");
  mkdirSync(join(f.root, "outside"), { recursive: true });
  writeFileSync(join(f.root, "outside", "hidden"), "edited\n");
  const before = readFileSync(gitPath(f, "index"));
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(blob(f, snapshot.workingTree, "outside/hidden").toString()).toBe("edited\n");
  expect(blob(f, snapshot.workingTree, "outside/absent").toString()).toBe("keep omitted\n");
  expect(git(f, "diff-tree", "--no-commit-id", "--name-only", "-r", snapshot.indexTree, snapshot.workingTree)).not.toContain("outside/absent");
  expect(existsSync(join(f.root, "outside", "absent"))).toBe(false);
  expect(readFileSync(gitPath(f, "index"))).toEqual(before);
}, 5000);

it("captures an edited file marked skip-worktree without changing the source index", async () => {
  const f = fixture(true);
  git(f, "update-index", "--skip-worktree", "binary.dat");
  const indexBefore = readFileSync(gitPath(f, "index"));
  writeFileSync(join(f.root, "binary.dat"), Buffer.from([8, 8, 0]));
  const calls: string[][] = [], original = f.ports.run;
  const ports: GitPorts = { ...f.ports, run: (cwd, argv, options) => { calls.push([...argv]); return original(cwd, argv, options); } };
  const snapshot = await snapshotWorkspace(input(f), ports);
  expect(calls.some(argv => argv.includes("--no-skip-worktree"))).toBe(false);
  expect(blob(f, snapshot.workingTree, "binary.dat")).toEqual(Buffer.from([8, 8, 0]));
  expect(readFileSync(gitPath(f, "index"))).toEqual(indexBefore);
  expect(git(f, "ls-files", "-v", "binary.dat")).toMatch(/^S /);
}, 5000);

it("captures an ignored but tracked materialized sparse file", async () => {
  const f = fixture(true);
  writeFileSync(join(f.root, ".gitignore"), "ignored.log\nbinary.dat\n");
  git(f, "update-index", "--skip-worktree", "binary.dat");
  writeFileSync(join(f.root, "binary.dat"), Buffer.from([8, 1, 8]));
  const before = readFileSync(gitPath(f, "index"));
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(blob(f, snapshot.workingTree, "binary.dat")).toEqual(Buffer.from([8, 1, 8]));
  expect(readFileSync(gitPath(f, "index"))).toEqual(before);
}, 5000);

it("captures a materialized sparse file replaced by a directory without ignored contents", async () => {
  const f = fixture(true), path = join(f.root, "binary.dat");
  git(f, "update-index", "--skip-worktree", "binary.dat");
  rmSync(path); mkdirSync(path); writeFileSync(join(path, "keep"), "visible\n");
  writeFileSync(join(path, "ignored.log"), "ignored\n");
  mkdirSync(join(path, ".spider")); writeFileSync(join(path, ".spider", "private"), "private\n");
  const before = readFileSync(gitPath(f, "index"));
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(blob(f, snapshot.workingTree, "binary.dat/keep").toString()).toBe("visible\n");
  expect(treeFiles(f, snapshot.workingTree)).not.toContain("binary.dat/ignored.log");
  expect(treeFiles(f, snapshot.workingTree)).not.toContain("binary.dat/.spider/private");
  expect(readFileSync(gitPath(f, "index"))).toEqual(before);
}, 5000);

it("excludes ignored and local files from a sparse directory appearing during capture", async () => {
  const f = fixture(true), path = join(f.root, "binary.dat"), original = f.ports.run;
  git(f, "update-index", "--skip-worktree", "binary.dat");
  let changed = false;
  const ports: GitPorts = { ...f.ports, run: async (cwd, argv, options) => {
    const result = await original(cwd, argv, options);
    if (!changed && argv.includes("add") && argv.includes("-A") && argv.includes(".")) {
      changed = true; rmSync(path); mkdirSync(path);
      writeFileSync(join(path, "keep"), "visible\n"); writeFileSync(join(path, "ignored.log"), "ignored\n");
      mkdirSync(join(path, ".spider")); writeFileSync(join(path, ".spider", "private"), "private\n");
    }
    return result;
  } };
  const before = readFileSync(gitPath(f, "index"));
  const snapshot = await snapshotWorkspace(input(f), ports);
  expect(changed).toBe(true);
  expect(blob(f, snapshot.workingTree, "binary.dat/keep").toString()).toBe("visible\n");
  expect(treeFiles(f, snapshot.workingTree)).not.toContain("binary.dat/ignored.log");
  expect(treeFiles(f, snapshot.workingTree)).not.toContain("binary.dat/.spider/private");
  expect(readFileSync(gitPath(f, "index"))).toEqual(before);
}, 5000);

it("captures executable-bit changes in a materialized sparse file", async () => {
  const f = fixture(true), file = join(f.root, "script.sh");
  git(f, "update-index", "--skip-worktree", "script.sh");
  writeFileSync(file, "#!/bin/sh\necho changed\n"); chmodSync(file, 0o755);
  const before = readFileSync(gitPath(f, "index"));
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(git(f, "ls-tree", snapshot.workingTree, "script.sh")).toMatch(/^100755 /);
  expect(readFileSync(gitPath(f, "index"))).toEqual(before);
}, 5000);

it("retains staged executable mode for sparse overlay when filemode is disabled", async () => {
  const f = fixture(true), file = join(f.root, "script.sh");
  chmodSync(file, 0o755); git(f, "add", "script.sh"); git(f, "config", "--replace-all", "core.filemode", "false");
  git(f, "update-index", "--skip-worktree", "script.sh");
  writeFileSync(file, "#!/bin/sh\necho changed\n"); chmodSync(file, 0o644);
  const before = readFileSync(gitPath(f, "index"));
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(git(f, "ls-tree", snapshot.workingTree, "script.sh")).toMatch(/^100755 /);
  expect(blob(f, snapshot.workingTree, "script.sh").toString()).toContain("changed");
  expect(readFileSync(gitPath(f, "index"))).toEqual(before);
}, 5000);

it("retains symlink representation for sparse overlay when symlinks are disabled", async () => {
  const f = fixture(true), file = join(f.root, "portable-link");
  symlinkSync("binary.dat", file); git(f, "add", "portable-link"); git(f, "config", "core.symlinks", "false");
  git(f, "update-index", "--skip-worktree", "portable-link");
  rmSync(file); writeFileSync(file, "missing-target");
  const before = readFileSync(gitPath(f, "index"));
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(git(f, "ls-tree", snapshot.workingTree, "portable-link")).toMatch(/^120000 /);
  expect(blob(f, snapshot.workingTree, "portable-link").toString()).toBe("missing-target");
  expect(readFileSync(gitPath(f, "index"))).toEqual(before);
}, 5000);

it("refuses changed custom-filtered files whose blobs differ and names every path", async () => {
  const f = fixture(true);
  writeFileSync(join(f.root, ".gitattributes"), "*.coded filter=case\n");
  git(f, "config", "filter.case.clean", "tr A-Z a-z"); git(f, "config", "filter.case.smudge", "tr a-z A-Z");
  writeFileSync(join(f.root, "a.coded"), "FIRST\n"); writeFileSync(join(f.root, "b.coded"), "SECOND\n");
  const before = readFileSync(gitPath(f, "index"));
  await expect(snapshotWorkspace(input(f), f.ports)).rejects.toThrow(/a\.coded[\s\S]*b\.coded[\s\S]*commit or stash/i);
  expect(readFileSync(gitPath(f, "index"))).toEqual(before);
  expect(git(f, "for-each-ref", "--format=%(refname)", "refs/spider-roam/")).toBe("");
}, 5000);

it("names all transformed files even when their smudge command fails", async () => {
  const f = fixture(true);
  writeFileSync(join(f.root, ".gitattributes"), "*.coded filter=broken\n");
  git(f, "config", "filter.broken.clean", "tr A-Z a-z"); git(f, "config", "filter.broken.smudge", "false");
  git(f, "config", "filter.broken.required", "true");
  writeFileSync(join(f.root, "a.coded"), "FIRST\n"); writeFileSync(join(f.root, "b.coded"), "SECOND\n");
  await expect(snapshotWorkspace(input(f), f.ports)).rejects.toThrow(/a\.coded[\s\S]*b\.coded[\s\S]*commit or stash/i);
  expect(git(f, "for-each-ref", "--format=%(refname)", "refs/spider-roam/")).toBe("");
}, 5000);

it("permits changed custom-filtered files when stored and working bytes match", async () => {
  const f = fixture(true);
  writeFileSync(join(f.root, ".gitattributes"), "*.coded filter=identity\n");
  git(f, "config", "filter.identity.clean", "tr a-z a-z"); git(f, "config", "filter.identity.smudge", "tr a-z a-z");
  writeFileSync(join(f.root, "a.coded"), "value\n");
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(blob(f, snapshot.workingTree, "a.coded").toString()).toBe("value\n");
}, 5000);

it("records the effective source Git normalization settings", async () => {
  const f = fixture(true);
  git(f, "config", "core.autocrlf", "input"); git(f, "config", "core.eol", "lf");
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(snapshot.normalization).toEqual({ autocrlf: "input", eol: "lf" });
}, 5000);

it("refuses changed normalized files without a tracked EOL pin and names the paths", async () => {
  const f = fixture(true);
  git(f, "config", "core.autocrlf", "true");
  writeFileSync(join(f.root, "a.text"), "first\r\n"); writeFileSync(join(f.root, "b.text"), "second\r\n");
  const before = readFileSync(gitPath(f, "index"));
  await expect(snapshotWorkspace(input(f), f.ports)).rejects.toThrow(/a\.text[\s\S]*b\.text[\s\S]*commit.*first/i);
  expect(readFileSync(gitPath(f, "index"))).toEqual(before);
  expect(git(f, "for-each-ref", "--format=%(refname)", "refs/spider-roam/")).toBe("");
}, 5000);

it("does not treat an untracked attributes file as a portable EOL pin", async () => {
  const f = fixture(true);
  writeFileSync(join(f.root, ".gitattributes"), "*.text text eol=crlf\n");
  writeFileSync(join(f.root, "line.text"), "line\r\n");
  await expect(snapshotWorkspace(input(f), f.ports)).rejects.toThrow(/line\.text[\s\S]*commit.*first/i);
}, 5000);

it("ignores an untracked nested EOL rule when another attributes file is tracked", async () => {
  const f = fixture(true);
  writeFileSync(join(f.root, ".gitattributes"), "*.md text\n"); git(f, "add", ".gitattributes");
  mkdirSync(join(f.root, "nested"));
  writeFileSync(join(f.root, "nested", ".gitattributes"), "*.text text eol=crlf\n");
  writeFileSync(join(f.root, "nested", "line.text"), "line\r\n");
  await expect(snapshotWorkspace(input(f), f.ports)).rejects.toThrow(/nested\/line\.text[\s\S]*commit.*first/i);
}, 5000);

it("does not treat ignored attributes as a portable EOL pin", async () => {
  const f = fixture(true);
  writeFileSync(join(f.root, ".gitignore"), "ignored.log\n.gitattributes\n");
  writeFileSync(join(f.root, ".gitattributes"), "*.text text eol=crlf\n");
  writeFileSync(join(f.root, "line.text"), "line\r\n");
  await expect(snapshotWorkspace(input(f), f.ports)).rejects.toThrow(/line\.text[\s\S]*commit.*first/i);
}, 5000);

it("does not treat local info attributes as a portable EOL pin", async () => {
  const f = fixture(true);
  writeFileSync(gitPath(f, "info/attributes"), "*.text text eol=crlf\n");
  writeFileSync(join(f.root, "line.text"), "line\r\n");
  await expect(snapshotWorkspace(input(f), f.ports)).rejects.toThrow(/line\.text[\s\S]*commit.*first/i);
}, 5000);

it("refuses an EOL pin overridden by local info attributes", async () => {
  const f = fixture(true);
  writeFileSync(join(f.root, ".gitattributes"), "*.text text eol=lf\n"); git(f, "add", ".gitattributes");
  writeFileSync(gitPath(f, "info/attributes"), "*.text eol=crlf\n");
  writeFileSync(join(f.root, "line.text"), "line\r\n");
  await expect(snapshotWorkspace(input(f), f.ports)).rejects.toThrow(/line\.text[\s\S]*commit.*first/i);
}, 5000);

it("permits changed files whose line-ending conversion preserves bytes", async () => {
  const f = fixture(true);
  writeFileSync(join(f.root, ".gitattributes"), "*.text text eol=crlf\n"); git(f, "add", ".gitattributes");
  writeFileSync(join(f.root, "lines.text"), "one\r\ntwo\r\n");
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(blob(f, snapshot.workingTree, "lines.text").toString()).toBe("one\ntwo\n");
  expect(readFileSync(join(f.root, "lines.text"), "utf8")).toBe("one\r\ntwo\r\n");
}, 5000);

it("preserves safe and dangling relative symlinks", async () => {
  const f = fixture(true);
  symlinkSync("binary.dat", join(f.root, "safe-link"));
  symlinkSync("missing-target", join(f.root, "dangling-link"));
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(blob(f, snapshot.workingTree, "safe-link").toString()).toBe("binary.dat");
  expect(blob(f, snapshot.workingTree, "dangling-link").toString()).toBe("missing-target");
  expect(git(f, "ls-tree", snapshot.workingTree, "safe-link")).toMatch(/^120000 /);
}, 5000);

it("refuses an index change by another writer before publishing refs", async () => {
  const f = fixture(true);
  const original = f.ports.run;
  let edited = false;
  const ports: GitPorts = { ...f.ports, run: async (cwd, argv, options) => {
    if (!edited && argv.includes("commit-tree")) {
      edited = true; writeFileSync(join(f.root, "binary.dat"), Buffer.from([8, 1, 0])); git(f, "add", "binary.dat");
    }
    return original(cwd, argv, options);
  } };
  await expect(snapshotWorkspace(input(f), ports)).rejects.toThrow(/index.*chang/i);
  expect(git(f, "for-each-ref", "--format=%(refname)", "refs/spider-roam/")).toBe("");
  expect(runGit(f.root, ["show", ":binary.dat"])).toEqual(Buffer.from([8, 1, 0]));
}, 5000);

it("refuses concurrent source normalization changes before publishing refs", async () => {
  const f = fixture(true), original = f.ports.run;
  let edited = false;
  const ports: GitPorts = { ...f.ports, run: async (cwd, argv, options) => {
    if (!edited && argv.includes("commit-tree")) { edited = true; git(f, "config", "core.autocrlf", "true"); }
    return original(cwd, argv, options);
  } };
  await expect(snapshotWorkspace(input(f), ports)).rejects.toThrow(/normalization.*changed/i);
  expect(git(f, "for-each-ref", "--format=%(refname)", "refs/spider-roam/")).toBe("");
}, 5000);

it("refuses concurrent sparse configuration changes before publishing refs", async () => {
  const f = fixture(true), original = f.ports.run;
  let edited = false;
  const ports: GitPorts = { ...f.ports, run: async (cwd, argv, options) => {
    if (!edited && argv.includes("commit-tree")) { edited = true; git(f, "config", "core.sparseCheckoutCone", "true"); }
    return original(cwd, argv, options);
  } };
  await expect(snapshotWorkspace(input(f), ports)).rejects.toThrow(/sparse.*changed/i);
  expect(git(f, "for-each-ref", "--format=%(refname)", "refs/spider-roam/")).toBe("");
}, 5000);

it("refuses concurrent sparse pattern changes before publishing refs", async () => {
  const f = fixture(true), original = f.ports.run;
  git(f, "sparse-checkout", "init", "--cone");
  const patterns = gitPath(f, "info/sparse-checkout");
  let edited = false;
  const ports: GitPorts = { ...f.ports, run: async (cwd, argv, options) => {
    if (!edited && argv.includes("commit-tree")) { edited = true; writeFileSync(patterns, "/*\n"); }
    return original(cwd, argv, options);
  } };
  await expect(snapshotWorkspace(input(f), ports)).rejects.toThrow(/sparse.*changed/i);
  expect(git(f, "for-each-ref", "--format=%(refname)", "refs/spider-roam/")).toBe("");
}, 5000);

it("refuses a concurrent symbolic HEAD change before publishing refs", async () => {
  const f = fixture(true);
  git(f, "branch", "other", "HEAD");
  const original = f.ports.run;
  let edited = false;
  const ports: GitPorts = { ...f.ports, run: async (cwd, argv, options) => {
    if (!edited && argv.includes("commit-tree")) {
      edited = true; git(f, "symbolic-ref", "HEAD", "refs/heads/other");
    }
    return original(cwd, argv, options);
  } };
  await expect(snapshotWorkspace(input(f), ports)).rejects.toThrow(/HEAD.*chang/i);
  expect(git(f, "symbolic-ref", "HEAD")).toBe("refs/heads/other");
  expect(git(f, "for-each-ref", "--format=%(refname)", "refs/spider-roam/")).toBe("");
}, 5000);

it("snapshots a split index without changing its bytes", async () => {
  const f = fixture(true);
  git(f, "update-index", "--split-index");
  const indexBefore = readFileSync(gitPath(f, "index"));
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(snapshot.indexTree).toBe(privateIndexTree(f));
  expect(readFileSync(gitPath(f, "index"))).toEqual(indexBefore);
}, 5000);

it("uses the checkout index rather than an inherited alternate index", async () => {
  const f = fixture(true);
  const alternate = join(f.base, "alternate-index");
  runGit(f.root, ["read-tree", "HEAD"], { env: { GIT_INDEX_FILE: alternate } });
  writeFileSync(join(f.root, "binary.dat"), Buffer.from([3, 0, 3])); git(f, "add", "binary.dat");
  const expected = privateIndexTree(f), original = f.ports.run;
  const ports: GitPorts = { ...f.ports, run: (cwd, argv, options) => original(cwd, argv, {
    ...options, env: { GIT_INDEX_FILE: alternate, ...options?.env },
  }) };
  const snapshot = await snapshotWorkspace(input(f), ports);
  expect(snapshot.indexTree).toBe(expected);
  expect(blob(f, snapshot.indexTree, "binary.dat")).toEqual(Buffer.from([3, 0, 3]));
}, 5000);

it("accepts a worktree root ending in whitespace", async () => {
  const f = fixture(true), linked = join(f.base, "linked ");
  git(f, "worktree", "add", "--detach", linked, "HEAD");
  const snapshot = await snapshotWorkspace({ ...input(f), root: linked, cwd: linked }, f.ports);
  expect(snapshot.root).toBe(linked);
  expect(snapshot.head).toBe(text(linked, "rev-parse", "HEAD"));
}, 5000);

it("does not expose raw Git errors that may contain private content", async () => {
  const f = fixture(true), original = f.ports.run;
  const ports: GitPorts = { ...f.ports, run: (cwd, argv, options) => {
    if (argv.includes("commit-tree")) return Promise.reject(new Error("private command output"));
    return original(cwd, argv, options);
  } };
  try { await snapshotWorkspace(input(f), ports); throw new Error("snapshot unexpectedly succeeded"); }
  catch (error) {
    expect((error as Error).message).toMatch(/git.*commit-tree/i);
    expect((error as Error).message).not.toContain("private command output");
  }
  expect(git(f, "for-each-ref", "--format=%(refname)", "refs/spider-roam/")).toBe("");
}, 5000);

it("ignores an excluded special file rather than trying to snapshot it", async () => {
  const f = fixture(true);
  writeFileSync(join(f.root, ".gitignore"), "ignored.log\n*.pipe\n");
  const result = spawnSync("mkfifo", [join(f.root, "ignored.pipe")]);
  if (result.status !== 0) throw new Error("could not create fixture fifo");
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(treeFiles(f, snapshot.workingTree)).not.toContain("ignored.pipe");
}, 5000);

it("records a SHA-256 repository without changing its index", async () => {
  const f = fixture(true), root = join(f.base, "sha256");
  mkdirSync(root); text(root, "init", "--object-format=sha256", "-b", "main");
  text(root, "config", "user.name", "Fixture Author"); text(root, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "data"), "sha256\n"); text(root, "add", "data"); text(root, "commit", "-m", "initial");
  const index = resolve(root, text(root, "rev-parse", "--git-path", "index")), before = readFileSync(index);
  const snapshot = await snapshotWorkspace({ ...input(f), root, cwd: root }, f.ports);
  expect(snapshot.objectFormat).toBe("sha256");
  expect(snapshot.head).toMatch(/^[a-f0-9]{64}$/);
  expect(snapshot.indexTree).toMatch(/^[a-f0-9]{64}$/);
  expect(readFileSync(index)).toEqual(before);
}, 5000);

it("excludes local state even when its path is a symlink", async () => {
  const f = fixture(true);
  symlinkSync(f.base, join(f.root, ".spider")); symlinkSync(f.base, join(f.root, ".pi-subagents"));
  const snapshot = await snapshotWorkspace(input(f), f.ports);
  expect(treeFiles(f, snapshot.workingTree)).not.toContain(".spider");
  expect(treeFiles(f, snapshot.workingTree)).not.toContain(".pi-subagents");
}, 5000);

it("excludes its private scratch directory when scratch is inside the checkout", async () => {
  const f = fixture(true), scratch = join(f.root, "scratch[1]");
  const snapshot = await snapshotWorkspace(input(f), { ...f.ports, scratch });
  expect(treeFiles(f, snapshot.workingTree).some(path => path.startsWith("scratch[1]/workspace-"))).toBe(false);
  expect(git(f, "status", "--porcelain")).not.toContain("workspace-");
}, 5000);

it("rejects unsafe move IDs and a cwd outside the checkout", async () => {
  const f = fixture(true);
  await expect(snapshotWorkspace({ ...input(f), moveId: "../other" }, f.ports)).rejects.toThrow(/invalid move ID/i);
  await expect(snapshotWorkspace({ ...input(f), stage: "pre\ncreate refs/injected" as never }, f.ports)).rejects.toThrow(/stage/i);
  await expect(snapshotWorkspace({ ...input(f), cwd: f.base }, f.ports)).rejects.toThrow(/cwd|outside/i);
  expect(git(f, "for-each-ref", "--format=%(refname)", "refs/spider-roam/")).toBe("");
}, 5000);

type Refusal = { name: string; reason: RegExp; arrange: (f: Fixture) => readonly Blocker[] | void };
const refusals: readonly Refusal[] = [
  { name: "merge", reason: /merge/i, arrange: f => { writeFileSync(gitPath(f, "MERGE_HEAD"), `${git(f, "rev-parse", "HEAD")}\n`); } },
  { name: "rebase", reason: /rebase/i, arrange: f => { mkdirSync(gitPath(f, "rebase-merge")); } },
  { name: "unresolved index", reason: /unresolved|unmerged|conflict/i, arrange: f => {
    const oid = git(f, "rev-parse", "HEAD:binary.dat");
    runGit(f.root, ["update-index", "-z", "--index-info"], { stdin: Buffer.from(`100644 ${oid} 1\tconflict.dat\0` + `100644 ${oid} 2\tconflict.dat\0` + `100644 ${oid} 3\tconflict.dat\0`) });
  } },
  { name: "submodule", reason: /submodule|gitlink/i, arrange: f => {
    git(f, "update-index", "--add", "--cacheinfo", `160000,${git(f, "rev-parse", "HEAD")},linked-repo`);
  } },
  { name: "escaping working symlink", reason: /symlink/i, arrange: f => { symlinkSync("../outside", join(f.root, "outside-link")); } },
  { name: "Windows relative symlink escape", reason: /symlink/i, arrange: f => { symlinkSync("..\\outside", join(f.root, "windows-link")); } },
  { name: "Windows drive symlink escape", reason: /symlink/i, arrange: f => { symlinkSync("C:\\outside", join(f.root, "windows-link")); } },
  { name: "Windows UNC symlink escape", reason: /symlink/i, arrange: f => { symlinkSync("\\\\server\\share", join(f.root, "windows-link")); } },
  { name: "Windows staged relative symlink escape", reason: /symlink/i, arrange: f => {
    const link = join(f.root, "windows-link"); symlinkSync("..\\outside", link); git(f, "add", "windows-link");
    rmSync(link); symlinkSync("binary.dat", link);
  } },
  { name: "Windows staged drive symlink escape", reason: /symlink/i, arrange: f => {
    const link = join(f.root, "windows-link"); symlinkSync("C:\\outside", link); git(f, "add", "windows-link");
    rmSync(link); symlinkSync("binary.dat", link);
  } },
  { name: "escaping staged symlink", reason: /symlink/i, arrange: f => {
    const file = join(f.root, "staged-link"); symlinkSync("../outside", file); git(f, "add", "staged-link");
    rmSync(file); symlinkSync("binary.dat", file);
  } },
  { name: "symlink through ignored external link", reason: /symlink/i, arrange: f => {
    writeFileSync(join(f.root, ".gitignore"), "ignored.log\nredirect\n");
    writeFileSync(join(f.base, "outside"), "outside\n");
    symlinkSync(f.base, join(f.root, "redirect")); symlinkSync("redirect/outside", join(f.root, "indirect-link"));
  } },
  { name: "staged symlink through ignored external link", reason: /symlink/i, arrange: f => {
    writeFileSync(join(f.root, ".gitignore"), "ignored.log\nredirect\n");
    writeFileSync(join(f.base, "outside"), "outside\n");
    symlinkSync(f.base, join(f.root, "redirect"));
    const link = join(f.root, "indirect-link");
    symlinkSync("redirect/outside", link); git(f, "add", "indirect-link");
    rmSync(link); symlinkSync("binary.dat", link);
  } },
  { name: "case-fold collision", reason: /case|collision/i, arrange: f => {
    const oid = git(f, "rev-parse", "HEAD:binary.dat");
    git(f, "update-index", "--add", "--cacheinfo", `100644,${oid},Case.dat`);
    git(f, "update-index", "--add", "--cacheinfo", `100644,${oid},case.dat`);
  } },
  { name: "Unicode case-fold collision", reason: /case|collision/i, arrange: f => {
    const oid = git(f, "rev-parse", "HEAD:binary.dat");
    git(f, "update-index", "--add", "--cacheinfo", `100644,${oid},ß.dat`);
    git(f, "update-index", "--add", "--cacheinfo", `100644,${oid},ẞ.dat`);
  } },
  { name: "Unicode normalization collision", reason: /case|collision/i, arrange: f => {
    git(f, "config", "core.precomposeunicode", "false");
    const oid = git(f, "rev-parse", "HEAD:binary.dat");
    git(f, "update-index", "--add", "--cacheinfo", `100644,${oid},é.dat`);
    git(f, "update-index", "--add", "--cacheinfo", `100644,${oid},é.dat`);
    const paths = runGit(f.root, ["ls-files", "-z"]).toString().split("\0");
    expect(paths).toContain("é.dat"); expect(paths).toContain("é.dat");
  } },
  { name: "case-folded directory collision", reason: /case|collision/i, arrange: f => {
    const oid = git(f, "rev-parse", "HEAD:binary.dat");
    git(f, "update-index", "--add", "--cacheinfo", `100644,${oid},Dir/one`);
    git(f, "update-index", "--add", "--cacheinfo", `100644,${oid},dir/two`);
  } },
  { name: "unsupported fifo", reason: /unsupported|file type/i, arrange: f => {
    const result = spawnSync("mkfifo", [join(f.root, "pipe")]);
    if (result.status !== 0) throw new Error("could not create fixture fifo");
  } },
  { name: "tracked fifo below an ignored directory", reason: /unsupported|file type/i, arrange: f => {
    writeFileSync(join(f.root, ".gitignore"), "ignored.log\nignored-dir/\n");
    mkdirSync(join(f.root, "ignored-dir"));
    const file = join(f.root, "ignored-dir", "tracked");
    writeFileSync(file, "tracked\n"); git(f, "add", "-f", "ignored-dir/tracked"); rmSync(file);
    if (spawnSync("mkfifo", [file]).status !== 0) throw new Error("could not create fixture fifo");
  } },
  { name: "lfs pointer only", reason: /lfs/i, arrange: f => {
    writeFileSync(join(f.root, ".gitattributes"), "*.lfs filter=lfs\n");
    writeFileSync(join(f.root, "asset.lfs"), lfsPointer(Buffer.from("content")));
    git(f, "add", ".gitattributes", "asset.lfs");
  } },
  { name: "lfs pointer without lfs attributes", reason: /lfs/i, arrange: f => {
    const content = Buffer.from("materialized content"), hash = createHash("sha256").update(content).digest("hex");
    writeFileSync(join(f.root, "asset.lfs"), lfsPointer(content)); git(f, "add", "asset.lfs");
    writeFileSync(join(f.root, "asset.lfs"), content);
    const object = join(gitPath(f, "lfs/objects"), hash.slice(0, 2), hash.slice(2, 4), hash);
    mkdirSync(dirname(object), { recursive: true }); writeFileSync(object, content);
  } },
  { name: "missing lfs object", reason: /lfs/i, arrange: f => {
    const content = Buffer.from("materialized content");
    writeFileSync(join(f.root, ".gitattributes"), "*.lfs filter=lfs\n");
    writeFileSync(join(f.root, "asset.lfs"), lfsPointer(content));
    git(f, "add", ".gitattributes", "asset.lfs");
    writeFileSync(join(f.root, "asset.lfs"), content); installLfsClean(f);
  } },
  { name: "lfs pointer only even when its object exists", reason: /lfs/i, arrange: f => {
    const content = Buffer.from("materialized content"), hash = createHash("sha256").update(content).digest("hex");
    writeFileSync(join(f.root, ".gitattributes"), "*.lfs filter=lfs\n");
    writeFileSync(join(f.root, "asset.lfs"), lfsPointer(content)); git(f, "add", ".gitattributes", "asset.lfs");
    const object = join(gitPath(f, "lfs/objects"), hash.slice(0, 2), hash.slice(2, 4), hash);
    mkdirSync(dirname(object), { recursive: true }); writeFileSync(object, content);
  } },
  { name: "conflicting lfs pointer sizes", reason: /lfs/i, arrange: f => {
    const content = Buffer.from("materialized content"), hash = createHash("sha256").update(content).digest("hex");
    writeFileSync(join(f.root, ".gitattributes"), "*.lfs filter=lfs\n");
    writeFileSync(join(f.root, "a.lfs"), lfsPointer(content));
    writeFileSync(join(f.root, "b.lfs"), lfsPointer(content).replace(`size ${content.length}`, `size ${content.length + 1}`));
    git(f, "add", ".gitattributes", "a.lfs", "b.lfs");
    writeFileSync(join(f.root, "a.lfs"), content); writeFileSync(join(f.root, "b.lfs"), content);
    const object = join(gitPath(f, "lfs/objects"), hash.slice(0, 2), hash.slice(2, 4), hash);
    mkdirSync(dirname(object), { recursive: true }); writeFileSync(object, content); installLfsClean(f);
  } },
  { name: "corrupt lfs object", reason: /lfs/i, arrange: f => {
    const content = Buffer.from("materialized content"), hash = createHash("sha256").update(content).digest("hex");
    writeFileSync(join(f.root, ".gitattributes"), "*.lfs filter=lfs\n");
    writeFileSync(join(f.root, "asset.lfs"), lfsPointer(content)); git(f, "add", ".gitattributes", "asset.lfs");
    writeFileSync(join(f.root, "asset.lfs"), content);
    const object = join(gitPath(f, "lfs/objects"), hash.slice(0, 2), hash.slice(2, 4), hash);
    mkdirSync(dirname(object), { recursive: true }); writeFileSync(object, Buffer.alloc(content.length, 1)); installLfsClean(f);
  } },
  { name: "lossy filter", reason: /filter|normaliz/i, arrange: f => {
    writeFileSync(join(f.root, ".gitattributes"), "*.lossy filter=lossy\n");
    git(f, "config", "filter.lossy.clean", "tr -d x"); git(f, "config", "filter.lossy.smudge", "tr a-z a-z");
    writeFileSync(join(f.root, "changed.lossy"), "xabc\n");
  } },
  { name: "changed attributes alter existing file bytes", reason: /filter|normaliz/i, arrange: f => {
    writeFileSync(join(f.root, ".gitattributes"), "unpushed.txt filter=uppercase\n");
    git(f, "config", "filter.uppercase.smudge", "tr a-z A-Z");
  } },
  { name: "lossy line endings", reason: /filter|normaliz/i, arrange: f => {
    writeFileSync(join(f.root, ".gitattributes"), "*.text text eol=lf\n");
    writeFileSync(join(f.root, "changed.text"), "one\r\ntwo\r\n");
  } },
  { name: "known writer", reason: /writer-1/, arrange: () => [{ kind: "run", id: "writer-1", detail: "active" }] },
  { name: "tracked local state", reason: /local state|\.spider/i, arrange: f => {
    mkdirSync(join(f.root, ".spider")); writeFileSync(join(f.root, ".spider", "secret"), "local\n");
    git(f, "add", "-f", ".spider/secret");
  } },
  { name: "tracked subagent state", reason: /local state|\.pi-subagents/i, arrange: f => {
    mkdirSync(join(f.root, ".pi-subagents")); writeFileSync(join(f.root, ".pi-subagents", "secret"), "local\n");
    git(f, "add", "-f", ".pi-subagents/secret");
  } },
  { name: "local state deleted from index but present in HEAD", reason: /local state|\.spider/i, arrange: f => {
    mkdirSync(join(f.root, ".spider")); writeFileSync(join(f.root, ".spider", "secret"), "local\n");
    git(f, "add", "-f", ".spider/secret"); git(f, "commit", "-m", "tracked state"); git(f, "rm", ".spider/secret");
  } },
];
function lfsPointer(bytes: Buffer): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash("sha256").update(bytes).digest("hex")}\nsize ${bytes.length}\n`;
}
function installLfsClean(f: Fixture): void {
  const script = join(f.base, "lfs-clean.cjs");
  writeFileSync(script, 'const {createHash}=require("node:crypto"); const chunks=[]; process.stdin.on("data", c=>chunks.push(c)); process.stdin.on("end",()=>{const b=Buffer.concat(chunks); process.stdout.write("version https://git-lfs.github.com/spec/v1\\noid sha256:"+createHash("sha256").update(b).digest("hex")+"\\nsize "+b.length+"\\n")});');
  git(f, "config", "filter.lfs.clean", `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`);
}
describe.each(refusals)("$name", ({ arrange, reason }) => {
  it("refuses unsupported states without changing source", async () => {
    const f = fixture(true);
    const writers = arrange(f) ?? [];
    const sourceIndexBytesBefore = readFileSync(gitPath(f, "index"));
    const sourceHeadBefore = git(f, "rev-parse", "HEAD");
    const sourceEntriesBefore = runGit(f.root, ["ls-files", "--stage", "-z"]);
    const sourceFileBefore = readFileSync(join(f.root, "binary.dat"));
    await expect(snapshotWorkspace(input(f, writers), f.ports)).rejects.toThrow(reason);
    expect(readFileSync(gitPath(f, "index"))).toEqual(sourceIndexBytesBefore);
    expect(git(f, "rev-parse", "HEAD")).toBe(sourceHeadBefore);
    expect(runGit(f.root, ["ls-files", "--stage", "-z"])).toEqual(sourceEntriesBefore);
    expect(readFileSync(join(f.root, "binary.dat"))).toEqual(sourceFileBefore);
    expect(git(f, "for-each-ref", "--format=%(refname)", "refs/spider-roam/")).toBe("");
  }, 5000);
});

it("move ref cleanup backs off from a concurrent user git transaction and leaves live files untouched", async () => {
  const { cleanupMoveRefs } = await import("../workspace");
  const { openJournal } = await import("../journal");
  const f = fixture(true), oid = git(f, "rev-parse", "HEAD"), ref = "refs/spider-roam/move-1/pre/index";
  git(f, "update-ref", ref, oid); git(f, "update-ref", "refs/heads/user-work", oid); git(f, "pack-refs", "--all");
  f.ports.journal = openJournal(join(f.base, "cleanup.db"));
  f.ports.journal.begin({ id: "move-1", kind: "move", machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: 1, args: {} });
  f.ports.journal.record("move-1", "workspace-snapshot-refs", { root: f.root, refs: [{ ref, oid }] });
  const files = [join(f.root, "binary.dat"), gitPath(f, "index"), gitPath(f, "config")], before = files.map(file => readFileSync(file));
  const user = spawn("git", ["update-ref", "--stdin"], { cwd: f.root, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>(resolve => user.once("exit", () => resolve()));
  try {
    const prepared = new Promise<void>((resolve, reject) => {
      let text = ""; user.stdout.on("data", bytes => { text += String(bytes); if (text.includes("prepare: ok")) resolve(); }); user.once("error", reject);
    });
    user.stdin.write(`start\ndelete refs/heads/user-work ${oid}\nprepare\n`); await prepared;
    expect(existsSync(gitPath(f, "packed-refs.lock"))).toBe(true);
    const result = await cleanupMoveRefs(f.root, "move-1", f.ports, () => true);
    expect(result.leftovers).toEqual([{ ref, reason: "move-ref-cleanup-pending", retryable: true }]);
    expect(git(f, "rev-parse", ref)).toBe(oid);
    expect(files.map(file => readFileSync(file))).toEqual(before);
  } finally { user.stdin.end("abort\n"); await exited; }
  expect((await cleanupMoveRefs(f.root, "move-1", f.ports, () => true)).leftovers).toEqual([]);
  expect(git(f, "rev-parse", "refs/heads/user-work")).toBe(oid);
}, 5000);

it("move ref cleanup uses the recorded oid and never deletes a replaced ref", async () => {
  const { cleanupMoveRefs } = await import("../workspace");
  const { openJournal } = await import("../journal");
  const f = fixture(), ref = "refs/spider-roam/move-1/final/working", oid = git(f, "rev-parse", "HEAD"), replacement = git(f, "rev-parse", "HEAD^");
  git(f, "update-ref", ref, oid);
  f.ports.journal = openJournal(join(f.base, "cleanup.db"));
  f.ports.journal.begin({ id: "move-1", kind: "move", machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: 1, args: {} });
  f.ports.journal.record("move-1", "workspace-snapshot-refs", { root: f.root, refs: [{ ref, oid }] });
  const run = f.ports.run;
  f.ports.run = async (cwd, argv, options) => {
    if (argv.includes("update-ref") && argv.includes("-d")) { expect(argv.slice(-2)).toEqual([ref, oid]); git(f, "update-ref", ref, replacement); }
    return run(cwd, argv, options);
  };
  expect((await cleanupMoveRefs(f.root, "move-1", f.ports, () => true)).leftovers).toEqual([{ ref, reason: "move-ref-cleanup-changed", retryable: true }]);
  expect(git(f, "rev-parse", ref)).toBe(replacement);
}, 5000);

it.each([true, false])("move cleanup never adopts a replaced or unowned ref as its own (creation proof %s)", async proved => {
  const { cleanupMoveRefs } = await import("../workspace"), { openJournal } = await import("../journal");
  const f = fixture(), ref = "refs/spider-roam/move-1/final/working", oid = git(f, "rev-parse", "HEAD"), replacement = git(f, "rev-parse", "HEAD^");
  f.ports.journal = openJournal(join(f.base, "cleanup.db"));
  f.ports.journal.begin({ id: "move-1", kind: "move", machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: 1, args: {} });
  git(f, "update-ref", ref, oid);
  if (proved) f.ports.journal.record("move-1", "workspace-snapshot-refs", { root: f.root, refs: [{ ref, oid }] });
  git(f, "update-ref", ref, replacement);
  expect((await cleanupMoveRefs(f.root, "move-1", f.ports, () => true)).leftovers).toEqual([{ ref, reason: proved ? "move-ref-cleanup-changed" : "move-ref-cleanup-unproved", retryable: true }]);
  expect(git(f, "rev-parse", ref)).toBe(replacement);
}, 5000);

it("snapshot creation records its exact ref object ids before cleanup", async () => {
  const { openJournal } = await import("../journal"), f = fixture(true), request = input(f);
  f.ports.journal = openJournal(join(f.base, "cleanup.db"));
  f.ports.journal.begin({ id: request.moveId, kind: "move", machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: 1, args: {} });
  const snapshot = await snapshotWorkspace(request, f.ports);
  expect(f.ports.journal.read(request.moveId).filter(row => row.action === "workspace-snapshot-refs")).toEqual([{ action: "workspace-snapshot-refs", result: { root: f.root, refs: snapshot.refs.map(ref => ({ ref, oid: git(f, "rev-parse", ref) })) } }]);
}, 5000);
