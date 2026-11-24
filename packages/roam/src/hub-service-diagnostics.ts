import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import type { Diagnostic } from "./contracts";
import { hubServiceLabel } from "./launchd";
import { launchctlBinary } from "./service-manager";

export interface HubServiceObservation {
  running: boolean | null;
  socketAvailable: boolean;
  lastExitCode: number | null;
}
interface ServicePrint { code: number | null; stdout: string }

/** Query metadata only. The error log path is reported, never opened. */
export async function inspectHubService(root: string, print?: () => Promise<ServicePrint>): Promise<HubServiceObservation> {
  const socket = join(root, "roam", "hub.sock"); assertTestConfigPath(socket);
  let socketAvailable = false;
  try { socketAvailable = lstatSync(socket).isSocket(); } catch { /* A missing or unreadable socket is not ready. */ }
  try {
    const query = print ?? (() => new Promise<ServicePrint>((done, reject) => {
      let binary: string;
      try { binary = launchctlBinary(); } catch (error) { reject(error); return; }
      execFile(binary, ["print", `gui/${process.getuid?.()}/${hubServiceLabel(root)}`], { timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        done({ code: !error ? 0 : error.killed || error.signal ? null : typeof error.code === "number" ? error.code : null, stdout });
      });
    }));
    const result = await query();
    if (result.code === 113) return { running: false, socketAvailable, lastExitCode: null };
    if (result.code !== 0) return { running: null, socketAvailable, lastExitCode: null };
    const lastExit = /\blast exit code\s*=\s*(-?\d+)\b/.exec(result.stdout)?.[1];
    const lastExitCode = lastExit !== undefined && Number.isSafeInteger(Number(lastExit)) ? Number(lastExit) : null;
    const pid = /\bpid\s*=\s*(\d+)\b/.exec(result.stdout)?.[1];
    const state = /\bstate[ \t]*=[ \t]*([a-z][a-z -]*)/.exec(result.stdout)?.[1];
    const running = pid !== undefined && Number.isSafeInteger(Number(pid)) && Number(pid) > 0 ? true : state ? false : null;
    return { running, socketAvailable, lastExitCode };
  } catch { return { running: null, socketAvailable, lastExitCode: null }; }
}

export function hubStartupDiagnostics(root: string, state: HubServiceObservation): Diagnostic[] {
  if (state.running === true && state.socketAvailable) return [];
  const pending = state.running === false || !state.socketAvailable;
  const code = pending ? "hub-startup-pending" : "hub-startup-unverified";
  const detail = !state.socketAvailable ? "Hub socket is missing or unavailable." : state.running === false ? "Hub service is not running." : "Hub service state cannot be verified.";
  return [{ severity: pending ? "block" : "warning", reason: `${code}: ${detail} Last exit code: ${state.lastExitCode ?? "unknown"}. Error log: ${join(root, "roam", "logs", "hub.err.log")}. Run spider roam enable on the Mac hub.`, repairCommand: "spider roam enable" }];
}
