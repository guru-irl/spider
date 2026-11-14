import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { openJournal } from "@spider/roam/journal";
import { createRunningIntentAuthority, readReadiness } from "@spider/roam/session-control";
import type { Readiness } from "@spider/db-core/roam/types";
import { registerAdmission, type AdmissionPorts } from "../admission";
import { persistReadiness } from "../readiness";

const BOX = "00000000-0000-4000-8000-000000000002";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); vi.unstubAllEnvs(); });
function fixture() {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const f = createReplica("global", BOX); fixtures.push(f);
  const journal = openJournal(join(f.root, "roam", "journal.db"));
  const ready: Readiness = { origin: "hub-operation" as const, opId: "admission-1", sessionId: "session-1", epoch: 1, cwd: f.root, file: join(f.root, "session.jsonl"), core: "core-1", terminal: "term-1" };
  journal.begin({ id: ready.opId, kind: "admission", machineId: BOX, expectedEpoch: 1, args: {} });
  const hooks = new Map<string, Array<(...args: any[]) => any>>();
  const pi = { on(name: string, handler: (...args: any[]) => any) { hooks.set(name, [...hooks.get(name) ?? [], handler]); } };
  const ctx = { cwd: f.root, sessionManager: { getSessionId: () => ready.sessionId, getSessionFile: () => ready.file } };
  const ports: AdmissionPorts = { expectedEpoch: null, localMachine: async () => BOX, knownParticipant: () => true, warnOnce() {},
    load: async () => ({ home: null, origin: BOX, participating: true, captureSafe: true, unfinishedFreeze: false, initialConflict: false,
      states: [{ sessionId: "session-1", epoch: 1, state: "active", moveId: null, freezeSeq: null }] }), lock: async () => async () => {} };
  return { ...f, journal, ready, hooks, pi, ctx, ports };
}

it("readiness commits before ordinary consumers", async () => {
  const f = fixture(), order: string[] = [];
  f.ports.ready = async () => { expect(gate.inspect().kind).toBe("pending"); persistReadiness(f.journal, f.ready); order.push("ready-durable"); };
  const gate = registerAdmission(f.pi as never, f.ports);
  f.hooks.get("session_start")!.push(() => { if (gate.inspect().kind === "ordinary") order.push("ordinary-consumer"); });
  for (const handler of f.hooks.get("session_start")!) await handler({}, f.ctx);
  expect(order.indexOf("ready-durable")).toBeLessThan(order.indexOf("ordinary-consumer"));
  expect(readReadiness(openJournal(join(f.root, "roam", "journal.db")), "admission-1")).toEqual(f.ready);
  await gate.close();
}, 5000);

it("failed readiness leaves admission closed and runs no ordinary consumer", async () => {
  const f = fixture(); f.ports.ready = async () => { throw new Error("disk full"); };
  const gate = registerAdmission(f.pi as never, f.ports);
  await f.hooks.get("session_start")![0]({}, f.ctx);
  expect(gate.inspect().kind).toBe("blocked"); expect(readReadiness(f.journal, "admission-1")).toBeNull();
  await gate.close();
}, 5000);

it.each(["quit", "reload"])("%s preserves the correct durable hosting intent", async reason => {
  const f = fixture(), authority = createRunningIntentAuthority(f.db);
  await authority.set({ sessionId: f.ready.sessionId, epoch: 1, desired: "running", suspended: null, file: f.ready.file, cwd: f.ready.cwd, moveId: null }, f.ready.opId);
  f.ports.ready = async () => persistReadiness(f.journal, f.ready);
  f.ports.stopped = id => authority.stop(id);
  const gate = registerAdmission(f.pi as never, f.ports);
  await f.hooks.get("session_start")![0]({}, f.ctx);
  await f.hooks.get("session_shutdown")![0]({ reason }, f.ctx);
  expect(await authority.get(f.ready.sessionId)).toMatchObject({ desired: reason === "quit" ? "stopped" : "running" });
  await gate.close();
}, 5000);

it("a replay cannot replace the persisted readiness owner", () => {
  const f = fixture(); persistReadiness(f.journal, f.ready); persistReadiness(f.journal, f.ready);
  expect(() => persistReadiness(f.journal, { ...f.ready, terminal: "term-2" })).toThrow("owner changed");
  expect(readReadiness(f.journal, "admission-1")).toEqual(f.ready);
}, 5000);
