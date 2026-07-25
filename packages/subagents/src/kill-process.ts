/** OS-level process-group termination. No DB or run knowledge — pure primitives so
 *  they can be unit-tested with an injected `kill` instead of real processes.
 *  Mirrors the proven approach in packages/context/src/executor.ts (killTree). */

export type KillOutcome = "terminated" | "forced" | "already-dead";

export interface KillOpts {
  /** Grace period between SIGTERM and SIGKILL. */
  graceMs?: number;
  /** Injected for tests; defaults to process.kill. */
  kill?: (pid: number, sig: NodeJS.Signals | number) => void;
  /** Injected for tests; defaults to process.platform. */
  platform?: string;
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

  try {
    kill(target, "SIGTERM");
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "ESRCH") return "already-dead";
    throw err;
  }

  await sleep(graceMs);

  // Probe the LEADER pid, not the group: a group probe reports alive while any
  // member lingers, and the leader is what the run row records.
  if (!isProcessAlive(pid, kill)) return "terminated";

  try {
    kill(target, "SIGKILL");
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "ESRCH") return "terminated";
    throw err;
  }
  return "forced";
}
