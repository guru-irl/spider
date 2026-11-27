import { execFileSync } from "node:child_process";
import { delimiter, dirname, join, relative, isAbsolute, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { mapWorkspace } from "@spider/db-core/roam/repo-map";
import { discoverOrdinarySource } from "./ordinary-source";
import { parseLocationStores, recordLocation } from "@spider/db-core/roam/catalog";
import { localEntries, readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { inspectSession } from "../session-file";
import { seedSession, enableMemoryCapture } from "@spider/db-core/roam/seed";
import { createStorePort } from "../stores";
import { parsePlacement, object, text } from "./journal";
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
import type { MovingHome, RelocateAdapterOptions, RelocateHome, RunningHome, SessionId, SessionOwner, SessionPlacement, SessionMachinePorts, SupervisorEntry, V0Result, RelocatePlan } from "./types";
import { refusal } from "./remote";
import { insideDirectory, isPiTitle, localDescendants, locklessPiInCheckout, type SessionProcess } from "./local-process";
import { localWriterBlockers } from "./local-writers";

type LocalTerminal = { terminal: string; state: "live" | "finished"; pid: number | null; owned?: true };
export interface LocalIO {
  inspect(sessionId: string): Promise<IdLockObservation | null>;
  probe(pid: number): Promise<{kind:"absent"}|{kind:"unknown"}|{kind:"live";startIdentity:string;pi:boolean}>;
  claimFree(sessionId: string): Promise<void>;
  descendants(pid: number): Promise<readonly SessionProcess[]>;
  writerBlockers(sessionId: SessionId, placement?: SessionPlacement, requireCheckout?: boolean): Promise<readonly string[]>;
  signal(pid: number): Promise<void>;
  shutdown(operation: Operation): Promise<boolean>;
  pause(ms: number): Promise<void>;
  terminals(sessionId: string): Promise<readonly LocalTerminal[]>;
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
    return {kind:"live",startIdentity,pi:isPiTitle(comm)};
  } catch { return {kind:"unknown"}; }
}
/** HC selection is local. No inherited terminal, remote target, or lease survives. */
export function localLaunchEnvironment(env: Readonly<NodeJS.ProcessEnv> = process.env): NodeJS.ProcessEnv {
  const clean = safeLaunchEnvironment(env);
  for (const key of Object.keys(clean)) if (/^(HC_|PI_|SPIDER_)/.test(key) || key === "NODE_OPTIONS") delete clean[key];
  clean.PI_SUBAGENT_CHILD = "0";
  clean.HC_SESSION = "default";
  clean.HC_SOCKET = selectedSocket(clean);
  clean.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR ?? join(homedir(),".pi","agent");
  clean.PATH = [dirname(process.execPath),env.PATH ?? ""].filter(Boolean).join(delimiter);
  return clean;
}
export function createLocalIO(options: RelocateAdapterOptions): LocalIO {
  const lockRoot = join(options.root,"herdr");
  const env = {...localLaunchEnvironment(),SPIDER_GLOBAL_ROOT:options.root};
  const binary = process.env.SPIDER_ROAM_HC ?? "hc";
  const pi = resolveParticipantPi(process.env);
  const hc = createLocalExactHc({
    coreId: async signal => (await observeCoreIdentity(binary,env,{signal})).coreId,
    invoke:(argv,signal)=>invokeCli(binary,argv,env,options.limits.replyBytes,undefined,{signal}),
    invokeTracked:(argv,launchEnv)=>invokeCli(binary,argv,launchEnv,options.limits.replyBytes,undefined,{timeoutMs:options.limits.launchMs}),
  });
  return {
    inspect:id=>inspectIdLock(lockRoot,id),probe:probeLocalProcess,
    descendants:localDescendants,
    async writerBlockers(id, placement, requireCheckout) {
      const saved = placement ? undefined : readLocal<unknown>(options.globalDb,"relocate-managed",id);
      const known = placement ?? (saved === undefined ? undefined : parsePlacement(saved));
      const row = known ? undefined : options.globalDb.prepare("SELECT cwd,stores_json FROM roam_locations WHERE session_id=?").get(id) as {cwd:string|null;stores_json:string} | undefined;
      const cwd = known?.cwd ?? row?.cwd;
      if (!cwd && options.config.role === "hub") {
        const source = await discoverOrdinarySource(id,options);
        if (source.ok) return [...await locklessPiInCheckout(source.value.root), ...await localWriterBlockers(id,source.value.root,source.value.placement.stores,options)];
        if (requireCheckout) throw new Error("The ordinary checkout could not be verified");
      }
      if (!cwd) {
        if (requireCheckout || known || row) throw new Error("The session has no verifiable checkout");
        return []; // No local copy yet, such as before its first install.
      }
      const root = (await options.git.run(cwd,["git","rev-parse","--show-toplevel"])).toString().trim();
      if (!isAbsolute(root)) throw new Error("The session checkout could not be verified");
      const checkout = await realpath(root);
      if (!insideDirectory(checkout,await realpath(cwd))) throw new Error("The working directory is outside the checkout");
      const stores = known?.stores ?? (row ? parseLocationStores(JSON.parse(row.stores_json)) : []);
      return [...await locklessPiInCheckout(checkout), ...await localWriterBlockers(id,checkout,stores,options)];
    },
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
      return (await Promise.all(reply.terminals.map(async (value: unknown) => {
        if (!value || typeof value !== "object") throw new Error("Invalid terminal");
        const row = value as Record<string,unknown>;
        // Native peer addresses are qualified; their processes are not local.
        if (typeof row.address === "string" && row.address.includes("/")) return null;
        const signaled = Number.isSafeInteger(row.signal) && (row.signal as number) > 0;
        if (typeof row.address !== "string" || !row.address || !["live","finished"].includes(row.state as string) || row.state === "finished" && (row.reason !== "exited" || !(Number.isSafeInteger(row.exit_code) || signaled))) throw new Error("Unknown terminal state");
        let pid: unknown = row.pid ?? row.process_id ?? null;
        let labels: unknown = row.labels;
        if (row.state === "live" && pid === null) {
          const detail = await invokeCli(binary,["get",row.address,"--json"],env,options.limits.replyBytes,undefined,{timeoutMs:options.limits.controlMs});
          if (!detail || typeof detail !== "object" || !("address" in detail) || detail.address !== row.address || !("state" in detail) || detail.state !== "live" || !("pid" in detail)) throw new Error("Terminal identity changed");
          pid = detail.pid;
          if ("labels" in detail) labels = detail.labels;
        }
        if (pid !== null && (!Number.isSafeInteger(pid) || (pid as number) <= 0)) throw new Error("Unknown terminal process");
        const terminal: LocalTerminal = {terminal:row.address,state:row.state as "live"|"finished",pid:pid as number|null};
        if (row.state === "live" && labels && typeof labels === "object") {
          const tags = labels as Record<string,unknown>;
          if (tags["spider.kind"] === "session" && tags["spider.session"] === id && tags["spider.machine"] === options.config.machineId &&
              typeof tags["spider.roam.epoch"] === "string" && /^[1-9]\d*$/.test(tags["spider.roam.epoch"])) terminal.owned = true;
        }
        return terminal;
      }))).filter(terminal => terminal !== null);
    },
    async launch({home,placement}) {
      if (!pi) throw new Error("Pi executable unavailable");
      const core = await observeCoreIdentity(binary,env,{timeoutMs:options.limits.controlMs});
      const launchEnv: NodeJS.ProcessEnv = {...env,HC_SESSION:core.sessionNamespace,HC_SOCKET:core.socket};
      const request: PiSpawnRequest = {sessionId:home.sessionId as unknown as HerdrSessionId,sessionFile:placement.file,cwd:placement.cwd,environment:{agentDirectory:launchEnv.PI_CODING_AGENT_DIR!,extensionArguments:[]},argv:[pi,"--session",placement.file],env:launchEnv,terminal:{background:true,noNotify:true,outliveParent:true,parent:null,labels:{"spider.kind":"session","spider.session":home.sessionId,"spider.machine":home.machineId,"spider.roam.epoch":String(home.epoch)}}};
      return hc.run(request,{started(){},exited(){}});
    },
  };
}

function busy<T>(blockers: readonly string[]): V0Result<T> {
  const list = [...new Set(blockers)], shown = list.slice(0,12);
  return refusal("session-busy",`Local session processes or jobs are still present: ${shown.join(", ")}${list.length > shown.length ? `, and ${list.length-shown.length} more` : ""}.`,"Close these, then rerun relocate.");
}
const processName = (p: SessionProcess): string => `PID ${p.pid} (${p.command.replace(/[\u0000-\u001f\u007f]/g,"?").slice(0,96)})`;
const terminalName = (t: LocalTerminal): string => t.pid === null ? `terminal ${t.terminal} (PID unavailable)` : `PID ${t.pid} (pi)`;

/** A free lock alone cannot clear an ordinary pi or a detached Spider job. */
export async function stopLocalSession(sessionId: SessionId, moving: MovingHome | null, io: LocalIO, clock: Clock, timeoutMs: number): Promise<V0Result<void>> {
  try {
    const deadline = clock.now() + timeoutMs;
    const observed = await io.inspect(sessionId);
    if (observed) {
      const {pid,startIdentity} = observed.identity;
      const root = {pid,startIdentity,command:"pi"};
      const p = await io.probe(pid);
      if (p.kind === "unknown" || p.kind === "live" && (p.startIdentity !== startIdentity || !p.pi)) return busy([processName(root)]);
      if (p.kind === "live") {
        if (!(await io.terminals(sessionId)).some(t=>t.state === "live" && t.owned && t.pid === pid)) return busy([processName(root)]);
        const children = await io.descendants(pid);
        const current = await io.inspect(sessionId), rechecked = await io.probe(pid);
        if (!sameOwner(current,observed) || rechecked.kind !== "live" || !rechecked.pi || rechecked.startIdentity !== startIdentity) return busy([processName(root)]);
        for (const child of children) {
          const member = await io.probe(child.pid);
          if (member.kind === "unknown") return busy([processName(child)]);
          if (member.kind === "live" && member.startIdentity === child.startIdentity) await io.signal(child.pid);
        }
        const shutdown = moving && await io.shutdown({id:`${moving.moveId}-shutdown`,machineId:moving.machineId,expectedEpoch:moving.epoch,kind:"session-shutdown",args:{sessionId,moveId:moving.moveId,v0:true}});
        if (!shutdown) {
          const owner = await io.probe(pid);
          if (owner.kind !== "absent") {
            if (!sameOwner(await io.inspect(sessionId),observed) || owner.kind !== "live" || !owner.pi || owner.startIdentity !== startIdentity) return busy([processName(root)]);
            await io.signal(pid);
          }
        }
        for (;;) {
          const held = await io.inspect(sessionId);
          if (held && !sameOwner(held,observed)) return busy([`PID ${held.identity.pid} (pi)`]);
          const alive: string[] = [];
          for (const member of [root,...children]) {
            const state = await io.probe(member.pid);
            if (state.kind === "unknown" || state.kind === "live" && state.startIdentity === member.startIdentity) alive.push(processName(member));
          }
          if (!alive.length) break;
          if (clock.now() >= deadline) return busy(alive);
          await io.pause(Math.min(100,Math.max(1,deadline-clock.now())));
        }
      }
    }
    // claimIdLock handles dead owners and stale records; never unlink a lock.
    await io.claimFree(sessionId);
    const live = (await io.terminals(sessionId)).filter(t=>t.state === "live");
    if (live.length) return busy(live.map(terminalName));
    const blockers = await io.writerBlockers(sessionId,undefined,moving !== null);
    if (blockers.length) return busy(blockers);
    const held = await io.inspect(sessionId);
    if (held) return busy([`PID ${held.identity.pid} (pi)`]);
    return {ok:true,value:undefined};
  } catch { return refusal("stop-timeout","The local session or its jobs could not be checked safely.","Close the local pi session and its jobs, then rerun relocate."); }
}
export const digestIdentity = (value: string): string => createHash("sha256").update(value).digest("hex");
function repoMap(options: RelocateAdapterOptions, key: string): {path:string;worktree_command_json:string|null} | undefined {
  return options.globalDb.prepare("SELECT path,worktree_command_json FROM roam_repo_maps WHERE repo_key=?").get(key) as {path:string;worktree_command_json:string|null}|undefined;
}
async function normalRepository(root: string, options: RelocateAdapterOptions): Promise<void> {
  if (options.git.worktreeCommand !== null) throw new Error("Configured worktree command is unsupported");
  let sparse = "";
  try { sparse = (await options.git.run(root,["git","config","--bool","core.sparseCheckout"])).toString().trim(); }
  catch (error) { if ((error as {status?:number}).status !== 1 && (error as {code?:number}).code !== 1) throw error; }
  if (sparse === "true") throw new Error("Sparse checkout is unsupported");
  const files = await options.git.run(root,["git","ls-files","-z"]);
  if (files.length) for (const cached of [false,true]) {
    const attrs = await options.git.run(root,["git","check-attr",...(cached?["--cached"]:[]),"-z","--stdin","filter"],{stdin:files});
    const fields = attrs.toString().split("\0");
    for (let i=2;i<fields.length;i+=3) if (fields[i] === "lfs") throw new Error("LFS is unsupported");
  }
}
export interface LocalSource {placement:SessionPlacement;epoch:number;state:"active"|"frozen";root:string;relativeCwd:string;head:string}
export async function inspectLocalSource(id: SessionId, options: RelocateAdapterOptions, allowStopped = false): Promise<V0Result<LocalSource>> {
  try {
    const row = options.globalDb.prepare("SELECT stores_json,home_json,file,cwd FROM roam_locations WHERE session_id=?").get(id) as {stores_json:string;home_json:string|null;file:string|null;cwd:string|null}|undefined;
    if (!row) {
      const ordinary = await discoverOrdinarySource(id, options);
      if (ordinary.ok) await normalRepository(ordinary.value.root, options);
      return ordinary;
    }
    const keys = parseLocationStores(JSON.parse(row.stores_json)), worktrees = keys.filter(key=>key.startsWith("worktree:"));
    if (worktrees.length !== 1) return refusal("ambiguous-session","The session has more than one working checkout.");
    const key = worktrees[0], rest = key.slice(9), at = rest.lastIndexOf(":"), repoKey = rest.slice(0,at), workspaceId = rest.slice(at+1);
    const map = repoMap(options,repoKey);
    if (!map) return refusal("repo-unmapped","The source repository has no local mapping.","Run spider roam repo map for the session repository, then retry.");
    if (map.worktree_command_json !== null) return refusal("unsupported-workspace","Configured worktree commands are not supported by v0.");
    if (!row.file || !row.cwd || !isAbsolute(row.file) || !isAbsolute(row.cwd)) return refusal("session-not-found","The local transcript and working directory are missing.");
    if (row.home_json !== null) { const home = object(JSON.parse(row.home_json)); if (home.machineId !== options.config.machineId) return refusal("home-conflict","This location is not owned by the local source."); }
    const fileStat = await lstat(row.file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || await realpath(row.file) !== row.file) return refusal("session-not-found","The local transcript path is not a regular canonical file.");
    const stores = createStorePort(options.config,options.globalDb);
    let epoch: number, state:"active"|"frozen";
    try {
      const db = stores.openStore(key).db;
      const membership = db.prepare("SELECT epoch,state FROM roam_sessions WHERE session_id=?").get(id) as {epoch:number;state:string}|undefined;
      const meta = db.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as {machine_id:string};
      if (!membership || meta.machine_id !== options.config.machineId || !Number.isSafeInteger(membership.epoch) || membership.epoch<1 || membership.state !== "active" && !(allowStopped && membership.state === "frozen")) return refusal("home-conflict","The source is not an ordinary active local member.");
      epoch = membership.epoch; state = membership.state as "active"|"frozen";
    } finally {stores.close();}
    const root = await realpath((await options.git.run(row.cwd,["git","rev-parse","--show-toplevel"])).toString().trim());
    const relativeCwd = relative(root,await realpath(row.cwd));
    if (isAbsolute(relativeCwd) || relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`)) return refusal("unsupported-workspace","The session cwd is outside its working checkout.");
    await normalRepository(root,options);
    const head = (await options.git.run(root,["git","rev-parse","--verify","HEAD^{commit}"])).toString().trim();
    const knownHome = row.home_json ? object(JSON.parse(row.home_json)) : null;
    const knownPlacement = readLocal<unknown>(options.globalDb,"relocate-managed",id);
    const historyMachine = knownPlacement ? parsePlacement(knownPlacement).historyMachine : typeof knownHome?.historyMachine === "string" ? knownHome.historyMachine : options.config.machineId;
    const placement = parsePlacement({sessionId:id,machineId:options.config.machineId,repoKey,workspaceId,repository:map.path,cwd:row.cwd,file:row.file,stores:[...new Set(["global",`repo:${repoKey}`,...keys])],historyMachine});
    return {ok:true,value:{placement,epoch,state,root,relativeCwd,head}};
  } catch { return refusal("unsupported-workspace","The source checkout or membership could not be inspected safely."); }
}
export async function inspectLocalDestination(source: SessionPlacement, relativeCwd: string, options: RelocateAdapterOptions): Promise<V0Result<{placement:SessionPlacement;head:string}>> {
  try {
    parsePlacement(source);
    if (isAbsolute(relativeCwd) || relativeCwd.split(/[\\/]/).includes("..")) return refusal("invalid-arguments","The relative session cwd is invalid.");
    const map = repoMap(options,source.repoKey);
    if (!map) return refusal("repo-unmapped","The destination repository has no local mapping.","Run spider roam repo map for the session repository on the destination, then retry.");
    if (map.worktree_command_json !== null) return refusal("unsupported-workspace","Configured worktree commands are not supported by v0.");
    await normalRepository(map.path,options);
    const mapped = options.globalDb.prepare("SELECT path FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").get(source.repoKey,source.workspaceId) as {path:string}|undefined;
    const checkout = mapped?.path ?? join(options.root,"roam","checkouts","v0",digestIdentity(source.repoKey),digestIdentity(source.workspaceId));
    if (mapped) await normalRepository(mapped.path,options);
    const existing = options.globalDb.prepare("SELECT file FROM roam_locations WHERE session_id=?").get(source.sessionId) as {file:string|null}|undefined;
    let file = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(),".pi","agent"),"sessions","roaming",`${digestIdentity(source.sessionId)}.jsonl`);
    if (existing?.file && isAbsolute(existing.file)) {
      const info = await lstat(existing.file).catch(()=>null);
      if (info?.isFile() && !info.isSymbolicLink() && await realpath(existing.file) === existing.file) file=existing.file;
    }
    const head = (await options.git.run(map.path,["git","rev-parse","--verify","HEAD^{commit}"])).toString().trim();
    const placement = parsePlacement({...source,machineId:options.config.machineId,repository:map.path,cwd:join(checkout,relativeCwd),file});
    return {ok:true,value:{placement,head}};
  } catch {return refusal("unsupported-workspace","The destination is not a supported normal checkout.");}
}
export async function seedLocalPlacement(placement: SessionPlacement, epoch: number, options: RelocateAdapterOptions): Promise<void> {
  const stores = createStorePort(options.config,options.globalDb);
  try {
    for (const key of placement.stores) {
      const db=stores.openStore(key).db;
      if (key.startsWith("worktree:")) { while (!seedSession(db,placement.sessionId,epoch,key,options.limits.hardBatchBytes).complete) { /* bounded seed chunks */ } }
      else enableMemoryCapture(db,key);
    }
  } finally {stores.close();}
}
export async function captureOrdinarySource(plan: RelocatePlan, options: RelocateAdapterOptions): Promise<void> {
  if (options.globalDb.prepare("SELECT 1 FROM roam_locations WHERE session_id=?").get(plan.source.sessionId)) return;
  const home = await options.homes.read(plan.source.sessionId);
  if (!home || home.state !== "moving" || home.machineId !== options.config.machineId || home.moveId !== plan.moveId || home.epoch !== plan.source.epoch + 1 || home.destination !== plan.destinationPlacement.machineId) throw new Error("Ordinary capture requires the moving home");
  const ready = await inspectLocalSource(plan.source.sessionId, options);
  if (!ready.ok || !isDeepStrictEqual(ready.value.placement, plan.sourcePlacement)) throw new Error("Ordinary source changed before capture");
  await mapWorkspace(options.globalDb, { repoKey: plan.sourcePlacement.repoKey, workspaceId: plan.sourcePlacement.workspaceId, path: ready.value.root });
  await seedLocalPlacement(plan.sourcePlacement, plan.source.epoch, options);
  recordLocation(options.globalDb, { sessionId: plan.source.sessionId, stores: plan.sourcePlacement.stores, home: { sessionId: plan.source.sessionId, machineId: plan.source.machineId, epoch: plan.source.epoch, moveId: null, updatedAt: plan.source.updatedAt }, file: plan.sourcePlacement.file, cwd: plan.sourcePlacement.cwd });
}
export interface LocalRuntime extends SessionMachinePorts {
  owner(id: SessionId, placement?: SessionPlacement): Promise<SessionOwner>;
  stop(id: SessionId, moving?: MovingHome | null): Promise<V0Result<void>>;
  entries(): Promise<readonly SupervisorEntry[]>;
}
export function createLocalRuntime(options: RelocateAdapterOptions, io: LocalIO = createLocalIO(options)): LocalRuntime {
  async function inspectOwner(id: SessionId, placement?: SessionPlacement): Promise<{owner:SessionOwner;blockers?:readonly string[]}> {
    try {
      const lock = await io.inspect(id), terminals = await io.terminals(id), live = terminals.filter(t=>t.state === "live");
      if (lock) {
        const p = await io.probe(lock.identity.pid);
        if (p.kind !== "absent") {
          if (p.kind !== "live" || !p.pi || p.startIdentity !== lock.identity.startIdentity || !sameOwner(await io.inspect(id),lock)) return {owner:{kind:"unknown"}};
          const terminal = live.find(t=>t.pid === lock.identity.pid);
          return {owner:{kind:"live",pid:lock.identity.pid,terminal:terminal?.terminal ?? null}};
        }
        await io.claimFree(id);
      }
      if (live.length) return {owner:{kind:"unknown"}};
      const blockers = await io.writerBlockers(id,placement);
      if (blockers.length) return {owner:{kind:"unknown"},blockers};
      return {owner:await io.inspect(id) ? {kind:"unknown"} : {kind:"free"}};
    } catch { return {owner:{kind:"unknown"}}; }
  }
  async function owner(id: SessionId, placement?: SessionPlacement): Promise<SessionOwner> { return (await inspectOwner(id,placement)).owner; }
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
      const {owner:current,blockers} = await inspectOwner(home.sessionId,placement);
      if (blockers) return busy(blockers);
      if (current.kind === "live") return current.terminal ? {ok:true,value:{terminal:current.terminal}} : refusal("start-pending","The running pi terminal cannot be located.");
      if (current.kind !== "free") return refusal("start-pending","A session owner or pending terminal is still present.");
      // Reread immediately before the only spawn call.
      if (!await runnable(home,placement)) return refusal("start-pending","The home changed before launch.");
      const launched = await io.launch({home,placement});
      return {ok:true,value:launched};
    }); } catch { return refusal("start-pending","The launch reply is pending; retry without starting another copy."); }
  }
  async function locate(machineId: string,id: SessionId): Promise<V0Result<SessionPlacement>> {
    if (machineId !== options.config.machineId) return refusal("machine-not-found","The requested placement is not local.");
    try {
      const known = readLocal<unknown>(options.globalDb,"relocate-managed",id);
      let placement: SessionPlacement;
      if (known) placement=parsePlacement(known);
      else { const source=await inspectLocalSource(id,options,true);if(!source.ok)return source;placement=source.value.placement; }
      if (placement.machineId !== machineId || placement.sessionId !== id) return refusal("destination-copy-missing","The local copy has a different identity.");
      const session=await inspectSession(placement.file,id,undefined,options.limits);
      if (session.cwd !== placement.cwd) return refusal("destination-copy-missing","The local transcript cwd no longer matches its recorded copy.");
      return {ok:true,value:placement};
    } catch {return refusal("destination-copy-missing","The destination has no verified local session copy.");}
  }
  async function publishHome(home: RelocateHome,machineId: string): Promise<V0Result<void>> {
    try { return machineId === options.config.machineId && exactHome(await options.homes.read(home.sessionId),home) ? {ok:true,value:undefined} : refusal("sync-failed","The exact home is not present on the local machine."); }
    catch {return refusal("sync-failed","The local home cannot be read back.");}
  }
  async function activate(home: RunningHome,placement: SessionPlacement): Promise<V0Result<void>> {
    try { return await withProcessLock(join(options.root,"herdr"),`v0-state:${home.sessionId}`,async()=>{
      parsePlacement(placement);
      const current=await options.homes.read(home.sessionId);
      const allowed=exactHome(current,home) || current?.state === "moving" && current.moveId === home.moveId && current.epoch+1 === home.epoch && (current.machineId === home.machineId || current.destination === home.machineId) || current?.state === "stopped" && current.machineId === home.machineId && current.epoch+1 === home.epoch;
      if (!allowed || home.state !== "running" || home.destination !== null || home.machineId !== options.config.machineId || placement.machineId !== home.machineId || home.sessionId !== placement.sessionId) return refusal("home-conflict","The home does not authorize this local activation.");
      const stores=createStorePort(options.config,options.globalDb);
      try { for(const key of placement.stores) if(key.startsWith("worktree:")) {
        const db=stores.openStore(key).db;
        const old=db.prepare("SELECT epoch FROM roam_sessions WHERE session_id=?").get(home.sessionId) as {epoch:number}|undefined;
        if(old && old.epoch>home.epoch) return refusal("home-conflict","The local membership has a newer epoch.");
        db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,?,'active') ON CONFLICT(session_id) DO UPDATE SET epoch=excluded.epoch,state='active'").run(home.sessionId,home.epoch);
      }} finally {stores.close();}
      await seedLocalPlacement(placement,home.epoch,options);
      writeLocal(options.globalDb,"relocate-managed",home.sessionId,placement);
      recordLocation(options.globalDb,{sessionId:home.sessionId,stores:placement.stores,home,file:placement.file,cwd:placement.cwd});
      return {ok:true,value:undefined};
    }); } catch {return refusal("install-failed","Local capture membership could not be activated.");}
  }
  async function stop(id: SessionId,moving: MovingHome|null=null): Promise<V0Result<void>> {
    try { return await withProcessLock(join(options.root,"herdr"),`v0-state:${id}`,async()=>{
      if(moving && !exactHome(await options.homes.read(id),moving))return refusal("home-conflict","The source moving home changed before shutdown.");
      const stopped=await stopLocalSession(id,moving,io,options.clock,options.limits.readyMs);if(!stopped.ok)return stopped;
      const known=readLocal<unknown>(options.globalDb,"relocate-managed",id);
      const row=options.globalDb.prepare("SELECT stores_json FROM roam_locations WHERE session_id=?").get(id) as {stores_json:string}|undefined;
      const keys=known?parsePlacement(known).stores:row?parseLocationStores(JSON.parse(row.stores_json)):[];
      const stores=createStorePort(options.config,options.globalDb);
      try {for(const key of keys)if(key.startsWith("worktree:"))stores.openStore(key).db.prepare("UPDATE roam_sessions SET state='frozen' WHERE session_id=? AND state='active'").run(id);}
      finally {stores.close();}
      return stopped;
    }); }catch{return refusal("stop-timeout","The stopped source membership could not be frozen.");}
  }
  async function entries(): Promise<readonly SupervisorEntry[]> {
    const homes=await options.homes.list(), byId=new Map(homes.map(home=>[home.sessionId,home]));
    const placements=new Map(localEntries<unknown>(options.globalDb,"relocate-managed").map(row=>[row.key as SessionId,parsePlacement(row.value)]));
    const ids=new Set([...placements.keys(),...homes.filter(home=>home.machineId===options.config.machineId || home.state === "moving" && home.destination===options.config.machineId).map(home=>home.sessionId)]);
    const result: SupervisorEntry[]=[];
    for(const sessionId of ids) {
      let placement=placements.get(sessionId)??null;
      if(!placement) { const found=await locate(options.config.machineId,sessionId);if(found.ok)placement=found.value; }
      result.push({sessionId,home:byId.get(sessionId)??null,placement});
    }
    return result;
  }
  return {owner,start,confirm,stop,locate,publishHome,activate,entries};
}
export function createLocalSessionMachinePorts(options: RelocateAdapterOptions): SessionMachinePorts {
  const local=createLocalRuntime(options);
  return {locate:local.locate,publishHome:local.publishHome,activate:local.activate,start:local.start,confirm:local.confirm};
}
