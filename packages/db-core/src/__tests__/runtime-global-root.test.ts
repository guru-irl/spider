import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.doUnmock("node:path");
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function globalRoot(override?: string, windows = false) {
  vi.stubEnv("SPIDER_GLOBAL_ROOT", override);
  // Inspect paths only. Never open the default root or a DB.
  vi.stubEnv("VITEST", "");
  if (windows) {
    Object.defineProperty(process, "platform", { value: "win32" });
    // Simulate the OS path implementation, not spider's validation behavior.
    vi.doMock("node:path", () => ({ ...win32 }));
  }
  vi.resetModules();
  return (await import("../paths")).paths.globalRoot;
}

describe("runtime global root", () => {
  it.each(["relative", "./x", "C:x", "\\x", "/x"])(
    "rejects Windows non-qualified root %j without fallback",
    async (override) => {
      await expect(globalRoot(override, true)).rejects.toThrow(
        `SPIDER_GLOBAL_ROOT must be absolute; received ${JSON.stringify(override)}`,
      );
    },
  );

  it.each(["C:\\fixture\\global", "\\\\server\\share\\global"])(
    "accepts fully qualified Windows root %j",
    async (override) => {
      expect(await globalRoot(override, true)).toBe(override);
    },
  );

  it("accepts an absolute native root", async () => {
    const root = join(process.cwd(), ".spider", "scratch", "global-root", "fixture");
    expect(await globalRoot(root)).toBe(root);
  });

  it.each([undefined, ""])("uses the default path only when the override is %j", async (override) => {
    expect(await globalRoot(override)).toBe(join(homedir(), ".pi", "agent", "spider"));
  });
});
