import { afterEach, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build } from "vite";
import { openDb } from "@spider/db-core";
import { scratchDbPath } from "@spider/db-core/testutil";
import type { Operation } from "../contracts";
import { openJournal } from "../journal";

const roots: string[] = [];
function fixture(): { root: string; file: string } {
  const parent = dirname(scratchDbPath("roam-journal"));
  const root = mkdtempSync(join(parent, "operation-journal-"));
  roots.push(root);
  return { root, file: join(root, "roam", "journal.db") };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const operation: Operation = {
  id: "operation-1",
  machineId: "00000000-0000-4000-8000-000000000001",
  expectedEpoch: 4,
  kind: "import",
  args: { artifact: "artifact-1", options: { beta: 2, alpha: 1 }, chunks: ["a", "b"] },
};

it("same operation returns its durable result", () => {
  const { file } = fixture();
  const first = openJournal(file);
  expect(first.begin(operation)).toEqual({ kind: "new", result: null });
  first.record(operation.id, "imported", { through: 7 });
  const result = { through: 7, digest: "abc" };
  first.record(operation.id, "done", result);
  const second = openJournal(file);
  expect(second.begin(operation)).toMatchObject({ kind: "done", result });
  expect(second.read(operation.id)).toEqual([
    { action: "imported", result: { through: 7 } },
    { action: "done", result: { through: 7, digest: "abc" } },
  ]);
}, 5000);

it("stores the operation identity and expected epoch without raw arguments", () => {
  const { file } = fixture();
  const journal = openJournal(file);
  journal.begin(operation);
  journal.begin({ ...operation, id: "without-epoch", expectedEpoch: null });
  const db = openDb(file);
  try {
    const row = db.prepare("SELECT * FROM roam_operations WHERE operation_id = ?").get(operation.id) as Record<string, unknown>;
    expect(row).toMatchObject({ operation_id: operation.id, machine_id: operation.machineId, expected_epoch: 4, kind: "import" });
    expect(row.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("artifact-1");
    expect(db.prepare("SELECT expected_epoch FROM roam_operations WHERE operation_id = ?").get("without-epoch")).toEqual({ expected_epoch: null });
  } finally { db.close(); }
}, 5000);

it("artifact reference checks retain exact pending work and recorded evidence", () => {
  const { file } = fixture();
  const journal = openJournal(file);
  expect(journal.hasArtifactReference("unrelated")).toBe(false);
  journal.begin(operation);
  expect(journal.hasArtifactReference("unrelated")).toBe(false);
  expect(journal.hasArtifactReference("artifact-1")).toBe(true);
  journal.record(operation.id, "staged", { file: "/fixture/private-snapshot.ndjson", artifactId: "artifact-1" });
  journal.record(operation.id, "done", { committed: true });
  expect(journal.hasArtifactReference("artifact-1")).toBe(true);
  expect(journal.hasArtifactReference("/fixture/private-snapshot.ndjson")).toBe(true);
  expect(journal.hasArtifactReference("unrelated")).toBe(false);
}, 5000);

it("failed read-only calls cannot retain unrelated artifacts", () => {
  const { file } = fixture(), journal = openJournal(file);
  for (const kind of ["stores", "inventory", "cursor"]) journal.begin({ ...operation, id: kind, kind, args: {} });
  expect(journal.hasArtifactReference("orphan")).toBe(false);
}, 5000);
it("artifact references match exact parsed identifiers rather than substrings", () => {
  const { file } = fixture(), journal = openJournal(file);
  journal.begin({ ...operation, id: "pull-artifact-extra", args: { artifactId: "artifact-extra" } });
  journal.record("pull-artifact-extra", "staged", { artifactId: "artifact-extra", file: "/fixture/artifact-extra.ndjson" });
  expect(journal.hasArtifactReference("artifact")).toBe(false);
  expect(journal.hasArtifactReference("artifact-extra")).toBe(true);
  expect(journal.hasArtifactReference("/fixture/artifact-extra.ndjson")).toBe(true);
}, 5000);
it("retention prunes released operations and actions but preserves pending recovery", () => {
  const { file } = fixture(), journal = openJournal(file);
  journal.begin(operation); journal.record(operation.id, "staged", { artifactId: "artifact-1" });
  journal.record(operation.id, "done", { artifactId: "artifact-1" });
  journal.begin({ ...operation, id: "pending", args: { artifactId: "pending-artifact" } });
  expect(journal.prune(Date.now() + 2000, 1000)).toEqual([]);
  journal.releaseArtifact("artifact-1");
  expect(journal.hasArtifactReference("artifact-1")).toBe(false);
  expect(journal.prune(Date.now() + 2000, 1000)).toEqual([operation.id]);
  expect(journal.read(operation.id)).toEqual([]);
  expect(journal.begin({ ...operation, id: "pending", args: { artifactId: "pending-artifact" } }).kind).toBe("pending");
}, 5000);
it("cancelling a superseded operation releases pending evidence but never replaces a committed result", () => {
  const { file } = fixture(), journal = openJournal(file);
  journal.begin(operation); journal.record(operation.id, "staged", { artifactId: "artifact-1" });
  journal.cancel(operation.id);
  expect(journal.begin(operation)).toMatchObject({ kind: "done", result: { cancelled: true } });
  expect(journal.hasArtifactReference("artifact-1")).toBe(false);
  const committed = { ...operation, id: "committed" };
  journal.begin(committed); journal.record(committed.id, "done", { through: 4 }); journal.cancel(committed.id);
  expect(journal.begin(committed)).toMatchObject({ kind: "done", result: { through: 4 } });
}, 5000);
it("journal pruning is bounded and respects retained sync references", () => {
  const { file } = fixture(), journal = openJournal(file);
  for (let i = 0; i < 260; i++) { const id = `read-${i}`; journal.begin({ ...operation, id, kind: "cursor", args: {} }); journal.record(id, "done", { value: { lastSeq: 0 } }); }
  const old = Date.now() + 2000;
  expect(journal.prune(old, 1000, id => id === "read-0")).toHaveLength(255);
  expect(journal.prune(old, 1000, id => id === "read-0")).toHaveLength(4);
  expect(journal.read("read-0")).toHaveLength(1);
}, 5000);
it("changed arguments under one ID refuse before effect", () => {
  const { file } = fixture();
  const journal = openJournal(file);
  journal.begin(operation);
  const changed: Operation = { ...operation, args: { ...operation.args, artifact: "artifact-2" } };
  expect(() => journal.begin(changed)).toThrow(/arguments/i);
  expect(journal.read(operation.id)).toEqual([]);
  expect(journal.begin(operation)).toEqual({ kind: "pending", result: null });
}, 5000);

it("canonical arguments ignore object key order but preserve array order and epoch", () => {
  const { file } = fixture();
  const journal = openJournal(file);
  journal.begin(operation);
  const reordered: Operation = {
    ...operation,
    args: { chunks: ["a", "b"], options: { alpha: 1, beta: 2 }, artifact: "artifact-1" },
  };
  expect(journal.begin(reordered)).toEqual({ kind: "pending", result: null });
  expect(() => journal.begin({ ...reordered, args: { ...reordered.args, chunks: ["b", "a"] } })).toThrow(/arguments/i);
  expect(() => journal.begin({ ...operation, expectedEpoch: 5 })).toThrow(/arguments/i);
  expect(() => journal.begin({ ...operation, kind: "export" })).toThrow(/arguments/i);
  expect(() => journal.begin({ ...operation, machineId: "00000000-0000-4000-8000-000000000002" })).toThrow(/arguments/i);
}, 5000);

it("restart preserves pending actions", () => {
  const { file } = fixture();
  const first = openJournal(file);
  first.begin(operation);
  first.record(operation.id, "received", { chunk: 0 });
  first.record(operation.id, "received", { chunk: 1 });
  const restarted = openJournal(file);
  expect(restarted.begin(operation)).toEqual({ kind: "pending", result: null });
  expect(restarted.read(operation.id)).toEqual([
    { action: "received", result: { chunk: 0 } },
    { action: "received", result: { chunk: 1 } },
  ]);
  restarted.record(operation.id, "done", { installed: true });
  expect(openJournal(file).begin(operation)).toEqual({ kind: "done", result: { installed: true } });
}, 5000);

async function compileJournal(root: string): Promise<void> {
  await build({
    configFile: false, logLevel: "silent", ssr: { target: "node", noExternal: true },
    build: {
      ssr: resolve("packages/roam/src/journal.ts"), target: "node22", outDir: join(root, "bundle"),
      rollupOptions: {
        external: id => id.startsWith("node:") || id === "better-sqlite3" || id === "sqlite-vec",
        output: { format: "es", entryFileNames: "journal.mjs", codeSplitting: false },
      },
    },
  });
}

it("a fresh process recovers pending actions after the writer exits", async () => {
  const { root, file } = fixture();
  await compileJournal(root);
  const runner = join(root, "runner.mjs");
  writeFileSync(runner, `import { openJournal } from './bundle/journal.mjs';
const op = ${JSON.stringify(operation)};
const journal = openJournal(process.argv[2]);
if (process.argv[3] === 'write') { journal.begin(op); journal.record(op.id, 'received', {chunk: 7}); process.exit(0); }
console.log(JSON.stringify({state: journal.begin(op), actions: journal.read(op.id)}));\n`);
  const run = (action: string) => spawnSync(process.execPath, [runner, file, action], { encoding: "utf8", timeout: 2000 });
  expect(run("write").status).toBe(0);
  const recovered = run("read");
  expect(recovered.status).toBe(0);
  expect(JSON.parse(recovered.stdout)).toEqual({
    state: { kind: "pending", result: null }, actions: [{ action: "received", result: { chunk: 7 } }],
  });
  openJournal(file).record(operation.id, "done", { installed: true });
  expect(JSON.parse(run("read").stdout).state).toEqual({ kind: "done", result: { installed: true } });
}, 5000);

it("concurrent processes reserve the operation ID once", async () => {
  const { root, file } = fixture();
  await compileJournal(root);
  const runner = join(root, "race.mjs");
  writeFileSync(runner, `import { openJournal } from './bundle/journal.mjs';
await new Promise(resolve => process.stdin.once('data', resolve));
console.log(JSON.stringify(openJournal(process.argv[2]).begin(${JSON.stringify(operation)})));\n`);
  function start(): { send(): void; result: Promise<{ code: number | null; stdout: string; stderr: string }> } {
    const child = spawn(process.execPath, [runner, file], { stdio: ["pipe", "pipe", "pipe"], timeout: 3000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      child.once("error", reject);
      child.once("close", code => resolveResult({ code, stdout, stderr }));
    });
    return { send: () => child.stdin.end("go"), result };
  }
  const first = start(), second = start();
  first.send(); second.send();
  const results = await Promise.all([first.result, second.result]);
  expect(results.map(result => result.code), results.map(result => result.stderr).join("\n")).toEqual([0, 0]);
  expect(results.map(result => JSON.parse(result.stdout).kind).sort()).toEqual(["new", "pending"]);
  expect(openJournal(file).read(operation.id)).toEqual([]);
}, 5000);

it("terminal results cannot be replaced by a later retry", () => {
  const { file } = fixture();
  const journal = openJournal(file);
  journal.begin(operation);
  journal.record(operation.id, "done", { result: "committed" });
  journal.record(operation.id, "done", { result: "committed" });
  expect(() => journal.record(operation.id, "done", { result: "different" })).toThrow();
  expect(() => journal.record(operation.id, "more-work", {})).toThrow();
  expect(journal.read(operation.id)).toEqual([{ action: "done", result: { result: "committed" } }]);
  expect(openJournal(file).begin(operation)).toEqual({ kind: "done", result: { result: "committed" } });
}, 5000);

it("rejects malformed operation data and records without a preceding begin", () => {
  const { file } = fixture();
  const journal = openJournal(file);
  expect(() => journal.record("missing", "done", {})).toThrow();
  expect(() => journal.begin({ ...operation, args: { count: Number.NaN } })).toThrow();
  expect(() => journal.begin({ ...operation, args: { count: Number.MAX_SAFE_INTEGER + 1 } })).toThrow();
  expect(() => journal.begin({ ...operation, args: { value: undefined } } as unknown as Operation)).toThrow();
  expect(() => journal.begin({ ...operation, machineId: "box-1.invalid" })).toThrow();
  expect(() => journal.begin({ ...operation, expectedEpoch: 0 })).toThrow();
  expect(journal.begin(operation)).toEqual({ kind: "new", result: null });
}, 5000);

it("uses private files and leaves the separate freeze journal untouched", () => {
  const { file } = fixture();
  const journal = openJournal(file);
  journal.begin(operation);
  const db = openDb(file);
  try {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'freeze_journal'").get()).toBeUndefined();
    db.exec("CREATE TABLE freeze_journal(session_id TEXT, state TEXT); INSERT INTO freeze_journal VALUES ('session-1', 'freezing')");
    journal.record(operation.id, "done", { ok: true });
    expect(db.prepare("SELECT session_id, state FROM freeze_journal").all()).toEqual([{ session_id: "session-1", state: "freezing" }]);
  } finally { db.close(); }
  if (process.platform !== "win32") {
    expect(lstatSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  }
}, 5000);

it("repairs an owned existing journal directory and file to private modes", () => {
  const { file } = fixture();
  mkdirSync(dirname(file), { mode: 0o755 });
  const db = openDb(file); db.close();
  if (process.platform !== "win32") {
    chmodSync(dirname(file), 0o755);
    chmodSync(file, 0o644);
  }
  openJournal(file).begin(operation);
  if (process.platform !== "win32") {
    expect(lstatSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  }
}, 5000);

it.skipIf(process.platform === "win32" || typeof process.getuid !== "function")("refuses a foreign-owned destination directory without changing it", () => {
  const { file } = fixture();
  mkdirSync(dirname(file), { mode: 0o755 });
  chmodSync(dirname(file), 0o755);
  const uid = process.getuid!();
  const identity = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
  try { expect(() => openJournal(file)).toThrow(/unsafe/i); }
  finally { identity.mockRestore(); }
  expect(lstatSync(dirname(file)).mode & 0o777).toBe(0o755);
  expect(existsSync(file)).toBe(false);
}, 5000);

it.skipIf(process.platform === "win32" || typeof process.getuid !== "function")("refuses a foreign-owned journal file without changing it", () => {
  const { file } = fixture();
  mkdirSync(dirname(file), { mode: 0o700 });
  writeFileSync(file, "", { mode: 0o644 });
  chmodSync(file, 0o644);
  const uid = process.getuid!();
  let checks = 0;
  const identity = vi.spyOn(process, "getuid").mockImplementation(() => ++checks === 2 ? uid + 1 : uid);
  try { expect(() => openJournal(file)).toThrow(/unsafe/i); }
  finally { identity.mockRestore(); }
  expect(lstatSync(file).mode & 0o777).toBe(0o644);
}, 5000);

it.each(["-wal", "-shm"])("refuses a symlink SQLite %s sidecar without touching its target", suffix => {
  const { root, file } = fixture();
  mkdirSync(dirname(file), { mode: 0o700 });
  const target = join(root, "sidecar-target");
  writeFileSync(target, "unchanged");
  symlinkSync(target, file + suffix);
  expect(() => openJournal(file)).toThrow(/symlink|unsafe/i);
  expect(readFileSync(target, "utf8")).toBe("unchanged");
}, 5000);

it("refuses symlink journal files and directories", () => {
  const { root, file } = fixture();
  const outside = join(root, "other.db");
  const target = openDb(outside);
  target.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('unchanged')");
  target.close();
  mkdirSync(dirname(file), { mode: 0o700 });
  symlinkSync(outside, file);
  expect(() => openJournal(file)).toThrow(/symlink|unsafe/i);
  const check = openDb(outside);
  try {
    expect(check.prepare("SELECT value FROM sentinel").get()).toEqual({ value: "unchanged" });
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'roam_operations'").get()).toBeUndefined();
  } finally { check.close(); }
  rmSync(file);
  rmSync(dirname(file), { recursive: true });
  const otherDir = join(root, "other-dir");
  mkdirSync(otherDir, { mode: 0o700 });
  chmodSync(otherDir, 0o700);
  symlinkSync(otherDir, dirname(file));
  expect(() => openJournal(file)).toThrow(/symlink|unsafe/i);
}, 5000);
