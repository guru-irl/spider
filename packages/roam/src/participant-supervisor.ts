import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openDbReadOnly } from "@spider/db-core";
import { readSessionState } from "@spider/db-core/roam/state";
import type { Probe, HubOperationReadiness, StoreKey } from "@spider/db-core/roam/types";
import type { AgentPorts, Clock, Diagnostic, HostIntent, Outcome } from "./contracts";
import { createIntentStore } from "./intent";
import { assertBoxEnrollment, participantCaptureInitialized, createRunningIntentAuthority } from "./session-control";
import { createDurableLaunchPort, createSupervisor, type LaunchReservation } from "./supervisor";
import { sessionHome } from "./homes";

export function unfinishedFreeze(root: string, id: string): boolean {
  const db = openDbReadOnly(join(root, "roam", "journal.db")); if (!db) return false;
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='freeze_journal'").get()) return false;
    return Boolean(db.prepare("SELECT 1 FROM freeze_journal WHERE session_id=? AND (state IS NULL OR state NOT IN ('complete','aborted')) LIMIT 1").get(id));
  } finally { db.close(); }
}
export function createParticipantSupervisor(input: {
  root: string; agent: AgentPorts; clock: Clock; identityCurrent?(): Promise<boolean>; events: { subscribe(listener: () => void): () => void };
  owner(intent: HostIntent): Promise<Probe>;
  diagnostics(intent: HostIntent): Promise<readonly Diagnostic[]>;
  launch(intent: HostIntent, operationId: string, mode: "initial" | "reconcile"): Promise<Outcome<HubOperationReadiness>>;
  stop(sessionId: string): Promise<Probe>;
  notify(sessionId: string, reason: string): Promise<void>;
}): { reconcile(): Promise<void>; start(): void; stop(): Promise<void> } {
  assertBoxEnrollment(input.agent.config);
  const global = input.agent.openStore("global").db, authority = createRunningIntentAuthority(global), intents = createIntentStore(input.root);
  const authorized = (id: string) => authority.authorized(id, input.agent.config.hubMachineId, input.agent.config.machineId);
  const trusted = { ...authority,
    async list() { if (input.identityCurrent && !await input.identityCurrent()) return []; return (await authority.list()).filter(authorized); },
    async get(id: string) { return authorized(id) ? authority.get(id) : null; },
  };
  async function inspect(id: string) {
    if (!participantCaptureInitialized(global, input.agent.config.machineId, "global")) throw new Error("Participant capture is not initialized");
    const intent = await trusted.get(id); if (!intent) throw new Error("Participant intent unavailable");
    const row = global.prepare("SELECT stores_json FROM roam_locations WHERE session_id=?").get(id) as { stores_json: string } | undefined;
    const keys: unknown = row && JSON.parse(row.stores_json);
    if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== "string" || !key.startsWith("worktree:"))) throw new Error("Participant stores unavailable");
    let origin: string | null = null;
    const states = (keys as StoreKey[]).map(key => {
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
  const launch = createDurableLaunchPort({ intents,
    async authorize(intent) {
      const observation = await inspect(intent.sessionId), latest = await trusted.get(intent.sessionId);
      return Boolean(latest?.desired === "running" && latest.suspended === null && latest.epoch === intent.epoch && latest.file === intent.file && latest.cwd === intent.cwd &&
        observation.owner.kind === "absent" && !observation.unfinishedFreeze && !observation.diagnostics.some(row => row.severity === "block"));
    },
    async invoke(request: { intent: HostIntent; mode: "initial" | "reconcile"; reservation: LaunchReservation }) {
      return input.launch(request.intent, request.reservation.operationId, request.mode);
    },
    operationId() { return randomUUID(); },
  });
  return createSupervisor({ clock: input.clock, journal: input.agent.journal, intents, runningIntents: trusted, events: input.events,
    inspect, launch, stop: input.stop, notify: input.notify });
}
