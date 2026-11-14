import { expect, it } from "vitest";
import { buildFixture } from "../../../scripts/test-bundle.js";
import {
  isSessionAddress, isSessionEndpoint, isFederationDispatchResult, isRemoteSessionInfo,
  isMessageReceipt, parseFederationBrokerMessage, resolveSessionTarget, qualifiedName, sameAddress, type RemoteSessionInfo,
} from "./protocol.js";

const remote: RemoteSessionInfo = {
  remote: true, id: "portable", address: { sessionId: "portable", scopeId: null },
  machineId: "machine-2", machineAlias: "box-1.invalid", homeEpoch: 2,
  activationEpoch: "activation-2", endpointEpoch: "activation-2", name: "team/helper",
  cwd: "/workspace", model: "fixture", startedAt: 1, lastActivity: 1,
};
it("the public protocol bundles without pi or Node runtime dependencies", async () => {
  const result = await buildFixture({ entryPoints: ["packages/intercom/src/protocol.ts"], write: false });
  const inputs = Object.keys(result.metafile.inputs);
  expect(inputs.length).toBeGreaterThan(0);
  expect(inputs.every(path => path.includes("/packages/intercom/src/"))).toBe(true);
  expect(result.outputFiles[0]!.text).not.toMatch(/\bimport\s*(?:[({*]|["'])/);
  expect(result.outputFiles[0]!.text).not.toContain("pi-coding-agent");
}, 5000);
it("addresses contain only logical identity and never route or process fields", () => {
  expect(isSessionAddress(remote.address)).toBe(true);
  expect(isSessionAddress({ ...remote.address, machineId: "machine-2" })).toBe(false);
  expect(isSessionAddress({ ...remote.address, pid: 123 })).toBe(false);
  expect(sameAddress(remote.address, { ...remote.address })).toBe(true);
  expect(isRemoteSessionInfo({ ...remote, address: { ...remote.address, terminalId: "untrusted" } })).toBe(false);
  expect(isRemoteSessionInfo({ ...remote, reachability: ["live"] })).toBe(false);
  for (const field of ["contextPct", "contextTokens", "contextWindow"]) expect(isRemoteSessionInfo({ ...remote, [field]: "40" })).toBe(false);
  expect(isRemoteSessionInfo({ ...remote, contextPct: Infinity })).toBe(false);
}, 5000);
it("endpoint constraints require machine, home and activation generations", () => {
  const endpoint = { address: remote.address, machineId: "machine-2", homeEpoch: 2, activationEpoch: "activation-2" };
  expect(isSessionEndpoint(endpoint)).toBe(true);
  expect(isSessionEndpoint({ ...endpoint, homeEpoch: null })).toBe(true);
  for (const change of [{ homeEpoch: -1 }, { homeEpoch: 1.1 }, { homeEpoch: undefined }, { machineId: "" }, { activationEpoch: "" }]) expect(isSessionEndpoint({ ...endpoint, ...change })).toBe(false);
}, 5000);
it("durable source acceptance and physical consumption are distinct wire facts", () => {
  const queued = { delivery: "queued", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: true, location: "source" } };
  expect(isFederationDispatchResult(queued)).toBe(true);
  expect(isFederationDispatchResult({ ...queued, delivery: ["queued"] })).toBe(false);
  expect(isFederationDispatchResult({ ...queued, delivery: "unknown", outcomeKnown: false, acceptance: { accepted: false, durable: false, location: "not-durable" } })).toBe(false);
  expect(isFederationDispatchResult({ ...queued, acceptance: { accepted: true, durable: false } })).toBe(false);
  expect(isFederationDispatchResult({ ...queued, acceptance: { accepted: false, durable: true, location: "source" } })).toBe(false);
  expect(isFederationDispatchResult({ ...queued, delivery: "unknown" })).toBe(false);
  expect(isFederationDispatchResult({ ...queued, delivery: "socket_delivered", acceptance: { accepted: false, durable: false } })).toBe(false);
  expect(isFederationDispatchResult({ ...queued, delivery: "failed", outcomeKnown: false, acceptance: { accepted: false, durable: false } })).toBe(false);
  expect(isMessageReceipt({ messageId: "mail", status: "injected", timestamp: 1, evidence: { kind: "absence", complete: true, sessionId: "portable", activationEpoch: "old", excludedGeneration: "old" } })).toBe(false);
}, 5000);
it("broker frames are parsed before privileged bridge callbacks", () => {
  const dispatch = { type: "federation_dispatch", requestId: "request", dispatch: { from: { sessionId: "own", scopeId: null }, to: remote, message: { id: "mail", timestamp: 1, content: { text: "synthetic" } } } };
  expect(parseFederationBrokerMessage(dispatch)).toEqual(dispatch);
  expect(parseFederationBrokerMessage({ ...dispatch, dispatch: { ...dispatch.dispatch, from: { sessionId: "own" } } })).toBeNull();
  const presence = { type: "federation_local_presence", sessions: [{ address: { sessionId: "own", scopeId: null }, activationEpoch: "activation", homeEpoch: null, cwd: "/workspace", model: "fixture", startedAt: 1, lastActivity: 1 }] };
  expect(parseFederationBrokerMessage(presence)).toEqual(presence);
  expect(parseFederationBrokerMessage({ ...presence, sessions: [{ ...presence.sessions[0], pid: 123 }] })).toBeNull();
  const blockers = { type: "blockers", requestId: "request", blockers: { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] } };
  expect(parseFederationBrokerMessage(blockers)).toEqual(blockers);
  expect(parseFederationBrokerMessage({ ...blockers, blockers: { ...blockers.blockers, pendingDispatch: [{ body: "synthetic" }] } })).toBeNull();
}, 5000);

it("portable full ids and encoded qualified names resolve without local fallback", () => {
  const local = { id: "broker-alias", address: { sessionId: "physical", scopeId: null }, cwd: "/workspace", model: "fixture", pid: 1, startedAt: 1, lastActivity: 1 };
  expect(resolveSessionTarget("physical", [local])).toBe(local);
  expect(qualifiedName(remote)).toBe("box-1.invalid/team%2Fhelper");
  expect(resolveSessionTarget(qualifiedName(remote), [local, remote])).toBe(remote);
  expect(() => resolveSessionTarget("box-1.invalid/%broken", [remote])).toThrow(/invalid-target/);
}, 5000);
