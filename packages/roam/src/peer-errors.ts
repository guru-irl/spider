const agentReasons = ["store-inventory-incomplete", "agent-operation-failed", "capture-unsafe"] as const;
type AgentFailureCode = typeof agentReasons[number];
export function agentFailureCode(reason: unknown): AgentFailureCode | null {
  return typeof reason === "string" && (agentReasons as readonly string[]).includes(reason) ? reason as AgentFailureCode : null;
}
export class AgentResponseError extends Error {
  constructor(readonly check: AgentFailureCode | "peer-response-invalid") { super("Peer agent refused the operation"); }
}

const unreachableCodes = ["machine-not-found", "core-unavailable", "connection-refused", "connection-closed", "missing-hc", "spawn-error", "spawn_failed"];
export function peerErrorCode(error: unknown): string | null {
  if (error instanceof AgentResponseError) return error.check;
  if (!(error instanceof Error) || error.name !== "HerdrError" || !("code" in error) || typeof error.code !== "string") return null;
  return [...unreachableCodes, "cli-exit", "cli-timeout", "peer-invalidated", "core-changed", "reply-too-large"].includes(error.code) ? error.code : null;
}

/** Never infer connectivity from a participant's answered application error. */
export function peerPreflightIssue(error: unknown, name: string, argument: string): { reason: string; repairCommand: string; detail?: string } {
  const code = error instanceof Error && error.name === "HerdrError" && "code" in error ? error.code : null;
  const detail = peerFailureReason(error);
  if (typeof code === "string" && unreachableCodes.includes(code))
    return { reason: `box-unreachable:${name}`, repairCommand: `spider roam forget ${argument}`, ...(detail ? { detail } : {}) };
  const check = error instanceof AgentResponseError ? error.check : code === "cli-exit" ? "peer-command-failed" : code === "cli-timeout" ? "peer-command-timeout" : "peer-response-invalid";
  return { reason: `preflight-failed:${name}:${check}`, repairCommand: `spider roam doctor ${argument}`, ...(detail ? { detail } : {}) };
}

/** Produce a bounded diagnostic without copying a peer's stderr into status. */
export function peerFailureReason(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "HerdrError" || !("code" in error) || typeof error.code !== "string") return null;
  const { code, details } = error as Error & { code: string; details?: unknown };
  if (code === "missing-hc" || code === "spawn-error") return `Peer command failed (${code})`;
  if (!details || typeof details !== "object") return null;
  const { exitCode, signal } = details as { exitCode?: unknown; signal?: unknown };
  if (typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode > 0 && exitCode <= 255) {
    if (code === "cli-exit") return `Peer command failed (exit ${exitCode})`;
    if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(code)) return `Peer command failed (${code})`;
  }
  if (code === "cli-exit" && exitCode === null && typeof signal === "string" && /^SIG[A-Z0-9]{1,16}$/.test(signal)) {
    return `Peer command failed (signal ${signal})`;
  }
  return null;
}

export function isPeerFailureReason(reason: unknown): reason is string {
  return typeof reason === "string" && /^Peer command failed \((?:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}|exit [1-9][0-9]{0,2}|signal SIG[A-Z0-9]{1,16})\)$/.test(reason);
}
