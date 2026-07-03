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
  const tui = { requestRender: () => { renderCount++; } };
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

  it("falls back to notify when ctx.ui.custom is unavailable", async () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "s1", "write plan");
    let captured = "";
    const cmd = makeTodosCommand({ getDb: () => ctx.db, getSessionId: () => "s1" });
    await cmd.handler("", { hasUI: true, ui: { notify: (m: string) => { captured = m; } } });
    expect(captured).toContain("write plan");
  });
});
