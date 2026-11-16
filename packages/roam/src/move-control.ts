import type { HubControlReply } from "./control-socket";

export type MoveControlRequest =
  | { op: "move" | "claim"; session: string; machine: string }
  | { op: "recover" | "cancel"; operationId: string }
  | { op: "stop" | "resume"; session: string }
  | { op: "forget"; machine: string; confirmation: string };
export type MoveControlHandler = (request: MoveControlRequest) => Promise<HubControlReply>;
export function parseMoveControlRequest(value: unknown): MoveControlRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const token = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(value);
  const keys = (...names: string[]) => Object.keys(row).sort().join() === names.sort().join();
  if ((row.op === "move" || row.op === "claim") && keys("op", "session", "machine") && token(row.session) && token(row.machine)) return { op: row.op, session: row.session, machine: row.machine };
  if ((row.op === "recover" || row.op === "cancel") && keys("op", "operationId") && token(row.operationId)) return { op: row.op, operationId: row.operationId };
  if ((row.op === "stop" || row.op === "resume") && keys("op", "session") && token(row.session)) return { op: row.op, session: row.session };
  if (row.op === "forget" && keys("op", "machine", "confirmation") && token(row.machine) && typeof row.confirmation === "string" && /^destroyed [A-Za-z0-9._-]+$/.test(row.confirmation)) return { op: row.op, machine: row.machine, confirmation: row.confirmation };
  return null;
}
export function guardMoveControl(enabled: () => boolean, handler?: MoveControlHandler): (request: unknown) => Promise<HubControlReply> {
  return async input => {
    const request = parseMoveControlRequest(input);
    if (!enabled() && request?.op !== "forget") return { code: 1, reason: "roaming-disabled", value: null };
    if (!request) return { code: 2, reason: "invalid-move-control", value: null };
    if (!handler) return { code: 1, reason: "move-control-unavailable", value: null };
    try { return await handler(request); } catch { return { code: 1, reason: "move-control-unavailable", value: null }; }
  };
}
