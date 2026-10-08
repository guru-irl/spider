import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDbReadOnly } from "@spider/db-core";
import { openUsageLedger, type UsageLedger } from "../ledger.js";
import { ingestOnce } from "../ingest.js";
import { forgetSessionMetadata } from "../session-metadata.js";
import { backfillSessionMetadata, METADATA_BACKFILL_BYTES_PER_PASS } from "../session-backfill.js";
import type { Discovery, SourceInfo } from "../discovery.js";
const gitReads=vi.hoisted(()=>({count:0,fake:false}));
vi.mock("node:child_process",async importOriginal=>{
 const actual=await importOriginal<typeof import("node:child_process")>();
 const {promisify}=await import("node:util");
 const execFile=(...args: Parameters<typeof actual.execFile>)=>actual.execFile(...args);
 Object.defineProperty(execFile,promisify.custom,{value:async(...args: any[])=>{
  gitReads.count++;if(gitReads.fake)return {stdout:"worktree /synthetic/main-project\n",stderr:""};
  return (promisify(actual.execFile) as any)(...args);
 }});
 return {...actual,execFile};
});
let root: string, ledger: UsageLedger;
const at = Date.parse("2026-10-01T12:00:00Z");
const signal = () => new AbortController().signal;
const header = { type: "session", id: "session", timestamp: new Date(at).toISOString() };
const call = (id: string) => ({ type: "message", id, timestamp: new Date(at + 1).toISOString(), message: { role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } } });
function source(name = "session"): SourceInfo { return { path: join(root, `${name}.jsonl`), project: null, repo: null, run: null }; }
function discovery(sources: SourceInfo[]): Discovery { return { sources, runs: [], errors: [] }; }
function write(s: SourceInfo, lines: unknown[]) { writeFileSync(s.path, lines.map(l => JSON.stringify(l)).join("\n") + "\n"); }
function facts() { const db = openDbReadOnly(join(root, "usage.db"))!; try { return db.prepare("SELECT id,fingerprint,input,output FROM counted_calls ORDER BY id").all(); } finally { db.close(); } }
beforeEach(() => { gitReads.count=0;gitReads.fake=false; root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "metadata-backfill-")); ledger = openUsageLedger(join(root, "usage.db")); });
afterEach(() => { vi.restoreAllMocks(); ledger.close(); rmSync(root, { recursive: true, force: true }); });
it("backfill resumes without billing reimport and a completed pass reads zero bytes", async () => {
  const s = source(); write(s, [header, call("one"), { type: "session_info", name: "Historical name" }]); const d = discovery([s]);
  await ingestOnce(ledger, d, at, signal()); const before = facts(), billing = ledger.getImportState(s.path);
  // Model a migrated v3 ledger: only metadata is cleared, never billing facts.
  ledger.apply({ calls: [], runs: [], states: [], resetSources: [], resetSessionMetadata: [{ path: s.path, sessionId: "session" }], sourceErrors: [], detailedRunIds: [], restoreAggregateRunIds: [], at });
  const first = await backfillSessionMetadata(ledger, d, at, signal(), () => true, 100); expect(first.complete).toBe(false); expect(first.bytesRead).toBeLessThanOrEqual(100);
  let result = first; for (let i = 0; i < 20 && !result.complete; i++) result = await backfillSessionMetadata(ledger, d, at, signal(), () => true, 100);
  expect(result.complete).toBe(true); expect(ledger.getSessions()[0].name).toBe("Historical name"); expect(ledger.getImportState(s.path)).toEqual(billing); expect(facts()).toEqual(before);
  expect((await backfillSessionMetadata(ledger, d, at, signal(), () => true, 100)).bytesRead).toBe(0);
});
it("huge lines resume across passes within the total byte budget across sources", async () => {
  const sources = [source("one"), source("two")];
  for (const [i, s] of sources.entries()) write(s, [{ ...header, id: `session-${i}` }, { type: "message", message: { role: "user", content: "Bounded name\n" + "private".repeat(40000) } }]);
  let done = false, passes = 0;
  while (!done && passes++ < 30) { const result = await backfillSessionMetadata(ledger, discovery(sources), at, signal(), () => true, 32768); expect(result.bytesRead).toBeLessThanOrEqual(32768); done = result.complete; }
  expect(done).toBe(true); expect(ledger.getSessions().map(s => s.name)).toEqual(["Bounded name", "Bounded name"]);
});
it("lost lease and cancellation write no metadata or checkpoint", async () => {
  const s = source(); write(s, [header, { type: "session_info", name: "Never committed" }]); let guards = 0;
  await backfillSessionMetadata(ledger, discovery([s]), at, signal(), () => ++guards === 1, 65536);
  expect(ledger.getSessions()).toEqual([]); expect(ledger.getMetadataCheckpoint(s.path)).toBeUndefined();
  const controller = new AbortController(); controller.abort(); await backfillSessionMetadata(ledger, discovery([s]), at, controller.signal, () => true, 65536); expect(ledger.getSessions()).toEqual([]);
});
it("appending new live billing calls progresses while historical backfill remains bounded", async () => {
  const old = source("historical"), live = source("live"); write(old, [{ ...header, id: "old" }, { type: "message", message: { role: "toolResult", content: "x".repeat(METADATA_BACKFILL_BYTES_PER_PASS * 3) } }]); write(live, [header, call("one")]);
  for (let pass = 0; pass < 2; pass++) {
    appendFileSync(live.path, JSON.stringify(call(`live-${pass}`)) + "\n");
    await ingestOnce(ledger, discovery([live]), at + pass, signal());
    const result = await backfillSessionMetadata(ledger, discovery([old, live]), at + pass, signal(), () => true, METADATA_BACKFILL_BYTES_PER_PASS);
    expect(result.complete).toBe(false); expect(result.bytesRead).toBeLessThanOrEqual(METADATA_BACKFILL_BYTES_PER_PASS); expect(ledger.health().calls).toBe(pass + 2); expect(ledger.health().lastIngestAt).toBe(at + pass); expect(ledger.getImportState(live.path)?.offset).toBe(statSync(live.path).size);
  }
});
it("missing metadata source has a safe code and does not erase billing facts", async () => {
  const s = source(); write(s, [header, call("one")]); await ingestOnce(ledger, discovery([s]), at, signal()); rmSync(s.path);
  await backfillSessionMetadata(ledger, discovery([s]), at, signal(), () => true, 65536); expect(ledger.health().calls).toBe(1); expect(ledger.getSourceErrors().some(e => e.code === "metadata-missing-source")).toBe(true);
});

it("a restarted backfill keeps the first user and resumes with a tiny budget", async () => {
  const s = source(); write(s, [header, { type: "message", message: { role: "user", content: "First user" } }]);
  await backfillSessionMetadata(ledger, discovery([s]), at, signal(), () => true, 65536);
  appendFileSync(s.path, JSON.stringify({ type: "message", message: { role: "user", content: "Wrong second user" } }) + "\n");
  forgetSessionMetadata(s.path);
  let complete = false; for (let i = 0; i < 30 && !complete; i++) complete = (await backfillSessionMetadata(ledger, discovery([s]), at, signal(), () => true, 10)).complete;
  expect(complete).toBe(true); expect(ledger.getSessions()[0].name).toBe("First user");
  appendFileSync(s.path, JSON.stringify({ type: "session_info", name: "Later explicit name" }) + "\n");
  forgetSessionMetadata(s.path);
  complete = false; for (let i = 0; i < 30 && !complete; i++) complete = (await backfillSessionMetadata(ledger, discovery([s]), at, signal(), () => true, 10)).complete;
  expect(ledger.getSessions()[0].name).toBe("Later explicit name");
});

it("completed child metadata captures newly available ownership without re-reading history", async () => {
  const s = source(); s.run = { id: "child", dbPath: "fixture.db", project: null, repo: null, sessionId: null, parentRunId: null, agent: null, role: "worker", name: null, model: null, thinking: null, phase: null, startedAt: at, endedAt: at + 1 };
  write(s, [header, call("one")]); const d = discovery([s]);
  await ingestOnce(ledger, d, at, signal()); await backfillSessionMetadata(ledger, d, at, signal(), () => true, 65536);
  expect(ledger.getSessions()).toEqual([]);
  s.run = { ...s.run, sessionId: "known-owner" };
  const result = await backfillSessionMetadata(ledger, discovery([{ ...s }]), at, signal(), () => true, 65536);
  expect(result.bytesRead).toBe(0); expect(ledger.getSessions()[0]).toMatchObject({ id: "session", ownerSessionId: "known-owner" });
});

it("a torn trailing line is caught up but is re-read on the next pass", async () => {
 const s=source();write(s,[header]);const offset=statSync(s.path).size;
 appendFileSync(s.path,'{"type":"session_info","name":"Tor');
 const first=await backfillSessionMetadata(ledger,discovery([s]),at,signal(),()=>true,65536);
 expect(first.complete).toBe(true);expect(ledger.getMetadataCheckpoint(s.path)?.offset).toBe(offset);
 appendFileSync(s.path,'n name"}\n');
 const next=await backfillSessionMetadata(ledger,discovery([s]),at,signal(),()=>true,65536);
 expect(next.complete).toBe(true);expect(ledger.getSessions()[0].name).toBe("Torn name");
 expect(next.bytesRead).toBe(statSync(s.path).size-offset);
});

it("completed metadata does not resolve projects again after cache churn", async () => {
 const s=source();s.project=join(root,"unique-cwd");write(s,[header]);
 await ingestOnce(ledger,discovery([s]),at,signal());
 await backfillSessionMetadata(ledger,discovery([s]),at,signal(),()=>true,65536);
 const stored=ledger.getSessions()[0];
 // Replace the git boundary before loading a fresh resolver cache.
 vi.resetModules(); gitReads.count=0;
 const {backfillSessionMetadata:fresh}=await import("../session-backfill.js");
 const result=await fresh(ledger,discovery([s]),at,signal(),()=>true,65536);
 expect(result.bytesRead).toBe(0);expect(gitReads.count).toBe(0);expect(ledger.getSessions()[0].project).toBe(stored.project);
});
it("unchanged metadata with a missing project does not run git", async () => {
 const s=source();write(s,[header]);await ingestOnce(ledger,discovery([s]),at,signal());
 await backfillSessionMetadata(ledger,discovery([s]),at,signal(),()=>true,65536);
 vi.resetModules();gitReads.count=0;const {backfillSessionMetadata:fresh}=await import("../session-backfill.js");
 s.project=join(root,"later-cwd");await fresh(ledger,discovery([s]),at,signal(),()=>true,65536);
 expect(gitReads.count).toBe(0);expect(ledger.getSessions()[0].project).toBeNull();
});

it("project cache retains 4096 distinct directories without re-running git", async () => {
 vi.resetModules();gitReads.count=0;gitReads.fake=true;
 const {resolveSessionProject:resolve}=await import("../session-metadata.js");
 for(let i=0;i<4096;i++)expect(await resolve(`/synthetic/cache-${i}`,null)).toBe("main-project");
 expect(await resolve("/synthetic/cache-0",null)).toBe("main-project");expect(gitReads.count).toBe(4096);
});
