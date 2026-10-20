import { describe, it, expect, vi } from "vitest";
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

  it("keeps only the last 4 KB of print failure stderr without splitting a character", async () => {
    const handle = defaultSpawner({ argv: [process.execPath, "-e", 'process.stderr.write("discarded prefix" + "🙂".repeat(1500) + "πtail"); process.exitCode = 1;'],
      cwd: process.cwd(), env: {}, childMode: "print" });
    const result = await handle.wait();
    expect(result.exitCode).toBe(1);
    expect(result.result).toContain("Stderr tail:\n");
    const tail = result.result!.split("Stderr tail:\n")[1];
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4096);
    expect(tail).toMatch(/^🙂+πtail$/u);
    expect(tail).not.toContain("discarded prefix");
  });

  it("decodes multibyte stderr characters split across child writes", async () => {
    const handle = defaultSpawner({ argv: [process.execPath, "-e", 'const b = Buffer.from("🙂"); process.stderr.write(b.subarray(0, 2)); setTimeout(() => { process.stderr.write(b.subarray(2)); process.exitCode = 2; }, 20);'],
      cwd: process.cwd(), env: {}, childMode: "print" });
    expect(await handle.wait()).toEqual({ exitCode: 2, result: "Child process exited with code 2.\nStderr tail:\n🙂" });
  });

  it("does not put stderr into a successful print result", async () => {
    const handle = defaultSpawner({ argv: [process.execPath, "-e", 'process.stderr.write("success diagnostic");'], cwd: process.cwd(), env: {}, childMode: "print" });
    expect(await handle.wait()).toEqual({ exitCode: 0 });
  });

  it("spawns unix children detached so they own a process group", async () => {
    const calls: any[] = [];
    vi.doMock("node:child_process", () => ({
      spawn: (...a: any[]) => {
        calls.push(a);
        return { pid: 1, on: () => {}, unref: () => {}, kill: () => {} };
      },
    }));
    vi.resetModules();
    const { defaultSpawner } = await import("../spawn-default");
    defaultSpawner({ argv: ["pi", "-p"], env: {}, cwd: "/tmp-not-used", sessionFile: "s" } as any);
    const opts = calls[0][2];
    expect(opts.detached).toBe(process.platform !== "win32");
    vi.doUnmock("node:child_process");
  });
});
