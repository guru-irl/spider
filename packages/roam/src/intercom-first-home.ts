import type { Db } from "@spider/db-core";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { isFirstHomeAttestation, isRemoteSessionInfo, isSessionAddress, isSessionEndpoint, sameAddress, type FirstHomeAttestation, type RemoteSessionInfo, type SessionAddress, type SessionEndpoint } from "@spider/intercom/protocol";
import { hasIntercomGeneration } from "./intercom-exclusion";

export interface FirstHomeAdoption {
  sessionId: string;
  activation: string;
  machine: string;
  fromEpoch: null;
  toEpoch: number;
  adoptedAt: number;
}
export interface FirstHomePairResume {
  reason: "first-home-adoption";
  from: SessionAddress;
  to: SessionAddress;
  through: number;
  previousEndpoint: SessionEndpoint;
  endpoint: SessionEndpoint;
  attestation: FirstHomeAttestation;
  at: number;
}
function firstHomeTransition(previous: SessionEndpoint, current: SessionEndpoint, attestation: FirstHomeAttestation | undefined): attestation is FirstHomeAttestation {
  return previous.homeEpoch === null && sameAddress(previous.address, current.address) &&
    previous.activationEpoch === current.activationEpoch && previous.machineId === current.machineId &&
    attestation !== undefined && attestation.activation === current.activationEpoch && attestation.fromEpoch === null && attestation.toEpoch === current.homeEpoch;
}
/** The caller supplies presence from its authorized edge roster, never a dispatch argument. */
export function createFirstHomePairResume(from: SessionAddress, previousEndpoint: SessionEndpoint, endpoint: SessionEndpoint,
  presence: RemoteSessionInfo | undefined, through: number, at: number): FirstHomePairResume | undefined {
  if (!isRemoteSessionInfo(presence) || !sameAddress(presence.address, endpoint.address) || presence.machineId !== endpoint.machineId ||
      presence.activationEpoch !== endpoint.activationEpoch || presence.homeEpoch !== endpoint.homeEpoch ||
      !firstHomeTransition(previousEndpoint, endpoint, presence.firstHome)) return undefined;
  return { reason: "first-home-adoption", from, to: endpoint.address, through, previousEndpoint, endpoint, attestation: presence.firstHome, at };
}
/** These records authorize only local acceptance, not cursor gaps at another machine. */
export function isFirstHomePairResume(value: unknown): value is FirstHomePairResume {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 8 && row.reason === "first-home-adoption" && isSessionAddress(row.from) && isSessionAddress(row.to) &&
    Number.isSafeInteger(row.through) && Number(row.through) >= 1 && Number.isSafeInteger(row.at) && Number(row.at) >= 0 &&
    isSessionEndpoint(row.previousEndpoint) && isSessionEndpoint(row.endpoint) && sameAddress(row.to, row.endpoint.address) &&
    isFirstHomeAttestation(row.attestation) && firstHomeTransition(row.previousEndpoint, row.endpoint, row.attestation);
}
const kind = "intercom-first-home";
const key = (endpoint: SessionEndpoint) => JSON.stringify([endpoint.address.sessionId, endpoint.activationEpoch, endpoint.machineId]);
function parse(raw: unknown): FirstHomeAdoption {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("intercom-first-home-invalid");
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).length !== 6 || !["sessionId", "activation", "machine"].every(field => typeof row[field] === "string" && row[field].length > 0) ||
      row.fromEpoch !== null || typeof row.toEpoch !== "number" || !Number.isSafeInteger(row.toEpoch) || row.toEpoch < 1 ||
      typeof row.adoptedAt !== "number" || !Number.isSafeInteger(row.adoptedAt) || row.adoptedAt < 0) throw new Error("intercom-first-home-invalid");
  return row as unknown as FirstHomeAdoption;
}
export function readFirstHomeAdoption(db: Db, endpoint: SessionEndpoint): FirstHomeAdoption | undefined {
  const raw = readLocal<unknown>(db, kind, key(endpoint));
  return raw === undefined ? undefined : parse(raw);
}
/** Equivalence selects the same live process. It never rewrites a queued endpoint. */
export function firstHomeEndpointMatches(record: FirstHomeAdoption | undefined, queued: SessionEndpoint, live: SessionEndpoint): boolean {
  return record !== undefined && sameAddress(queued.address, live.address) && queued.homeEpoch === null &&
    queued.activationEpoch === live.activationEpoch && queued.machineId === live.machineId &&
    record.sessionId === queued.address.sessionId && record.activation === queued.activationEpoch && record.machine === queued.machineId &&
    record.fromEpoch === null && record.toEpoch === live.homeEpoch;
}
/** Called by the admitted owner after readiness, before publishing its new registration. */
export function recordFirstHomeAdoption(db: Db, previous: SessionEndpoint, current: SessionEndpoint, adoptedAt: number = Date.now()): void {
  if (!isSessionEndpoint(previous) || !isSessionEndpoint(current) || !sameAddress(previous.address, current.address) ||
      previous.homeEpoch !== null || current.homeEpoch === null || previous.machineId !== current.machineId || previous.activationEpoch !== current.activationEpoch ||
      !hasIntercomGeneration(db, previous.address.sessionId, previous.activationEpoch)) throw new Error("intercom-first-home-invalid");
  const row = parse({ sessionId: previous.address.sessionId, activation: previous.activationEpoch, machine: previous.machineId,
    fromEpoch: null, toEpoch: current.homeEpoch, adoptedAt });
  db.raw.transaction(() => {
    const prior = readLocal<unknown>(db, kind, key(previous));
    if (prior === undefined) writeLocal(db, kind, key(previous), row);
    else {
      const existing = parse(prior);
      if (existing.sessionId !== row.sessionId || existing.activation !== row.activation || existing.machine !== row.machine || existing.toEpoch !== row.toEpoch) {
        throw new Error("intercom-first-home-conflict");
      }
    }
  }).immediate();
}
