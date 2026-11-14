import { afterEach, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { claimIdLock } from "@spider/herdr/sessions/id-lock";
import { writeLaunchHandoff } from "@spider/herdr/sessions/launch-handoff";
import { hash } from "@spider/herdr/sessions/registry";
import { runLocalDoctor } from "../local-diagnostics";
import { createIntentStore } from "../intent";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it.each([
  [null, /core identity.*unavailable/i],
  ["new-core", /core.*changed/i],
  ["original-core", /awaiting reconciliation/i],
])("reports a pending handoff without changing files or exposing its nonce (core %s)", async (currentCore, detail) => {
  const parent = resolve(".spider/scratch/roam-handoff-doctor");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "case-")); roots.push(root);
  const stateRoot = join(root, "herdr"), file = join(root, "session.jsonl");
  const owner = { pid: 9876, startIdentity: "fixture-owner" };
  const lock = await claimIdLock(stateRoot, "session-1", owner, async () => ({ kind: "live", startIdentity: owner.startIdentity }),
    { bootId: async () => "fixture-boot" });
  const pending = await lock.prepareHandoff("operation-1", file, "original-core");
  const handoff = await writeLaunchHandoff(stateRoot, { version: 1, operationId: "operation-1", sessionId: "session-1",
    sessionFile: file, nonce: pending.nonce, leaseToken: "a".repeat(64) });
  const lockFile = join(stateRoot, "id-locks", `${hash("session-1")}.json`);
  const paths = [stateRoot, join(stateRoot, "id-locks"), lockFile, handoff];
  const snapshot = async () => Promise.all(paths.map(async path => {
    const stat = await lstat(path); return { mode: stat.mode, mtimeMs: stat.mtimeMs, bytes: stat.isFile() ? await readFile(path, "utf8") : null };
  }));
  const before = await snapshot();
  const report = await runLocalDoctor({ root, currentCore: async () => currentCore });
  expect(report.diagnostics.map(item => item.reason).join("\n")).toMatch(detail);
  expect(report.diagnostics.map(item => item.reason).join("\n")).toContain("session-1");
  expect(JSON.stringify(report)).not.toContain(pending.nonce);
  expect(JSON.stringify(report)).not.toContain("a".repeat(64));
  expect(await snapshot()).toEqual(before);
}, 5000);

it("reports a reserved launch with no handoff without changing its state", async () => {
  const parent = resolve(".spider/scratch/roam-handoff-doctor");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "reservation-")); roots.push(root);
  const store = createIntentStore(root), id = "session-1";
  const state = { intent: { sessionId: id, epoch: 1, desired: "running" as const, suspended: null,
    file: join(root, "session.jsonl"), cwd: root, moveId: null }, failures: [],
    supervision: { kind: "launching" as const, operationId: "reserved-operation", phase: "invoking" as const } };
  await store.update(id, null, state);
  const file = join(root, "roam", "intents", `${hash(id)}.json`), before = await readFile(file, "utf8"), mode = (await lstat(file)).mode;
  const report = await runLocalDoctor({ root });
  expect(report.diagnostics.map(item => item.reason).join("\n")).toMatch(/reserved-operation.*pending/i);
  expect(await readFile(file, "utf8")).toBe(before);
  expect((await lstat(file)).mode).toBe(mode);
}, 5000);
