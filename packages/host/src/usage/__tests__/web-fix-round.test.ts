import { readFileSync } from "node:fs";
import { renderTable } from "../web/tables.js";
import { expect, it, vi } from "vitest";
import { PlainDocument, elements, settle, button } from "./fixtures/plain-dom.js";
import { hashRoute, routeHash } from "../web/navigation.js";
import { createDashboardBrowserPage } from "./fixtures/dashboard-browser-fixture.js";
import { allViewPage } from "./fixtures/all-view-browser-fixture.js";
import { DashboardClientError } from "../web/client.js";
import { numericText, tokenCell } from "../web/format.js";
import { chartWithTable } from "../web/charts.js";
import type { ViewMount } from "../web/views.js";
import * as screenshot from "../../../../../scripts/usage-dashboard-screenshot.mjs";

function browser(doc: PlainDocument, hash = "") {
  const win = new EventTarget(), location = { hash };
  const history = { pushState: vi.fn((_s: unknown, _t: string, h: string) => { location.hash = h; }), replaceState: vi.fn((_s: unknown, _t: string, h: string) => { location.hash = h; }) };
  Object.assign(win, { location, history }); Object.defineProperty(doc, "defaultView", { value: win });
  return { win, location, history, restore(h: string) { location.hash = h; win.dispatchEvent(new Event("popstate")); win.dispatchEvent(new Event("hashchange")); } };
}
it.each(["_session", "-session", ".session", ":session", "a".repeat(128)])("hash accepts supported detail id %s", id => {
  expect(hashRoute(`#/session/${encodeURIComponent(id)}`)).toMatchObject({ page: "session", id });
});
it.each([
  "#view=cache&filters=" + encodeURIComponent(JSON.stringify([{field:"role",value:"worker"}])).replace("worker", "%E0%A4%A"), "#view=cache&bad=%E0%A4%A", "#view=cache&view=cache", "#view=cache&unknown=yes", "#view=session&id=bad%20id", "#view=session&id=" + "a".repeat(129),
  "#view=cache&" + "&".repeat(16384),
  ...[Array(17).fill({ field: "role", value: "worker" }), [{ field: "role", kind: "wrong", value: "worker" }], [{ field: "role", kind: "missing", value: "worker" }], [{ field: "role", value: "a".repeat(1025) }], { field: "role" }].map(f => "#view=cache&filters=" + encodeURIComponent(JSON.stringify(f))),
  "#view=cache&start=1", "#view=cache&start=1&end=9007199254740992", "#view=cache&start=1&end=8640000000000001",
])("each validator rejects a malformed hash with a valid view: %s", hash => expect(hashRoute(hash).page).toBe("overview"));
it.each(["off", "unavailable"] as const)("%s fixture maps every AIC-bearing field and evidence consistently", async state => {
  const page = allViewPage(await createDashboardBrowserPage(), state);
  function inspect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if ("basis" in obj) { expect(obj.basis).toBe("published"); expect(obj.primaryAic).toBe(obj.publishedAic); }
    if ("calibratedAic" in obj) expect(obj.calibratedAic).toBeNull();
    if ("factor" in obj && "status" in obj) { expect(obj.factor).toBeNull(); expect(obj.status).toBe(state === "off" ? "off" : "uncalibrated"); if (state === "off") { expect(obj.windowStart).toBeNull(); expect(obj.windowEnd).toBeNull(); expect(obj.coveredHours).toBe(0); expect(obj.counterDelta).toBe(0); } }
    Object.values(obj).forEach(inspect);
  }
  for (const [path, route] of Object.entries(page.routes)) if (path.startsWith("/api/")) inspect(JSON.parse(route.body as string));
});
it("chart choices are independent and retained per stable chart id on rerender in a browser document", () => {
  const doc = new PlainDocument(); browser(doc);
  const chart = (title: string) => chartWithTable(doc.asDocument(), { title, unit: "tokens", points: [] });
  const a = chart("First"), b = chart("Second"); (doc.body as unknown as HTMLElement).append(a, b); button(a, "Table").click();
  const nextA = chart("First"), nextB = chart("Second"); expect(button(nextA, "Table").getAttribute("aria-pressed")).toBe("true"); expect(button(nextB, "Table").getAttribute("aria-pressed")).toBe("false");
});
it("CLI batch deadline covers every visual test's declared budget", () => {
  const source = readFileSync(new URL("./dashboard-visual.test.ts", import.meta.url), "utf8");
  const budgets = [...source.matchAll(/}, implementation\.BROWSER_TEST_TIMEOUT_MS(?: \* (\d+))?\);/g)].map(match => Number(match[1] ?? 1));
  expect(budgets.length).toBe((source.match(/^test\(/gm) ?? []).length);
  expect(budgets.length).toBeGreaterThan(0);
  expect(screenshot.DEFAULT_CLI_TIMEOUT_MS).toBeGreaterThanOrEqual(screenshot.BROWSER_TEST_TIMEOUT_MS * budgets.reduce((a,b)=>a+b,0));
});

it("numeric fragments style signed values, not signs, units or identifiers", () => {
  const doc = new PlainDocument();
  const node = numericText(doc.asDocument(), "gap -2 AIC · ~33.33% · x2 · synthetic-v1 · model-5.1 · trailing 7-day ratio");
  expect(elements(node,"span").filter(n=>n.className==="numeric").map(n=>n.textContent)).toEqual(["2","33.33","2"]);
});

it("new route hashes omit the unused mode while accepting legacy hashes", () => {
  expect(routeHash({page:"calibration"})).not.toContain("mode=");
  expect(hashRoute("#view=cache&mode=table")).toMatchObject({page:"overview"});
});
it("token cells follow the receiving table's column count",async()=>{
 const page=allViewPage(await createDashboardBrowserPage(),"calibrated");
 const tokens=JSON.parse(page.routes["/api/overview"]!.body as string).data.totals.tokens;
 const doc=new PlainDocument();
 for(const count of [6,7]) {
  const columns=Array.from({length:count},(_,i)=>String(i));
  const cell=tokenCell(doc.asDocument(),tokens);
  const table=renderTable(doc.asDocument(),{caption:"Tokens",columns,rows:[[cell,...columns.slice(1)]]});
  expect(elements(table,"dt").length>0).toBe(count===6);
  expect(table.textContent.includes("prompt 1,300 · output 400 · total 1,700")).toBe(count===7);
 }
});
