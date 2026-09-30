// packages/host/src/__tests__/agents-ui.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { controlConfig } from "../control";
import { mountAgentsUI } from "../agents/mount";
import { openDb, migrate } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil";
import { installAgentsUI, registerAgentsUI, buildAgentsSelector } from "../agents/agents-ui";
import { AgentStore } from "@spider/ui";
import { createRunSource } from "../agents/run-source";

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

describe("installAgentsUI", () => {
  it("shortcut and command target the current install, not a stale closure", async () => {
    const db = openDb(scratchDbPath("aui-reinst")); opened.push(db); migrate(db, "project");
    db.prepare(`INSERT INTO runs (id, session_id, agent, status, step_count, token_count, started_at)
                VALUES ('r1','s2','worker','running',1,0,0)`).run();
    
    // A single activation owns the registration across session_start remounts.
    const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
    
    const registration = registerAgentsUI(pi);

    // First install with ui1
    const ui1 = fakeUi();
    const dispose1 = installAgentsUI(pi as never, { ui: ui1 } as never, { db, sessionId: "s1", registration });
    
    // Check if shortcut was registered
    expect(pi.registerShortcut).toHaveBeenCalledTimes(1);
    // regression guard: must use a non-conflicting chord (ctrl+g alone is pi's
    // built-in app.editor.external, which makes pi SKIP our registration).
    expect(pi.registerShortcut.mock.calls[0][0]).toBe("alt+shift+up");
    const handler = pi.registerShortcut.mock.calls[0][1].handler;
    
    // Second install with ui2 (simulating session_start re-fire with same pi)
    const ui2 = fakeUi();
    const dispose2 = installAgentsUI(pi as never, { ui: ui2 } as never, { db, sessionId: "s2", registration });
    
    // Shortcut should not be registered again
    expect(pi.registerShortcut).toHaveBeenCalledTimes(1);
    
    // After fix: handler should call current (ui2) install's openGrid, not the stale closure
    handler({});
    
    // openGrid is async but calls ui.custom synchronously at the start
    // Wait a tick for the async call to begin
    await new Promise(resolve => setImmediate(resolve));
    
    // After fix: ui2.custom should be called (current install)
    expect(ui2.custom).toHaveBeenCalled();
    expect(ui1.custom).not.toHaveBeenCalled();
    
    dispose1();
    dispose2();
  });

  it("mounts a footer widget when an agent is active and clears on dispose", () => {
    const db = openDb(scratchDbPath("aui")); opened.push(db); migrate(db, "project");
    db.prepare(`INSERT INTO runs (id, session_id, agent, status, step_count, token_count, started_at)
                VALUES ('r1','s','worker','running',1,10,0)`).run();
    const ui = fakeUi();
    const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
    const dispose = installAgentsUI(pi as never, { ui } as never, { db, sessionId: "s" });
    expect(ui.setWidget).toHaveBeenCalledWith("spider-agents", expect.anything(), { placement: "aboveEditor" });
    dispose();
    expect(ui.setWidget).toHaveBeenLastCalledWith("spider-agents", undefined);
  });

  it("does not mount a footer when there are zero agents", () => {
    const db = openDb(scratchDbPath("aui0")); opened.push(db); migrate(db, "project");
    const ui = fakeUi();
    const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
    const dispose = installAgentsUI(pi as never, { ui } as never, { db, sessionId: "s" });
    expect(ui.widgets.has("spider-agents")).toBe(false);
    dispose();
  });


});

const th = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s, glyph: "🕸" };

it("selector routes keys via matchesKey: arrows move, enter drills, esc steps back then releases, ctrl+c always releases (#56)", () => {
  const calls: string[] = [];
  let drilled = false;
  const ctrl = {
    moveSelect: (d: number) => calls.push("move" + d),
    drill: () => { drilled = true; calls.push("drill"); },
    isDrilled: () => drilled,
    closeDetail: () => { drilled = false; calls.push("closeDetail"); },
    forwardToDetail: (_d: string) => calls.push("fwd"),
    close: () => calls.push("close"),
    repaint: () => {},
  };
  const sel = buildAgentsSelector(ctrl as never);
  expect(sel.render(120)).toEqual([]);            // pure key sink — renders nothing

  sel.handleInput("\x1b[B"); expect(calls).toContain("move1");   // Down
  sel.handleInput("\x1b[A"); expect(calls).toContain("move-1");  // Up
  sel.handleInput("\r");     expect(drilled).toBe(true);         // Enter drills
  sel.handleInput("k");      expect(calls).toContain("fwd");     // forwarded to the detail while drilled
  sel.handleInput("\u001b"); expect(drilled).toBe(false);       // Esc steps back to selection
  sel.handleInput("\u001b"); expect(calls).toContain("close");  // Esc again releases to chat

  // Ctrl+C always releases — both while selecting and while drilled
  calls.length = 0; sel.handleInput("\x03"); expect(calls).toContain("close");
  drilled = true; calls.length = 0; sel.handleInput("\x03"); expect(calls).toContain("close");
});

it("openOverlay opens a pure key-sink overlay and focuses it via onHandle (#56)", async () => {
  const db = openDb(scratchDbPath("aui-anchor")); opened.push(db); migrate(db, "project");
  db.prepare(`INSERT INTO runs (id, session_id, agent, status, step_count, token_count, started_at)
              VALUES ('r1','s','worker','running',1,0,0)`).run();
  const ui = fakeUi();
  const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
  const dispose = installAgentsUI(pi as never, { ui } as never, { db, sessionId: "s" });
  // Every install has a reachable shortcut.
  const calls = pi.registerShortcut.mock.calls;
  expect(calls).toHaveLength(1);
  {
    calls.at(-1)![1].handler({});
    await new Promise((r) => setImmediate(r));
    expect(ui.custom).toHaveBeenCalled();
    const opts = ui.custom.mock.calls.at(-1)![1];
    expect(opts.overlay).toBe(true);
    expect(typeof opts.onHandle).toBe("function");        // focuses the overlay so it owns input
    const focus = vi.fn();
    opts.onHandle({ focus });
    expect(focus).toHaveBeenCalled();
  }
  dispose();
});

it("keeps the footer mounted while the selector is open (footer stays static, no suppression) (#50)", async () => {
  const db = openDb(scratchDbPath("aui-suppress")); opened.push(db); migrate(db, "project");
  db.prepare(`INSERT INTO runs (id, session_id, agent, status, step_count, token_count, started_at)
              VALUES ('r1','s','worker','running',1,0,0)`).run();
  const ui = fakeUi();
  let resolveCustom!: () => void;
  ui.custom.mockReturnValue(new Promise<void>((r) => { resolveCustom = () => r(); }));
  const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
  const dispose: any = installAgentsUI(pi as never, { ui } as never, { db, sessionId: "s" });
  expect(ui.widgets.has("spider-agents")).toBe(true);   // footer mounted while an agent is active
  const p = dispose.openOverlay();
  expect(ui.widgets.has("spider-agents")).toBe(true);   // STILL mounted while the selector is open (static)
  resolveCustom();
  await p;
  expect(ui.widgets.has("spider-agents")).toBe(true);   // and after it closes
  dispose();
});

it("renders the drilled detail ABOVE the static footer rows in the same widget (#57)", () => {
  const db = openDb(scratchDbPath("aui-detail")); opened.push(db); migrate(db, "project");
  db.prepare(`INSERT INTO runs (id, session_id, agent, name, status, step_count, token_count, started_at)
              VALUES ('r1','s','scout','one','running',1,0,0),('r2','s','worker','two','running',1,0,0)`).run();
  const ui = fakeUi();
  let overlay: any;
  ui.custom.mockImplementation((factory: any) => new Promise<void>(() => {
    overlay = factory({ requestRender() {} }, ui.theme, {}, () => {});
  }));
  const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
  const dispose: any = installAgentsUI(pi as never, { ui } as never, { db, sessionId: "s" });

  // render the mounted footer widget
  const widgetFactory = ui.widgets.get("spider-agents") as any;
  const footerComp = widgetFactory({ requestRender() {} }, ui.theme);

  dispose.openOverlay();                       // beginSelect + open the key-sink overlay (captured)
  const beforeLines = footerComp.render(120);  // selecting, cursor, NO detail
  expect(beforeLines.join("\n")).not.toContain("╭");

  overlay.handleInput("\r");                    // Enter → drill the selected run
  const afterLines = footerComp.render(120);
  expect(afterLines.join("\n")).toContain("╭"); // detail frame now present
  expect(afterLines.length).toBeGreaterThan(beforeLines.length);
  // the detail floats ABOVE the footer rows (same static widget): its top border is line 0,
  // and the footer agent rows are the LAST lines. (Assert positionally — the spinner frame in a
  // row can change between renders, so don't compare row strings byte-for-byte.)
  expect(afterLines[0]).toContain("╭");
  expect(afterLines[afterLines.length - 1]).toMatch(/one|two/);
  dispose();
});

it("does not open the selector (input trap) when there are no agents (#trap)", async () => {
  const db = openDb(scratchDbPath("aui-noagents")); opened.push(db); migrate(db, "project");
  const ui = fakeUi();
  const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
  const dispose: any = installAgentsUI(pi as never, { ui } as never, { db, sessionId: "s" });
  await dispose.openOverlay();               // no agents inserted
  expect(ui.custom).not.toHaveBeenCalled();  // never opens a key-sink over an empty footer
  expect(ui.notify).toHaveBeenCalled();
  dispose();
});

it("does not open an invisible selector when the footer is disabled", async () => {
  const db = openDb(scratchDbPath("aui-footer-off")); opened.push(db); migrate(db, "project");
  db.prepare(`INSERT INTO runs (id, session_id, agent, status, step_count, token_count, started_at)
              VALUES ('r1','footer-off','worker','running',1,0,0)`).run();
  const ui = fakeUi();
  const dispose = installAgentsUI({ registerShortcut: vi.fn() }, { ui }, { db, sessionId: "footer-off", showFooter: false }) as (() => void) & { openOverlay(): Promise<void> };
  await dispose.openOverlay();
  expect(ui.custom).not.toHaveBeenCalled();
  expect(ui.notify).toHaveBeenCalled();
  dispose();
});

it("production mount suppresses the active agents footer when ui.footer is false", () => {
  const root = resolve(".spider/scratch");
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, "footer-"));
  execFileSync("git", ["init", "-q"], { cwd });
  const db = openDb(scratchDbPath("footer-config")); opened.push(db); migrate(db, "project");
  db.prepare(`INSERT INTO runs (id, session_id, agent, status, step_count, token_count, started_at)
              VALUES ('r1','footer','worker','running',1,0,0)`).run();
  try {
    controlConfig("set", cwd, "ui.footer", false);
    const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn() };
    const ui = fakeUi();
    const dispose = mountAgentsUI(pi, { ui }, { db, sessionId: "footer", cwd });
    expect(ui.widgets.has("spider-agents")).toBe(false);
    dispose();
    controlConfig("set", cwd, "ui.footer", true);
    const enabledUi = fakeUi();
    const enabled = mountAgentsUI(pi, { ui: enabledUi }, { db, sessionId: "footer", cwd });
    expect(enabledUi.widgets.has("spider-agents")).toBe(true);
    enabled();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
