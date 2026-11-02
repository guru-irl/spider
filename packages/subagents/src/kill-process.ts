/** OS-level process-group termination. No DB or run knowledge.
 *  Mirrors the proven approach in packages/context/src/executor.ts (killTree). */
import { execFileSync } from "node:child_process";
import { commandEnv } from "@spider/db-core";

export type KillOutcome = "terminated" | "forced" | "already-dead";

export interface KillOpts {
  /** Grace period between SIGTERM and SIGKILL. */
  graceMs?: number;
  /** Injected for tests; defaults to process.kill. */
  kill?: (pid: number, sig: NodeJS.Signals | number) => void;
  /** Injected for tests; defaults to process.platform. */
  platform?: string;
  /** The run owner rechecks spawn identity before either signal. */
  canSignal?: () => boolean;
  /** EPERM inventory fallback: true for live members or an inspection failure. */
  hasLiveGroupMembers?: (pgid: number) => boolean;
}

const DEFAULT_GRACE_MS = 3000;

/** Liveness probe: signal 0 checks permission+existence without delivering a signal. */
export function isProcessAlive(pid: number, kill: (p: number, s: NodeJS.Signals | number) => void = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means it exists but belongs to another user — still alive.
    return (err as { code?: string })?.code === "EPERM";
  }
}

/** macOS returns EPERM for zombie-only groups. Only a successful inventory can
 * establish that no runnable members remain; inspection failures stay alive. */
function hasLiveGroupMembers(pgid: number): boolean {
  try {
    const output = execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="], {
      encoding: "utf8", timeout: 1000, maxBuffer: 8 * 1024 * 1024,
      env: { ...commandEnv(), LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
      if (!row) return true;
      if (Number(row[2]) === pgid && !row[3].startsWith("Z")) return true;
    }
    return false;
  } catch { return true; }
}

function probeGroup(pid: number, kill: (p: number, s: NodeJS.Signals | number) => void, inspect: (pgid: number) => boolean): "alive" | "dead" | "missing" {
  if (!Number.isInteger(pid) || pid <= 0) return "missing";
  try { kill(-pid, 0); return "alive"; }
  catch (error) {
    if ((error as { code?: string })?.code === "EPERM") return inspect(pid) ? "alive" : "dead";
    return "missing";
  }
}

/** Probe the process group, including members whose leader has exited. */
export function isProcessGroupAlive(pid: number, kill: (p: number, s: NodeJS.Signals | number) => void = process.kill, inspect: (pgid: number) => boolean = hasLiveGroupMembers): boolean {
  return probeGroup(pid, kill, inspect) === "alive";
}

/** A missing group may have a reused live leader pid. A confirmed zombie-only
 * group must not become alive again just because its leader is unreaped. */
export function isProcessOrGroupAlive(pid: number, kill: (p: number, s: NodeJS.Signals | number) => void = process.kill, inspect: (pgid: number) => boolean = hasLiveGroupMembers): boolean {
  const group = probeGroup(pid, kill, inspect);
  return group === "alive" || (group === "missing" && isProcessAlive(pid, kill));
}

const sleep = (ms: number) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  (t as unknown as { unref?: () => void }).unref?.();
});

/**
 * SIGTERM the process group, wait `graceMs`, then SIGKILL if still alive.
 * On Unix the target is `-pid` (the whole group, so the child's own tool
 * subprocesses die too). Windows has no process groups, so the positive pid is
 * used and the caller is expected to have spawned without `detached`.
 */
export async function killProcessGroup(pid: number, opts: KillOpts = {}): Promise<KillOutcome> {
  const kill = opts.kill ?? process.kill;
  const platform = opts.platform ?? process.platform;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const target = platform === "win32" ? pid : -pid;
  const inspect = opts.hasLiveGroupMembers ?? hasLiveGroupMembers;
  const alive = (includeLeader = false) => platform === "win32" ? isProcessAlive(pid, kill)
    : includeLeader ? isProcessOrGroupAlive(pid, kill, inspect) : isProcessGroupAlive(pid, kill, inspect);

  if (opts.canSignal && !opts.canSignal()) {
    if (alive(true)) throw new Error("Process identity unconfirmed; no signal sent.");
    return "already-dead";
  }
  try {
    kill(target, "SIGTERM");
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ESRCH" || (code === "EPERM" && platform !== "win32" && !inspect(pid))) return "already-dead";
    throw err;
  }

  await sleep(graceMs);

  // A group may retain tool processes after its leader exits.
  if (!alive()) return "terminated";

  if (opts.canSignal && !opts.canSignal()) {
    if (alive(true)) throw new Error("Process identity unconfirmed; no signal sent.");
    return "already-dead";
  }
  try {
    kill(target, "SIGKILL");
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ESRCH" || (code === "EPERM" && platform !== "win32" && !inspect(pid))) return "terminated";
    throw err;
  }
  return "forced";
}
