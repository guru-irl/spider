import { describe, it, expect } from "vitest";
import { renderSpiderResult } from "../render-result";
import type { StageResult } from "@spider/memory";

// Minimal fakes for pi's renderResult call shape. We only exercise the fields the
// dispatcher reads: result.content (model text), result.details (structured payload),
// context.args ({ action, sub/command }).
const opts = {} as any;
const theme = {} as any;
const mkCtx = (args: any) => ({ args }) as any;
const mkResult = (details: unknown, text = "") =>
  ({ content: text ? [{ type: "text", text }] : [], details }) as any;

/** Every renderer must return a valid pi Component: render(width) AND invalidate(). */
function assertComponent(c: any) {
  expect(c).toBeTruthy();
  expect(typeof c.render).toBe("function");
  expect(typeof c.invalidate).toBe("function");
  const lines = c.render(80);
  expect(Array.isArray(lines)).toBe(true);
}

describe("renderSpiderResult dispatcher", () => {
  it("remember → remember panel (title + status)", () => {
    const details: StageResult = { status: "staged", uuid: "abc-123" };
    const c = renderSpiderResult(mkResult(details), opts, theme, mkCtx({ action: "remember" }));
    assertComponent(c);
    const text = c.render(80).join("\n");
    expect(text).toContain("remember");
    expect(text).toContain("staged");
  });

  it("recall → recall panel with count", () => {
    const recs = [
      { uuid: "u1", category: "fact", content: "the sky is blue", link: null },
      { uuid: "u2", category: "fact", content: "grass is green", link: null },
    ];
    const c = renderSpiderResult(mkResult(recs), opts, theme, mkCtx({ action: "recall" }));
    assertComponent(c);
    const text = c.render(80).join("\n");
    expect(text).toContain("recall");
    expect(text).toContain("the sky is blue");
  });

  it("control sub=pending → pending panel", () => {
    const recs = [{ uuid: "p1", category: "fact", content: "pending item", link: null }];
    const c = renderSpiderResult(
      mkResult(recs),
      opts,
      theme,
      mkCtx({ action: "control", sub: "pending" }),
    );
    assertComponent(c);
    expect(c.render(80).join("\n")).toContain("pending item");
  });

  it("search → search panel with hit count", () => {
    const rows = [
      { key: "k1", kind: "memory", id: "1", title: "fact", snippet: "hello world" },
    ];
    const c = renderSpiderResult(mkResult(rows), opts, theme, mkCtx({ action: "search" }));
    assertComponent(c);
    const text = c.render(80).join("\n");
    expect(text).toContain("search");
    expect(text).toContain("hello world");
  });

  it("import → import summary panel", () => {
    const summary = { imported: 3, skipped: 1, staged: 5, committed: 2, perSession: [] };
    const c = renderSpiderResult(mkResult(summary), opts, theme, mkCtx({ action: "import" }));
    assertComponent(c);
    const text = c.render(80).join("\n");
    expect(text).toContain("import");
    expect(text).toContain("3");
  });

  it("DEFAULT (unmatched action) → text fallback from result.content", () => {
    const c = renderSpiderResult(
      mkResult({ anything: true }, "exec output line 1\nexec output line 2"),
      opts,
      theme,
      mkCtx({ action: "exec" }),
    );
    assertComponent(c);
    const text = c.render(80).join("\n");
    expect(text).toContain("exec output line 1");
    expect(text).toContain("exec output line 2");
  });

  it("always returns a Component (never undefined) even with no args", () => {
    const c = renderSpiderResult(mkResult(null, "plain"), opts, theme, mkCtx({}));
    assertComponent(c);
  });
});
