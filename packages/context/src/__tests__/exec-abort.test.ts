import { describe, it, expect } from "vitest";
import { getEventListeners } from "node:events";
import { PolyglotExecutor } from "../executor";

const ex = () => new PolyglotExecutor({ projectRoot: () => process.cwd() });

/** True while `pid` still exists in the process table. Signal 0 is a pure liveness
 *  probe — kill(2) never actually delivers it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll for death instead of a fixed sleep: fast on the happy path, not flaky under
 *  CI scheduling jitter. */
async function waitUntilDead(pid: number, deadlineMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

describe("exec abort — Escape mid-run must kill the process, not just drop the stream", () => {
  // Root cause under test: extension.ts used to discard pi's AbortSignal entirely
  // (`_signal`), so Escape stopped the model-facing stream but the spawned process —
  // and anything IT spawned — kept running to completion.
  //
  // Mutation this catches: kill only proc.pid instead of the process group (-pgid) ->
  // the backgrounded `sleep` grandchild survives and this fails.
  it("aborting mid-run kills the whole process group — asserts a GRANDCHILD pid is dead, not just the shell", async () => {
    const ac = new AbortController();
    let childPid: number | undefined;
    const start = Date.now();

    const p = ex().execute({
      language: "shell",
      // The backgrounded `sleep` is a child of the spawned shell — a GRANDCHILD of this
      // test process. A kill that only targets the shell's own pid would miss it.
      code: "sleep 6 & echo GRANDCHILD_PID:$!; wait",
      signal: ac.signal,
      onData: (chunk: string) => {
        const m = chunk.match(/GRANDCHILD_PID:(\d+)/);
        if (m) {
          childPid = Number(m[1]);
          ac.abort();
        }
      },
    } as any);

    const r = await p;
    const elapsed = Date.now() - start;

    expect(childPid).toBeGreaterThan(0);
    expect(r.aborted).toBe(true);
    expect(r.exitCode).not.toBe(0);
    // Proves the kill was early (ours) — not the grandchild's own 6s timer expiring.
    expect(elapsed).toBeLessThan(2000);
    expect(await waitUntilDead(childPid!)).toBe(true);
  });

  // Mutation this catches: remove the `signal.addEventListener("abort", ...)` wiring ->
  // nothing ever calls killTree, so this waits out the full sleep and fails on elapsed.
  it("abort resolves the exec call promptly instead of waiting out the full command", async () => {
    const ac = new AbortController();
    const start = Date.now();
    const p = ex().execute({ language: "shell", code: "sleep 5", signal: ac.signal } as any);
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(r.aborted).toBe(true);
  });

  it("a signal that is already aborted before execute() is called never spawns the process", async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    const r = await ex().execute({
      language: "shell",
      code: "echo should-not-run; sleep 5",
      signal: ac.signal,
    } as any);
    const elapsed = Date.now() - start;
    expect(r.stdout).not.toContain("should-not-run");
    expect(elapsed).toBeLessThan(500);
    expect(r.aborted).toBe(true);
  });

  it("output printed before the abort is preserved; output scheduled after it is not", async () => {
    const ac = new AbortController();
    const p = ex().execute({
      language: "shell",
      code: "echo before-abort; sleep 5; echo after-abort",
      signal: ac.signal,
    } as any);
    setTimeout(() => ac.abort(), 150);
    const r = await p;
    expect(r.stdout).toContain("before-abort");
    expect(r.stdout).not.toContain("after-abort");
    expect(r.aborted).toBe(true);
    // A killed command must not look like a normal success.
    expect(r.exitCode).not.toBe(0);
  });

  it("no signal supplied → behaves exactly as before (no regression)", async () => {
    const r = await ex().execute({ language: "shell", code: "echo fine" } as any);
    expect(r.stdout).toContain("fine");
    expect(r.exitCode).toBe(0);
    expect(r.aborted).toBeUndefined();
  });

  // Required behaviour #5 (listener hygiene) — not one of the five headline tests, but
  // explicitly required: the abort listener must not accumulate on a long-lived
  // AbortSignal reused across the many execs in one session/turn.
  it("removes its abort listener once the process settles, on both the non-abort and abort paths", async () => {
    const ac = new AbortController();
    await ex().execute({ language: "shell", code: "echo one", signal: ac.signal } as any);
    await ex().execute({ language: "shell", code: "echo two", signal: ac.signal } as any);
    expect(getEventListeners(ac.signal, "abort").length).toBe(0);

    const ac2 = new AbortController();
    const p = ex().execute({ language: "shell", code: "sleep 5", signal: ac2.signal } as any);
    setTimeout(() => ac2.abort(), 100);
    await p;
    expect(getEventListeners(ac2.signal, "abort").length).toBe(0);
  });
});
