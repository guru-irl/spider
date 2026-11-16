import { join } from "node:path";
import { isSessionAddress, isSessionEndpoint, type IntercomIntakeFence } from "@spider/intercom/protocol";
import { isIntercomIntakeFence } from "@spider/intercom/broker/protocol";
import type { Home, JsonObject } from "@spider/db-core/roam/types";
import type { MachineMovePort } from "./intercom-runtime";
import { requestPrivateControl, startPrivateControl } from "./control-socket";

type Request = { action: string; args: unknown[] };
function validHome(value: unknown): value is Home {
  if (!value || typeof value !== "object") return false;
  const row = value as Home;
  return typeof row.sessionId === "string" && typeof row.machineId === "string" && Number.isSafeInteger(row.epoch) && row.epoch >= 1 && Number.isSafeInteger(row.updatedAt) && (row.moveId === null || typeof row.moveId === "string");
}
function parse(bytes: Buffer): Request | null {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Request;
    if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "action,args" || !Array.isArray(value.args)) return null;
    const args = value.args;
    if (["bridge", "endpoint"].includes(value.action) && args.length === 1 && isSessionAddress(args[0])) return value;
    if (value.action === "settlement" && args.length === 1) {
      const query = args[0] as Record<string, unknown>;
      if (query && Object.keys(query).sort().join() === "fromSessionId,messageId,scopeId,toSessionId" && typeof query.messageId === "string" &&
          [query.fromSessionId, query.toSessionId, query.scopeId].every(value => value === null || typeof value === "string")) return value;
    }
    if (value.action === "releaseRollbackFence" && args.length === 3 && isIntercomIntakeFence(args[0]) && validHome(args[1]) && validHome(args[2])) return value;
    if (["drain", "inspect", "checkGeneration", "abort"].includes(value.action) && args.length === 1 && isIntercomIntakeFence(args[0])) return value;
    if (value.action === "ready" && args.length === 2 && isIntercomIntakeFence(args[0]) && isSessionEndpoint(args[1])) return value;
    if (value.action === "close" && (args.length === 3 || args.length === 4) && isSessionAddress(args[0]) && typeof args[1] === "string" &&
        Number.isSafeInteger(args[2]) && Number(args[2]) >= 1 && (args.length === 3 || typeof args[3] === "string")) return value;
  } catch { /* No malformed request reaches the machine port. */ }
  return null;
}
const path = (root: string) => join(root, "roam", "move.sock");
export function startMachineMoveSocket(root: string, enabled: () => boolean, port: MachineMovePort): Promise<{ close(): Promise<void> }> {
  return startPrivateControl(path(root), parse, async request => {
    try {
      const action = request.action, args = request.args;
      let result: unknown;
      if (action === "bridge") result = await port.bridge(args[0] as Parameters<MachineMovePort["bridge"]>[0]);
      else if (action === "endpoint") result = await port.endpoint(args[0] as Parameters<MachineMovePort["endpoint"]>[0]);
      else if (action === "settlement") result = await port.settlement(args[0] as Parameters<MachineMovePort["settlement"]>[0]);
      else if (action === "releaseRollbackFence") result = await port.releaseRollbackFence(args[0] as IntercomIntakeFence, args[1] as Home, args[2] as Home);
      else if (action === "close") result = await port.intake.close(args[0] as Parameters<MachineMovePort["intake"]["close"]>[0], args[1] as string, args[2] as number, args[3] as string | undefined);
      else if (action === "ready") result = await port.intake.ready(args[0] as IntercomIntakeFence, args[1] as Parameters<MachineMovePort["intake"]["ready"]>[1]);
      else result = await port.intake[action as "drain" | "inspect" | "checkGeneration" | "abort"](args[0] as IntercomIntakeFence);
      return { code: 0, reason: "complete", value: { result: JSON.parse(JSON.stringify(result ?? null)) } as JsonObject };
    } catch (error) {
      const reason = error instanceof Error && /^(?:intercom|move)-[a-z-]+$/.test(error.message) ? error.message : "intercom-move-unavailable";
      return { code: 1, reason, value: null };
    }
  }, enabled);
}
export async function requestMachineMove(root: string, input: unknown): Promise<unknown> {
  const encoded = Buffer.from(JSON.stringify(input));
  const request = parse(encoded);
  if (!request) throw new Error("invalid-machine-move-control");
  const reply = await requestPrivateControl(path(root), request, parse, { timeoutMs: 60_000 });
  if (reply.code !== 0 || !reply.value || !("result" in reply.value)) throw new Error(reply.reason);
  return reply.value.result;
}
export function machineMoveProxy(root: string): MachineMovePort {
  const call = <T>(action: string, args: unknown[]) => requestMachineMove(root, { action, args }) as Promise<T>;
  return {
    bridge: (...args) => call("bridge", args), endpoint: (...args) => call("endpoint", args), settlement: (...args) => call("settlement", args),
    releaseRollbackFence: (...args) => call("releaseRollbackFence", args),
    intake: { close: (...args) => call("close", args.filter(value => value !== undefined)), drain: (...args) => call("drain", args), inspect: (...args) => call("inspect", args),
      checkGeneration: (...args) => call("checkGeneration", args), abort: (...args) => call("abort", args), ready: (...args) => call("ready", args) },
  };
}
