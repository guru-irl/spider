import { safeCauseCode } from "./cause-codes";
import { safeMoveCause, moveFailureRepair } from "./move-failure";

const stages = ["preparation", "ownership", "move-bindings", "live-freeze", "socket-publication"] as const;
export type MoveSetupStage = typeof stages[number];
export interface MoveSetupFailure { stage: MoveSetupStage; causeCode: string }
const ownershipCodes = ["session-id-owner", "session-file-owner", "unsafe-state-path", "launch-environment-invalid",
  "participant-not-box", "participant-capture-uninitialized", "participant-stopped", "participant-hub-intent-required",
  "participant-launch-provenance-unavailable", "participant-owner-unproved"];
function safeSetupCause(value: unknown): string | undefined {
  return safeMoveCause(value) ?? safeCauseCode(value) ?? (typeof value === "string" && ownershipCodes.includes(value) ? value : undefined);
}
export function parseMoveSetupFailure(value: unknown): MoveSetupFailure | null {
  if (!value || typeof value !== "object") return null;
  const { stage, causeCode } = value as Partial<MoveSetupFailure>;
  if (!(stages as readonly unknown[]).includes(stage) || !(causeCode === "setup-unavailable" || safeSetupCause(causeCode))) return null;
  return { stage: stage as MoveSetupStage, causeCode: causeCode! };
}
export function moveSetupFailure(stage: MoveSetupStage, error: unknown): MoveSetupFailure {
  const value = error && typeof error === "object" ? error as { setupStage?: unknown; code?: unknown; message?: unknown } : {};
  return { stage: (stages as readonly unknown[]).includes(value.setupStage) ? value.setupStage as MoveSetupStage : stage,
    causeCode: safeSetupCause(value.code) ?? safeMoveCause(value.message) ??
      (typeof value.message === "string" && ownershipCodes.includes(value.message) ? value.message : "setup-unavailable") };
}
export class MoveSetupError extends Error {
  readonly setupStage: MoveSetupStage;
  readonly code: string;
  constructor(stage: MoveSetupStage, error: unknown) {
    const failure = moveSetupFailure(stage, error);
    super("Move setup failed"); this.setupStage = failure.stage; this.code = failure.causeCode;
  }
}
export function moveSetupRepair(failure: MoveSetupFailure): string {
  const cause = safeMoveCause(failure.causeCode);
  return cause ? moveFailureRepair(cause) : "Run spider roam doctor, repair the local setup, then reload this session.";
}
export function moveSetupMessage(failure: MoveSetupFailure): string {
  return `Move setup failed at ${failure.stage} (${failure.causeCode}). ${moveSetupRepair(failure)}`;
}
