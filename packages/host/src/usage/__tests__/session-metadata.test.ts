import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDbReadOnly } from "@spider/db-core";
import { openUsageLedger, type ImportBatch, type RunMeta, type UsageLedger } from "../ledger.js";
import { ingestOnce } from "../ingest.js";
import type { SourceInfo } from "../discovery.js";
import { SessionMetadataCapture, readSessionMetadata, redactSessionName, resolveSessionProject } from "../session-metadata.js";
let root: string, ledger: UsageLedger;
const at = Date.parse("2026-10-01T12:00:00Z");
const signal = () => new AbortController().signal;
const header = (extra = {}) => ({ type: "session", id: "synthetic-session", timestamp: new Date(at).toISOString(), ...extra });
const user = (content: unknown, ts = at + 1) => ({ type: "message", timestamp: new Date(ts).toISOString(), message: { role: "user", content } });
const call = (id = "call", ts = at + 2) => ({ type: "message", id, timestamp: new Date(ts).toISOString(), message: { role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } } });
function source(run: RunMeta | null = null): SourceInfo { return { path: join(root, "session.jsonl"), project: null, repo: null, run }; }
function write(s: SourceInfo, lines: unknown[]) { writeFileSync(s.path, lines.map(l => JSON.stringify(l)).join("\n") + "\n"); }
function batch(extra: Partial<ImportBatch> = {}): ImportBatch { return { calls: [], runs: [], states: [], resetSources: [], sourceErrors: [], detailedRunIds: [], restoreAggregateRunIds: [], at, ...extra }; }
function run(id: string): RunMeta { return { id, dbPath: "fixture.db", project: null, repo: null, sessionId: "human-owner", parentRunId: null, agent: null, role: "worker", name: null, model: null, thinking: null, phase: null, startedAt: at, endedAt: null }; }
beforeEach(() => { root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "metadata-")); ledger = openUsageLedger(join(root, "usage.db")); });
afterEach(() => { vi.restoreAllMocks(); ledger.close(); rmSync(root, { recursive: true, force: true }); });
it("latest name wins over first user and id without trusting timestamps", async () => {
  const s = source(); write(s, [header(), user("  First line\nprivate suffix"), { type: "session_info", name: "Earlier", timestamp: "2099-01-01" }, { type: "session_info", name: "Latest", timestamp: "2000-01-01" }]);
  await ingestOnce(ledger, { sources: [s], runs: [], errors: [] }, at, signal());
  expect(ledger.getSessions()[0]).toMatchObject({ name: "Latest", nameSource: "name", firstActivity: null, lastActivity: null });
});
it("unnamed sessions use the first text block line and at most 80 code points", async () => {
  const s = source(); write(s, [header(), user([{ type: "image", data: "ignored" }, { type: "text", text: "  " + "猫".repeat(100) + "\nsecret" }])]);
  const result = await readSessionMetadata(s, undefined, signal(), 65536);
  expect(result.session?.nameSource).toBe("first-user"); expect([...(result.session?.name ?? "")]).toHaveLength(80);
});
it.each(["", [{ type: "image", data: "ignored" }], 42])("blank or nontext first message uses short id: %j", async content => {
  const s = source(); write(s, [header(), user(content), user("Do not use the second message")]);
  const result = await readSessionMetadata(s, undefined, signal(), 65536);
  expect(result.session).toMatchObject({ name: "synthet", nameSource: "id" });
});
it("name is redacted before storage, including encoded paths and terminal controls", async () => {
  const s = source(); const name = "Review %2FUsers%2Fexample%2Fsecret and C%3A%5CUsers%5Cexample%5Csecret \u001b[31mnow\u001b[0m";
  write(s, [header(), { type: "session_info", name }]); await ingestOnce(ledger, { sources: [s], runs: [], errors: [] }, at, signal());
  const stored = ledger.getSessions()[0].name;
  expect(stored).not.toMatch(/example|secret|%2F|%5C|\u001b|\[31m/); expect(redactSessionName(name)).toBe(stored);
});
it("huge content retains only a bounded first line and never enters source entries", async () => {
  const s = source(); write(s, [header(), user("Visible line\n" + "private-user".repeat(300000)), { type: "message", message: { role: "toolResult", content: "private-tool".repeat(300000) } }, { ...call(), message: { ...call().message, content: "private-assistant".repeat(300000) } }]);
  await ingestOnce(ledger, { sources: [s], runs: [], errors: [] }, at, signal());
  expect(ledger.getSessions()[0].name).toBe("Visible line"); expect(ledger.health().calls).toBe(1);
  const db = openDbReadOnly(join(root, "usage.db"))!; try { const entries = JSON.stringify(db.prepare("SELECT json FROM source_entries").all()); expect(entries).not.toMatch(/private-user|private-tool|private-assistant|Visible line/); expect(entries.length).toBeLessThan(2000); } finally { db.close(); }
});
it("malformed metadata is resumable and later valid lines still ingest", async () => {
  const s = source(); write(s, [header(), { type: "session_info", name: { bad: true } }]); const offset = statSync(s.path).size;
  appendFileSync(s.path, '{"type":"session_info","name":"Res');
  const first = await readSessionMetadata(s, undefined, signal(), 65536); expect(first.checkpoint.offset).toBe(offset); expect(first.checkpoint.complete).toBe(false);
  appendFileSync(s.path, 'umed"}\n{bad\n' + JSON.stringify(call()) + "\n");
  const second = await readSessionMetadata(s, first.checkpoint, signal(), 65536); expect(second.session?.name).toBe("Resumed"); expect(second.checkpoint.complete).toBe(true); expect(second.errors.map(e => e.code)).toContain("metadata-parse-error");
  await ingestOnce(ledger, { sources: [s], runs: [], errors: [] }, at, signal()); expect(ledger.health().calls).toBe(1);
});
it.each([true, false])("inherited user is not a name; new user present=%s", async newer => {
  const s = source(); write(s, [header({ parentSession: "inherited.jsonl" }), user("Inherited", at - 1), ...(newer ? [user("New user")] : [])]);
  const result = await readSessionMetadata(s, undefined, signal(), 65536); expect(result.session?.name).toBe(newer ? "New user" : "synthet");
});
it("nested child header maps to its run owner without parent_run_id", async () => {
  const r = run("nested"), s = source(r); write(s, [header({ id: "child-session" }), call()]);
  await ingestOnce(ledger, { sources: [s], runs: [r], errors: [] }, at, signal()); expect(ledger.getSessions()[0]).toMatchObject({ id: "child-session", ownerSessionId: "human-owner", firstActivity: at + 2, lastActivity: at + 2 });
});
it("status only ingest persists and every real status commits with unknown normalized", async () => {
  const statuses = ["queued", "running", "paused", "done", "failed", "cancelled", "future"];
  const runs = statuses.map((_, i) => run(`run${i}`));
  const s = source(); write(s, [header(), call()]);
  const d = { sources: [s], runs, errors: [], runStates: runs.map((r, i) => ({ id: r.id, dbPath: r.dbPath, status: statuses[i], childMode: null })) };
  await ingestOnce(ledger, d, at, signal()); expect(ledger.getRuns().map(r => r.status)).toEqual([...statuses.slice(0, 6), null]);
  const billingBefore = ledger.getImportState(s.path);
  d.runStates[3].status = "cancelled"; await ingestOnce(ledger, d, at + 1, signal()); expect(ledger.getRuns()[3].status).toBe("cancelled");
  expect(ledger.getImportState(s.path)).toEqual(billingBefore); expect(ledger.health().calls).toBe(1);
});
it("duplicate run ids join status by dbPath and id", async () => {
  const a = run("duplicate"), b = { ...a, dbPath: "other.db" };
  await ingestOnce(ledger, { sources: [], runs: [a, b], errors: [], runStates: [{ id: a.id, dbPath: a.dbPath, status: "done", childMode: null }, { id: b.id, dbPath: b.dbPath, status: "failed", childMode: null }] }, at, signal());
  expect(ledger.getRuns().map(r => r.status)).toEqual(["done", "failed"]);
});
it("explicit metadata reset clears name and span in the same fenced transaction", () => {
  const session = { id: "s", ownerSessionId: null, name: "Old", nameSource: "name" as const, project: null, firstActivity: 1, lastActivity: 1000, nameOrder: 9000 };
  ledger.apply(batch({ sessions: [session], metadataCheckpoints: [{ path: "fixture", generation: 0, offset: 1, size: 1, complete: true }] }));
  const next = { ...session, name: "New", nameOrder: 1, firstActivity: 20, lastActivity: 30 };
  expect(ledger.apply(batch({ resetSessionMetadata: [{ path: "fixture", sessionId: "s" }], sessions: [next], commitGuard: () => false }))).toBe(false);
  expect(ledger.getSessions()).toEqual([session]);
  ledger.apply(batch({ resetSessionMetadata: [{ path: "fixture", sessionId: "s" }], sessions: [next] })); expect(ledger.getSessions()).toEqual([next]); expect(ledger.getMetadataCheckpoint("fixture")).toBeUndefined();
});
it("replacement clears stale metadata safely, including a changed header id", async () => {
  const s = source(); write(s, [header(), { type: "session_info", name: "Old" }, call("old", at + 9999)]); await ingestOnce(ledger, { sources: [s], runs: [], errors: [] }, at, signal());
  renameSync(s.path, join(root, "old.jsonl")); write(s, [header({ id: "replacement" }), user("Replacement"), call("new")]);
  await ingestOnce(ledger, { sources: [s], runs: [], errors: [] }, at + 1, signal()); expect(ledger.getSessions()).toHaveLength(1); expect(ledger.getSessions()[0]).toMatchObject({ id: "replacement", name: "Replacement", firstActivity: at + 2, lastActivity: at + 2 });
});
it("malformed metadata must never abort an ingest batch carrying billing calls", async () => {
  const s = source(); write(s, [header(), call()]);
  let captured: ImportBatch | undefined; const apply = ledger.apply.bind(ledger);
  ledger.apply = incoming => { if (incoming.calls.length) captured = incoming; return apply(incoming); };
  await ingestOnce(ledger, { sources: [s], runs: [], errors: [] }, at, signal());
  const existing = ledger.getImportState(s.path)!;
  expect(() => ledger.apply(batch({ calls: captured!.calls.map(c => ({ ...c, id: "valid-new-call", entryId: "valid-new-call" })), runs: [{ ...run("invalid"), status: "future" as any }], sessions: [{ id: "bad", ownerSessionId: null, name: null as any, nameSource: "bad" as any, project: null, firstActivity: NaN, lastActivity: null, nameOrder: -1 }], metadataCheckpoints: [{ path: s.path, generation: -1, offset: -1, size: -1, complete: true }], states: [{ ...existing, mtimeMs: existing.mtimeMs + 1 }] }))).not.toThrow();
  expect(ledger.getImportState(s.path)?.mtimeMs).toBe(existing.mtimeMs + 1); expect(ledger.health().calls).toBe(2); expect(ledger.getRuns()[0].status).toBeNull();
});
it("deleted cwd preserves registered repo and otherwise uses folder basename", async () => {
  expect(await resolveSessionProject(join(root, "deleted"), "/synthetic/registered-repo")).toBe("registered-repo"); expect(await resolveSessionProject(join(root, "deleted"), null)).toBe("deleted");
});

it("first user text block ignores image captions even when text precedes type", async () => {
  const s = source(); write(s, [header(), user([{ text: "Image caption", type: "image" }, { text: "Actual first text", type: "text" }, { type: "text", text: "Later" }])]);
  const result = await readSessionMetadata(s, undefined, signal(), 65536); expect(result.session?.name).toBe("Actual first text");
});
it("percent-encoded terminal controls are removed after path decoding", () => {
  expect(redactSessionName("Hello %1B[31mworld%1B[0m%00")).toBe("Hello world");
});
it("malformed run metadata cannot abort a batch with a new billing call", async () => {
  const s = source(); write(s, [header(), call()]); await ingestOnce(ledger, { sources: [s], runs: [], errors: [] }, at, signal());
  let captured: ImportBatch | undefined; const apply = ledger.apply.bind(ledger);
  ledger.apply = incoming => { if (incoming.calls.length) captured = incoming; return apply(incoming); };
  appendFileSync(s.path, JSON.stringify(call("new")) + "\n"); await ingestOnce(ledger, { sources: [s], runs: [], errors: [] }, at, signal());
  expect(captured?.calls).toHaveLength(1);
  const incoming = { ...captured!, calls: captured!.calls.map(c => ({ ...c, id: "another", entryId: "another" })), runs: [{ ...run("bad"), name: { invalid: true } as any }], states: [] };
  expect(() => ledger.apply(incoming)).not.toThrow(); expect(ledger.health().calls).toBe(3);
});

it("a child with no owning session is never stored as a human session", async () => {
  const r = { ...run("unresolved"), sessionId: null }, s = source(r); write(s, [header({ id: "orphan-child" }), call()]);
  await ingestOnce(ledger, { sources: [s], runs: [r], errors: [] }, at, signal());
  expect(ledger.health().calls).toBe(1); expect(ledger.getSessions()).toEqual([]);
});

it("nested text inside a nontext content block is not a user name", async () => {
  const s = source(); write(s, [header(), user([{ type: "image", caption: { type: "text", text: "Nested caption" } }, { type: "text", text: "Actual text block" }])]);
  const result = await readSessionMetadata(s, undefined, signal(), 65536); expect(result.session?.name).toBe("Actual text block");
});
it("percent-encoded Unicode in a name keeps code points", () => {
  expect(redactSessionName("Review %E7%8C%AB")).toBe("Review 猫");
});

it("empty cwd uses registered evidence and never the worker's git project", async () => {
 expect(await resolveSessionProject("", "/synthetic/registered-empty-cwd")).toBe("registered-empty-cwd");
 expect(await resolveSessionProject("", null)).toBe("");
});
it("a saved header capture failure cannot discard new billing calls", async () => {
 const s=source();write(s,[header(),call("first")]);await ingestOnce(ledger,{sources:[s],runs:[],errors:[]},at,signal());
 appendFileSync(s.path,JSON.stringify(call("second"))+"\n");
 const consume=SessionMetadataCapture.prototype.consume;
 vi.spyOn(SessionMetadataCapture.prototype,"consume").mockImplementation(function(this: SessionMetadataCapture,value,offset) {
  if(offset===0 && (value as any)?.type==="session")throw new Error("fixture header failure");
  return consume.call(this,value,offset);
 });
 await ingestOnce(ledger,{sources:[s],runs:[],errors:[]},at+1,signal());
 expect(ledger.health().calls).toBe(2);expect(ledger.getImportState(s.path)?.offset).toBe(statSync(s.path).size);
});
it("a successful metadata retry clears its stable diagnostic without touching source errors", async () => {
 const s=source();write(s,[header(),call()]);let captured:ImportBatch|undefined;const apply=ledger.apply.bind(ledger);
 ledger.apply=incoming=>{if(incoming.calls.length)captured=incoming;return apply(incoming);};
 await ingestOnce(ledger,{sources:[s],runs:[],errors:[]},at,signal());
 const good=run("retry"), bad={...good,name:{invalid:true} as any};
 ledger.apply(batch({sourceErrors:[{path:good.dbPath,code:"EACCES"}]}));
 ledger.apply(batch({calls:captured!.calls.map(c=>({...c,id:"retry-call",entryId:"retry-call"})),runs:[bad]}));
 const errors=ledger.getSourceErrors();expect(errors.some(e=>e.code==="metadata-invalid")).toBe(true);
 expect(errors.some(e=>e.path===good.dbPath && e.code==="EACCES")).toBe(true);
 ledger.apply(batch({calls:captured!.calls.map(c=>({...c,id:"retry-success-call",entryId:"retry-success-call"})),runs:[good]}));
 expect(ledger.getSourceErrors().some(e=>e.code==="metadata-invalid")).toBe(false);
 expect(ledger.getSourceErrors().some(e=>e.path===good.dbPath && e.code==="EACCES")).toBe(true);
});
