import { delimiter, dirname, isAbsolute } from "node:path";
import { validUnicode } from "@spider/db-core/roam/hlc";
import type { MachineId } from "@spider/db-core/roam/types";
import { isMachineId } from "../machine-id";
import type { SessionId } from "./types";

const launchKey = "SPIDER_ROAM_V0_LAUNCH";
export type ManagedLaunch = { sessionId: SessionId; machineId: MachineId; homeEpoch: number };

function isManagedLaunch(value: unknown): value is ManagedLaunch {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3) return false;
  const { sessionId, machineId, homeEpoch } = value as Record<string, unknown>;
  return validUnicode(sessionId) && sessionId.length <= 4096 && !!sessionId.trim() && !/[\u0000-\u001f\u007f]/.test(sessionId) &&
    isMachineId(machineId) && typeof homeEpoch === "number" && Number.isSafeInteger(homeEpoch) && homeEpoch > 0;
}

/** Undefined is an unmarked launch; null is a supplied but invalid marker. */
export function consumeManagedLaunch(): ManagedLaunch | null | undefined {
  const raw = process.env[launchKey];
  if (raw === undefined) return undefined;
  delete process.env[launchKey];
  try {
    const value: unknown = JSON.parse(raw);
    return isManagedLaunch(value) ? value : null;
  } catch { return null; }
}

const systemPaths = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const absolute = (value: string): boolean => isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);

export function toolPath(value: string | undefined, node: string): string {
  // Ignore empty and relative entries: a relocated checkout is not a source
  // of executables. The node in the unit stays available to pi's shebang.
  return [...new Set([dirname(node), ...(value ?? "").split(delimiter), ...systemPaths].filter(absolute))].join(delimiter);
}

export function piLaunchArgv(pi: string, file: string, env: Readonly<NodeJS.ProcessEnv>, launch?: ManagedLaunch): string[] {
  // `hc run` sends an empty env map. `env` execs pi in the same PID and
  // preserves the terminal context inserted by the core. Never serialize
  // the service's full environment, provider keys, leases, or handoffs.
  const values = ["PATH", "PI_CODING_AGENT_DIR", "SPIDER_GLOBAL_ROOT", "PI_SUBAGENT_CHILD"].map(name => {
    const value = env[name];
    if (!value) throw new Error(`Missing ${name} for v0 pi launch`);
    return `${name}=${value}`;
  });
  if (env.SSH_AUTH_SOCK && absolute(env.SSH_AUTH_SOCK)) values.push(`SSH_AUTH_SOCK=${env.SSH_AUTH_SOCK}`);
  if (launch !== undefined) {
    const { sessionId, machineId, homeEpoch } = launch;
    const marker = { sessionId, machineId, homeEpoch };
    if (!isManagedLaunch(marker)) throw new Error("Invalid v0 managed launch");
    values.push(`${launchKey}=${JSON.stringify(marker)}`);
  }
  return ["/usr/bin/env", ...values, pi, "--session", file];
}
