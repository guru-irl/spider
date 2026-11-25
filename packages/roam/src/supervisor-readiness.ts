import { execFile } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { requestHubControl, startHubControl } from "./control-socket";

export interface SupervisorReadiness {
  root: string; release: string; pid: number;
}
const unit = "spider-roam-supervisor.service";
export const supervisorReadinessSocket = (root: string): string => join(root, "roam", "sv.sock");
const absolute = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 &&
  isAbsolute(value) && resolve(value) === value && !/[\u0000-\u001f\u007f]/.test(value);
function parse(value: unknown): SupervisorReadiness {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("supervisor-identity-unavailable");
  const row = value as Partial<SupervisorReadiness>;
  if (Object.keys(row).sort().join() !== "pid,release,root" || !absolute(row.root) || !absolute(row.release) ||
      !Number.isSafeInteger(row.pid) || Number(row.pid) <= 0) throw new Error("supervisor-identity-unavailable");
  return row as SupervisorReadiness;
}
function mainPid(): Promise<number> {
  return new Promise((done, reject) => {
    execFile("systemctl", ["--user", "show", unit, "--property=MainPID", "--value"], { timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
      const text = stdout.trim(), pid = Number(text);
      if (error || !/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(pid)) reject(new Error("supervisor-identity-unavailable"));
      else done(pid);
    });
  });
}
/** A stale socket or a manually started supervisor cannot stand in for the fixed user unit. */
export async function inspectSupervisorReadiness(root: string): Promise<SupervisorReadiness> {
  const before = await mainPid();
  const reply = await requestHubControl(supervisorReadinessSocket(root), { op: "status" }, { timeoutMs: 5000 });
  const identity = parse(reply.value), after = await mainPid();
  if (reply.code !== 0 || before !== after || identity.pid !== before) throw new Error("supervisor-identity-unavailable");
  return identity;
}
/** Only status is served. In particular, the existing control protocol must not expose disable or move effects here. */
export function serveSupervisorReadiness(identity: SupervisorReadiness): Promise<{ close(): Promise<void> }> {
  const snapshot = Object.freeze({ ...parse(identity) });
  return startHubControl(supervisorReadinessSocket(snapshot.root), async request => request.op === "status"
    ? { code: 0, reason: "ready", value: { ...snapshot } }
    : { code: 2, reason: "invalid-supervisor-request", value: null });
}
