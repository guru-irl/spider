import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, it } from "vitest";
import { scratchDbPath } from "@spider/db-core/testutil";
import { testScratchPath as hostScratch } from "../testutil";
// This repo-wide lifecycle check uses the other packages' actual test scratch helpers.
import { testScratchPath as subagentScratch } from "../../../../subagents/src/__tests__/helpers/testutil";
import { testScratchPath as superpowersScratch } from "../../../../superpowers/src/__tests__/testutil";

// Not *.test.ts: the normal suite does not collect this file. The parent runs it
// with the probe-only config to exercise the real setup lifecycle.
const failMode = process.env.SPIDER_SCRATCH_PROBE_FAIL;
if (failMode === "hook") {
  afterAll(() => { throw new Error("intentional afterAll failure"); });
}

it("creates this process's PID scratch folders", () => {
  const files = [
    scratchDbPath("cleanup-probe"),
    hostScratch("cleanup-probe.txt"),
    subagentScratch("cleanup-probe.txt"),
    superpowersScratch("cleanup-probe.txt"),
  ];
  for (const file of files) {
    writeFileSync(file, "probe");
    // Catches accidental PID-prefix matching: this path begins with our PID.
    const neighbour = join(dirname(dirname(file)), `${process.pid}000000000`);
    if (!existsSync(neighbour)) {
      mkdirSync(neighbour);
      writeFileSync(join(neighbour, "keep.txt"), "prefix neighbour");
    }
  }
  writeFileSync(process.env.SPIDER_SCRATCH_PROBE_OUT!, String(process.pid));
  if (failMode === "test") throw new Error("intentional probe failure");
});
