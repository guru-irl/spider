import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import type { ApiEnvelope, CalibrationResult, UsageMeasure } from "../dashboard-contract.js";
import type { DetailData } from "../query-detail.js";
import { createDashboardClient } from "../web/client.js";
import { PlainDocument, button, elements, settle } from "./fixtures/plain-dom.js";

const fit: CalibrationResult = { status: "off", factor: null, windowStart: null, windowEnd: null, coveredHours: 0, computedAic: 0, counterDelta: 0, unpricedCalls: 0, method: "trailing-7d-ratio" };
const measure: UsageMeasure = { calls: 0, pricedCalls: 0, unpricedCalls: 0, aggregateCalls: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, prompt: 0, output: 0, total: 0, cacheWrite1h: null, reasoning: null }, aic: null, aicDisplay: { primaryAic: null, publishedAic: null, basis: "published" }, aicComponents: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, piCost: null, possibleOverlap: false, possibleUndercount: false, pendingData: false, estimated: false };
const unavailable = { status: "unavailable" as const, phase: 2 as const, reason: "not-built" as const, message: "Not available yet (Phase 2)" as const };
function data(kind: "session" | "run", id: string): DetailData { return { kind, id, calibration: fit, totals: measure, timeline: [], calls: { rows: [], nextCursor: null }, links: { rows: [], nextCursor: null }, accounting: { status: "no-selected-calls", coveringRunId: null, message: "No selected calls" }, contextFillPercent: null, contextFillMessage: "Context fill unavailable: historical window not recorded", composition: unavailable, carry: unavailable, itemReuse: unavailable }; }

describe("Detail registration", () => {
  it.each(["session", "run"] as const)("registers %s using route id without freezing the rolling month", async kind => {
    vi.useFakeTimers(); try {
      const { startDashboard } = await import("../web/app.js"); const module = await import("../web/detail.js");
      const mount = kind === "session" ? module.mountSession : module.mountRun;
      expect(mount).toBeTypeOf("function");
      const doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root);
      let clock = Date.UTC(2026, 9, 31, 23, 59, 30); const windows: { start: number; end: number; id: string | null }[] = [];
      const client = createDashboardClient(async input => {
        const params = new URL(String(input), "http://127.0.0.1").searchParams;
        const period = { start: Number(params.get("start")), end: Number(params.get("end")) }; windows.push({ ...period, id: params.get("id") });
        const response: ApiEnvelope<DetailData> = { apiVersion: 1, revision: "r", generatedAt: clock, period, data: data(kind, "route-id") }; return new Response(JSON.stringify(response));
      });
      const app = startDashboard({ document: doc.asDocument(), root: root as unknown as HTMLElement, client, now: () => clock, initialRoute: { view: kind, id: "route-id" }, mounts: { [kind]: mount } });
      await settle(); clock += 120000; await vi.advanceTimersByTimeAsync(60000);
      expect(windows).toEqual([{ start: Date.UTC(2026, 9, 1), end: clock - 120000, id: "route-id" }, { start: Date.UTC(2026, 10, 1), end: clock, id: "route-id" }]); app.dispose();
    } finally { vi.useRealTimers(); }
  });
  it.each(["session", "run"] as const)("prompts for a %s selection without requesting undefined ids", async kind => {
    const module = await import("../web/detail.js"); const mount = kind === "session" ? module.mountSession : module.mountRun; expect(mount).toBeTypeOf("function");
    const doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root); let requests = 0;
    const view = await mount({ document: doc.asDocument(), root: root as unknown as HTMLElement, client: createDashboardClient(async () => { requests++; throw new Error("unexpected request"); }), period: { start: 0, end: 1 }, filters: [], signal: new AbortController().signal, navigate() {} });
    await settle(); expect(root.textContent).toContain(`Select a ${kind}`); expect(requests).toBe(0); view.dispose();
  });
  it("shares a browser-safe key module, without any Node imports", async () => {
    const url = new URL("../dashboard-keys.ts", import.meta.url); expect(existsSync(url)).toBe(true);
    const source = readFileSync(url, "utf8"); expect(source).not.toMatch(/\b(?:import|require|export)\b[^;]*["'](?:node:|crypto|fs|os|path)[^"']*["']/);
    expect(source).not.toMatch(/\b(?:import|require)\b/);
    const { supportedDetailId } = await import("../dashboard-keys.js"); expect(supportedDetailId("safe-key:1")).toBe(true); expect(supportedDetailId("../bad")).toBe(false);
    const context = readFileSync(new URL("../web/context.ts", import.meta.url), "utf8"); expect(context).toContain('from "./detail-id.js"'); expect(context).not.toContain("{1,128}");
  });
  it("text-faced prose and token column sizing are local to Detail", () => {
    const url = new URL("../web/detail.css", import.meta.url); expect(existsSync(url)).toBe(true);
    const css = readFileSync(url, "utf8"); expect(css).toMatch(/\.detail-prose\s*\{[^}]*font-family:\s*var\(--text-face\)/);
    expect(css).not.toMatch(/outline|border|shadow|#[a-f\d]{3,8}/i);
  });
});
