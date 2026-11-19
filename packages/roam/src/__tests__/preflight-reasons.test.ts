import { afterEach, expect, it } from "vitest";
import { createSync } from "../sync";
import { safeControlOutcome } from "../commands";
import { HerdrError } from "@spider/herdr/client/parse";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moveSession } from "../move";
import { handleAgentOperation } from "../agent";
import { createProductionRecoveryPorts } from "../recovery-transport";
import { assignInitialHome } from "../homes";
import type { MovePorts } from "../contracts";
import { network, BOX, HUB } from "./sync-fixture";

const fixtures: ReturnType<typeof network>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function fixture() { const f = network(); fixtures.push(f); return f; }

it.each(["store-inventory-incomplete", "unknown"])("sync retains a safe %s refusal from a legacy reachable agent", async reason => {
  const f = fixture();
  f.replyHook((_peer, operation, bytes) => operation.kind === "stores"
    ? Buffer.from(JSON.stringify({ operationId: operation.id, code: 1, reason: reason === "store-inventory-incomplete" ? reason : "private free text", value: null })) : bytes);
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores });
  const results = await sync.sync(BOX); sync.stop();
  const output = safeControlOutcome({ code: 1, reason: "Synchronization needs attention", operationId: "sync-a", home: null, epoch: null, repairCommand: null, value: { outcomes: results } });
  expect(output.value).toMatchObject({ outcomes: [{ code: 1, reason: reason === "unknown" ? "peer-stores-refused" : reason }] });
  expect(JSON.stringify(output)).not.toContain("private free text");
  expect(JSON.stringify(output)).not.toContain("control-failed");
});

it.each([
  ["filesystem", "ENOENT"],
  ["transport", "cli-timeout"],
  ["unknown", "unexpected-stores"],
  ["unsafe-code", "unexpected-stores"],
] as const)("sync exposes the bounded %s agent cause without exception text", async (kind, causeCode) => {
  const f = fixture();
  f.remotes.get(BOX)!.ports.openStore = () => {
    if (kind === "filesystem") readFileSync(join(f.root, "missing-private-file"));
    if (kind === "transport") throw new HerdrError("cli-timeout", "private exception details");
    if (kind === "unsafe-code") throw new HerdrError("private-secret", "private exception details");
    throw new Error("private exception details");
  };
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores });
  const results = await sync.sync(BOX); sync.stop();
  const output = safeControlOutcome({ code: 1, reason: "Synchronization needs attention", operationId: "sync-a", home: null, epoch: null, repairCommand: null, value: { outcomes: results } });
  expect(output.value).toMatchObject({ outcomes: [{ code: 1, reason: "agent-operation-failed", causeCode }] });
  expect(JSON.stringify(output)).not.toContain("private exception details");
  expect(JSON.stringify(output)).not.toContain("missing-private-file");
  expect(JSON.stringify(output)).not.toContain("private-secret");
});

it("correlates an agent exception to its safe operation kind and original ID through sync", async () => {
  const f = fixture(), remote = f.remotes.get(BOX)!;
  remote.ports.openStore = () => { readFileSync(join(f.root, "missing-private-file")); throw new Error("unreachable"); };
  const direct = await handleAgentOperation({ id: "agent-failure", machineId: BOX, expectedEpoch: null, kind: "stores", args: {} }, remote.ports);
  expect(direct).toMatchObject({ code: 1, operationId: "agent-failure", operationKind: "stores", causeCode: "ENOENT" });
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores });
  const results = await sync.sync(BOX); sync.stop();
  const request = f.calls.find(call => call.operation.kind === "stores")!.operation;
  const output = safeControlOutcome({ code: 1, reason: "Synchronization needs attention", operationId: "sync-a", home: null, epoch: null, repairCommand: null, value: { outcomes: results } });
  expect(output.value).toMatchObject({ outcomes: [{ code: 1, reason: "agent-operation-failed", operationId: request.id, operationKind: "stores", causeCode: "ENOENT" }] });
  expect(JSON.stringify(output)).not.toContain("missing-private-file");
});

it.each(["roaming-disabled", "mirror-home-changed", "private"] as const)("sync retains only a correlated safe recovery refusal: %s", async reason => {
  const f = fixture(), remote = f.remotes.get(BOX)!;
  remote.ports.config.enabled = false;
  expect(assignInitialHome(f.global.db, "mirror-session", BOX, HUB)).not.toBe("conflict");
  if (reason !== "roaming-disabled") f.replyHook((_peer, operation, bytes) => operation.kind === "mirror-export"
    ? Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), reason: reason === "private" ? "/private/fixture" : reason })) : bytes);
  const recovery = createProductionRecoveryPorts({ root: f.global.root, config: f.config, globalDb: f.global.db, journal: f.journal, transport: f.transport });
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores, ...recovery });
  const results = await sync.sync(BOX); sync.stop();
  const request = f.calls.find(call => call.operation.kind === "mirror-export")!.operation;
  const output = safeControlOutcome({ code: 1, reason: "Synchronization needs attention", operationId: "sync-a", home: null, epoch: null, repairCommand: null, value: { outcomes: results } });
  expect(output.value).toMatchObject({ outcomes: expect.arrayContaining([expect.objectContaining({ code: 1,
    reason: reason === "private" ? "recovery-peer-refused" : reason, operationKind: "mirror-export", operationId: request.id })]) });
  expect(JSON.stringify(output)).not.toContain("/private/fixture");
  expect(JSON.stringify(output)).not.toContain("control-failed");
});

it("does not trust an answered refusal with a mismatched operation ID", async () => {
  const f = fixture(); f.remotes.get(BOX)!.ports.config.enabled = false;
  expect(assignInitialHome(f.global.db, "mirror-session", BOX, HUB)).not.toBe("conflict");
  f.replyHook((_peer, operation, bytes) => operation.kind === "mirror-export"
    ? Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), operationId: "other-operation" })) : bytes);
  const recovery = createProductionRecoveryPorts({ root: f.global.root, config: f.config, globalDb: f.global.db, journal: f.journal, transport: f.transport });
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores, ...recovery });
  const results = await sync.sync(BOX); sync.stop();
  expect(results).toContainEqual(expect.objectContaining({ code: 1, reason: "recovery-peer-invalid", operationKind: "mirror-export" }));
  expect(results.some(row => row.reason === "roaming-disabled")).toBe(false);
});

it.each(["transport", "unknown"] as const)("move retains a coded preflight blocker without copying error text (%s)", async kind => {
  const f = fixture();
  const unavailable = async (): Promise<never> => { throw new Error("must not run"); };
  const ports = { config: f.config, globalDb: f.global.db, journal: f.journal,
    async check() { throw kind === "transport" ? new HerdrError("machine-not-found", "private free text") : new Error("private free text"); },
    intercom: { address: { sessionId: "session-a", scopeId: null }, destinationEndpoint: unavailable,
      ports: { close: unavailable, drain: unavailable, inspect: unavailable, checkGeneration: unavailable, abort: unavailable, ready: unavailable } },
  } as unknown as MovePorts;
  const result = await moveSession({ sessionId: "session-a", destinationMachine: BOX,
    operation: { id: "move-a", kind: "move", machineId: HUB, expectedEpoch: null, args: { sessionId: "session-a", destinationMachine: BOX } } }, ports);
  expect(safeControlOutcome(result)).toMatchObject({ code: 1, reason: "move-preflight-refused", refusal: {
    blockers: [kind === "transport" ? "machine-not-found" : "preflight-check-unavailable"],
  } });
  expect(JSON.stringify(result)).not.toContain("private free text");
  expect(f.journal.read("move-a").some(row => row.result.action === "freeze")).toBe(false);
});
