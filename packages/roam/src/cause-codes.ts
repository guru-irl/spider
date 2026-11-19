import { constants as osConstants } from "node:os";

const nativeHcCodes = new Set<string>(["unreachable", "not_found", "machine_not_found", "invalid_params", "server_stopped"]);
const causeCodes = new Set<string>([
  ...Object.keys(osConstants.errno), ...nativeHcCodes,
  "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_OUT_OF_RANGE", "ERR_INVALID_STATE",
  "ERR_STREAM_DESTROYED", "ERR_STREAM_PREMATURE_CLOSE", "ERR_SOCKET_CLOSED", "ERR_IPC_CHANNEL_CLOSED",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "ERR_BUFFER_TOO_LARGE", "ERR_FS_FILE_TOO_LARGE",
  "SQLITE_ERROR", "SQLITE_INTERNAL", "SQLITE_PERM", "SQLITE_ABORT", "SQLITE_BUSY", "SQLITE_LOCKED",
  "SQLITE_NOMEM", "SQLITE_READONLY", "SQLITE_INTERRUPT", "SQLITE_IOERR", "SQLITE_CORRUPT", "SQLITE_FULL",
  "SQLITE_CANTOPEN", "SQLITE_PROTOCOL", "SQLITE_SCHEMA", "SQLITE_TOOBIG", "SQLITE_CONSTRAINT", "SQLITE_MISMATCH",
  "SQLITE_MISUSE", "SQLITE_AUTH", "SQLITE_RANGE", "SQLITE_NOTADB", "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_READONLY_RECOVERY", "SQLITE_READONLY_CANTLOCK", "SQLITE_READONLY_DBMOVED",
  "SQLITE_CONSTRAINT_CHECK", "SQLITE_CONSTRAINT_FOREIGNKEY", "SQLITE_CONSTRAINT_NOTNULL",
  "SQLITE_CONSTRAINT_PRIMARYKEY", "SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_TRIGGER",
  "diagnostic-snapshot-changing", "diagnostic-snapshot-wal-invalid", "diagnostic-snapshot-wal-unpublished",
  "diagnostic-snapshot-wal-index-missing", "diagnostic-snapshot-unsafe",
  "missing-hc", "spawn-error", "spawn_failed", "stdin-error", "cli-error", "cli-aborted", "cli-exit", "cli-timeout",
  "connection-refused", "connection-closed", "machine-not-found", "machine-ambiguous", "machine-not-enrolled", "machine-mismatch",
  "peer-invalidated", "core-unavailable", "core-changed", "reply-too-large", "invalid-reply", "invalid-config", "invalid-operation",
  "invalid-byte-limit", "invalid-cli-deadline", "unresolved-peer", "service-not-loaded", "service-failed", "service-timeout", "service-spawn-error",
]);

const steps = [
  "stores", "inventory", "enable-capture", "recheck-store", "export", "import", "release-export", "split", "assemble", "cursor", "receipt",
  "enable", "enable-peer-capture", "enable-local-capture", "enable-peer-flag", "enable-config", "enable-service",
  "disable", "disable-service", "disable-config", "disable-peer-flag",
  "enrollment", "read-fences", "notify-peers", "record-enrollment", "register-pair", "check-connector", "inspect-ssh", "bind-pair", "host-connector", "connect-connector",
  "ensure-key", "write-known-host", "authorize", "approve-pair", "add-machine", "verify-transport", "publish-pair", "verify-pair",
] as const;
export type CauseStep = typeof steps[number];
const fallbackCodes = new Set<string>(steps.map(step => `unexpected-${step}`));

/** A native stderr kind is data, never exception text or an arbitrary identifier. */
export function safeNativeHcCode(value: unknown): string | undefined {
  return typeof value === "string" && nativeHcCodes.has(value) ? value : undefined;
}

/** Only named codes and fixed operation steps can cross a machine or CLI boundary. */
export function safeCauseCode(value: unknown): string | undefined {
  return typeof value === "string" && (causeCodes.has(value) || fallbackCodes.has(value)) ? value : undefined;
}
export function causeCode(error: unknown, step: CauseStep): string {
  const code = error && typeof error === "object" && "code" in error ? safeCauseCode(error.code) : undefined;
  const peerCause = error && typeof error === "object" && "causeCode" in error ? safeCauseCode(error.causeCode) : undefined;
  return code ?? peerCause ?? `unexpected-${step}`;
}
