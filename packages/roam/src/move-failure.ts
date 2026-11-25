import { safeCauseCode, safeMoveFailureStep, type MoveFailureStep } from "./cause-codes";
import { MOVE_REFUSAL_MESSAGES } from "./contracts";
import { ownershipFailureCode, ownershipRepair, type OwnershipFailureCode } from './ownership-failure';
import { isMachineId } from "./machine-id";

export interface MoveFailureDetail { step: MoveFailureStep; code: string }
// A bounded token can still contain private data. Only registered codes may leave the adapter.
const safeDetailCode = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value) &&
  (value === "unknown" || Object.hasOwn(MOVE_REFUSAL_MESSAGES, value) || safeMoveCause(value) !== undefined || safeCauseCode(value) !== undefined);
export function parseMoveFailure(value: unknown): MoveFailureDetail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Partial<MoveFailureDetail>, step = safeMoveFailureStep(row.step);
  return step && safeDetailCode(row.code) ? { step, code: row.code } : undefined;
}
export function moveFailureDetail(error: unknown, step: MoveFailureStep): MoveFailureDetail {
  const row = error && typeof error === "object" ? error as { code?: unknown; failure?: unknown; refusal?: { code?: unknown } } : {};
  const code = row.code ?? row.refusal?.code;
  return parseMoveFailure(row.failure) ?? { step, code: safeDetailCode(code) ? code : "unknown" };
}

export class MoveStepError extends Error {
  readonly failure: MoveFailureDetail;
  constructor(step: MoveFailureStep, error: unknown) {
    super("Move adapter failed", { cause: error });
    this.failure = moveFailureDetail(error, step);
  }
}
export async function withMoveStep<T>(step: MoveFailureStep, effect: () => T | Promise<T>): Promise<T> {
  try { return await effect(); }
  catch (error) { throw error instanceof MoveStepError ? error : new MoveStepError(step, error); }
}

const moveCauses = ["participant-pi-unavailable", "participant-stores-unavailable", "participant-config-unavailable",
  "participant-context-unavailable", "participant-home-unavailable", "participant-freeze-unfinished", "participant-cwd-unavailable",
  "participant-header-invalid", "participant-header-mismatch", "participant-store-mapping-failed", "participant-seed-failed",
  "move-adapter-unavailable", "move-workspace-unmapped", "move-checkout-conflict", "move-first-home-withheld", "move-session-dir-unsupported",
  "supervisor-release-unavailable", "supervisor-identity-unavailable", "supervisor-root-mismatch", "supervisor-release-mismatch",
  "workspace-prerequisite-missing", "workspace-prerequisite-invalid", "workspace-fetch-unavailable"] as const;
export type MoveCauseCode = typeof moveCauses[number] | OwnershipFailureCode;

export function safeMoveCause(value: unknown): MoveCauseCode | undefined {
  const ownership = ownershipFailureCode(value);
  if (ownership) return ownership;
  return typeof value === "string" && (moveCauses as readonly string[]).includes(value) ? value as MoveCauseCode : undefined;
}
export function moveFailureCause(error: unknown): MoveCauseCode {
  if (error instanceof MoveStepError) return moveFailureCause(error.cause);
  return error && typeof error === "object" && "code" in error ? safeMoveCause(error.code) ?? "move-adapter-unavailable" : "move-adapter-unavailable";
}
export class MoveCompositionError extends Error {
  readonly code: MoveCauseCode;
  readonly failure?: MoveFailureDetail;
  constructor(cause: unknown, failure?: MoveFailureDetail) {
    const code = safeMoveCause(cause) ?? "move-adapter-unavailable";
    super(code); this.code = code; this.failure = parseMoveFailure(failure);
  }
}
const prerequisiteRepairs = ["fetch a shared merge base on the destination", "fetch the required commits on the destination",
  "fetch the required commits on both machines"] as const;
export function isSupervisorMoveCause(cause: MoveCauseCode): boolean {
  return cause === "supervisor-release-unavailable" || cause === "supervisor-identity-unavailable" ||
    cause === "supervisor-root-mismatch" || cause === "supervisor-release-mismatch";
}
/** Only fixed guidance and a validated destination identity may cross the adapter boundary. */
export function safeMoveRepair(cause: MoveCauseCode, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (cause === "workspace-prerequisite-missing" && (prerequisiteRepairs as readonly string[]).includes(value)) return value;
  if (cause === "workspace-prerequisite-invalid" && value === "verify the Git history on both machines") return value;
  if (cause === "workspace-fetch-unavailable" && value === "fetch origin on the destination") return value;
  if (isSupervisorMoveCause(cause) && value.startsWith("spider roam provision ") && isMachineId(value.slice("spider roam provision ".length))) return value;
  return undefined;
}
export function moveRepairCommand(cause: MoveCauseCode, destinationMachine: string, hint?: string): string | undefined {
  if (isSupervisorMoveCause(cause) && isMachineId(destinationMachine)) return `spider roam provision ${destinationMachine}`;
  if (cause === "workspace-prerequisite-missing") return safeMoveRepair(cause, hint) ?? prerequisiteRepairs[1];
  if (cause === "workspace-prerequisite-invalid") return "verify the Git history on both machines";
  if (cause === "workspace-fetch-unavailable") return "fetch origin on the destination";
  return undefined;
}
export function prerequisiteRepair(error: unknown): string {
  if (error instanceof MoveStepError) return prerequisiteRepair(error.cause);
  const row = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; repairCommand?: unknown } : {};
  const prefix = "workspace-prerequisite-missing: ";
  const message = typeof row.message === "string" && row.message.startsWith(prefix) ? row.message.slice(prefix.length) : undefined;
  return safeMoveRepair("workspace-prerequisite-missing", row.repairCommand) ?? safeMoveRepair("workspace-prerequisite-missing", message) ?? prerequisiteRepairs[1];
}
export function moveFailureRepair(cause: MoveCauseCode, repair?: unknown): string {
  if (isSupervisorMoveCause(cause)) return `Run ${safeMoveRepair(cause, repair) ?? "spider roam provision <machine>"} to restore the destination supervisor, then retry or recover the move.`;
  if (cause === "workspace-prerequisite-missing") return `To proceed, ${safeMoveRepair(cause, repair) ?? prerequisiteRepairs[1]}, then retry or recover the move.`;
  if (cause === "workspace-prerequisite-invalid") return "You can verify the Git history on both machines, then retry or recover the move.";
  if (cause === "workspace-fetch-unavailable") return "Check Git credentials and fetch origin on the destination, then retry or recover the move.";
  const ownership = ownershipFailureCode(cause);
  if (ownership) return ownershipRepair(ownership);
  if (cause === "move-session-dir-unsupported") return "Roaming requires the transcript to be in the agent's sessions folder. Restart the session without --session-dir.";
  if (cause === "move-first-home-withheld") return "Restore the reported store on the named machine, then retry the move.";
  if (cause === "move-workspace-unmapped") return "Run spider roam repo map <repo> <path> on the destination, then retry the move.";
  return cause === "participant-pi-unavailable"
    ? "Install pi or set SPIDER_ROAM_PI to its executable, then run spider roam doctor."
    : "Run spider roam doctor and repair the participant configuration.";
}
