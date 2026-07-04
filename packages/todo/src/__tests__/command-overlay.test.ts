import { describe, it, expect, afterEach } from "vitest";
import { makeTodoDb } from "./helpers/tmpdb";
import { makeTodosCommand } from "../command";
import { addTodo } from "../store";

let ctx: ReturnType<typeof makeTodoDb>;
afterEach(() => ctx?.cleanup());

/** Capture the overlay factory passed to ctx.ui.custom and drive it like pi would. */
function fakeCustomUi() {
  let doneFn: (() => void) | undefined;
  let component: any;
  let renderCount = 0;
  let forcedRenderCount = 0;
  const tui = { requestRender: (force?: boolean) => { renderCount++; if (force) forcedRenderCount++; } };
  const theme = {};
  const kb = {};
  const ui = {
    async custom<T>(factory: (t: any, th: any, k: any, done: (v: T) => void) => any): Promise<T> {
      component = factory(tui, theme, kb, (v: any) => { doneFn?.(); return v; });
      return undefined as any;
    },
  };
  return {
    ui,
    get component() { return component; },
    get renderCount() { return renderCount; },
    get forcedRenderCount() { return forcedRenderCount; },
    onDone(fn: () => void) { doneFn = fn; },
  };
}

describe("makeTodosCommand — interactive overlay", () => {
  it("opens an interactive overlay listing this session's todos", async () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "s1", "write plan");
    addTodo(ctx.db, "s2", "other session task");
    const fake = fakeCustomUi();
    const cmd = makeTodosCommand({ getDb: () => ctx.db, getSessionId: () => "s1" });
    await cmd.handler("", { hasUI: true, ui: fake.ui });

    const comp = fake.component;
    expect(comp).toBeTruthy();
    expect(typeof comp.render).toBe("function");
    expect(typeof comp.handleInput).toBe("function");
    expect(typeof comp.invalidate).toBe("function");
    expect(typeof comp.dispose).toBe("function");

    const initial = comp.render(80).join("\n");
    expect(initial).toContain("write plan");
    expect(initial).not.toContain("other session task");
  });

  it("renders the quality layout: Todos rule, session line, completed count and check glyphs", async () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "s1", "write plan");
    addTodo(ctx.db, "s1", "ship it");
    const fake = fakeCustomUi();
    const cmd = makeTodosCommand({ getDb: () => ctx.db, getSessionId: () => "s1" });
    await cmd.handler("", { hasUI: true, ui: fake.ui });
    const out = fake.component.render(80).join("\n");
    expect(out).toContain("Todos");         // subtle rule header (no 🕸 chrome)
    expect(out).toContain("session:");      // context line
    expect(out).toMatch(/0\/2 completed/);  // summary
    expect(out).toContain("○");             // open-item glyph
    expect(out).toMatch(/Esc to close/);    // footer hint
  });

  it("'a' toggles to the all-sessions view and re-renders", async () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "s1", "write plan");
    addTodo(ctx.db, "s2", "other session task");
    const fake = fakeCustomUi();
    const cmd = makeTodosCommand({ getDb: () => ctx.db, getSessionId: () => "s1" });
    await cmd.handler("", { hasUI: true, ui: fake.ui });
    const comp = fake.component;

    const before = fake.renderCount;
    const handled = comp.handleInput("a");
    expect(handled).toBe(true);
    expect(fake.renderCount).toBeGreaterThan(before);

    const all = comp.render(80).join("\n");
    expect(all).toContain("write plan");
    expect(all).toContain("other session task");
  });

  it("'q' closes the overlay via done()", async () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "s1", "write plan");
    const fake = fakeCustomUi();
    let closed = false;
    fake.onDone(() => { closed = true; });
    const cmd = makeTodosCommand({ getDb: () => ctx.db, getSessionId: () => "s1" });
    await cmd.handler("", { hasUI: true, ui: fake.ui });
    const comp = fake.component;

    expect(comp.handleInput("q")).toBe(true);
    expect(closed).toBe(true);
  });

  it("'Esc' and Ctrl+C close the overlay via done()", async () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "s1", "write plan");
    for (const key of ["\x1b", "\x03"]) {
      const fake = fakeCustomUi();
      let closed = false;
      fake.onDone(() => { closed = true; });
      const cmd = makeTodosCommand({ getDb: () => ctx.db, getSessionId: () => "s1" });
      await cmd.handler("", { hasUI: true, ui: fake.ui });
      expect(fake.component.handleInput(key)).toBe(true);
      expect(closed).toBe(true);
    }
  });

  it("'a' toggle forces a full redraw (clearOnShrink) so a shrinking view reclaims freed rows", async () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "s1", "write plan");
    const fake = fakeCustomUi();
    const cmd = makeTodosCommand({ getDb: () => ctx.db, getSessionId: () => "s1" });
    await cmd.handler("", { hasUI: true, ui: fake.ui });
    const comp = fake.component;
    const before = fake.forcedRenderCount;
    comp.handleInput("a");
    expect(fake.forcedRenderCount).toBeGreaterThan(before);
  });

  it("dispose forces a full redraw so closing reclaims freed rows and the chat bar reflows down", async () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "s1", "write plan");
    const fake = fakeCustomUi();
    const cmd = makeTodosCommand({ getDb: () => ctx.db, getSessionId: () => "s1" });
    await cmd.handler("", { hasUI: true, ui: fake.ui });
    const comp = fake.component;
    const before = fake.forcedRenderCount;
    comp.dispose();
    expect(fake.forcedRenderCount).toBeGreaterThan(before);
  });

  it("falls back to notify when ctx.ui.custom is unavailable", async () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "s1", "write plan");
    let captured = "";
    const cmd = makeTodosCommand({ getDb: () => ctx.db, getSessionId: () => "s1" });
    await cmd.handler("", { hasUI: true, ui: { notify: (m: string) => { captured = m; } } });
    expect(captured).toContain("write plan");
  });
});
