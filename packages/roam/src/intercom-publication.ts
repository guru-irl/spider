import { HELPER_EXCHANGE_ERRORS } from "@spider/intercom/helper-errors";
import type { Db } from "@spider/db-core";
import { safeCauseCode } from "./cause-codes";
import type { Diagnostic, Journal } from "./contracts";
import type { IntercomPairRecord } from "./intercom-registry";

export type PublicationStep = "publish-config" | "enroll-live";
export type PublicationSide = "source" | "target";
export interface PublicationFailure { step: PublicationStep; side: PublicationSide; causeCode?: string }

const messages: Record<PublicationStep, ReadonlySet<string>> = {
  "publish-config": new Set(["intercom-mode-not-peers", "intercom-route-missing", "intercom-edge-must-be-revoked", "invalid-intercom-config", "machine-mismatch", "peer-consent-required"]),
  "enroll-live": new Set([...HELPER_EXCHANGE_ERRORS, "broker-unavailable", "helper-timeout", "bridge-exchange-failed", "unsafe-helper-route"]),
};
const preciseRefusals = new Set(["fresh-peer-consent-required", "host-key-changed", "revocation-pending", "intercom-ssh-host-unverified"]);

/** Retain only exact, known local reasons; native codes already have their own boundary. */
export function localPublicationError(error: unknown, step: PublicationStep): unknown {
  if (!(error instanceof Error) || !messages[step].has(error.message) || !safeCauseCode(error.message) ||
      "code" in error && safeCauseCode(error.code)) return error;
  return Object.assign(new Error(error.message), { code: error.message });
}

/** Wrap no exception text: the prior precise refusals must remain unchanged. */
export class PublicationError extends Error {
  readonly publication: PublicationFailure;
  readonly code?: string;
  constructor(step: PublicationStep, side: PublicationSide, error: unknown) {
    const reason = error instanceof Error && preciseRefusals.has(error.message) ? error.message : "intercom-publication-failed";
    super(reason);
    const native = error && typeof error === "object" && "code" in error ? safeCauseCode(error.code) : undefined;
    const peer = error && typeof error === "object" && "causeCode" in error ? safeCauseCode(error.causeCode) : undefined;
    const named = error instanceof Error && messages[step].has(error.message) ? safeCauseCode(error.message) : undefined;
    const code = native ?? peer ?? named;
    this.publication = { step, side, ...(code ? { causeCode: code } : {}) };
    if (code) this.code = code;
  }
}

export function parsePublicationFailure(value: unknown): PublicationFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!(row.step === "publish-config" || row.step === "enroll-live") || !(row.side === "source" || row.side === "target") ||
      row.causeCode !== undefined && !safeCauseCode(row.causeCode)) return null;
  return { step: row.step, side: row.side, ...(typeof row.causeCode === "string" ? { causeCode: row.causeCode } : {}) };
}
export function publicationText(value: PublicationFailure): string {
  return `publication ${value.step} on ${value.side}${value.causeCode ? ` [${value.causeCode}]` : ""}`;
}

/** Diagnostic writes never decide whether enrollment can progress. */
export function recordPublicationFailure(journal: Journal, operationId: string, pairId: string, publication: PublicationFailure | null): void {
  try {
    const previous = journal.read(operationId).filter(row => row.action === "intercom-publication" && row.result.pairId === pairId).at(-1)?.result;
    const prior = parsePublicationFailure(previous?.publication);
    if (publication === null ? !previous || previous.publication === null : prior && prior.step === publication.step && prior.side === publication.side && prior.causeCode === publication.causeCode) return;
    journal.record(operationId, "intercom-publication", { pairId, publication: publication === null ? null : { ...publication } });
  } catch { /* Missing diagnostic storage cannot alter the refusal or its retry. */ }
}

/** Read only the latest diagnostic for each still-pending pair and operation. */
export function publicationDiagnostics(db: Db, records: readonly IntercomPairRecord[]): Diagnostic[] {
  const query = db.prepare(`SELECT a.result_json FROM roam_operation_actions a
    JOIN roam_operations o ON o.operation_id=a.operation_id
    WHERE o.operation_id=? AND o.kind='intercom-enrollment' AND o.result_json IS NULL
      AND a.action='intercom-publication'
      AND CASE WHEN json_valid(a.result_json) THEN json_extract(a.result_json, '$.pairId') END=?
    ORDER BY a.seq DESC LIMIT 1`);
  const diagnostics: Diagnostic[] = [];
  for (const record of records) {
    if (record.state !== "pending") continue;
    const row = query.get(record.operationId, record.pair.pairId) as { result_json: string } | undefined;
    if (!row) continue;
    try {
      const value: unknown = JSON.parse(row.result_json);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const failure = parsePublicationFailure((value as Record<string, unknown>).publication);
      if (failure) diagnostics.push({ severity: "warning", reason: `${record.pair.pairId}: ${publicationText(failure)}.`, repairCommand: null });
    } catch { /* Invalid retained evidence is never displayed. */ }
  }
  return diagnostics;
}
