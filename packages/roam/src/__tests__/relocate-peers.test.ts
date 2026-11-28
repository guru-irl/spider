import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { testTmpDir } from "@spider/intercom/test-support";
import { openDb } from "@spider/db-core";
import { writeLocal } from "@spider/db-core/roam/local-state";
import type { ApplyReceipt } from "@spider/db-core/roam/types";
import { createReplica } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, disabledIntercom, type Clock, type Operation, type RoamConfig, type Transport } from "../contracts";
import { readLocalIdentity } from "../runtime";
import { openJournal } from "../journal";
import { isRevoked, revokeMachine } from "../revocation";
import { main } from "../cli";
import { safeControlOutcome } from "../commands";
import { createV0Runtime, startV0Hub } from "../relocate/runtime";
import { requestV0Services } from "../relocate/service";
import { handleRelocateAgent, type RelocateAgentRequest } from "../relocate/remote";
import type { RelocateId, SessionId, V0Result } from "../relocate/types";
import { deferred } from "./relocate-fakes";

const mac = "11111111-1111-4111-8111-111111111111";
const box = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const sessionId = "revocation-example" as SessionId;
const disabled = "44444444-4444-4444-8444-444444444444";
const forgotten = "55555555-5555-4555-8555-555555555555";
const uncertain = "66666666-6666-4666-8666-666666666666";

type PeerCall = { machineId: string; kind: string; operation?: Operation; reply?: V0Result<unknown> };
async function manualSyncFixture(machines = [box, other]) {
  const root = mkdtempSync(join(testTmpDir(), "ms-"));
  const replicas = new Map([mac, ...machines].map(machine => [machine, createReplica("global", machine)]));
  const local = replicas.get(mac)!;
  const peers = machines.map((machineId, i) => ({ machineId, alias: `box-${i}.invalid`, node: "/node", pi: "/pi", cli: "/spider",
    core: "/core", globalRoot: replicas.get(machineId)!.root }));
  const config: RoamConfig = { enabled: true, role: "hub", machineId: mac, hubMachineId: mac, peers,
    discoveryRoots: [], coreUnit: "fixture", syncMs: 10_000, limits: { ...DEFAULT_LIMITS, retryDelaysMs: [] }, intercom: disabledIntercom() };
  const scheduled = new Map<() => void, number>();
  const clock: Clock = { now: () => 100, later(ms, fn) { scheduled.set(fn, ms); return () => { scheduled.delete(fn); }; } };
  const resolved: string[] = [], calls: PeerCall[] = [];
  const network = new Map<string, ReturnType<typeof createV0Runtime>>();
  let onResolve: (machine: string) => void = () => {};
  let onRequest: (call: PeerCall) => void | Promise<void> = () => {};
  let onReply: (call: PeerCall, result: V0Result<unknown>) => V0Result<unknown> = (_call, result) => result;
  let onHubConfigRead: () => void = () => {};
  const unavailable = new Set<string>();
  const unused = async () => { throw new Error("Unexpected transport method"); };
  const transport: Transport = {
    bootstrapProbe: unused, run: unused, write: unused,
    async resolve(peer) {
      resolved.push(peer.machineId); onResolve(peer.machineId);
      if (unavailable.has(peer.machineId)) throw new Error("Peer is unreachable");
      return peer;
    },
    async exec(peer, argv, options) {
      expect(argv).toEqual(["roam", "agent", "--v0"]);
      const request = JSON.parse(options.stdin!.toString()) as RelocateAgentRequest;
      const input = request.kind === "artifact" ? request.input as { action: string; operation: Operation } : null;
      const call: PeerCall = { machineId: peer.machineId, kind: request.kind === "data" ? request.operation.kind :
        input ? `artifact:${input.action}` : request.kind, operation: request.kind === "data" ? request.operation : input?.operation };
      calls.push(call); await onRequest(call);
      call.reply = await handleRelocateAgent(request, network.get(peer.machineId)!.options);
      return Buffer.from(JSON.stringify(onReply(call, call.reply)));
    },
    async read(peer, file) {
      calls.push({ machineId: peer.machineId, kind: "artifact:read" });
      expect(file.startsWith(join(peer.globalRoot, "roam", "staging") + "/")).toBe(true);
      return readFileSync(file);
    },
  };
  const saveConfig = (directory: string, value: RoamConfig) => {
    mkdirSync(join(directory, "roam"), { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "roam", "machine.json"), JSON.stringify({ machineId: value.machineId }), { mode: 0o600 });
    writeFileSync(join(directory, "roam", "config.json"), JSON.stringify(value), { mode: 0o600 });
  };
  const setBoxEnabled = (machine: string, enabled: boolean) => saveConfig(replicas.get(machine)!.root,
    { ...config, machineId: machine, role: "box", enabled, peers: [] });
  const staging = (machine: string) => {
    const path = join(replicas.get(machine)!.root, "roam", "staging");
    return existsSync(path) ? readdirSync(path, { recursive: true }).sort() : [];
  };
  let hub: Awaited<ReturnType<typeof startV0Hub>> | undefined;
  const close = async () => {
    try { await hub?.stop(); }
    finally {
      for (const runtime of network.values()) await runtime.close();
      for (const replica of replicas.values()) replica.close();
      rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs();
    }
  };
  function forget(machine: string) {
    const journalFile = join(root, "roam", "journal.db");
    openJournal(journalFile);
    const db = openDb(journalFile, { fileMustExist: true, checkpointOnClose: false });
    try { revokeMachine(db, machine); } finally { db.close(); }
  }
  try {
    saveConfig(root, config);
    for (const [machine, replica] of replicas) {
      replica.db.prepare("UPDATE roam_meta SET capture_enabled=1").run();
      if (machine === mac) continue;
      setBoxEnabled(machine, machine !== disabled);
      network.set(machine, createV0Runtime(replica.root, { openCore: () => ({ root: replica.root, db: replica.db,
        config: readLocalIdentity(replica.root), close() {} }), readConfig: readLocalIdentity, transport, clock }));
    }
    if (machines.includes(forgotten)) forget(forgotten);
    vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
    vi.stubEnv("HC_SOCKET", join(root, "hc.sock"));
    vi.stubEnv("HC_SESSION", "manual-sync");
    hub = await startV0Hub(root, { openCore: () => ({ root, db: local.db, config, close() {} }),
      readConfig: path => { onHubConfigRead(); return readLocalIdentity(path); }, transport, clock });
  } catch (error) { await close(); throw error; }
  return { root, close, forget, local, calls, resolved, setBoxEnabled, staging, unavailable, replicas,
    stopHub: () => hub!.stop(),
    marker(machine: string, id: string) { replicas.get(machine)!.db.prepare("INSERT INTO global_memory(uuid,category,content,created_at) VALUES (?,'insight',?,1)").run(id, id); },
    markers(machine: string) { return replicas.get(machine)!.db.prepare("SELECT uuid FROM global_memory ORDER BY uuid").all().map(row => (row as { uuid: string }).uuid); },
    onResolve(fn: typeof onResolve) { onResolve = fn; }, onRequest(fn: typeof onRequest) { onRequest = fn; },
    onReply(fn: typeof onReply) { onReply = fn; },
    onHubConfigRead(fn: typeof onHubConfigRead) { onHubConfigRead = fn; },
    tickScheduledSync() { for (const [run, delay] of [...scheduled]) if (delay === 0) { scheduled.delete(run); run(); } },
    async command(machine?: string) {
      const out: string[] = [], err: string[] = [];
      const code = await main(["roam", "sync", ...(machine === undefined ? [] : [machine]), "--json"],
        { out: line => out.push(line), err: line => err.push(line) });
      return { code, result: JSON.parse(out.join("")), err };
    },
  };
}

it.each(["box-0.invalid", box])("manual sync %s converges only the selected peer", async target => {
  const f = await manualSyncFixture();
  try {
    f.marker(mac, "on-mac"); f.marker(box, "on-box"); f.marker(other, "on-other");
    const result = await f.command(target);
    expect(result, result.result.reason).toMatchObject({ code: 0, err: [] });
    expect(f.markers(other)).toEqual(["on-other"]);
    expect(f.markers(mac)).toEqual(["on-box", "on-mac"]);
    expect(f.markers(box)).toEqual(["on-box", "on-mac"]);
    expect(result.result).toMatchObject({ reason: "Synchronization complete", value: { outcomes: [
      expect.objectContaining({ code: 0, reason: "pulled", value: { batchId: expect.any(String), stream: expect.any(String), through: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), applyMs: expect.any(Number) } }),
      expect.objectContaining({ code: 0, reason: "pushed", value: { batchId: expect.any(String), stream: expect.any(String), through: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), applyMs: expect.any(Number) } }),
    ] } });
    expect(f.calls.filter(call => call.machineId === other).map(call => call.kind)).toEqual(["stores"]);
  } finally { await f.close(); }
});

it("keeps a fractional real receipt with whole milliseconds in public sync output", async () => {
  const f = await manualSyncFixture([box]);
  let received: ApplyReceipt | undefined;
  try {
    f.marker(mac, "fractional-receipt");
    f.onReply((call, reply) => {
      if (call.kind !== "import" || !reply.ok) return reply;
      const wire = reply.value as { version: 1; outcome: { code: number; value: ApplyReceipt } };
      expect(wire.outcome.code).toBe(0);
      received = { ...wire.outcome.value, applyMs: 1.6 };
      return { ...reply, value: { ...wire, outcome: { ...wire.outcome, value: received } } };
    });
    const result = await f.command(box);
    expect(result.code).toBe(0);
    expect(received).toBeDefined();
    const row = { code: 0 as const, reason: "pushed", operationId: "", home: null, epoch: null, repairCommand: null, value: received! };
    const sanitized = safeControlOutcome({ code: 0, reason: "Synchronization complete", operationId: "", home: null,
      epoch: null, repairCommand: null, value: { outcomes: [row] } });
    const expected = { ...received!, applyMs: 2 };
    expect(sanitized.value).toMatchObject({ outcomes: [{ value: expected }] });
    expect(result.result.value.outcomes).toContainEqual(expect.objectContaining({ reason: "pushed", value: expected }));
    expect(f.markers(box)).toEqual(["fractional-receipt"]);
  } finally { await f.close(); }
});

it("manual sync without a selector converges every eligible peer", async () => {
  const f = await manualSyncFixture();
  try {
    f.marker(mac, "on-mac"); f.marker(box, "on-box"); f.marker(other, "on-other");
    expect(await f.command()).toMatchObject({ code: 0, result: { reason: "Synchronization complete" } });
    expect(f.markers(mac)).toEqual(["on-box", "on-mac", "on-other"]);
    expect(f.markers(box)).toEqual(expect.arrayContaining(["on-box", "on-mac"]));
    expect(f.markers(other)).toEqual(expect.arrayContaining(["on-other", "on-mac"]));
  } finally { await f.close(); }
});

it("manual sync returns the scheduled transfer's receipt without repeating its import", async () => {
  const f = await manualSyncFixture([box]);
  const importEntered = deferred(), finishImport = deferred();
  try {
    f.marker(mac, "one-import");
    f.onRequest(async call => { if (call.kind === "import") { importEntered.resolve(); await finishImport.promise; } });
    f.tickScheduledSync(); await importEntered.promise;
    const accepted = deferred();
    f.onHubConfigRead(() => accepted.resolve());
    const manual = f.command(box);
    const reachedHub = await Promise.race([accepted.promise.then(() => true), manual.then(() => false)]);
    finishImport.resolve();
    const result = await manual;
    expect(result, `request reached the running hub: ${reachedHub}`).toMatchObject({ code: 0 });
    expect(reachedHub).toBe(true);
    const imports = f.calls.filter(call => call.kind === "import");
    expect(imports).toHaveLength(1);
    expect(imports[0].reply).toMatchObject({ ok: true, value: { outcome: { code: 0, value: { batchId: expect.any(String) } } } });
    expect(result.result.value.outcomes).toEqual([expect.objectContaining({ reason: "pushed", operationId: imports[0].operation!.id,
      value: expect.objectContaining({ batchId: imports[0].operation!.args.artifactId, sha256: imports[0].operation!.args.sha256 }) })]);
    expect(f.markers(box)).toEqual(["one-import"]);
  } finally { finishImport.resolve(); await f.close(); }
});

it("hub shutdown drains an accepted manual sync without starting scheduled transfers", async () => {
  const f = await manualSyncFixture();
  const importEntered = deferred(), finishImport = deferred();
  try {
    f.marker(mac, "on-mac");
    f.onRequest(async call => { if (call.machineId === box && call.kind === "import") { importEntered.resolve(); await finishImport.promise; } });
    const manual = f.command(box);
    expect(await Promise.race([importEntered.promise.then(() => true), manual.then(() => false)])).toBe(true);
    let stopped = false;
    const stopping = f.stopHub().then(() => { stopped = true; });
    await new Promise<void>(done => setImmediate(done));
    expect(stopped).toBe(false);
    f.tickScheduledSync();
    finishImport.resolve();
    expect(await manual).toMatchObject({ code: 0 });
    await stopping;
    expect(f.markers(box)).toEqual(["on-mac"]);
    expect(f.markers(other)).toEqual([]);
    expect(f.calls.filter(call => call.machineId === other).map(call => call.kind)).toEqual(["stores"]);
  } finally { finishImport.resolve(); await f.close(); }
});

it("all-peers sync reports a disabled box and excludes a forgotten box without stopping healthy peers", async () => {
  const f = await manualSyncFixture([box, other, disabled, forgotten]);
  try {
    f.marker(mac, "on-mac"); f.marker(box, "on-box"); f.marker(other, "on-other");
    f.marker(disabled, "on-disabled"); f.marker(forgotten, "on-forgotten");
    writeLocal(f.local.db, "observed-origin", "unassigned", { id: "unassigned", origin: mac });
    expect(await f.command()).toMatchObject({ code: 1, result: { reason: "Synchronization needs attention", value: { outcomes:
      expect.arrayContaining([expect.objectContaining({ code: 1, reason: "roaming-disabled", operationKind: "stores" })]),
    } } });
    expect(f.markers(mac)).toEqual(["on-box", "on-mac", "on-other"]);
    expect(f.markers(box)).toContain("on-mac"); expect(f.markers(other)).toContain("on-mac");
    expect(f.markers(disabled)).toEqual(["on-disabled"]); expect(f.staging(disabled)).toEqual([]);
    expect(f.local.db.prepare("SELECT machine_id FROM session_homes WHERE session_id='unassigned'").get()).toBeUndefined();
    expect(f.calls.filter(call => call.machineId === disabled).map(call => call.kind)).toEqual(["stores"]);
    expect(f.resolved).not.toContain(forgotten); expect(f.calls.map(call => call.machineId)).not.toContain(forgotten);
    expect(f.markers(forgotten)).toEqual(["on-forgotten"]); expect(f.staging(forgotten)).toEqual([]);
  } finally { await f.close(); }
});

it("a targeted disabled box refuses without replication or a fallback to other peers", async () => {
  const f = await manualSyncFixture([box, disabled]);
  try {
    f.marker(mac, "on-mac");
    expect(await f.command(disabled)).toMatchObject({ code: 1, result: { value: { outcomes: [expect.objectContaining({ code: 1, reason: "roaming-disabled" })] } } });
    expect(f.calls.map(call => call.kind)).toEqual(["stores", "stores"]);
    expect(f.markers(box)).toEqual([]); expect(f.markers(disabled)).toEqual([]); expect(f.staging(disabled)).toEqual([]);
  } finally { await f.close(); }
});

it("targeting a forgotten ID refuses before dispatch, while an empty eligible set succeeds", async () => {
  const f = await manualSyncFixture([forgotten]);
  try {
    const configRead = vi.fn(); f.onHubConfigRead(configRead);
    expect(await f.command(forgotten)).toMatchObject({ code: 1, result: { reason: "machine-revoked" } });
    expect(configRead).not.toHaveBeenCalled();
    expect(await requestV0Services(f.root).sync({ machineId: forgotten })).toMatchObject({ code: 1, reason: "machine-revoked" });
    expect(await f.command()).toMatchObject({ code: 0, result: { reason: "Synchronization complete", value: { outcomes: [] } } });
    expect(f.resolved).toEqual([]); expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

it("a box that disables after discovery refuses a capture request before changing the store", async () => {
  const f = await manualSyncFixture([box]);
  try {
    const db = f.replicas.get(box)!.db;
    db.prepare("UPDATE roam_meta SET capture_enabled=0").run();
    f.marker(mac, "never-imported");
    f.onRequest(call => { if (call.kind === "enable-capture") f.setBoxEnabled(box, false); });
    const result = await f.command(box);
    expect(result).toMatchObject({ code: 1, result: { value: { outcomes: [expect.objectContaining({ code: 1, reason: "roaming-disabled" })] } } });
    const refused = f.calls.find(call => call.kind === "enable-capture")!;
    expect(refused.reply).toMatchObject({ ok: true, value: { version: 1, outcome: { code: 1, reason: "roaming-disabled", operationId: refused.operation!.id } } });
    expect(db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
    expect(f.markers(box)).toEqual([]); expect(f.staging(box)).toEqual([]);
    expect(f.calls.map(call => call.kind)).toEqual(["stores", "inventory", "enable-capture"]);
  } finally { await f.close(); }
});

it("a box that disables before a chunk write refuses it without staging more bytes", async () => {
  const f = await manualSyncFixture([box]);
  try {
    f.marker(mac, "never-imported");
    let staged: ReturnType<typeof f.staging> | undefined;
    f.onRequest(call => { if (call.kind === "artifact:chunk") { staged = f.staging(box); f.setBoxEnabled(box, false); } });
    const result = await f.command(box);
    expect(result).toMatchObject({ code: 1, result: { value: { outcomes: [expect.objectContaining({ code: 1, reason: "roaming-disabled" })] } } });
    expect(f.calls.find(call => call.kind === "artifact:chunk")?.reply).toMatchObject({ ok: true, value: { version: 1, wire: { code: 1, reason: "roaming-disabled" } } });
    expect(staged?.length).toBeGreaterThan(0);
    expect(f.staging(box)).toEqual(staged);
    expect(f.markers(box)).toEqual([]);
    expect(f.calls.map(call => call.kind)).not.toContain("import");
  } finally { await f.close(); }
});

it("manual sync makes no RPC to a peer forgotten during resolve", async () => {
  const f = await manualSyncFixture();
  try {
    f.marker(mac, "on-mac");
    f.onResolve(machine => { if (machine === box) f.forget(box); });
    const result = await f.command(box);
    expect(result.code).not.toBe(0);
    expect(result.result.reason).toBe("Synchronization needs attention");
    expect(f.resolved).toContain(box);
    expect(f.calls.map(call => [call.machineId, call.kind])).toEqual([[other, "stores"]]);
    expect(f.markers(box)).toEqual([]); expect(f.markers(other)).toEqual([]);
  } finally { await f.close(); }
});

it.each([
  { peers: [box, other], codes: [0, 2], expected: 2 },
  { peers: [box, other, disabled], codes: [0, 1, 2], expected: 1 },
  { peers: [box, other, disabled, uncertain], codes: [0, 1, 2, 3], expected: 3 },
])("manual sync reports $expected for mixed per-peer outcomes $codes", async ({ peers, codes, expected }) => {
  const f = await manualSyncFixture(peers);
  try {
    f.marker(mac, "on-mac");
    f.onReply((call, reply) => {
      if (call.machineId === other && call.kind === "stores") return { ok: true, value: { version: 1, outcome: {
        code: 2, reason: "invalid-arguments", operationId: call.operation!.id, value: null, home: null, epoch: null, repairCommand: null,
      } } };
      if (call.machineId === uncertain && call.kind === "import") throw new Error("Lost the import reply after apply");
      return reply;
    });
    const result = await f.command();
    expect(result).toMatchObject({ code: expected, result: { reason: "Synchronization needs attention" } });
    expect([...new Set(result.result.value.outcomes.map((row: { code: number }) => row.code))].sort()).toEqual(codes);
    expect(f.markers(box)).toEqual(["on-mac"]);
    if (peers.includes(uncertain)) {
      expect(f.markers(uncertain)).toEqual(["on-mac"]);
      expect(result.result.value.outcomes).toContainEqual(expect.objectContaining({ code: 3, reason: "Peer operation is pending reconciliation", value: null }));
    }
  } finally { await f.close(); }
});

it("an unreachable peer is not a successful sync and its inventory cannot authorize a first home", async () => {
  const f = await manualSyncFixture();
  try {
    f.unavailable.add(other);
    f.marker(mac, "on-mac"); f.marker(box, "on-box");
    writeLocal(f.local.db, "observed-origin", "unassigned", { id: "unassigned", origin: mac });
    const result = await f.command();
    expect(result).toMatchObject({ code: 3, result: { value: { outcomes: expect.arrayContaining([
      expect.objectContaining({ code: 3, reason: "Peer operation is pending reconciliation" }),
    ]) } } });
    expect(f.markers(box)).toEqual(["on-box", "on-mac"]);
    const firstHome = f.local.db.prepare("SELECT machine_id, epoch, move_id, state, destination FROM session_homes WHERE session_id='unassigned'");
    expect(firstHome.get()).toBeUndefined();
    f.unavailable.delete(other);
    expect(await f.command()).toMatchObject({ code: 0 });
    expect(firstHome.get()).toEqual({ machine_id: mac, epoch: 1, move_id: null, state: null, destination: null });
  } finally { await f.close(); }
});

function fixture() {
  const replica = createReplica("global", mac);
  const journalFile = join(replica.root, "roam", "journal.db");
  openJournal(journalFile);
  const config: RoamConfig = {
    enabled: true, role: "hub", machineId: mac, hubMachineId: mac,
    peers: [box, other].map((machineId, i) => ({ machineId, alias: `box-${i}.invalid`, node: "/node", pi: "/pi", cli: "/spider", core: "/core", globalRoot: "/root" })),
    discoveryRoots: [], coreUnit: "core", syncMs: 10_000, limits: DEFAULT_LIMITS, intercom: disabledIntercom(),
  };
  const scheduled = new Map<() => void, number>();
  const clock: Clock = { now: () => 100, later(ms, fn) { scheduled.set(fn, ms); return () => { scheduled.delete(fn); }; } };
  const resolved: string[] = [], requests: string[] = [];
  let duringResolve = () => {};
  const unused = async () => { throw new Error("Transport method is unused"); };
  const transport: Transport = {
    async resolve(peer) {
      resolved.push(peer.machineId);
      if (peer.machineId === box) duringResolve();
      return peer;
    },
    async exec(peer) { requests.push(peer.machineId); throw new Error("End synthetic discovery"); },
    bootstrapProbe: unused, run: unused, read: unused, write: unused,
  };
  function forget() {
    const db = openDb(journalFile, { fileMustExist: true, checkpointOnClose: false });
    try { revokeMachine(db, box); } finally { db.close(); }
  }
  const overrides = {
    openCore: () => ({ root: replica.root, config: { ...config }, db: replica.db, close() {} }), transport, clock,
    readConfig: () => ({ ...config }),
  };
  const start = () => createV0Runtime(replica.root, overrides);
  return { forget, start, resolved, requests, scheduled, replica, config, overrides, journalFile, onResolve(fn: () => void) { duringResolve = fn; } };
}

it("schedules synchronization only for enrolled peers that were not forgotten", async () => {
  const f = fixture(); f.forget();
  const runtime = f.start();
  try {
    runtime.sync.start();
    const ticks = [...f.scheduled.keys()];
    for (const tick of ticks) { f.scheduled.delete(tick); tick(); }
    await runtime.sync.drain();
    expect(ticks).toHaveLength(1);
    expect(f.requests).toEqual([other]);
  } finally { await runtime.close(); f.replica.close(); }
});

it("scheduled replication follows configuration changes without a hub restart", async () => {
  const f = fixture();
  f.config.enabled = false;
  const root = mkdtempSync(join(resolve(".spider/scratch"), "pv-"));
  const hub = await startV0Hub(root, f.overrides);
  const tick = (predicate: (delay: number) => boolean) => {
    for (const [fn, delay] of [...f.scheduled]) if (predicate(delay)) { f.scheduled.delete(fn); fn(); }
  };
  try {
    expect(f.requests).toEqual([]);
    f.config.enabled = true;
    tick(ms => ms > 0); tick(ms => ms === 0);
    await new Promise<void>(done => setImmediate(done));
    expect(f.requests).toEqual(expect.arrayContaining([box, other]));
    const previous = f.requests.length;
    f.config.enabled = false;
    tick(ms => ms > 0); tick(ms => ms === 0);
    await new Promise<void>(done => setImmediate(done));
    expect(f.requests).toHaveLength(previous);
    expect([...f.scheduled.values()]).toEqual([1_000]);
  } finally { await hub.stop(); f.replica.close(); rmSync(root,{recursive:true,force:true}); }
});

it("does not send peer RPCs if the peer is forgotten during discovery", async () => {
  const f = fixture();
  const runtime = f.start();
  f.onResolve(f.forget);
  try {
    await runtime.sync.sync(box);
    expect(f.resolved).toContain(box);
    expect(f.requests).toEqual([other]);
  } finally { await runtime.close(); f.replica.close(); }
});

it.each([true, false])("forget records a revocation without a legacy hub (enabled=%s)", async enabled => {
  const f = fixture();
  f.config.enabled = enabled;
  writeFileSync(join(f.replica.root, "roam", "machine.json"), JSON.stringify({ machineId: mac }), { mode: 0o600 });
  writeFileSync(join(f.replica.root, "roam", "config.json"), JSON.stringify(f.config), { mode: 0o600 });
  vi.stubEnv("SPIDER_GLOBAL_ROOT", f.replica.root);
  const runtime = f.start();
  try {
    const before = await runtime.homes.initialize(sessionId, box);
    const out = vi.fn(), err = vi.fn();
    expect(await main(["roam", "forget", "box-0.invalid", "--confirm", "destroyed box-0.invalid", "--json"], { out, err })).toBe(0);
    expect(JSON.parse(out.mock.calls.flat().join(""))).toMatchObject({ code: 0, reason: "machine-forgotten" });
    const db = openDb(f.journalFile, { fileMustExist: true, checkpointOnClose: false });
    try { expect(isRevoked(db, box)).toBe(true); } finally { db.close(); }
    expect(await runtime.homes.read(sessionId)).toEqual(before);
    expect(await runtime.services.relocate({ sessionId, destinationMachine: box })).toMatchObject({ ok: false, refusal: { code: "machine-revoked" } });
    expect(f.requests).toEqual([]);
  } finally { await runtime.close(); f.replica.close(); vi.unstubAllEnvs(); }
});

it("refuses a forgotten destination at the CLI before asking for confirmation", async () => {
  const f=fixture();f.forget();
  writeFileSync(join(f.replica.root,"roam","machine.json"),JSON.stringify({machineId:mac}),{mode:0o600});
  writeFileSync(join(f.replica.root,"roam","config.json"),JSON.stringify(f.config),{mode:0o600});
  vi.stubEnv("SPIDER_GLOBAL_ROOT",f.replica.root);
  const out=vi.fn(), err=vi.fn(), confirmation=vi.fn(async()=>null);
  const mutate=vi.fn(async()=>{throw new Error("the CLI must not contact the hub");});
  try {
    const v0={catalog:[{id:sessionId,name:null}],confirmation,services:{relocate:mutate,setHome:mutate}};
    const exit=await main(["roam","set-home",sessionId,"box-0.invalid","--force","--json"],{out,err},{v0});
    expect(exit).toBe(1);
    expect(JSON.parse(out.mock.calls.flat().join(""))).toMatchObject({ok:false,refusal:{code:"machine-revoked"}});
    expect(confirmation).not.toHaveBeenCalled();expect(mutate).not.toHaveBeenCalled();
  } finally {f.replica.close();vi.unstubAllEnvs();}
});

it("cannot enter moving after hub disable has finished checking the homes", async () => {
  const f = fixture(), runtime = f.start();
  try {
    const before = await runtime.homes.initialize(sessionId, mac);
    f.config.enabled = false;
    await expect(runtime.homes.compareAndSwap(before, { ...before, state: "moving", destination: box,
      epoch: 2, moveId: "v0-33333333-3333-4333-8333-333333333333" as RelocateId })).rejects.toThrow(/disabled/);
    expect(await runtime.homes.read(sessionId)).toEqual(before);
  } finally { await runtime.close(); f.replica.close(); }
});

it("rejects relocate and forced set-home to a forgotten peer without contacting it", async () => {
  const f = fixture();
  const runtime = f.start(); f.forget();
  try {
    const destinationMachine = box;
    const before = await runtime.homes.initialize(sessionId, mac);
    const refused = { ok: false, refusal: { code: "machine-revoked", nextStep: expect.stringMatching(/choose another/i) } };
    const moved = await runtime.services.relocate({ sessionId, destinationMachine });
    const reassigned = await runtime.services.setHome({ sessionId, destinationMachine, force: true, confirmation: `reassign ${sessionId} to ${box}; source will not run` });
    expect([moved, reassigned]).toMatchObject([refused, refused]);
    expect(await runtime.homes.read(sessionId)).toEqual(before);
    expect(f.resolved).toEqual([]);
    expect(f.requests).toEqual([]);
  } finally { await runtime.close(); f.replica.close(); }
});
