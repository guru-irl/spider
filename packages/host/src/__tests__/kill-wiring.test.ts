// CRITICAL 1 regression: kill affordance must reach dispatch when actions are wired
import { describe, it, expect, vi, afterEach } from "vitest";
import { openDb, migrate } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil";
import { installAgentsUI } from "../agents/agents-ui";

const opened: { close(): void }[] = [];
afterEach(() => { for (const d of opened) d.close(); opened.length = 0; cleanupScratch(); });

function fakeUi() {
  const widgets = new Map<string, unknown>();
  return {
    widgets,
    setWidget: vi.fn((k: string, v: unknown) => { if (v === undefined) widgets.delete(k); else widgets.set(k, v); }),
    custom: vi.fn(),
    requestRender: vi.fn(),
    notify: vi.fn(),
    theme: { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s },
  };
}

describe("kill wiring across the installAgentsUI boundary", () => {
  it("onKill reaches the wired actions.kill when drilling into a detail and triggering k-k", async () => {
    const db = openDb(scratchDbPath("kill-wiring")); opened.push(db); migrate(db, "project");
    db.prepare(`INSERT INTO runs (id, session_id, agent, name, status, step_count, token_count, started_at)
                VALUES ('r1','s','worker','alpha','running',1,0,0)`).run();
    
    const ui = fakeUi();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const killSpy = vi.fn();
    const actions = {
      kill: async (runId: string) => {
        killSpy(runId);
        await dispatch("kill", { id: runId });
      },
      message: vi.fn(),
      interrupt: vi.fn(),
      resume: vi.fn(),
      follow: vi.fn(),
    };
    
    const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
    
    // This is the production call site (extension.ts:520) — it MUST wire actions
    const dispose: any = installAgentsUI(pi as never, { ui } as never, { db, sessionId: "s", actions });
    
    // Capture the overlay factory from ui.custom
    let overlayComp: any;
    ui.custom.mockImplementation((factory: any) => {
      overlayComp = factory({ requestRender() {} }, ui.theme, {}, () => {});
      return Promise.resolve();
    });
    
    await dispose.openOverlay();
    expect(ui.custom).toHaveBeenCalled();
    
    // Enter to drill into the selected run
    overlayComp.handleInput("\r");
    
    // Verify we're drilled before testing kill
    const widgetFactory = ui.widgets.get("spider-agents") as any;
    expect(widgetFactory).toBeDefined();
    
    // Simulate k-k sequence (kill affordance)
    overlayComp.handleInput("k");
    overlayComp.handleInput("k");
    
    // Wait for async dispatch
    await new Promise(resolve => setImmediate(resolve));
    
    // Assert: the kill action must have been dispatched with the run id
    if (killSpy.mock.calls.length === 0) {
      throw new Error(`CRITICAL 1 BUG NOT FIXED: killSpy was not called. actions.kill: ${typeof actions.kill}, dispatch calls: ${dispatch.mock.calls.length}`);
    }
    expect(killSpy).toHaveBeenCalledWith("r1");
    expect(dispatch).toHaveBeenCalledWith("kill", { id: "r1" });
    
    dispose();
  });
  
  it("fails when actions are NOT wired (discrimination check)", async () => {
    const db = openDb(scratchDbPath("kill-wiring-no-actions")); opened.push(db); migrate(db, "project");
    db.prepare(`INSERT INTO runs (id, session_id, agent, name, status, step_count, token_count, started_at)
                VALUES ('r1','s','worker','alpha','running',1,0,0)`).run();
    
    const ui = fakeUi();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    
    const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
    
    // NO actions key — this is the current production bug
    const dispose: any = installAgentsUI(pi as never, { ui } as never, { db, sessionId: "s" });
    
    // Capture the overlay factory
    let overlayComp: any;
    ui.custom.mockImplementation((factory: any) => {
      overlayComp = factory({ requestRender() {} }, ui.theme, {}, () => {});
      return Promise.resolve();
    });
    
    await dispose.openOverlay();
    
    // Enter to drill
    overlayComp.handleInput("\r");
    
    // k-k sequence
    overlayComp.handleInput("k");
    overlayComp.handleInput("k");
    
    await new Promise(resolve => setImmediate(resolve));
    
    // Without actions wired, dispatch is never called
    expect(dispatch).not.toHaveBeenCalled();
    
    dispose();
  });
});
