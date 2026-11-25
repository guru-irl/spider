import { execFileSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { inspectIdLock, claimIdLock, localBootId, type IdLockObservation } from "@spider/herdr/sessions/id-lock";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";
import { safeLaunchEnvironment, type PiSpawnRequest } from "@spider/herdr/sessions/launcher";
import type { SessionId as HerdrSessionId } from "@spider/herdr/contracts";
import { invokeCli, observeCoreIdentity } from "@spider/herdr/client/hc";
import { selectedSocket } from "@spider/herdr/client/parse";
import type { Operation, Clock } from "../contracts";
import { createLocalExactHc, resolveParticipantPi } from "../launcher";
import { requestSessionControl } from "../session-socket";
import type { MovingHome, RelocateAdapterOptions, RelocateHome, RunningHome, SessionId, SessionOwner, SessionPlacement, V0Result } from "./types";
import { refusal } from "./remote";

export interface LocalIO {
  inspect(sessionId: string): Promise<IdLockObservation | null>;
  probe(pid: number): Promise<{kind:"absent"}|{kind:"unknown"}|{kind:"live";startIdentity:string;pi:boolean}>;
  claimFree(sessionId: string): Promise<void>;
  signal(pid: number): Promise<void>;
  shutdown(operation: Operation): Promise<boolean>;
  pause(ms: number): Promise<void>;
  terminals(sessionId: string): Promise<readonly {terminal:string;state:"live"|"finished";pid:number|null}[]>;
  launch(request: {home:RunningHome;placement:SessionPlacement}): Promise<{terminal:string}>;
}
export function exactHome(a: RelocateHome | null, b: RelocateHome): boolean {
  return !!a && a.sessionId === b.sessionId && a.machineId === b.machineId && a.epoch === b.epoch && a.state === b.state && a.destination === b.destination && a.moveId === b.moveId;
}
function sameOwner(a: IdLockObservation | null, b: IdLockObservation): boolean {
  return !!a && a.identity.pid === b.identity.pid && a.identity.startIdentity === b.identity.startIdentity && a.bootId === b.bootId && a.pendingOperationId === b.pendingOperationId;
}
export async function probeLocalProcess(pid: number): ReturnType<LocalIO["probe"]> {
  try {
    const startIdentity = processStartIdentity(pid);
    if (startIdentity === null) return {kind:"absent"};
    const comm = execFileSync("ps",["-p",String(pid),"-o","comm="],{encoding:"utf8",timeout:1000}).trim();
    const pi = comm === "pi" || /(?:^|[/\\])pi(?:\.exe)?$/.test(comm);
    return {kind:"live",startIdentity,pi};
  } catch { return {kind:"unknown"}; }
}
/** HC selection is local. No inherited terminal, remote target, or lease survives. */
export function localLaunchEnvironment(env: Readonly<NodeJS.ProcessEnv> = process.env): NodeJS.ProcessEnv {
  const clean = safeLaunchEnvironment(env);
  for (const key of Object.keys(clean)) if (key.startsWith("HC_")) delete clean[key];
  clean.HC_SESSION = "default";
  clean.HC_SOCKET = selectedSocket(clean);
  clean.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR ?? join(homedir(),".pi","agent");
  clean.PATH = [dirname(process.execPath),env.PATH ?? ""].filter(Boolean).join(delimiter);
  return clean;
}
export function createLocalIO(options: RelocateAdapterOptions): LocalIO {
  const lockRoot = join(options.root,"herdr");
  const env = localLaunchEnvironment();
  const binary = process.env.SPIDER_ROAM_HC ?? "hc";
  const pi = resolveParticipantPi(env);
  const hc = createLocalExactHc({
    coreId: async signal => (await observeCoreIdentity(binary,env,{signal})).coreId,
    invoke:(argv,signal)=>invokeCli(binary,argv,env,options.limits.replyBytes,undefined,{signal}),
    invokeTracked:(argv,launchEnv)=>invokeCli(binary,argv,launchEnv,options.limits.replyBytes,undefined,{timeoutMs:options.limits.launchMs}),
  });
  return {
    inspect:id=>inspectIdLock(lockRoot,id),probe:probeLocalProcess,
    async claimFree(id) {
      const startIdentity = processStartIdentity(process.pid);
      if (!startIdentity) throw new Error("Local process identity unavailable");
      const held = await claimIdLock(lockRoot,id,{pid:process.pid,startIdentity},probeLocalProcess,{bootId:localBootId});
      await held.release();
    },
    async signal(pid) { process.kill(pid,"SIGTERM"); },
    async shutdown(operation) { try { return (await requestSessionControl(join(options.root,"roam","s"),operation,{timeoutMs:options.limits.controlMs})).code === 0; } catch { return false; } },
    pause:ms=>delay(ms),
    async terminals(id) {
      const reply = await invokeCli(binary,["ls","--all","--json","--label",`spider.session=${id}`],env,options.limits.replyBytes,undefined,{timeoutMs:options.limits.controlMs});
      if (!reply || typeof reply !== "object" || !("terminals" in reply) || !Array.isArray(reply.terminals)) throw new Error("Terminal list unavailable");
      return reply.terminals.map((value: unknown) => {
        if (!value || typeof value !== "object") throw new Error("Invalid terminal");
        const row = value as Record<string,unknown>;
        if (typeof row.address !== "string" || !row.address || !["live","finished"].includes(row.state as string) || row.state === "finished" && (row.reason !== "exited" || !Number.isSafeInteger(row.exit_code))) throw new Error("Unknown terminal state");
        const pid = row.pid ?? row.process_id ?? null;
        if (pid !== null && (!Number.isSafeInteger(pid) || (pid as number) <= 0)) throw new Error("Unknown terminal process");
        return {terminal:row.address,state:row.state as "live"|"finished",pid:pid as number|null};
      });
    },
    async launch({home,placement}) {
      if (!pi) throw new Error("Pi executable unavailable");
      const core = await observeCoreIdentity(binary,env,{timeoutMs:options.limits.controlMs});
      const launchEnv = {...env,HC_SESSION:core.sessionNamespace,HC_SOCKET:core.socket};
      const request: PiSpawnRequest = {sessionId:home.sessionId as unknown as HerdrSessionId,sessionFile:placement.file,cwd:placement.cwd,environment:{agentDirectory:launchEnv.PI_CODING_AGENT_DIR!,extensionArguments:[]},argv:[pi,"--session",placement.file],env:launchEnv,terminal:{background:true,noNotify:true,outliveParent:true,parent:null,labels:{"spider.kind":"session","spider.session":home.sessionId,"spider.machine":home.machineId,"spider.roam.epoch":String(home.epoch)}}};
      return hc.run(request,{started(){},exited(){}});
    },
  };
}

/** Stop acknowledges only a free ID lock, never a terminal address or signal. */
export async function stopLocalSession(sessionId: SessionId, moving: MovingHome | null, io: LocalIO, clock: Clock, timeoutMs: number): Promise<V0Result<void>> {
  try {
    const deadline = clock.now() + timeoutMs;
    const observed = await io.inspect(sessionId);
    if (observed) {
      const p = await io.probe(observed.identity.pid);
      if (p.kind === "unknown" || p.kind === "live" && (p.startIdentity !== observed.identity.startIdentity || !p.pi)) return refusal("stop-timeout","The session lock owner cannot be verified.");
      let shutdown = false;
      if (moving && p.kind === "live") shutdown = await io.shutdown({id:`${moving.moveId}-shutdown`,machineId:moving.machineId,expectedEpoch:moving.epoch,kind:"session-shutdown",args:{sessionId,moveId:moving.moveId,v0:true}});
      else if (!moving && p.kind === "live") shutdown = await io.shutdown({id:`v0-stop-${sessionId}`,machineId:"",expectedEpoch:1,kind:"session-shutdown",args:{sessionId,moveId:`v0-stop-${sessionId}`,v0:true}});
      if (p.kind === "live" && !shutdown) {
        const current = await io.inspect(sessionId), rechecked = await io.probe(observed.identity.pid);
        if (!sameOwner(current,observed) || rechecked.kind !== "live" || !rechecked.pi || rechecked.startIdentity !== observed.identity.startIdentity) return refusal("stop-timeout","The session lock owner changed; no signal was sent.");
        await io.signal(observed.identity.pid);
      }
      for (;;) {
        const current = await io.inspect(sessionId), owner = await io.probe(observed.identity.pid);
        if (owner.kind === "unknown" || current && !sameOwner(current,observed)) return refusal("stop-timeout","The session lock owner is uncertain.");
        if (owner.kind === "absent") break;
        if (clock.now() >= deadline) return refusal("stop-timeout","The session did not exit before the stop deadline.");
        await io.pause(Math.min(100,Math.max(1,deadline-clock.now())));
      }
    }
    // claimIdLock handles dead owners and stale records; never unlink a lock.
    await io.claimFree(sessionId);
    if (await io.inspect(sessionId)) return refusal("stop-timeout","The session lock is not free.");
    if ((await io.terminals(sessionId)).some(t=>t.state === "live")) return refusal("stop-timeout","A session terminal is still live.");
    return {ok:true,value:undefined};
  } catch { return refusal("stop-timeout","The session could not be stopped safely."); }
}
export function createLocalRuntime(options: RelocateAdapterOptions, io: LocalIO = createLocalIO(options)) {
  async function owner(id: SessionId): Promise<SessionOwner> {
    try {
      const lock = await io.inspect(id), terminals = await io.terminals(id), live = terminals.filter(t=>t.state === "live");
      if (!lock) return live.length ? {kind:"unknown"} : {kind:"free"};
      const p = await io.probe(lock.identity.pid);
      if (p.kind === "absent") { await io.claimFree(id); return live.length ? {kind:"unknown"} : {kind:"free"}; }
      if (p.kind !== "live" || !p.pi || p.startIdentity !== lock.identity.startIdentity || !sameOwner(await io.inspect(id),lock)) return {kind:"unknown"};
      const terminal = live.find(t=>t.pid === lock.identity.pid);
      return {kind:"live",pid:lock.identity.pid,terminal:terminal?.terminal ?? null};
    } catch { return {kind:"unknown"}; }
  }
  async function runnable(home: RunningHome, placement: SessionPlacement): Promise<boolean> {
    return home.machineId === options.config.machineId && home.sessionId === placement.sessionId && placement.machineId === options.config.machineId && exactHome(await options.homes.read(home.sessionId),home);
  }
  async function confirm(home: RunningHome,placement: SessionPlacement): Promise<V0Result<{terminal:string}>> {
    try {
      if (!await runnable(home,placement)) return refusal("start-pending","The local running home changed.");
      const current = await owner(home.sessionId);
      return current.kind === "live" && current.terminal ? {ok:true,value:{terminal:current.terminal}} : refusal("start-pending","Pi has not claimed this session's ID lock.");
    } catch { return refusal("start-pending","The session owner cannot be confirmed."); }
  }
  async function start(home: RunningHome,placement: SessionPlacement): Promise<V0Result<{terminal:string}>> {
    try { return await withProcessLock(join(options.root,"herdr"),`v0-spawn:${home.sessionId}`,async()=>{
      if (!await runnable(home,placement)) return refusal("start-pending","The local running home does not authorize launch.");
      const current = await owner(home.sessionId);
      if (current.kind === "live") return current.terminal ? {ok:true,value:{terminal:current.terminal}} : refusal("start-pending","The running pi terminal cannot be located.");
      if (current.kind !== "free") return refusal("start-pending","A session owner or pending terminal is still present.");
      // Reread immediately before the only spawn call.
      if (!await runnable(home,placement)) return refusal("start-pending","The home changed before launch.");
      const launched = await io.launch({home,placement});
      return {ok:true,value:launched};
    }); } catch { return refusal("start-pending","The launch reply is pending; retry without starting another copy."); }
  }
  return {owner,start,confirm,stop:(id:SessionId,moving:MovingHome|null=null)=>stopLocalSession(id,moving,io,options.clock,options.limits.readyMs)};
}
