import { describe, it, expect } from "vitest";
import { PolyglotExecutor } from "../executor";

describe("cleanupBackgrounded — dead code, deliberately removed rather than wired up", () => {
  // Root cause under test: `cleanupBackgrounded()` SIGTERMed every backgrounded
  // pid but was called from NOWHERE (confirmed via a repo-wide grep before this
  // fix — the only hit was the method's own definition). It reads as an
  // implemented safety net and is completely inert.
  //
  // It is deleted, not wired up: every real integration point available to this
  // fix (this class's own lifecycle) is per-call — `actions/exec.ts` constructs
  // a brand-new PolyglotExecutor for every single exec/batch call and discards
  // it immediately after, so nothing ever holds a reference long enough to call
  // this at a meaningful "teardown" moment anyway. Worse, wiring it into any
  // automatic teardown (process exit, signal handler, etc.) would silently kill
  // processes a caller deliberately backgrounded to outlive the session —
  // trading defect 1's silent death for a different one. See the commit message
  // for the full justification.
  it("is no longer present on PolyglotExecutor", () => {
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    expect((exec as unknown as Record<string, unknown>).cleanupBackgrounded).toBeUndefined();
  });
});
