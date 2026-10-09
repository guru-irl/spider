import { describe, expect, it, vi } from "vitest";
import { PlainDocument, elements, settle } from "./fixtures/plain-dom.js";
describe("web entry", () => {
  it.each(["complete", "loading"] as const)("entry auto-starts a %s usage-app with exactly one main landmark", async readyState => {
    vi.resetModules(); vi.useFakeTimers();
    const doc = new PlainDocument(); doc.readyState = readyState;
    const root = doc.createElement("div"); root.id = "usage-app"; doc.body.append(root);
    vi.stubGlobal("document", doc.asDocument()); vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "ledger-changed" } }), { status: 409 }));
    try {
      await import("../web/app.js");
      if (readyState === "loading") { expect(elements(root, "main")).toHaveLength(0); doc.dispatchEvent(new Event("DOMContentLoaded")); }
      await settle(); expect(elements(doc.body, "main")).toHaveLength(1); expect(elements(root, "nav")).toHaveLength(1);
      expect(elements(root, "button").some(button => button.textContent === "Overview")).toBe(true);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); }
  });
  it.each(["complete", "loading"] as const)("entry import does not auto-start a %s document without usage-app", async readyState => {
    vi.resetModules(); vi.useFakeTimers();
    const doc = new PlainDocument(); doc.readyState = readyState;
    const existing = doc.createElement("p"); existing.textContent = "Existing document"; doc.body.append(existing); existing.focus();
    let requests = 0;
    vi.stubGlobal("document", doc.asDocument()); vi.stubGlobal("fetch", async () => { ++requests; return new Response(JSON.stringify({})); });
    try {
      const { startDashboard } = await import("../web/app.js");
      if (readyState === "loading") doc.dispatchEvent(new Event("DOMContentLoaded")); await settle();
      expect(doc.body.children).toEqual([existing]); expect(doc.activeElement).toBe(existing); expect(requests).toBe(0); expect(vi.getTimerCount()).toBe(0);
      const app = startDashboard({ document: doc.asDocument(), mounts: { overview: ctx => { const heading = ctx.document.createElement("h1"); heading.textContent = "Explicit mount"; ctx.root.append(heading); return { refresh: async () => {}, dispose() {} }; } } }); await settle();
      expect(elements(doc.body, "h1")[0]!.textContent).toBe("Explicit mount"); app.dispose();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); }
  });
});
