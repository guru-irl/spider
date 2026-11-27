import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, type WorkspaceImportPorts } from "../contracts";
import { openJournal } from "../journal";
import { snapshotWorkspace } from "../workspace";
import { prepareWorkspace } from "../workspace-import";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it.each([{ version: "2.54.0.vfs.0.4", ignoreCase: false }, { version: "2.56.1", ignoreCase: true }])("broad cone inspection with Git $version needs no check-rules or scratch blobs", async ({ version, ignoreCase }) => {
  let phase = "fixture";
  let phaseStarted = performance.now();
  const phases: Record<string, number> = {};
  const commands: Record<string, { count: number; total: number; max: number }> = {};
  let scanMs = 0;
  const next = (name: string) => {
    const now = performance.now();
    phases[phase] = Math.round(now - phaseStarted);
    phase = name; phaseStarted = now;
  };
  const root = mkdtempSync(join(dirname(scratchDbPath("sparse-inspection")), "si-")); roots.push(root);
  const source = join(root, "source"), destination = join(root, "destination"), scratch = join(root, "scratch");
  mkdirSync(source); mkdirSync(join(source, "keep")); mkdirSync(join(source, "skip"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const run = (cwd: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }) => {
    const start = performance.now();
    let command = 1;
    while (["-c", "--work-tree", "--git-dir"].includes(argv[command])) command += 2;
    const verb = argv[command];
    const key = `${phase}:${verb}${["config", "ls-files", "rev-parse", "ls-tree", "sparse-checkout"].includes(verb) ? ` ${argv.slice(command + 1, command + 3).join(" ")}` : ""}`;
    const stat = commands[key] ??= { count: 0, total: 0, max: 0 };
    try { return execFileSync(argv[0], argv.slice(1), { cwd, env: { ...env, ...options?.env }, input: options?.stdin, stdio: ["pipe", "pipe", "pipe"] }); }
    finally {
      const elapsed = performance.now() - start;
      stat.count++; stat.total += elapsed; stat.max = Math.max(stat.max, elapsed);
    }
  };
  const git = (cwd: string, ...args: string[]) => run(cwd, ["git", ...args]).toString().trim();
  git(source, "init", "-q", "--initial-branch=main");
  for (let i = 0; i < 512; i++) writeFileSync(join(source, "keep", `${i}.txt`), "fixture blob\n".repeat(128));
  writeFileSync(join(source, "skip", "hidden.txt"), "not included\n"); writeFileSync(join(source, "root.txt"), "root file\n");
  mkdirSync(join(source, "parent", "a[1]", "leaf"), { recursive: true }); mkdirSync(join(source, "parent", "sibling"));
  writeFileSync(join(source, "parent", "parent.txt"), "ancestor file\n");
  writeFileSync(join(source, "parent", "a[1]", "leaf", "selected.txt"), "nested file\n");
  writeFileSync(join(source, "parent", "sibling", "hidden.txt"), "excluded sibling\n");
  git(source, "add", "."); git(source, "commit", "-q", "-m", "fixture"); git(root, "clone", "-q", source, destination);
  git(source, "config", "core.ignoreCase", String(ignoreCase)); git(destination, "config", "core.ignoreCase", String(ignoreCase));
  const journal = openJournal(join(root, "journal.db"));
  for (const id of ["before", "incoming"]) journal.begin({ id, kind: "workspace-snapshot", machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: null, args: {} });
  const base = { run: async (cwd: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }) => run(cwd, argv[0] === "git" ? argv : ["git", ...argv], options), journal, scratch, limits: DEFAULT_LIMITS, worktreeCommand: null };
  try {
  next("snapshot-before");
  const previous = await snapshotWorkspace({ root: destination, cwd: destination, repoKey: "fixture-repo", workspaceId: "fixture-workspace", moveId: "before", stage: "final", writers: [] }, base);
  next("set-sparse");
  git(source, "sparse-checkout", "init", "--cone"); git(source, "sparse-checkout", "set", "--skip-checks", ignoreCase ? "KEEP" : "keep", "parent/a[1]/leaf");
  next("snapshot-sparse");
  const incoming = await snapshotWorkspace({ root: source, cwd: source, repoKey: "fixture-repo", workspaceId: "fixture-workspace", moveId: "incoming", stage: "pre", writers: [] }, base);
  next("bundle-sparse");
  const artifact = join(root, "incoming.bundle"); git(source, "bundle", "create", artifact, ...incoming.refs, `^${incoming.head}`); chmodSync(artifact, 0o600);
  let copiedBlobs = 0;
  const ports: WorkspaceImportPorts = { ...base, async run(cwd, argv, options) {
    if (argv.includes("--version")) return Buffer.from(`git version ${version}\n`);
    if (argv.includes("check-rules")) throw new Error("unsupported git command");
    const result = run(cwd, argv, options);
    const scanStart = performance.now();
    copiedBlobs = Math.max(copiedBlobs, readdirSync(scratch, { recursive: true, withFileTypes: true }).filter(file => file.isFile() && file.name.endsWith(".txt")).length);
    scanMs += performance.now() - scanStart;
    return result;
  }, resolveCommonRepository: async () => destination, lastExportedSnapshot: async () => previous, verifiedArtifactPath: async () => artifact };
  next("prepare-sparse");
  const prepared = await prepareWorkspace({ ...incoming, prerequisites: [incoming.head], bundle: { kind: "ready", artifactId: "incoming-bundle", byteLength: statSync(artifact).size } }, destination, ports);
  next("assert-sparse");
  expect(copiedBlobs).toBe(0);
  expect(readdirSync(join(destination, "keep"))).toHaveLength(512);
  expect(git(destination, "ls-files", "-t", "keep/0.txt")).toBe("H keep/0.txt");
  expect(git(destination, "ls-files", "-t", "skip/hidden.txt")).toBe("S skip/hidden.txt");
  expect(existsSync(join(destination, "root.txt"))).toBe(true);
  expect(existsSync(join(destination, "parent", "parent.txt"))).toBe(true);
  expect(existsSync(join(destination, "parent", "a[1]", "leaf", "selected.txt"))).toBe(true);
  expect(git(destination, "ls-files", "-t", "parent/sibling/hidden.txt")).toBe("S parent/sibling/hidden.txt");
  next("disable-sparse");
  git(source, "sparse-checkout", "disable");
  next("snapshot-full");
  const full = await snapshotWorkspace({ root: source, cwd: source, repoKey: "fixture-repo", workspaceId: "fixture-workspace", moveId: "incoming", stage: "final", writers: [] }, base);
  next("bundle-full");
  const fullArtifact = join(root, "full.bundle"); git(source, "bundle", "create", fullArtifact, ...full.refs, `^${full.head}`); chmodSync(fullArtifact, 0o600);
  ports.lastExportedSnapshot = async () => prepared.snapshot; ports.verifiedArtifactPath = async () => fullArtifact;
  next("prepare-full");
  await prepareWorkspace({ ...full, prerequisites: [full.head], bundle: { kind: "ready", artifactId: "full-bundle", byteLength: statSync(fullArtifact).size } }, destination, ports);
  next("assert-full");
  expect(git(destination, "ls-files", "-t", "skip/hidden.txt")).toBe("H skip/hidden.txt");
  expect(copiedBlobs).toBe(0);
  } finally {
    next("finished");
    console.log("SPARSE_HUNT " + JSON.stringify({ version, phases, commands, scanMs }));
  }
}, 5000);
