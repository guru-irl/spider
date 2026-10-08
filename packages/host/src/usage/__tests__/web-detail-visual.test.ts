import { mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { build } from "vite";
import { captureDashboard, screenshotSkipReason, BROWSER_TEST_TIMEOUT_MS, type DashboardRoute } from "../../../../../scripts/usage-dashboard-screenshot.mjs";
import { createDashboardBrowserPage, externalFixtureAssets } from "./fixtures/dashboard-browser-fixture.js";
import { usageSecurityHeaders } from "../server-security.js";
import type { ApiEnvelope, OverviewData } from "../dashboard-contract.js";
import type { CacheData } from "../query-cache.js";
import type { RatesData } from "../query-rates.js";
import type { ReconciliationData } from "../query-reconciliation.js";
import type { ExplorerData } from "../query-explorer.js";
import type { DetailCall, DetailData } from "../query-detail.js";

const checkout = fileURLToPath(new URL("../../../../../", import.meta.url));
function analysisRoutes(source: ApiEnvelope<OverviewData>): Record<string, DashboardRoute> {
  const { totals, calibration, daily } = source.data;
  const unavailable = { status: "unavailable", phase: 2, reason: "not-built", message: "Not available yet (Phase 2)" } as const;
  const split = { cacheWrite5m: 0, cacheWrite1h: 0, knownTokens: 0, knownCalls: 0, unknownTokens: 0, unknownCalls: 0 };
  const components = (["input", "cacheRead", "cacheWrite", "output"] as const).map(tokenType => ({ tokenType, tokens: totals.tokens[tokenType], aicDisplay: totals.aicDisplay }));
  const cache: CacheData = { ingestPending: false, writeSplit: split, warmerWriteSplit: split, calibration, totals, warmer: totals, hitRate: 0, components, warmerComponents: components,
    warmerShare: { prompt: 0, calls: 0, publishedAic: 0 }, daily: { rows: daily.rows.map(row => ({ ...row, hitRate: 0, warmer: row.measure, components, warmerComponents: components, writeSplit: split, warmerWriteSplit: split })), nextCursor: null },
    sessionsWithWritesNoReads: { rows: [], nextCursor: null }, observation: "Sessions with writes and no recorded reads", itemReuse: unavailable };
  const rates: RatesData = { calibration, periodCalibration: calibration, totals, versions: [], rates: { rows: [], nextCursor: null }, storedRateVersions: [], storedRateVersionsTruncated: false,
    unpricedModels: { rows: [], nextCursor: null }, factorHistory: { rows: daily.rows.map(row => ({ day: row.start, calibration })), nextCursor: null }, factorHistoryEnabled: true, nextCursor: null };
  const reconciliation: ReconciliationData = { periods: { rows: daily.rows.map(row => ({ start: row.start, end: row.end, bucketStart: row.start, bucketEnd: row.end, coverage: 1, coveredMs: row.end-row.start, resetAnchors: 0, exclusions: {}, counterStart: row.start, counterEnd: row.end,
    status: "compared", counterAic: 20, computed: row.measure, gap: 2, ratio: 1, calibratedAic: 12, calibratedGap: 8, calibratedRatio: 1, ratioReason: null, calibration })), nextCursor: null }, counterGranularityAic: 1, billingLagCaveat: "billing-lag-minutes", caveats: [] };
  const explorer: ExplorerData = { groupBy: ["project"], calibration, totals, rows: [{ key: ["v1_fixture"], labels: ["Synthetic project"], measure: totals }], nextCursor: null };
  return Object.fromEntries(Object.entries({ cache, rates, reconciliation, explorer }).map(([name,data]) => [`/api/${name}`, {body: JSON.stringify({...source,data}),contentType: "application/json",ignoreSearch:true}]));
}
async function detailPage(kind: "session" | "run", placeholder = false) {
  const fixture = await createDashboardBrowserPage();
  const source = JSON.parse(fixture.routes["/api/overview"]!.body as string) as ApiEnvelope<OverviewData>;
  const id = `${kind}-fixture`, measure = source.data.totals;
  const call: DetailCall = { id: "call-fixture", ts: source.period.start + 1000, sessionId: "session-fixture", runId: "run-fixture", parentRunId: "parent-fixture",
    project: { key: "v1_fixture", label: "Synthetic project" }, repo: null, actor: "subagent", role: "worker", agent: "Synthetic worker", runName: "Synthetic run",
    phase: "build", auxPurpose: null, provider: "synthetic", model: "synthetic-model", requestedModel: null, thinking: "high", api: "synthetic-api", latencyMs: 0, aggregate: false, measure };
  const unavailable = { status: "unavailable", phase: 2, reason: "not-built", message: "Not available yet (Phase 2)" } as const;
  const data: DetailData = { kind, id, calibration: source.data.calibration, totals: measure,
    timeline: source.data.daily.rows.map(row => ({ start: row.start, end: row.end, label: row.label, measure: row.measure })),
    calls: { rows: [call], nextCursor: "calls-next" }, links: { rows: [{kind:"run", id:"child-fixture", label:"Synthetic child", relationship:"child", ongoing:true}], nextCursor:"links-next" },
    accounting: {status:"selected",coveringRunId:null,message:"Only globally selected representations are counted; unpriced calls keep unknown AIC."}, contextFillPercent:null,
    contextFillMessage:"Context fill unavailable: historical window not recorded", composition:unavailable, carry:unavailable, itemReuse:unavailable };
  // An injected registry is the existing public integration contract. The root is
  // not usage-app, so the packaged app's default auto-start cannot run twice.
  const entry = "virtual:detail-acceptance";
  const result = await build({configFile:false, root:checkout, publicDir:false, logLevel:"silent",
    plugins:[{name:"detail-acceptance",resolveId(id){return id.endsWith(entry) ? "\0"+entry : null;},load(moduleId){if(moduleId!=="\0"+entry)return null; return `
      import {startDashboard} from ${JSON.stringify(join(checkout,"packages/host/src/usage/web/app.ts"))};
      import {mountCache} from ${JSON.stringify(join(checkout,"packages/host/src/usage/web/cache.ts"))};
      import {mountRates} from ${JSON.stringify(join(checkout,"packages/host/src/usage/web/rates.ts"))};
      import {mountReconciliation} from ${JSON.stringify(join(checkout,"packages/host/src/usage/web/reconciliation.ts"))};
      import {mountExplorer} from ${JSON.stringify(join(checkout,"packages/host/src/usage/web/explorer.ts"))};
      import {mountSession,mountRun} from ${JSON.stringify(join(checkout,"packages/host/src/usage/web/detail.ts"))};
      const start=()=>startDashboard({root:document.getElementById('detail-fixture'),initialRoute:{view:${JSON.stringify(kind)},id:${JSON.stringify(placeholder ? undefined : id)}},mounts:{session:mountSession,run:mountRun,cache:mountCache,rates:mountRates,reconciliation:mountReconciliation,explorer:mountExplorer}});
      if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();`;}}],
    build:{write:false,target:"es2022",minify:true,cssCodeSplit:false,lib:{entry,name:"DetailAcceptance",formats:["iife"]}}});
  const output = (Array.isArray(result)?result:[result]).flatMap(r=>"output" in r ? r.output : []);
  const code = output.filter(o=>o.type==="chunk").map(o=>o.code).join("\n").replace(/<\/script/gi,"<\\/script");
  const css = output.flatMap(o=>o.type==="asset"&&o.fileName.endsWith(".css") ? [String(o.source)] : []).join("\n");
  const clock = `let now=${source.period.end},seq=0;const timers=new Map();Date.now=()=>now;
    window.setTimeout=(run,delay=0)=>{const id=++seq;timers.set(id,{run,due:now+delay});return id;};
    window.setInterval=(run,delay)=>{const id=++seq;timers.set(id,{run,due:now+delay,delay});return id;};window.clearTimeout=window.clearInterval=id=>timers.delete(id);
    window.__clock={advance(ms){now+=ms;for(const[id,t]of Array.from(timers))if(t.due<=now&&timers.has(id)){if(t.delay)t.due=now+t.delay;else timers.delete(id);t.run();}}};
    window.__requests=0;window.__completed=0;const transport=window.fetch;window.fetch=(...args)=>{++window.__requests;return transport(...args).then(r=>{++window.__completed;return r;});};`;
  const { html, routes: assetRoutes } = externalFixtureAssets(clock + code, css, "detail-fixture");
  const response = (data: unknown): DashboardRoute => ({body:JSON.stringify({...source,data}),contentType:"application/json",ignoreSearch:true});
  const routes = {...fixture.routes,...analysisRoutes(source),...assetRoutes,"/api/detail":response(data),"/api/detail-links":response(data.links)};
  return {html,routes};
}
const ready = `new Promise(resolve=>{const deadline=performance.now()+3000;const check=()=>{if(document.querySelector('.detail-calls time')&&window.__completed===window.__requests)requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)));else if(performance.now()>deadline)resolve(false);else requestAnimationFrame(check);};check();})`;

test.skipIf(Boolean(screenshotSkipReason())).each(["session", "run"] as const)("Edge %s retains evidence and pages at 390px and 1272px without clipping", async kind => {
  const fixture=await detailPage(kind), scratch=join(checkout,".spider/scratch/usage-dashboard-visual/detail"); mkdirSync(scratch,{recursive:true});
  const owned=mkdtempSync(join(scratch,"browser-test-"));
  const out=process.env.SPIDER_USAGE_SCREENSHOT_OUT || owned;
  try {for(const width of [390,1272]) {
    let pid=0;
    const png=await captureDashboard({html:fixture.html,routes:fixture.routes,scratchDir:owned,out:join(out,kind,String(width)),viewport:{width,height:width===390?844:900},verify:async page=>{
      pid=page.pid; expect(await page.evaluate(ready)).toBe(true);
      expect(await page.evaluate("document.querySelector('h1').textContent")).toBe(kind==="run"?"Run · Synthetic run":"Session · session-fixture");
      expect(await page.evaluate("document.querySelectorAll('main').length")).toBe(1);
      expect(await page.evaluate("document.documentElement.scrollWidth<=innerWidth")).toBe(true);
      expect(await page.evaluate("Array.from(document.querySelectorAll('td')).every(n=>!getComputedStyle(n).fontFamily.includes('Usage Code'))")).toBe(true);
      expect(await page.evaluate("Array.from(document.querySelectorAll('.numeric')).every(n=>getComputedStyle(n).fontFamily.includes('Usage Code'))")).toBe(true);
      expect(await page.evaluate("document.querySelector('.detail-calls time').dateTime")).toBe("2026-01-01T00:00:01.000Z");
      expect(await page.evaluate("document.querySelector('.detail-calls time').textContent")).toBe("1 Jan 2026, 00:00:01 UTC");
      expect(await page.evaluate("document.querySelector('.detail-calls .token-summary').textContent")).toBe("prompt 1,300 · output 400 · total 1,700");
      const heights = await page.evaluate("Array.from(document.querySelectorAll('.chart-panel svg[role=\"img\"]'),n=>n.getBoundingClientRect().height)") as number[];
      expect(heights.length).toBeGreaterThan(0); expect(heights.every(h=>h===96)).toBe(true);
      const diameters = await page.evaluate(markerDiameters) as number[][]; expect(diameters.length).toBeGreaterThan(0);
      expect(diameters.every(([w,h])=>Math.abs(w!-7)<0.05&&Math.abs(h!-7)<0.05)).toBe(true);
      expect(await page.evaluate(`Array.from(document.querySelectorAll('.table-region')).filter(r=>!r.closest('[hidden]')).every(r=>r.classList.contains('wide-table-region')||r.scrollWidth<=r.clientWidth+1)`)).toBe(true);
      expect(await page.evaluate(`Array.from(document.querySelectorAll('.wide-table td .cell-value')).every(n=>n.clientWidth>=72&&n.scrollWidth<=n.clientWidth+1)`)).toBe(true);
      expect(await page.evaluate(`(()=>{const summary=document.querySelector('.detail-calls .token-summary');return summary.getBoundingClientRect().height<=1.6*parseFloat(getComputedStyle(summary).fontSize);})()`)).toBe(true);
      expect(await page.evaluate(`(()=>{const r=document.querySelector('.wide-table-region');return r.tabIndex===0&&!r.hasAttribute('aria-describedby')&&!r.querySelector('.scroll-cue');})()`)).toBe(true);
      if(width===390)expect(await page.evaluate("Array.from(document.querySelectorAll('.data-table:not(.wide-table)')).filter(n=>!n.closest('[hidden]')).every(n=>getComputedStyle(n).display==='block')")).toBe(true);
      // Navigate both owned pagers before suspension. The fixture accepts any
      // cursor but the next request count and retained buttons are real DOM.
      expect(await page.evaluate(`(()=>{for(const label of ['Calls pages','Related sessions and runs pages'])Array.from(document.querySelector('[aria-label="'+label+'"]').querySelectorAll('button')).find(b=>b.textContent==='Next page').click();return true;})()`)).toBe(true);
      expect(await page.evaluate(ready)).toBe(true);
      await page.evaluate(`window.__retained={main:document.querySelector('main'),section:document.querySelector('.detail-view'),chart:document.querySelector('.chart-panel'),table:document.querySelector('.chart-panel table'),region:document.querySelector('.chart-panel .table-region')};const toggle=Array.from(window.__retained.chart.querySelectorAll('button')).find(b=>b.textContent==='Table');toggle.click();toggle.focus();window.__retained.toggle=toggle;window.__before=window.__requests;Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));window.__clock.advance(300000);Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));window.__clock.advance(300);`);
      expect(await page.evaluate(ready)).toBe(true);
      expect(await page.evaluate("window.__requests-window.__before")).toBe(2);
      expect(await page.evaluate(`window.__retained.main===document.querySelector('main')&&window.__retained.section===document.querySelector('.detail-view')&&window.__retained.chart===document.querySelector('.chart-panel')&&window.__retained.table===document.querySelector('.chart-panel table')&&window.__retained.region===document.querySelector('.chart-panel .table-region')&&document.activeElement===window.__retained.toggle&&window.__retained.toggle.getAttribute('aria-pressed')==='true'`)).toBe(true);
      expect(await page.evaluate(`Array.from(document.querySelectorAll('[aria-label$="pages"]')).every(g=>Array.from(g.querySelectorAll('button')).find(b=>b.textContent==='Previous page').disabled===false)`)).toBe(true);
      expect(await page.evaluate("Array.from(document.querySelectorAll('button')).filter(b=>b.textContent==='Retry'&&!b.hidden).length")).toBe(0);
      expect(await page.evaluate("document.documentElement.scrollWidth<=innerWidth")).toBe(true);
      expect(await page.evaluate(`(()=>{const r=document.querySelector('.wide-table-region');r.scrollLeft=r.scrollWidth;const scrolled=r.scrollLeft===Math.max(0,r.scrollWidth-r.clientWidth);r.scrollLeft=0;return scrolled;})()`)).toBe(true);
      expect(await page.evaluate("(()=>{const last=Array.from(document.querySelector('.detail-view').children).at(-1);last.scrollIntoView({block:'end'});return last.getBoundingClientRect().bottom<=innerHeight+1;})()")).toBe(true);
      await page.evaluate("scrollTo(0,0)");
    }});
    expect(readFileSync(png).length).toBeGreaterThan(10000); renameSync(png,join(out,kind,String(width),`${kind}-viewport.png`));
    expect(()=>process.kill(pid,0)).toThrow();
    const full=await captureDashboard({html:fixture.html,routes:fixture.routes,scratchDir:owned,out:join(out,kind,String(width)),viewport:{width,height:width===390?844:900},fullPage:true,verify:async page=>{
      pid=page.pid; expect(await page.evaluate(ready)).toBe(true);
      expect(await page.evaluate("[innerWidth,innerHeight]")).toEqual([width,width===390?844:900]);
    }});
    expect(readFileSync(full).readUInt32BE(20)).toBeGreaterThan(width===390?844:900); renameSync(full,join(out,kind,String(width),`${kind}-full.png`)); expect(()=>process.kill(pid,0)).toThrow();
    const tail=await captureDashboard({fullPage:true,html:fixture.html,routes:fixture.routes,scratchDir:owned,out:join(out,kind,String(width)),viewport:{width,height:width===390?844:900},verify:async page=>{
      pid=page.pid; expect(await page.evaluate(ready)).toBe(true);
      expect(await page.evaluate(`(()=>{const r=document.querySelector('.detail-calls .table-region');r.scrollLeft=r.scrollWidth;return r.scrollLeft>0&&Array.from(r.querySelectorAll('.cell-value')).every(n=>n.scrollWidth<=n.clientWidth+1);})()`)).toBe(true);
      expect(await page.evaluate("document.documentElement.scrollWidth<=innerWidth")).toBe(true);
    }});
    expect(readFileSync(tail).length).toBeGreaterThan(10000); renameSync(tail,join(out,kind,String(width),`${kind}-calls-end.png`)); expect(()=>process.kill(pid,0)).toThrow();
  }} finally {rmSync(owned,{recursive:true,force:true});}
}, BROWSER_TEST_TIMEOUT_MS * 2);


const pills = "Array.from(document.querySelectorAll('.usage-rail .action'),n=>n.getBoundingClientRect().height)";
const settledView = (heading: string) => `new Promise(resolve=>{const deadline=performance.now()+3000;const check=()=>{if(document.querySelector('h1')?.textContent===${JSON.stringify(heading)}&&window.__completed===window.__requests)requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)));else if(performance.now()>deadline)resolve(false);else requestAnimationFrame(check);};check();})`;
const markerDiameters = `Array.from(document.querySelectorAll('.chart-panel svg circle')).filter(n=>!n.closest('[hidden]')).map(n=>[n.getBoundingClientRect().width,n.getBoundingClientRect().height])`;
function ownedVisual() {
  const scratch=join(checkout,".spider/scratch/usage-dashboard-visual/detail"); mkdirSync(scratch,{recursive:true});
  return mkdtempSync(join(scratch,"browser-test-"));
}

test.skipIf(Boolean(screenshotSkipReason()))("Edge short Run placeholder keeps natural pill height at 390x844", async () => {
  // Breaks: shared mobile implicit rows or flex line stretching inflate short-page pills.
  const fixture=await detailPage("run",true), owned=ownedVisual(); let pid=0;
  try {
    await captureDashboard({html:fixture.html,routes:fixture.routes,scratchDir:owned,out:owned,viewport:{width:390,height:844},verify:async page=>{
      pid=page.pid; expect(await page.evaluate(settledView("Run"))).toBe(true);
      expect(await page.evaluate("document.querySelector('main').textContent.includes('Select a run')")).toBe(true);
      const heights=await page.evaluate(pills) as number[]; expect(heights.length).toBe(8); expect(heights.every(h=>h>24&&h<48)).toBe(true);
    }}); expect(()=>process.kill(pid,0)).toThrow();
  } finally {rmSync(owned,{recursive:true,force:true});}
},BROWSER_TEST_TIMEOUT_MS);

test.skipIf(Boolean(screenshotSkipReason()))("Edge compact Attribution is content-sized and aligns the first line", async () => {
  // Breaks: browser default paragraph margins inflate the off-screen Attribution cell.
  const fixture=await detailPage("run"),owned=ownedVisual();let pid=0;
  try {
    await captureDashboard({html:fixture.html,routes:fixture.routes,scratchDir:owned,out:owned,viewport:{width:1272,height:900},verify:async page=>{
      pid=page.pid;expect(await page.evaluate(ready)).toBe(true);
      const result=await page.evaluate(`(()=>{const row=document.querySelector('.detail-calls tbody tr'),cell=row.cells[6],p=cell.querySelector('.attribution-summary > span'),content=cell.querySelector('.detail-prose');return {height:row.getBoundingClientRect().height,content:content.getBoundingClientRect().height,margin:parseFloat(getComputedStyle(p).marginTop),offset:p.getBoundingClientRect().top-row.cells[0].querySelector('.cell-value').getBoundingClientRect().top};})()` ) as {height:number;content:number;margin:number;offset:number};
      console.log("Recorded calls dimensions",JSON.stringify(result));
      expect(result.margin).toBe(0);expect(result.offset).toBeLessThan(1);expect(result.height-result.content).toBeLessThan(40);expect(result.height).toBeLessThan(150);
    }});expect(()=>process.kill(pid,0)).toThrow();
  }finally{rmSync(owned,{recursive:true,force:true});}
},BROWSER_TEST_TIMEOUT_MS);

test.skipIf(Boolean(screenshotSkipReason())).each([390,1272])("Edge shared views at %spx keep natural pills and 7px chart points without connecting gaps", async width => {
  // Breaks: scaled SVG radii, chart lines joining unknown windows, or shared mobile rail stretching.
  const fixture=await detailPage("run",true),owned=ownedVisual();let pid=0;
  try {
    const png=await captureDashboard({html:fixture.html,routes:fixture.routes,scratchDir:owned,out:owned,viewport:{width,height:width===390?844:900},verify:async page=>{
      pid=page.pid;expect(await page.evaluate(settledView("Run"))).toBe(true);
      for(const view of ["Overview","Explorer","Cache","Reconciliation","Rates"]) {
        await page.evaluate(`Array.from(document.querySelectorAll('.usage-rail button')).find(b=>b.textContent===${JSON.stringify(view)}).click()`);
        expect(await page.evaluate(settledView(view))).toBe(true);
        const heights=await page.evaluate(pills) as number[];expect(heights.length).toBe(8);expect(heights.every(h=>h>24&&h<48)).toBe(true);
        {
          const sizes=await page.evaluate(markerDiameters) as number[][];expect(sizes.length).toBeGreaterThan(0);
          expect(sizes.every(([w,h])=>Math.abs(w!-7)<0.05&&Math.abs(h!-7)<0.05)).toBe(true);
          expect(await page.evaluate("document.querySelectorAll('.chart-panel svg path,.chart-panel svg polyline,.chart-panel svg line:not(.chart-zero-line)').length")).toBe(0);
        }
        if(view==="Explorer") expect(await page.evaluate("document.querySelector('.usage-explorer table tbody tr')!==null")).toBe(true);
        if(view==="Reconciliation") {
          const extents=await page.evaluate(`Array.from(document.querySelectorAll('.chart-zero-line')).map(line=>{
            const svg=line.ownerSVGElement.ownerSVGElement, dots=Array.from(svg.querySelectorAll('circle'));
            const centers=dots.map(dot=>{const r=dot.getBoundingClientRect();return r.x+r.width/2;});
            const r=line.getBoundingClientRect(), outer=svg.getBoundingClientRect();return [r.left,r.right,Math.min(...centers),outer.left+outer.width*574/600,getComputedStyle(line).strokeWidth,getComputedStyle(line).vectorEffect];
          })`) as [number,number,number,number,string,string][];
          expect(extents.length).toBeGreaterThan(0);
          for(const [left,right,first,expectedRight,stroke,effect] of extents) {
            expect(Math.abs(left-first)).toBeLessThan(1);expect(Math.abs(right-expectedRight)).toBeLessThan(1);
            expect(stroke).toBe("1px");expect(effect).toBe("non-scaling-stroke");
          }
        }
      }
      await page.evaluate("Array.from(document.querySelectorAll('.usage-rail button')).find(b=>b.textContent==='Overview').click();scrollTo(0,0)");
      expect(await page.evaluate(settledView("Overview"))).toBe(true);
    }});
    const out=process.env.SPIDER_USAGE_SCREENSHOT_OUT;
    if(out){mkdirSync(join(out,"overview",String(width)),{recursive:true});renameSync(png,join(out,"overview",String(width),"overview-viewport.png"));}
    expect(()=>process.kill(pid,0)).toThrow();
  }finally{rmSync(owned,{recursive:true,force:true});}
},BROWSER_TEST_TIMEOUT_MS);
