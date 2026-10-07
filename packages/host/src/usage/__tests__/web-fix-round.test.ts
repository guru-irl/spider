import { readFileSync } from "node:fs";
import { renderTable } from "../web/tables.js";
import { expect, it, vi } from "vitest";
import { PlainDocument, elements, settle, button } from "./fixtures/plain-dom.js";
import { startDashboard } from "../web/app.js";
import { hashRoute, routeHash } from "../web/navigation.js";
import { createDashboardBrowserPage } from "./fixtures/dashboard-browser-fixture.js";
import { allViewPage } from "./fixtures/all-view-browser-fixture.js";
import { createDashboardClient, DashboardClientError } from "../web/client.js";
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
const flush = async () => { for (let i = 0; i < 30; i++) await settle(); };
async function fixture(view: "overview" | "explorer" | "session" | "run" | "cache" | "rates" | "reconciliation") {
  const page = allViewPage(await createDashboardBrowserPage(), "calibrated"), doc = new PlainDocument(); browser(doc);
  const client = createDashboardClient(async input => new Response(page.routes[new URL(String(input), "https://dashboard.invalid").pathname]!.body as string));
  const app = startDashboard({ document: doc.asDocument(), initialRoute: { view, id: view === "run" ? "run-fixture" : "session-fixture" }, client }); await flush();
  return { doc, app };
}
it.each(["_session", "-session", ".session", ":session", "a".repeat(128)])("hash accepts supported detail id %s", id => {
  expect(hashRoute(`#view=session&id=${encodeURIComponent(id)}`)).toMatchObject({ view: "session", id });
});
it.each([
  "#view=cache&filters=" + encodeURIComponent(JSON.stringify([{field:"role",value:"worker"}])).replace("worker", "%E0%A4%A"), "#view=cache&bad=%E0%A4%A", "#view=cache&view=cache", "#view=cache&unknown=yes", "#view=session&id=bad%20id", "#view=session&id=" + "a".repeat(129),
  "#view=cache&" + "&".repeat(16384),
  ...[Array(17).fill({ field: "role", value: "worker" }), [{ field: "role", kind: "wrong", value: "worker" }], [{ field: "role", kind: "missing", value: "worker" }], [{ field: "role", value: "a".repeat(1025) }], { field: "role" }].map(f => "#view=cache&filters=" + encodeURIComponent(JSON.stringify(f))),
  "#view=cache&start=1", "#view=cache&start=1&end=9007199254740992", "#view=cache&start=1&end=8640000000000001",
])("each validator rejects a malformed hash with a valid view: %s", hash => expect(hashRoute(hash).view).toBe("overview"));
it("rolling month stays rolling across reload, restore and clear-filter recovery without pushing history", async () => {
  let now = Date.UTC(2030, 0, 31); const doc = new PlainDocument(), b = browser(doc, "#view=cache"), reads: number[] = [];
  const mount: ViewMount = async ctx => { reads.push(ctx.period.start); return { dispose() {} }; };
  const mounts = { cache: mount, overview: mount };
  let app = startDashboard({ document: doc.asDocument(), now: () => now, mounts });
  try {
    await settle(); expect(b.location.hash).not.toContain("start="); app.dispose(); now = Date.UTC(2030, 1, 2);
    app = startDashboard({ document: doc.asDocument(), now: () => now, mounts }); await settle(); expect(reads.at(-1)).toBe(Date.UTC(2030, 1, 1));
    b.restore("#view=cache&start=1&end=2"); await settle(); expect(reads.at(-1)).toBe(1);
    b.history.pushState.mockClear(); b.restore("#view=cache"); await settle(); expect(reads.at(-1)).toBe(Date.UTC(2030, 1, 1)); expect(b.history.pushState).not.toHaveBeenCalled();
    b.restore("#view=cache&mode=chart"); await settle(); expect(b.history.pushState).not.toHaveBeenCalled();
  } finally { app.dispose(); }
});
it("shell unknown-filter failure renders the promised Clear filters action and retains a rolling month", async () => {
  let now = Date.UTC(2030, 0, 31), cleared: unknown;
  const doc = new PlainDocument(), b = browser(doc);
  const app = startDashboard({ document: doc.asDocument(), now: () => now, initialRoute: { view: "cache", filters: [{ field: "role", kind: "id", value: "v1_old" }] }, mounts: { cache: async ctx => {
    if (ctx.filters.length) throw new DashboardClientError("unknown-filter-id"); cleared = { filters: ctx.filters, period: ctx.period }; return { dispose() {} };
  } } });
  try { await settle(); expect(doc.body.textContent).toContain("Clear filters"); now = Date.UTC(2030, 1, 2); button(doc.body, "Clear filters").click(); await settle(); expect(cleared).toEqual({ filters: [], period: { start: Date.UTC(2030, 1, 1), end: now } }); expect(b.location.hash).not.toContain("start="); }
  finally { app.dispose(); }
});
it("Session and Run rail buttons retain their independent selected ids", async () => {
  const doc = new PlainDocument(), b = browser(doc, "#view=session&id=_session"), ids: unknown[] = [];
  const mount: ViewMount = async ctx => { ids.push(ctx.id); return { dispose() {} }; };
  const app = startDashboard({ document: doc.asDocument(), mounts: { session: mount, run: mount, context: mount } });
  try { await settle(); b.restore("#view=run&id=run-2"); await settle(); button(doc.body, "Context").click(); await settle(); button(doc.body, "Session").click(); await settle(); expect(ids.at(-1)).toBe("_session"); button(doc.body, "Run").click(); await settle(); expect(ids.at(-1)).toBe("run-2"); }
  finally { app.dispose(); }
});
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
it.each(["overview", "session", "cache", "rates"] as const)("%s legends use the shared numeric fragments for values only", async view => {
  const { doc, app } = await fixture(view);
  try { const legend = elements(doc.body, "p").find(p => p.className === "calibration-evidence")!; const numbers = elements(legend, "span").filter(n => n.className === "numeric"); expect(numbers.map(n => n.textContent)).toContain("0"); expect(numbers.every(n => !/[a-wyz]/i.test(n.textContent))).toBe(true); }
  finally { app.dispose(); }
});
it("Rates calibration lines have identical shared wording and separators, identifiers keep the text face", async () => {
  const { doc, app } = await fixture("rates");
  try { const lines = elements(doc.body, "p").filter(p => p.className === "calibration-evidence").map(p => p.textContent.replace(/^(Selected-period|Current) calibration: /, "")); expect(lines).toHaveLength(2); expect(lines[0]).toBe(lines[1]); expect(lines[1]).not.toContain(";");
    const id = elements(doc.body, "td").find(td => td.textContent.endsWith("synthetic-v1"))!; expect(elements(id, "span").filter(n => n.className === "numeric")).toHaveLength(0);
  } finally { app.dispose(); }
});
it("wide analysis tables exist and use one-line token summaries", async () => {
  const { doc, app } = await fixture("reconciliation");
  try { const tables = elements(doc.body, "table").filter(t => t.className.includes("wide-table")); expect(tables.length).toBeGreaterThan(0); for (const table of tables) { expect(elements(table, "dt")).toHaveLength(0); if (table.textContent.includes("Tokens")) expect(table.textContent).toContain("prompt 500 · output 200 · total 700"); } }
  finally { app.dispose(); }
});
it("Explorer inactive filter values have no empty status, results or paging blocks", async () => {
  const { doc, app } = await fixture("explorer");
  try { const filters = elements(doc.body, "section").find(n => n.getAttribute("aria-label") === "Filter values")!;
    expect(elements(filters, "p").filter(p => p.className === "notice" && !p.textContent && !p.hidden)).toHaveLength(0);
    expect(elements(filters, "div").filter(p => p.className === "view-actions" && !p.hidden)).toHaveLength(1);
  } finally { app.dispose(); }
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

it("disposing the dashboard clears per-chart choices before a new dashboard starts", async () => {
  const doc = new PlainDocument(); browser(doc);
  const mount: ViewMount = async ctx => { ctx.root.append(chartWithTable(ctx.document, { title: "Owned chart", unit: "tokens", points: [] })); return { dispose() { ctx.root.replaceChildren(); } }; };
  let app = startDashboard({ document: doc.asDocument(), mounts: { overview: mount } });
  try { await settle(); button(doc.body,"Table").click(); app.dispose(); app=startDashboard({ document:doc.asDocument(),mounts:{overview:mount} }); await settle(); expect(button(doc.body,"Table").getAttribute("aria-pressed")).toBe("false"); }
  finally { app.dispose(); }
});

it("numeric fragments style signed values, not signs, units or identifiers", () => {
  const doc = new PlainDocument();
  const node = numericText(doc.asDocument(), "gap -2 AIC · ~33.33% · x2 · synthetic-v1 · model-5.1 · trailing 7-day ratio");
  expect(elements(node,"span").filter(n=>n.className==="numeric").map(n=>n.textContent)).toEqual(["2","33.33","2"]);
});

it("new route hashes omit the unused mode while accepting legacy hashes", () => {
  expect(routeHash({view:"cache",mode:"table"})).not.toContain("mode=");
  expect(hashRoute("#view=cache&mode=table")).toMatchObject({view:"cache"});
});
it.each(["session","run"] as const)("%s Recorded calls have compact attribution and prompt/output/total tokens", async view => {
  const {doc,app}=await fixture(view);
  try {
    const table=elements(doc.body,"table").find(t=>elements(t,"caption")[0]?.textContent==="Recorded calls")!;
    expect(table).toBeDefined(); expect(elements(table,"dt")).toHaveLength(0);
    expect(table.textContent).toContain("prompt 1,300 · output 400 · total 1,700");
    const cell=elements(table,"td").find(t=>t.getAttribute("data-label")==="Attribution")!;
    expect(elements(cell,"p")).toHaveLength(0); expect(cell.textContent).toContain(" · ");
    expect(elements(cell,"button").length).toBeGreaterThan(0);
  } finally { app.dispose(); }
});
it.each(["overview","session","run"] as const)("%s table evidence uses the shared number face",async view=>{
 const {doc,app}=await fixture(view);
 try { const table=elements(doc.body,"table").find(t=>elements(t,"caption")[0]?.textContent===(view==="overview"?"Selected usage":"Recorded calls"))!;
 const cell=elements(table,"td").find(t=>["Evidence","Accounting evidence"].includes(t.getAttribute("data-label")??""))!;
 expect(elements(cell,"span").filter(n=>n.className==="numeric").map(n=>n.textContent)).toContain("0");
 } finally {app.dispose();}
});
it("Rates daily evidence does not duplicate status, factor or window",async()=>{
 const {doc,app}=await fixture("rates");try{
 const table=elements(doc.body,"table").find(t=>elements(t,"caption")[0]?.textContent==="Daily calibration evidence")!;
 const evidence=elements(table,"td").find(t=>t.getAttribute("data-label")==="Evidence")!;
 expect(evidence.textContent).toContain("h covered");expect(evidence.textContent).not.toMatch(/calibrated|UTC|window|x2/);
 }finally{app.dispose();}
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
it("Session and Run timelines keep independent choices",async()=>{
 const page=allViewPage(await createDashboardBrowserPage(),"calibrated"),doc=new PlainDocument();const b=browser(doc);
 const client=createDashboardClient(async input=>new Response(page.routes[new URL(String(input),"https://dashboard.invalid").pathname]!.body as string));
 const app=startDashboard({document:doc.asDocument(),initialRoute:{view:"session",id:"session-fixture"},client});
 try {await flush();const panels=()=>elements(doc.body,"section").filter(n=>n.className==="chart-panel");
 button(panels()[0]!,"Table").click();b.restore("#view=run&id=run-fixture");await flush();
 expect(button(panels()[0]!,"Table").getAttribute("aria-pressed")).toBe("false");
 button(doc.body,"Session").click();await flush();expect(button(panels()[0]!,"Table").getAttribute("aria-pressed")).toBe("true");
 }finally{app.dispose();}
});
it("Overview same-label series keep independent choices",async()=>{
 const page=allViewPage(await createDashboardBrowserPage(),"calibrated"),doc=new PlainDocument();browser(doc);
 const data=JSON.parse(page.routes["/api/overview"]!.body as string);
 const real={label:"Other (remaining roles)",isOther:false,measure:data.data.totals}; const other={...real,isOther:true};data.data.roles=[real,other];
 for(const day of data.data.daily.rows)day.roles=[real,other];
 page.routes["/api/overview"]={...page.routes["/api/overview"]!,body:JSON.stringify(data)};
 const client=createDashboardClient(async input=>new Response(page.routes[new URL(String(input),"https://dashboard.invalid").pathname]!.body as string));
 const app=startDashboard({document:doc.asDocument(),client});try{await flush();
 const panels=elements(doc.body,"section").filter(n=>n.className==="chart-panel"&&n.textContent.includes("Daily role · Other (remaining roles)"));
 expect(panels).toHaveLength(2);button(panels[0]!,"Table").click();button(doc.body,"Cache").click();await flush();button(doc.body,"Overview").click();await flush();
 const next=elements(doc.body,"section").filter(n=>n.className==="chart-panel"&&n.textContent.includes("Daily role · Other (remaining roles)"));
 expect(button(next[0]!,"Table").getAttribute("aria-pressed")).toBe("true");expect(button(next[1]!,"Table").getAttribute("aria-pressed")).toBe("false");
 }finally{app.dispose();}
});

it("Rates diagnostic Factor matches the shared calibration summary",async()=>{
 const page=allViewPage(await createDashboardBrowserPage(),"calibrated"),doc=new PlainDocument();browser(doc);
 const response=JSON.parse(page.routes["/api/rates"]!.body as string);
 for(const point of response.data.factorHistory.rows)point.calibration={...point.calibration,status:"implausible",factor:2};
 response.data.calibration={...response.data.calibration,status:"implausible",factor:2};
 page.routes["/api/rates"]={...page.routes["/api/rates"]!,body:JSON.stringify(response)};
 const client=createDashboardClient(async input=>new Response(page.routes[new URL(String(input),"https://dashboard.invalid").pathname]!.body as string));
 const app=startDashboard({document:doc.asDocument(),initialRoute:{view:"rates"},client});try{await flush();
 const table=elements(doc.body,"table").find(t=>elements(t,"caption")[0]?.textContent==="Daily calibration evidence")!;
 const factor=elements(table,"td").find(t=>t.getAttribute("data-label")==="Factor")!;
 const content=elements(factor,"div").find(n=>n.className==="cell-value")!.textContent;
 expect(content).toBe("Diagnostic x2.00 (clamped, not applied)");
 expect(elements(doc.body,"p").find(p=>p.textContent.startsWith("Current calibration:"))!.textContent).toContain(content);
 }finally{app.dispose();}
});
