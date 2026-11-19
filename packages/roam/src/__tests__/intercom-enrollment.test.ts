import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Outcome, Peer } from "../contracts";
import type { IntercomEnrollmentPair } from "../provision-contracts";
import { openJournal } from "../journal";
import * as enrollment from "../intercom-enrollment";

const HUB = "00000000-0000-4000-8000-000000000001";
const FIRST = "00000000-0000-4000-8000-000000000002";
const SECOND = "00000000-0000-4000-8000-000000000003";
const THIRD = "00000000-0000-4000-8000-000000000004";
const FOURTH = "00000000-0000-4000-8000-000000000005";
const CONSENT = "Enrolling this pair lets the initiating box execute commands as your user on its peer. A compromised initiating box can access every box reachable through enrolled pairs. This approval is separate from copying pi authentication. Pair keys verify their pair and epoch, but shared loopback SSH does not bind a key to one tunnel. Revoke with `spider roam intercom revoke <pair>` to stop the pair host and remove its key. Deleting the key alone does not close open connections.";
const roots: string[] = [];

function peer(machineId: string, alias: string): Peer {
  return { machineId, alias, node: "/home/fixture/.local/bin/node", pi: "/home/fixture/.local/bin/pi",
    cli: "/home/fixture/.local/lib/spider/dist/roam/cli.mjs", core: "/home/fixture/.local/bin/hc", globalRoot: "/home/fixture/.pi/agent/spider" };
}

function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "intercom-enrollment-")); roots.push(root);
  const journal = openJournal(join(root, "journal.db"));
  const source = peer(FIRST, "box-1.invalid"), target = peer(SECOND, "box-2.invalid");
  const request = { operation: { id: "approval-1", machineId: HUB, kind: "intercom-enrollment", expectedEpoch: null, args: {} },
    pairs: [{ pairId: "pair-1", source, target, edgeEpoch: "edge-1", connector: { tunnelId: "tunnel-1", remotePort: 2222, session: "default" } }] };
  const hostBlob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  const state = { allow: false, preview: null as unknown, effects: [] as string[], failAfter: null as string | null,
    sshUser: "fixture", hostKey: { type: "ssh-ed25519", base64: hostBlob.toString("base64") }, knownHosts: new Map<string, unknown>(),
    connectorIssue: null as null | "missing" | "not-signed-in" | "unhosted" | "peer-port-unreachable", connectorMissingMachine: null as string | null,
    changedMachine: null as string | null, wrongTarget: false, offline: false, warnings: [] as string[], sharedJobs: false, activeAccess: false,
    connectors: new Set<string>(), loggedIn: new Set<string>(), connections: new Set<string>(), keys: new Map<string, string>(),
    authorized: new Map<string, string>(), machines: new Map<string, string[]>(), routes: new Set<string>(), registered: new Map<string, IntercomEnrollmentPair>(),
    fences: new Map<string, string>(), approvals: new Map<string, string>(), revokeOffline: null as string | null, fenceUnclosed: false, remoteFenceUnclosed: false,
    killMode: "control-group" as "control-group" | "unknown" | undefined, pendingCleanup: new Map<string, string>(), revoking: new Set<string>(), revoked: new Set<string>() };
  const step = (name: string, effect: () => void) => {
    state.effects.push(name); effect();
    if (state.failAfter === name) { state.failAfter = null; throw new Error("lost reply"); }
  };
  const ports = {
    journal, actor: "fixture", now: () => 1_000,
    async withLock<T>(work: () => Promise<T>): Promise<T> { return work(); },
    async present(preview: unknown) { state.preview = preview; },
    async approve() { return state.allow; },
    async readPairFences(pairs: readonly IntercomEnrollmentPair[]) { return Object.fromEntries(pairs.map(pair => [pair.pairId, state.fences.get(pair.pairId) ?? null])); },
    async approvePair(pair: IntercomEnrollmentPair, consent: { operationId: string; graphDigest: string; expectedFenceId: string | null }) {
      const current = state.fences.get(pair.pairId) ?? null, receipt = JSON.stringify(consent);
      if (current !== consent.expectedFenceId && !(current === null && state.approvals.get(pair.pairId) === receipt)) throw new Error("fresh-peer-consent-required");
      step("approve-pair", () => { state.fences.delete(pair.pairId); state.approvals.set(pair.pairId, receipt); });
    },
    async notify() { state.effects.push("notify"); },
    async pinMachine(machine: Peer) {
      state.effects.push(`pin:${machine.machineId}`);
      if (state.revokeOffline === machine.machineId) return null;
      return { machineId: state.changedMachine === machine.machineId ? THIRD : machine.machineId, coreId: `core-${machine.machineId}` };
    },
    async warn(machineId: string, reason: string) { state.warnings.push(`${machineId}:${reason}`); },
    async registerPair(pair: IntercomEnrollmentPair) { step("register", () => { state.registered.set(pair.pairId, structuredClone(pair)); }); },
    async checkConnector(machine: Peer) {
      step(`check:${machine.machineId}`, () => {});
      if (state.connectorMissingMachine === machine.machineId) return "missing" as const;
      return state.connectorIssue === "missing" || state.connectorIssue === "not-signed-in" ? state.connectorIssue : "ready" as const;
    },
    async hostConnector() { step("host", () => {}); return state.connectorIssue === "unhosted" ? "unhosted" as const : "ready" as const; },
    async inspectSshHost(pair: IntercomEnrollmentPair) { step("inspect-ssh", () => {}); return { targetMachineId: pair.target.machineId, sshUser: state.sshUser, hostKeys: [{ ...state.hostKey }] }; },
    async bindPair(pair: IntercomEnrollmentPair) { step("bind-pair", () => { state.registered.set(pair.pairId, structuredClone(pair)); }); },
    async writeKnownHost(pair: IntercomEnrollmentPair) { step("known-host", () => { state.knownHosts.set(pair.pairId, { ...pair.hostKey, alias: pair.hostKeyAlias, user: pair.sshUser }); }); },
    async connect(pair: IntercomEnrollmentPair): Promise<"ready" | "offline"> {
      if (state.offline) return "offline";
      if (state.connectorIssue === "peer-port-unreachable") return "peer-port-unreachable" as any;
      step("connect", () => { state.connections.add(pair.pairId); }); return "ready";
    },
    async ensureKey(pair: IntercomEnrollmentPair) {
      step("key", () => {
        if (!state.keys.has(pair.pairId)) {
          const bytes = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, state.keys.size + 1)]);
          state.keys.set(pair.pairId, `ssh-ed25519 ${bytes.toString("base64")}`);
        }
      });
      return { publicKey: state.keys.get(pair.pairId)!, privateMode: 0o600, privateOwned: true };
    },
    async authorize(pair: IntercomEnrollmentPair, line: string) { step("authorize", () => { state.authorized.set(pair.pairId, line); }); },
    async addMachine(pair: IntercomEnrollmentPair, argv: readonly string[]) { step("machine", () => { state.machines.set(pair.pairId, [...argv]); }); },
    async verifyTransport(pair: IntercomEnrollmentPair) {
      state.effects.push("verify-transport");
      return { sourceMachineId: pair.source.machineId, targetMachineId: state.wrongTarget ? THIRD : pair.target.machineId, connector: true, key: true, route: true };
    },
    async publishPair(pair: IntercomEnrollmentPair) { step("publish", () => { state.routes.add(pair.pairId); }); },
    async verifyPair(pair: IntercomEnrollmentPair) {
      step("verify", () => {});
      return { sourceMachineId: pair.source.machineId, targetMachineId: pair.target.machineId, connector: true, key: true, route: true, federation: true };
    },
    async getPair(pairId: string) {
      const pair = state.registered.get(pairId);
      return pair ? { pair: structuredClone(pair), state: state.revoked.has(pairId) ? "revoked" as const : state.revoking.has(pairId) ? "revoking" as const : "active" as const,
        cleanupReason: state.pendingCleanup.get(pairId) ?? null } : null;
    },
    async beginRevocation(pair: IntercomEnrollmentPair) { step("begin-revoke", () => { state.revoking.add(pair.pairId); }); },
    async fenceAndClose(pair: IntercomEnrollmentPair) {
      step("fence", () => { if (!state.fences.has(pair.pairId)) state.fences.set(pair.pairId, `fence-${pair.edgeEpoch}`); state.routes.delete(pair.pairId); });
      return { sourceMachineId: pair.source.machineId, targetMachineId: pair.target.machineId, localMachineId: pair.source.machineId,
        edgeEpoch: pair.edgeEpoch, fenceId: state.fences.get(pair.pairId)!, fenceDurable: true as const, exchanges: state.fenceUnclosed ? "active" as const : "closed" as const, inFlight: state.fenceUnclosed ? 1 : 0 };
    },
    async fenceRemote(pair: IntercomEnrollmentPair, _pins: unknown, fenceId: string) {
      step("fence-remote", () => {});
      return { sourceMachineId: pair.source.machineId, targetMachineId: pair.target.machineId, localMachineId: pair.target.machineId,
        edgeEpoch: pair.edgeEpoch, fenceId, fenceDurable: true as const, exchanges: state.remoteFenceUnclosed ? "active" as const : "closed" as const,
        inFlight: state.remoteFenceUnclosed ? 1 : 0 };
    },
    async stopPairHost(pair: IntercomEnrollmentPair) { step("stop-host", () => {}); return { machineId: pair.target.machineId,
      unit: `spider-pair-${pair.pairId}-host.service`, activeState: "inactive" as const, mainPid: 123, mainStartIdentity: "fixture-start",
      mainProcess: "exited" as const, controlGroup: "empty" as const, killMode: state.killMode };  },
    async removeAuthorizedKey(pair: IntercomEnrollmentPair) { step("remove-key", () => { state.authorized.delete(pair.pairId); }); },
    async removeMachineIfIdle(pair: IntercomEnrollmentPair) {
      if (state.sharedJobs) return "shared-jobs" as const;
      step("remove-machine", () => { state.machines.delete(pair.pairId); }); return "removed" as const;
    },
    async verifyRevocation(pair: IntercomEnrollmentPair) {
      return { sourceMachineId: pair.source.machineId, targetMachineId: pair.target.machineId, edgeEpoch: pair.edgeEpoch,
        keyAbsent: !state.authorized.has(pair.pairId), routeAbsent: !state.machines.has(pair.pairId),
        exchanges: "closed" as const, authenticatedConnections: state.activeAccess ? "active" as const : "closed" as const };
    },
    async finishRevocation(pair: IntercomEnrollmentPair, cleanupReason: string | null) { step("finish-revoke", () => {
      state.revoked.add(pair.pairId); if (cleanupReason) state.pendingCleanup.set(pair.pairId, cleanupReason); else state.pendingCleanup.delete(pair.pairId);
    }); },
  };
  return { root, journal, source, target, request, state, ports };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function run(request: unknown, ports: unknown): Promise<Outcome<unknown>> {
  const fn = (enrollment as { provisionIntercomEnrollment?: (request: unknown, ports: unknown) => Promise<Outcome<unknown>> }).provisionIntercomEnrollment;
  expect(typeof fn).toBe("function");
  return fn!(request, ports);
}
async function revoke(pairId: string, ports: unknown): Promise<Outcome<unknown>> {
  const fn = (enrollment as { revokeIntercomPair?: (pairId: string, ports: unknown) => Promise<Outcome<unknown>> }).revokeIntercomPair;
  expect(typeof fn).toBe("function");
  return fn!(pairId, ports);
}

it.each(["unknown", undefined] as const)("refuses an unproven systemd kill mode %#", async mode => {
  const f = fixture(); f.state.allow = true; expect((await run(f.request, f.ports)).code).toBe(0); f.state.killMode = mode;
  expect(await revoke("pair-1", f.ports)).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed" });
  expect(f.state.authorized.has("pair-1")).toBe(true); expect(f.state.effects).not.toContain("remove-key");
}, 5000);

it("auth consent does not approve peer execution", async () => {
  const f = fixture();
  f.journal.begin({ id: "auth-1", machineId: FIRST, kind: "provision", expectedEpoch: null, args: {} });
  f.journal.record("auth-1", "provision-consent", { approved: true, target: f.source.alias, machineId: FIRST });
  const outcome = await run(f.request, f.ports);
  expect(outcome).toMatchObject({ code: 1, reason: "peer-consent-required", value: null });
  expect(f.state.effects).toEqual([]);
}, 5000);

it("consent states full peer command access and shows the exact directed identities", async () => {
  const f = fixture();
  await run(f.request, f.ports);
  expect(f.state.preview).toEqual({ consent: CONSENT, pairs: [{ pairId: "pair-1", source: { machineId: FIRST, alias: "box-1.invalid" },
    target: { machineId: SECOND, alias: "box-2.invalid" }, edgeEpoch: "edge-1", connector: { tunnelId: "tunnel-1", remotePort: 2222, session: "default" } }] });
  expect(f.state.effects).toEqual([]);
}, 5000);

it("no graph approval has zero transport effects", async () => {
  const f = fixture();
  const result = await run(f.request, f.ports);
  expect(result).toMatchObject({ code: 1, reason: "peer-consent-required" });
  expect(f.state.effects).toEqual([]);
  expect(f.journal.read("approval-1").some(row => row.action === "intercom-peer-consent")).toBe(false);
}, 5000);

it("one restricted key exists per pair", async () => {
  const f = fixture(); f.state.allow = true;
  f.request.pairs.push({ pairId: "pair-2", source: f.source, target: peer(THIRD, "box-3.invalid"), edgeEpoch: "edge-2",
    connector: { tunnelId: "tunnel-2", remotePort: 2223, session: "default" } });
  const result = await run(f.request, f.ports);
  expect(result).toMatchObject({ code: 0, reason: "intercom-enrolled", value: { pairs: ["pair-1", "pair-2"] } });
  expect(f.state.keys.size).toBe(2);
  expect(new Set(f.state.keys.values()).size).toBe(2);
  expect(f.state.authorized.get("pair-1")).toMatch(/^from="127\.0\.0\.1",restrict,command="/);
  expect(f.state.authorized.get("pair-1")).toContain(`${f.state.keys.get("pair-1")} spider-intercom:pair-1`);
  expect(f.state.authorized.get("pair-2")).toMatch(/^from="127\.0\.0\.1",restrict,command="/);
  expect(f.state.authorized.get("pair-2")).toContain(`${f.state.keys.get("pair-2")} spider-intercom:pair-2`);
  expect(f.state.machines.get("pair-1")).toEqual(["machine", "add", "--via",
    "/home/fixture/.pi/agent/spider/roam/intercom/pairs/pair-1/edge-1/via", "--name", "spider-pair-pair-1", "--session", "default", "--json"]);
  expect(f.state.effects.indexOf("notify")).toBeLessThan(f.state.effects.indexOf(`check:${FIRST}`));
  expect(f.journal.read("approval-1").filter(row => row.action === "intercom-peer-consent")).toHaveLength(1);
}, 5000);

it("pins the target's observed SSH user and host key to a pair-specific alias", async () => {
  const f = fixture(); f.state.allow = true;
  expect(await run(f.request, f.ports)).toMatchObject({ code: 0 });
  const pair = f.state.registered.get("pair-1")!;
  expect(pair.sshUser).toBe("fixture"); expect(pair.hostKey).toEqual(f.state.hostKey);
  expect(pair.hostKeyAlias).toMatch(/^spider-[0-9a-f]{32}$/);
  expect(f.state.knownHosts.get("pair-1")).toEqual({ ...f.state.hostKey, alias: pair.hostKeyAlias, user: "fixture" });
  expect(f.state.effects.indexOf("notify")).toBeLessThan(f.state.effects.indexOf("inspect-ssh"));
  expect(f.state.effects.indexOf("inspect-ssh")).toBeLessThan(f.state.effects.indexOf("known-host"));
  expect(f.state.effects.indexOf("known-host")).toBeLessThan(f.state.effects.indexOf("machine"));
}, 5000);

it("keeps the original pin when a preferred host key appears on retry", async () => {
  const f = fixture(); f.state.allow = true; f.state.failAfter = "known-host";
  const ed = { ...f.state.hostKey };
  const type = Buffer.from("ssh-rsa"), exponent = Buffer.from([1, 0, 1]), modulus = Buffer.concat([Buffer.from([0]), Buffer.alloc(256, 0x81)]);
  const field = (value: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(value.length); return Buffer.concat([length, value]); };
  const rsa = { type: "ssh-rsa", base64: Buffer.concat([field(type), field(exponent), field(modulus)]).toString("base64") };
  f.state.hostKey = rsa;
  expect(await run(f.request, f.ports)).toMatchObject({ code: 3 });
  const previous = structuredClone(f.state.knownHosts.get("pair-1"));
  const inspect = f.ports.inspectSshHost;
  f.ports.inspectSshHost = async pair => ({ ...await inspect(pair), hostKeys: [ed, rsa] });
  expect(await run(f.request, f.ports)).toMatchObject({ code: 0, reason: "intercom-enrolled" });
  expect(f.state.knownHosts.get("pair-1")).toEqual(previous);
  expect(f.state.registered.get("pair-1")?.hostKey).toEqual(rsa);
}, 5000);

it("reports an unavailable pin when its key type does not answer on retry", async () => {
  const f = fixture(); f.state.allow = true; f.state.failAfter = "known-host";
  expect(await run(f.request, f.ports)).toMatchObject({ code: 3 });
  const previous = structuredClone(f.state.knownHosts.get("pair-1"));
  const type = Buffer.from("ssh-rsa"), exponent = Buffer.from([1, 0, 1]), modulus = Buffer.concat([Buffer.from([0]), Buffer.alloc(256, 0x81)]);
  const field = (value: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(value.length); return Buffer.concat([length, value]); };
  f.state.hostKey = { type: "ssh-rsa", base64: Buffer.concat([field(type), field(exponent), field(modulus)]).toString("base64") };
  expect(await run(f.request, f.ports)).toMatchObject({ code: 3, reason: "intercom-ssh-host-unavailable" });
  expect(f.state.knownHosts.get("pair-1")).toEqual(previous);
  expect(f.state.machines.size).toBe(0);
}, 5000);

it("does not silently repin a changed host key on an interrupted enrollment", async () => {
  const f = fixture(); f.state.allow = true; f.state.failAfter = "known-host";
  expect(await run(f.request, f.ports)).toMatchObject({ code: 3 });
  const previous = structuredClone(f.state.knownHosts.get("pair-1"));
  const blob = Buffer.from(f.state.hostKey.base64, "base64"); blob[blob.length - 1] ^= 1;
  f.state.hostKey = { ...f.state.hostKey, base64: blob.toString("base64") };
  expect(await run(f.request, f.ports)).toMatchObject({ code: 3, reason: "host-key-changed" });
  expect(f.state.knownHosts.get("pair-1")).toEqual(previous);
  expect(f.state.machines.size).toBe(0);
  const fresh = structuredClone(f.request); fresh.operation.id = "approval-new-key"; fresh.pairs[0].edgeEpoch = "edge-new";
  expect(await run(fresh, f.ports)).toMatchObject({ code: 0 });
  expect(f.state.knownHosts.get("pair-1")).toMatchObject({ base64: f.state.hostKey.base64 });
}, 5000);

it.each([
  ["missing", "intercom-connector-missing"], ["not-signed-in", "intercom-connector-sign-in-required"],
  ["unhosted", "intercom-tunnel-unhosted"], ["peer-port-unreachable", "intercom-peer-port-unreachable"],
] as const)("keeps enrollment pending for connector prerequisite %s without installing or logging in", async (issue, reason) => {
  const f = fixture(); f.state.allow = true; f.state.connectorIssue = issue;
  expect(await run(f.request, f.ports)).toMatchObject({ code: 3, reason });
  expect(f.state.effects.some(effect => effect.startsWith("install:") || effect.startsWith("login:"))).toBe(false);
  expect(f.state.machines.size).toBe(0);
}, 5000);

it("a pending connector on one pair does not prevent another approved pair from enrolling", async () => {
  const f = fixture(); f.state.allow = true; f.state.connectorMissingMachine = SECOND;
  f.request.pairs.push({ pairId: "pair-2", source: peer(THIRD, "box-3.invalid"), target: peer(FOURTH, "box-4.invalid"), edgeEpoch: "edge-2",
    connector: { tunnelId: "tunnel-2", remotePort: 2223, session: "default" } });
  const result = await run(f.request, f.ports);
  expect(result).toMatchObject({ code: 3, value: { pairs: ["pair-2"], pending: [{ pairId: "pair-1", reason: "intercom-connector-missing" }] } });
  expect(f.state.routes.has("pair-1")).toBe(false); expect(f.state.routes.has("pair-2")).toBe(true);
  expect(f.journal.read("approval-1").filter(row => row.action === "intercom-peer-consent")).toHaveLength(1);
  f.state.connectorMissingMachine = null; f.state.allow = false;
  expect(await run(f.request, f.ports)).toMatchObject({ code: 0, value: { pairs: ["pair-1", "pair-2"] } });
  expect(f.state.routes.has("pair-1")).toBe(true); expect(f.state.routes.has("pair-2")).toBe(true);
}, 5000);

it("an unavailable authoritative fence does not block an independent pair", async () => {
  const f = fixture(); f.state.allow = true;
  f.request.pairs.push({ pairId: "pair-2", source: peer(THIRD, "box-3.invalid"), target: peer(FOURTH, "box-4.invalid"), edgeEpoch: "edge-2",
    connector: { tunnelId: "tunnel-2", remotePort: 2223, session: "default" } });
  const ports = { ...f.ports, async readPairFences(pairs: readonly IntercomEnrollmentPair[]) {
    return Object.fromEntries(pairs.map(pair => [pair.pairId, pair.pairId === "pair-1" ? "unavailable" : null]));
  } };
  expect(await run(f.request, ports)).toMatchObject({ code: 3, value: { pairs: ["pair-2"], pending: [{ pairId: "pair-1", reason: "intercom-fence-unavailable" }] } });
  expect(f.state.registered.has("pair-1")).toBe(false); expect(f.state.routes.has("pair-2")).toBe(true);
}, 5000);

it("approves fresh pair commands after authorization and before adding the route", async () => {
  const f = fixture(); f.state.allow = true;
  expect(await run(f.request, f.ports)).toMatchObject({ code: 0, reason: "intercom-enrolled" });
  const order = f.state.effects.filter(name => ["authorize", "approve-pair", "machine", "verify-transport"].includes(name));
  expect(order).toEqual(["authorize", "approve-pair", "machine", "verify-transport"]);
}, 5000);

it("rerun converges after each interrupted step", async () => {
  for (const stage of ["register", `check:${FIRST}`, "inspect-ssh", "bind-pair", "host", "connect", "key", "known-host", "authorize", "approve-pair", "machine", "publish", "verify"]) {
    const f = fixture(); f.state.allow = true; f.state.failAfter = stage;
    expect(await run(f.request, f.ports), stage).toMatchObject({ code: 3 });
    f.state.allow = false;
    expect(await run(f.request, f.ports), stage).toMatchObject({ code: 0, reason: "intercom-enrolled" });
    expect(f.state.registered.size, stage).toBe(1);
    expect(f.state.keys.size, stage).toBe(1);
    expect(f.state.authorized.size, stage).toBe(1);
    expect(f.state.machines.size, stage).toBe(1);
    expect(f.state.routes.size, stage).toBe(1);
    expect(f.journal.read("approval-1").filter(row => row.action === "intercom-peer-consent"), stage).toHaveLength(1);
  }
}, 5000);

it("binds approval to the exact machine UUIDs and refuses changed arguments", async () => {
  const f = fixture(); f.state.allow = true; f.state.failAfter = "key";
  expect(await run(f.request, f.ports)).toMatchObject({ code: 3 });
  const count = f.state.effects.length;
  f.request.pairs[0].target = peer(THIRD, "box-3.invalid");
  expect(await run(f.request, f.ports)).toMatchObject({ code: 1, reason: "operation-arguments-changed" });
  expect(f.state.effects).toHaveLength(count);
}, 5000);

it("only consent to the current fence generation can re-enroll a revoked pair", async () => {
  const f = fixture(); f.state.allow = true; f.state.failAfter = "key";
  expect(await run(f.request, f.ports)).toMatchObject({ code: 3 });
  f.state.fences.set("pair-1", "fence-new"); const before = f.state.effects.length;
  expect(await run(f.request, f.ports)).toMatchObject({ code: 3, reason: "fresh-peer-consent-required" });
  expect(f.state.fences.get("pair-1")).toBe("fence-new");
  expect(f.state.effects.slice(before)).not.toContain("authorize"); expect(f.state.effects.slice(before)).not.toContain("machine");
  const fresh = structuredClone(f.request); fresh.operation.id = "approval-2"; fresh.pairs[0].edgeEpoch = "edge-2";
  f.state.allow = false;
  expect(await run(fresh, f.ports)).toMatchObject({ code: 1, reason: "peer-consent-required" });
  expect(f.state.fences.get("pair-1")).toBe("fence-new");
  f.state.allow = true;
  expect(await run(fresh, f.ports)).toMatchObject({ code: 0, reason: "intercom-enrolled" });
  expect(f.state.fences.has("pair-1")).toBe(false);
}, 5000);

it("refuses a changed machine identity before connector or key effects", async () => {
  const f = fixture(); f.state.allow = true; f.state.changedMachine = SECOND;
  expect(await run(f.request, f.ports)).toMatchObject({ code: 3, reason: "machine-mismatch" });
  expect(f.state.connectors.size).toBe(0);
  expect(f.state.keys.size).toBe(0);
  expect(f.state.authorized.size).toBe(0);
}, 5000);

it("refuses unsafe private key modes before authorizing a peer", async () => {
  const f = fixture(); f.state.allow = true;
  const original = f.ports.ensureKey;
  f.ports.ensureKey = async pair => ({ ...await original(pair), privateMode: 0o644 });
  expect(await run(f.request, f.ports)).toMatchObject({ code: 3, reason: "unsafe-pair-key" });
  expect(f.state.authorized.size).toBe(0);
  expect(f.state.machines.size).toBe(0);
}, 5000);

it("does not publish an edge until the route reaches the approved target", async () => {
  const f = fixture(); f.state.allow = true; f.state.wrongTarget = true;
  expect(await run(f.request, f.ports)).toMatchObject({ code: 3, reason: "intercom-verification-pending" });
  expect(f.state.routes.size).toBe(0);
}, 5000);

it("offline box stays pending without repeated warnings", async () => {
  const f = fixture(); f.state.allow = true; f.state.offline = true;
  expect(await run(f.request, f.ports)).toMatchObject({ code: 3, reason: "link-down" });
  expect(await run(f.request, f.ports)).toMatchObject({ code: 3, reason: "link-down" });
  expect(f.state.warnings).toEqual([`${SECOND}:link-down`]);
  expect(f.state.authorized.size).toBe(0);
  f.state.offline = false;
  expect(await run(f.request, f.ports)).toMatchObject({ code: 0, reason: "intercom-enrolled" });
}, 5000);

it("keeps revocation unconfirmed while a pair host cgroup has a straggler", async () => {
  const f = fixture(); f.state.allow = true; expect((await run(f.request, f.ports)).code).toBe(0);
  const before = f.state.authorized.get("pair-1"), ports = { ...f.ports, async stopPairHost(pair: IntercomEnrollmentPair) {
    return { machineId: pair.target.machineId, unit: `spider-pair-${pair.pairId}-host.service`, activeState: "inactive" as const,
      mainPid: 123, mainStartIdentity: "fixture-start", mainProcess: "exited" as const, controlGroup: "nonempty" as const };
  } };
  expect(await revoke("pair-1", ports)).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed" });
  expect(f.state.authorized.get("pair-1")).toBe(before);
  expect(f.state.pendingCleanup.get("pair-1")).toBe("intercom-revocation-unconfirmed");
}, 5000);

it("revocation removes only that pair", async () => {
  const f = fixture(); f.state.allow = true;
  f.request.pairs.push({ pairId: "pair-2", source: f.source, target: peer(THIRD, "box-3.invalid"), edgeEpoch: "edge-2",
    connector: { tunnelId: "tunnel-2", remotePort: 2223, session: "default" } });
  expect((await run(f.request, f.ports)).code).toBe(0);
  const otherKey = f.state.authorized.get("pair-2"), otherRoute = f.state.machines.get("pair-2");
  expect(await revoke("pair-1", f.ports)).toMatchObject({ code: 0, reason: "intercom-revoked", value: { pairId: "pair-1" } });
  expect(f.state.authorized.has("pair-1")).toBe(false);
  expect(f.state.machines.has("pair-1")).toBe(false);
  expect(f.state.routes.has("pair-1")).toBe(false);
  expect(f.state.authorized.get("pair-2")).toBe(otherKey);
  expect(f.state.machines.get("pair-2")).toEqual(otherRoute);
  expect(f.state.routes.has("pair-2")).toBe(true);
  expect(f.state.effects.indexOf("fence")).toBeLessThan(f.state.effects.indexOf("begin-revoke"));
  expect(f.state.effects.indexOf("fence")).toBeLessThan(f.state.effects.indexOf("fence-remote"));
  expect(f.state.effects.indexOf("fence-remote")).toBeLessThan(f.state.effects.indexOf("remove-key"));
  expect(f.state.effects.indexOf("remove-key")).toBeLessThan(f.state.effects.indexOf("remove-machine"));
}, 5000);

it("live shared jobs leave named cleanup pending without undoing local revocation", async () => {
  const f = fixture(); f.state.allow = true;
  expect((await run(f.request, f.ports)).code).toBe(0);
  f.state.sharedJobs = true; f.state.activeAccess = true;
  expect(await revoke("pair-1", f.ports)).toMatchObject({ code: 0, reason: "intercom-revoked", value: { pairId: "pair-1", cleanupReason: "intercom-revocation-shared-jobs" } });
  expect(f.state.routes.has("pair-1")).toBe(false);
  expect(f.state.authorized.has("pair-1")).toBe(false);
  expect(f.state.machines.has("pair-1")).toBe(true);
  expect(f.state.revoked.has("pair-1")).toBe(true);
  expect(f.state.pendingCleanup.get("pair-1")).toBe("intercom-revocation-shared-jobs");
  f.state.sharedJobs = false; f.state.activeAccess = false;
  expect(await revoke("pair-1", f.ports)).toMatchObject({ code: 0, reason: "intercom-revoked", value: { cleanupReason: null } });
  expect(f.state.machines.has("pair-1")).toBe(false);
}, 5000);

it("revocation reconciles lost replies without restoring access", async () => {
  for (const stage of ["fence", "begin-revoke", "finish-revoke"]) {
    const f = fixture(); f.state.allow = true;
    expect((await run(f.request, f.ports)).code, stage).toBe(0);
    f.state.failAfter = stage;
    expect(await revoke("pair-1", f.ports), stage).toMatchObject({ code: 3 });
    expect(await revoke("pair-1", f.ports), stage).toMatchObject({ code: 0, reason: "intercom-revoked" });
    expect(f.state.authorized.has("pair-1"), stage).toBe(false);
    expect(f.state.machines.has("pair-1"), stage).toBe(false);
    expect(f.state.routes.has("pair-1"), stage).toBe(false);
  }
}, 5000);

it("leaves revocation unconfirmed when B is unreachable and retries after it returns", async () => {
  const f = fixture(); f.state.allow = true; expect((await run(f.request, f.ports)).code).toBe(0);
  f.state.revokeOffline = SECOND;
  const before = f.state.effects.length;
  expect(await revoke("pair-1", f.ports)).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed" });
  expect(f.state.fences.has("pair-1")).toBe(true);
  expect(f.state.pendingCleanup.get("pair-1")).toBe("intercom-revocation-unconfirmed");
  expect(f.state.effects.slice(before)).not.toContain("remove-key");
  expect(f.state.effects.slice(before)).not.toContain("remove-machine");
  f.state.revokeOffline = null;
  expect(await revoke("pair-1", f.ports)).toMatchObject({ code: 0, value: { cleanupReason: null } });
  expect(f.state.pendingCleanup.has("pair-1")).toBe(false);
}, 5000);

it("never removes credentials without proof that the fenced exchange has closed", async () => {
  const f = fixture(); f.state.allow = true; expect((await run(f.request, f.ports)).code).toBe(0);
  f.state.fenceUnclosed = true; const before = f.state.effects.length;
  expect(await revoke("pair-1", f.ports)).toMatchObject({ code: 3, reason: "revocation-incomplete" });
  expect(f.state.fences.has("pair-1")).toBe(true);
  expect(f.state.effects.slice(before)).not.toContain("remove-key");
  expect(f.state.effects.slice(before)).not.toContain("remove-machine");
  expect(f.state.revoked.has("pair-1")).toBe(false);
}, 5000);

it("keeps remote cleanup pending if the reachable peer cannot prove its exchange closed", async () => {
  const f = fixture(); f.state.allow = true; expect((await run(f.request, f.ports)).code).toBe(0);
  f.state.remoteFenceUnclosed = true; const before = f.state.effects.length;
  expect(await revoke("pair-1", f.ports)).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed" });
  expect(f.state.fences.has("pair-1")).toBe(true);
  expect(f.state.effects.slice(before)).not.toContain("remove-key"); expect(f.state.effects.slice(before)).not.toContain("remove-machine");
  expect(f.state.pendingCleanup.get("pair-1")).toBe("intercom-revocation-unconfirmed");
}, 5000);

it("retries named pending cleanup after a lost cleanup reply", async () => {
  for (const stage of ["remove-key", "remove-machine"]) {
    const f = fixture(); f.state.allow = true; expect((await run(f.request, f.ports)).code).toBe(0);
    f.state.failAfter = stage;
    expect(await revoke("pair-1", f.ports), stage).toMatchObject(stage === "remove-key"
      ? { code: 3, reason: "intercom-revocation-unconfirmed" }
      : { code: 0, value: { cleanupReason: "intercom-revocation-cleanup-pending" } });
    expect(await revoke("pair-1", f.ports), stage).toMatchObject({ code: 0, value: { cleanupReason: null } });
    expect(f.state.machines.has("pair-1"), stage).toBe(false);
  }
}, 5000);

it("never reports revocation success when authorized-key removal has no confirmation", async () => {
  const f = fixture(); f.state.allow = true; expect((await run(f.request, f.ports)).code).toBe(0);
  const remove = f.ports.removeAuthorizedKey;
  f.ports.removeAuthorizedKey = async () => { throw new Error("key write failed"); };
  expect(await revoke("pair-1", f.ports)).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed" });
  expect(f.state.authorized.has("pair-1")).toBe(true);
  expect(f.state.pendingCleanup.get("pair-1")).toBe("intercom-revocation-unconfirmed");
  f.ports.removeAuthorizedKey = remove;
  expect(await revoke("pair-1", f.ports)).toMatchObject({ code: 0, reason: "intercom-revoked" });
  expect(f.state.authorized.has("pair-1")).toBe(false);
}, 5000);

it("keeps revocation unconfirmed when key verification fails alongside route verification", async () => {
  const f = fixture(); f.state.allow = true; expect((await run(f.request, f.ports)).code).toBe(0);
  const verify = f.ports.verifyRevocation;
  f.ports.verifyRevocation = async pair => ({ ...await verify(pair), keyAbsent: false, routeAbsent: false });
  expect(await revoke("pair-1", f.ports)).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed" });
  expect(f.state.pendingCleanup.get("pair-1")).toBe("intercom-revocation-unconfirmed");
}, 5000);


it("refreshes unavailable consent fences and asks again before setup", async () => {
  const f = fixture(); f.state.allow = true; let available = false, observations = 0;
  const ports = { ...f.ports, async readPairFences(pairs: readonly IntercomEnrollmentPair[]) {
    observations++; return Object.fromEntries(pairs.map(pair => [pair.pairId, available ? null : "unavailable"]));
  } };
  expect(await run(f.request, ports)).toMatchObject({ code: 3, reason: "intercom-fence-unavailable" });
  const before = observations; available = true; f.state.allow = false;
  expect(await run(f.request, ports)).toMatchObject({ code: 1, reason: "peer-consent-required" });
  expect(observations).toBeGreaterThan(before); expect(f.state.routes.size).toBe(0);
  f.state.allow = true;
  expect(await run(f.request, ports)).toMatchObject({ code: 0, reason: "intercom-enrolled" });
  expect(f.journal.read("approval-1").filter(row => row.action === "intercom-peer-consent").at(-1)?.result.fences).toEqual({ "pair-1": null });
}, 5000);


it("retains completed fence consent while refreshing only unavailable pairs", async () => {
  const f = fixture(); f.state.allow = true; let available = false;
  f.request.pairs.push({ pairId: "pair-2", source: peer(THIRD, "box-3.invalid"), target: peer(FOURTH, "box-4.invalid"), edgeEpoch: "edge-2",
    connector: { tunnelId: "tunnel-2", remotePort: 2222, session: "default" } });
  f.state.fences.set("pair-2", "predecessor-fence");
  const ports = { ...f.ports, async readPairFences(pairs: readonly IntercomEnrollmentPair[]) {
    return Object.fromEntries(pairs.map(pair => [pair.pairId, pair.pairId === "pair-1" && !available ? "unavailable" : f.state.fences.get(pair.pairId) ?? null]));
  } };
  expect(await run(f.request, ports)).toMatchObject({ code: 3, value: { pairs: ["pair-2"] } });
  available = true;
  expect(await run(f.request, ports)).toMatchObject({ code: 0, value: { pairs: ["pair-1", "pair-2"] } });
  expect(f.journal.read("approval-1").filter(row => row.action === "intercom-peer-consent").at(-1)?.result.fences).toEqual({ "pair-1": null, "pair-2": "predecessor-fence" });
}, 5000);
