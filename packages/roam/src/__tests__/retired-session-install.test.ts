import { afterEach, expect, it } from "vitest";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import type { Probe, Segment } from "@spider/db-core/roam/types";
import { DEFAULT_LIMITS } from "../contracts";
import type { FreezeAck } from "../contracts";
import { openFreezeJournal, openJournal } from "../journal";
import { inspectSession, installSession, stageSession } from "../session-file";

const roots: string[] = [];
const stamp = "2026-01-02T03:04:05.000Z";
const sessionId = "returning-session";
const machineA = "00000000-0000-4000-8000-000000000001";
const machineB = "00000000-0000-4000-8000-000000000002";
const machineC = "00000000-0000-4000-8000-000000000003";
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const withBothLocks = async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn();

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function returningSession(options: { retire?: boolean; matchingRewrite?: boolean; sourceEpoch?: number; incomingMoveId?: string } = {}) {
  const root = mkdtempSync(join(dirname(scratchDbPath("retired-install")), "return-"));
  roots.push(root);
  const cwd = join(root, "original-checkout"), awayCwd = join(root, "away-checkout");
  mkdirSync(cwd); mkdirSync(awayCwd);
  const target = join(root, "session.jsonl");
  const original = line({ type: "session", version: 3, id: sessionId, timestamp: stamp, cwd }) +
    line({ type: "message", id: "root", parentId: null, timestamp: stamp,
      message: { role: "user", content: "committed history", timestamp: 1 } });
  writeFileSync(target, original, { mode: 0o600 });
  const frozen = await inspectSession(target, sessionId);
  const journal = openFreezeJournal(join(root, "journal.db"));
  const sourceEpoch = options.sourceEpoch ?? 1;
  const away: Segment = { version: 1, moveId: "move-away", epoch: sourceEpoch + 1, previousMachine: machineA,
    nextMachine: machineB, historyMachine: machineA, parentRef: null };
  const freezeId = `${away.moveId}-session-freeze-${machineA}`;
  journal.begin({ id: freezeId, machineId: machineA, expectedEpoch: sourceEpoch, kind: "session-freeze",
    args: { sessionId, moveId: away.moveId } });
  journal.beginFreeze(sessionId, away.moveId, sourceEpoch);
  journal.bindIntercomFence({ address: { sessionId, scopeId: "scope" }, moveId: away.moveId,
    expectedEpoch: sourceEpoch, generation: "frozen-generation" });
  const ack: FreezeAck = { operationId: freezeId, sessionId, epoch: sourceEpoch, owner: null,
    file: frozen.file, cwd: frozen.cwd, leaf: frozen.leaf, size: frozen.size, sha256: frozen.sha256,
    barriers: [], intercomGeneration: "frozen-generation" };
  journal.advanceFreeze(sessionId, away.moveId, sourceEpoch, "frozen");
  journal.record(freezeId, "done", ack as unknown as import("@spider/db-core/roam/types").JsonObject);
  const awaySession = await stageSession({ source: frozen, destinationCwd: awayCwd, destinationParent: null,
    segment: { ...away, moveId: options.incomingMoveId ?? away.moveId } }, join(root, "outgoing"));
  // Equivalent to the source's durable retirement after the home commit and proved exit.
  if (options.retire !== false) journal.advanceFreeze(sessionId, away.moveId, sourceEpoch, "complete");
  appendFileSync(target, line({ type: "session_info", id: "retired-metadata", parentId: "root", timestamp: stamp,
    name: "post-commit metadata" }));
  if (options.matchingRewrite) {
    for (const file of [target, awaySession.file]) {
      writeFileSync(file, readFileSync(file, "utf8").replace("committed history", "divergent history"));
    }
  }
  const onwardSource = await inspectSession(awaySession.file, sessionId);
  const onward = await stageSession({ source: onwardSource, destinationCwd: join(root, "third-checkout"), destinationParent: null,
    segment: { ...away, moveId: "move-onward", epoch: away.epoch + 1, previousMachine: machineB, nextMachine: machineC } }, join(root, "onward"));
  const returnSource = await inspectSession(onward.file, sessionId);
  const returning = await stageSession({ source: returnSource, destinationCwd: cwd, destinationParent: null,
    segment: { ...away, moveId: "move-return", epoch: away.epoch + 2, previousMachine: machineC, nextMachine: machineA } }, join(root, "returning"));
  journal.begin({ id: returning.artifactId, machineId: machineA, expectedEpoch: away.epoch + 2, kind: "move", args: { sessionId } });
  const ports = { journal, withBothLocks, ownership: async (): Promise<Probe> => ({ kind: "absent" }) };
  const backup = join(root, `.${basename(target)}.${returning.artifactId}.backup`);
  return { root, cwd, target, original, journal, frozen, away, returning, ports, backup };
}

it("return installs committed history and backs up discarded retired metadata", async () => {
  const f = await returningSession();
  const retained = readFileSync(f.target);
  await installSession(f.returning, f.target, f.ports);
  expect(readFileSync(f.target)).toEqual(readFileSync(f.returning.file));
  expect(readFileSync(f.target, "utf8")).not.toContain("retired-metadata");
  expect(readFileSync(f.backup)).toEqual(retained);
  if (process.platform !== "win32") expect(lstatSync(f.backup).mode & 0o777).toBe(0o600);
  const installed = await inspectSession(f.target, sessionId);
  expect(installed.cwd).toBe(f.cwd);
  expect(installed.sessionId).toBe(sessionId);
  const finalEntry = JSON.parse(readFileSync(f.target, "utf8").trimEnd().split("\n").at(-1)!);
  expect(finalEntry.data).toMatchObject({ epoch: 4, previousMachine: machineC, nextMachine: machineA, historyMachine: machineA });
  await installSession(f.returning, f.target, f.ports);
  expect(readFileSync(f.backup)).toEqual(retained);
});

it("return uses the freeze epoch after rollback without requiring a new source segment", async () => {
  const f = await returningSession({ sourceEpoch: 3 });
  await installSession(f.returning, f.target, f.ports);
  expect(readFileSync(f.target)).toEqual(readFileSync(f.returning.file));
  expect(readFileSync(f.backup, "utf8")).toContain("retired-metadata");
});

it("return through an operation journal reads the persisted retirement proof", async () => {
  const f = await returningSession();
  await installSession(f.returning, f.target, { ...f.ports, journal: openJournal(join(f.root, "journal.db")) });
  expect(readFileSync(f.target)).toEqual(readFileSync(f.returning.file));
  expect(readFileSync(f.backup, "utf8")).toContain("retired-metadata");
});

it("return retains its frozen prefix proof after journal retention expires", async () => {
  const f = await returningSession();
  f.journal.prune(Date.now() + DEFAULT_LIMITS.retentionMs + 1, DEFAULT_LIMITS.retentionMs);
  await installSession(f.returning, f.target, f.ports);
  expect(readFileSync(f.target)).toEqual(readFileSync(f.returning.file));
  expect(readFileSync(f.backup, "utf8")).toContain("retired-metadata");
});

it("return refuses edits inside the committed range without replacing the retired file", async () => {
  const f = await returningSession();
  const divergent = readFileSync(f.target, "utf8").replace("committed history", "divergent history");
  writeFileSync(f.target, divergent);
  await expect(installSession(f.returning, f.target, f.ports)).rejects.toThrow(/diverged/);
  expect(readFileSync(f.target, "utf8")).toBe(divergent);
  expect(existsSync(f.backup)).toBe(false);
});

it("return refuses a committed rewrite even when incoming history matches it", async () => {
  const f = await returningSession({ matchingRewrite: true });
  const retained = readFileSync(f.target);
  await expect(installSession(f.returning, f.target, f.ports)).rejects.toThrow(/diverged/);
  expect(readFileSync(f.target)).toEqual(retained);
  expect(existsSync(f.backup)).toBe(false);
});

it("return does not discard appends from a freeze whose retirement is unfinished", async () => {
  const f = await returningSession({ retire: false });
  const retained = readFileSync(f.target);
  await expect(installSession(f.returning, f.target, f.ports)).rejects.toThrow(/diverged/);
  expect(readFileSync(f.target)).toEqual(retained);
  expect(existsSync(f.backup)).toBe(false);
});

it("return cannot borrow retirement proof from a different departure at the same epoch", async () => {
  const f = await returningSession({ incomingMoveId: "unrecorded-departure" });
  const retained = readFileSync(f.target);
  await expect(installSession(f.returning, f.target, f.ports)).rejects.toThrow(/diverged/);
  expect(readFileSync(f.target)).toEqual(retained);
  expect(existsSync(f.backup)).toBe(false);
});

it.each(["live", "uncertain"] as const)("return refuses a %s destination owner even with retirement proof", async kind => {
  const f = await returningSession();
  const retained = readFileSync(f.target);
  const owner: Probe = kind === "live" ? { kind, identity: { bootId: "boot", pid: 1, startTime: "1" } } : { kind };
  await expect(installSession(f.returning, f.target, { ...f.ports, ownership: async () => owner })).rejects.toThrow(/owner/);
  expect(readFileSync(f.target)).toEqual(retained);
  expect(existsSync(f.backup)).toBe(false);
});

it("return keeps the configured size limit for the retained file including discarded appends", async () => {
  const f = await returningSession();
  appendFileSync(f.target, line({ type: "session_info", id: "large-metadata", parentId: "retired-metadata", timestamp: stamp,
    name: "x".repeat(f.returning.size) }));
  const retained = readFileSync(f.target);
  await expect(installSession(f.returning, f.target, { ...f.ports,
    limits: { ...DEFAULT_LIMITS, sessionBytes: f.returning.size } })).rejects.toThrow(/oversized/);
  expect(readFileSync(f.target)).toEqual(retained);
});

it("retrying an earlier return cannot discard appends from the newer installed copy", async () => {
  const f = await returningSession();
  await installSession(f.returning, f.target, f.ports);
  appendFileSync(f.target, line({ type: "session_info", id: "installed-metadata", parentId: f.returning.leaf, timestamp: stamp,
    name: "metadata from the returned copy" }));
  const retained = readFileSync(f.target);
  rmSync(f.backup); // Old backups may have been deliberately removed before a later retry.
  await expect(installSession(f.returning, f.target, f.ports)).rejects.toThrow(/diverged/);
  expect(readFileSync(f.target)).toEqual(retained);
});

it("a second return uses its own retirement boundary and preserves earlier segments", async () => {
  const f = await returningSession();
  await installSession(f.returning, f.target, f.ports);
  const frozen = await inspectSession(f.target, sessionId);
  const moveId = "second-away", freezeId = `${moveId}-session-freeze-${machineA}`;
  f.journal.begin({ id: freezeId, machineId: machineA, expectedEpoch: 4, kind: "session-freeze", args: { sessionId, moveId } });
  f.journal.beginFreeze(sessionId, moveId, 4);
  f.journal.bindIntercomFence({ address: { sessionId, scopeId: "scope" }, moveId, expectedEpoch: 4, generation: "second-generation" });
  f.journal.advanceFreeze(sessionId, moveId, 4, "frozen");
  const ack: FreezeAck = { operationId: freezeId, sessionId, epoch: 4, owner: null, file: frozen.file, cwd: frozen.cwd,
    leaf: frozen.leaf, size: frozen.size, sha256: frozen.sha256, barriers: [], intercomGeneration: "second-generation" };
  f.journal.record(freezeId, "done", ack as unknown as import("@spider/db-core/roam/types").JsonObject);
  const secondAway = await stageSession({ source: frozen, destinationCwd: join(f.root, "second-checkout"), destinationParent: null,
    segment: { ...f.away, moveId, epoch: 5 } }, join(f.root, "second-away"));
  f.journal.advanceFreeze(sessionId, moveId, 4, "complete");
  appendFileSync(f.target, line({ type: "session_info", id: "second-retired", parentId: frozen.leaf, timestamp: stamp, name: "second discarded append" }));
  const retained = readFileSync(f.target);
  const incoming = await stageSession({ source: await inspectSession(secondAway.file, sessionId), destinationCwd: f.cwd, destinationParent: null,
    segment: { ...f.away, moveId: "second-return", epoch: 6, previousMachine: machineB, nextMachine: machineA } }, join(f.root, "second-return"));
  f.journal.begin({ id: incoming.artifactId, machineId: machineA, expectedEpoch: 6, kind: "move", args: { sessionId } });
  await installSession(incoming, f.target, f.ports);
  expect(readFileSync(f.target)).toEqual(readFileSync(incoming.file));
  expect(readFileSync(f.target, "utf8")).toContain("move-return");
  expect(readFileSync(f.target, "utf8")).not.toContain("second-retired");
  expect(readFileSync(join(f.root, `.${basename(f.target)}.${incoming.artifactId}.backup`))).toEqual(retained);
});

it("return cannot use retirement proof from before a newer installed epoch", async () => {
  const f = await returningSession();
  await installSession(f.returning, f.target, f.ports);
  appendFileSync(f.target, line({ type: "session_info", id: "new-metadata", parentId: f.returning.leaf, timestamp: stamp, name: "new active copy" }));
  const retained = readFileSync(f.target);
  const laterAway = await stageSession({ source: await inspectSession(f.returning.file, sessionId), destinationCwd: join(f.root, "later-away"), destinationParent: null,
    segment: { ...f.away, moveId: "later-away", epoch: 5, previousMachine: machineA, nextMachine: machineB } }, join(f.root, "later-away-staging"));
  const incoming = await stageSession({ source: await inspectSession(laterAway.file, sessionId), destinationCwd: f.cwd, destinationParent: null,
    segment: { ...f.away, moveId: "later-return", epoch: 6, previousMachine: machineB, nextMachine: machineA } }, join(f.root, "later"));
  f.journal.begin({ id: incoming.artifactId, machineId: machineA, expectedEpoch: 6, kind: "move", args: { sessionId } });
  await expect(installSession(incoming, f.target, f.ports)).rejects.toThrow(/diverged/);
  expect(readFileSync(f.target)).toEqual(retained);
});
