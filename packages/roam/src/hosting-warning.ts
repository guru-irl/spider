import type { Db } from "@spider/db-core";
import { localEntries } from "@spider/db-core/roam/local-state";
import { safeCauseCode } from "./cause-codes";

export const HOSTING_WARNING_CODE = "supervisor-hosting-error";
export type HostingCheck = "running-intent" | "intent-view" | "inspection" | "restart" | "launch";
export interface LaunchExit { exitCode?: number; signal?: number }
export interface HostingWarning { code: typeof HOSTING_WARNING_CODE; check: HostingCheck; since: number; count: number; causeCode?: string; exitCode?: number; signal?: number }
export interface SessionHostingWarning extends HostingWarning { sessionId: string }

const validExitCode = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
const validSignal = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 255;
export function safeLaunchExit(value: unknown): LaunchExit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { exitCode?: unknown; signal?: unknown };
  const exit: LaunchExit = { ...(validExitCode(row.exitCode) ? { exitCode: row.exitCode } : {}),
    ...(validSignal(row.signal) ? { signal: row.signal } : {}) };
  return exit.exitCode === undefined && exit.signal === undefined ? undefined : exit;
}

export function validHostingWarning(value: unknown): value is HostingWarning {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as HostingWarning;
  return row.code === HOSTING_WARNING_CODE && ["running-intent", "intent-view", "inspection", "restart", "launch"].includes(row.check) &&
    Number.isSafeInteger(row.since) && row.since >= 0 &&
    (row.count === 3 || row.check === "launch" && row.causeCode === "participant-exited-before-readiness" && (row.count === 1 || row.count === 2)) &&
    (row.causeCode === undefined || row.check === "launch" && safeCauseCode(row.causeCode) !== undefined) &&
    (row.exitCode === undefined || row.check === "launch" && row.causeCode !== undefined && validExitCode(row.exitCode)) &&
    (row.signal === undefined || row.check === "launch" && row.causeCode !== undefined && validSignal(row.signal));
}
export function validHostingWarnings(value: unknown): value is SessionHostingWarning[] {
  return Array.isArray(value) && value.every(value => {
    const row = value as SessionHostingWarning;
    return validHostingWarning(row) && typeof row.sessionId === "string" && row.sessionId.length > 0 &&
      row.sessionId.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(row.sessionId);
  });
}
export function copyHostingWarning(value: HostingWarning): HostingWarning {
  return { code: value.code, check: value.check, since: value.since, count: value.count,
    ...(value.causeCode === undefined ? {} : { causeCode: value.causeCode }),
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }), ...(value.signal === undefined ? {} : { signal: value.signal }) };
}
export function readHostingWarnings(db: Db): SessionHostingWarning[] {
  return localEntries<unknown>(db, HOSTING_WARNING_CODE).map(({ key, value }) => {
    if (!validHostingWarning(value)) throw new Error("Invalid hosting warning");
    return { sessionId: key, ...copyHostingWarning(value) };
  });
}
export function hostingWarningText(warning: HostingWarning): string {
  const details = [warning.causeCode, warning.exitCode === undefined ? undefined : `exit code ${warning.exitCode}`,
    warning.signal === undefined ? undefined : `signal ${warning.signal}`].filter(Boolean).join(", ");
  return `${warning.code} (${warning.check}${details ? `: ${details}` : ""}); hosting checks will retry automatically.`;
}
export function hostingWarningReason(sessionId: string, warning: HostingWarning): string {
  const id = sessionId.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
  return `Session ${id}: ${hostingWarningText(warning)}`;
}
