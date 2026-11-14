import { isAbsolute } from "node:path";
import type { HubOperationReadiness, Readiness } from "./types";

export class ReadinessParseError extends Error {
  readonly reason: "readiness-origin-mismatch" | "readiness-invalid";
  constructor(reason: ReadinessParseError["reason"]) { super(reason); this.reason = reason; }
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
export function parseReadiness(value: unknown): Readiness {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReadinessParseError("readiness-invalid");
  const row = value as Record<string, unknown>;
  if ("operationId" in row || row.origin !== "hub-operation" && row.origin !== "box-local" ||
      row.origin === "hub-operation" && (!text(row.opId) || "machineId" in row) ||
      row.origin === "box-local" && ("opId" in row || !text(row.machineId))) throw new ReadinessParseError("readiness-origin-mismatch");
  if (![row.sessionId, row.cwd, row.file, row.core, row.terminal].every(text) || !Number.isSafeInteger(row.epoch) || (row.epoch as number) < 1 ||
      !isAbsolute(row.cwd as string) || !isAbsolute(row.file as string)) throw new ReadinessParseError("readiness-invalid");
  const common = { sessionId: row.sessionId as string, epoch: row.epoch as number, cwd: row.cwd as string, file: row.file as string,
    core: row.core as string, terminal: row.terminal as string };
  return row.origin === "hub-operation" ? { origin: row.origin, opId: row.opId as string, ...common }
    : { origin: "box-local", machineId: row.machineId as string, ...common };
}
export function parseHubReadiness(value: unknown): HubOperationReadiness {
  const ready = parseReadiness(value);
  if (ready.origin !== "hub-operation") throw new ReadinessParseError("readiness-origin-mismatch");
  return ready;
}
export function validReadiness(value: unknown): value is Readiness {
  try { parseReadiness(value); return true; } catch { return false; }
}
