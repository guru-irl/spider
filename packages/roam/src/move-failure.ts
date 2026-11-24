const moveCauses = ["participant-pi-unavailable", "participant-stores-unavailable", "participant-config-unavailable",
  "participant-context-unavailable", "participant-home-unavailable", "move-adapter-unavailable"] as const;
export type MoveCauseCode = typeof moveCauses[number];

export function safeMoveCause(value: unknown): MoveCauseCode | undefined {
  return typeof value === "string" && (moveCauses as readonly string[]).includes(value) ? value as MoveCauseCode : undefined;
}
export function moveFailureCause(error: unknown): MoveCauseCode {
  return error && typeof error === "object" && "code" in error ? safeMoveCause(error.code) ?? "move-adapter-unavailable" : "move-adapter-unavailable";
}
export class MoveCompositionError extends Error {
  readonly code: MoveCauseCode;
  constructor(cause: unknown) {
    const code = safeMoveCause(cause) ?? "move-adapter-unavailable";
    super(code); this.code = code;
  }
}
export function moveFailureRepair(cause: MoveCauseCode): string {
  return cause === "participant-pi-unavailable"
    ? "Install pi or set SPIDER_ROAM_PI to its executable, then run spider roam doctor."
    : "Run spider roam doctor and repair the participant configuration.";
}
