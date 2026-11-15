import { expect, it } from "vitest";
import { isRemoteSessionInfo } from "@spider/intercom/protocol";
import { decodeExchange, encodeExchange } from "../intercom-codec";
import type { IntercomExchange } from "../intercom-contracts";
const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const entry = { remote: true as const, id: "owner", address: { sessionId: "owner", scopeId: "scope" }, machineId: A, machineAlias: "peer.invalid",
  homeEpoch: null, activationEpoch: "activation", endpointEpoch: "activation", name: "owner", cwd: "/fixture", model: "fixture", status: "idle", startedAt: 1, lastActivity: 1 };
const exchange = (presence: unknown): IntercomExchange => ({ protocol: 3, senderMachine: A, recipientMachine: B, generation: { edgeEpoch: "edge", channel: "push", generation: 1 },
  frames: [], acknowledgements: [], receipts: [], controls: [], presence: [presence] } as IntercomExchange);
it.each([["name", 256], ["machineAlias", 255], ["cwd", 4096], ["model", 256], ["status", 512]] as const)("bounds peer-supplied %s", (field, max) => {
  expect(isRemoteSessionInfo({ ...entry, [field]: "x".repeat(max) })).toBe(true);
  expect(() => decodeExchange(Buffer.from(JSON.stringify(exchange({ ...entry, [field]: "x".repeat(max + 1) }))))).toThrow();
  expect(isRemoteSessionInfo({ ...entry, [field]: "x".repeat(max + 1) })).toBe(false);
}, 5000);
it.each(["name", "machineAlias", "cwd", "model", "status"])("strips ANSI and C0/C1 escapes from peer %s before it reaches a broker", field => {
  const unsafe = { ...entry, [field]: "safe\u001b[31mred\u001b[0m\u0007\u0085" };
  const decoded = decodeExchange(Buffer.from(JSON.stringify(exchange(unsafe))));
  expect(decoded.presence[0][field as keyof typeof entry]).toBe("safered");
  expect(JSON.stringify(decoded.presence)).not.toMatch(/\\u00(?:1b|07|85)/);
  expect(isRemoteSessionInfo(unsafe)).toBe(false);
  expect(decodeExchange(encodeExchange(exchange(unsafe))).presence).toEqual(decoded.presence);
}, 5000);
