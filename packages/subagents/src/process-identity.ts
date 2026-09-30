import { commandEnv } from "@spider/db-core";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Identity captured immediately after spawn. Linux ticks avoid second-resolution reuse. */
export function processStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[0] === "Z" || !fields[19] ? null : `linux:${fields[19]}`;
    }
    if (process.platform === "win32") return null;
    const start = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", timeout: 1000, windowsHide: true, env: { ...commandEnv(), LC_ALL: "C", TZ: "UTC" },
    }).trim();
    return start ? `posix:${start}` : null;
  } catch { return null; }
}

export function checkProcessIdentity(pid: number, recordedStart?: string | null, probes: { start?: (pid: number) => string | null; command?: (pid: number) => string | null } = {}): { matches: boolean; reason: string } {
  if (recordedStart) {
    const current = (probes.start ?? processStartTime)(pid);
    if (!current) return { matches: false, reason: "Process is missing or its start time cannot be read; no signal sent." };
    if (current !== recordedStart) return { matches: false, reason: "Process start time mismatch; pid identity was lost, no signal sent." };
    return { matches: true, reason: "Process start time matches." };
  }
  const matches = looksLikeSubagent(pid, probes.command);
  return { matches, reason: matches ? "Legacy command identity confirmed." : "Legacy process identity could not be confirmed; no signal sent." };
}

/**
 * Best-effort: the command line of `pid`, or null if unknown/unsupported.
 * Uses ps on POSIX; returns null on win32, when pid is gone, ps is missing,
 * or permission is denied.
 */
export function processCommand(pid: number): string | null {
  if (process.platform === "win32") return null;
  
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 1000,
      windowsHide: true, env: commandEnv(),
    });
    return output.trim();
  } catch {
    // pid gone, ps missing, EPERM, timeout, or any other error
    return null;
  }
}

/**
 * True when pid's command line still looks like a spawned subagent.
 * 
 * RPC children must run the Pi executable (or its Node CLI entry) and carry
 * a spider-owned subagent-sessions path. An arbitrary RPC Pi session is not
 * a child. Preserve the legacy `--mode json -p` signature for older launches.
 * Unknown command lines fail closed.
 */
export function looksLikeSubagent(
  pid: number,
  probe?: (pid: number) => string | null,
): boolean {
  const cmd = probe ? probe(pid) : processCommand(pid);
  if (!cmd) return false;
  
  // Match the distinctive subagent argv signature:
  // Must contain both "--mode json" (or "--mode=json") and "-p"
  const hasJsonMode = cmd.includes("--mode json") || cmd.includes("--mode=json");
  const hasPFlag = / -p(?:\s|$)/.test(cmd);
  
  if (hasJsonMode && hasPFlag) return true; // Legacy print-mode launches.
  const hasRpcMode = /(?:^|\s)--mode(?:=|\s+)rpc(?:\s|$)/.test(cmd);
  const tokens = cmd.trim().split(/\s+/);
  const basename = (s: string) => s.split(/[/\\]/).at(-1) ?? "";
  const directPi = /^pi(?:\.cmd|\.exe)?$/.test(basename(tokens[0]));
  const nodePi = /^node(?:\.exe)?$/.test(basename(tokens[0])) && !!tokens[1] && (
    basename(tokens[1]) === "pi" || /[/\\]@earendil-works[/\\]pi-coding-agent[/\\]dist[/\\]cli\.js$/.test(tokens[1])
  );
  const piExecutable = directPi || nodePi;
  const spiderSession = /(?:^|\s)--session(?:=|\s+)[^\n]*[/\\]subagent-sessions[/\\][^\n]+\.jsonl(?:\s|$)/.test(cmd);
  return hasRpcMode && piExecutable && spiderSession;
}
