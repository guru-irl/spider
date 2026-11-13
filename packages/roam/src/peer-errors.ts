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
