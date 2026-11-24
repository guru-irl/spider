import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../cli";
import { openDiagnosticSnapshot } from "../diagnostic-snapshot";
import { runLocalPairOperation, type LocalPairPorts } from "../intercom-local-ops";
import { createIntercomRegistry } from "../intercom-registry";
import { openIntercomStore } from "../intercom-store";
import type { IntercomEnrollmentPair } from "../provision-contracts";
import type { IntercomStore } from "../intercom-contracts";

const publication = vi.hoisted(() => ({ index: null as null | { dev: number; ino: number; bytes: Buffer } }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readSync(...args: unknown[]) {
    const count = Reflect.apply(actual.readSync, undefined, args);
    const index = publication.index;
    if (index && count === 96 && args[4] === 0) {
      const source = actual.fstatSync(args[0] as number);
      if (source.dev === index.dev && source.ino === index.ino) index.bytes.copy(args[1] as Buffer, args[2] as number, 0, 96);
    }
    return count;
  } };
});

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const FENCE = "00000000-0000-4000-8000-000000000003", C = "00000000-0000-4000-8000-000000000004";
const roots: string[] = [], queues: IntercomStore[] = [];
afterEach(() => {
  publication.index = null;
  for (const queue of queues.splice(0)) queue.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "enroll-fence-")); roots.push(root);
  const sourceRoot = join(root, "source"), targetRoot = join(root, "target"), home = join(root, "home");
  for (const directory of [sourceRoot, targetRoot, home]) mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(sourceRoot, "roam"), { mode: 0o700 });
  const peer = (machineId: string, alias: string, globalRoot: string) => ({ machineId, alias, globalRoot,
    node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc" });
  const plan = { pairId: "pair-1", edgeEpoch: "edge-1", source: peer(A, "box-1.invalid", sourceRoot), target: peer(B, "box-2.invalid", targetRoot),
    connector: { tunnelId: "tunnel", remotePort: 22, session: "default" } };
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  const pair: IntercomEnrollmentPair = { ...plan, sshUser: "fixture", hostKey: { type: "ssh-ed25519", base64: blob.toString("base64") },
    hostKeyAlias: `spider-${"a".repeat(32)}` };
  const approval = { approved: true as const, actor: "fixture", at: 1000, operationId: "approval-1",
    graphDigest: createHash("sha256").update(JSON.stringify([plan])).digest("hex"), pairs: [plan] };
  writeFileSync(join(sourceRoot, "roam", "machine.json"), JSON.stringify({ machineId: A }), { mode: 0o600 });
  writeFileSync(join(sourceRoot, "roam", "config.json"), JSON.stringify({ role: "hub", machineId: A, hubMachineId: A, coreUnit: "fixture.service" }), { mode: 0o600 });
  const file = join(sourceRoot, "roam", "intercom", "queue.db"), queue = openIntercomStore({ file, machineId: A, clock: { now: () => 1000 } }); queues.push(queue);
  const ports: LocalPairPorts = { machineId: A, root: sourceRoot, home, node: process.execPath, ssh: "/fixture/ssh", keygen: "/fixture/keygen",
    async inspectFence(input) {
      const request = input as { machineId: string; peer: string };
      const fence = queue.pairFence(request.peer);
      return { machineId: A, peer: request.peer, fence: fence ? { edgeEpoch: fence.edgeEpoch, fenceId: fence.fenceId } : null };
    },
    async run(argv) {
      if (argv[0] !== "/fixture/keygen") throw new Error("unexpected fixture process");
      const key = argv[argv.indexOf("-f") + 1];
      writeFileSync(key, "synthetic private key", { mode: 0o600 });
      writeFileSync(`${key}.pub`, `ssh-ed25519 ${pair.hostKey.base64}\n`, { mode: 0o644 });
      return { code: 0, stdout: "" };
    } };
  return { root, sourceRoot, pair, plan, approval, file, queue, ports };
}

// Diagnostic reads see the real index just before publication. The live helper
// reads the real SQLite store, not a replacement queue or a canned fence result.
function holdDiagnosticPublication(f: ReturnType<typeof fixture>) {
  f.queue.updateEdgeState(B, "hub-edge", state => ({ ...state, failures: 1 }));
  const index = `${f.file}-shm`, source = statSync(index), bytes = readFileSync(index).subarray(0, 96);
  f.queue.updateEdgeState(B, "hub-edge", state => ({ ...state, failures: 2 }));
  publication.index = { dev: source.dev, ino: source.ino, bytes };
  let error: unknown;
  try { openDiagnosticSnapshot(f.file)?.close(); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: "diagnostic-snapshot-wal-unpublished" });
  expect(f.queue.edgeState(B, "hub-edge").failures).toBe(2);
}

async function setup(f: ReturnType<typeof fixture>) {
  let out = "", err = "";
  const code = await main(["--global-root", f.sourceRoot, "roam", "intercom", "setup-local"],
    { out(text) { out += text; }, err(text) { err += text; } },
    { stdin: Buffer.from(JSON.stringify({ action: "register-pair", pair: f.pair, approval: f.approval })), pairPorts: f.ports });
  return { code, reply: JSON.parse(out), err };
}

it("registers the approved pair through the private CLI during queue WAL publication", async () => {
  const f = fixture(); holdDiagnosticPublication(f);
  const result = await setup(f);
  expect(result.reply, result.err).toMatchObject({ ok: true, value: { registered: true } });
  expect(result.code).toBe(0);
  expect(await createIntercomRegistry(f.sourceRoot).get("pair-1")).toMatchObject({ state: "pending", pair: f.pair });
  expect(f.queue.pairFence(B)).toBeNull();
});

it("creates an approved source key during unrelated queue WAL publication", async () => {
  const f = fixture();
  await createIntercomRegistry(f.sourceRoot).register(f.plan, f.approval.operationId, f.approval.graphDigest);
  holdDiagnosticPublication(f);
  const key = await runLocalPairOperation({ action: "ensure-key", pair: f.pair, approval: f.approval }, f.ports);
  expect(key).toMatchObject({ publicKey: `ssh-ed25519 ${f.pair.hostKey.base64}`, privateMode: 0o600 });
  expect(readFileSync(join(f.sourceRoot, "roam", "intercom", "pairs", "pair-1", "edge-1", "id_ed25519"), "utf8")).toBe("synthetic private key");
});

it("observes the authoritative pair fence during queue WAL publication", async () => {
  const f = fixture(); holdDiagnosticPublication(f); let out = "";
  await main(["--global-root", f.sourceRoot, "roam", "intercom", "observe-fence"], { out(text) { out += text; }, err() {} },
    { stdin: Buffer.from(JSON.stringify({ version: 1, action: "inspect-fence", machineId: A, peer: B, pairId: "pair-1" })),
      fencePort: async (_root, input) => f.ports.inspectFence!(input) });
  expect(JSON.parse(out)).toMatchObject({ ok: true, value: { machineId: A, peer: B, fence: null, revocationPending: false } });
});

it.each([
  { state: "clear", pending: false },
  { state: "fenced", pending: true },
  { state: "cleanup-pending", pending: true },
] as const)("observes the requested new peer after pair retirement when it is $state", async ({ state, pending }) => {
  const f = fixture(), registry = createIntercomRegistry(f.sourceRoot);
  await registry.register(f.plan, f.approval.operationId, f.approval.graphDigest);
  await registry.bind(f.pair, f.approval.operationId);
  const retired = f.queue.fencePair(B, "edge-1", FENCE).fence;
  await registry.beginRevocation("pair-1", FENCE);
  await registry.finishRevocation("pair-1", state === "cleanup-pending" ? "intercom-revocation-cleanup-pending" : null);
  // Even a matching epoch and fence ID belong to another peer, not this receipt.
  const nextFence = state === "fenced" ? f.queue.fencePair(C, "edge-1", FENCE).fence : null;
  const before = readFileSync(join(f.sourceRoot, "roam", "intercom", "enrollments", "pair-1.json"));
  holdDiagnosticPublication(f);
  let out = "";
  await main(["--global-root", f.sourceRoot, "roam", "intercom", "observe-fence"], { out(text) { out += text; }, err() {} },
    { stdin: Buffer.from(JSON.stringify({ version: 1, action: "inspect-fence", machineId: A, peer: C, pairId: "pair-1" })),
      fencePort: async (_root, input) => f.ports.inspectFence!(input) });
  expect(JSON.parse(out)).toMatchObject({ ok: true, value: { machineId: A, peer: C,
    fence: nextFence ? { edgeEpoch: "edge-1", fenceId: FENCE } : null, revocationPending: pending } });
  expect(f.queue.pairFence(B)).toEqual(retired);
  expect(f.queue.pairFence(C)).toEqual(nextFence);
  expect(readFileSync(join(f.sourceRoot, "roam", "intercom", "enrollments", "pair-1.json"))).toEqual(before);
});

it("still blocks registration for a real queue fence during WAL publication", async () => {
  const f = fixture(); f.queue.fencePair(B, "edge-1", FENCE); holdDiagnosticPublication(f);
  const result = await setup(f);
  expect(result.reply).toMatchObject({ ok: false, reason: "revocation-pending" });
  expect(await createIntercomRegistry(f.sourceRoot).get("pair-1")).toBeNull();
  expect(f.queue.pairFence(B)).toMatchObject({ edgeEpoch: "edge-1", fenceId: FENCE });
});

it.each(["unavailable", "wrong-machine", "wrong-peer"])("blocks credential effects when the live fence helper is %s", async failure => {
  const f = fixture(); await createIntercomRegistry(f.sourceRoot).register(f.plan, f.approval.operationId, f.approval.graphDigest);
  holdDiagnosticPublication(f);
  f.ports.inspectFence = async () => {
    if (failure === "unavailable") throw new Error("broker-unavailable");
    return { machineId: failure === "wrong-machine" ? B : A, peer: failure === "wrong-peer" ? A : B, fence: null };
  };
  await expect(runLocalPairOperation({ action: "ensure-key", pair: f.pair, approval: f.approval }, f.ports))
    .rejects.toThrow(failure === "unavailable" ? "broker-unavailable" : "intercom-fence-unavailable");
  expect(existsSync(join(f.sourceRoot, "roam", "intercom", "pairs"))).toBe(false);
});
