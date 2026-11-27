// packages/host/src/__tests__/agents-ui.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { controlConfig } from "../control";
import { mountAgentsUI } from "../agents/mount";
import { openDb, migrate, bus, type Db } from "@spider/db-core";
import { TuiAltScreen, stripTerminalSequences, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil";
import { installAgentsUI, registerAgentsUI, buildAgentsSelector } from "../agents/agents-ui";
import { AgentStore, type AgentActions } from "@spider/ui";
import { createRunSource } from "../agents/run-source";
import { agentsHostFixture } from "./fixtures/agents-host";

const opened: { close(): void }[] = [];
const closeHarnesses: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closeHarnesses.splice(0).reverse()) await close();
  for (const d of opened) d.close(); opened.length = 0; cleanupScratch();
});

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

function seededDb(name: string, count = 2, events = 0): Db {
  const db = openDb(scratchDbPath(name)); opened.push(db); migrate(db, "project");
  const insert = db.prepare(`INSERT INTO runs (id, session_id, agent, name, status, step_count, token_count, started_at)
    VALUES (?, 's', 'worker', ?, 'running', 1, 0, ?)`);
  for (let i = 1; i <= count; i++) insert.run(`r${i}`, i === 1 ? "one" : "two", i);
  const event = db.prepare(`INSERT INTO run_events (run_id, session_id, ts, type, summary) VALUES ('r1', 's', ?, 'message', ?)`);
  for (let i = 0; i < events; i++) event.run(i, `message-${String(i).padStart(3, "0")}`);
  return db;
}

function watchDetailReads(db: Db) {
  const counts = { runs: 0, events: 0 };
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    const query = sql.startsWith("SELECT * FROM runs WHERE id = ?") ? "runs"
      : sql.startsWith("SELECT id, run_id, session_id, ts, type, tool, summary, payload FROM run_events") ? "events" : undefined;
    if (!query) return statement;
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if ((query === "runs" && property === "get") || (query === "events" && property === "all")) counts[query]++;
          return Reflect.apply(value, target, args);
        };
      },
    });
  });
  return { counts, restore: () => spy.mockRestore() };
}

function realCustomHarness(db: Db, options: { mode?: "regular" | "fullscreen"; piVersion?: string | null; mountCwd?: string; documentRows?: number; actions?: AgentActions; iconStyle?: "text" | "nerd" } = {}) {
  const h = agentsHostFixture(options);
  const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn() };
  const piVersion = options.piVersion === null ? undefined : options.piVersion ?? "1.2.0";
  const dispose = (options.mountCwd
    ? mountAgentsUI(pi, { ui: h.ui } as never, { db, sessionId: "s", cwd: options.mountCwd, piVersion } as never)
    : installAgentsUI(pi, { ui: h.ui } as never, { db, sessionId: "s", piVersion, actions: options.actions, iconStyle: options.iconStyle } as never)) as (() => void) & { openOverlay(): Promise<void> };
  const start = async () => { void dispose.openOverlay(); await h.settle(); };
  closeHarnesses.push(async () => { dispose(); h.releaseHeld(); await h.settle(); h.close(); });
  return { ...h, dispose, start };
}

function actions(kill: AgentActions["kill"]): AgentActions {
  return { message() {}, interrupt() {}, resume() {}, follow() {}, kill };
}
function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function subscriptionCounts() {
  const live = { store: 0, source: 0 };
  const storeOn = AgentStore.prototype.onChange;
  const busOn = bus.on.bind(bus);
  const storeSpy = vi.spyOn(AgentStore.prototype, "onChange").mockImplementation(function(this: AgentStore, listener) {
    const off = storeOn.call(this, listener); live.store++;
    let active = true;
    return () => { if (active) { active = false; live.store--; off(); } };
  });
  const sourceSpy = vi.spyOn(bus, "on").mockImplementation(listener => {
    const off = busOn(listener); live.source++;
    let active = true;
    return () => { if (active) { active = false; live.source--; off(); } };
  });
  return { live, restore: () => { storeSpy.mockRestore(); sourceSpy.mockRestore(); } };
}

function expectNoGeometryWrappers(h: ReturnType<typeof agentsHostFixture>) {
  for (const key of ["doRender", "compositeOverlays", "showOverlay", "hideOverlay", "render"]) {
    expect(Object.getOwnPropertyDescriptor(h.view.tui, key), key).toBeUndefined();
  }
  expect(Object.getOwnPropertyDescriptor(h.view.dock, "render")).toBeUndefined();
  for (const child of h.view.children.slice(1)) {
    expect(Object.getOwnPropertyDescriptor(child, "render")).toBeUndefined();
  }
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

it("selector routes arrows, Enter, Esc and Ctrl+C without forwarding detail input", () => {
  const calls: string[] = [];
  const ctrl = {
    moveSelect: (delta: number) => calls.push(`move${delta}`),
    drill: () => calls.push("drill"),
    close: (reason: "escape" | "interrupt") => calls.push(reason),
    repaint: () => {},
  };
  const selector = buildAgentsSelector(ctrl);
  expect(selector.render(120)).toEqual([]);
  selector.handleInput("\x1b[B"); selector.handleInput("\x1b[A"); selector.handleInput("\r");
  selector.handleInput("k"); selector.handleInput("\u001b"); selector.handleInput("\x03");
  expect(calls).toEqual(["move1", "move-1", "drill", "escape", "interrupt"]);
});

it("opens the pure key-sink selector and focuses it once through onHandle", async () => {
  const h = realCustomHarness(seededDb("aui-anchor"));
  await h.start();
  expect(h.ui.custom).toHaveBeenCalledTimes(1);
  expect(h.ui.custom.mock.calls[0]![1]).toMatchObject({ overlay: true });
  expect(h.focuses).toEqual(["selector"]);
  expect(h.focused()?.render(120)).toEqual([]);
  await h.send("\u001b");
  expect(h.focused()).toBe(h.view.editor);
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

it("enter opens one real detail without changing footer rows or dock positions", async () => {
  const db = seededDb("aui-detail");
  const h = realCustomHarness(db);
  await h.start(); await h.send("\x1b[B");
  const footer = h.ui.widgets.get("spider-agents")!;
  const beforeRows = footer.render(120).length;
  const beforeDock = h.view.markerPositions();
  h.view.terminal.send("\r"); h.view.terminal.send("\r");
  await h.settle();
  expect(h.ui.custom).toHaveBeenCalledTimes(2);
  expect(h.ui.custom.mock.calls[1]![1]).toMatchObject({
    overlay: true, overlayOptions: { anchor: "top-center", width: "80%", minWidth: 24, maxHeight: "100%" },
  });
  expect(footer.render(120)).toHaveLength(beforeRows);
  expect(footer.render(120).join("\n")).not.toContain("╭");
  expect(h.view.markerPositions()).toEqual(beforeDock);
  const detail = h.focused()!;
  expect(detail.render(96).join("\n")).toContain("two");
  expect(h.focuses).toEqual(["selector", "detail"]);
  db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = 'r1'").run(Date.now() - 20_000);
  bus.emit({ sessionId: "s", runId: "r1", ts: Date.now(), type: "status" });
  await h.settle();
  expect(detail.render(96).join("\n")).toContain("two");
  expect(h.focuses).toEqual(["selector", "detail"]);
});

it("uses the configured icon style in the footer and detail overlay", async () => {
  const h = realCustomHarness(seededDb("aui-icons", 1), { iconStyle: "nerd" });
  expect(h.ui.widgets.get("spider-agents")!.render(120).join("\n")).toContain("\u{F167A}");
  await h.start(); await h.send("\r");
  expect(h.focused()!.render(96)[0]).toContain("\u{F167A}  one");
});

it("Esc closes detail then selector and restores the editor text and cursor", async () => {
  const h = realCustomHarness(seededDb("aui-esc", 1, 25));
  h.view.editor.setText("keep this draft"); h.view.editor.cursor = 4;
  await h.start();
  const selector = h.focused();
  await h.send("\r");
  const detail = h.focused();
  expect(detail).not.toBe(selector);
  await h.send("x");
  expect(h.view.editor.getText()).toBe("keep this draft");
  expect(h.view.editor.cursor).toBe(4);
  await h.send("\u001b");
  expect(h.completions).toEqual(["detail"]);
  expect(h.focused()).toBe(selector);
  await h.send("\u001b");
  expect(h.completions).toEqual(["detail", "selector"]);
  expect(h.focused()).toBe(h.view.editor);
  expect(h.view.editor.getText()).toBe("keep this draft");
  expect(h.view.editor.cursor).toBe(4);
});

it("Ctrl+C closes the detail and selector in top-first order", async () => {
  const h = realCustomHarness(seededDb("aui-ctrl-c", 1));
  await h.start(); await h.send("\r"); await h.send("\x03");
  expect(h.completions).toEqual(["detail", "selector"]);
  expect(h.stack()).toHaveLength(0);
  expect(h.focused()).toBe(h.view.editor);
});

it("keeps retained detail readable after the list empties, then closes the empty selector", async () => {
  const db = seededDb("aui-retention", 1, 3);
  const h = realCustomHarness(db);
  await h.start(); await h.send("\r");
  const detail = h.focused()!;
  expect(detail.render(96).join("\n")).toContain("message-002");
  db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = 'r1'").run(Date.now() - 20_000);
  bus.emit({ sessionId: "s", runId: "r1", ts: Date.now(), type: "status" });
  await h.settle();
  expect(h.ui.widgets.has("spider-agents")).toBe(false);
  expect(h.focused()).toBe(detail);
  expect(detail.render(96).join("\n")).toContain("message-002");
  expect(h.completions).toEqual([]);
  await h.send("\u001b");
  expect(h.completions).toEqual(["detail", "selector"]);
  expect(h.focused()).toBe(h.view.editor);
});

it("closes an empty selector when no detail is open", async () => {
  const db = seededDb("aui-empty-selector", 1);
  const h = realCustomHarness(db); await h.start();
  db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = 'r1'").run(Date.now() - 20_000);
  bus.emit({ sessionId: "s", runId: "r1", ts: Date.now(), type: "status" });
  await h.settle();
  expect(h.completions).toEqual(["selector"]);
  expect(h.focused()).toBe(h.view.editor);
});

it("keeps the selector when another run appears before an empty detail closes", async () => {
  const db = seededDb("aui-new-run", 1);
  const h = realCustomHarness(db); await h.start(); const selector = h.focused(); await h.send("\r");
  db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = 'r1'").run(Date.now() - 20_000);
  bus.emit({ sessionId: "s", runId: "r1", ts: Date.now(), type: "status" });
  db.prepare("INSERT INTO runs (id, session_id, agent, status, step_count, token_count, started_at) VALUES ('r2','s','worker','running',1,0,2)").run();
  bus.emit({ sessionId: "s", runId: "r2", ts: Date.now(), type: "status" });
  await h.settle(); await h.send("\u001b");
  expect(h.completions).toEqual(["detail"]);
  expect(h.focused()).toBe(selector);
});

it("shutdown closes top-first once and blocks new interactions", async () => {
  const h = realCustomHarness(seededDb("aui-shutdown", 1));
  await h.start(); await h.send("\r");
  h.dispose(); h.dispose(); await h.settle();
  expect(h.completions).toEqual(["detail", "selector"]);
  expect(h.ui.widgets.has("spider-agents")).toBe(false);
  expect(h.focused()).toBe(h.view.editor);
  let settled = false;
  void h.dispose.openOverlay().then(() => { settled = true; });
  await h.settle();
  expect(settled).toBe(true);
  expect(h.ui.custom).toHaveBeenCalledTimes(2);
});

it.each(["escape", "kill"] as const)("releases wrappers and listeners across 20 %s cycles", async close => {
  const counts = subscriptionCounts();
  const h = realCustomHarness(seededDb(`aui-cycles-${close}`, 1), { actions: actions(async () => {}) });
  const baseline = { ...counts.live };
  try {
    for (let i = 0; i < 20; i++) {
      await h.start(); await h.send("\r");
      if (close === "kill") { await h.send("k"); await h.send("k"); }
      else await h.send("\u001b");
      await h.send("\u001b");
      expect(h.stack()).toHaveLength(0);
      expectNoGeometryWrappers(h);
      expect(counts.live).toEqual(baseline);
    }
    h.dispose(); await h.settle();
    expect(counts.live).toEqual({ store: 0, source: 0 });
  } finally { h.dispose(); counts.restore(); }
});

it.each(["fullscreen", "regular"] as const)("releases retired adapters across 20 shutdowns in %s when Pi never completes", async mode => {
  vi.useFakeTimers();
  const counts = subscriptionCounts();
  const db = seededDb(`aui-cycles-shutdown-${mode}`, 1);
  const h = agentsHostFixture({ mode });
  const pi = { registerShortcut: vi.fn(), registerCommand: vi.fn() };
  let dispose: (() => void) | undefined;
  try {
    for (let i = 0; i < 20; i++) {
      dispose = installAgentsUI(pi, { ui: h.ui } as never, { db, sessionId: "s", piVersion: "1.2.0" });
      const open = dispose as (() => void) & { openOverlay(): Promise<void> };
      void open.openOverlay(); await h.settle(); await h.send("\r");
      const foreign: Component = { render: () => ["foreign"], invalidate() {} };
      const handle = h.view.tui.showOverlay(foreign, { width: 20, nonCapturing: true });
      const completions = h.completions.length;
      dispose(); await h.settle();
      expect(h.completions).toHaveLength(completions);
      expect(counts.live).toEqual({ store: 0, source: 0 });
      vi.advanceTimersByTime(1_000); await h.settle();
      expect(h.completions).toHaveLength(completions);
      expectNoGeometryWrappers(h);
      expect(counts.live).toEqual({ store: 0, source: 0 });
      handle.hide(); await h.settle();
    }
  } finally {
    dispose?.(); h.close(); counts.restore(); vi.useRealTimers();
  }
});

it("repeated open commands cannot stack selector interactions", async () => {
  const h = realCustomHarness(seededDb("aui-single-selector", 1));
  await h.start();
  void h.dispose.openOverlay(); void h.dispose.openOverlay(); await h.settle();
  expect(h.ui.custom).toHaveBeenCalledTimes(1);
  expect(h.stack()).toHaveLength(1);
});

it.each(["escape", "shutdown"] as const)("%s during selector opening waits for its handle", async reason => {
  const h = realCustomHarness(seededDb(`aui-selector-opening-${reason}`, 1));
  h.holdNext("selector-handle"); await h.start();
  expect(h.hasHeld()).toBe(true);
  if (reason === "escape") await h.send("\u001b");
  else { h.dispose(); await h.settle(); }
  expect(h.completions).toEqual([]);
  expect(h.stack()).toHaveLength(1);
  h.releaseHeld(); await h.settle();
  expect(h.completions).toEqual(["selector"]);
  expect(h.focused()).toBe(h.view.editor);
});

it("Esc during detail opening waits for its handle without popping the parent", async () => {
  const h = realCustomHarness(seededDb("aui-opening", 1));
  await h.start();
  const selector = h.focused();
  h.holdNext("handle"); await h.send("\r");
  expect(h.hasHeld()).toBe(true);
  expect(h.stack()).toHaveLength(2);
  await h.send("\u001b");
  expect(h.completions).toEqual([]);
  expect(h.stack()).toHaveLength(2);
  h.releaseHeld(); await h.settle();
  expect(h.completions).toEqual(["detail"]);
  expect(h.focused()).toBe(selector);
});

it("Esc delivered to the selector during a deferred child factory cancels only the child", async () => {
  const h = realCustomHarness(seededDb("aui-factory", 1));
  await h.start();
  const selector = h.focused();
  h.holdNext("factory"); await h.send("\r");
  expect(h.hasHeld()).toBe(true);
  expect(h.focused()).toBe(selector);
  await h.send("\u001b");
  expect(h.completions).toEqual([]);
  h.releaseHeld(); await h.settle();
  expect(h.completions).toEqual(["detail"]);
  expect(h.focused()).toBe(selector);
});

it("shutdown during a deferred factory does not read the closed store", async () => {
  const db = seededDb("aui-factory-shutdown", 1);
  const h = realCustomHarness(db); await h.start(); h.holdNext("factory"); await h.send("\r");
  h.dispose();
  opened.splice(opened.indexOf(db), 1); db.close();
  h.releaseHeld(); await h.settle();
  expect(h.completions).toEqual(["detail", "selector"]);
  expect(h.focused()).toBe(h.view.editor);
});

it.each(["interrupt", "shutdown"] as const)("%s during opening queues child then parent", async reason => {
  const h = realCustomHarness(seededDb(`aui-opening-${reason}`, 1));
  await h.start(); h.holdNext("handle"); await h.send("\r");
  if (reason === "interrupt") await h.send("\x03");
  else { h.dispose(); await h.settle(); }
  expect(h.completions).toEqual([]);
  expect(h.stack()).toHaveLength(2);
  h.releaseHeld(); await h.settle();
  expect(h.completions).toEqual(["detail", "selector"]);
  expect(h.focused()).toBe(h.view.editor);
});

it.each([
  { name: "hidden", options: {}, hide: true },
  { name: "non-capturing", options: { nonCapturing: true }, hide: false },
] as const)("Esc leaves the detail immediately beneath a $name foreign overlay", async ({ name, options, hide }) => {
  const h = realCustomHarness(seededDb(`aui-detail-${name}`, 1));
  await h.start(); const selector = h.focused(); await h.send("\r");
  const detail = h.focused()!;
  const foreign: Component = { render: () => ["foreign"], invalidate() {} };
  const handle = h.view.tui.showOverlay(foreign, { width: 20, ...options });
  if (hide) handle.setHidden(true);
  expect(h.focused()).toBe(detail);
  try {
    await h.send("\u001b");
    const entries = (h.view.tui as unknown as { overlayStack: { component: Component; hidden: boolean }[] }).overlayStack;
    expect(entries.find(entry => entry.component === detail)?.hidden).toBe(true);
    expect(h.focused()).toBe(selector);
    expect(h.completions).toEqual([]);
    expect(h.stack().at(-1)).toBe(foreign);
  } finally { handle.hide(); await h.settle(); }
  expect(h.completions).toEqual(["detail"]);
  expect(h.focused()).toBe(selector);
});

it.each([
  { name: "hidden", options: {}, hide: true },
  { name: "non-capturing", options: { nonCapturing: true }, hide: false },
] as const)("Esc leaves the selector immediately beneath a $name foreign overlay", async ({ name, options, hide }) => {
  const h = realCustomHarness(seededDb(`aui-selector-${name}`, 1));
  await h.start(); const selector = h.focused()!;
  const foreign: Component = { render: () => ["foreign"], invalidate() {} };
  const handle = h.view.tui.showOverlay(foreign, { width: 20, ...options });
  if (hide) handle.setHidden(true);
  expect(h.focused()).toBe(selector);
  try {
    await h.send("\u001b");
    const entries = (h.view.tui as unknown as { overlayStack: { component: Component; hidden: boolean }[] }).overlayStack;
    expect(entries.find(entry => entry.component === selector)?.hidden).toBe(true);
    expect(h.focused()).toBe(h.view.editor);
    expect(h.completions).toEqual([]);
    expect(h.stack().at(-1)).toBe(foreign);
  } finally { handle.hide(); await h.settle(); }
  expect(h.completions).toEqual(["selector"]);
  expect(h.focused()).toBe(h.view.editor);
});

it.each([
  { name: "hidden", options: {}, hide: true },
  { name: "non-capturing", options: { nonCapturing: true }, hide: false },
] as const)("Ctrl+C returns to the editor beneath a $name foreign overlay", async ({ name, options, hide }) => {
  const h = realCustomHarness(seededDb(`aui-interrupt-${name}`, 1));
  await h.start(); const selector = h.focused()!; await h.send("\r");
  const detail = h.focused()!;
  const foreign: Component = { render: () => ["foreign"], invalidate() {} };
  const handle = h.view.tui.showOverlay(foreign, { width: 20, ...options });
  if (hide) handle.setHidden(true);
  try {
    await h.send("\x03");
    const entries = (h.view.tui as unknown as { overlayStack: { component: Component; hidden: boolean }[] }).overlayStack;
    expect(entries.find(entry => entry.component === detail)?.hidden).toBe(true);
    expect(entries.find(entry => entry.component === selector)?.hidden).toBe(true);
    expect(h.focused()).toBe(h.view.editor);
    expect(h.completions).toEqual([]);
    expect(h.stack().at(-1)).toBe(foreign);
  } finally { handle.hide(); await h.settle(); }
  expect(h.completions).toEqual(["detail", "selector"]);
  expect(h.focused()).toBe(h.view.editor);
});

it.each(["detail", "selector"] as const)("Esc leaves the %s beneath a throwing visibility callback", async target => {
  const h = realCustomHarness(seededDb(`aui-${target}-throwing-visibility`, 1));
  await h.start(); const selector = h.focused()!;
  if (target === "detail") await h.send("\r");
  const closing = h.focused()!;
  const fallback = target === "detail" ? selector : h.view.editor;
  let throwing = false, calls = 0;
  const foreign: Component = { render: () => ["foreign"], invalidate() {} };
  const handle = h.view.tui.showOverlay(foreign, { width: 20, visible: () => {
    if (throwing) { calls++; throw new Error("foreign visibility failed"); }
    return false;
  } });
  await h.settle();
  const entries = (h.view.tui as unknown as { overlayStack: { component: Component; hidden: boolean }[] }).overlayStack;
  const queued: (() => void)[] = [];
  const scheduler = vi.spyOn(globalThis, "queueMicrotask").mockImplementation(fn => { queued.push(fn); });
  try {
    // Pi itself cannot render a throwing callback; run the close checks before rendering.
    throwing = true;
    closing.handleInput?.("\u001b");
    expect(queued.length).toBeGreaterThan(0);
    expect(() => { for (let i = 0; i < 10 && queued.length; i++) queued.shift()!(); }).not.toThrow();
    expect(queued).toHaveLength(0);
    expect(calls).toBeGreaterThan(0);
    expect(entries.find(item => item.component === closing)?.hidden).toBe(true);
    expect(h.focused()).toBe(fallback);
    expect(h.completions).toEqual([]);
    expect(h.stack().at(-1)).toBe(foreign);
  } finally {
    throwing = false; scheduler.mockRestore();
    for (const task of queued.splice(0)) task();
    handle.hide(); await h.settle();
  }
  expect(h.completions).toEqual([target]);
  expect(h.focused()).toBe(fallback);
});

it("does not pop a foreign top overlay when selector completion is queued", async () => {
  const h = realCustomHarness(seededDb("aui-foreign-selector", 1)); await h.start();
  const selector = h.focused()!;
  const foreign: Component = { render: () => ["foreign"], invalidate() {} };
  const handle = h.view.tui.showOverlay(foreign, { width: 20 });
  selector.handleInput?.("\u001b"); await h.settle();
  expect(h.stack().at(-1)).toBe(foreign);
  expect(h.completions).toEqual([]);
  handle.hide(); await h.settle();
  expect(h.completions).toEqual(["selector"]);
  expect(h.focused()).toBe(h.view.editor);
});

it("does not pop a foreign top overlay when a detail completion is queued", async () => {
  const h = realCustomHarness(seededDb("aui-foreign", 1));
  await h.start(); const selector = h.focused(); await h.send("\r");
  const detail = h.focused()!;
  const foreign: Component = { render: () => ["foreign"], invalidate() {} };
  const handle = h.view.tui.showOverlay(foreign, { width: 20 });
  h.view.tui.renderNow();
  detail.handleInput?.("\u001b"); await h.settle();
  expect(h.stack().at(-1)).toBe(foreign);
  expect(h.completions).toEqual([]);
  handle.hide(); await h.settle();
  expect(h.completions).toEqual(["detail"]);
  expect(h.focused()).toBe(selector);
});

it("does not focus a detail whose delayed handle is beneath a foreign overlay", async () => {
  const h = realCustomHarness(seededDb("aui-foreign-opening", 1));
  await h.start(); h.holdNext("handle"); await h.send("\r");
  const detail = h.focused()!;
  const foreign: Component = { render: () => ["foreign"], invalidate() {} };
  const handle = h.view.tui.showOverlay(foreign, { width: 20 });
  h.releaseHeld(); await h.settle();
  expect(h.focused()).toBe(foreign);
  expect(h.focuses).toEqual(["selector"]);
  detail.handleInput?.("\u001b"); await h.settle();
  expect(h.completions).toEqual([]);
  handle.hide(); await h.settle();
  expect(h.completions).toEqual(["detail"]);
});

it("completes retired interactions after a foreign custom overlay pops itself", async () => {
  vi.useFakeTimers();
  try {
    const h = realCustomHarness(seededDb("aui-retired-custom-foreign", 1));
    await h.start(); await h.send("\r");
    const foreign: Component = { render: () => ["foreign"], invalidate() {} };
    h.view.tui.showOverlay(foreign, { width: 20, nonCapturing: true });
    h.dispose(); await h.settle();
    expect(h.completions).toEqual([]);
    expect(h.stack().at(-1)).toBe(foreign);
    h.view.tui.hideOverlay();
    vi.advanceTimersByTime(25); await h.settle();
    expect(h.completions).toEqual(["detail", "selector"]);
    expect(h.focused()).toBe(h.view.editor);
  } finally { vi.useRealTimers(); }
});

it("releases subscriptions on shutdown while a foreign overlay delays completion", async () => {
  const h = realCustomHarness(seededDb("aui-foreign-shutdown", 1));
  await h.start(); await h.send("\r");
  const foreign: Component = { render: () => ["foreign"], invalidate() {} };
  const handle = h.view.tui.showOverlay(foreign, { width: 20 });
  h.dispose(); await h.settle();
  expect(h.completions).toEqual([]);
  expect(h.stack().at(-1)).toBe(foreign);
  expect(h.ui.widgets.has("spider-agents")).toBe(false);
  handle.hide(); await h.settle();
  expect(h.completions).toEqual(["detail", "selector"]);
  expect(h.focused()).toBe(h.view.editor);
});

it("clears a rejected child factory without completing the parent", async () => {
  const h = realCustomHarness(seededDb("aui-reject", 1));
  await h.start(); const selector = h.focused();
  h.holdNext("reject"); await h.send("\r");
  expect(h.completions).toEqual([]);
  expect(h.focused()).toBe(selector);
  await h.send("\r");
  expect(h.ui.custom).toHaveBeenCalledTimes(3);
  expect(h.focused()).not.toBe(selector);
});

it("routes pi wheel events only to conversation rows and does not capture drag", async () => {
  const h = realCustomHarness(seededDb("aui-wheel", 1, 100));
  await h.start(); await h.send("\r");
  const detail = h.focused()!;
  const firstMessage = () => {
    const lines = detail.render(96).slice(6, -2).map(stripTerminalSequences).join("\n");
    const found = /message-(\d{3})/.exec(lines);
    expect(found).not.toBeNull();
    return Number(found![1]);
  };
  const before = firstMessage();
  const chatTop = h.view.transcript.scrollTop;
  await h.send("\x1b[<64;21;8M");
  expect(firstMessage()).toBe(before - 3);
  expect(h.view.transcript.scrollTop).toBe(chatTop);
  await h.send("\x1b[<64;21;3M");
  expect(firstMessage()).toBe(before - 3);
  expect(h.view.transcript.scrollTop).toBe(chatTop);
  (h.view.tui as TuiAltScreen).setWheelScrollLines(1);
  await h.send("\x1b[<65;21;8M");
  expect(firstMessage()).toBe(before - 2);
  const drag: TuiMouseEvent = { type: "drag", button: "left", x: 2, y: 7, screenX: 14, screenY: 7,
    width: 96, height: 30, shift: false, alt: false, ctrl: false };
  expect(detail.handleMouse?.(drag)).toBeUndefined();
});

it("preserves a short regular document and dock while opening detail", async () => {
  const h = realCustomHarness(seededDb("aui-short-regular", 1), { mode: "regular", documentRows: 6 });
  await h.start();
  const before = h.view.markerPositions();
  const rows = h.view.baseRows();
  await h.send("\r");
  expect(h.view.markerPositions()).toEqual(before);
  expect(h.view.baseRows()).toBe(rows);
  expect(h.view.renderedRows()).toBe(rows);
  expect(h.focused()?.render(96).join("\n")).toMatch(/larger terminal/i);
});

it("does not focus a detail when a regular document has fewer than three rows", async () => {
  const h = realCustomHarness(seededDb("aui-tiny-regular", 1), { mode: "regular", documentRows: 2 });
  await h.start(); const selector = h.focused();
  await h.send("\r");
  expect(h.ui.custom).toHaveBeenCalledTimes(1);
  expect(h.focused()).toBe(selector);
  expect(h.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/larger/i), expect.anything());
});

it("keeps keyboard scrolling available on a regular terminal without mouse input", async () => {
  const h = realCustomHarness(seededDb("aui-regular", 1, 100), { mode: "regular" });
  await h.start(); await h.send("\r");
  const detail = h.focused()!;
  const before = detail.render(96).slice(6, -2).map(stripTerminalSequences).join("\n");
  await h.send("\x1b[A");
  const after = detail.render(96).slice(6, -2).map(stripTerminalSequences).join("\n");
  expect(after).not.toBe(before);
  expect(h.view.editor.getText()).toBe("draft text");
});

it("passes the running host version through the production mount", async () => {
  const root = dirname(scratchDbPath("agents-version-root"));
  const cwd = mkdtempSync(join(root, "agents-version-"));
  execFileSync("git", ["init", "-q"], { cwd });
  try {
    const h = realCustomHarness(seededDb("aui-mount-version", 1), { mountCwd: cwd, piVersion: "1.2.0" });
    await h.start();
    expect(h.stack()).toHaveLength(1);
    expect(h.focuses).toEqual(["selector"]);
    expect(h.ui.notify).not.toHaveBeenCalled();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

const incompatibleHosts = [
  {
    name: "unsupported pi",
    piVersion: "1.2.1",
    layout: false,
    reason: "Run detail needs pi 1.2.0 or 1.5.2 (running 1.2.1); the list still works",
  },
  {
    name: "old shim",
    piVersion: null,
    layout: false,
    reason: "Run detail needs a relinked spider shim: run npm run link (or npm run dev:link) and restart pi",
  },
  {
    name: "unexpected layout",
    piVersion: "1.2.0",
    layout: true,
    reason: "Run detail can't read this pi layout; update spider",
  },
] as const;

function incompatibleHarness(name: string, piVersion: string | null, layout: boolean) {
  const db = seededDb(`aui-compat-${name.replaceAll(" ", "-")}`);
  const h = realCustomHarness(db, { piVersion });
  if (layout) {
    const root = h.view.root as unknown as { entries: { basis?: number | string }[] };
    root.entries[0]!.basis = 1;
  }
  return { db, h };
}

it.each(incompatibleHosts)("keeps the list usable and refuses detail on $name", async ({ name, piVersion, layout, reason }) => {
  const { h } = incompatibleHarness(name, piVersion, layout);
  h.view.editor.setText("keep this draft"); h.view.editor.cursor = 4;
  await h.start();
  const selector = h.focused();
  expect(selector).not.toBe(h.view.editor);
  expect(h.focuses).toEqual(["selector"]);
  const selectedLine = () => h.ui.widgets.get("spider-agents")!.render(120).find(line => line.startsWith("▸ "));
  expect(selectedLine()).toContain("one");
  await h.send("\x1b[B");
  expect(selectedLine()).toContain("two");
  await h.send("\x1b[A");
  expect(selectedLine()).toContain("one");
  await h.send("\r");
  expect(h.ui.custom).toHaveBeenCalledTimes(1);
  expect(h.ui.notify).toHaveBeenCalledExactlyOnceWith(reason, "info");
  expect(h.focused()).toBe(selector);
  await h.send("\u001b");
  expect(h.completions).toEqual(["selector"]);
  expect(h.focused()).toBe(h.view.editor);
  expect(h.view.editor.getText()).toBe("keep this draft");
  expect(h.view.editor.cursor).toBe(4);
});

it("opens the legacy list when an incompatible host's focus accessor throws", async () => {
  const h = realCustomHarness(seededDb("aui-compat-focus-accessor", 1), { piVersion: "1.2.1" });
  const original = Object.getOwnPropertyDescriptor(h.view.tui, "getFocusedComponent");
  Object.defineProperty(h.view.tui, "getFocusedComponent", { configurable: true, get() { throw new Error("changed focus API"); } });
  try { await h.start(); }
  finally {
    if (original) Object.defineProperty(h.view.tui, "getFocusedComponent", original);
    else Reflect.deleteProperty(h.view.tui, "getFocusedComponent");
  }
  expect(h.focused()).not.toBe(h.view.editor);
  expect(h.focuses).toEqual(["selector"]);
  await h.send("\u001b");
  expect(h.completions).toEqual(["selector"]);
  expect(h.focused()).toBe(h.view.editor);
});

it.each(incompatibleHosts)("Ctrl+C closes the list on $name", async ({ name, piVersion, layout }) => {
  const { h } = incompatibleHarness(`${name}-interrupt`, piVersion, layout);
  await h.start(); await h.send("\x03");
  expect(h.completions).toEqual(["selector"]);
  expect(h.focused()).toBe(h.view.editor);
});

it.each(incompatibleHosts)("closes the list when all runs disappear on $name", async ({ name, piVersion, layout }) => {
  const { db, h } = incompatibleHarness(`${name}-empty`, piVersion, layout);
  await h.start();
  db.prepare("UPDATE runs SET status = 'done', ended_at = ?").run(Date.now() - 20_000);
  for (const runId of ["r1", "r2"]) bus.emit({ sessionId: "s", runId, ts: Date.now(), type: "status" });
  await h.settle();
  expect(h.completions).toEqual(["selector"]);
  expect(h.focused()).toBe(h.view.editor);
});

it("does not open a detail while a foreign regular overlay owns composition", async () => {
  const h = realCustomHarness(seededDb("aui-regular-foreign", 1), { mode: "regular" });
  await h.start(); const selector = h.focused()!;
  const foreign: Component = { render: () => ["foreign"], invalidate() {} };
  const handle = h.view.tui.showOverlay(foreign, { width: 20 });
  selector.handleInput?.("\r"); await h.settle();
  expect(h.ui.custom).toHaveBeenCalledTimes(1);
  expect(h.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/geometry|unavailable/i), expect.anything());
  expect(h.focused()).toBe(foreign);
  handle.hide(); await h.settle();
  await h.send("\r");
  expect(h.ui.custom).toHaveBeenCalledTimes(2);
});

it("closes an unusably resized detail once and returns focus safely", async () => {
  const h = realCustomHarness(seededDb("aui-resize", 1));
  await h.start(); const selector = h.focused(); await h.send("\r");
  h.view.terminal.resize(120, 2); h.view.tui.renderNow();
  expect(h.completions).toEqual([]);
  await h.settle(); await h.settle();
  expect(h.completions).toEqual(["detail"]);
  expect(h.focused()).toBe(selector);
  expect(h.ui.notify).toHaveBeenCalledTimes(1);
  expect(h.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/larger|size|geometry/i), expect.anything());
});

it("coalesces live detail reads while preserving unread identity and focus", async () => {
  vi.useFakeTimers();
  const db = seededDb("aui-live", 1, 100), reads = watchDetailReads(db);
  try {
    const h = realCustomHarness(db); await h.start(); await h.send("\r");
    const detail = h.focused()!;
    expect(reads.counts.events).toBe(1);
    await h.send("\x1b[A");
    const before = detail.render(96).join("\n");
    expect(before).toContain("↓ 0 new");
    db.prepare("INSERT INTO run_events (run_id, session_id, ts, type, summary) VALUES ('r1','s',1000,'message','fresh')").run();
    const event = { sessionId: "s", runId: "r1", ts: 1000, type: "message", summary: "fresh" };
    bus.emit(event); bus.emit(event); bus.emit(event);
    vi.advanceTimersByTime(99); await h.settle();
    expect(reads.counts.events).toBe(1);
    expect(detail.render(96).join("\n")).toContain("↓ 0 new");
    vi.advanceTimersByTime(1); await h.settle();
    expect(reads.counts.events).toBe(2);
    expect(detail.render(96).join("\n")).toContain("↓ 1 new");
    expect(h.focused()).toBe(detail);
    expect(h.focuses).toEqual(["selector", "detail"]);
    db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = 'r1'").run(Date.now());
    bus.emit({ sessionId: "s", runId: "r1", ts: 1001, type: "status" });
    await h.settle();
    expect(detail.render(96)[0]).toContain("done");
    expect(reads.counts.events).toBe(2);
    vi.advanceTimersByTime(100); await h.settle();
    expect(reads.counts.events).toBe(3);
    bus.emit({ sessionId: "s", runId: "other", ts: 1002, type: "message" });
    vi.advanceTimersByTime(100); await h.settle();
    expect(reads.counts.events).toBe(3);
  } finally { reads.restore(); vi.useRealTimers(); }
});

it("stops pending detail reads when Esc returns to the selector", async () => {
  vi.useFakeTimers();
  const db = seededDb("aui-live-close", 1, 30), reads = watchDetailReads(db);
  try {
    const h = realCustomHarness(db); await h.start(); const selector = h.focused(); await h.send("\r");
    bus.emit({ sessionId: "s", runId: "r1", ts: 1000, type: "message" });
    const baseline = { ...reads.counts };
    await h.send("\u001b");
    vi.advanceTimersByTime(200); await h.settle();
    expect(reads.counts).toEqual(baseline);
    expect(h.focused()).toBe(selector);
  } finally { reads.restore(); vi.useRealTimers(); }
});

it("stops pending detail reads immediately on shutdown beneath a foreign overlay", async () => {
  vi.useFakeTimers();
  const db = seededDb("aui-live-dispose", 1, 30), reads = watchDetailReads(db);
  try {
    const h = realCustomHarness(db); await h.start(); await h.send("\r");
    bus.emit({ sessionId: "s", runId: "r1", ts: 1000, type: "message" });
    const baseline = { ...reads.counts };
    const foreign: Component = { render: () => ["foreign"], invalidate() {} };
    const handle = h.view.tui.showOverlay(foreign, { width: 20 });
    h.dispose();
    expect(h.ui.widgets.has("spider-agents")).toBe(false);
    vi.advanceTimersByTime(200); await h.settle();
    expect(reads.counts).toEqual(baseline);
    expect(h.stack().at(-1)).toBe(foreign);
    handle.hide(); await h.settle();
    expect(h.completions).toEqual(["detail", "selector"]);
  } finally { reads.restore(); vi.useRealTimers(); }
});

it("marks kill pending once and closes only the detail on success", async () => {
  const pending = deferred(); let detail!: Component;
  const kill = vi.fn(() => {
    expect(detail.render(96).join("\n")).toContain("Stopping");
    return pending.promise;
  });
  const h = realCustomHarness(seededDb("aui-kill-success", 1), { actions: actions(kill) });
  await h.start(); const selector = h.focused(); await h.send("\r");
  detail = h.focused()!;
  await h.send("k"); expect(kill).not.toHaveBeenCalled();
  expect(detail.render(96).join("\n")).toContain("k again to kill");
  await h.send("k");
  expect(kill).toHaveBeenCalledExactlyOnceWith("r1");
  expect(detail.render(96).join("\n")).toContain("Stopping");
  await h.send("k"); await h.send("k");
  expect(kill).toHaveBeenCalledTimes(1);
  pending.resolve(); await h.settle();
  expect(h.completions).toEqual(["detail"]);
  expect(h.focused()).toBe(selector);
});

it("keeps an asynchronously failed kill open and requires two fresh retry presses", async () => {
  const first = deferred(), second = deferred();
  const kill = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const h = realCustomHarness(seededDb("aui-kill-reject", 1), { actions: actions(kill) });
  await h.start(); await h.send("\r"); const detail = h.focused()!;
  await h.send("k"); await h.send("k");
  first.reject(new Error("permission denied")); await h.settle();
  expect(h.focused()).toBe(detail);
  expect(detail.render(96).join("\n")).toContain("permission denied");
  expect(h.completions).toEqual([]);
  await h.send("k"); expect(kill).toHaveBeenCalledTimes(1);
  await h.send("k"); expect(kill).toHaveBeenCalledTimes(2);
  second.resolve(); await h.settle();
  expect(h.completions).toEqual(["detail"]);
});

it("handles a synchronously throwing kill without closing the detail", async () => {
  const kill = vi.fn(() => { throw new Error("refused"); });
  const h = realCustomHarness(seededDb("aui-kill-throw", 1), { actions: actions(kill) });
  await h.start(); await h.send("\r"); const detail = h.focused()!;
  await h.send("k"); await h.send("k");
  expect(kill).toHaveBeenCalledExactlyOnceWith("r1");
  expect(h.focused()).toBe(detail);
  expect(detail.render(96).join("\n")).toContain("refused");
  expect(h.completions).toEqual([]);
  await h.send("k"); expect(kill).toHaveBeenCalledTimes(1);
});

it.each(["success", "failure"] as const)("Esc during a pending kill ignores late %s except for failure notification", async outcome => {
  const pending = deferred(), kill = vi.fn(() => pending.promise);
  const h = realCustomHarness(seededDb(`aui-late-${outcome}`, 1), { actions: actions(kill) });
  await h.start(); const selector = h.focused(); await h.send("\r");
  await h.send("k"); await h.send("k"); await h.send("\u001b");
  expect(h.focused()).toBe(selector);
  expect(h.completions).toEqual(["detail"]);
  if (outcome === "failure") pending.reject(new Error("late refusal")); else pending.resolve();
  await h.settle();
  expect(h.focused()).toBe(selector);
  expect(h.ui.custom).toHaveBeenCalledTimes(2);
  expect(h.focuses).toEqual(["selector", "detail"]);
  if (outcome === "failure") expect(h.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/late refusal/), "error");
  else expect(h.ui.notify).not.toHaveBeenCalled();
});

it("waits for a foreign overlay before closing after kill success", async () => {
  const pending = deferred(), kill = vi.fn(() => pending.promise);
  const h = realCustomHarness(seededDb("aui-kill-foreign", 1), { actions: actions(kill) });
  await h.start(); const selector = h.focused(); await h.send("\r");
  await h.send("k"); await h.send("k");
  const foreign: Component = { render: () => ["foreign"], invalidate() {} };
  const handle = h.view.tui.showOverlay(foreign, { width: 20 });
  pending.resolve(); await h.settle();
  expect(h.focused()).toBe(foreign);
  expect(h.completions).toEqual([]);
  handle.hide(); await h.settle();
  expect(h.completions).toEqual(["detail"]);
  expect(h.focused()).toBe(selector);
});

it("notifies if a rejection races with Esc before detail disposal", async () => {
  const pending = deferred(), kill = vi.fn(() => pending.promise);
  const h = realCustomHarness(seededDb("aui-kill-race", 1), { actions: actions(kill) });
  await h.start(); const selector = h.focused(); await h.send("\r");
  const detail = h.focused()!;
  await h.send("k"); await h.send("k");
  pending.reject(new Error("racing refusal"));
  detail.handleInput?.("\u001b");
  await h.settle();
  expect(h.focused()).toBe(selector);
  expect(h.completions).toEqual(["detail"]);
  expect(h.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/racing refusal/), "error");
});

it("notifies a late failure after session shutdown without reopening", async () => {
  const pending = deferred(), kill = vi.fn(() => pending.promise);
  const h = realCustomHarness(seededDb("aui-kill-shutdown", 1), { actions: actions(kill) });
  await h.start(); await h.send("\r"); await h.send("k"); await h.send("k");
  h.dispose(); await h.settle();
  expect(h.completions).toEqual(["detail", "selector"]);
  pending.reject(new Error("shutdown refusal")); await h.settle();
  expect(h.ui.custom).toHaveBeenCalledTimes(2);
  expect(h.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/shutdown refusal/), "error");
});

it("kills the captured run after the selector list is reordered", async () => {
  const pending = deferred(), kill = vi.fn(() => pending.promise);
  const db = seededDb("aui-kill-captured", 2);
  const h = realCustomHarness(db, { actions: actions(kill) });
  await h.start(); await h.send("\x1b[B"); await h.send("\r");
  db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = 'r1'").run(Date.now() - 20_000);
  bus.emit({ sessionId: "s", runId: "r1", ts: Date.now(), type: "status" });
  await h.settle(); await h.send("k"); await h.send("k");
  expect(kill).toHaveBeenCalledExactlyOnceWith("r2");
  pending.resolve(); await h.settle();
});

it("disarms immediately when a selected run completes before history refresh", async () => {
  vi.useFakeTimers();
  const kill = vi.fn(), db = seededDb("aui-kill-complete", 1);
  try {
    const h = realCustomHarness(db, { actions: actions(kill) });
    await h.start(); await h.send("\r"); const detail = h.focused()!;
    await h.send("k"); expect(detail.render(96).join("\n")).toContain("k again to kill");
    db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = 'r1'").run(Date.now());
    bus.emit({ sessionId: "s", runId: "r1", ts: Date.now(), type: "status" });
    await h.settle();
    expect(detail.render(96).join("\n")).not.toContain("k again to kill");
    await h.send("k"); expect(kill).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
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
  const root = dirname(scratchDbPath("footer-config-root"));
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
