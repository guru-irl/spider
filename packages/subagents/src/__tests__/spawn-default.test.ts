import { describe, it, expect } from "vitest";
import { defaultSpawner } from "../spawn-default.js";

describe("defaultSpawner", () => {
  it("resolves wait() to exitCode 1 when the binary does not exist (no uncaught error)", async () => {
    const handle = defaultSpawner({ argv: ["__spider_nonexistent_bin__"], cwd: process.cwd(), env: {} });
    await expect(handle.wait()).resolves.toEqual({ exitCode: 1 });
  });
});
