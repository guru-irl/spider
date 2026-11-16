import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { scratchDbPath } from "@spider/db-core/testutil";
import type { Segment } from "@spider/db-core/roam/types";
import { openJournal } from "../journal";
import { inspectSession, installSession, stageSession } from "../session-file";

const roots: string[] = [];
const stamp = "2026-01-02T03:04:05.000Z";
const sessionId = "sdk-session-1";
const machineA = "00000000-0000-4000-8000-000000000001";
const machineB = "00000000-0000-4000-8000-000000000002";
const segment: Segment = {
  version: 1, moveId: "sdk-move-1", epoch: 2, previousMachine: machineA,
  nextMachine: machineB, historyMachine: machineA, parentRef: null,
};
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const entry = (id: string, parentId: string | null, content: string) => ({
  type: "message", id, parentId, timestamp: stamp, message: { role: "user", content, timestamp: 1 },
});
function fixture() {
  const root = mkdtempSync(join(dirname(scratchDbPath("session-sdk")), "session-sdk-")); roots.push(root);
  const oldCwd = join(root, "old"), mappedCwd = join(root, "mapped");
  mkdirSync(oldCwd); mkdirSync(mappedCwd);
  writeFileSync(join(oldCwd, "sentinel"), "old");
  writeFileSync(join(mappedCwd, "sentinel"), "destination");
  const source = join(root, "source.jsonl");
  const header = { type: "session", version: 3, id: sessionId, timestamp: stamp, cwd: oldCwd };
  const history = line(entry("root", null, "root")) + line(entry("selected", "root", "selected")) + line(entry("later", "root", "abandoned"));
  writeFileSync(source, line(header) + history, { mode: 0o600 });
  return { root, oldCwd, mappedCwd, source, header, history };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("older selected leaf survives physical later branch", async () => {
  const f = fixture();
  const inspected = await inspectSession(f.source, sessionId, "selected");
  const staged = await stageSession({ source: inspected, destinationCwd: f.mappedCwd, destinationParent: null, segment }, join(f.root, "staging"));
  const targetDir = join(f.root, "destination"); mkdirSync(targetDir, { mode: 0o700 });
  const target = join(targetDir, "exact.jsonl");
  const journal = openJournal(join(f.root, "journal.db"));
  journal.begin({ id: segment.moveId, machineId: machineA, expectedEpoch: 1, kind: "move", args: {} });
  await installSession(staged, target, { journal, withBothLocks: async <T>(_id: string, fn: () => Promise<T>) => fn(),
    ownership: async () => ({ kind: "absent" }) });
  const opened = SessionManager.open(target);
  const markerId = staged.leaf;
  expect(opened.getSessionId()).toBe(sessionId);
  expect(opened.getCwd()).toBe(f.mappedCwd);
  expect(readFileSync(join(opened.getCwd(), "sentinel"), "utf8")).toBe("destination");
  expect(opened.getBranch().map(e => e.id)).toEqual(["root", "selected", markerId]);
  const contextText = JSON.stringify(opened.buildSessionContext().messages);
  expect(contextText).toContain("selected");
  expect(contextText).not.toContain("abandoned");
  expect(contextText).not.toContain("spider-roam-segment");
  const installed = readFileSync(target, "utf8").split("\n");
  const installedHistoryDigest = createHash("sha256").update(installed.slice(1, -2).join("\n") + "\n").digest("hex");
  const sourceHistoryDigest = createHash("sha256").update(f.history).digest("hex");
  expect(installedHistoryDigest).toBe(sourceHistoryDigest);
}, 5000);

it("a later move retains the initial history machine", async () => {
  const f = fixture();
  const inspected = await inspectSession(f.source, sessionId, "selected");
  const first = await stageSession({ source: inspected, destinationCwd: f.mappedCwd, destinationParent: null, segment }, join(f.root, "first"));
  const moved = await inspectSession(first.file, sessionId);
  const secondSegment: Segment = { ...segment, moveId: "sdk-move-2", epoch: 3, previousMachine: machineB, nextMachine: machineA };
  await expect(stageSession({ source: moved, destinationCwd: f.oldCwd, destinationParent: null,
    segment: { ...secondSegment, historyMachine: machineB } }, join(f.root, "second"))).rejects.toThrow();
  const second = await stageSession({ source: moved, destinationCwd: f.oldCwd, destinationParent: null, segment: secondSegment }, join(f.root, "second"));
  const opened = SessionManager.open(second.file);
  const latest = opened.getEntry(second.leaf);
  expect(latest?.type).toBe("custom");
  if (latest?.type !== "custom") throw new Error("missing segment marker");
  expect((latest.data as Segment).historyMachine).toBe(machineA);
  expect((latest.data as Segment).parentRef).toBeNull();
  expect(opened.getBranch().map(e => e.id)).toEqual(["root", "selected", first.leaf, second.leaf]);
}, 5000);

it("older session formats upgrade on the source through Pi before inspection", async () => {
  const f = fixture();
  writeFileSync(f.source, line({ ...f.header, version: 2 }) + f.history);
  await expect(inspectSession(f.source, sessionId)).rejects.toThrow();
  const opened = SessionManager.open(f.source);
  expect(opened.getSessionId()).toBe(sessionId);
  expect(JSON.parse(readFileSync(f.source, "utf8").split("\n")[0]).version).toBe(3);
  expect((await inspectSession(f.source, sessionId)).leaf).toBe("later");
}, 5000);
