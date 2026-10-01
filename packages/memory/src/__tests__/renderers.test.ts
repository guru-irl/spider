import { describe, it, expect } from "vitest";
import { renderRememberResult } from "../renderers";

describe("renderRememberResult", () => {
  it.each([undefined, null, {}, { error: "Not stored: memory is full" }, { message: "Not stored: memory is full" }])("shows an error when the receipt has no status (%j)", result => {
    const text = renderRememberResult(result as any).render(160).join("\n");
    expect(text).toContain("✗");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("status:");
    if (result && ("error" in result || "message" in result)) expect(text).toContain("Not stored: memory is full");
  });

  it("shows the remembered content + meta and drops the duplicate glyph/rule header", () => {
    const out = renderRememberResult({
      status: "active",
      uuid: "8578541f-cafa-4970-97cf-1d4b158fb552",
      content: "The user prefers dark mode and tabs over spaces",
      category: "preference",
      scope: "repo",
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

  it("shows the reviewer message and reason once on the card", () => {
    const text = renderRememberResult({ status: "active", content: "A fact", reason: "useful later", message: "stored as id (reviewer: new; useful later)" }).render(120).join("\n");
    expect(text).toContain("stored as id (reviewer: new; useful later)");
    expect(text.match(/useful later/g)).toHaveLength(1);
  });
  it("omits the content line when nothing was passed (still renders status)", () => {
    const out = renderRememberResult({ status: "staged", uuid: "abcd1234" }).render(120);
    expect(out.join("\n")).toContain("status: staged");
  });
});
