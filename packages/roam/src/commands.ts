import type { RoamStatus } from "./diagnostics";
import { isAbsolute } from "node:path";
import { MOVE_REFUSAL_MESSAGES, type MoveRefusal, type MoveRefusalCode, type SourceCleanup, type Outcome, type RoamConfig } from "./contracts";
import { validateBlockerId, parseSourceCleanup } from "./move";
import { isPeerFailureReason } from "./peer-errors";
import { INTERCOM_UNIQUENESS_DESCRIPTION } from "./intercom-readiness";
import { storeScope } from "@spider/db-core/roam/codec";

export type PublicControl =
  | { kind: "status" | "sync" | "doctor" | "enable" | "disable"; machine?: string }
  | { kind: "move" | "claim"; session: string; machine: string }
  | { kind: "recover" | "cancel"; operationId: string }
  | { kind: "stop" | "resume"; session: string }
  | { kind: "forget"; machine: string; confirmation: string }
  | { kind: "repo-map"; repoKey: string; path: string }
  | { kind: "memory-tag"; storeKey: string; uuid: string; machine: string }
  | { kind: "provision"; machine: string; options: readonly string[] };
const plain = (value: string | undefined): value is string => !!value && value.length <= 1024 && !/[\u0000-\u0020\u007f]/.test(value) && !value.startsWith("-");
export function parsePublicControl(input: readonly string[]): PublicControl | null {
  const args = input.at(-1) === "--json" ? input.slice(0, -1) : input;
  const [group, command, a, b, c, d] = args;
  if (group === "move") return args.length === 3 && plain(command) && plain(a) ? { kind: "move", session: command, machine: a } : null;
  if (group !== "roam") return null;
  if (["status", "enable", "disable"].includes(command) && args.length === 2) return { kind: command as "status" | "enable" | "disable" };
  if (command === "sync" || command === "doctor") {
    if (args.length === 2) return { kind: command };
    if (args.length === 3 && plain(a)) return { kind: command, machine: a };
    if (args.length === 4 && ["--", "--machine"].includes(a) && b && b.length <= 1024 && !/[\u0000-\u0020\u007f]/.test(b)) return { kind: command, machine: b };
  }
  if ((command === "recover" || command === "cancel") && args.length === 3 && plain(a)) return { kind: command, operationId: a };
  if ((command === "stop" || command === "resume") && args.length === 3 && plain(a)) return { kind: command, session: a };
  if (command === "claim" && args.length === 4 && plain(a) && plain(b)) return { kind: command, session: a, machine: b };
  if (command === "forget" && args.length === 5 && plain(a) && b === "--confirm" && /^destroyed [A-Za-z0-9._-]+$/.test(c)) return { kind: command, machine: a, confirmation: c };
  if (command === "repo" && a === "map" && args.length === 5 && plain(b) && plain(c) && isAbsolute(c)) return { kind: "repo-map", repoKey: b, path: c };
  if (command === "memory" && a === "tag" && plain(b) && plain(c)) {
    const machine = args.length === 6 && plain(d) ? d
      : args.length === 7 && d === "--" && args[6] && args[6].length <= 1024 && !/[\u0000-\u0020\u007f]/.test(args[6]) ? args[6] : null;
    if (!machine) return null;
    try { if (storeScope(b) === "worktree") return null; } catch { return null; }
    return { kind: "memory-tag", storeKey: b, uuid: c, machine };
  }
  if (command === "provision" && plain(a)) {
    const seen = new Set<string>();
    for (let i = 3; i < args.length; i++) {
      const flag = args[i];
      if (!["--release", "--yes", "--no-settings", "--consent", "--operation-id", "--skill", "--consent-provider"].includes(flag) || seen.has(flag) && !["--skill", "--consent-provider"].includes(flag)) return null;
      seen.add(flag);
      if (["--yes", "--no-settings"].includes(flag)) continue;
      if (!plain(args[++i]) || flag === "--release" && !isAbsolute(args[i])) return null;
    }
    return { kind: "provision", machine: a, options: args.slice(3) };
  }
  return null;
}
export function controlRefusal(control: PublicControl, config: RoamConfig): string | null {
  if (!config.enabled && !["status", "doctor", "enable", "disable", "provision", "forget", "stop"].includes(control.kind)) return "roaming-disabled";
  if (config.role === "box" && !(control.kind === "status" || control.kind === "repo-map" || control.kind === "doctor" && control.machine === undefined)) return "mac-hub-required";
  return null;
}
export function resolveControlSession(target: string, catalog: readonly { id: string; name: string | null }[]): { sessionId: string } | { reason: string; candidates: string[] } {
  const exact = catalog.find(row => row.id === target);
  if (exact) return { sessionId: exact.id };
  const candidates = [...new Set(catalog.filter(row => row.id.startsWith(target) || row.name === target).map(row => row.id))].sort();
  return candidates.length === 1 ? { sessionId: candidates[0] } : { reason: candidates.length ? "ambiguous-session" : "session-not-found", candidates };
}
export function resolveControlMachine(target: string, config: RoamConfig): string | null {
  if (target === "mac" || target === config.hubMachineId) return config.hubMachineId;
  const matches = config.peers.filter(peer => peer.machineId === target || peer.alias === target);
  return matches.length === 1 ? matches[0].machineId : null;
}
const token = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value) ? value : null;
export type SafeControlOutcome = Outcome<unknown> & { refusal?: MoveRefusal };
const syncReasons = new Set(["Synchronization complete", "Synchronization needs attention", "Hub synchronization is disabled", "Machine is not enrolled",
  "Peer store is quarantined", "Peer store is quarantined or invalid", "Operation journal result is pending reconciliation", "Peer operation is pending reconciliation",
  "Invalid saved manifest page", "Invalid journal result", "Enrolled machine identity does not match", "Invalid peer outcome", "Invalid peer value", "Invalid peer cursor",
  "Invalid export manifest descriptor", "Invalid manifest page", "Conflicting export manifest", "Superseded artifact cleanup is waiting for a peer slot",
  "Conflicting export header", "Invalid empty export", "Invalid committed local receipt", "Local store identity does not match", "Conflicting peer apply receipt",
  "Invalid peer apply receipt", "Invalid peer store list", "Peer global store is missing"]);
function safeReason(value: unknown): string {
  return token(value) ?? (typeof value === "string" && (syncReasons.has(value) || isPeerFailureReason(value)) ? value : "control-failed");
}
function safeHome(value: unknown): Outcome<unknown>["home"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!token(row.sessionId) || !token(row.machineId) || !Number.isSafeInteger(row.epoch) || !Number.isSafeInteger(row.updatedAt) ||
      !(row.moveId === null || token(row.moveId))) return null;
  return { sessionId: row.sessionId as string, machineId: row.machineId as string, epoch: row.epoch as number, moveId: row.moveId as string | null, updatedAt: row.updatedAt as number };
}
function safeWarning(value: unknown): value is string {
  return typeof value === "string" && (/^(?:tool-auth|tool-signin|intercom-route|route-unavailable|workspace-|git-)[A-Za-z0-9._:@/-]*$/.test(value) ||
    value === "sparse-cone-defaulted-to-false" || /^[A-Za-z][A-Za-z0-9-]*(?:\.(?:[A-Za-z0-9_-]+|<redacted>))+$/.test(value));
}
export function controlWarningText(value: string): string {
  return value === "tool-auth-unverified" ? "tool-auth-unverified: gh auth status, Git identity, and configured CLIs were not checked." : value;
}
/** Do not serialize arbitrary participant values or error messages at a public boundary. */
export function safeControlOutcome(result: Outcome<unknown> & { refusal?: unknown }): SafeControlOutcome {
  const home = safeHome(result.home);
  const safeRepair = (value: unknown): string | null => typeof value === "string" && (/^spider roam (?:recover|doctor|cancel|claim|provision|forget|disable)(?: [A-Za-z0-9._-]+)?$/.test(value) ||
    /^spider roam provision [A-Za-z0-9._-]+ --operation-id [A-Za-z0-9._-]+$/.test(value)) ? value : null;
  const repair = safeRepair(result.repairCommand);
  const raw = result.value && typeof result.value === "object" && !Array.isArray(result.value) ? result.value as Record<string, unknown> : null;
  const value: Record<string, unknown> = {};
  if (raw) {
    if (raw.sourceCleanup !== undefined) try { value.sourceCleanup = parseSourceCleanup(raw.sourceCleanup); } catch { /* Invalid evidence is never published. */ }
    for (const key of ["terminal", "intercomAddress"] as const) if (token(raw[key])) value[key] = raw[key];
    if (Array.isArray(raw.warnings)) value.warnings = raw.warnings.filter(safeWarning);
    if (Array.isArray(raw.candidates)) value.candidates = raw.candidates.filter(candidate => token(candidate));
    if (raw.presentation === "pending" || raw.presentation === "complete") value.presentation = raw.presentation;
    if (Array.isArray(raw.homes)) {
      const homes = raw.homes.map(safeHome);
      if (homes.every(item => item !== null)) value.homes = homes;
    }
    if (typeof raw.hostingReady === "boolean") value.hostingReady = raw.hostingReady;
    if (Array.isArray(raw.outcomes)) value.outcomes = raw.outcomes.flatMap(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      if (![0, 1, 2, 3].includes(row.code as number) || typeof row.reason !== "string") return [];
      const receipt = row.value && typeof row.value === "object" && !Array.isArray(row.value) ? row.value as Record<string, unknown> : null;
      const validReceipt = receipt && token(receipt.batchId) && token(receipt.stream) && Number.isSafeInteger(receipt.through) &&
        typeof receipt.sha256 === "string" && /^[a-f0-9]{64}$/.test(receipt.sha256) &&
        (receipt.applyMs === null || Number.isSafeInteger(receipt.applyMs) && Number(receipt.applyMs) >= 0)
        ? { batchId: receipt.batchId, stream: receipt.stream, through: receipt.through, sha256: receipt.sha256, applyMs: receipt.applyMs } : null;
      return [{ code: row.code, reason: safeReason(row.reason), operationId: token(row.operationId) ?? "", home: safeHome(row.home),
        epoch: Number.isSafeInteger(row.epoch) ? row.epoch : null, repairCommand: safeRepair(row.repairCommand), value: validReceipt }];
    });
    if (Array.isArray(raw.information)) value.information = raw.information.flatMap(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const info = item as Record<string, unknown>, machine = token(info.machine), reason = info.reason;
      return machine && typeof reason === "string" && (reason === INTERCOM_UNIQUENESS_DESCRIPTION || /^intercom-other-extension: [A-Za-z0-9@._/-]{1,128} \(not classified for intercom\)\.$/.test(reason)) ? [{ machine, reason }] : [];
    });
    if (Array.isArray(raw.issues)) value.issues = raw.issues.flatMap(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const issue = item as Record<string, unknown>, reason = token(issue.reason), repairCommand = safeRepair(issue.repairCommand);
      return reason && repairCommand ? [{ reason, repairCommand }] : [];
    });
  }
  let refusal: MoveRefusal | undefined;
  if (result.refusal && typeof result.refusal === "object" && !Array.isArray(result.refusal)) {
    const rawRefusal = result.refusal as Record<string, unknown>, code = rawRefusal.code;
    if (typeof code === "string" && Object.hasOwn(MOVE_REFUSAL_MESSAGES, code) && code === result.reason && result.code !== 0 &&
        rawRefusal.message === MOVE_REFUSAL_MESSAGES[code as MoveRefusalCode] && Array.isArray(rawRefusal.blockers)) {
      try { refusal = { code: code as MoveRefusalCode, message: MOVE_REFUSAL_MESSAGES[code as MoveRefusalCode], blockers: rawRefusal.blockers.map(validateBlockerId) }; }
      catch { /* Invalid blocker identities are never printed. */ }
    }
  }
  return { code: [0, 1, 2, 3].includes(result.code) ? result.code : 1, reason: safeReason(result.reason), operationId: token(result.operationId) ?? "",
    home, epoch: Number.isSafeInteger(result.epoch) ? result.epoch : null, repairCommand: repair, value: Object.keys(value).length ? value : null,
    ...(refusal ? { refusal } : {}) };
}
export function controlText(result: SafeControlOutcome, destinationAlias?: string): string {
  const value = result.value as { presentation?: string; terminal?: string; intercomAddress?: string; warnings?: string[]; candidates?: string[]; sourceCleanup?: SourceCleanup } | null;
  if (result.code === 0 && value?.sourceCleanup) switch (value.sourceCleanup.status) {
    case 'done': break;
    case 'pending': return `Moved. Source cleanup pending: ${MOVE_REFUSAL_MESSAGES['move-source-stop-pending'].replace(/\.$/, '')}. It finishes on its own; check with \`spider roam status\`.\n`;
    default: { const exhaustive: never = value.sourceCleanup; return exhaustive; }
  }
  if (result.code === 0 && value?.presentation === "pending") return "recovered; the pane appears when Herdr opens\n";
  if (result.code === 0 && value?.intercomAddress) return `Moved to ${destinationAlias ?? result.home?.machineId ?? "destination"}; terminal ${value.terminal ?? "pending"}; intercom ${value.intercomAddress}.\n${value.warnings?.map(controlWarningText).join("\n") ?? ""}\n`;
  const explanation = result.refusal?.message, pause = ["destination-unknown", "move-destination-pending"].includes(result.reason) && !explanation?.includes("The source is paused")
    ? "\nThe source is paused to avoid running two copies." : "";
  return `${result.reason === "mac-hub-required" ? "Run this command on the Mac hub." : result.reason}${explanation ? `\n${explanation}` : ""}${result.refusal?.blockers.length ? `\nBlockers: ${result.refusal.blockers.join(", ")}` : ""}${result.home ? `\nCurrent home: ${result.home.machineId} (epoch ${result.home.epoch}).` : ""}${pause}${result.repairCommand ? `\n${result.repairCommand}` : ""}${value?.candidates?.length ? `\nCandidates: ${value.candidates.join(", ")}` : ""}\n`;
}

export function sourceCleanupStatusText(item: NonNullable<RoamStatus['sourceCleanups']>[number]): string {
  return `Session ${token(item.sessionId) ?? 'unknown'}: source cleanup pending on ${token(item.sourceMachine) ?? 'unknown'}: ${item.sourceCleanup.blockers[0]}.`;
}
