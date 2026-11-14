import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Db } from "@spider/db-core";
import { localEntries, readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import type { SessionEndpoint } from "@spider/intercom/protocol";
import type { SessionGenerationExclusion } from "./intercom-contracts";

export type NativeProcess = { kind: "absent" } | { kind: "unknown" } | { kind: "live"; startIdentity: string };
export interface GenerationProcess { version: 1; sessionId: string; generation: string; pid: number; startIdentity: string }
export interface SupervisorExitProof extends GenerationProcess { confirmed: "stop-exited" }
const generationKind = "intercom-generation", exitKind = "intercom-supervisor-exit";
const key = (sessionId: string, generation: string) => JSON.stringify([sessionId, generation]);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
function parse(value: unknown, exit: boolean): GenerationProcess | SupervisorExitProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("intercom-exclusion-invalid");
  const row = value as Record<string, unknown>, fields = exit ? ["version", "sessionId", "generation", "pid", "startIdentity", "confirmed"] : ["version", "sessionId", "generation", "pid", "startIdentity"];
  if (Object.keys(row).length !== fields.length || !fields.every(field => Object.hasOwn(row, field)) || row.version !== 1 ||
      !text(row.sessionId) || !text(row.generation) || !Number.isSafeInteger(row.pid) || Number(row.pid) <= 0 || !text(row.startIdentity) ||
      exit && row.confirmed !== "stop-exited") throw new Error("intercom-exclusion-invalid");
  return row as unknown as GenerationProcess | SupervisorExitProof;
}
function writeOnce(db: Db, kind: string, row: GenerationProcess | SupervisorExitProof): void {
  const id = key(row.sessionId, row.generation), prior = readLocal<unknown>(db, kind, id);
  if (prior !== undefined && JSON.stringify(parse(prior, kind === exitKind)) !== JSON.stringify(row)) throw new Error("intercom-exclusion-conflict");
  if (prior === undefined) writeLocal(db, kind, id, row);
}
/** An inaccessible process is unknown, never evidence of exit. */
export function probeIntercomProcess(pid: number): NativeProcess {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unknown" };
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? { kind: "absent" } : { kind: "unknown" }; }
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
      if (fields[0] === "Z") return { kind: "absent" };
      return fields[19] ? { kind: "live", startIdentity: `linux:${fields[19]}` } : { kind: "unknown" };
    }
    if (process.platform === "win32") return { kind: "unknown" };
    const start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim();
    return start ? { kind: "live", startIdentity: `posix:${start}` } : { kind: "unknown" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && process.platform === "linux") {
      try { process.kill(pid, 0); } catch (again) { if ((again as NodeJS.ErrnoException).code === "ESRCH") return { kind: "absent" }; }
    }
    return { kind: "unknown" };
  }
}
export function recordIntercomGeneration(db: Db, input: { sessionId: string; generation: string; pid: number }, probe: (pid: number) => NativeProcess = probeIntercomProcess): void {
  const observed = probe(input.pid);
  if (observed.kind !== "live") throw new Error("intercom-process-identity-unavailable");
  const row: GenerationProcess = { version: 1, sessionId: input.sessionId, generation: input.generation, pid: input.pid, startIdentity: observed.startIdentity };
  parse(row, false); db.raw.transaction(() => writeOnce(db, generationKind, row)).immediate();
}
/** Called only after the supervisor's stop port confirms the observed process exited. */
export function recordSupervisorExits(db: Db, sessionId: string, identity: { pid: number; startTime: string }): void {
  db.raw.transaction(() => {
    for (const entry of localEntries<unknown>(db, generationKind)) {
      const row = parse(entry.value, false) as GenerationProcess;
      if (entry.key !== key(row.sessionId, row.generation)) throw new Error("intercom-exclusion-invalid");
      if (row.sessionId === sessionId && row.pid === identity.pid && row.startIdentity === identity.startTime) {
        const proof: SupervisorExitProof = { ...row, confirmed: "stop-exited" }; writeOnce(db, exitKind, proof);
      }
    }
  }).immediate();
}
export function hasIntercomGeneration(db: Db, sessionId: string, generation: string): boolean {
  const raw = readLocal<unknown>(db, generationKind, key(sessionId, generation));
  if (raw === undefined) return false;
  const row = parse(raw, false) as GenerationProcess;
  if (row.sessionId !== sessionId || row.generation !== generation) throw new Error("intercom-exclusion-invalid");
  return true;
}
export function intercomExclusion(db: Db, owner: SessionEndpoint, probe: (pid: number) => NativeProcess = probeIntercomProcess): SessionGenerationExclusion | undefined {
  const id = key(owner.address.sessionId, owner.activationEpoch), raw = readLocal<unknown>(db, generationKind, id);
  if (raw === undefined) return undefined;
  const row = parse(raw, false) as GenerationProcess;
  if (row.sessionId !== owner.address.sessionId || row.generation !== owner.activationEpoch) throw new Error("intercom-exclusion-invalid");
  const stopped = readLocal<unknown>(db, exitKind, id);
  if (stopped !== undefined) {
    const proof = parse(stopped, true) as SupervisorExitProof;
    if (proof.sessionId !== row.sessionId || proof.generation !== row.generation || proof.pid !== row.pid || proof.startIdentity !== row.startIdentity) throw new Error("intercom-exclusion-conflict");
    return { owner, excludedGeneration: owner.activationEpoch, kind: "owner-exited" };
  }
  const current = probe(row.pid);
  if (current.kind === "absent" || current.kind === "live" && current.startIdentity !== row.startIdentity) {
    return { owner, excludedGeneration: owner.activationEpoch, kind: "owner-exited" };
  }
  return undefined;
}
