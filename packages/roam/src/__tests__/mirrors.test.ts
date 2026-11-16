import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS } from "../contracts";
import { openJournal } from "../journal";
import { inspectSession } from "../session-file";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import { appendMirror, exportMirrorRange, recoverMirror } from "../mirrors";

const fault = vi.hoisted(() => ({ target: null as string | null, observeTarget: null as string | null, modes: [] as number[], wrote: false, failOpen: false, failRollback: false, failRecoverySync: false, descriptors: new Map<number, string>() }));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    openSync: (...args: unknown[]) => {
      if (fault.failOpen && args[0] === fault.target && typeof args[1] === "number" && (args[1] & real.constants.O_WRONLY) !== 0) {
        throw Object.assign(new Error("fixture open failed"), { code: "EACCES" });
      }
      const fd = (real.openSync as (...values: unknown[]) => number)(...args);
      if (typeof args[0] === "string") fault.descriptors.set(fd, args[0]);
      return fd;
    },
    closeSync: (fd: number) => { fault.descriptors.delete(fd); real.closeSync(fd); },
    ftruncateSync: (fd: number, length?: number) => {
      if (fault.failRollback && fault.descriptors.get(fd) === fault.target) throw Object.assign(new Error("fixture rollback failed"), { code: "EIO" });
      real.ftruncateSync(fd, length);
    },
    fsyncSync: (fd: number) => {
      if (fault.failRecoverySync && fault.descriptors.get(fd) === fault.target) throw Object.assign(new Error("fixture recovery sync failed"), { code: "EIO" });
      real.fsyncSync(fd);
    },
    writeSync: (...args: unknown[]) => {
      const fd = args[0] as number;
      if (fault.observeTarget && fault.descriptors.get(fd) === fault.observeTarget) fault.modes.push(real.fstatSync(fd).mode & 0o222);
      if (fault.target && fault.descriptors.get(fd) === fault.target) {
        if (!fault.wrote && Buffer.isBuffer(args[1]) && typeof args[2] === "number") {
          fault.wrote = true;
          return real.writeSync(fd, args[1], args[2], 1, typeof args[4] === "number" ? args[4] : null);
        }
        throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
      }
      return (real.writeSync as (...values: unknown[]) => number)(...args);
    },
  };
});

const roots: string[] = [];
const stamp = "2026-01-02T03:04:05.000Z";
const sessionId = "mirror-session-1";
const machineA = "00000000-0000-4000-8000-000000000001";
const machineB = "00000000-0000-4000-8000-000000000002";
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const entry = (id: string, parentId: string | null, content = id) => ({
  type: "message", id, parentId, timestamp: stamp, message: { role: "user", content, timestamp: 1 },
});
function fixture() {
  const root = mkdtempSync(join(dirname(scratchDbPath("session-mirror")), "session-mirror-")); roots.push(root);
  const cwd = join(root, "workspace"); mkdirSync(cwd);
  const file = join(root, "source.jsonl");
  const header = { type: "session", version: 3, id: sessionId, timestamp: stamp, cwd };
  const marker = { type: "custom", id: "epoch-2", parentId: "first", timestamp: stamp, customType: "spider-roam-segment",
    data: { version: 1, moveId: "move-2", epoch: 2, previousMachine: machineA, nextMachine: machineB, historyMachine: machineA, parentRef: null } };
  const first = line(header) + line(entry("root", null)) + line(entry("first", "root")) + line(marker);
  writeFileSync(file, first, { mode: 0o600 });
  const journal = openJournal(join(root, "journal.db"));
  const operationId = "mirror-sync-1";
  journal.begin({ id: operationId, machineId: machineB, expectedEpoch: 2, kind: "sync", args: {} });
  return { root, file, first, header, journal, operationId, mirrorRoot: join(root, "mirrors") };
}
afterEach(() => {
  fault.target = null; fault.observeTarget = null; fault.modes = []; fault.wrote = false; fault.failOpen = false; fault.failRollback = false; fault.failRecoverySync = false; fault.descriptors.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("mirror export accepts later appends without extending the observed transfer range", async () => {
  const f = fixture(), prefix = await inspectSession(f.file, sessionId);
  const tail = line(entry("next", "epoch-2", "observed tail")); appendFileSync(f.file, tail);
  const observed = await inspectSession(f.file, sessionId);
  appendFileSync(f.file, line(entry("later", "next", "still running")));
  const result = exportMirrorRange(observed, { size: prefix.size, sha256: prefix.sha256 }, join(f.root, "exports"));
  expect(result).toMatchObject({ mode: "append", offset: prefix.size });
  expect(readFileSync(result.file!, "utf8")).toBe(tail);
  writeFileSync(f.file, f.first.replace("first", "FIRST") + tail);
  expect(() => exportMirrorRange(observed, null, join(f.root, "exports"))).toThrow();
});

it("mirrors append complete verified lines per epoch", async () => {
  const f = fixture();
  let source = await inspectSession(f.file, sessionId);
  const first = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  expect(readFileSync(first.file, "utf8")).toBe(f.first);
  if (process.platform !== "win32") expect(lstatSync(first.file).mode & 0o222).toBe(0);
  const added = line(entry("next", "epoch-2", "new text"));
  appendFileSync(f.file, added);
  source = await inspectSession(f.file, sessionId);
  const next = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  expect(next.file).toBe(first.file);
  expect(readFileSync(next.file, "utf8")).toBe(f.first + added);
  expect(next.sha256).toBe(source.sha256);
  const nextMarker = line({ type: "custom", id: "epoch-3", parentId: "next", timestamp: stamp, customType: "spider-roam-segment",
    data: { version: 1, moveId: "move-3", epoch: 3, previousMachine: machineB, nextMachine: machineA, historyMachine: machineA, parentRef: null } });
  appendFileSync(f.file, nextMarker);
  const epochThreeSource = await inspectSession(f.file, sessionId);
  f.journal.begin({ id: "mirror-sync-2", machineId: machineA, expectedEpoch: 3, kind: "sync", args: {} });
  const another = await appendMirror({ sessionId, epoch: 3, source: epochThreeSource, root: f.mirrorRoot, operationId: "mirror-sync-2" }, f.journal);
  expect(another.file).not.toBe(first.file);
  expect(readFileSync(another.file, "utf8")).toBe(f.first + added + nextMarker);
  expect(readFileSync(first.file, "utf8")).toBe(f.first + added);
  const actions = f.journal.read(f.operationId);
  expect(actions.some(action => action.action === "mirror-append-intent" && action.result.machineId === machineB)).toBe(true);
  expect(actions.some(action => action.action === "mirror-append-complete" && action.result.machineId === machineB)).toBe(true);
  expect(actions.some(action => action.action === "done")).toBe(false);
  f.journal.record(f.operationId, "still-pending", {});
}, 5000);

it("changed or truncated source and partial tails leave the mirror untouched", async () => {
  const f = fixture();
  const source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  const before = readFileSync(mirror.file);
  writeFileSync(f.file, line(f.header) + line(entry("root", null)));
  const truncated = await inspectSession(f.file, sessionId);
  await expect(appendMirror({ sessionId, epoch: 2, source: truncated, root: f.mirrorRoot, operationId: f.operationId }, f.journal)).rejects.toThrow();
  expect(readFileSync(mirror.file)).toEqual(before);
  writeFileSync(f.file, f.first.replace('"content":"first"', '"content":"FIRST"'));
  const changed = await inspectSession(f.file, sessionId);
  await expect(appendMirror({ sessionId, epoch: 2, source: changed, root: f.mirrorRoot, operationId: f.operationId }, f.journal)).rejects.toThrow();
  expect(readFileSync(mirror.file)).toEqual(before);
  appendFileSync(f.file, line(entry("next", "epoch-2")));
  const changedAndExtended = await inspectSession(f.file, sessionId);
  await expect(appendMirror({ sessionId, epoch: 2, source: changedAndExtended, root: f.mirrorRoot, operationId: f.operationId }, f.journal)).rejects.toThrow();
  expect(readFileSync(mirror.file)).toEqual(before);
  writeFileSync(f.file, f.first);
  appendFileSync(f.file, '{"type":"message"');
  await expect(appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal)).rejects.toThrow();
  expect(readFileSync(mirror.file)).toEqual(before);
}, 5000);

it("a previously acknowledged mirror cannot be truncated", async () => {
  const f = fixture();
  const source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  chmodSync(mirror.file, 0o600);
  const shortened = line(f.header) + line(entry("root", null));
  writeFileSync(mirror.file, shortened);
  chmodSync(mirror.file, 0o400);
  const before = readFileSync(mirror.file);
  await expect(appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal)).rejects.toThrow();
  expect(readFileSync(mirror.file)).toEqual(before);
}, 5000);

it("keeps the mirror read-only while appending verified bytes", async () => {
  const f = fixture();
  let source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  appendFileSync(f.file, line(entry("next", "epoch-2")));
  source = await inspectSession(f.file, sessionId);
  fault.observeTarget = mirror.file;
  await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  expect(fault.modes.length).toBeGreaterThan(0);
  if (process.platform !== "win32") expect(fault.modes.every(mode => mode === 0)).toBe(true);
  expect(readFileSync(mirror.file)).toEqual(readFileSync(f.file));
}, 5000);

it("restores read-only mode on an unchanged mirror", async () => {
  const f = fixture();
  const source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  chmodSync(mirror.file, 0o600);
  await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  if (process.platform !== "win32") expect(lstatSync(mirror.file).mode & 0o222).toBe(0);
  expect(readFileSync(mirror.file)).toEqual(readFileSync(f.file));
}, 5000);

it("retries a mirror with a long valid session ID", async () => {
  const f = fixture();
  const id = "s".repeat(9000);
  writeFileSync(f.file, line({ ...f.header, id }) + f.first.slice(line(f.header).length));
  const source = await inspectSession(f.file, id);
  const input = { sessionId: id, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId };
  const first = await appendMirror(input, f.journal);
  const second = await appendMirror(input, f.journal);
  expect(second.file).toBe(first.file);
  expect(readFileSync(second.file)).toEqual(readFileSync(f.file));
}, 5000);

it("a different operation machine cannot extend the same epoch", async () => {
  const f = fixture();
  const source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  const before = readFileSync(mirror.file);
  f.journal.begin({ id: "other-sync", machineId: machineA, expectedEpoch: 2, kind: "sync", args: {} });
  await expect(appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: "other-sync" }, f.journal))
    .rejects.toMatchObject({ code: "mirror-machine-changed" });
  expect(readFileSync(mirror.file)).toEqual(before);
}, 5000);

it("disk-full append preserves the prior mirror and the same operation can retry", async () => {
  const f = fixture();
  let source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  const before = readFileSync(mirror.file);
  appendFileSync(f.file, line(entry("next", "epoch-2", "new text")));
  source = await inspectSession(f.file, sessionId);
  fault.target = mirror.file;
  await expect(appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal)).rejects.toThrow();
  fault.target = null;
  expect(readFileSync(mirror.file)).toEqual(before);
  if (process.platform !== "win32") expect(lstatSync(mirror.file).mode & 0o222).toBe(0);
  await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  expect(readFileSync(mirror.file)).toEqual(readFileSync(f.file));
}, 5000);

it("reconciles an unacknowledged partial tail after interruption", async () => {
  const f = fixture();
  let source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  const before = readFileSync(mirror.file);
  appendFileSync(f.file, line(entry("next", "epoch-2")));
  source = await inspectSession(f.file, sessionId);
  fault.target = mirror.file; fault.failRollback = true;
  await expect(appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal)).rejects.toThrow();
  fault.target = null; fault.failRollback = false;
  const interrupted = readFileSync(mirror.file);
  expect(interrupted.subarray(0, before.length)).toEqual(before);
  expect(interrupted.length).toBeGreaterThan(before.length);
  await expect(inspectSession(mirror.file, sessionId)).rejects.toThrow();
  await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  expect(readFileSync(mirror.file)).toEqual(readFileSync(f.file));
}, 5000);

it("an append open failure leaves the existing mirror read-only and retryable", async () => {
  const f = fixture();
  let source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  const before = readFileSync(mirror.file);
  appendFileSync(f.file, line(entry("next", "epoch-2")));
  source = await inspectSession(f.file, sessionId);
  fault.target = mirror.file; fault.failOpen = true;
  await expect(appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal)).rejects.toThrow();
  fault.target = null; fault.failOpen = false;
  expect(readFileSync(mirror.file)).toEqual(before);
  if (process.platform !== "win32") expect(lstatSync(mirror.file).mode & 0o222).toBe(0);
  await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  expect(readFileSync(mirror.file)).toEqual(readFileSync(f.file));
}, 5000);

it("a symlink at the mirror cannot replace or mutate its target", async () => {
  const f = fixture();
  const source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  const before = readFileSync(f.file);
  rmSync(mirror.file);
  symlinkSync(f.file, mirror.file);
  await expect(appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal)).rejects.toThrow();
  expect(lstatSync(mirror.file).isSymbolicLink()).toBe(true);
  expect(readFileSync(f.file)).toEqual(before);
}, 5000);

it("offline recovery truncates an interrupted tail to the committed prefix", async () => {
  const f = fixture();
  let source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  const committed = readFileSync(mirror.file), inode = lstatSync(mirror.file).ino;
  appendFileSync(f.file, line(entry("next", "epoch-2")));
  source = await inspectSession(f.file, sessionId);
  fault.target = mirror.file; fault.failRollback = true;
  await expect(appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal)).rejects.toThrow();
  fault.target = null; fault.failRollback = false;
  expect(readFileSync(mirror.file).length).toBeGreaterThan(committed.length);
  rmSync(f.file);
  const recovered = await recoverMirror({ sessionId, epoch: 2, machineId: machineB, root: f.mirrorRoot });
  expect(readFileSync(recovered.file)).toEqual(committed);
  expect(lstatSync(recovered.file).ino).toBe(inode);
  expect(recovered.size).toBe(committed.length);
  expect(recovered.sha256).toBe(mirror.sha256);
  expect(recovered.leaf).toBe("epoch-2");
  if (process.platform !== "win32") expect(lstatSync(recovered.file).mode & 0o222).toBe(0);
}, 5000);

it("recovery retries after interruption before and after truncation and permits a new extension", async () => {
  const f = fixture();
  let source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  const committed = readFileSync(mirror.file);
  appendFileSync(f.file, line(entry("old-next", "epoch-2")));
  source = await inspectSession(f.file, sessionId);
  fault.target = mirror.file; fault.failRollback = true;
  await expect(appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal)).rejects.toThrow();
  fault.target = null; fault.failRollback = false;
  const interrupted = readFileSync(mirror.file);
  expect(interrupted.length).toBeGreaterThan(committed.length);
  rmSync(f.file);
  const input = { sessionId, epoch: 2, machineId: machineB, root: f.mirrorRoot };
  fault.target = mirror.file; fault.failRollback = true;
  await expect(recoverMirror(input)).rejects.toThrow(/rollback failed/i);
  expect(readFileSync(mirror.file)).toEqual(interrupted);
  fault.failRollback = false; fault.failRecoverySync = true;
  await expect(recoverMirror(input)).rejects.toThrow(/recovery sync failed/i);
  expect(readFileSync(mirror.file)).toEqual(committed);
  fault.target = null; fault.failRecoverySync = false;
  const recovered = await recoverMirror(input);
  expect(readFileSync(recovered.file)).toEqual(committed);
  writeFileSync(f.file, f.first + line(entry("new-next", "epoch-2")), { mode: 0o600 });
  source = await inspectSession(f.file, sessionId);
  await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  expect(readFileSync(mirror.file)).toEqual(readFileSync(f.file));
}, 5000);

it("offline recovery of a clean mirror is a no-op and repeated recovery is stable", async () => {
  const f = fixture(), source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  const before = lstatSync(mirror.file), bytes = readFileSync(mirror.file);
  rmSync(f.file);
  const input = { sessionId, epoch: 2, machineId: machineB, root: f.mirrorRoot };
  const first = await recoverMirror(input);
  const second = await recoverMirror(input);
  const after = lstatSync(mirror.file);
  expect(readFileSync(mirror.file)).toEqual(bytes);
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(first).toEqual(second);
  expect(first.sha256).toBe(mirror.sha256);
}, 5000);

it("offline recovery preserves the last acknowledged live leaf, including a leaf-only sync", async () => {
  const f = fixture();
  let source = await inspectSession(f.file, sessionId, "first");
  const input = { sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId };
  await appendMirror(input, f.journal);
  expect((await recoverMirror({ sessionId, epoch: 2, machineId: machineB, root: f.mirrorRoot })).leaf).toBe("first");
  source = await inspectSession(f.file, sessionId, "root");
  await appendMirror({ ...input, source }, f.journal);
  rmSync(f.file);
  const recovered = await recoverMirror({ sessionId, epoch: 2, machineId: machineB, root: f.mirrorRoot });
  expect(recovered.leaf).toBe("root");
  expect(readFileSync(recovered.file, "utf8")).toBe(f.first);
}, 5000);

it("mirror operations honor configured session limits before writing", async () => {
  const f = fixture(), source = await inspectSession(f.file, sessionId);
  const limits = { ...DEFAULT_LIMITS, sessionBytes: source.size - 1 };
  await expect(appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId, limits }, f.journal))
    .rejects.toThrow(/oversized|size/i);
  expect(existsSync(f.mirrorRoot)).toBe(false);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  chmodSync(mirror.file, 0o600); appendFileSync(mirror.file, "partial"); chmodSync(mirror.file, 0o400);
  const before = readFileSync(mirror.file);
  await expect(recoverMirror({ sessionId, epoch: 2, machineId: machineB, root: f.mirrorRoot, limits }))
    .rejects.toThrow(/oversized|size/i);
  expect(readFileSync(mirror.file)).toEqual(before);
}, 5000);

it("offline recovery refuses a corrupted committed prefix without changing the file", async () => {
  const f = fixture(), source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  const changed = Buffer.from(readFileSync(mirror.file));
  const offset = changed.indexOf(Buffer.from('"content":"first"'));
  expect(offset).toBeGreaterThan(0);
  changed[offset + '"content":"'.length] = "F".charCodeAt(0);
  chmodSync(mirror.file, 0o600); writeFileSync(mirror.file, changed); appendFileSync(mirror.file, "partial"); chmodSync(mirror.file, 0o400);
  const before = readFileSync(mirror.file);
  await expect(recoverMirror({ sessionId, epoch: 2, machineId: machineB, root: f.mirrorRoot }))
    .rejects.toMatchObject({ code: "mirror-checkpoint-mismatch" });
  expect(readFileSync(mirror.file)).toEqual(before);
}, 5000);

it("offline recovery refuses a missing or shortened committed mirror", async () => {
  const f = fixture(), source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  chmodSync(mirror.file, 0o600); writeFileSync(mirror.file, f.first.slice(0, -3)); chmodSync(mirror.file, 0o400);
  const before = readFileSync(mirror.file);
  await expect(recoverMirror({ sessionId, epoch: 2, machineId: machineB, root: f.mirrorRoot }))
    .rejects.toMatchObject({ code: "mirror-checkpoint-mismatch" });
  expect(readFileSync(mirror.file)).toEqual(before);
  rmSync(mirror.file);
  await expect(recoverMirror({ sessionId, epoch: 2, machineId: machineB, root: f.mirrorRoot }))
    .rejects.toMatchObject({ code: "mirror-checkpoint-mismatch" });
  expect(existsSync(mirror.file)).toBe(false);
}, 5000);

it("offline recovery refuses a missing checkpoint and a symlink without changing evidence", async () => {
  const f = fixture(), source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  const checkpoint = join(dirname(mirror.file), "2.state.json"), before = readFileSync(mirror.file);
  const state = readFileSync(checkpoint);
  rmSync(checkpoint);
  await expect(recoverMirror({ sessionId, epoch: 2, machineId: machineB, root: f.mirrorRoot }))
    .rejects.toMatchObject({ code: "mirror-checkpoint-missing" });
  expect(readFileSync(mirror.file)).toEqual(before);
  writeFileSync(checkpoint, state, { mode: 0o600 });
  rmSync(mirror.file); symlinkSync(f.file, mirror.file);
  await expect(recoverMirror({ sessionId, epoch: 2, machineId: machineB, root: f.mirrorRoot }))
    .rejects.toMatchObject({ code: "mirror-unsafe-path" });
  expect(readFileSync(f.file)).toEqual(before);
  expect(lstatSync(mirror.file).isSymbolicLink()).toBe(true);
}, 5000);

it("offline recovery cannot promote an uncommitted initial snapshot", async () => {
  const f = fixture();
  const dir = join(f.mirrorRoot, createHash("sha256").update(sessionId).digest("hex"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "2.jsonl"), checkpoint = join(dir, "2.state.json");
  writeFileSync(file, f.first, { mode: 0o400 });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  writeFileSync(checkpoint, JSON.stringify({ version: 1, sessionId, epoch: 2, machineId: machineB,
    committed: { size: 0, sha256: hash("") }, pending: { size: Buffer.byteLength(f.first), sha256: hash(f.first), leaf: "epoch-2" } }), { mode: 0o600 });
  await expect(recoverMirror({ sessionId, epoch: 2, machineId: machineB, root: f.mirrorRoot }))
    .rejects.toMatchObject({ code: "mirror-no-committed-prefix" });
  expect(readFileSync(file, "utf8")).toBe(f.first);
}, 5000);

it("offline recovery waits for the epoch lock before changing the mirror", async () => {
  const f = fixture(), source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  chmodSync(mirror.file, 0o600); appendFileSync(mirror.file, "partial"); chmodSync(mirror.file, 0o400);
  const interrupted = readFileSync(mirror.file);
  let release!: () => void, acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = withProcessLock(f.mirrorRoot, `mirror:${sessionId}:2`, async () => { acquired(); await gate; });
  await ready;
  let settled = false;
  const recovery = recoverMirror({ sessionId, epoch: 2, machineId: machineB, root: f.mirrorRoot }).finally(() => { settled = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(readFileSync(mirror.file)).toEqual(interrupted);
  } finally { release(); await held; }
  await recovery;
  expect(readFileSync(mirror.file, "utf8")).toBe(f.first);
}, 5000);

it("offline recovery refuses a checkpoint for a different home machine", async () => {
  const f = fixture(), source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  const before = readFileSync(mirror.file);
  await expect(recoverMirror({ sessionId, epoch: 2, machineId: machineA, root: f.mirrorRoot }))
    .rejects.toMatchObject({ code: "mirror-machine-changed" });
  expect(readFileSync(mirror.file)).toEqual(before);
}, 5000);

it("an operation completed while waiting for the epoch lock cannot append", async () => {
  const f = fixture();
  let source = await inspectSession(f.file, sessionId);
  const mirror = await appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal);
  const before = readFileSync(mirror.file);
  appendFileSync(f.file, line(entry("next", "epoch-2")));
  source = await inspectSession(f.file, sessionId);
  const operationId = "waiting-sync";
  f.journal.begin({ id: operationId, machineId: machineB, expectedEpoch: 2, kind: "sync", args: {} });
  let release!: () => void, acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = withProcessLock(f.mirrorRoot, `mirror:${sessionId}:2`, async () => { acquired(); await gate; });
  await ready;
  const pending = appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId }, f.journal);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.journal.read(operationId).some(action => action.action === "mirror-append-intent")).toBe(true);
    f.journal.record(operationId, "done", { complete: true });
  } finally { release(); await held; }
  await expect(pending).rejects.toMatchObject({ code: "mirror-operation-complete" });
  expect(readFileSync(mirror.file)).toEqual(before);
}, 5000);

it("a legacy journal without lookup refuses before a mirror write", async () => {
  const f = fixture();
  const source = await inspectSession(f.file, sessionId);
  const legacy = { begin: f.journal.begin, record: f.journal.record, read: f.journal.read };
  await expect(appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, legacy))
    .rejects.toMatchObject({ code: "mirror-journal-unavailable" });
  expect(existsSync(f.mirrorRoot)).toBe(false);
}, 5000);

it("unknown or completed journal operations refuse before a mirror write", async () => {
  const f = fixture();
  const source = await inspectSession(f.file, sessionId);
  await expect(appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: "unknown" }, f.journal))
    .rejects.toMatchObject({ code: "mirror-operation-unknown" });
  expect(existsSync(f.mirrorRoot)).toBe(false);
  f.journal.record(f.operationId, "done", { complete: true });
  await expect(appendMirror({ sessionId, epoch: 2, source, root: f.mirrorRoot, operationId: f.operationId }, f.journal))
    .rejects.toMatchObject({ code: "mirror-operation-complete" });
  expect(existsSync(f.mirrorRoot)).toBe(false);
}, 5000);
