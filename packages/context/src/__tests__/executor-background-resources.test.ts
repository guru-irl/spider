import { describe, it, expect, beforeEach, vi } from "vitest";
import { fstatSync, readdirSync } from "node:fs";
import { PolyglotExecutor } from "../executor";

const state = vi.hoisted(() => ({
  forceSpawnThrow: false,
  failSecondOpen: false,
  openCallCount: 0,
  capturedFds: [] as number[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (state.forceSpawnThrow) {
        throw new Error("forced synchronous spawn failure (test)");
      }
      return (actual.spawn as any)(...args);
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      state.openCallCount++;
      if (state.failSecondOpen && state.openCallCount === 2) {
        throw new Error("forced second-log-open failure (test)");
      }
      const fd = (actual.openSync as any)(...args);
      state.capturedFds.push(fd);
      return fd;
    },
  };
});

// PolyglotExecutor is imported above, statically — vi.mock is hoisted above every
// import in this file, so the mocked node:fs/node:child_process are already in
// place by the time executor.ts's own imports resolve.

function isFdClosed(fd: number): boolean {
  try {
    fstatSync(fd);
    return false;
  } catch {
    return true;
  }
}

function openFdCount(): number {
  try {
    return readdirSync("/dev/fd").length;
  } catch {
    return -1; // not POSIX / not available — caller should skip
  }
}

beforeEach(() => {
  state.forceSpawnThrow = false;
  state.failSecondOpen = false;
  state.openCallCount = 0;
  state.capturedFds = [];
});

describe("background exec — fd leak fixes (O3)", () => {
  it("closes both log fds when the supervisor spawn throws SYNCHRONOUSLY, instead of leaking them", async () => {
    state.forceSpawnThrow = true;
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    await expect(
      exec.execute({ language: "shell", code: "echo hi", background: true, timeout: 5000 }),
    ).rejects.toThrow(/forced synchronous spawn failure/);

    expect(state.capturedFds.length).toBe(2); // both stdout.log and stderr.log were opened
    for (const fd of state.capturedFds) {
      expect(isFdClosed(fd)).toBe(true);
    }
  });

  it("closes the FIRST fd when the second log open fails, instead of leaking it", async () => {
    state.failSecondOpen = true;
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    await expect(
      exec.execute({ language: "shell", code: "echo hi", background: true, timeout: 5000 }),
    ).rejects.toThrow(/forced second-log-open failure/);

    expect(state.capturedFds.length).toBe(1); // only stdout.log succeeded before stderr.log threw
    expect(isFdClosed(state.capturedFds[0])).toBe(true);
  });

  it("no onData callback fires when the launch itself fails (a failed launch is not a stream)", async () => {
    state.forceSpawnThrow = true;
    const chunks: string[] = [];
    const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
    await expect(
      exec.execute({
        language: "shell", code: "echo hi", background: true, timeout: 5000,
        onData: (c) => chunks.push(c),
      }),
    ).rejects.toThrow();
    expect(chunks.length).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "repeated synchronous spawn failures do not grow the process's open fd count",
    async () => {
      state.forceSpawnThrow = true;
      const exec = new PolyglotExecutor({ projectRoot: () => process.cwd() });
      const before = openFdCount();
      for (let i = 0; i < 20; i++) {
        await expect(
          exec.execute({ language: "shell", code: "echo hi", background: true, timeout: 5000 }),
        ).rejects.toThrow();
      }
      const after = openFdCount();
      // Generous tolerance for unrelated fds Node/vitest itself may open/close during
      // the run — the point is "no monotonic leak", not exact equality.
      expect(after - before).toBeLessThan(5);
    },
  );
});
