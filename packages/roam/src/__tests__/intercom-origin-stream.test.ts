import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import type { SessionAddress, SessionEndpoint } from "@spider/intercom/protocol";
import { openIntercomStore } from "../intercom-store";
import { makeMessageFrame } from "../intercom-codec";

const B = "00000000-0000-4000-8000-000000000001";
const H = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const roots: string[] = []; const opened: Array<{ close(): void }> = [];
afterEach(() => { for (const s of opened.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const clock = { now: () => 1_000_000 };
const recipient: SessionAddress = { sessionId: "recipient", scopeId: "scope" };
const local: SessionEndpoint = { address: recipient, machineId: H, homeEpoch: null, activationEpoch: "gen-1" };

it("keeps inbound sequence streams separate for each origin", () => {
  const dir = mkdtempSync(join(dirname(scratchDbPath("roam-intercom")), "spoof-")); roots.push(dir);
  const hub = openIntercomStore({ file: join(dir, "q.db"), machineId: H, clock }); opened.push(hub);
  const cSession: SessionAddress = { sessionId: "c-session", scopeId: "scope" };
  const forged = makeMessageFrame({ from: cSession, endpoint: local, sequence: 1, message: { id: "forged", timestamp: 1, content: { text: "hi from c (not)" } }, originMachineId: B });
  expect(hub.acceptInbound({ peer: B, frame: forged }).kind).toBe("accepted");
  const real = makeMessageFrame({ from: cSession, endpoint: local, sequence: 1, message: { id: "real", timestamp: 1, content: { text: "real" } }, originMachineId: C });
  let err: unknown = null; try { hub.acceptInbound({ peer: C, frame: real }); } catch (e) { err = e; }
  expect(err).toBeNull();
}, 5000);

it("isolates local cursors from remote-origin streams", () => {
  const dir = mkdtempSync(join(dirname(scratchDbPath("roam-intercom")), "spoof-")); roots.push(dir);
  const hub = openIntercomStore({ file: join(dir, "q.db"), machineId: H, clock }); opened.push(hub);
  const s1: SessionAddress = { sessionId: "hub-s1", scopeId: "scope" };
  const forged = makeMessageFrame({ from: s1, endpoint: local, sequence: 1, message: { id: "forged2", timestamp: 1, content: { text: "x" } }, originMachineId: B });
  expect(hub.acceptInbound({ peer: B, frame: forged }).kind).toBe("accepted");
  expect(hub.pending({ kind: "inbound", address: recipient }).map(i => [i.id, i.from.sessionId])).toEqual([["forged2", "hub-s1"]]);
  let err: unknown = null; try { hub.acceptLocal({ from: s1, endpoint: local, message: { id: "legit", timestamp: 2, content: { text: "y" } } }); } catch (e) { err = e; }
  expect(err).toBeNull();
}, 5000);

it("accepts a sender that messages locally then moves to another origin", () => {
  const dir = mkdtempSync(join(dirname(scratchDbPath("roam-intercom")), "spoof-")); roots.push(dir);
  const hub = openIntercomStore({ file: join(dir, "q.db"), machineId: H, clock }); opened.push(hub);
  const s1: SessionAddress = { sessionId: "mover", scopeId: "scope" };
  expect(hub.acceptLocal({ from: s1, endpoint: local, message: { id: "before-move", timestamp: 2, content: { text: "y" } } }).kind).toBe("accepted");
  const after = makeMessageFrame({ from: s1, endpoint: local, sequence: 1, message: { id: "after-move", timestamp: 3, content: { text: "z" } }, originMachineId: B });
  let err: unknown = null; try { hub.acceptInbound({ peer: B, frame: after }); } catch (e) { err = e; }
  expect(err).toBeNull();
}, 5000);
it("accepts a sender that messages remotely then returns to the hub", () => {
  const dir = mkdtempSync(join(dirname(scratchDbPath("roam-intercom")), "return-")); roots.push(dir);
  const hub = openIntercomStore({ file: join(dir, "q.db"), machineId: H, clock }); opened.push(hub);
  const from = { sessionId: "returning", scopeId: "scope" };
  const frame = makeMessageFrame({ from, endpoint: local, sequence: 1, message: { id: "remote-first", timestamp: 1, content: { text: "x" } }, originMachineId: B });
  hub.acceptInbound({ peer: B, frame });
  expect(hub.acceptLocal({ from, endpoint: local, message: { id: "local-second", timestamp: 2, content: { text: "y" } } })).toMatchObject({ kind: "accepted", identity: { sequence: 1 } });
}, 5000);
