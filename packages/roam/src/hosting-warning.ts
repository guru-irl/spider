import type { Db } from "@spider/db-core";
import { localEntries } from "@spider/db-core/roam/local-state";

export const HOSTING_WARNING_CODE = "supervisor-hosting-error";
export type HostingCheck = "running-intent" | "intent-view" | "inspection" | "restart" | "launch";
export interface HostingWarning { code: typeof HOSTING_WARNING_CODE; check: HostingCheck; since: number; count: number }
export interface SessionHostingWarning extends HostingWarning { sessionId: string }

export function validHostingWarning(value: unknown): value is HostingWarning {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as HostingWarning;
  return row.code === HOSTING_WARNING_CODE && ["running-intent", "intent-view", "inspection", "restart", "launch"].includes(row.check) &&
    Number.isSafeInteger(row.since) && row.since >= 0 && row.count === 3;
}
export function validHostingWarnings(value: unknown): value is SessionHostingWarning[] {
  return Array.isArray(value) && value.every(value => {
    const row = value as SessionHostingWarning;
    return validHostingWarning(row) && typeof row.sessionId === "string" && row.sessionId.length > 0 &&
      row.sessionId.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(row.sessionId);
  });
}
export function readHostingWarnings(db: Db): SessionHostingWarning[] {
  return localEntries<unknown>(db, HOSTING_WARNING_CODE).map(({ key, value }) => {
    if (!validHostingWarning(value)) throw new Error("Invalid hosting warning");
    return { sessionId: key, code: value.code, check: value.check, since: value.since, count: value.count };
  });
}
export function hostingWarningText(warning: HostingWarning): string {
  return `${warning.code} (${warning.check}); hosting checks will retry automatically.`;
}
export function hostingWarningReason(sessionId: string, warning: HostingWarning): string {
  const id = sessionId.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
  return `Session ${id}: ${hostingWarningText(warning)}`;
}
