import { HOSTING_WARNING_CODE } from "./hosting-warning";
import { peerEnabledDiagnostics } from "./peer-enabled";
import { readMoveBindingDiagnostics } from "./move-diagnostics";
import { controlRefusal, controlText, sourceCleanupStatusText, parsePublicControl, resolveControlMachine, safeControlOutcome } from "./commands";
import { destroyedMachineWarning } from "./forget";
import type { RunDisabledForget } from "./disabled-forget-contract";
import { ReadinessParseError } from "@spider/db-core/roam/readiness";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { spawnBrokerIfNeeded } from "@spider/intercom/broker/spawn";
import { runProvisionCli } from "./provision-cli";
import { observeLocalHosting } from "./production-supervisor";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectLocalConsumers, localHostingWarningDiagnostics, runLocalDoctor, runLocalStatus } from "./local-diagnostics";
import { requestHubControl } from "./control-socket";
import { parseRoamJson, storeScope } from "@spider/db-core/roam/codec";
import { mapRepository } from "@spider/db-core/roam/repo-map";
import type { MachineId, StoreKey } from "@spider/db-core/roam/types";
import { tagMemory } from "@spider/memory/tags";
import { MOVE_REFUSAL_MESSAGES, type Operation, type Outcome } from "./contracts";
import { dispatchArtifactCommand, handleAgentOperation } from "./agent";
import { openLocalCore, openLocalRuntime, readLocalIdentity } from "./runtime";
import { listStoreKeys } from "./store-inventory";
import { createStorePort } from "./stores";
import { loadHerdrConfig, startProductionHub } from "./production-hub";
export { startProductionHub } from "./production-hub";
import { createTransport } from "./transport";
import { isPeerFailureReason, peerFailureReason } from "./peer-errors";
import { remoteDoctor } from "./remote-observations";
import { disableRoaming, enableRoaming } from "./production-controls";
import { runForeground, runLocalPairCleanup, runLocalPairOperation, hasPairConsent, type LocalPairCleanup, type LocalPairOperation, type LocalPairPorts } from "./intercom-local-ops";
import { parseHelperFence, requestHelperFence } from "./intercom-helper";
import { createIntercomRegistry } from "./intercom-registry";
import { pairScopedRecipe, inspectPairUnit } from "./intercom-pair-resources";
import type { IntercomCliOptions } from "./intercom-cli";
import { DEFAULT_SSH, DEFAULT_SSH_KEYGEN, DEFAULT_SSH_KEYSCAN } from "./intercom-ssh-defaults";
import { enrollmentCauseCode } from "./intercom-enrollment";

const HELP = `Usage: spider <command>

  spider roam status [--json]
  spider roam sync [machine]
  spider roam enable|disable
  spider roam doctor [machine]
  spider roam provision <machine> [--release <tarball>] [--no-settings] [--skill <name>]... [--yes --consent copilot-auth] [--consent-provider <name>]... [--operation-id <id>]
  spider roam stop|resume <session>
  spider roam recover|cancel <operation-id>
  spider roam claim <session> <machine>
  spider roam forget <machine> --confirm "destroyed <machine UUID or alias>"
  spider roam repo map <repo-key> <path>
  spider roam memory tag <store-key> <uuid> <machine|all>
  spider move <session> <machine>

Add --json at the end of a control for machine-readable output.
For sync or doctor, use -- <machine> or --machine <machine> for names starting with a dash.
Non-interactive provisioning uses --yes --consent copilot-auth as an explicit user command.
Anyone with the user's shell access can invoke it. While disabled, provision does not enable the box or start hosting.
Before forget, confirm the machine is destroyed. If it is alive, two copies can run until reconnection.
Conversation after the last mirror and unsent workspace edits will be lost.
Exit codes: 0 complete, 1 refused, 2 invalid arguments, 3 durable pending or reconciliation needed.
`;

function clean(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, "?"); }
type CommandIO = { out(text: string): void; err(text: string): void };
function outcome(code: 0 | 1 | 2 | 3, reason: string, value: unknown = null): Outcome<unknown> {
  return { code, reason, operationId: "", home: null, epoch: null, repairCommand: null, value };
}
function emitOutcome(io: CommandIO, result: Outcome<unknown> & { refusal?: unknown }, json: boolean, text?: string): number {
  const safe = safeControlOutcome(result);
  if (json) io.out(`${JSON.stringify(safe)}\n`);
  else (safe.code === 0 ? io.out : io.err)(text ?? controlText(safe));
  return safe.code;
}
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
function setupPendingCause(error: unknown): { code: string; message: string } {
  const code = enrollmentCauseCode(error);
  const message = (error instanceof Error ? error.message : "Unknown setup failure")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:token|secret|password|credential|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[redacted]")
    .replace(/(["'])(?:\/|[A-Za-z]:[\\/])[\s\S]*?\1/g, "[redacted]")
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'<>;,)]*/g, "[redacted]")
    .replace(/\bssh-(?:ed25519|rsa)\s+[^\s]+/g, "[redacted]")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 240);
  return { code, message: message || "Unknown setup failure" };
}

export async function main(argv: readonly string[], io: CommandIO, options?: { bundleUrl?: URL; stdin?: Buffer; pairPorts?: LocalPairPorts; fencePort?: typeof requestHelperFence; intercomOptions?: IntercomCliOptions; intercomDoctor?: Parameters<typeof runLocalDoctor>[0]["intercomDoctor"]; runDisabledForget?: RunDisabledForget; moveFactory?: import("./move-runtime-contracts").MoveRuntimeFactory; placementFactory?: import("./contracts").PlacementFactory }): Promise<number> {
  let root = process.env.SPIDER_GLOBAL_ROOT || join(homedir(), ".pi", "agent", "spider");
  const privateRoot = argv[0] === "--global-root";
  if (privateRoot) {
    if (!argv[1] || !isAbsolute(argv[1]) || argv[2] !== "roam" || !["agent", "artifact", "observe", "intercom"].includes(argv[3])) {
      io.err("Invalid arguments. Run spider --help for usage.\n"); return 2;
    }
    root = argv[1]; argv = argv.slice(2);
  }
  if (argv.length === 0 || argv.length === 1 && ["--help", "-h", "help"].includes(argv[0]) ||
      argv.length === 2 && argv[0] === "roam" && ["--help", "-h", "help"].includes(argv[1])) {
    io.out(HELP);
    return 0;
  }
  const publicInput = argv[0] === "move" || argv[0] === "roam" && !["agent", "artifact", "observe", "intercom", "hub"].includes(argv[1]);
  const jsonOutput = publicInput && argv.at(-1) === "--json";
  if (publicInput) {
    let control = parsePublicControl(argv);
    const forgetWarning = (machine: string | null) => machine ? destroyedMachineWarning(machine)
      : "Confirm the box is destroyed. If it is still alive, two copies can run until reconnection. Conversation after the last mirror and unsent workspace edits will be lost.";
    if (!control) {
      if (argv[0] === "roam" && argv[1] === "forget") {
        let machine: string | null = null;
        try { machine = resolveControlMachine(argv[2] ?? "", readLocalIdentity(root)); } catch { /* No identity was proved. */ }
        io.err(`${forgetWarning(machine)}\n`);
        return emitOutcome(io, outcome(2, "destroyed-machine-confirmation-required"), jsonOutput);
      }
      return emitOutcome(io, outcome(2, "invalid-arguments"), jsonOutput, argv[0] === "roam" && argv[1] === "provision" ? "Invalid provisioning arguments.\n" : "Invalid arguments. Run spider --help for usage.\n");
    }
    let publicConfig: ReturnType<typeof readLocalIdentity> | undefined;
    try {
      publicConfig = readLocalIdentity(root);
      const reason = controlRefusal(control, publicConfig);
      if (reason) {
        const result = { code: 1 as const, reason, operationId: "", home: null, epoch: null, repairCommand: null, value: null };
        return emitOutcome(io, result, jsonOutput);
      }
    } catch {
      if (!["status", "doctor"].includes(control.kind)) return emitOutcome(io, outcome(1, "roaming-config-unavailable"), jsonOutput);
    }
    if (control.kind === "forget" && publicConfig) {
      const machine = resolveControlMachine(control.machine, publicConfig);
      if (!machine || machine === publicConfig.hubMachineId) return emitOutcome(io, outcome(2, "machine-not-enrolled"), jsonOutput);
      if (control.confirmation !== `destroyed ${machine}` && control.confirmation !== `destroyed ${control.machine}`) {
        io.err(`${forgetWarning(machine)}\n`);
        return emitOutcome(io, outcome(2, "destroyed-machine-confirmation-required"), jsonOutput);
      }
      control = { ...control, confirmation: `destroyed ${machine}` };
      if (!publicConfig.enabled) {
        if (!options?.runDisabledForget) return emitOutcome(io, outcome(3, "disabled-forget-unavailable"), jsonOutput);
        try {
          const result = await options.runDisabledForget({ machine, confirmed: true });
          const code = "code" in result ? result.code : 1;
          if (jsonOutput) io.out(`${JSON.stringify(result)}\n`);
          else {
            const pending = "results" in result ? result.results.filter(row => row.reason === "recovery-launch-pending" && row.repairCommand).map(row => `Resume ${clean(row.sessionId)}: ${row.repairCommand}`) : [];
            (code === 0 ? io.out : io.err)(result.ok && result.presentation === "pending" ? "recovered; the pane appears when Herdr opens\n" : `${[clean(result.reason), ...pending].join("\n")}\n`);
          }
          return code;
        } catch { return emitOutcome(io, outcome(3, "disabled-forget-unavailable"), jsonOutput); }
      }
    }
    if (["move", "recover", "cancel", "forget", "claim"].includes(control.kind)) {
      try {
        const { kind, ...args } = control;
        const request = { op: kind, ...args } as import("./move-control").MoveControlRequest;
        if (kind === "move" && !jsonOutput) io.out("Keep the Mac awake until the move finishes.\n");
        const reply = await requestHubControl(join(root, "roam", "hub.sock"), request);
        const result = { ...reply, operationId: reply.operationId ?? "", home: reply.home ?? null, epoch: reply.epoch ?? null, repairCommand: reply.repairCommand ?? null };
        let alias: string | undefined;
        if (kind === "move") try { alias = readLocalIdentity(root).peers.find(peer => peer.machineId === result.home?.machineId)?.alias; } catch { /* The typed outcome remains authoritative. */ }
        return emitOutcome(io, result, jsonOutput, jsonOutput ? undefined : controlText(safeControlOutcome(result), alias));
      } catch { return emitOutcome(io, outcome(1, "move-control-unavailable"), jsonOutput); }
    }
    if (jsonOutput) argv = argv.slice(0, -1);
  }
  if (privateRoot && argv.length === 3 && argv[0] === "roam" && argv[1] === "intercom" && argv[2] === "start-broker") {
    try {
      const config = readLocalIdentity(root), agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
      const info = lstatSync(agentDir);
      if (config.role !== "box" || !isAbsolute(agentDir) || resolve(agentDir) !== agentDir || realpathSync(agentDir) !== agentDir ||
          !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("unsafe-broker-start");
      await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"], { agentDir });
      io.out(`${JSON.stringify({ version: 1, kind: "intercom-broker-start", ok: true, machineId: config.machineId })}\n`);
    } catch { io.out(`${JSON.stringify({ version: 1, kind: "intercom-broker-start", ok: false, reason: "intercom-broker-unavailable" })}\n`); }
    return 0;
  }
  if (argv[0] === "roam" && argv[1] === "intercom" && argv[2] === "enroll") {
    let graphFile: string | undefined, operationId: string | undefined;
    for (let i = 3; i < argv.length; i++) {
      if (argv[i] === "--graph" && !graphFile && argv[i + 1]) graphFile = argv[++i];
      else if (argv[i] === "--operation" && !operationId && argv[i + 1]) operationId = argv[++i];
      else { io.err("Usage: spider roam intercom enroll --graph <absolute-private-json> [--operation <id>]\n"); return 2; }
    }
    if (!graphFile) { io.err("Usage: spider roam intercom enroll --graph <absolute-private-json> [--operation <id>]\n"); return 2; }
    const { runIntercomEnrollCli } = await import("./intercom-cli");
    return runIntercomEnrollCli({ root, graphFile, operationId }, io, options?.intercomOptions);
  }
  if (argv[0] === "roam" && argv[1] === "intercom" && argv[2] === "revoke") {
    const id = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
    if (!id(argv[3] ?? "") || !(argv.length === 4 || argv.length === 6 && argv[4] === "--fence-epoch" && id(argv[5]))) {
      io.err("Usage: spider roam intercom revoke <pair-id> [--fence-epoch <historical-epoch>]\n"); return 2;
    }
    const { runIntercomRevokeCli } = await import("./intercom-cli");
    return runIntercomRevokeCli({ root, pairId: argv[3], fenceEpoch: argv[5] }, io, options?.intercomOptions);
  }
  if (argv[0] === "roam" && argv[1] === "intercom" && argv[2] === "observe-fence" && argv.length === 3) {
    try {
      const config = readLocalIdentity(root), bytes = await readArtifactInput(4096, options?.stdin);
      const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid-intercom-observation");
      const { pairId, ...body } = raw as Record<string, unknown>;
      if (pairId !== undefined && (typeof pairId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pairId))) throw new Error("invalid-intercom-observation");
      const input = parseHelperFence(body);
      if (input.machineId !== config.machineId) throw new Error("machine-mismatch");
      const observed = await (options?.fencePort ?? requestHelperFence)(root, input);
      const value = pairId === undefined ? observed : { ...observed, revocationPending: await createIntercomRegistry(root).revocationPending(pairId as string, observed.peer) };
      io.out(`${JSON.stringify({ version: 1, kind: "intercom-fence", ok: true, value })}\n`);
    } catch { io.out(`${JSON.stringify({ version: 1, kind: "intercom-fence", ok: false, reason: "intercom-fence-unavailable" })}\n`); }
    return 0;
  }
  if (argv[0] === "roam" && argv[1] === "intercom" && argv[2] === "cleanup-local" && argv.length === 3) {
    try {
      const config = readLocalIdentity(root), bytes = await readArtifactInput(64 * 1024, options?.stdin);
      const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as LocalPairCleanup;

      const base = options?.pairPorts ?? { machineId: config.machineId, root, home: homedir(), node: process.execPath, ssh: DEFAULT_SSH,
        keygen: DEFAULT_SSH_KEYGEN, keyscan: DEFAULT_SSH_KEYSCAN, sshUser: userInfo().username, recipe: config.intercom.connector, run: runForeground };
      const value = await runLocalPairCleanup(input, { ...base, machineId: config.machineId, root });
      io.out(`${JSON.stringify({ version: 1, kind: "intercom-cleanup", ok: true, machineId: config.machineId, value })}\n`);
    } catch (error) { io.out(`${JSON.stringify({ version: 1, kind: "intercom-cleanup", ok: false,
      reason: error instanceof Error && error.message === "intercom-revocation-unconfirmed" ? error.message : "intercom-revocation-cleanup-pending" })}\n`); }
    return 0;
  }
  if (argv[0] === "roam" && argv[1] === "intercom" && argv[2] === "setup-local" && argv.length === 3) {
    try {
      const config = readLocalIdentity(root), bytes = await readArtifactInput(1024 * 1024, options?.stdin);
      const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as LocalPairOperation;
      if (!input?.pair || !hasPairConsent(input.pair, input.approval)) throw new Error("peer-consent-required");
      if (await createIntercomRegistry(root).revocationPending(input.pair.pairId, config.machineId === input.pair.source.machineId ? input.pair.target.machineId : input.pair.source.machineId)) throw new Error("revocation-pending");
      if (!["check-connector", "inspect-ssh", "register-pair", "host-connector", "connect-connector"].includes(input?.action) && !pairScopedRecipe(config.intercom.connector ?? options?.pairPorts?.recipe)) throw new Error("connector-not-pair-scoped");
      const base = options?.pairPorts ?? { machineId: config.machineId, root, home: homedir(), node: process.execPath, ssh: DEFAULT_SSH,
        keygen: DEFAULT_SSH_KEYGEN, keyscan: DEFAULT_SSH_KEYSCAN, sshUser: userInfo().username, recipe: config.intercom.connector, run: runForeground };
      if (!["check-connector", "inspect-ssh", "register-pair", "host-connector", "connect-connector"].includes(input?.action)) {
        const side = input.pair?.source?.machineId === config.machineId ? "connect" : "host";
        if (!await inspectPairUnit(input.pair as import("./provision-contracts").IntercomEnrollmentPair, side, { ...base, machineId: config.machineId, root })) throw new Error("connector-not-pair-scoped");
      }
      const value = await runLocalPairOperation(input, { ...base, machineId: config.machineId, root });
      io.out(`${JSON.stringify({ version: 1, kind: "intercom-setup", ok: true, machineId: config.machineId, value })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const reason = /^(?:intercom-[a-z-]+|revocation-pending|fresh-peer-consent-required|connector-not-pair-scoped|peer-consent-required|machine-mismatch|core-unavailable|unsafe-pair-key|host-key-changed)$/.test(message) ? message : "intercom-setup-pending";
      const cause = reason === "intercom-setup-pending" ? setupPendingCause(error) : undefined;
      if (cause) io.err(`${JSON.stringify({ reason, cause })}\n`);
      io.out(`${JSON.stringify({ version: 1, kind: "intercom-setup", ok: false, reason, ...(cause ? { cause } : {}) })}\n`);
    }
    return 0;
  }
  if (argv[0] === "roam" && argv[1] === "observe" && argv.length === 3 && ["consumers", "doctor", "hosting"].includes(argv[2])) {
    try {
      const config = readLocalIdentity(root);
      const value = argv[2] === "consumers" ? await inspectLocalConsumers(root, config.machineId, options?.bundleUrl)
        : argv[2] === "hosting" ? await observeLocalHosting(root) : await runLocalDoctor({ root, bundleUrl: options?.bundleUrl, inspectIntercomDoctor: true, intercomDoctor: options?.intercomDoctor });
      io.out(`${JSON.stringify({ version: 1, machineId: config.machineId, kind: argv[2], value })}\n`);
      return 0;
    } catch (error) { io.err(error instanceof ReadinessParseError ? `${error.reason}\n` : "Cannot inspect local roaming state. No data was changed.\n"); return 1; }
  }
  if (argv[0] === "roam" && argv[1] === "hub" && argv.length === 2) {
    try {
      const hub = await startProductionHub(root, { moveFactory: options?.moveFactory, placementFactory: options?.placementFactory });
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
      let result: Awaited<ReturnType<typeof handleAgentOperation>>;
      try {
        if (options?.moveFactory) runtime.agent.move = async op => {
          const sessionId = op.args.sessionId as string;
          const herdr = loadHerdrConfig(root);
          const transport = createTransport({ binary: herdr.core.binary, env: process.env, enrolled: runtime.config.peers });
          const { openFreezeJournal } = await import("./journal");
          const mounted = await options.moveFactory!({ root, globalDb: runtime.db, config: runtime.config, journal: openFreezeJournal(join(root, "roam", "journal.db")), transport, sessionId, operation: op });
          try {
            if (mounted.dispatch) return await mounted.dispatch(op);
            const { handleMoveParticipantOperation } = await import("./move-ports");
            return await handleMoveParticipantOperation(op, runtime.journal, mounted.bindings);
          } finally { await mounted.close(); }
        };
        result = await handleAgentOperation(operation as Operation, runtime.agent);
        const op = operation as Operation, header = op.args?.header;
        if (result.code === 0 && op.kind === "import" && header && typeof header === "object" && !Array.isArray(header) && typeof header.senderMachine === "string") {
          try { const { signalHubRestoration } = await import("./hub-restoration"); signalHubRestoration(root, runtime.config, header.senderMachine); } catch { /* The next verified import retries the restoration feed. */ }
        }
      }
      finally { runtime.close(); }
      io.out(`${JSON.stringify(result)}\n`);
      return 0;
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
      let reply: Buffer;
      try {
        // Phase 2 boxes have exactly one enrolled source: their configured hub.
        if (runtime.config.role !== "box") return 1;
        const action = (request as { action?: unknown }).action;
        let stdin: Buffer | undefined;
        try {
          if (action === "page" || action === "chunk") stdin = await readArtifactInput(
            action === "page" ? runtime.config.limits.manifestBytes : runtime.config.limits.chunkBytes, options?.stdin);
        } catch { io.err("Invalid artifact bytes.\n"); return 2; }
        const outcome = await dispatchArtifactCommand(argv, stdin, runtime.config.hubMachineId, runtime.agent);
        if (!outcome) return 2;
        reply = outcome;
      } finally { runtime.close(); }
      io.out(reply.toString("utf8"));
      return 0;
    } catch { io.err("Local roaming agent is unavailable.\n"); return 1; }
  }
  if (argv[0] === "roam" && argv[1] === "provision") {
    if (!positional(argv[2], false)) { io.err("Invalid provisioning target.\n"); return 2; }
    let release: string | undefined, operationId: string | undefined, yes = false, noSettings = false, consent: string | null = null;
    const seen = new Set<string>(), skills: string[] = [], consentedProviders: string[] = [];
    for (let index = 3; index < argv.length; index++) {
      const flag = argv[index];
      if (flag !== "--skill" && flag !== "--consent-provider" && seen.has(flag) ||
          !["--release", "--yes", "--no-settings", "--consent", "--operation-id", "--skill", "--consent-provider"].includes(flag)) { io.err("Invalid provisioning arguments.\n"); return 2; }
      seen.add(flag);
      if (flag === "--yes") { yes = true; continue; }
      if (flag === "--no-settings") { noSettings = true; continue; }
      const value = argv[++index];
      if (!positional(value, false)) { io.err("Invalid provisioning arguments.\n"); return 2; }
      if (flag === "--release") { if (!isAbsolute(value)) { io.err("The release must be an absolute path.\n"); return 2; } release = value; }
      else if (flag === "--consent") consent = value;
      else if (flag === "--skill") skills.push(value);
      else if (flag === "--consent-provider") consentedProviders.push(value);
      else operationId = value;
    }
    const provisionIO = jsonOutput ? { out: io.err, err: io.err } : io;
    const result = await runProvisionCli({ root, target: argv[2], release, yes, consent, operationId, skills, consentedProviders, noSettings }, provisionIO, { bundleUrl: options?.bundleUrl });
    return jsonOutput ? emitOutcome(io, result, true) : result.code;
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
    return emitOutcome(io, outcome(result.code, result.reason, result.issues || result.information ? { issues: result.issues, information: result.information } : null), jsonOutput, `${result.message.split("\n").map(clean).join("\n")}\n`);
  }
  if (argv[0] === "roam" && argv[1] === "repo" && argv[2] === "map") {
    try {
      const core = openLocalCore(root);
      try { await mapRepository(core.db, { repoKey: argv[3], path: argv[4] }); }
      finally { core.close(); }
      return emitOutcome(io, outcome(0, "repository-mapped"), jsonOutput, "Repository mapped.\n");
    } catch { return emitOutcome(io, outcome(1, "repository-map-unavailable"), jsonOutput, "Cannot map this repository. Check the local path and roaming doctor.\n"); }
  }
  if (argv[0] === "roam" && argv[1] === "memory" && argv[2] === "tag") {
    let scope: string;
    try { scope = storeScope(argv[3]); } catch { return emitOutcome(io, outcome(2, "invalid-memory-store"), jsonOutput, "Invalid memory store.\n"); }
    if (scope === "worktree") return emitOutcome(io, outcome(2, "invalid-memory-store"), jsonOutput, "Memory tags require a global or repository store.\n");
    try {
      const core = openLocalCore(root);
      try {
        const name = argv[5];
        const machine: MachineId | null | undefined = name === "all" ? null
          : name === core.config.machineId ? core.config.machineId : name === core.config.hubMachineId ? core.config.hubMachineId
          : core.config.peers.find(peer => peer.alias === name || peer.machineId === name)?.machineId;
        if (machine === undefined) return emitOutcome(io, outcome(2, "machine-not-enrolled"), jsonOutput, "Machine is not enrolled.\n");
        if (!listStoreKeys(core.db).includes(argv[3] as StoreKey)) return emitOutcome(io, outcome(1, "memory-store-unavailable"), jsonOutput, "Memory store is unavailable.\n");
        const stores = createStorePort(core.config, core.db, { allowUnassignedGlobal: true });
        try { tagMemory(stores.openStore(argv[3] as StoreKey).db, argv[4], machine); }
        finally { stores.close(); }
      } finally { core.close(); }
      return emitOutcome(io, outcome(0, "memory-tag-updated"), jsonOutput, "Memory tag updated.\n");
    } catch { return emitOutcome(io, outcome(1, "memory-tag-unavailable"), jsonOutput, "Cannot update this memory tag. No other fields were changed.\n"); }
  }
  if (argv[0] === "roam" && ["stop", "resume"].includes(argv[1])) {
    try {
      const core = openLocalCore(root);
      try {
        if (core.config.role !== "hub") return emitOutcome(io, outcome(1, "mac-hub-required"), jsonOutput, "Run this command on the Mac hub.\n");
        const home = core.db.prepare("SELECT machine_id,epoch FROM session_homes WHERE session_id=?").get(argv[2]) as { machine_id: string; epoch: number } | undefined;
        if (!home?.machine_id) return emitOutcome(io, outcome(1, "participant-home-unavailable"), jsonOutput);
        const peer = core.config.peers.find(peer => peer.machineId === home.machine_id);
        if (!peer) return emitOutcome(io, outcome(1, "participant-home-not-enrolled"), jsonOutput);
        const herdr = loadHerdrConfig(root), transport = createTransport({ binary: herdr.core.binary, env: process.env, enrolled: core.config.peers });
        const operation: Operation = { id: randomUUID(), kind: `session-${argv[1]}`, machineId: peer.machineId, expectedEpoch: home.epoch,
          args: { sourceMachine: core.config.machineId, sessionId: argv[2] } };
        const handle = await transport.resolve(peer), bytes = await transport.exec(handle, ["roam", "agent", JSON.stringify(operation)],
          { timeoutMs: core.config.limits.controlMs, maxBytes: core.config.limits.replyBytes });
        const result = parseRoamJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown> | null;
        if (!result || typeof result !== "object" || Array.isArray(result) || result.operationId !== operation.id || typeof result.code !== "number" || ![0, 1, 2, 3].includes(result.code) || typeof result.reason !== "string") throw new Error("Invalid control response");
        return emitOutcome(io, result as unknown as Outcome<unknown>, jsonOutput, `${clean(result.reason)}\n`);
      } finally { core.close(); }
    } catch { return emitOutcome(io, outcome(1, "participant-control-unavailable"), jsonOutput, "Participant control is unavailable. Run spider roam doctor.\n"); }
  }
  if (argv[0] === "roam" && argv[1] === "sync") {
    let config;
    try { config = readLocalIdentity(root); }
    catch { return emitOutcome(io, outcome(1, "sync-unavailable"), jsonOutput, "Roaming synchronization is unavailable.\n"); }
    if (config.role !== "hub") return emitOutcome(io, outcome(1, "mac-hub-required"), jsonOutput, "Run this command on the Mac hub.\n");
    if (!config.enabled) return emitOutcome(io, outcome(1, "roaming-disabled"), jsonOutput, "Roaming synchronization is unavailable while disabled.\n");
    const peer = argv[2] === undefined ? undefined : config.peers.find(candidate => candidate.alias === argv[2] || candidate.machineId === argv[2]);
    if (argv[2] !== undefined && !peer) return emitOutcome(io, outcome(2, "machine-not-enrolled"), jsonOutput, "Machine is not enrolled.\n");
    try {
      const reply = await requestHubControl(join(root, "roam", "hub.sock"), peer ? { op: "sync", machine: peer.machineId } : { op: "sync" });
      const outcomes = Array.isArray(reply.value?.outcomes) ? reply.value.outcomes : [];
      const failure = outcomes.map(value => value && typeof value === "object" && !Array.isArray(value) && value.code === 1 &&
        isPeerFailureReason(value.reason) ? value.reason : null).find(Boolean);
      return emitOutcome(io, { ...reply, operationId: reply.operationId ?? "", home: reply.home ?? null, epoch: reply.epoch ?? null, repairCommand: reply.repairCommand ?? null },
        jsonOutput, `${clean(failure ? `${reply.reason}. ${failure}` : reply.reason)}\n`);
    } catch { return emitOutcome(io, outcome(1, "hub-unavailable"), jsonOutput, "The roaming hub is unavailable.\n"); }
  }
  if (argv[0] === "roam" && argv[1] === "status") {
    try {
      const status = runLocalStatus({ root });
      if (jsonOutput) io.out(`${JSON.stringify(status.enabled ? { ...status, code: 0, reason: "status-complete", operationId: "", home: null, epoch: null, repairCommand: null } : status)}\n`);
      else {
        const number = (value: number | null) => value === null ? "unknown" : String(value);
        const timestamp = (value: number | null) => value === null ? "unknown" : new Date(value).toISOString();
        io.out(`Roaming is ${status.enabled ? "enabled" : "disabled"}. Status is cached${status.complete ? "" : " and incomplete or unavailable"}.\n`);
        for (const home of status.homes) io.out(`Home ${clean(home.sessionId)}: ${clean(home.machineId)} (epoch ${home.epoch}).\n`);
        for (const session of status.homeConflicts) io.out(`Home conflict: ${clean(session)}.\n`);
        for (const peer of status.peers) io.out(`Peer ${clean(peer.alias)}: ${peer.connected === null ? "connection unknown" : peer.connected ? "connected" : "disconnected"}; last sync ${timestamp(peer.lastSyncAt)}; observation age ${number(peer.observationAgeMs)} ms; backlog ${number(peer.backlog)}${peer.failure ? `; ${clean(peer.failure)}` : ""}.\n`);
        for (const store of status.stores) {
          io.out(`Store ${clean(store.key)}: head ${store.head}, ${store.changes} changes, log ${number(store.logBytes)} bytes, versions ${number(store.versionBytes)} bytes, ${store.tombstones} tombstones.\n`);
          for (const cursor of store.cursors) io.out(`  Cursor ${clean(cursor.machineId)} / ${clean(cursor.stream)}: ${cursor.through}.\n`);
        }
        for (const warning of status.warnings) io.out(`Warning ${clean(warning.machineId)}: ${clean(warning.kind)}.\n`);
        for (const item of status.suspensions) io.out(`Suspended ${clean(item.sessionId)} on ${clean(item.machineId)} (epoch ${item.epoch}).\n`);
        if (status.sourceCleanups === null) io.out("Source cleanup: unknown.\n");
        else for (const item of status.sourceCleanups) io.out(`${sourceCleanupStatusText(item)}\n`);
        if (status.incompleteOperations === null) io.out("Incomplete operations: unknown.\n");
        else for (const operation of status.incompleteOperations) io.out(`Incomplete ${clean(operation.kind)}: ${clean(operation.id)} on ${clean(operation.machineId)}.\n`);
        for (const diagnostic of status.diagnostics) io.out(`${clean(diagnostic.reason)}\n`);
      }
      return 0;
    } catch {
      return emitOutcome(io, outcome(1, "status-unavailable"), jsonOutput, "Cannot inspect local roaming status. No data was changed.\n");
    }
  }
  if (argv[0] === "roam" && argv[1] === "doctor") {
    try {
      if (argv.length === 2) {
        let config: ReturnType<typeof readLocalIdentity> | undefined;
        try { config = readLocalIdentity(root); }
        catch { if (existsSync(join(root, "roam", "config.json"))) throw new Error("roaming-config-unavailable"); }
        if (!config || !config.enabled) {
          let rows: Awaited<ReturnType<typeof peerEnabledDiagnostics>> = [];
          if (config?.role === "hub" && config.peers.length) {
            try {
              const herdr = loadHerdrConfig(root), transport = createTransport({ binary: herdr.core.binary, env: process.env, enrolled: config.peers });
              rows = await peerEnabledDiagnostics(config, transport);
            } catch { rows = config.peers.map(peer => ({ reason: `peer-enabled-unavailable:${peer.machineId}`, severity: "warning" as const, repairCommand: "spider roam doctor" })); }
          }
          rows.push(...localHostingWarningDiagnostics(root));
          if (jsonOutput) io.out(`${JSON.stringify({ ...outcome(0, "roaming-disabled"), value: { enabled: false, diagnostics: rows, consumers: [] } })}\n`);
          else { io.out(`${MOVE_REFUSAL_MESSAGES["roaming-disabled"]}\n`); for (const row of rows) io.out(`${clean(row.reason)}\n`); }
          return 0;
        }
      }
      let report: Awaited<ReturnType<typeof runLocalDoctor>>;
      if (argv.length === 2) report = await runLocalDoctor({ root, bundleUrl: options?.bundleUrl, inspectIntercomDoctor: true, intercomDoctor: options?.intercomDoctor });
      else {
        const config = readLocalIdentity(root);
        if (config.role !== "hub") return emitOutcome(io, outcome(1, "mac-hub-required"), jsonOutput, "Run remote doctor on the Mac hub.\n");
        const peer = config.peers.find(candidate => candidate.alias === argv[2] || candidate.machineId === argv[2]);
        if (!peer) return emitOutcome(io, outcome(2, "machine-not-enrolled"), jsonOutput, "Machine is not enrolled.\n");
        const herdr = loadHerdrConfig(root);
        report = await remoteDoctor(createTransport({ binary: herdr.core.binary, env: process.env, enrolled: config.peers }), peer, config);
        report = { ...report, consumers: report.enabled ? report.consumers : [], diagnostics: [
          ...(report.enabled ? report.diagnostics : report.diagnostics.filter(row => row.severity === "warning" && row.code === HOSTING_WARNING_CODE)),
          ...(report.enabled !== config.enabled ? [{ reason: `peer-enabled-mismatch:${peer.machineId}`, severity: "warning" as const,
            repairCommand: config.enabled ? "spider roam enable" : "spider roam disable" }] : []),
        ] };
      }
      if (argv.length === 2) {
        report = { ...report, diagnostics: [...report.diagnostics, ...readMoveBindingDiagnostics(root)] };
        let config: ReturnType<typeof readLocalIdentity> | undefined;
        try { config = readLocalIdentity(root); } catch { /* Local doctor already reports invalid or missing configuration. */ }
        if (config?.enabled && !config.intercom.enabled) report = { ...report, diagnostics: [...report.diagnostics,
          { reason: "intercom-move-port-unavailable: Intercom federation is disabled.", severity: "block", repairCommand: null }] };
        if (config?.role === "hub" && config.peers.length) {
          try {
            const herdr = loadHerdrConfig(root), transport = createTransport({ binary: herdr.core.binary, env: process.env, enrolled: config.peers });
            report = { ...report, diagnostics: [...report.diagnostics, ...await peerEnabledDiagnostics(config, transport)] };
          } catch { report = { ...report, diagnostics: [...report.diagnostics, ...config.peers.map(peer => ({ reason: `peer-enabled-unavailable:${peer.machineId}`, severity: "warning" as const, repairCommand: "spider roam doctor" }))] }; }
        }
      }
      const code = report.diagnostics.some(diagnostic => diagnostic.severity === "block") ? 1 : 0;
      if (jsonOutput) {
        const value = { enabled: report.enabled, diagnostics: report.diagnostics.map(row => ({ ...row, reason: clean(row.reason),
          repairCommand: row.repairCommand === null ? null : clean(row.repairCommand) })),
          consumers: report.consumers.map(row => ({ ...row, machine: clean(row.machine), build: clean(row.build) })) };
        io.out(`${JSON.stringify({ ...outcome(code, !report.enabled ? "roaming-disabled" : code ? "doctor-blocked" : "doctor-complete"), value })}\n`);
        return code;
      }
      io.out(`${report.enabled ? "Roaming is enabled." : MOVE_REFUSAL_MESSAGES["roaming-disabled"]}\n`);
      if (report.enabled) io.out("sqlite3 CLI requires 3.38 to write a migrated store and 3.42 for roaming capture.\n");
      for (const consumer of report.consumers) io.out(`${clean(consumer.machine)}: ${consumer.kind} PID ${consumer.pid} loaded build ${clean(consumer.build)}${consumer.roamSchema === null ? "" : `, roaming schema ${consumer.roamSchema}`}.\n`);
      for (const diagnostic of report.diagnostics) io.out(`${clean(diagnostic.reason)}\n`);
      return code;
    } catch (error) {
      const failure = argv.length > 2 ? peerFailureReason(error) : null;
      return emitOutcome(io, outcome(1, failure ?? "doctor-unavailable"), jsonOutput,
        failure ? `${failure}. No data was changed.\n` : argv.length > 2 ? "Remote doctor is unavailable. No data was changed.\n" : "Cannot inspect local roaming state. No data was changed.\n");
    }
  }
  io.err("This roaming command is unavailable in this build.\n");
  return 1;
}
