import { describe, it, expect } from "vitest";
import { renderRememberResult } from "../renderers";

describe("renderRememberResult", () => {
  it("shows the remembered content + meta and drops the duplicate glyph/rule header", () => {
    const out = renderRememberResult({
      status: "active",
      uuid: "8578541f-cafa-4970-97cf-1d4b158fb552",
      content: "The user prefers dark mode and tabs over spaces",
      category: "preference",
      scope: "project",
    }).render(120);
    const text = out.join("\n");
    // the actual saved memory is shown
    expect(text).toContain("dark mode");
    expect(text).toContain("category: preference");
    expect(text).toContain("status: active");
    // uuid is internal noise — it must NOT be shown to the user
    expect(text).not.toContain("uuid");
    expect(text).not.toContain("8578541f");
    // no second "🕸 remember" header / section rule (the tool title already carries the glyph)
    expect(text).not.toContain("🕸 remember");
    expect(text).not.toMatch(/─{3,}/);
  });

  it("omits the content line when nothing was passed (still renders status)", () => {
    const out = renderRememberResult({ status: "staged", uuid: "abcd1234" }).render(120);
    expect(out.join("\n")).toContain("status: staged");
  });
});
