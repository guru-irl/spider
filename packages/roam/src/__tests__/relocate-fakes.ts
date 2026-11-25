import { expect } from "vitest";
import type { MachineId } from "@spider/db-core/roam/types";
import type { SessionManifest } from "../contracts";
import type {
  CapturedSession, RelocateCheckpoint, RelocateHome, RelocateId, RelocatePlan,
  RelocatePorts, RunningHome, SessionId, SessionPlacement, V0Refusal, V0Result,
} from "../relocate/types";

export const sessionId = "session-1" as SessionId;
export const source = "source" as MachineId;
export const destination = "destination" as MachineId;
export const third = "third" as MachineId;
export const request = { sessionId, destinationMachine: destination };
export const ok = <T>(value: T): V0Result<T> => ({ ok: true, value });
export const refusal = (code: V0Refusal["code"]): V0Refusal => ({
  code, message: "The operation could not finish.", nextStep: "Retry spider roam relocate session-1 destination.",
});
export const running = (): RunningHome => ({
  sessionId, machineId: source, epoch: 1, state: "running", destination: null,
  moveId: null, updatedAt: 100,
});
export const placement = (machineId: MachineId): SessionPlacement => ({
  sessionId, machineId, repoKey: "repo", workspaceId: "workspace",
  repository: `/${machineId}/repo`, cwd: `/${machineId}/repo/sub`,
  file: `/${machineId}/session.jsonl`, stores: [], historyMachine: source,
});
function manifest(p: SessionPlacement, moveId: RelocateId): SessionManifest {
  return { file: p.file, sessionId, cwd: p.cwd, leaf: "leaf", size: 123,
    sha256: "a".repeat(64), historySha256: "b".repeat(64), artifactId: `${moveId}-session` };
}
function capture(plan: RelocatePlan): CapturedSession {
  return {
    session: manifest(plan.sourcePlacement, plan.moveId),
    workspace: {
      root: plan.sourcePlacement.repository, repoKey: "repo", workspaceId: "workspace",
      moveId: plan.moveId, stage: "final", head: "1".repeat(40), branch: "refs/heads/main",
      objectFormat: "sha1", indexTree: "2".repeat(40), workingTree: "3".repeat(40),
      relativeCwd: "sub", sparsePatterns: null, worktreeConfig: null, droppedConfigKeys: [],
      normalization: { autocrlf: null, eol: null }, sparse: { enabled: false, cone: null },
      refs: [], prerequisites: [], bundle: { kind: "ready", artifactId: `${plan.moveId}-bundle`, byteLength: 42 },
    },
    transcriptArtifact: { id: `${plan.moveId}-session`, kind: "session", byteLength: 123, sha256: "a".repeat(64), chunks: [] },
    bundleArtifact: { id: `${plan.moveId}-bundle`, kind: "workspace", byteLength: 42, sha256: "c".repeat(64), chunks: [] },
  };
}

export interface FakeState {
  home: RelocateHome | null;
  journal: Map<RelocateId, RelocateCheckpoint>;
  replicaHomes: Map<MachineId, RelocateHome>;
  captures: Map<RelocateId, CapturedSession>;
  pushed: Set<RelocateId>;
  installed: Map<RelocateId, string>;
  snapshots: Set<RelocateId>;
  segments: Set<RelocateId>;
  seeds: Set<SessionId>;
  backups: Set<MachineId>;
  processes: Set<MachineId>;
  effects: string[];
  attempts: string[];
  safetyViolations: string[];
  homesWritten: RelocateHome[];
  ids: number;
  locked: boolean;
  stopAcknowledged: boolean;
  failAfter: string | null;
  failBefore: string | null;
  refuse: { effect: string; code: V0Refusal["code"] } | null;
  stopBarrier: Promise<void> | null;
  casWinner: RelocateHome | null;
}
const histories: FakeState[] = [];
export function assertSafeHistories(): void {
  for (const s of histories.splice(0)) expect(s.safetyViolations).toEqual([]);
}
export function state(): FakeState {
  const result: FakeState = { home: running(), journal: new Map(), replicaHomes: new Map([[source, running()]]), captures: new Map(), pushed: new Set(),
    installed: new Map(), snapshots: new Set(), segments: new Set(), seeds: new Set(),
    backups: new Set([source]), processes: new Set([source]), effects: [], attempts: [], safetyViolations: [], homesWritten: [],
    ids: 0, locked: false, stopAcknowledged: false, failAfter: null, failBefore: null,
    refuse: null, stopBarrier: null, casWinner: null };
  histories.push(result);
  return result;
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Every new ports object sees only durable state, never another invocation's locals.
export function ports(s: FakeState): RelocatePorts {
  const before = (effect: string) => {
    s.attempts.push(effect);
    expect(s.locked).toBe(true);
    if (s.failBefore === effect) { s.failBefore = null; throw new Error("reply unavailable"); }
  };
  const effect = (name: string) => {
    s.effects.push(name);
    // Record rather than throw: production handles arbitrary port failures, so a
    // thrown assertion could otherwise masquerade as the fault being injected.
    if (s.processes.size > 1) s.safetyViolations.push(`${name}: two running copies`);
    if (s.stopAcknowledged && s.home?.state === "moving" && s.processes.size !== 0) s.safetyViolations.push(`${name}: running while moving after stop`);
    if (s.home?.machineId === destination && s.home.state === "running" && s.processes.has(source)) s.safetyViolations.push(`${name}: source runs after commit`);
    if (!s.stopAcknowledged && s.processes.has(destination)) s.safetyViolations.push(`${name}: destination runs before source stop`);
    if (s.failAfter === name) { s.failAfter = null; throw new Error("reply unavailable"); }
  };
  const perform = async <T>(name: string, run: () => T | Promise<T>): Promise<V0Result<T>> => {
    before(name);
    if (s.refuse?.effect === name) return { ok: false, refusal: refusal(s.refuse.code) };
    const value = await run();
    effect(name);
    return ok(value);
  };
  return {
    withSession: async (_id, run) => {
      expect(_id).toBe(sessionId);
      expect(s.locked).toBe(false);
      s.locked = true;
      try { return await run(); } finally { s.locked = false; }
    },
    newMoveId: () => { before("new-id"); return `v0-move-${++s.ids}` as RelocateId; },
    homes: {
      read: async id => { before("read"); expect(id).toBe(sessionId); return structuredClone(s.home); },
      list: async () => s.home ? [structuredClone(s.home)] : [],
      initialize: async (id, machineId) => {
        before("initialize"); expect(s.seeds.has(id)).toBe(true);
        s.home = { ...running(), machineId }; effect("initialize"); return structuredClone(s.home);
      },
      compareAndSwap: async (expected, next) => {
        before(`cas-${next.state}`);
        if (s.casWinner) { s.home = structuredClone(s.casWinner); s.casWinner = null; return { kind: "conflict", home: structuredClone(s.home) }; }
        if (JSON.stringify(s.home) === JSON.stringify(next)) return { kind: "already-applied", home: structuredClone(next) };
        if (JSON.stringify(s.home) !== JSON.stringify(expected)) return { kind: "conflict", home: structuredClone(s.home) };
        s.home = structuredClone(next); s.homesWritten.push(structuredClone(next));
        effect(`cas-${next.state}`);
        return { kind: "applied", home: structuredClone(next) };
      },
    },
    journal: {
      load: async id => { before("load"); return structuredClone(s.journal.get(id) ?? null); },
      save: async cp => {
        before("save"); s.journal.set(cp.plan.moveId, structuredClone(cp));
        effect(`save-${cp.completed.at(-1) ?? "empty"}`);
      },
    },
    initialSource: async () => perform("initial-source", () => { s.seeds.add(sessionId); return source; }),
    check: async (_req, home, moveId) => perform("check", () => {
      s.seeds.add(sessionId);
      return { moveId, source: structuredClone(home), sourcePlacement: placement(home.machineId),
        destinationPlacement: placement(_req.destinationMachine), destinationPrerequisites: [], startedAt: 200 };
    }),
    publishHome: async (home, machine) => perform(`publish-${machine}-${home.state}`, () => {
      expect(home).toEqual(s.home);
      s.replicaHomes.set(machine, structuredClone(home));
    }),
    stopSource: async (plan, moving) => perform("stop-source", async () => {
      expect(moving.state).toBe("moving"); expect(moving.moveId).toBe(plan.moveId);
      if (s.stopBarrier) await s.stopBarrier;
      s.processes.delete(plan.source.machineId); s.stopAcknowledged = true;
      effect("lock-free");
    }),
    pullSource: async plan => perform("pull-source", () => {
      expect(s.stopAcknowledged).toBe(true); expect(s.processes.size).toBe(0);
      if (!s.captures.has(plan.moveId)) {
        s.captures.set(plan.moveId, capture(plan)); s.snapshots.add(plan.moveId);
      }
      return structuredClone(s.captures.get(plan.moveId)!);
    }),
    pushDestination: async (plan, captured) => perform("push-destination", () => {
      expect(captured).toEqual(s.captures.get(plan.moveId)); s.pushed.add(plan.moveId);
    }),
    installDestination: async (plan, captured, home) => perform("install-destination", () => {
      expect(s.pushed.has(plan.moveId)).toBe(true); expect(captured).toEqual(s.captures.get(plan.moveId));
      expect(home).toMatchObject({ machineId: plan.destinationPlacement.machineId, state: "running", epoch: plan.source.epoch + 2, moveId: plan.moveId });
      const p = plan.destinationPlacement;
      s.segments.add(plan.moveId); s.installed.set(plan.moveId, `history\nsegment:${plan.moveId}:${home.epoch}`);
      s.backups.add(p.machineId);
      return { placement: p, session: manifest(p, plan.moveId) };
    }),
    locate: async machine => perform(`locate-${machine}`, () => placement(machine)),
    activate: async (home, p) => perform(`activate-${p.machineId}`, () => {
      expect(home.machineId).toBe(p.machineId);
      expect(s.backups.has(p.machineId)).toBe(true);
    }),
    start: async (home, p) => perform(`start-${p.machineId}`, () => {
      expect(s.home).toEqual(home); expect(home.state).toBe("running");
      expect(s.replicaHomes.get(p.machineId)).toEqual(home);
      expect(home.machineId).toBe(p.machineId); s.processes.add(p.machineId);
      return { terminal: `terminal-${p.machineId}` };
    }),
    confirm: async (home, p) => perform(`confirm-${p.machineId}`, () => {
      expect(s.home).toEqual(home); expect(s.processes.has(p.machineId)).toBe(true);
      return { terminal: `terminal-${p.machineId}` };
    }),
  };
}
