import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import { migrate, openDb } from "@spider/db-core";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { main } from "../cli";
import { parsePublicControl } from "../commands";
import { serveV0Control } from "../relocate/service";
import { readCachedSessionStatus } from "../relocate/session-stop-store";
import { createLocalStop } from "../relocate/local-stop";
import { decodeStopObservation } from "../relocate/remote";
import { createHomeStore } from "../relocate/home";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import type { LocalIO } from "../relocate/local";
import type { RelocateAdapterOptions, SessionId, StoppedHome } from "../relocate/types";
import * as legacyTransport from "../transport";
import * as productionHub from "../production-hub";
import { hostingWarningDiagnostic } from "../hosting-warning";
import { HUB_ID, writeEnabledConfig } from "./fixtures/enabled-config";

const box = "00000000-0000-4000-8000-000000000002";
const id = "session-abcdef";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("public stop and start never reach a legacy socket", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "s12-")); roots.push(root);
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  vi.stubEnv("HC_SOCKET", join(root, "hc.sock")); vi.stubEnv("HC_SESSION", "stop-cli-test");
  writeEnabledConfig(root, { peers: [{ machineId: box, alias: "box", node: "/node", pi: "/pi", cli: "/spider", core: "/hc", globalRoot: "/global" }] });
  const db = openDb(join(root, "spider.db")), project = openDb(join(root, "project.db"));
  migrate(db, "global", { machineId: HUB_ID, globalRoot: root });
  migrate(project, "worktree", { machineId: HUB_ID, globalRoot: root });
  db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('p',?,?,1,1)").run(root, project.raw.name);
  project.prepare("INSERT INTO sessions(id,name,started_at) VALUES (?, 'session with spaces', 1)").run(id);
  for (const other of ["duplicate-one", "duplicate-two"]) {
    project.prepare("INSERT INTO sessions(id,name,started_at) VALUES (?, 'duplicate name', 1)").run(other);
    db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,7,NULL,100,'running',NULL)").run(other, box);
  }
  project.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('legacy-only','legacy name',1)").run();
  db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES ('legacy-only',?,1,NULL,100)").run(box);
  db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,7,NULL,100,'running',NULL)").run(id, box);
  const calls: unknown[] = [], legacyCalls: unknown[] = [], rawAgentCalls: unknown[] = [];
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/hc" } } as never);
  const transport = vi.spyOn(legacyTransport, "createTransport").mockReturnValue({
    async resolve(peer: unknown) { return peer; },
    async exec(_peer: unknown, argv: string[]) {
      const operation = JSON.parse(argv[2]); rawAgentCalls.push(operation);
      return Buffer.from(JSON.stringify({ code: 0, reason: "stopped-intent", operationId: operation.id, home: null, epoch: 7, repairCommand: null, value: null }));
    },
  } as never);
  const legacy = createServer(socket => { legacyCalls.push("connected"); socket.destroy(); });
  const legacyPath = join(root, "roam", "hub.sock");
  await new Promise<void>(done => legacy.listen(legacyPath, done)); chmodSync(legacyPath, 0o600);
  const probe = createConnection(legacyPath);
  await new Promise<void>((done, fail) => { probe.once("close", () => done()); probe.once("error", fail); });
  expect(legacyCalls).toEqual(["connected"]); legacyCalls.length = 0;
  const unexpected = async () => { throw new Error("unexpected placement request"); };
  const server = await serveV0Control(root, { sync: unexpected, relocate: unexpected, setHome: unexpected,
    stop: async request => { calls.push(request); return { sessionId: id as never, operationId: request.operationId, machineId: box, homeEpoch: 8, homeState: "stopped", status: "stopped", outcome: "complete", reason: null, observedAt: 123 }; },
    start: async request => { calls.push(request); return { sessionId: id as never, operationId: request.operationId, machineId: box, homeEpoch: 9, homeState: "running", status: "running", outcome: "complete", reason: null, observedAt: 124 }; },
    sessionStatus: unexpected,
  });
  const out: string[] = [], err: string[] = [], io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  try {
    for (const target of [id, "session-abc", "session with spaces"]) {
      expect(await main(["roam", "stop", target, "--now", "--json"], io)).toBe(0);
      expect(legacyCalls).toEqual([]); expect(rawAgentCalls).toEqual([]);
      expect(calls.at(-1)).toMatchObject({ sessionId: id, machineId: box, homeEpoch: 7, mode: "hard" });
    }
    db.prepare("UPDATE session_homes SET epoch=8,state='stopped' WHERE session_id=?").run(id);
    for (const target of [id, "session-abc", "session with spaces"]) {
      expect(await main(["roam", "start", target, "--json"], io)).toBe(0);
      expect(calls.at(-1)).toMatchObject({ sessionId: id, machineId: box, homeEpoch: 8 });
    }
    expect(await main(["roam", "stop", "duplicate name"], io)).toBe(1);
    expect(await main(["roam", "stop", "legacy-only"], io)).toBe(1);
    expect(calls).toHaveLength(6);
    expect(await main(["roam", "resume", id], io)).toBe(2);
    expect(legacyCalls).toEqual([]); expect(rawAgentCalls).toEqual([]); expect(transport).not.toHaveBeenCalled();
  } finally { await server.close(); await new Promise<void>(done => legacy.close(() => done())); project.close(); db.close(); }
});

it("distinguishes confirmed, pending, refused and lost replies without a saved claim", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "s12-")); roots.push(root);
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root); writeEnabledConfig(root);
  const db = openDb(join(root, "spider.db")); migrate(db, "global", { machineId: HUB_ID, globalRoot: root });
  db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,7,NULL,100,'running',NULL)").run(id, box);
  let response: "confirmed" | "pending" | "refused" | "lost" = "confirmed";
  const server = createServer(socket => socket.once("data", bytes => {
    const request = JSON.parse(String(bytes)).request;
    if (response === "lost") { socket.destroy(); return; }
    const result = { sessionId: id, operationId: request.operationId, machineId: box, homeEpoch: 8, homeState: "stopped",
      status: response === "confirmed" ? "stopped" : "stop-pending", observedAt: response === "confirmed" ? 123 : null,
      outcome: response === "confirmed" ? "complete" : response, reason: response === "confirmed" ? null : "fixture-reason" };
    socket.end(`${JSON.stringify({ version: 1, kind: "stop", result })}\n`);
  }));
  await new Promise<void>(done => server.listen(join(root, "roam", "relocate.sock"), done)); chmodSync(join(root, "roam", "relocate.sock"), 0o600);
  const out: string[] = [], err: string[] = [], io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  try {
    const exitCodes: Record<string, number> = {};
    for (response of ["confirmed", "pending", "refused", "lost"] as const) { out.length = 0; err.length = 0; exitCodes[response] = await main(["roam", "stop", id], io); }
    exitCodes.invalid = await main(["roam", "stop", "--now"], io);
    expect(exitCodes).toEqual({ confirmed: 0, pending: 3, lost: 3, refused: 1, invalid: 2 });
    const lostText = err.join(""); expect(lostText).toMatch(/unknown.*status/is); expect(lostText).not.toMatch(/saved/i);
    response = "lost"; out.length = 0;
    expect(await main(["roam", "start", id, "--json"], io)).toBe(3);
    expect(JSON.parse(out.join(""))).toMatchObject({ code: 3, reason: "outcome-unknown", operationId: expect.any(String), message: expect.stringMatching(/unknown.*status/i) });
  } finally { await new Promise<void>(done => server.close(() => done())); db.close(); }
});

it.each(["disabled", "box"] as const)("refuses session actions from a %s caller", async mode => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "s12-")); roots.push(root);
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  writeEnabledConfig(root, mode === "disabled" ? { enabled: false } : { role: "box", machineId: box, hubMachineId: HUB_ID, peers: [] });
  const out: string[] = [], err: string[] = [], io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  const transport = vi.spyOn(legacyTransport, "createTransport");
  for (const action of ["stop", "start"]) expect(await main(["roam", action, id], io)).toBe(1);
  expect(transport).not.toHaveBeenCalled();
  expect(err.join("")).toContain(mode === "disabled" ? "roaming-disabled" : "Mac hub");
});

it.each([
  ["roam", "stop", "--now"], ["roam", "stop", id, "--now", "--now"], ["roam", "stop", id, "--bad"],
  ["roam", "start", id, "--now"], ["roam", "start", "bad\nname"], ["roam", "resume", id],
])("rejects invalid action arguments %j", async (...args) => {
  const out: string[] = [], err: string[] = [];
  expect(await main(args, { out: s => out.push(s), err: s => err.push(s) })).toBe(2);
});

it("status reads cached proof and its age with the hub socket closed", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "s12-")); roots.push(root);
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  writeEnabledConfig(root);
  const db = openDb(join(root, "spider.db"));
  migrate(db, "global", { machineId: HUB_ID, globalRoot: root });
  const now = Date.now(), observedAt = now - 12_000;
  const home = (sessionId: string, state: "running" | "stopped" | "moving", epoch: number) => ({
    sessionId, machineId: box, state, epoch, updatedAt: 100, moveId: state === "moving" ? "v0-11111111-1111-4111-8111-111111111111" : null,
    destination: state === "moving" ? HUB_ID : null,
  });
  const running = home("running", "running", 7), stopped = home("stopped", "stopped", 8), moving = home("moving", "moving", 4), pending = home("pending", "stopped", 6);
  for (const h of [running, stopped, moving, pending]) db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,?,?,?,?,?)")
    .run(h.sessionId, h.machineId, h.epoch, h.moveId, h.updatedAt, h.state, h.destination);
  writeLocal(db, "session-transition", running.sessionId, { operationId: "start-1", expected: running, committed: running, contactReason: null, action: "start", observedAt });
  writeLocal(db, "session-transition", stopped.sessionId, { operationId: "stop-1", expected: stopped, committed: stopped, contactReason: null, action: "stop", mode: "hard", displaced: [], observations: [{ sessionId: stopped.sessionId, machineId: box, home: stopped, observedAt, bootId: "boot", evidence: { kind: "confirmed", owner: null } }] });
  writeLocal(db, "session-transition", pending.sessionId, { operationId: "stop-2", expected: pending, committed: pending, contactReason: "Box unreachable", action: "stop", mode: "graceful", displaced: [], observations: [] });
  db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES ('a-corrupt',?,1,NULL,100,'stopped',NULL)").run(box);
  writeLocal(db, "session-transition", "a-corrupt", { invalid: true });
  for (const h of [running, stopped, moving, pending]) expect(readCachedSessionStatus(db, h.sessionId as SessionId, now).homeState).toBe(h.state);
  const out: string[] = [], err: string[] = [], io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  expect(await main(["roam", "status", "--json"], io)).toBe(0);
  const cached = JSON.parse(out.join(""));
  expect(cached.complete).toBe(false);
  expect(cached.diagnostics).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("a-corrupt") }));
  expect(cached.sessions).toContainEqual(expect.objectContaining({ sessionId: "stopped", machineId: box, homeState: "stopped", homeEpoch: 8, status: "stopped", observedAt }));
  expect(cached.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "running", status: "running" }), expect.objectContaining({ sessionId: "moving", status: "moving" }), expect.objectContaining({ sessionId: "pending", status: "stop-pending", reason: "Box unreachable" })]));
  out.length = 0;
  expect(await main(["roam", "status"], io)).toBe(0);
  expect(out.join("")).toContain("Stopped"); expect(out.join("")).toContain("12 seconds ago");
  db.close();
});

it.each([
  { kind: "relocate-stop-proof", suffix: "not-a-key", recordSession: null },
  { kind: "relocate-stop-mode", suffix: `[${JSON.stringify(id)},`, recordSession: id },
] as const)("reports unreadable $kind and safe guidance in status", async ({ kind, suffix, recordSession }) => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "s12-")); roots.push(root);
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  writeEnabledConfig(root);
  const db = openDb(join(root, "spider.db"));
  try {
    migrate(db, "global", { machineId: HUB_ID, globalRoot: root });
    const home: StoppedHome = { sessionId: id as SessionId, machineId: box, epoch: 8, state: "stopped", destination: null, moveId: null, updatedAt: 8 };
    db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,8,NULL,8,'stopped',NULL)").run(id, box);
    db.prepare("INSERT INTO roam_cursors(peer_machine,peer_stream,last_seq) VALUES ('',?,0)").run(`spider-local:${kind}:${suffix}`);
    const unused = () => { throw new Error("unexpected effect"); };
    const config = { enabled: true, role: "box" as const, machineId: box, hubMachineId: HUB_ID, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
    const options = { root, globalDb: db, config, limits: DEFAULT_LIMITS,
      homes: createHomeStore({ db, hubMachineId: HUB_ID, localMachineId: box }),
      clock: { now: () => 1000, later: () => () => {} },
    } as unknown as RelocateAdapterOptions;
    const local = createLocalStop(options, { bootId: async () => "boot" } as LocalIO, async (_id, fn) => fn());
    const observation = await local.observeStopped(home);
    expect(observation.evidence.kind).toBe("pending");
    const decoded = decodeStopObservation(JSON.parse(JSON.stringify(observation)), box, home);
    writeLocal(db, "session-transition", id, { operationId: "stop-m1", expected: home, committed: home, action: "stop", mode: "graceful", displaced: [], contactReason: null, observations: [decoded] });
    const out: string[] = [], io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s) };
    expect(await main(["roam", "status", "--json"], io)).toBe(0);
    const status = JSON.parse(out.join("")).sessions.find((row: { sessionId: string }) => row.sessionId === id);
    expect(status.status).toBe("stop-pending");
    expect(status.reason).toContain(kind); expect(status.reason).toContain(box);
    if (recordSession) expect(status.reason).toContain(recordSession); else expect(status.reason).toMatch(/unknown|unattributable/i);
    expect(status.reason).toMatch(/enforcement continues/i);
    expect(status.reason).toMatch(/pending until.*read/i);
    expect(status.reason).toContain(`spider roam doctor ${box}`);
    expect(status.reason).toContain(`spider roam stop ${id}`);
    expect(status.reason).not.toMatch(/delete|remove|overwrite/i);
    out.length = 0;
    expect(await main(["roam", "status"], io)).toBe(0);
    expect(out.join("")).toContain(status.reason);
    void unused;
  } finally { db.close(); }
});

it("legacy hosting warnings do not suggest the new session actions", () => {
  const warning = hostingWarningDiagnostic(id, { code: "supervisor-hosting-error", check: "inspection", since: 1, count: 3 });
  expect(warning.reason).toContain("roaming-upgrade.md#settle-old-work-only-after-approval");
  expect(warning.reason).not.toMatch(/spider roam (stop|resume|start)/);
  expect(warning.repairCommand).toBe("spider roam doctor");
});

it("accepts one exact session name and rejects controls and flags as targets", () => {
  expect(parsePublicControl(["roam", "stop", "session with spaces", "--now", "--json"])).toEqual({ kind: "stop", session: "session with spaces", mode: "hard" });
  expect(parsePublicControl(["roam", "start", "session with spaces"])).toEqual({ kind: "start", session: "session with spaces" });
  for (const args of [["roam", "stop", "--now"], ["roam", "stop", "x", "--bad"], ["roam", "start", "x", "--now"], ["roam", "resume", "x"], ["roam", "start", "x\ny"]])
    expect(parsePublicControl(args)).toBeNull();
});
