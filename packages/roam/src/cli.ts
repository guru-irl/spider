import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectLocalConsumers, runLocalDoctor, runLocalStatus } from "./local-diagnostics";
import { requestHubControl } from "./control-socket";
import { parseRoamJson, storeScope } from "@spider/db-core/roam/codec";
import { mapRepository } from "@spider/db-core/roam/repo-map";
import type { MachineId, StoreKey } from "@spider/db-core/roam/types";
import { tagMemory } from "@spider/memory/tags";
import type { Operation } from "./contracts";
import { dispatchArtifactCommand, handleAgentOperation } from "./agent";
import { openLocalCore, openLocalRuntime, readLocalIdentity } from "./runtime";
import { listStoreKeys } from "./store-inventory";
import { createStorePort } from "./stores";
import { loadHerdrConfig, startProductionHub } from "./production-hub";
import { createTransport } from "./transport";
import { remoteDoctor } from "./remote-observations";
import { disableRoaming, enableRoaming } from "./production-controls";

const HELP = `Usage: spider <command>

  spider roam status [--json]
  spider roam sync [machine]
  spider roam enable|disable
  spider roam doctor [machine]
  spider roam provision <machine>
  spider roam repo map <repo-key> <path>
  spider roam memory tag <store-key> <uuid> <machine|all>
  spider move <session> <machine>

For sync or doctor, use -- <machine> or --machine <machine> for names starting with a dash.
Exit codes: 0 complete, 1 refused, 2 invalid arguments, 3 durable pending or reconciliation needed.
Roaming operations are unavailable until their services are installed.
`;

function clean(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, "?"); }
function positional(value: string | undefined, literal: boolean): boolean {
  return typeof value === "string" && value.length > 0 && (literal || !value.startsWith("-")) && !/[\u0000-\u001f\u007f]/.test(value);
}
function normalize(input: readonly string[]): { args: readonly string[]; literalFrom: number } {
  if (input[0] === "roam" && (input[1] === "sync" || input[1] === "doctor") && input[2] === "--machine" && input.length === 4)
    return { args: [input[0], input[1], input[3]], literalFrom: 2 };
  const end = input.indexOf("--");
  return end < 1 ? { args: input, literalFrom: Infinity } : { args: [...input.slice(0, end), ...input.slice(end + 1)], literalFrom: end };
}
function valid(args: readonly string[], literalFrom: number): boolean {
  const item = (index: number) => positional(args[index], index >= literalFrom);
  if (args[0] === "move") return args.length === 3 && item(1) && item(2);
  if (args[0] !== "roam") return false;
  switch (args[1]) {
    case "status": return args.length === 2 || args.length === 3 && args[2] === "--json" && literalFrom > 2;
    case "enable": case "disable": return args.length === 2;
    case "sync": case "doctor": return args.length === 2 || args.length === 3 && item(2);
    case "provision": case "recover": case "cancel": case "forget": case "claim": case "stop": case "resume":
      return args.length === (args[1] === "claim" ? 4 : 3) && args.slice(2).every((_value, index) => item(index + 2));
    case "repo": return args[2] === "map" && args.length === 5 && item(3) && item(4);
    case "memory": return args[2] === "tag" && args.length === 6 && item(3) && item(4) && item(5);
    default: return false;
  }
}

async function readArtifactInput(limit: number, supplied?: Buffer): Promise<Buffer> {
  if (supplied !== undefined) {
    if (supplied.length > limit) throw new Error("request too large");
    return Buffer.from(supplied);
  }
  if (process.stdin.isTTY) throw new Error("artifact bytes required");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > limit) { process.stdin.destroy(); throw new Error("request too large"); }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

/** Parse before loading configuration, a database, or a transport. */
export async function main(argv: readonly string[], io: { out(text: string): void; err(text: string): void }, options?: { bundleUrl?: URL; stdin?: Buffer }): Promise<number> {
  let root = process.env.SPIDER_GLOBAL_ROOT || join(homedir(), ".pi", "agent", "spider");
  if (argv[0] === "--global-root") {
    if (!argv[1] || !isAbsolute(argv[1]) || argv[2] !== "roam" || !["agent", "artifact", "observe"].includes(argv[3])) {
      io.err("Invalid arguments. Run spider --help for usage.\n"); return 2;
    }
    root = argv[1]; argv = argv.slice(2);
  }
  if (argv.length === 0 || argv.length === 1 && ["--help", "-h", "help"].includes(argv[0]) ||
      argv.length === 2 && argv[0] === "roam" && ["--help", "-h", "help"].includes(argv[1])) {
    io.out(HELP);
    return 0;
  }
  if (argv[0] === "roam" && argv[1] === "observe" && argv.length === 3 && ["consumers", "doctor"].includes(argv[2])) {
    try {
      const config = readLocalIdentity(root);
      const value = argv[2] === "consumers" ? await inspectLocalConsumers(root, config.machineId, options?.bundleUrl)
        : await runLocalDoctor({ root, bundleUrl: options?.bundleUrl });
      io.out(`${JSON.stringify({ version: 1, machineId: config.machineId, kind: argv[2], value })}\n`);
      return 0;
    } catch { io.err("Cannot inspect local roaming state. No data was changed.\n"); return 1; }
  }
  if (argv[0] === "roam" && argv[1] === "hub" && argv.length === 2) {
    try {
      const hub = await startProductionHub(root);
      try {
        await new Promise<void>(done => {
          const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); done(); };
          process.once("SIGINT", stop); process.once("SIGTERM", stop);
        });
      } finally { await hub.stop(); }
      return 0;
    } catch { io.err("Cannot start the roaming hub. Run spider roam doctor.\n"); return 1; }
  }
  if (argv[0] === "roam" && argv[1] === "agent" && argv.length === 3) {
    let operation: unknown;
    try {
      if (Buffer.byteLength(argv[2]) > 1_048_576) throw new Error("request too large");
      operation = parseRoamJson(argv[2]);
    } catch { io.err("Invalid agent request.\n"); return 2; }
    try {
      const runtime = openLocalRuntime(root);
      try {
        const result = await handleAgentOperation(operation as Operation, runtime.agent);
        io.out(`${JSON.stringify(result)}\n`);
        return 0;
      } finally { runtime.close(); }
    } catch { io.err("Local roaming agent is unavailable.\n"); return 1; }
  }
  if (argv[0] === "roam" && argv[1] === "artifact" && argv[2] === "receive" && argv.length === 4) {
    let request: unknown;
    try {
      if (Buffer.byteLength(argv[3]) > 1_048_576) throw new Error("request too large");
      request = parseRoamJson(argv[3]);
      if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("invalid request");
    } catch { io.err("Invalid artifact request.\n"); return 2; }
    try {
      const runtime = openLocalRuntime(root);
      try {
        // Phase 2 boxes have exactly one enrolled source: their configured hub.
        if (runtime.config.role !== "box") return 1;
        const action = (request as { action?: unknown }).action;
        let stdin: Buffer | undefined;
        try {
          if (action === "page" || action === "chunk") stdin = await readArtifactInput(
            action === "page" ? runtime.config.limits.manifestBytes : runtime.config.limits.chunkBytes, options?.stdin);
        } catch { io.err("Invalid artifact bytes.\n"); return 2; }
        const reply = await dispatchArtifactCommand(argv, stdin, runtime.config.hubMachineId, runtime.agent);
        if (!reply) return 2;
        io.out(reply.toString("utf8"));
        return 0;
      } finally { runtime.close(); }
    } catch { io.err("Local roaming agent is unavailable.\n"); return 1; }
  }
  const parsed = normalize(argv);
  argv = parsed.args;
  if (!valid(argv, parsed.literalFrom)) {
    io.err("Invalid arguments. Run spider --help for usage.\n");
    return 2;
  }
  const localBoxControl = argv[0] === "roam" && (argv[1] === "status" || argv[1] === "repo" || argv[1] === "doctor" && argv.length === 2);
  if (!localBoxControl) {
    try {
      if (readLocalIdentity(root).role === "box") { io.err("Run this command on the Mac hub.\n"); return 1; }
    } catch { /* The selected command reports its own unavailable or invalid state. */ }
  }
  if (argv[0] === "roam" && (argv[1] === "enable" || argv[1] === "disable")) {
    const result = argv[1] === "enable" ? await enableRoaming(root, fileURLToPath(import.meta.url), options?.bundleUrl) : await disableRoaming(root);
    (result.code === 0 ? io.out : io.err)(`${clean(result.reason)}\n`);
    return result.code;
  }
  if (argv[0] === "roam" && argv[1] === "repo" && argv[2] === "map") {
    try {
      const core = openLocalCore(root);
      try { await mapRepository(core.db, { repoKey: argv[3], path: argv[4] }); }
      finally { core.close(); }
      io.out("Repository mapped.\n"); return 0;
    } catch { io.err("Cannot map this repository. Check the local path and roaming doctor.\n"); return 1; }
  }
  if (argv[0] === "roam" && argv[1] === "memory" && argv[2] === "tag") {
    let scope: string;
    try { scope = storeScope(argv[3]); } catch { io.err("Invalid memory store.\n"); return 2; }
    if (scope === "worktree") { io.err("Memory tags require a global or repository store.\n"); return 2; }
    try {
      const core = openLocalCore(root);
      try {
        const name = argv[5];
        const machine: MachineId | null | undefined = name === "all" ? null
          : name === core.config.machineId ? core.config.machineId : name === core.config.hubMachineId ? core.config.hubMachineId
          : core.config.peers.find(peer => peer.alias === name || peer.machineId === name)?.machineId;
        if (machine === undefined) { io.err("Machine is not enrolled.\n"); return 2; }
        if (!listStoreKeys(core.db).includes(argv[3] as StoreKey)) { io.err("Memory store is unavailable.\n"); return 1; }
        const stores = createStorePort(core.config, core.db, { allowUnassignedGlobal: true });
        try { tagMemory(stores.openStore(argv[3] as StoreKey).db, argv[4], machine); }
        finally { stores.close(); }
      } finally { core.close(); }
      io.out("Memory tag updated.\n"); return 0;
    } catch { io.err("Cannot update this memory tag. No other fields were changed.\n"); return 1; }
  }
  if (argv[0] === "roam" && argv[1] === "sync") {
    let config;
    try { config = readLocalIdentity(root); }
    catch { io.err("Roaming synchronization is unavailable.\n"); return 1; }
    if (config.role !== "hub") { io.err("Run this command on the Mac hub.\n"); return 1; }
    if (!config.enabled) { io.err("Roaming synchronization is unavailable while disabled.\n"); return 1; }
    const peer = argv[2] === undefined ? undefined : config.peers.find(candidate => candidate.alias === argv[2] || candidate.machineId === argv[2]);
    if (argv[2] !== undefined && !peer) { io.err("Machine is not enrolled.\n"); return 2; }
    try {
      const reply = await requestHubControl(join(root, "roam", "hub.sock"), peer ? { op: "sync", machine: peer.machineId } : { op: "sync" });
      (reply.code === 0 ? io.out : io.err)(`${clean(reply.reason)}\n`);
      return reply.code;
    } catch { io.err("The roaming hub is unavailable.\n"); return 1; }
  }
  if (argv[0] === "roam" && argv[1] === "status") {
    try {
      const status = runLocalStatus({ root });
      if (argv[2] === "--json") io.out(`${JSON.stringify(status)}\n`);
      else {
        const number = (value: number | null) => value === null ? "unknown" : String(value);
        const timestamp = (value: number | null) => value === null ? "unknown" : new Date(value).toISOString();
        io.out(`Roaming is ${status.enabled ? "enabled" : "disabled"}. Status is cached${status.complete ? "" : " and incomplete or unavailable"}.\n`);
        for (const home of status.homes) io.out(`Home ${clean(home.sessionId)}: ${clean(home.machineId)} (epoch ${home.epoch}).\n`);
        for (const session of status.homeConflicts) io.out(`Home conflict: ${clean(session)}.\n`);
        for (const peer of status.peers) io.out(`Peer ${clean(peer.alias)}: ${peer.connected === null ? "connection unknown" : peer.connected ? "connected" : "disconnected"}; last sync ${timestamp(peer.lastSyncAt)}; observation age ${number(peer.observationAgeMs)} ms; backlog ${number(peer.backlog)}.\n`);
        for (const store of status.stores) {
          io.out(`Store ${clean(store.key)}: head ${store.head}, ${store.changes} changes, log ${number(store.logBytes)} bytes, versions ${number(store.versionBytes)} bytes, ${store.tombstones} tombstones.\n`);
          for (const cursor of store.cursors) io.out(`  Cursor ${clean(cursor.machineId)} / ${clean(cursor.stream)}: ${cursor.through}.\n`);
        }
        for (const warning of status.warnings) io.out(`Warning ${clean(warning.machineId)}: ${clean(warning.kind)}.\n`);
        for (const item of status.suspensions) io.out(`Suspended ${clean(item.sessionId)} on ${clean(item.machineId)} (epoch ${item.epoch}).\n`);
        if (status.incompleteOperations === null) io.out("Incomplete operations: unknown.\n");
        else for (const operation of status.incompleteOperations) io.out(`Incomplete ${clean(operation.kind)}: ${clean(operation.id)} on ${clean(operation.machineId)}.\n`);
        for (const diagnostic of status.diagnostics) io.out(`${clean(diagnostic.reason)}\n`);
      }
      return 0;
    } catch {
      io.err("Cannot inspect local roaming status. No data was changed.\n");
      return 1;
    }
  }
  if (argv[0] === "roam" && argv[1] === "doctor") {
    try {
      let report: Awaited<ReturnType<typeof runLocalDoctor>>;
      if (argv.length === 2) report = await runLocalDoctor({ root, bundleUrl: options?.bundleUrl });
      else {
        const config = readLocalIdentity(root);
        if (config.role !== "hub") { io.err("Run remote doctor on the Mac hub.\n"); return 1; }
        const peer = config.peers.find(candidate => candidate.alias === argv[2] || candidate.machineId === argv[2]);
        if (!peer) { io.err("Machine is not enrolled.\n"); return 2; }
        const herdr = loadHerdrConfig(root);
        report = await remoteDoctor(createTransport({ binary: herdr.core.binary, env: process.env, enrolled: config.peers }), peer, config);
      }
      io.out(`Roaming is ${report.enabled ? "enabled" : "disabled"}.\n`);
      io.out("sqlite3 CLI requires 3.38 to write a migrated store and 3.42 for roaming capture.\n");
      for (const consumer of report.consumers) io.out(`${clean(consumer.machine)}: ${consumer.kind} PID ${consumer.pid} loaded build ${clean(consumer.build)}${consumer.roamSchema === null ? "" : `, roaming schema ${consumer.roamSchema}`}.\n`);
      for (const diagnostic of report.diagnostics) io.out(`${clean(diagnostic.reason)}\n`);
      return report.diagnostics.some(diagnostic => diagnostic.severity === "block") ? 1 : 0;
    } catch {
      io.err(argv.length > 2 ? "Remote doctor is unavailable. No data was changed.\n" : "Cannot inspect local roaming state. No data was changed.\n");
      return 1;
    }
  }
  io.err("This roaming command is unavailable in this build.\n");
  return 1;
}
