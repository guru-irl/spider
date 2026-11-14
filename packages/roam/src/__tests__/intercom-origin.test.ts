import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openIntercomStore } from "../intercom-store";
import { decodeFrame, encodeFrame } from "../intercom-codec";

const A = "00000000-0000-4000-8000-000000000001";
const HUB = "00000000-0000-4000-8000-000000000002";
const B = "00000000-0000-4000-8000-000000000003";
const from = { sessionId: "sender", scopeId: "scope" };
const to = { sessionId: "recipient", scopeId: "scope" };
const endpoint = { address: to, machineId: B, homeEpoch: null, activationEpoch: "recipient-1" };
const clock = { now: () => 1_000_000 };
const roots: string[] = [];
const stores: ReturnType<typeof openIntercomStore>[] = [];
function root() { const path = mkdtempSync(join(resolve(".spider/scratch"), "origin-")); roots.push(path); return path; }
function open(file: string, machineId: string) { const store = openIntercomStore({ file, machineId, clock }); stores.push(store); return store; }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("stamps origin at source acceptance and preserves it across restart and relay", () => {
  const dir = root(), sourceFile = join(dir, "source.db");
  let source = open(sourceFile, A); const relay = open(join(dir, "relay.db"), HUB), dest = open(join(dir, "dest.db"), B);
  source.acceptOutbound({ from, endpoint, nextHop: HUB, message: { id: "one", timestamp: 1, content: { text: "synthetic" } } });
  source.close(); source = open(sourceFile, A);
  const first = source.pending({ kind: "outbound", peer: HUB, hopBudgetMs: 100 })[0];
  expect(first.originMachineId).toBe(A);
  expect(decodeFrame(encodeFrame(first)).originMachineId).toBe(A);
  expect(relay.acceptInbound({ peer: A, frame: first }).kind).toBe("accepted");
  expect(relay.acceptOutbound({ nextHop: B, frame: first }).kind).toBe("accepted");
  const forwarded = relay.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
  expect(forwarded.originMachineId).toBe(A);
  expect(dest.acceptInbound({ peer: HUB, frame: forwarded }).kind).toBe("accepted");
  expect(dest.beginDispatch({ id: "one", endpoint, readiness: "idle" }).originMachineId).toBe(A);
}, 5000);

it("rejects a duplicate which changes a previously recorded origin", () => {
  const dir = root(), source = open(join(dir, "source.db"), A), relay = open(join(dir, "relay.db"), HUB);
  source.acceptOutbound({ from, endpoint, nextHop: HUB, message: { id: "conflict", timestamp: 1, content: { text: "synthetic" } } });
  const frame = source.pending({ kind: "outbound", peer: HUB, hopBudgetMs: 100 })[0];
  relay.acceptInbound({ peer: A, frame });
  expect(() => relay.acceptInbound({ peer: A, frame: { ...frame, originMachineId: B } })).toThrow(/origin/i);
}, 5000);
