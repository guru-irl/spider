import { execFile } from "node:child_process";
import { join } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import type { Diagnostic } from "./contracts";
import { hubServiceLabel } from "./launchd";
import { launchctlBinary } from "./service-manager";
import { waitReady } from "./hub-readiness";

export interface HubServiceObservation {
  running: boolean | null;
  socketAvailable: boolean;
  lastExitCode: number | null;
}
interface ServicePrint { code: number | null; stdout: string }

/** Query metadata and read-only status. The error log is never opened. */
export async function inspectHubService(root: string, print?: () => Promise<ServicePrint>): Promise<HubServiceObservation> {
  const socket = join(root, "roam", "hub.sock"); assertTestConfigPath(socket);
  let running: boolean | null = null, lastExitCode: number | null = null;
  try {
    const query = print ?? (() => new Promise<ServicePrint>((done, reject) => {
      let binary: string;
      try { binary = launchctlBinary(); } catch (error) { reject(error); return; }
      execFile(binary, ["print", `gui/${process.getuid?.()}/${hubServiceLabel(root)}`], { timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        done({ code: !error ? 0 : error.killed || error.signal ? null : typeof error.code === "number" ? error.code : null, stdout });
      });
    }));
    const result = await query();
    if (result.code === 113) running = false;
    else if (result.code === 0) {
      const lastExit = /\blast exit code\s*=\s*(-?\d+)\b/.exec(result.stdout)?.[1];
      lastExitCode = lastExit !== undefined && Number.isSafeInteger(Number(lastExit)) ? Number(lastExit) : null;
      const pid = /\bpid\s*=\s*(\d+)\b/.exec(result.stdout)?.[1];
      const state = /\bstate[ \t]*=[ \t]*([a-z][a-z -]*)/.exec(result.stdout)?.[1];
      running = pid !== undefined && Number.isSafeInteger(Number(pid)) && Number(pid) > 0 ? true : state ? false : null;
    }
  } catch { /* Unknown metadata alone cannot prove a stopped service. */ }
  const socketAvailable = running !== false && await waitReady(socket, 2000);
  return { running, socketAvailable, lastExitCode };
}

export function hubStartupDiagnostics(root: string, state: HubServiceObservation): Diagnostic[] {
  if (state.running === true && state.socketAvailable) return [];
  const pending = state.running === false || state.running === true && !state.socketAvailable;
  const code = pending ? "hub-startup-pending" : "hub-startup-unverified";
  const detail = state.running === false ? "Hub service is not running." : state.running === true ? "Hub service did not answer a ready status probe within 2 seconds." : "Hub service state cannot be verified.";
  return [{ severity: pending ? "block" : "warning", reason: `${code}: ${detail} Last exit code: ${state.lastExitCode ?? "unknown"}. Error log: ${join(root, "roam", "logs", "hub.err.log")}. Check the hub service and its error log on the Mac hub before retrying.`, repairCommand: null }];
}
