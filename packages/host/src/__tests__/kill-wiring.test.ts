// CRITICAL 1 regression: kill affordance must reach dispatch when actions are wired
// This test verifies the PRODUCTION WIRING: that mountAgentsUI correctly wires
// actions by calling createAgentActions. It does NOT construct actions manually —
// that would bypass the bug (missing actions key in the production mount call).
import { describe, it, expect, vi, afterEach } from "vitest";
import { openDb, migrate } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil";
import { mountAgentsUI } from "../agents/mount";

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

describe("kill wiring across the mountAgentsUI → installAgentsUI boundary", () => {
  it("k-k kill affordance reaches dispatch when mountAgentsUI wires actions", async () => {
    const db = openDb(scratchDbPath("kill-wiring")); opened.push(db); migrate(db, "project");
    db.prepare(`INSERT INTO runs (id, session_id, agent, name, status, step_count, token_count, started_at)
                VALUES ('r1','s','worker','alpha','running',1,0,0)`).run();
    
    const ui = fakeUi();
    const dispatchSpy = vi.fn().mockResolvedValue(undefined);
    
    const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
    
    // This is the PRODUCTION mount path: extension.ts calls mountAgentsUI which must
    // wire actions internally. The test injects dispatch to spy on the wiring.
    const dispose: any = mountAgentsUI(pi as never, { ui } as never, {
      db,
      sessionId: "s",
      cwd: "/tmp",
      dispatch: dispatchSpy,
    });
    
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
    
    // Assert: the kill action must have been dispatched with the run id.
    // If mountAgentsUI does NOT wire actions, dispatchSpy will never be called.
    expect(dispatchSpy).toHaveBeenCalledWith("kill", { id: "r1" });
    
    dispose();
  });
});
