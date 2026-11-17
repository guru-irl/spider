import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { parseLocationStores } from "@spider/db-core/roam/catalog";
import { startPrivateControl, requestPrivateControl } from "./control-socket";
import type { IntercomLifecycle, Operation, RoamConfig } from "./contracts";
import type { SupervisorPorts } from "./supervisor";
import { participantLaunchId } from "./participant-runtime";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { openDbReadOnly, type Db } from "@spider/db-core";
import { readSessionState } from "@spider/db-core/roam/state";
import type { Probe, HubOperationReadiness, JsonObject, StoreKey } from "@spider/db-core/roam/types";
import type { AgentPorts, Clock, Diagnostic, HostIntent, Outcome } from "./contracts";
import { createIntentStore } from "./intent";
import { assertBoxEnrollment, participantCaptureInitialized, createRunningIntentAuthority } from "./session-control";
import { createDurableLaunchPort, createSupervisor, type LaunchReservation } from "./supervisor";
import { sessionHome } from "./homes";
import { recordSupervisorExits } from "./intercom-exclusion";

export function unfinishedFreeze(root: string, id: string): boolean {
  const db = openDbReadOnly(join(root, "roam", "journal.db")); if (!db) return false;
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='freeze_journal'").get()) return false;
    return Boolean(db.prepare("SELECT 1 FROM freeze_journal WHERE session_id=? AND (state IS NULL OR state NOT IN ('complete','aborted')) LIMIT 1").get(id));
  } finally { db.close(); }
}
export async function stopParticipantWithExclusion(db: Db, sessionId: string, before: Probe, stop: () => Promise<Probe>,
  confirmExit?: (identity: { pid: number; startTime: string }) => Promise<boolean>): Promise<Probe> {
  const result = await stop();
  if (before.kind === "live" && result.kind === "absent" && confirmExit && await confirmExit(before.identity)) {
    recordSupervisorExits(db, sessionId, before.identity);
  }
  return result;
}
export function createParticipantSupervisor(input: {
  root: string; agent: AgentPorts; clock: Clock; identityCurrent?(): Promise<boolean>;
  connection?: SupervisorPorts["connection"]; events: { subscribe(listener: () => void): () => void };
  /** Refresh external stop evidence before reading authoritative intent. */
  beforeInspect?(sessionId: string): Promise<void>;
  owner(intent: HostIntent): Promise<Probe>;
  diagnostics(intent: HostIntent): Promise<readonly Diagnostic[]>;
  launch(intent: HostIntent, operationId: string, mode: "initial" | "reconcile"): Promise<Outcome<HubOperationReadiness>>;
  stop(sessionId: string): Promise<Probe>;
  cancelStop?(sessionId: string): void;
  confirmExit?(identity: { pid: number; startTime: string }): Promise<boolean>;
  notify(sessionId: string, reason: string): Promise<void>;
}): { reconcile(): Promise<void>; start(): void; stop(): Promise<void> } {
  assertBoxEnrollment(input.agent.config);
  const global = input.agent.openStore("global").db, authority = createRunningIntentAuthority(global), intents = createIntentStore(input.root);
  const authorized = (id: string) => authority.authorized(id, input.agent.config.hubMachineId, input.agent.config.machineId);
  const trusted = { ...authority,
    async list() { if (readLocal(global, "supervisor-revoked", input.agent.config.machineId)) return []; if (input.identityCurrent && !await input.identityCurrent()) return []; return (await authority.list()).filter(authorized); },
    async get(id: string) {
      const revoked = () => Boolean(readLocal(global, "supervisor-revoked", input.agent.config.machineId));
      if (revoked() || !authorized(id)) return null;
      await input.beforeInspect?.(id);
      return !revoked() && authorized(id) ? authority.get(id) : null;
    },
  };
  async function inspect(id: string) {
    if (!participantCaptureInitialized(global, input.agent.config.machineId, "global")) throw new Error("Participant capture is not initialized");
    const intent = await trusted.get(id); if (!intent) throw new Error("Participant intent unavailable");
    const row = global.prepare("SELECT stores_json FROM roam_locations WHERE session_id=?").get(id) as { stores_json: string } | undefined;
    const keys = parseLocationStores(row ? JSON.parse(row.stores_json) : null).filter(key => key.startsWith("worktree:"));
    if (!keys.length) throw new Error("Participant stores unavailable");
    let origin: string | null = null;
    const states = keys.map(key => {
      const { db } = input.agent.openStore(key), state = readSessionState(db, id);
      if (!state || !participantCaptureInitialized(db, input.agent.config.machineId, key)) throw new Error("Participant store unavailable");
      const row = db.prepare("SELECT origin_machine FROM sessions WHERE id=?").get(id) as { origin_machine: string } | undefined;
      if (!row?.origin_machine || origin !== null && origin !== row.origin_machine) throw new Error("Participant origin conflict");
      origin = row.origin_machine; return state;
    });
    const conflict = global.prepare("SELECT 1 FROM session_homes WHERE session_id=? AND machine_id=''").get(id);
    return { home: conflict ? "conflict" as const : sessionHome(global, id), origin, localMachine: input.agent.config.machineId,
      states, unfinishedFreeze: unfinishedFreeze(input.root, id), intent, owner: await input.owner(intent), diagnostics: await input.diagnostics(intent) };
  }
  const restartHistory = (intent: HostIntent) => {
    const operationId = authority.operationId(intent.sessionId);
    if (!operationId) throw new Error("participant-intent-unavailable");
    const launchId = participantLaunchId(input.agent.config.machineId, intent.sessionId, intent.epoch, operationId), id = `${launchId}-restarts`;
    input.agent.journal.begin({ id, kind: "participant-restarts", machineId: input.agent.config.machineId, expectedEpoch: intent.epoch,
      args: { sessionId: intent.sessionId, operationId, file: intent.file, cwd: intent.cwd, moveId: intent.moveId } });
    const entries = input.agent.journal.read(id).filter(row => row.action === "restart");
    if (entries.some((row, index) => row.result.sequence !== index + 1)) throw new Error("participant-restart-journal-invalid");
    return { id, launchId, entries };
  };
  const launch = createDurableLaunchPort({ intents,
    async authorize(intent) {
      const observation = await inspect(intent.sessionId), latest = await trusted.get(intent.sessionId);
      return Boolean(latest?.desired === "running" && latest.suspended === null && latest.epoch === intent.epoch && latest.file === intent.file && latest.cwd === intent.cwd &&
        observation.owner.kind === "absent" && !observation.unfinishedFreeze && !observation.diagnostics.some(row => row.severity === "block"));
    },
    async invoke(request: { intent: HostIntent; mode: "initial" | "reconcile"; reservation: LaunchReservation }) {
      return input.launch(request.intent, request.reservation.operationId, request.mode);
    },
    operationId(intent) {
      const { launchId, entries } = restartHistory(intent);
      return entries.length ? `${launchId}-restart-${entries.length}` : launchId;
    },
  });
  return createSupervisor({ connection: input.connection, clock: input.clock, journal: input.agent.journal, intents, runningIntents: trusted, events: input.events,
    inspect, launch,
    async restart(intent, previous) {
      if (previous.kind === "idle") throw new Error("participant-restart-unproved");
      const { id, entries } = restartHistory(intent);
      const proof: JsonObject = previous.kind === "launching" ? { ...previous } : { kind: previous.kind, stableSince: previous.stableSince,
        identity: { bootId: previous.identity.bootId, pid: previous.identity.pid, startTime: previous.identity.startTime } };
      if (!entries.some(row => isDeepStrictEqual(row.result.previous, proof))) {
        input.agent.journal.record(id, "restart", { sequence: entries.length + 1, previous: proof });
      }
    },
    async stop(id) {
      const intent = await trusted.get(id), before = intent ? await input.owner(intent) : { kind: "uncertain" as const };
      return stopParticipantWithExclusion(global, id, before, () => input.stop(id), input.confirmExit);
    }, cancelStop: input.cancelStop, notify: input.notify });
}

function parseRetirement(bytes: Buffer): Operation | null {
  try {
    const op = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Operation;
    if (!op || op.kind !== "supervisor-retire" || typeof op.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(op.id) || op.expectedEpoch !== null || !op.args || Object.keys(op.args).sort().join() !== "reply,sourceMachine") return null;
    return op;
  } catch { return null; }
}
export function supervisorRetirementLifecycle(root: string, config: RoamConfig, stopSessions: () => Promise<void>, previous?: IntercomLifecycle): IntercomLifecycle {
  let server: Awaited<ReturnType<typeof startPrivateControl>> | undefined;
  return { ...previous, diagnostics: () => previous?.diagnostics() ?? [], async start() {
    await previous?.start();
    server = await startPrivateControl(join(root, "roam", "retire.sock"), parseRetirement, async operation => {
      const reply = operation.args.reply as unknown as import("./revocation").SyncHandshake;
      if (config.role !== "box" || operation.machineId !== config.machineId || operation.args.sourceMachine !== config.hubMachineId || !reply || reply.kind !== "retire-only" || reply.reason !== "machine-revoked" || reply.machineId !== config.machineId) return { code: 1, reason: "recovery-authority-unavailable", operationId: operation.id, value: null };
      await stopSessions();
      return { code: 0, reason: "retired", operationId: operation.id, value: { stopped: true } };
    });
  }, async stop() { try { await server?.close(); } finally { await previous?.stop(); } } };
}
export async function requestSupervisorRetirement(root: string, operation: Operation, config: RoamConfig): Promise<Outcome<import("@spider/db-core/roam/types").JsonObject>> {
  const reply = await requestPrivateControl(join(root, "roam", "retire.sock"), operation, parseRetirement, { timeoutMs: config.limits.controlMs });
  return { ...reply, operationId: operation.id, home: null, epoch: null, repairCommand: null };
}

/** Retirement is permanent for this enrolled machine identity, including locally originated sessions. */
export async function retireParticipantSessions(agent: AgentPorts, stop: (sessionId: string) => Promise<Probe>): Promise<void> {
  const global = agent.openStore("global").db, authority = createRunningIntentAuthority(global);
  writeLocal(global, "supervisor-revoked", agent.config.machineId, true);
  const locations = global.prepare("SELECT session_id,file,cwd,stores_json FROM roam_locations").all() as { session_id: string; file: string; cwd: string; stores_json: string }[];
  const ids = new Set([...await authority.list(), ...locations.map(row => row.session_id)]);
  let pending = false;
  for (const id of ids) {
    try {
      const existing = await authority.get(id), location = locations.find(row => row.session_id === id);
      if (!existing) {
        const home = sessionHome(global, id);
        if (!location) throw new Error("retirement-evidence-unavailable");
        const memberships = (JSON.parse(location.stores_json) as StoreKey[]).filter(key => key.startsWith("worktree:")).map(key => {
          const state = agent.openStore(key).db.prepare("SELECT epoch,move_id FROM roam_sessions WHERE session_id=?").get(id) as { epoch: number; move_id: string | null } | undefined;
          if (!state) throw new Error("retirement-evidence-unavailable"); return state;
        });
        const epoch = home && home !== "unknown" ? home.epoch : memberships[0]?.epoch;
        const moveId = home && home !== "unknown" ? home.moveId : memberships[0]?.move_id ?? null;
        if (!epoch || (!home || home === "unknown") && memberships.some(row => row.epoch !== epoch)) throw new Error("retirement-evidence-unavailable");
        await authority.set({ sessionId: id, epoch, desired: "stopped", suspended: null, file: location.file, cwd: location.cwd, moveId }, `retire-${id}`, { machineId: agent.config.machineId, hubMachineId: agent.config.hubMachineId });
      } else await authority.stop(id);
      if ((await stop(id)).kind !== "absent") throw new Error("retirement-pending");
      if (location) for (const key of JSON.parse(location.stores_json) as StoreKey[]) if (key.startsWith("worktree:")) {
        agent.openStore(key).db.prepare("UPDATE roam_sessions SET state='retired' WHERE session_id=?").run(id);
      }
    } catch { pending = true; }
  }
  if (pending) throw new Error("retirement-pending");
}
