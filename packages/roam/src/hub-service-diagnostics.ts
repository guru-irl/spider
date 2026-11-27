import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { assertTestConfigPath } from "@spider/db-core";
import type { Diagnostic } from "./contracts";
import { hubServiceFile, hubServiceLabel } from "./launchd";
import { probeV0Control } from "./relocate/service";
import { launchctlBinary } from "./service-manager";
import { waitReady } from "./hub-readiness";

export interface HubServiceObservation {
  running: boolean | null;
  socketAvailable: boolean;
  lastExitCode: number | null;
}
interface ServicePrint { code: number | null; stdout: string }
const DOCTOR_HUB_DEADLINE_MS = 2000;

export function hubPlistDirectory(platform: NodeJS.Platform = process.platform): string | undefined {
  const supported = process.env.SPIDER_TEST_FIXTURE_CHECKOUT
    ? Boolean(process.env.SPIDER_TEST_ROAM_LAUNCHCTL)
    : platform === "darwin";
  return supported ? join(homedir(), "Library", "LaunchAgents") : undefined;
}

export function observedHubServiceMode(root: string, directory: string | undefined = hubPlistDirectory()): "v0" | undefined {
  if (!directory) return undefined;
  const file = hubServiceFile(root, directory, "v0");
  assertTestConfigPath(file);
  return existsSync(file) ? "v0" : undefined;
}

/** Query metadata and read-only status. The error log is never opened. */
export async function inspectHubService(root: string, print?: () => Promise<ServicePrint>, directory?: string): Promise<HubServiceObservation> {
  const mode = observedHubServiceMode(root, directory);
  const socket = join(root, "roam", "hub.sock"); assertTestConfigPath(socket);
  const end = Date.now() + DOCTOR_HUB_DEADLINE_MS;
  let running: boolean | null = null, lastExitCode: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = print ?? (() => new Promise<ServicePrint>((done, reject) => {
      let binary: string;
      try { binary = launchctlBinary(); } catch (error) { reject(error); return; }
      execFile(binary, ["print", `gui/${process.getuid?.()}/${hubServiceLabel(root, mode)}`], { timeout: DOCTOR_HUB_DEADLINE_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error, stdout) => {
        done({ code: !error ? 0 : error.killed || error.signal ? null : typeof error.code === "number" ? error.code : null, stdout });
      });
    }));
    const result = await Promise.race([query(), new Promise<null>(done => { timer = setTimeout(() => done(null), DOCTOR_HUB_DEADLINE_MS); })]);
    if (result?.code === 113) running = false;
    else if (result?.code === 0) {
      const lastExit = /\blast exit code\s*=\s*(-?\d+)\b/.exec(result.stdout)?.[1];
      lastExitCode = lastExit !== undefined && Number.isSafeInteger(Number(lastExit)) ? Number(lastExit) : null;
      const pid = /\bpid\s*=\s*(\d+)\b/.exec(result.stdout)?.[1];
      const state = /\bstate[ \t]*=[ \t]*([a-z][a-z -]*)/.exec(result.stdout)?.[1];
      running = pid !== undefined && Number.isSafeInteger(Number(pid)) && Number(pid) > 0 ? true : state ? false : null;
    }
  } catch { /* Unknown metadata alone cannot prove a stopped service. */ }
  finally { if (timer !== undefined) clearTimeout(timer); }
  const remaining = end - Date.now();
  const socketAvailable = remaining > 0 && running !== false && (mode === "v0"
    ? await probeV0Control(root, remaining).catch(() => false)
    : (running === true || existsSync(socket)) && await waitReady(socket, remaining));
  return { running, socketAvailable, lastExitCode };
}

export function hubStartupDiagnostics(root: string, state: HubServiceObservation, directory?: string): Diagnostic[] {
  if (state.running === true && state.socketAvailable) return [];
  const pending = state.running === false || state.running === true && !state.socketAvailable;
  const code = pending ? "hub-startup-pending" : "hub-startup-unverified";
  const detail = state.running === false ? "Hub service is not running." : state.running === true ? "Hub service did not answer a ready status probe within 2 seconds." : "Hub service state cannot be verified.";
  const log = observedHubServiceMode(root, directory) === "v0" ? "hub-v0.err.log" : "hub.err.log";
  return [{ severity: pending ? "block" : "warning", reason: `${code}: ${detail} Last exit code: ${state.lastExitCode ?? "unknown"}. Error log: ${join(root, "roam", "logs", log)}. Check the hub service and its error log on the Mac hub before retrying.`, repairCommand: 'spider roam enable' }];
}
