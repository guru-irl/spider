import { afterEach, expect, it, vi } from "vitest";
import { PolyglotExecutor } from "../executor";
afterEach(()=>vi.unstubAllEnvs());
it.each(["exec","exec_file","background"])("%s commands do not inherit the child's reporter identity", async mode=>{
  const keys=["PI_SUBAGENT_CHILD","PI_SUBAGENT_RUN_ID","PI_SUBAGENT_CHILD_AGENT","PI_SUBAGENT_CHILD_INDEX","PI_SPIDER_DB_PATH","PI_SPIDER_SESSION_ID","PI_INTERCOM_SESSION_ID","PI_INTERCOM_STABLE_ID","PI_SUBAGENT_INTERCOM_SESSION_NAME","PI_SUBAGENT_ORCHESTRATOR_TARGET","PI_SUBAGENT_ORCHESTRATOR_SESSION_ID","PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR","PI_INTERCOM_NAME_POLL_MS","PI_INTERCOM_SCOPE_ID"];
  keys.forEach((key,i)=>vi.stubEnv(key,i===0?"1":`fixture-${i}`));
  const ex=new PolyglotExecutor({projectRoot:process.cwd()});
  const code=`console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]??null]))));`;
  const args={language:"javascript" as const,code,timeout:10000};
  const result=mode==="exec_file"?await ex.executeFile({...args,path:"package.json"}):await ex.execute({...args,background:mode==="background"});
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual(Object.fromEntries(keys.map((k,i)=>[k,k==="PI_SUBAGENT_CHILD"?"1":k==="PI_INTERCOM_NAME_POLL_MS"||k==="PI_INTERCOM_SCOPE_ID"?`fixture-${i}`:null])));
});
