import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createReplica } from "@spider/db-core/testutil";
import { openFreezeJournal } from "@spider/roam/journal";
import { freezeParticipant, type FreezePorts } from "../freeze.js";
import type { AdmissionGate } from "../admission.js";
import type { Operation } from "@spider/roam/contracts";
import { join, resolve } from "node:path";
import { createIntercomBridge } from "@spider/roam/intercom-bridge";
import { openIntercomStore } from "@spider/roam/intercom-store";
import { IntercomClient, IntercomFederationClient } from "@spider/intercom/broker/client";
import { FEDERATION_FEATURE, MOVE_FENCE_FEATURE, type FederationBlockers, type SessionEndpoint } from "@spider/intercom/protocol";
import { authorizeTestBridge, startTestBroker, stopTestBroker } from "../../../../intercom/src/test-support.js";
import { getAgentDirPath } from "../../../../intercom/src/broker/paths.js";
import { createIntercomMovePorts } from "../intercom.js";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const address = { sessionId: "recipient", scopeId: null }, senderAddress = { sessionId: "sender", scopeId: null };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); } finally { vi.unstubAllEnvs(); } });
async function fixture(realBroker = false, enabled = true, localSocket = false, withPeer = false) {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "h-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const clock = { now: () => 1000, later: () => () => {} };
  const store = openIntercomStore({ file: join(root, "queue.db"), machineId: A, clock }); cleanups.push(() => store.close());
  let endpoint: SessionEndpoint = { address, machineId: A, homeEpoch: 2, activationEpoch: "old" };
  let home = { sessionId: "recipient", machineId: A, epoch: 2, moveId: null as string | null, updatedAt: 1000 };
  let admitted = true, owned = true, evidenceError = false, warningError = false, admissionError = false;
  let brokerSnapshot: FederationBlockers = { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] };
  const incoming: string[] = [];
  const bridge = createIntercomBridge({ machineId: A, machineAlias: "source.invalid", edges: withPeer ? [{ peer: { machineId: B, alias: "box-2.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/root" }, edgeEpoch: "destination-edge", initiator: false }] : [], clock, store, moveFences: enabled,
    transport: {} as never, localPresence: () => [], authoritativeHome: () => home, onInbound: message => incoming.push(message.id) });
  cleanups.push(() => bridge.stop()); await bridge.start();
  let broker: Pick<IntercomFederationClient, "intake" | "inspectFreezeBlockers"> = {
    intake: async (action, fence) => bridge.intake!(action, fence),
    inspectFreezeBlockers: async () => brokerSnapshot,
  };
  let restartBroker: () => Promise<void> = async () => { throw new Error("This fixture has no broker"); };
  let client: IntercomClient | undefined, recipient: IntercomClient | undefined, connection: IntercomFederationClient | undefined;
  const socketMessages: string[] = [];
  if (realBroker) {
    const agent = join(root, "a"); mkdirSync(agent);
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    const start = async () => {
      const child = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], { env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] }, "suite");
      cleanups.push(() => stopTestBroker(child));
      await new Promise<void>((resolveStarted, reject) => {
        const timer = setTimeout(() => reject(new Error("fixture broker startup timed out")), 4000);
        child.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture broker exit ${code}`)); });
        child.stdout!.on("data", bytes => { if (String(bytes).includes("Intercom broker started")) { clearTimeout(timer); resolveStarted(); } });
      });
      return child;
    };
    const child = await start();
    connection = new IntercomFederationClient(); cleanups.push(() => connection!.close());
    await connection.connect({ feature: FEDERATION_FEATURE, agentDir: getAgentDirPath(), credential: authorizeTestBridge(getAgentDirPath(), A), machineId: A, machineAlias: "source.invalid", ...(enabled ? { moveFences: true as const } : {}) }, bridge);
    broker = connection;
    client = new IntercomClient(); recipient = new IntercomClient();
    cleanups.push(() => client!.disconnect()); cleanups.push(() => recipient!.disconnect());
    await client.connect({ address: senderAddress, cwd: root, model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1, activationEpoch: "sender-activation" }, "sender");
    await recipient.connect({ address, cwd: root, model: "fixture", pid: process.pid, name: "helper", startedAt: 1, lastActivity: 1, activationEpoch: "old", ...(localSocket ? {} : { homeEpoch: 2 }) }, "recipient");
    recipient.on("message", event => socketMessages.push(event.id));
    restartBroker = async () => {
      await client!.disconnect(); await recipient!.disconnect(); await connection!.close(); await stopTestBroker(child);
      await start();
      await connection!.connect({ feature: FEDERATION_FEATURE, agentDir: agent, credential: authorizeTestBridge(agent, A), machineId: A, machineAlias: "source.invalid", moveFences: true }, bridge);
    };
  }
  const journal = openFreezeJournal(join(root, "move-journal.db"));
  const input: import("@spider/roam/intercom-move").IntercomMoveInput = { journal, broker, bridge, endpoint: () => endpoint, home: async () => { if (evidenceError) throw new Error("Unavailable home"); return home; },
    owns: async () => owned,
    admitted: current => { if (admissionError) throw new Error("Admission unavailable"); return admitted && current.activationEpoch === endpoint.activationEpoch && current.homeEpoch === home.epoch && current.machineId === home.machineId; },
    presence: current => ({ ...current, remote: true, id: "recipient", endpointEpoch: current.activationEpoch, machineAlias: current.machineId === A ? "source.invalid" : "box-2.invalid", name: "helper", cwd: root, model: "fixture", startedAt: 1, lastActivity: 1 }),
    warnings: () => { if (warningError) throw new Error("Warnings unavailable"); return ["Route to box-9.invalid is unavailable."]; } };
  const ports = createIntercomMovePorts(input);
  const send = (id: string, ask = false) => bridge.dispatch({ from: senderAddress, to: { ...endpoint, remote: true, id: "recipient", endpointEpoch: endpoint.activationEpoch, machineAlias: "source.invalid", name: "helper", cwd: root, model: "fixture", startedAt: 1, lastActivity: 1 },
    message: { id, timestamp: 1000, content: { text: "synthetic" }, ...(ask ? { expectsReply: true, remainingMs: 2000 } : {}) } });
  return { ports, recreate: () => createIntercomMovePorts(input), bridge, store, incoming, send, client, recipient, connection, socketMessages, restartBroker,
    setHome: (epoch: number, machineId = B) => { home = { ...home, epoch, machineId, moveId: "move-1" }; },
    setEndpoint: (current: SessionEndpoint) => { endpoint = current; }, setAdmitted: (value: boolean) => { admitted = value; }, setOwned: (value: boolean) => { owned = value; }, setHomeError: (value: boolean) => { evidenceError = value; }, setWarningError: (value: boolean) => { warningError = value; }, setAdmissionError: (value: boolean) => { admissionError = value; }, setBrokerSnapshot: (value: FederationBlockers) => { brokerSnapshot = value; } };
}
it("inbound and outbound asks block without cancellation", async () => {
  const f = await fixture(); await f.send("inbound-ask", true);
  f.store.acceptOutbound({ from: address, endpoint: { address: senderAddress, machineId: B, homeEpoch: 2, activationEpoch: "sender" }, nextHop: B,
    message: { id: "outbound-ask", timestamp: 1000, expectsReply: true, remainingMs: 2000, content: { text: "synthetic" } } });
  const closure = await f.ports.close(address, "move-1", 2); await f.ports.drain(closure);
  const observed = await f.ports.inspect(closure);
  expect(observed.blockers).toContainEqual(expect.objectContaining({ kind: "intercom-ask-inbound", id: "inbound-ask" }));
  expect(observed.blockers).toContainEqual(expect.objectContaining({ kind: "intercom-ask-outbound", id: "outbound-ask" }));
  expect(observed.cancelledWork).toEqual([]);
  expect(f.store.retained("inbound", "inbound-ask")).toMatchObject({ state: "queued", payloadRetained: true });
  expect(f.store.retained("outbound", "outbound-ask")).toMatchObject({ state: "queued", payloadRetained: true });
}, 5000);
it("unknown and unobserved receipts return exact ids", async () => {
  const f = await fixture(); await f.send("unknown-id");
  f.store.beginDispatch({ id: "unknown-id", endpoint: { address, machineId: A, homeEpoch: 2, activationEpoch: "old" }, readiness: "ready" });
  const closure = await f.ports.close(address, "move-1", 2);
  const observed = await f.ports.inspect(closure);
  expect(observed.blockers).toContainEqual(expect.objectContaining({ kind: "intercom-unknown", id: "unknown-id" }));
  expect(observed.blockers).toContainEqual(expect.objectContaining({ kind: "intercom-receipt", id: "unknown-id" }));
  expect(observed.cancelledWork).toEqual([]);
  expect(observed.warnings).toEqual(["Route to box-9.invalid is unavailable."]);
}, 5000);
it("incoming ask cannot race final freeze", async () => {
  const f = await fixture(true, true, true);
  expect(f.connection!.supportsFeature(MOVE_FENCE_FEATURE)).toBe(true);
  const send = f.client!.send("recipient", { messageId: "socket-race", text: "synthetic", expectsReply: true, remainingMs: 2000 });
  const closing = f.ports.close(address, "move-1", 2);
  const [result, closure] = await Promise.all([send, closing]); await f.ports.drain(closure);
  const observed = await f.ports.inspect(closure);
  if (result.delivered) expect(observed.blockers.some(blocker => blocker.id === "socket-race")).toBe(true);
  else expect(result.reason).toBe("intercom-frozen");
  expect(f.socketMessages).toEqual(result.delivered ? ["socket-race"] : []);
  const after = await f.client!.send("recipient", { messageId: "after-close", text: "synthetic", expectsReply: true, remainingMs: 2000 });
  expect(after).toMatchObject({ delivered: false, reason: "intercom-frozen" });
  expect(f.socketMessages).toEqual(result.delivered ? ["socket-race"] : []);
}, 5000);
it("abort and committed readiness honor closure generation", async () => {
  const f = await fixture(false, true, false, true); const closure = await f.ports.close(address, "move-1", 2);
  await expect(f.ports.abort({ ...closure, generation: "stale" })).rejects.toThrow();
  await expect(f.ports.ready(closure, { address, machineId: B, homeEpoch: 3, activationEpoch: "next" })).rejects.toThrow();
  await f.send("move-queued");
  f.setHome(3); f.setEndpoint({ address, machineId: B, homeEpoch: 3, activationEpoch: "next" }); f.setAdmitted(false);
  await expect(f.ports.ready(closure, { address, machineId: B, homeEpoch: 3, activationEpoch: "next" })).rejects.toThrow();
  await expect(f.ports.abort(closure)).rejects.toThrow();
  f.setAdmitted(true);
  const ready = await f.ports.ready(closure, { address, machineId: B, homeEpoch: 3, activationEpoch: "next" });
  expect(ready).toEqual({ intercomAddress: "box-2.invalid/helper", warnings: ["Route to box-9.invalid is unavailable."] });
  expect(ready).not.toHaveProperty("lostPeers");
  expect(f.store.retained("outbound", "move-queued")).toMatchObject({ identity: { id: "move-queued", to: address }, endpoint: { machineId: B, homeEpoch: 3, activationEpoch: "next" }, payloadRetained: true });
}, 5000);
it("old brokers and disabled roaming refuse moves with a named blocker", async () => {
  const f = await fixture(true, false);
  expect(f.connection!.supportsFeature(MOVE_FENCE_FEATURE)).toBe(false);
  await expect(f.ports.close(address, "move-1", 2)).rejects.toMatchObject({ blockers: [{ kind: "intercom-fence-unsupported", id: "recipient", detail: expect.any(String) }] });
}, 5000);

async function freezeFixture() {
  const f = await fixture(), replica = createReplica("worktree", A); cleanups.push(() => replica.close());
  replica.db.prepare("UPDATE roam_meta SET store_key='worktree:fixture:workspace',capture_enabled=1 WHERE id=1").run();
  replica.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('recipient',2,'active')").run();
  const file = join(replica.root, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "recipient", cwd: replica.root }) + "\n" +
    JSON.stringify({ type: "message", id: "leaf", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "synthetic", timestamp: 1 } }) + "\n");
  const journal = openFreezeJournal(join(replica.root, "roam", "journal.db"));
  let closed = false;
  const home = { sessionId: "recipient", machineId: A, epoch: 2, moveId: null, updatedAt: 1000 };
  const gate: AdmissionGate = { inspect: () => ({ kind: closed ? "control-only" : "ordinary", home, blockers: [] }),
    async freeze() { closed = true; }, async unfreeze() { closed = false; }, async close() { closed = true; },
    async refreshInitialHome() { return this.inspect(); }, async whenSettled() { return this.inspect(); } };
  const ports: FreezePorts = { gate, journal, stores: [replica.db], expectedStores: ["worktree:fixture:workspace"],
    intercom: { address, ports: f.ports }, drain: async () => {}, resume: async () => {}, ingestThrough: async () => {},
    inspect: async () => ({ file, cwd: replica.root, leaf: "leaf", owner: null, blockers: [] }),
    authorizeAbort: async () => ({ home, cancelledMoveId: "move-1" }), onHubRestored: () => () => {} };
  const operation: Operation = { id: "freeze-1", kind: "session-freeze", machineId: A, expectedEpoch: 2, args: { sessionId: "recipient", moveId: "move-1" } };
  return { ...f, ports, operation, journal };
}
it("freeze acknowledgement includes and rechecks the atomic closure generation", async () => {
  const f = await freezeFixture();
  f.ports.ingestThrough = async () => {
    expect(await f.send("final-race", true)).toMatchObject({ delivery: "failed", reason: "intercom-frozen" });
    await f.send("queued-during-freeze");
  };
  const ack = await freezeParticipant(f.operation, f.ports);
  expect(ack.intercomGeneration).toEqual(expect.any(String));
  expect(ack.intercomGeneration.length).toBeGreaterThan(0);
  expect(f.incoming).toEqual([]);
  expect(f.store.retained("inbound", "queued-during-freeze")).toMatchObject({ payloadRetained: true });
  const closure = { address, moveId: "move-1", expectedEpoch: 2, generation: ack.intercomGeneration };
  await f.bridge.intake!("open", closure);
  await expect(freezeParticipant(f.operation, f.ports)).rejects.toThrow();
}, 5000);
it("a changed final generation prevents acknowledgement", async () => {
  const f = await freezeFixture();
  f.ports.ingestThrough = async () => {
    const closure = await f.ports.intercom!.ports.close(address, "move-1", 2);
    await f.bridge.intake!("open", closure);
  };
  await expect(freezeParticipant(f.operation, f.ports)).rejects.toThrow();
  expect(f.journal.read(f.operation.id).some(row => row.action === "done")).toBe(false);
}, 5000);
it("intercom fencing retains pipeline and job blockers", async () => {
  const f = await freezeFixture();
  f.ports.inspect = async () => ({ file: "unused", cwd: "/fixture", leaf: "unused", owner: null, blockers: [
    { kind: "pipeline", id: "pipeline-7", detail: "Pipeline has a pending stage." },
    { kind: "remote-job", id: "job-9", detail: "A remote job is still active." },
  ] });
  await expect(freezeParticipant(f.operation, f.ports)).rejects.toMatchObject({ blockers: [
    { kind: "pipeline", id: "pipeline-7", detail: "Pipeline has a pending stage." },
    { kind: "remote-job", id: "job-9", detail: "A remote job is still active." },
  ] });
  expect(f.ports.gate.inspect().kind).toBe("control-only");
}, 5000);
it("missing intake ports fail closed instead of freezing unfenced", async () => {
  const f = await freezeFixture(); delete f.ports.intercom;
  await expect(freezeParticipant(f.operation, f.ports)).rejects.toMatchObject({ blockers: [expect.objectContaining({ kind: "intercom-fence-unsupported", id: "recipient" })] });
  expect(f.ports.gate.inspect().kind).toBe("control-only");
}, 5000);

it("ordinary local socket mail is retained behind the joint fence", async () => {
  const f = await fixture(true), closure = await f.ports.close(address, "move-1", 2);
  expect(await f.client!.send("recipient", { messageId: "socket-queued", text: "synthetic" })).toMatchObject({ delivered: true, delivery: "queued" });
  expect(f.socketMessages).toEqual([]);
  expect(f.store.retained("inbound", "socket-queued")).toMatchObject({ payloadRetained: true, state: "queued" });
  expect((await f.ports.inspect(closure)).blockers).toEqual([]);
}, 5000);
it("dormant closure requires positive ownership and never reopens an unowned activation", async () => {
  const f = await fixture(); f.setAdmitted(false); f.setOwned(false);
  await expect(f.ports.close(address, "move-1", 2)).rejects.toMatchObject({ blockers: [expect.objectContaining({ kind: "intercom-owner-unknown", id: "recipient" })] });
  f.setOwned(true); const closure = await f.ports.close(address, "move-1", 2);
  f.setOwned(false); await expect(f.ports.abort(closure)).rejects.toThrow();
  await f.send("dormant-mail"); expect(f.incoming).toEqual([]);
}, 5000);
it("later moves get a new generation and stale reopen cannot affect them", async () => {
  const f = await fixture(), old = await f.ports.close(address, "move-1", 2);
  await f.ports.abort(old);
  const next = await f.ports.close(address, "move-2", 2);
  expect(next.generation).not.toBe(old.generation);
  await expect(f.ports.abort(old)).rejects.toThrow();
  await f.send("next-move-mail"); expect(f.incoming).toEqual([]);
}, 5000);

it("the final inspection cannot hide a generation change while awaiting evidence", async () => {
  const f = await freezeFixture(), intercom = f.ports.intercom!.ports, inspect = intercom.inspect;
  let count = 0;
  intercom.inspect = async closure => {
    const result = await inspect(closure);
    if (++count === 2) await f.bridge.intake!("open", closure);
    return result;
  };
  await expect(freezeParticipant(f.operation, f.ports)).rejects.toThrow();
  expect(f.journal.read(f.operation.id).some(row => row.action === "done")).toBe(false);
}, 5000);

it("broker restart is not evidence of a surviving closure generation", async () => {
  const f = await fixture(true), closure = await f.ports.close(address, "move-1", 2);
  await f.restartBroker();
  await expect(f.ports.checkGeneration(closure)).rejects.toMatchObject({ blockers: [expect.objectContaining({ kind: "intercom-generation-changed", id: "recipient" })] });
  expect((await f.ports.inspect(closure)).blockers).toContainEqual(expect.objectContaining({ kind: "intercom-generation-changed", id: "recipient" }));
}, 5000);
it("broker rejects a stale generation even if the bridge echoes it", async () => {
  const f = await fixture(true, true, true), closure = await f.ports.close(address, "move-1", 2);
  await f.connection!.close();
  await f.connection!.connect({ feature: FEDERATION_FEATURE, agentDir: getAgentDirPath(), credential: authorizeTestBridge(getAgentDirPath(), A), machineId: A, machineAlias: "source.invalid", moveFences: true },
    { ...f.bridge, intake: (_action, requested) => requested.generation });
  expect(await f.connection!.intake("open", { ...closure, generation: "stale" })).toBeNull();
  expect(await f.connection!.intake("open", { ...closure, expectedEpoch: 1 })).toBeNull();
  expect(await f.connection!.intake("open", { ...closure, moveId: "other" })).toBeNull();
  expect(await f.client!.send("recipient", { messageId: "still-fenced", text: "synthetic", expectsReply: true, remainingMs: 2000 })).toMatchObject({ delivered: false, reason: "intercom-frozen" });
  expect(f.socketMessages).toEqual([]);
}, 5000);

it("unavailable home evidence refuses with the exact session id", async () => {
  const f = await fixture(); f.setHomeError(true);
  await expect(f.ports.close(address, "move-1", 2)).rejects.toMatchObject({ blockers: [expect.objectContaining({ kind: "intercom-owner-unknown", id: "recipient" })] });
}, 5000);
it("bridge read failure retains known broker blocker ids", async () => {
  const f = await fixture(), closure = await f.ports.close(address, "move-1", 2);
  f.setBrokerSnapshot({ asks: [], pendingDispatch: [], unknownOutcomes: ["broker-known"], unobservedReceipts: [] });
  f.store.close();
  const observed = await f.ports.inspect(closure);
  expect(observed.blockers).toContainEqual(expect.objectContaining({ kind: "intercom-unknown", id: "broker-known" }));
  expect(observed.blockers).toContainEqual(expect.objectContaining({ kind: "blocker-source-unavailable", id: "bridge" }));
}, 5000);

it("warning read failure retains known blockers rather than losing their ids", async () => {
  const f = await fixture(), closure = await f.ports.close(address, "move-1", 2);
  f.setBrokerSnapshot({ asks: [], pendingDispatch: [], unknownOutcomes: ["known-unknown"], unobservedReceipts: [] }); f.setWarningError(true);
  const observed = await f.ports.inspect(closure);
  expect(observed.blockers).toContainEqual(expect.objectContaining({ kind: "intercom-unknown", id: "known-unknown" }));
  expect(observed.blockers).toContainEqual(expect.objectContaining({ kind: "blocker-source-unavailable", id: "intercom-warnings" }));
}, 5000);
it("unavailable destination admission keeps the exact closure closed", async () => {
  const f = await fixture(), closure = await f.ports.close(address, "move-1", 2), endpoint = { address, machineId: B, homeEpoch: 3, activationEpoch: "next" };
  f.setHome(3); f.setEndpoint(endpoint); f.setAdmissionError(true);
  await expect(f.ports.ready(closure, endpoint)).rejects.toMatchObject({ blockers: [expect.objectContaining({ kind: "intercom-readiness-unproved", id: "recipient" })] });
  await f.ports.checkGeneration(closure);
}, 5000);

it("ready and abort reload the source owner and presence name after process restart", async () => {
  const f = await fixture(false, true, false, true);
  const fence = await f.ports.close(address, "move-1", 2);
  await expect(f.recreate().abort(fence)).resolves.toBeUndefined();
  await f.ports.close(address, "move-1", 2, fence.generation);
  f.setHome(3);
  const endpoint = { address, machineId: B, homeEpoch: 3, activationEpoch: "new" };
  f.setEndpoint(endpoint);
  expect(await f.recreate().ready(fence, endpoint)).toMatchObject({ intercomAddress: expect.any(String) });
}, 5000);

it("ready refuses a different committed move even with the same endpoint and epoch", async () => {
  const f = await fixture(false, true, false, true), fence = await f.ports.close(address, "foreign-move", 2);
  f.setHome(3); const endpoint = { address, machineId: B, homeEpoch: 3, activationEpoch: "new" }; f.setEndpoint(endpoint);
  await expect(f.ports.ready(fence, endpoint)).rejects.toMatchObject({ blockers: [expect.objectContaining({ kind: "intercom-readiness-unproved" })] });
}, 5000);

it("broker restart never directly delivers mail to a homeless frozen recipient", async () => {
  const f = await fixture(true, true, true);
  await f.ports.close(address, "move-1", 2); await f.restartBroker();
  await f.client!.connect({ address: senderAddress, cwd: "/fixture", model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1, activationEpoch: "sender-activation" }, "sender");
  await f.recipient!.connect({ address, cwd: "/fixture", model: "fixture", pid: process.pid, name: "helper", startedAt: 1, lastActivity: 1, activationEpoch: "old" }, "recipient");
  expect(await f.client!.send("recipient", { messageId: "restart-mail", text: "synthetic" })).toMatchObject({ delivered: false, reason: "stale-home-epoch" });
  expect(await f.client!.send("recipient", { messageId: "restart-ask", text: "synthetic", expectsReply: true, remainingMs: 2000 })).toMatchObject({ delivered: false, reason: "intercom-frozen" });
  expect(f.socketMessages).toEqual([]);
}, 5000);
