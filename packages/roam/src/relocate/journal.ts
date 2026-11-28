import { isAbsolute } from "node:path";
import type { MachineId, JsonObject } from "@spider/db-core/roam/types";
import { storeScope } from "@spider/db-core/roam/codec";
import { isMachineId } from "../machine-id";
import type { Journal } from "../contracts";
import type { InstalledSession, RelocateCheckpoint, RelocateId, RelocateHome, RelocateJournal, RelocatePlan, RelocateStep, SessionPlacement } from "./types";

export const steps: readonly RelocateStep[] = ["check", "mark-moving", "stop-source", "pull-source", "push-destination", "install-destination", "commit-home", "start-destination", "confirm"];
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Invalid v0 object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid v0 text");
}
function integer(value: unknown, min = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error("Invalid v0 integer");
}
function path(value: unknown): void { text(value); if (!isAbsolute(value)) throw new Error("Invalid v0 path"); }
function machine(value: unknown): void { if (!isMachineId(value)) throw new Error("Invalid v0 machine"); }
function nullableText(value: unknown): void { if (value !== null) text(value); }
function strings(value: unknown): void { if (!Array.isArray(value)) throw new Error("Invalid v0 list"); value.forEach(text); }
export function parseHome(value: unknown): RelocateHome {
  const h = object(value); text(h.sessionId); machine(h.machineId); integer(h.epoch, 1); integer(h.updatedAt); nullableText(h.moveId);
  if (h.state === "moving") { text(h.moveId); machine(h.destination); if (h.destination === h.machineId) throw new Error("Invalid moving home"); }
  else if (!["running", "stopped"].includes(h.state as string) || h.destination !== null) throw new Error("Invalid v0 home");
  return value as RelocateHome;
}
export function parsePlacement(value: unknown): SessionPlacement {
  const p = object(value); text(p.sessionId); machine(p.machineId); machine(p.historyMachine); text(p.repoKey); text(p.workspaceId);
  path(p.repository); path(p.cwd); path(p.file);
  if (!Array.isArray(p.stores) || !p.stores.length || new Set(p.stores).size !== p.stores.length) throw new Error("Invalid v0 stores");
  p.stores.forEach(storeScope);
  return value as SessionPlacement;
}
export function parsePlan(value: unknown): RelocatePlan {
  const p = object(value); text(p.moveId); if (!(p.moveId as string).startsWith("v0-")) throw new Error("Invalid v0 move");
  const h = parseHome(p.source), s = parsePlacement(p.sourcePlacement), d = parsePlacement(p.destinationPlacement);
  if (h.state === "moving" || h.sessionId !== s.sessionId || s.sessionId !== d.sessionId || h.machineId !== s.machineId || s.machineId === d.machineId || s.repoKey !== d.repoKey || s.workspaceId !== d.workspaceId || s.historyMachine !== d.historyMachine) throw new Error("Invalid relocate plan");
  strings(p.destinationPrerequisites); integer(p.startedAt);
  return value as RelocatePlan;
}
function manifest(value: unknown): void {
  const m = object(value); path(m.file); text(m.sessionId); path(m.cwd); text(m.leaf); integer(m.size); text(m.artifactId);
  for (const key of ["sha256", "historySha256"]) if (typeof m[key] !== "string" || !/^[a-f0-9]{64}$/.test(m[key])) throw new Error("Invalid session hash");
}
function artifact(value: unknown): void {
  const a = object(value); text(a.id); if (!["session", "workspace"].includes(a.kind as string)) throw new Error("Invalid artifact kind"); integer(a.byteLength);
  if (typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256) || !Array.isArray(a.chunks)) throw new Error("Invalid artifact");
  let length = 0;
  a.chunks.forEach((value, index) => { const c = object(value); if (c.index !== index) throw new Error("Invalid chunk index"); integer(c.rawLength, 1); if (typeof c.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(c.sha256)) throw new Error("Invalid chunk hash"); length += c.rawLength; });
  if (length !== a.byteLength) throw new Error("Invalid artifact length");
}
export function parseCaptured(value: unknown): RelocateCheckpoint["captured"] & {} {
  const c = object(value); manifest(c.session); artifact(c.transcriptArtifact); artifact(c.bundleArtifact);
  const w = object(c.workspace); path(w.root); text(w.repoKey); text(w.workspaceId); text(w.moveId); text(w.head); nullableText(w.branch); text(w.indexTree); text(w.workingTree);
  if (w.stage !== "final" || !["sha1", "sha256"].includes(w.objectFormat as string)) throw new Error("Invalid snapshot");
  if (typeof w.relativeCwd !== "string" || isAbsolute(w.relativeCwd) || w.relativeCwd.split(/[\\/]/).includes("..")) throw new Error("Invalid relative cwd");
  nullableText(w.sparsePatterns); nullableText(w.worktreeConfig); strings(w.droppedConfigKeys); strings(w.refs); strings(w.prerequisites);
  const n = object(w.normalization); nullableText(n.autocrlf); nullableText(n.eol);
  const s = object(w.sparse); if (typeof s.enabled !== "boolean" || !(s.cone === null || typeof s.cone === "boolean")) throw new Error("Invalid sparse state");
  const b = object(w.bundle); if (b.kind !== "ready") throw new Error("Unbundled snapshot"); text(b.artifactId); integer(b.byteLength);
  return value as RelocateCheckpoint["captured"] & {};
}
export function parseCheckpoint(value: unknown): RelocateCheckpoint {
  const c = object(value), p = parsePlan(c.plan);
  if (!Array.isArray(c.completed) || c.completed.some((s, i) => s !== steps[i])) throw new Error("Invalid checkpoint order");
  if (c.captured !== null) { const captured = parseCaptured(c.captured); if (captured.workspace.moveId !== p.moveId || captured.session.sessionId !== p.source.sessionId) throw new Error("Mismatched capture"); }
  if (c.installed !== null) { const installed = object(c.installed); parsePlacement(installed.placement); manifest(installed.session); }
  nullableText(c.terminal);
  if (c.result !== null) { const r = object(c.result); const h = parseHome(r.home); parsePlacement(r.placement); nullableText(r.moveId); text(r.terminal); if (h.state !== "running" || h.sessionId !== p.source.sessionId || !["relocated", "already-home", "undone"].includes(r.disposition as string)) throw new Error("Invalid relocate result"); }
  return value as RelocateCheckpoint;
}
export function json(value: unknown): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }
const installedAction = "relocate-installed";
export function recordInstalledSession(journal: Journal, moveId: RelocateId, installed: InstalledSession): void {
  journal.record(moveId, installedAction, json({ installed }));
}
export function readInstalledPlacement(journal: Journal, moveId: RelocateId): SessionPlacement | undefined {
  const record = journal.read(moveId).findLast(row => row.action === installedAction);
  return record && parsePlacement(object(record.result.installed).placement);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
}
export function createRelocateJournal(journal: Journal, hubMachineId: MachineId): RelocateJournal {
  function load(moveId: string): RelocateCheckpoint | null {
    const rows = journal.read(moveId).filter(row => row.action === "relocate-checkpoint");
    if (!rows.length) return null;
    let previous: RelocateCheckpoint | null = null;
    for (const row of rows) {
      const checkpoint = parseCheckpoint(row.result.checkpoint);
      if (checkpoint.plan.moveId !== moveId || previous && canonical(previous.plan) !== canonical(checkpoint.plan)) throw new Error("Conflicting journal plan");
      previous = checkpoint;
    }
    return previous;
  }
  return {
    async load(moveId) { return load(moveId); },
    async save(value) {
      const checkpoint = parseCheckpoint(value), plan = checkpoint.plan;
      const begun = journal.begin({id:plan.moveId,machineId:hubMachineId,expectedEpoch:plan.source.epoch,kind:"relocate-v0",args:json({plan})});
      const previous = load(plan.moveId);
      if (previous && canonical(previous) === canonical(checkpoint)) return;
      if (begun.kind === "done") throw new Error("Relocate operation already completed");
      if (previous && (canonical(previous.plan) !== canonical(plan) || previous.completed.length > checkpoint.completed.length)) throw new Error("Conflicting checkpoint");
      journal.record(plan.moveId,"relocate-checkpoint",json({checkpoint}));
      if (checkpoint.result) journal.record(plan.moveId,"done",json({result:checkpoint.result}));
    },
  };
}
