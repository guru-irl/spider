import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "../../../../../vitest.config";

// Replacing include (not mergeConfig, which concatenates arrays) runs only the probe.
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
export default defineConfig({
  ...base,
  root,
  test: {
    ...base.test,
    include: ["packages/host/src/__tests__/fixtures/scratch-probe.fixture.ts"],
    maxWorkers: 1,
  },
});
