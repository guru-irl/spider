// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from "node:crypto";
import type { Journal } from "./contracts";

const phases = ["prerequisites", "export", "pull", "relay", "send", "import", "result",
  "participant-prerequisites", "participant-export", "participant-import"] as const;
const codeSources = ["code", "refusal", "message-prefix", "untyped"] as const;
export type TransferDiagnosticPhase = typeof phases[number];
type CodeSource = typeof codeSources[number];
export interface PrivateTransferDiagnostic {
  phase: TransferDiagnosticPhase; code: string; codeSource: CodeSource; fingerprint?: string;
}

function codeToken(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return typeof value === "string" && /^-?[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value) ? value : undefined;
}

export function parsePrivateTransferDiagnostic(value: unknown): PrivateTransferDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const phase = phases.find(value => value === row.phase), codeSource = codeSources.find(value => value === row.codeSource);
  if (!phase || !codeSource || typeof row.code !== "string" || codeToken(row.code) !== row.code ||
      row.fingerprint !== undefined && (typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.fingerprint))) return undefined;
  return { phase, code: row.code, codeSource,
    ...(typeof row.fingerprint === "string" ? { fingerprint: row.fingerprint } : {}) };
}

/** Private evidence only. Never copy these rows into outcomes or replicated stores. */
export async function withPrivateTransferDiagnostic<T>(journal: Journal, operationId: string,
  phase: TransferDiagnosticPhase, effect: () => T | Promise<T>): Promise<T> {
  try { return await effect(); }
  catch (error) {
    try {
      const row = error && typeof error === "object" ? error as { code?: unknown; refusal?: { code?: unknown }; message?: unknown } : {};
      const message = typeof row.message === "string" ? row.message : undefined;
      let code = codeToken(row.code), codeSource: CodeSource = "code";
      if (!code) { code = codeToken(row.refusal?.code); codeSource = "refusal"; }
      if (!code) { code = message?.match(/^([a-z][a-z0-9-]{0,63})(?::|$)/)?.[1]; codeSource = "message-prefix"; }
      if (!code) { code = "untyped-error"; codeSource = "untyped"; }
      journal.record(operationId, "move-transfer-diagnostic", { phase, code, codeSource,
        ...(message === undefined ? {} : { fingerprint: createHash("sha256").update(message).digest("hex") }) });
    } catch { /* Missing diagnostic evidence must not change the move failure. */ }
    throw error;
  }
}
