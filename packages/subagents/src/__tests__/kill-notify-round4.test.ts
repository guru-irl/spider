import { afterEach, expect, it, vi } from "vitest";
import { killRun } from "../kill";
import { makeKillHandler } from "../actions/kill";
import { makeRunHandler, makeAsyncNotifier } from "../actions/run";
import { RunStore } from "../run-store";
import { freshDb, testScratchPath } from "./helpers/testutil";
import { getChild, teardownAllAsync } from "../coordinators";
import { type Db } from "@spider/db-core";
import { AgentSession } from "@earendil-works/pi-coding-agent";
const dbs: Db[] = [];
afterEach(async () => { await teardownAllAsync({ graceMs: 1 }); for(const db of dbs.splice(0)) db.close(); vi.restoreAllMocks(); });
it("kill reports an unconfirmed identity as an error with the reason, not no-process", async () => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db);
  const {id} = store.create({sessionId:"owner",agent:"worker"}); store.start(id); store.setPid(id, process.pid, process.pid, "mismatched-start");
  const result = await makeKillHandler()({id}, {db,sessionId:"owner"});
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/unconfirmed|failed/i);
  expect(result.content).toMatch(/start time mismatch/i);
  expect(result.content).not.toMatch(/no-process/);
});
it("a pid-only own-session kill retains the same specific cause", async () => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db);
  const {id} = store.create({sessionId:"pid-owner",agent:"worker"}); store.start(id); store.setPid(id,12345,process.pid,"fixture-start");
  const result = await killRun({db,store,alive:()=>true,probeStartTime:()=>"fixture-start",kill:async()=>"terminated"},"pid-owner",store.get(id)!);
  expect(result.outcome).toBe("killed");
  expect(store.get(id)).toMatchObject({status:"cancelled",result:"killed by spider kill from this session"});
});
it("a caller's own kill persists its cause and sends no extra completion notification", async () => {
  const db = freshDb(); dbs.push(db); const sent: any[] = []; let finish!: (v:any)=>void;
  const exit = new Promise<{exitCode:number}>(r=>{finish=r});
  const ctx = {db, sessionId:"owner",cwd:testScratchPath("cwd"),runDbPath:testScratchPath("fixture.db"),pi:{sendMessage:(...args:any[])=>sent.push(args)}};
  const result = await makeRunHandler({spawner:()=>({wait:()=>exit,detach(){},kill(){finish({exitCode:143})}})})({agent:"worker",task:"work"},ctx);
  const id = result.details.run.id;
  expect((await makeKillHandler()({id},ctx)).isError).toBe(false);
  await exit; await Promise.resolve(); await Promise.resolve();
  expect(new RunStore(db).get(id)).toMatchObject({status:"cancelled", result:"killed by spider kill from this session"});
  expect(sent).toEqual([]);
});
it.each(["quit","reload"])("shutdown on %s records its cause without starting a model turn", async reason => {
  const db = freshDb(); dbs.push(db); const sent:any[]=[]; let finish!:(v:any)=>void;
  const exit = new Promise<{exitCode:number}>(r=>{finish=r});
  const ctx={db,sessionId:reason,cwd:testScratchPath("cwd"),runDbPath:testScratchPath("fixture.db"),pi:{sendMessage:(...args:any[])=>sent.push(args)}};
  const result=await makeRunHandler({spawner:()=>({wait:()=>exit,detach(){},kill(){finish({exitCode:143})}})})({agent:"worker",task:"work"},ctx);
  expect(getChild(reason,result.details.run.id)).toBeTruthy();
  await teardownAllAsync(); await vi.waitFor(()=>expect(sent).toHaveLength(1));
  expect(sent[0][0].details).toMatchObject({status:"cancelled",output:"Session shutdown cancelled this run."});
  expect(sent[0][1]).toMatchObject({triggerTurn:false,deliverAs:"nextTurn"});
});
it("pi's real message method queues shutdown for nextTurn instead of invoking its model-turn path", async () => {
  let modelTurnRequests = 0;
  const boundary = { _pendingNextTurnMessages: [] as any[], isStreaming: false,
    _runAgentPrompt: async () => { modelTurnRequests++; } };
  const dispatch = (message: any, options: any) => AgentSession.prototype.sendCustomMessage.call(boundary as any, message, options);
  // This is the pre-fix shutdown option while the old runner is still valid.
  await dispatch({customType:"probe",content:"old shutdown",display:false}, {triggerTurn:true});
  expect(modelTurnRequests).toBe(1);
  const deliveries: Promise<void>[] = [];
  makeAsyncNotifier({pi:{sendMessage:(message:any,options:any)=>deliveries.push(dispatch(message,options))}})(
    {id:"fixture",agent:"worker"}, "cancelled", "Session shutdown cancelled this run.");
  await Promise.all(deliveries);
  expect(modelTurnRequests).toBe(1);
  expect(boundary._pendingNextTurnMessages).toHaveLength(1);
  expect(boundary._pendingNextTurnMessages[0].details.status).toBe("cancelled");
});
it("a throwing owned kill reports failure instead of claiming success", async () => {
  const db=freshDb();dbs.push(db);const ctx={db,sessionId:"throws",cwd:testScratchPath("cwd"),runDbPath:"fixture.db"};
  const result=await makeRunHandler({spawner:()=>({wait:()=>new Promise(()=>{}),detach(){},kill(){throw new Error("permission denied")}})})({agent:"worker",task:"work"},ctx);
  const killed=await makeKillHandler()({id:result.details.run.id},ctx);
  expect(killed.isError).toBe(true); expect(killed.content).toMatch(/permission denied/);
});
