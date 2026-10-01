import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { openDbAt } from "@spider/db-core";
import { freshDb } from "./helpers/testutil";
import { makeChildReporter } from "../child-reporter";
import { RunStore } from "../run-store";
it("claims a legacy null-pid row before writing or finalizing", () => {
  const db=freshDb();try {
    const store=new RunStore(db);const {id}=store.create({sessionId:"owner",agent:"worker"});store.start(id);
    const rep=makeChildReporter(db,{runId:id,sessionId:"owner"});
    expect(store.get(id)?.pid).toBe(process.pid);
    expect(store.get(id)?.pid_start_time).toEqual(expect.any(String));
    rep.onMessage("real child report");rep.onShutdown("done");
    expect(store.get(id)).toMatchObject({status:"done",result:"real child report"});
  } finally {db.close()}
});
it("a reporter disables itself permanently when pid ownership changes", () => {
  const db=freshDb();try {
    const store=new RunStore(db);const {id}=store.create({sessionId:"owner",agent:"worker"});store.start(id);
    store.setPid(id,process.pid,process.pid); const rep=makeChildReporter(db,{runId:id,sessionId:"owner"});
    db.prepare("UPDATE runs SET pid=? WHERE id=?").run(process.pid+100000,id);
    rep.onTurn(9); // Must disable even if a subsequent event sees our pid restored.
    db.prepare("UPDATE runs SET pid=? WHERE id=?").run(process.pid,id);
    rep.onToolStart("write");rep.onToolEnd("write");rep.onModel("foreign/model");rep.onStatus("done");rep.onMessage("foreign report");rep.onShutdown("done","foreign result");
    expect(store.get(id)).toMatchObject({status:"running",model:null,step_count:0});
    expect(db.prepare("SELECT id FROM run_events WHERE run_id=?").all(id)).toEqual([]);
  } finally {db.close()}
});
it("foreign terminal shutdown also permanently disables the reporter", () => {
  const db = freshDb(); try {
    const store = new RunStore(db); const {id} = store.create({sessionId:"owner",agent:"worker"}); store.start(id);
    const rep = makeChildReporter(db,{runId:id,sessionId:"owner"});
    db.prepare("UPDATE runs SET status='done',pid=? WHERE id=?").run(process.pid+100000,id);
    rep.onShutdown("done");
    db.prepare("UPDATE runs SET status='running',pid=? WHERE id=?").run(process.pid,id);
    rep.onMessage("foreign report"); rep.onShutdown("done","foreign result");
    expect(store.get(id)?.status).toBe("running");
    expect(db.prepare("SELECT id FROM run_events WHERE run_id=?").all(id)).toEqual([]);
  } finally {db.close()}
});
it("claims rows on legacy tables without the optional start-time column", () => {
  const db=freshDb();try {
    db.exec("ALTER TABLE runs DROP COLUMN pid_start_time");
    const store=new RunStore(db);const {id}=store.create({sessionId:"owner",agent:"worker"});store.start(id);
    const rep=makeChildReporter(db,{runId:id,sessionId:"owner"});
    expect(store.get(id)?.pid).toBe(process.pid);
    rep.onMessage("legacy report");rep.onShutdown("done");
    expect(store.get(id)).toMatchObject({status:"done",result:"legacy report"});
  } finally {db.close()}
});
it("a real grandchild inheriting identity cannot write or finalize the child's run", () => {
  const scratch=resolve(".spider/scratch/reporter-round4");mkdirSync(scratch,{recursive:true});const root=mkdtempSync(join(scratch,"case-"));
  const dbPath=join(root,"fixture.db"), entry=join(root,"child.mjs");
  const db=openDbAt(dbPath,"worktree"); const store=new RunStore(db);const {id}=store.create({sessionId:"owner",agent:"worker"});store.start(id);
  // A real child claims the legacy row before spawning a second node process
  // with the same env. The grandchild loads the very same reporter code.
  const source=`import {spawnSync} from 'node:child_process'; import {openDbAt} from '@spider/db-core'; import {makeChildReporter} from ${JSON.stringify(resolve("packages/subagents/src/child-reporter.ts"))};
    const db=openDbAt(process.env.PI_SPIDER_DB_PATH!, 'worktree'); const id=process.env.PI_SUBAGENT_RUN_ID!;
    const rep=makeChildReporter(db,{runId:id,sessionId:'owner'});
    if(process.argv[2]==='grandchild') { rep.onTurn(99);rep.onModel('foreign/model');rep.onMessage('foreign report');rep.onShutdown('done','foreign result'); db.close(); }
    else {
      const claimed=db.prepare('SELECT pid FROM runs WHERE id=?').get(id) as any;
      if(claimed.pid!==process.pid) throw new Error('child failed to claim its run');
      const grand=spawnSync(process.execPath,[process.argv[1],'grandchild'],{cwd:process.cwd(),env:process.env,encoding:'utf8'});
      if(grand.status!==0) throw new Error(grand.stderr);
      const after=db.prepare('SELECT status,model,step_count FROM runs WHERE id=?').get(id) as any;
      const count=(db.prepare('SELECT COUNT(*) AS n FROM run_events WHERE run_id=?').get(id) as any).n;
      process.stdout.write(JSON.stringify({after,count,childPid:process.pid})+'\\n');
      if(after.status!=='running'||after.model!==null||after.step_count!==0||count!==0) throw new Error('grandchild wrote to parent run');
      rep.onMessage('real child report');rep.onShutdown('done');db.close();
    }`;
  try {
    buildSync({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:"reporter-fixture.ts",loader:"ts"},bundle:true,platform:"node",format:"esm",banner:{js:"import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url);"},external:["better-sqlite3","sqlite-vec"],outfile:entry});
    const env={...process.env,PI_SUBAGENT_CHILD:"1",PI_SUBAGENT_RUN_ID:id,PI_SPIDER_DB_PATH:dbPath,PI_SPIDER_SESSION_ID:"owner"};
    const child=spawnSync(process.execPath,[entry],{cwd:root,env,encoding:"utf8",timeout:10000});
    expect(child.status,child.stderr).toBe(0);
    const observed=JSON.parse(child.stdout.trim());expect(observed.after.status).toBe("running");expect(observed.count).toBe(0);
    expect(store.get(id)).toMatchObject({pid:observed.childPid,status:"done",result:"real child report"});
  } finally {db.close();rmSync(root,{recursive:true,force:true})}
});
