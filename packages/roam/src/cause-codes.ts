import { constants as osConstants } from "node:os";
import { HELPER_EXCHANGE_ERRORS } from "@spider/intercom/helper-errors";

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
  "ROAM_MAPPING_FENCED", "diagnostic-snapshot-changing", "diagnostic-snapshot-wal-invalid", "diagnostic-snapshot-wal-unpublished",
  "diagnostic-snapshot-wal-index-missing", "diagnostic-snapshot-unsafe",
  "missing-hc", "spawn-error", "spawn_failed", "stdin-error", "cli-error", "cli-aborted", "cli-exit", "cli-timeout",
  "active-release-unavailable", "active-release-layout-invalid", "invalid-intercom-readiness",
  ...HELPER_EXCHANGE_ERRORS, "broker-unavailable", "helper-timeout", "bridge-exchange-failed", "unsafe-helper-route",
  "intercom-mode-not-peers", "intercom-route-missing", "intercom-edge-must-be-revoked", "invalid-intercom-config",
  "broker-start-timeout", "broker-start-aborted", "broker-start-exited", "broker-start-failed", "unsafe-broker-start", "unsupported-broker",
  "intercom-pair-unit-missing",
  "intercom-broker-unavailable", "intercom-broker-not-spider", "intercom-agent-unsafe", "intercom-directory-unsafe", "intercom-socket-unsafe", "federation-feature-missing",
  "legacy-pending-asks", "legacy-pending-asks-unavailable", "settings-unavailable", "settings-resolution-unavailable", "legacy-extension-declared",
  "settings-spider-invalid", "settings-spider-missing", "settings-spider-duplicate", "broker-readiness-unconfirmed",
  "intercom-pair-revocation-incomplete", "intercom-pair-fence-conflict", "intercom-revocation-unconfirmed",
  "intercom-revocation-remote-fence-pending", "intercom-revocation-cleanup-pending", "intercom-fence-mismatch", "unsafe-pair-key",
  "connection-refused", "connection-closed", "machine-not-found", "machine-ambiguous", "machine-not-enrolled", "machine-mismatch",
  "inspection-unavailable", "participant-capture-uninitialized", "launch-unavailable", "launch-pending", "provisioned-pi-unavailable", "participant-exited-before-readiness", "exit-status-unavailable",
  "peer-invalidated", "core-unavailable", "core-changed", "reply-too-large", "invalid-reply", "invalid-config", "invalid-operation",
  "invalid-byte-limit", "invalid-cli-deadline", "unresolved-peer", "service-not-loaded", "service-failed", "service-timeout", "service-spawn-error",
]);

const agentOperationKinds = ["stores", "stores-retire", "inventory", "enable-capture", "recheck-store", "export", "import", "release-export", "split", "assemble", "cursor", "receipt",
  "mirror-export", "sync-handshake", "supervisor-retire"] as const;
export type AgentOperationKind = typeof agentOperationKinds[number];
const agentKindSet = new Set<string>(agentOperationKinds);
export function safeAgentOperationKind(value: unknown): AgentOperationKind | undefined {
  return typeof value === "string" && agentKindSet.has(value) ? value as AgentOperationKind : undefined;
}

export const MOVE_FAILURE_STEPS = [
  "preflight", "workspace-plan", "source-inspect", "destination-diagnostics", "power", "seed", "seed-barriers",
  "initial-home", "source-home-replicate", "remote-prepare", "freeze", "intercom-inspect", "transfer", "final-barriers",
  "generation-check", "verify-source", "home-commit", "home-replicate", "start", "same-home-inspect", "destination-inspect",
  "destination-endpoint", "intercom-ready", "source-retire", "final-inspect", "cleanup", "power-release",
] as const;
export type MoveFailureStep = typeof MOVE_FAILURE_STEPS[number];
export function safeMoveFailureStep(value: unknown): MoveFailureStep | undefined {
  return typeof value === "string" && (MOVE_FAILURE_STEPS as readonly string[]).includes(value) ? value as MoveFailureStep : undefined;
}

export function moveOperationStep(kind: string, stage?: unknown): MoveFailureStep {
  if (["move-prerequisites", "move-export", "move-import"].includes(kind) && (stage === "pre" || stage === "final"))
    return stage === "pre" ? "remote-prepare" : "transfer";
  const steps: Readonly<Record<string, MoveFailureStep>> = {
    "move-workspace-map": "workspace-plan", "session-inspect": "source-inspect", "move-diagnostics": "destination-diagnostics",
    "move-seed": "seed", "move-prerequisites": "remote-prepare", "session-freeze": "freeze",
    "move-export": "transfer", "move-import": "transfer", "move-verify": "verify-source", "session-start": "start",
    "move-observation": "destination-inspect", "session-retire": "source-retire", "move-cleanup": "cleanup",
    "move-intercom-inspect": "intercom-inspect", "move-intercom-checkGeneration": "generation-check", "move-intercom-ready": "intercom-ready",
  };
  return steps[kind] ?? "preflight";
}

const additionalSteps = [
  "enable", "enable-broker", "enable-peer-capture", "enable-local-capture", "enable-peer-flag", "enable-config", "enable-service",
  "disable", "disable-service", "disable-config", "disable-peer-flag",
  "enrollment", "read-fences", "notify-peers", "record-enrollment", "register-pair", "check-connector", "inspect-ssh", "bind-pair", "host-connector", "connect-connector",
  "ensure-key", "write-known-host", "authorize", "approve-pair", "add-machine", "verify-transport", "publish-pair", "verify-pair",
  "revoke-pin", "revoke-remote-fence", "revoke-host", "revoke-authorization", "revoke-remote-cleanup",
] as const;
export type CauseStep = AgentOperationKind | typeof additionalSteps[number];
const fallbackCodes = new Set<string>([...agentOperationKinds, ...additionalSteps].map(step => `unexpected-${step}`));

/** A native stderr kind is data, never exception text or an arbitrary identifier. */
export function safeNativeHcCode(value: unknown): string | undefined {
  return typeof value === "string" && nativeHcCodes.has(value) ? value : undefined;
}

/** Only named codes and fixed operation steps can cross a machine or CLI boundary. */
export function safeCauseCode(value: unknown): string | undefined {
  return typeof value === "string" && (causeCodes.has(value) || fallbackCodes.has(value)) ? value : undefined;
}
const revocationGateNames = ["identity-pin-unavailable", "identity-pin-invalid", "fence-closure-unproven", "host-closure-unproven",
  "authorization-removal-unproven", "authorization-absence-unproven"] as const;
export interface RevocationGate { side: "source" | "target"; gate: typeof revocationGateNames[number]; causeCode?: string }
const revocationGateSet = new Set<string>(revocationGateNames);
/** Validate persisted or remotely supplied diagnostic data before displaying it. */
export function validRevocationGates(value: unknown): value is readonly RevocationGate[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(item => item && typeof item === "object" && !Array.isArray(item) &&
    (item.side === "source" || item.side === "target") && typeof item.gate === "string" && revocationGateSet.has(item.gate) &&
    (item.causeCode === undefined || safeCauseCode(item.causeCode) !== undefined));
}
export function formatRevocationGates(gates: readonly RevocationGate[] | undefined): string {
  return gates?.map(({ side, gate, causeCode }) => `${side}:${gate}${causeCode ? ` [${causeCode}]` : ""}`).join(", ") ?? "";
}
export function revocationCauseCode(error: unknown, step: CauseStep): string {
  const code = error && typeof error === "object" && "code" in error ? safeCauseCode(error.code) : undefined;
  const peer = error && typeof error === "object" && "causeCode" in error ? safeCauseCode(error.causeCode) : undefined;
  const named = error instanceof Error ? safeCauseCode(error.message) : undefined;
  return code ?? peer ?? named ?? `unexpected-${step}`;
}
/** Classify startup failures without exposing the broker's captured stderr. */
export function brokerStartupCause(error: unknown): string {
  const native = error && typeof error === "object" && "cause" in error ? error.cause : undefined;
  const code = native && typeof native === "object" && "code" in native ? safeCauseCode(native.code) : undefined;
  if (code) return code;
  if (error instanceof Error) {
    const message = error.message.split("\n", 1)[0];
    if (["unsafe-broker-start", "unsupported-broker", "broker-start-aborted", "active-release-unavailable", "active-release-layout-invalid", "invalid-intercom-readiness"].includes(message)) return message;
    if (message === "Broker failed to start within timeout") return "broker-start-timeout";
    if (message.startsWith("Intercom broker exited before startup")) return "broker-start-exited";
  }
  const direct = causeCode(error, "enable-broker");
  return direct === "unexpected-enable-broker" ? "broker-start-failed" : direct;
}
export function causeCode(error: unknown, step: CauseStep): string {
  const code = error && typeof error === "object" && "code" in error ? safeCauseCode(error.code) : undefined;
  const peerCause = error && typeof error === "object" && "causeCode" in error ? safeCauseCode(error.causeCode) : undefined;
  return code ?? peerCause ?? `unexpected-${step}`;
}
