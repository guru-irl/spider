import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { assertTestConfigPath } from "@spider/db-core";
import type { Journal, Peer } from "./contracts";
import type { IntercomEnrollmentPlan, IntercomRevocationPorts } from "./provision-contracts";
import { readLocalIdentity } from "./runtime";
import { loadHerdrConfig } from "./production-hub";
import { openJournal } from "./journal";
import { createProvisionTransport, type ProvisionTransport } from "./transport";
import { createProductionIntercomEnrollmentPorts, createProductionIntercomRevocationPorts, type IntercomRevocationTransport } from "./intercom-production";
import { provisionIntercomEnrollment, revokeIntercomPair } from "./intercom-enrollment";
import { createIntercomRegistry } from "./intercom-registry";
import { topologyTransitionId } from "./intercom-topology";
import { requestHelperRevoke, requestHelperTopology } from "./intercom-helper";
import { runForeground, runLocalPairCleanup } from "./intercom-local-ops";
import { invokeCli } from "@spider/herdr/client/hc";
import { parseCore, selectedSocket } from "@spider/herdr/client/parse";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function graphFile(file: string, peers: readonly Peer[]): IntercomEnrollmentPlan[] {
  if (!isAbsolute(file) || resolve(file) !== file) throw new Error("invalid-intercom-graph");
  assertTestConfigPath(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let value: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || stat.size < 1 ||
        typeof process.getuid === "function" && stat.uid !== process.getuid() || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("invalid-intercom-graph");
    value = JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
  if (!record(value) || Object.keys(value).length !== 1 || !Array.isArray(value.pairs)) throw new Error("invalid-intercom-graph");
  const find = (name: unknown): Peer => {
    if (typeof name !== "string") throw new Error("invalid-intercom-graph");
    const matches = peers.filter(peer => peer.alias === name || peer.machineId === name);
    if (matches.length !== 1) throw new Error("invalid-intercom-graph"); return matches[0];
  };
  return value.pairs.map(row => {
    if (!record(row) || Object.keys(row).sort().join(",") !== "connector,edgeEpoch,pairId,source,target" || !record(row.connector) ||
        Object.keys(row.connector).sort().join(",") !== "remotePort,session,tunnelId" || typeof row.pairId !== "string" || typeof row.edgeEpoch !== "string" ||
        typeof row.connector.tunnelId !== "string" || typeof row.connector.session !== "string" || typeof row.connector.remotePort !== "number") throw new Error("invalid-intercom-graph");
    return { pairId: row.pairId, source: find(row.source), target: find(row.target), edgeEpoch: row.edgeEpoch,
      connector: { tunnelId: row.connector.tunnelId, session: row.connector.session, remotePort: row.connector.remotePort } };
  });
}
export interface IntercomCliOptions { tty?: boolean; ask?(text: string): Promise<string>; transport?: ProvisionTransport; journal?: Journal; revokePorts?: IntercomRevocationPorts }
export async function runIntercomEnrollCli(input: { root: string; graphFile: string; operationId?: string }, io: { out(text: string): void; err(text: string): void },
  options: IntercomCliOptions = {}): Promise<number> {
  try {
    const tty = options.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!tty) throw new Error("peer-consent-required");
    const config = readLocalIdentity(input.root); if (config.role !== "hub") throw new Error("intercom-requires-hub");
    const pairs = graphFile(input.graphFile, config.peers), operationId = input.operationId ?? randomUUID();
    const request = { operation: { id: operationId, kind: "intercom-enrollment", machineId: config.machineId, expectedEpoch: null, args: {} }, pairs };
    const journal = options.journal ?? openJournal(join(input.root, "roam", "journal.db"));
    const transport = options.transport ?? createProvisionTransport({ binary: loadHerdrConfig(input.root).core.binary, env: process.env, enrolled: config.peers }, journal);
    io.out(`Operation: ${operationId}\n`);
    const ports = createProductionIntercomEnrollmentPorts({ root: input.root, request, journal, transport, actor: userInfo().username, now: Date.now,
      async present(preview) { io.out(`${preview.consent}\n${config.intercom.mode === "hub-only" ? "Approval also activates peer mode on every configured box after the hub drains accepted relay mail.\n" : ""}${JSON.stringify(preview.pairs, null, 2)}\n`); },
      async approve() {
        const question = "Approve this exact intercom graph? Type approve: ";
        if (options.ask) return (await options.ask(question)).trim() === "approve";
        const reader = createInterface({ input: process.stdin, output: process.stdout });
        try { return (await reader.question(question)).trim() === "approve"; } finally { reader.close(); }
      },
      async notify() {}, async warn(_machineId, reason) { io.err(`${reason}\n`); },
    });
    const result = await provisionIntercomEnrollment(request, ports);
    if (result.code === 0 && config.intercom.mode === "hub-only") {
      const history = journal.read(operationId), consent = history.find(row => row.action === "intercom-peer-consent" && row.result.approved === true);
      if (!consent || typeof consent.result.graphDigest !== "string") throw new Error("peer-consent-required");
      const transitionId = topologyTransitionId(config.machineId, operationId, consent.result.graphDigest);
      const transition = await requestHelperTopology(input.root, { version: 1, action: "transition-topology", machineId: config.machineId,
        transitionId, operationId, graphDigest: consent.result.graphDigest, from: "hub-only", to: "peers" });
      io.out(`intercom-transition-${transition.state} ${transition.transitionId}\n`);
    }
    (result.code === 0 ? io.out : io.err)(`${result.reason}\n`);
    if (result.value?.pending) for (const pending of result.value.pending) io.err(`${pending.pairId}: ${pending.reason}\n`);
    return result.code;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const reason = /^(?:peer-consent-required|intercom-requires-hub|invalid-intercom-graph|invalid-intercom-enrollment|intercom-transition-unsupported|intercom-transition-conflict)$/.test(message) ? message : "intercom-enrollment-unavailable";
    io.err(`${reason}\n`); return 1;
  }
}

export async function runIntercomRevokeCli(input: { root: string; pairId: string; fenceEpoch?: string }, io: { out(text: string): void; err(text: string): void },
  options: IntercomCliOptions = {}): Promise<number> {
  try {
    const config = readLocalIdentity(input.root), record = await createIntercomRegistry(input.root).get(input.pairId);
    if (!record || !("sshUser" in record.pair)) throw new Error("intercom-pair-not-found");
    const pair = record.pair, remote = config.machineId === pair.source.machineId ? pair.target : config.machineId === pair.target.machineId ? pair.source : null;
    if (!remote && config.role !== "hub") throw new Error("machine-mismatch");
    const routedRemote = remote && config.machineId === pair.source.machineId && record.resources ? { ...remote, alias: record.resources.route.name } : remote;
    let created: ProvisionTransport | undefined;
    const getTransport = (): ProvisionTransport => created ??= createProvisionTransport({ binary: loadHerdrConfig(input.root).core.binary,
      env: process.env, enrolled: routedRemote ? [routedRemote] : [pair.source, pair.target] }, options.journal ?? openJournal(join(input.root, "roam", "journal.db")));
    const delegate = (): ProvisionTransport => options.transport ?? getTransport();
    const lazy: IntercomRevocationTransport = { pinIntercomPeer: peer => delegate().pinIntercomPeer(routedRemote?.machineId === peer.machineId ? routedRemote : peer),
      transport: { exec: (...args) => delegate().transport.exec(...args) } };
    const ports = options.revokePorts ?? createProductionIntercomRevocationPorts({ root: input.root, localMachineId: config.machineId, hub: config.role === "hub", fenceEpoch: input.fenceEpoch, transport: lazy,
      async localCore() {
        const binary = loadHerdrConfig(input.root).core.binary, env = { ...process.env, HC_SOCKET: selectedSocket(process.env) };
        return parseCore(await invokeCli(binary, ["server", "status", "--json"], env, 64 * 1024), env).coreId;
      },
      fenceLocal: value => requestHelperRevoke(input.root, value),
      cleanupLocal: value => runLocalPairCleanup(value, { machineId: config.machineId, root: input.root, home: homedir(), node: process.execPath,
        ssh: "/usr/bin/ssh", keygen: "/usr/bin/ssh-keygen", recipe: config.intercom.connector, run: runForeground }),
      async notify() {},
    });
    const result = await revokeIntercomPair(input.pairId, ports);
    (result.code === 0 ? io.out : io.err)(`${result.reason}\n`);
    if (result.value?.cleanupReason) io.out(`${result.value.cleanupReason}\n`);
    return result.code;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    io.err(`${message === "intercom-pair-not-found" || message === "machine-mismatch" ? message : "revocation-incomplete"}\n`); return 1;
  }
}
