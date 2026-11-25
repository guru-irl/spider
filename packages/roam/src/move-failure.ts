import { safeMoveFailureStep, type MoveFailureStep } from "./cause-codes";

export interface MoveFailureDetail { step: MoveFailureStep; code: string }
const safeDetailCode = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value);
export function parseMoveFailure(value: unknown): MoveFailureDetail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Partial<MoveFailureDetail>, step = safeMoveFailureStep(row.step);
  return step && safeDetailCode(row.code) ? { step, code: row.code } : undefined;
}
export function moveFailureDetail(error: unknown, step: MoveFailureStep): MoveFailureDetail {
  const row = error && typeof error === "object" ? error as { code?: unknown; failure?: unknown } : {};
  return parseMoveFailure(row.failure) ?? { step, code: safeDetailCode(row.code) ? row.code : "unknown" };
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
  "move-adapter-unavailable", "move-workspace-unmapped", "move-checkout-conflict", "move-first-home-withheld"] as const;
export type MoveCauseCode = typeof moveCauses[number];

export function safeMoveCause(value: unknown): MoveCauseCode | undefined {
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
export function moveFailureRepair(cause: MoveCauseCode): string {
  if (cause === "move-first-home-withheld") return "Restore the reported store on the named machine, then retry the move.";
  if (cause === "move-workspace-unmapped") return "Run spider roam repo map <repo> <path> on the destination, then retry the move.";
  return cause === "participant-pi-unavailable"
    ? "Install pi or set SPIDER_ROAM_PI to its executable, then run spider roam doctor."
    : "Run spider roam doctor and repair the participant configuration.";
}
