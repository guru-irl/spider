import { describe, it, expect } from "vitest";
import { defaultSpawner } from "../spawn-default";

describe("defaultSpawner", () => {
  it("resolves wait() to exitCode 1 when the binary does not exist (no uncaught error)", async () => {
    const handle = defaultSpawner({ argv: ["__spider_nonexistent_bin__"], cwd: process.cwd(), env: {}, sessionFile: "" });
    await expect(handle.wait()).resolves.toEqual({ exitCode: 1 });
  });

  it("does not raise an uncaught error on the async (detach, never-waited) spawn-failure path", async () => {
    // Mirrors runner.runAsync: detach immediately, never call wait(). The child
    // 'error' listener must be attached EAGERLY or the ENOENT crashes the host.
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const handle = defaultSpawner({ argv: ["__spider_nonexistent_bin__"], cwd: process.cwd(), env: {}, sessionFile: "" });
      handle.detach();
      await new Promise((r) => setTimeout(r, 60));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
