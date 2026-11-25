// Exercise the production mount and actions rather than injecting AgentActions.
import { describe, it, expect, vi, afterEach } from "vitest";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { openDb, migrate } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil";
import { mountAgentsUI } from "../agents/mount";
import { agentsHostFixture } from "./fixtures/agents-host";

const opened: { close(): void }[] = [];
afterEach(() => { for (const d of opened) d.close(); opened.length = 0; cleanupScratch(); });

type Dispatch = (action: string, args: Record<string, unknown>) => Promise<unknown>;
async function withWiring(dispatch: Dispatch | undefined, test: (h: ReturnType<typeof agentsHostFixture>) => Promise<void>): Promise<void> {
  const db = openDb(scratchDbPath("kill-wiring")); opened.push(db); migrate(db, "project");
  db.prepare(`INSERT INTO runs (id, session_id, agent, name, status, step_count, token_count, started_at)
              VALUES ('r1','s','worker','alpha','running',1,0,0)`).run();
  const h = agentsHostFixture();
  const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
  const scratch = dirname(scratchDbPath("kill-wiring-root"));
  const cwd = mkdtempSync(join(scratch, "kill-wiring-"));
  execFileSync("git", ["init", "-q"], { cwd });
  const dispose = mountAgentsUI(pi as never, { ui: h.ui } as never, {
    db, sessionId: "s", cwd, dispatch, piVersion: "1.2.0",
  }) as (() => void) & { openOverlay(): Promise<void> };
  const opening = dispose.openOverlay();
  try {
    await h.settle(); await h.send("\r");
    await test(h);
  } finally {
    dispose(); await h.settle(); await opening; h.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("kill wiring across the production mount boundary", () => {
  it("dispatches exactly one kill for the captured run", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    await withWiring(dispatch, async h => {
      await h.send("k"); expect(dispatch).not.toHaveBeenCalled();
      await h.send("k"); await h.settle();
      expect(dispatch).toHaveBeenCalledExactlyOnceWith("kill", { id: "r1" });
      expect(h.completions).toEqual(["detail"]);
    });
  });

  it.each([
    ["rejected dispatch", () => Promise.reject(new Error("dispatch rejected")), "dispatch rejected"],
    ["error result", () => Promise.resolve({ error: "handler unavailable" }), "handler unavailable"],
    ["isError result", () => Promise.resolve({ isError: true, content: "termination refused" }), "termination refused"],
    ["isError details", () => Promise.resolve({ isError: true, details: { error: "failure detail" } }), "failure detail"],
    ["isError without details", () => Promise.resolve({ isError: true }), "kill failed"],
  ] as const)("keeps the detail open after %s", async (_label, result, message) => {
    const dispatch = vi.fn(result);
    await withWiring(dispatch, async h => {
      const detail = h.focused()!;
      await h.send("k"); await h.send("k"); await h.settle();
      expect(dispatch).toHaveBeenCalledExactlyOnceWith("kill", { id: "r1" });
      expect(h.focused()).toBe(detail);
      expect(detail.render(96).join("\n")).toContain(message);
      expect(h.completions).toEqual([]);
      expect(h.ui.notify).not.toHaveBeenCalled();
    });
  });

  it("notifies once when production dispatch fails after detail closes", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
    const dispatch = vi.fn(() => pending);
    await withWiring(dispatch, async h => {
      await h.send("k"); await h.send("k"); await h.send("\u001b");
      reject(new Error("dispatch later failed")); await h.settle();
      expect(h.completions).toEqual(["detail"]);
      expect(h.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/dispatch later failed/), "error");
    });
  });

  it("does not offer kill when dispatch is unavailable", async () => {
    await withWiring(undefined, async h => {
      const detail = h.focused()!;
      expect(detail.render(96).join("\n")).toContain("kill unavailable");
      await h.send("k"); await h.send("k");
      expect(detail.render(96).join("\n")).not.toContain("k again to kill");
      expect(h.completions).toEqual([]);
    });
  });
});
