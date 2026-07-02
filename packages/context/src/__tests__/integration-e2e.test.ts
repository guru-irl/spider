import { describe, it, expect, afterEach } from "vitest";
import { makeContentDb } from "./helpers/tmpdb.js";
import { registerContextActions } from "../index.js";

function fakeHost() {
  const map = new Map<string, any>();
  return { registerAction: (n: string, h: any) => map.set(n, h), dispatch: (n: string, a: any, c: any) => map.get(n)(a, c), map };
}

let cx: ReturnType<typeof makeContentDb>;
afterEach(() => cx?.cleanup());

describe("context e2e via dispatcher", () => {
  it("registers all Phase 2 actions and runs index→search", async () => {
    const host = fakeHost();
    registerContextActions(host.registerAction);
    for (const n of ["exec", "exec_file", "batch", "index", "fetch", "search", "import"]) {
      expect(host.map.has(n)).toBe(true);
    }
    cx = makeContentDb();
    const ctx = { db: cx.db, cwd: process.cwd(), sessionId: "s" };
    await host.dispatch("index", { action: "index", content: "# H\nunified search works", source: "d" }, ctx);
    const res = await host.dispatch("search", { action: "search", query: "unified search", limit: 5 }, ctx);
    expect(String((res.text ?? "") + JSON.stringify(res.details ?? "")).length).toBeGreaterThan(0);
    expect((res.details as any[]).some((r) => /unified search/i.test(r.snippet ?? r.title ?? ""))).toBe(true);
  });
});
