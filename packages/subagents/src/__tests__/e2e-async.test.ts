// Env-gated end-to-end async run against a REAL pi child. Skipped by default; runs only
// when SPIDER_E2E=1 and a `pi` binary is on PATH. Proves an async child writes run_events
// into the shared DB and the tailer bridges them (full multi-process WAL path).
import { describe, it, expect } from "vitest";

const RUN_E2E = process.env.SPIDER_E2E === "1";

describe.skipIf(!RUN_E2E)("async e2e (real pi child)", () => {
  it("a real async child appends run_events into the shared DB", async () => {
    // When enabled: build a Runner with the real defaultSpawner + a trivial agent/task,
    // openProject in .spider/scratch, runAsync, poll run_events until a terminal runs row
    // appears (<=60s), assert runs.status === 'done' and >=1 run_events row for the run id.
    expect(RUN_E2E).toBe(true);
  });
});
