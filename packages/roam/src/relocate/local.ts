import { execFileSync } from "node:child_process";
import { basename, join, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstat, realpath, stat } from "node:fs/promises";
import { mapWorkspace } from "@spider/db-core/roam/repo-map";
import { discoverOrdinarySource } from "./ordinary-source";
import { parseLocationStores, recordLocation } from "@spider/db-core/roam/catalog";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { localRecordRows } from "./local-records";
import { openRoamStoreReadOnly } from "@spider/db-core/roam/reads";
import { inspectSession } from "../session-file";
import { seedSession, enableMemoryCapture } from "@spider/db-core/roam/seed";
import { createStorePort } from "../stores";
import { parsePlacement, object, text } from "./journal";
import { homedir } from "node:os";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import { inspectIdLock, claimIdLock, bootIdChanged, localBootId, type IdLockObservation } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";
import { safeLaunchEnvironment, type PiSpawnRequest } from "@spider/herdr/sessions/launcher";
import { HERDR_KINDS, type CoreIdentity, type SessionId as HerdrSessionId } from "@spider/herdr/contracts";
import { invokeCli, observeCoreIdentity } from "@spider/herdr/client/hc";
import { hubCoreSelection } from "../launchd";
import { loadHerdrConfig } from "../host-config";
import type { Operation, Clock } from "../contracts";
import { createLocalExactHc, resolveParticipantPi } from "../launcher";
import { decodeManagedHome, readManagedHome, sameManagedHome } from "./home";
import { createLocalStop, queueStopMode } from "./local-stop";
import type { StopMode, StopObservation } from "./session-stop-types";
import { requestSessionControl } from "../session-socket";
import type { MovingHome, RelocateAdapterOptions, RelocateHome, RunningHome, SessionId, SessionOwner, SessionPlacement, SessionMachinePorts, StoppedHome, SupervisorEntry, V0Result, RelocatePlan } from "./types";
import { refusal } from "./remote";
import { insideDirectory, isPiTitle, localProcessTree, localGroupBlockers, locklessPiInCheckout, processName, type SessionProcessTree, type StopTreeCheck } from "./local-process";
import { localWriterBlockers } from "./local-writers";
import { piLaunchArgv, toolPath } from "./launch-environment";

type LocalLaunch = { sessionId: string; machineId: string; epoch: number; cwd: string; file: string };
type LocalTerminal = { terminal: string; state: "live" | "finished"; pid: number | null; owned?: true; labelled?: true; launch?: LocalLaunch };
export type LocalDurableTerminal = { pid: number; core: CoreIdentity; identity: string; createdAt: number };
const auxiliaryKinds = new Set<string>([...Object.values(HERDR_KINDS).filter(kind => kind !== HERDR_KINDS.session), "roam-proxy"]);
function finishedTerminal(terminal: string, row: Record<string,unknown>): LocalTerminal {
  const signaled = Number.isSafeInteger(row.signal) && (row.signal as number) > 0;
  if (row.reason === "exited" && !Number.isSafeInteger(row.exit_code) && !signaled) throw new Error("Invalid terminal exit");
  // Restart and other non-exit reasons need not carry exit data. A retained
  // finished row cannot identify a live owner, even if it still has a PID.
  return {terminal,state:"finished",pid:null};
}
export interface LocalIO {
  inspect(sessionId: string): Promise<IdLockObservation | null>;
  probe(pid: number, readStartedAt?: boolean): Promise<{kind:"absent"}|{kind:"unknown"}|{kind:"live";startIdentity:string;pi:boolean;startedAt?:number}>;
  claimFree(sessionId: string): Promise<void>;
  tree(pid: number, stop?: StopTreeCheck): Promise<SessionProcessTree>;
  groupBlockers(groups: readonly number[]): Promise<readonly string[]>;
  writerBlockers(sessionId: SessionId, placement?: SessionPlacement, requireCheckout?: boolean): Promise<readonly string[]>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
  shutdown(operation: Operation, timeoutMs?: number): Promise<boolean>;
  bootId?(): Promise<string>;
  fileLease?(file: string): Promise<{ pid: number; startIdentity: string; bootId?: string } | null>;
  pause(ms: number): Promise<void>;
  terminals(sessionId: string, admittedPid?: number, includeLaunch?: boolean, stop?: { timeoutMs: number }): Promise<readonly LocalTerminal[]>;
  durableTerminal?(address: string, directory: string, timeoutMs: number): Promise<LocalDurableTerminal | null>;
  launch(request: {home:RunningHome;placement:SessionPlacement}, beforeSpawn?: () => Promise<void>): Promise<{terminal:string}>;
}
export function exactHome(a: RelocateHome | null, b: RelocateHome): boolean {
  return !!a && a.sessionId === b.sessionId && a.machineId === b.machineId && a.epoch === b.epoch && a.state === b.state && a.destination === b.destination && a.moveId === b.moveId;
}
function sameOwner(a: IdLockObservation | null, b: IdLockObservation): boolean {
  return !!a && a.identity.pid === b.identity.pid && a.identity.startIdentity === b.identity.startIdentity && a.bootId === b.bootId && a.pendingOperationId === b.pendingOperationId;
}
export async function probeLocalProcess(pid: number, readStartedAt = false): ReturnType<LocalIO["probe"]> {
  let startIdentity: string | null;
  try { startIdentity = processStartIdentity(pid); }
  catch { return {kind:"unknown"}; }
  if (startIdentity === null) return {kind:"absent"};
  try {
    if (!readStartedAt) {
      const comm = execFileSync("ps",["-p",String(pid),"-o","comm="],{encoding:"utf8",timeout:1000}).trim();
      return {kind:"live",startIdentity,pi:isPiTitle(comm)};
    }
    const output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], {
      encoding: "utf8", timeout: 1000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    }).trim();
    const fields = /^(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})[ \t]+(.+)$/.exec(output);
    if (!fields || processStartIdentity(pid) !== startIdentity) return {kind:"unknown"};
    const startedAt = Date.parse(`${fields[1]} UTC`);
    if (!Number.isSafeInteger(startedAt)) return {kind:"unknown"};
    return {kind:"live",startIdentity,pi:isPiTitle(fields[2]),startedAt};
  } catch {
    try { return processStartIdentity(pid) === startIdentity ? {kind:"unknown"} : {kind:"absent"}; }
    catch { return {kind:"unknown"}; }
  }
}
/** HC selection is local. No inherited terminal, remote target, or lease survives. */
export function localLaunchEnvironment(env: Readonly<NodeJS.ProcessEnv> = process.env): NodeJS.ProcessEnv {
  const core = hubCoreSelection(env);
  const clean = safeLaunchEnvironment(env);
  for (const key of Object.keys(clean)) if (/^(HC_|PI_|SPIDER_)/.test(key) || key === "NODE_OPTIONS") delete clean[key];
  clean.PI_SUBAGENT_CHILD = "0";
  clean.HC_SESSION = core.session;
  clean.HC_SOCKET = core.socket;
  clean.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR ?? join(homedir(),".pi","agent");
  clean.PATH = toolPath(env.PATH,process.execPath);
  return clean;
}
export function localHerdrConnection(root: string, base: Readonly<NodeJS.ProcessEnv> = process.env): {binary:string;env:NodeJS.ProcessEnv} {
  let config;
  try { config = loadHerdrConfig(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const binary = base.SPIDER_ROAM_HC || config?.core.binary || "hc";
  if (base.SPIDER_ROAM_HC && !isAbsolute(binary)) throw new Error("The configured hc executable must have an absolute path");
  const env = {...localLaunchEnvironment({...base,PI_CODING_AGENT_DIR:base.PI_CODING_AGENT_DIR || config?.agentDirectory}),SPIDER_GLOBAL_ROOT:root};
  return {binary,env};
}
export function createLocalIO(options: RelocateAdapterOptions): LocalIO {
  const lockRoot = join(options.root,"herdr");
  const {binary,env} = localHerdrConnection(options.root);
  const pi = resolveParticipantPi(process.env);
  const hc = createLocalExactHc({
    coreId: async signal => (await observeCoreIdentity(binary,env,{signal})).coreId,
    invoke:(argv,signal)=>invokeCli(binary,argv,env,options.limits.replyBytes,undefined,{signal}),
    invokeTracked:(argv,launchEnv)=>invokeCli(binary,argv,launchEnv,options.limits.replyBytes,undefined,{timeoutMs:options.limits.launchMs}),
  });
  return {
    inspect:id=>inspectIdLock(lockRoot,id),probe:probeLocalProcess,
    tree:localProcessTree,groupBlockers:localGroupBlockers,
    async writerBlockers(id, placement, requireCheckout) {
      const saved = placement ? undefined : readLocal<unknown>(options.globalDb,"relocate-managed",id);
      const known = placement ?? (saved === undefined ? undefined : parsePlacement(saved));
      const row = known ? undefined : options.globalDb.prepare("SELECT file,cwd,stores_json FROM roam_locations WHERE session_id=?").get(id) as {file:string|null;cwd:string|null;stores_json:string} | undefined;
      const cwd = known?.cwd ?? row?.cwd;
      if (!cwd && options.config.role === "hub") {
        const source = await discoverOrdinarySource(id,options);
        if (source.ok) return [...await locklessPiInCheckout(source.value.root), ...await localWriterBlockers(id,source.value.root,source.value.placement.stores,options)];
        if (requireCheckout) throw new Error("The ordinary checkout could not be verified");
      }
      if (!cwd) {
        if (requireCheckout || known || row && (row.file !== null || row.cwd !== null)) throw new Error("The session has no verifiable checkout");
        // Replication can catalog rows before the first local checkout exists.
        if (row) parseLocationStores(JSON.parse(row.stores_json),{allowEmpty:true});
        return [];
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
    async signal(pid, signal) { process.kill(pid,signal); },
    async shutdown(operation, timeoutMs = options.limits.controlMs) { try { return (await requestSessionControl(join(options.root,"roam","s"),operation,{timeoutMs})).code === 0; } catch { return false; } },
    pause:ms=>delay(ms),
    async terminals(id,admittedPid,includeLaunch,stop) {
      const timeoutMs = stop?.timeoutMs ?? options.limits.controlMs;
      async function list(args: readonly string[], pidFilter?: number, labelled = false): Promise<LocalTerminal[]> {
        const reply = await invokeCli(binary,args,env,options.limits.replyBytes,undefined,{timeoutMs});
        if (!reply || typeof reply !== "object" || !("terminals" in reply) || !Array.isArray(reply.terminals)) throw new Error("Terminal list unavailable");
        return (await Promise.all(reply.terminals.map(async (value: unknown) => {
          if (!value || typeof value !== "object") throw new Error("Invalid terminal");
          const row = value as Record<string,unknown>;
          // Native peer addresses are qualified; their processes are not local.
          if (typeof row.address === "string" && row.address.includes("/")) return null;
          if (typeof row.address !== "string" || !row.address || row.state !== "live" && row.state !== "finished") throw new Error("Unknown terminal state");
          if (row.state === "finished") return pidFilter === undefined ? finishedTerminal(row.address,row) : null;
          let pid: unknown = row.pid ?? row.process_id ?? null;
          if (pidFilter !== undefined && pid !== null && pid !== pidFilter) return null;
          let labels: unknown = row.labels, detail: Record<string,unknown> | undefined;
          if (pid === null || labels == null || includeLaunch) {
            detail = object(await invokeCli(binary,["get",row.address,"--json"],env,options.limits.replyBytes,undefined,{timeoutMs}));
            if (detail.address !== row.address) throw new Error("Terminal identity changed");
            if (detail.state === "finished" && "reason" in detail) return pidFilter === undefined ? finishedTerminal(row.address,detail) : null;
            if (detail.state !== "live" || !("pid" in detail)) throw new Error("Terminal identity changed");
            if (pid !== null && detail.pid !== pid) throw new Error("Terminal process changed");
            pid = detail.pid;
            if ("labels" in detail || includeLaunch) labels = detail.labels;
          }
          if (pid !== null && (!Number.isSafeInteger(pid) || (pid as number) <= 0)) throw new Error("Unknown terminal process");
          if (pidFilter !== undefined && pid !== pidFilter) return null;
          const terminal: LocalTerminal = {terminal:row.address,state:"live",pid:pid as number|null};
          if (includeLaunch && labelled) terminal.labelled = true;
          if (labels && typeof labels === "object") {
            const tags = labels as Record<string,unknown>;
            const kind = tags["spider.kind"];
            // Views and job terminals may share the session label. They are
            // never pi authority; a claim on the ID-lock PID is a conflict.
            if (stop && pid !== admittedPid && typeof kind === "string" && auxiliaryKinds.has(kind) && !("spider.roam.epoch" in tags)) return null;
            if (includeLaunch && ("spider.session" in tags || "spider.roam.epoch" in tags || kind === "session")) terminal.labelled = true;
            if (tags["spider.kind"] === "session" && tags["spider.session"] === id && tags["spider.machine"] === options.config.machineId &&
                typeof tags["spider.roam.epoch"] === "string" && /^[1-9]\d*$/.test(tags["spider.roam.epoch"]) &&
                !("spider.roam.operation" in tags)) terminal.owned = true;
            if (includeLaunch && detail && tags["spider.kind"] === "session" && typeof tags["spider.session"] === "string" &&
                typeof tags["spider.machine"] === "string" && typeof tags["spider.roam.epoch"] === "string" &&
                /^[1-9]\d*$/.test(tags["spider.roam.epoch"]) && Number.isSafeInteger(Number(tags["spider.roam.epoch"])) &&
                !("spider.roam.operation" in tags) && typeof detail.cwd === "string" && isAbsolute(detail.cwd) &&
                Array.isArray(detail.argv) && detail.argv.at(-2) === "--session" && typeof detail.argv.at(-1) === "string" && isAbsolute(detail.argv.at(-1))) {
              terminal.launch = {sessionId:tags["spider.session"],machineId:tags["spider.machine"],epoch:Number(tags["spider.roam.epoch"]),cwd:detail.cwd,file:detail.argv.at(-1)};
            }
          }
          return terminal;
        }))).filter(terminal => terminal !== null);
      }
      const tagged = await list(["ls","--all","--json","--label",`spider.session=${id}`],undefined,true);
      if (admittedPid === undefined || tagged.some(terminal=>terminal.pid === admittedPid)) return tagged;
      return [...tagged,...await list(["ls","--json"],admittedPid)];
    },
    async durableTerminal(address, directory, timeoutMs) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(address)) return null;
      const core = await observeCoreIdentity(binary, env, { timeoutMs });
      const row = object(await invokeCli(binary, ["get", address, "--json"], env, options.limits.replyBytes, undefined, { timeoutMs }));
      const { pid, identity, created_ms: createdAt, argv } = row;
      if (row.address !== address || row.state !== "live" || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1 ||
          typeof identity !== "string" || !identity || typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt <= 0 ||
          !Array.isArray(argv) || argv.length !== 7 || argv[1] !== "--input-type=module" || argv[2] !== "-e" ||
          typeof argv[4] !== "string" || !isAbsolute(argv[4]) || basename(argv[4]) !== "subagent-supervisor.mjs" ||
          argv[5] !== join(directory, "request.json") || argv[6] !== join(directory, "supervisor.log")) return null;
      if (!isDeepStrictEqual(core, await observeCoreIdentity(binary, env, { timeoutMs }))) return null;
      return { pid, core, identity, createdAt };
    },
    async launch({home,placement}, beforeSpawn) {
      if (!pi) throw new Error("Pi executable unavailable");
      const core = await observeCoreIdentity(binary,env,{timeoutMs:options.limits.controlMs});
      const launchEnv: NodeJS.ProcessEnv = {...env,HC_SESSION:core.sessionNamespace,HC_SOCKET:core.socket};
      const launch = { sessionId: home.sessionId, machineId: home.machineId, homeEpoch: home.epoch };
      const request: PiSpawnRequest = {sessionId:home.sessionId as unknown as HerdrSessionId,sessionFile:placement.file,cwd:placement.cwd,environment:{agentDirectory:launchEnv.PI_CODING_AGENT_DIR!,extensionArguments:[]},argv:piLaunchArgv(pi,placement.file,launchEnv,launch),env:launchEnv,terminal:{background:true,noNotify:true,outliveParent:true,parent:null,labels:{"spider.kind":"session","spider.session":home.sessionId,"spider.machine":home.machineId,"spider.roam.epoch":String(home.epoch)}}};
      await beforeSpawn?.();
      return hc.run(request,{started(){},exited(){}});
    },
  };
}

type StopRetryCommand = "relocate" | "set-home --force";
function busy<T>(blockers: readonly string[], retry: StopRetryCommand = "relocate", scope: "session" | "checkout" = "session"): V0Result<T> {
  const list = [...new Set(blockers)], shown = list.slice(0,12);
  const more = list.length > shown.length ? `, and ${list.length-shown.length} more` : "";
  const note = scope === "checkout" ? " Close every pi in this checkout, including pi for other sessions." : "";
  return refusal("session-busy",`Local processes or jobs are still present: ${shown.join(", ")}${more}.${note}`,`Close these, then rerun ${retry}.`);
}
function unverifiedStop(retry: StopRetryCommand = "relocate"): V0Result<void> {
  return refusal("stop-timeout","The local session or its jobs could not be checked safely.",`Close the local pi session and its jobs, then rerun ${retry}.`);
}

/** The home store has already reserved this session's Mac ID. Only observe the checkout, never signal its writers. */
export async function checkMacSourceWriters(id: SessionId, options: RelocateAdapterOptions): Promise<V0Result<void>> {
  try {
    const blockers = await createLocalIO(options).writerBlockers(id, undefined, true);
    return blockers.length ? busy(blockers, "set-home --force", "checkout") : {ok:true,value:undefined};
  } catch { return unverifiedStop("set-home --force"); }
}
const terminalName = (t: LocalTerminal): string => t.pid === null ? `terminal ${t.terminal} (PID unavailable)` : `PID ${t.pid} (pi)`;

/** A free lock alone cannot clear an ordinary pi or a detached Spider job. */
export async function stopLocalSession(sessionId: SessionId, moving: MovingHome | null, io: LocalIO, clock: Clock, timeoutMs: number,
  beforeSignal?: () => Promise<V0Result<void> | undefined>): Promise<V0Result<void>> {
  try {
    const deadline = clock.now() + timeoutMs;
    let observed = await io.inspect(sessionId);
    if (observed && (await io.probe(observed.identity.pid)).kind === "absent") {
      await io.claimFree(sessionId);
      observed = await io.inspect(sessionId);
    }
    const lockPid = observed?.identity.pid;
    // Ordinary pi holds the admission lock without managed launch labels.
    // Labels are still required before admission, when a lock cannot prove ownership.
    const admitted = observed?.pendingOperationId === null;
    const liveTerminals = async () => (await io.terminals(sessionId,admitted ? lockPid : undefined)).filter(t=>t.state === "live");
    const live = await liveTerminals();
    const terminal = lockPid !== undefined
      ? live.find(t=>t.pid === lockPid && (admitted || t.owned))
      : live.length === 1 && live[0].owned ? live[0] : undefined;
    if (observed && !terminal) return busy([`PID ${observed.identity.pid} (pi)`]);
    const pid = terminal?.pid ?? null;
    const p = pid === null ? null : await io.probe(pid);
    if (terminal && pid !== null && p && p.kind !== "absent") {
      const address = terminal.terminal;
      if (p.kind !== "live" || !p.pi || observed && p.startIdentity !== observed.identity.startIdentity) return busy([terminalName(terminal)]);
      const root = {pid,startIdentity:p.startIdentity,command:"pi"};
      const expectedLock = (held: IdLockObservation | null): boolean => observed ? sameOwner(held,observed)
        : !held || held.identity.pid === pid && held.identity.startIdentity === root.startIdentity && held.pendingOperationId === null;
      // A blocked v0 admission can release its lock and leave pi in the
      // terminal. In that case both labels and the process must still match.
      async function stillOwned(): Promise<boolean> {
        if (!observed) {
          const matches = await liveTerminals();
          if (matches.length !== 1 || !matches[0].owned || matches[0].terminal !== address || matches[0].pid !== pid) return false;
        }
        if (!expectedLock(await io.inspect(sessionId))) return false;
        const state = await io.probe(root.pid);
        return state.kind === "live" && state.pi && state.startIdentity === root.startIdentity;
      }
      const {descendants:children,groups} = await io.tree(pid);
      if (!await stillOwned()) return busy([processName(root)]);
      // Preflight every descendant before signalling any. Recheck each target
      // because an earlier signal can end a relative or its PID can be reused.
      const liveChildren: Array<SessionProcessTree["descendants"][number]> = [];
      for (const child of children) {
        const member = await io.probe(child.pid);
        if (member.kind === "unknown") return busy([processName(child)]);
        if (member.kind === "live" && member.startIdentity === child.startIdentity) liveChildren.push(child);
      }
      for (const child of liveChildren) {
        const member = await io.probe(child.pid);
        if (member.kind === "unknown") return busy([processName(child)]);
        if (member.kind !== "live" || member.startIdentity !== child.startIdentity) continue;
        if (beforeSignal) { const blocked = await beforeSignal(); if (blocked) return blocked; }
        try { await io.signal(child.pid,"SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException | null)?.code !== "ESRCH") throw error; }
      }
      const shutdown = observed && moving && await io.shutdown({id:`${moving.moveId}-shutdown`,machineId:moving.machineId,expectedEpoch:moving.epoch,kind:"session-shutdown",args:{sessionId,moveId:moving.moveId,v0:true}});
      if (!shutdown && (await io.probe(pid)).kind !== "absent") {
        if (!await stillOwned()) return busy([processName(root)]);
        if (beforeSignal) { const blocked = await beforeSignal(); if (blocked) return blocked; }
        try { await io.signal(pid,"SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException | null)?.code !== "ESRCH") throw error; }
      }
      for (;;) {
        const held = await io.inspect(sessionId);
        if (held && !expectedLock(held)) return busy([`PID ${held.identity.pid} (pi)`]);
        const alive: string[] = [];
        for (const member of [root,...children]) {
          const state = await io.probe(member.pid);
          if (state.kind === "unknown" || state.kind === "live" && state.startIdentity === member.startIdentity) alive.push(processName(member));
        }
        if (!alive.length || clock.now() >= deadline) alive.push(...await io.groupBlockers(groups));
        if (!alive.length) break;
        if (clock.now() >= deadline) return busy(alive);
        await io.pause(Math.min(100,Math.max(1,deadline-clock.now())));
      }
    }
    // An empty stop check must not publish ownership of the session ID:
    // an incoming install may need to claim it while the home is moving.
    // Use the existing claim/release only to clear a remaining record.
    if (await io.inspect(sessionId)) await io.claimFree(sessionId);
    for (;;) {
      const remaining = await liveTerminals();
      if (!remaining.length) break;
      // Only the terminal whose process we checked can be waiting for the
      // core's exit observation. A new terminal or owner is not proof of exit.
      if (pid === null || remaining.length !== 1 || remaining[0].terminal !== terminal?.terminal || remaining[0].pid !== pid || clock.now() >= deadline) {
        return busy(remaining.map(terminalName));
      }
      const held = await io.inspect(sessionId);
      if (held) return busy([`PID ${held.identity.pid} (pi)`]);
      await io.pause(Math.min(100,Math.max(1,deadline-clock.now())));
    }
    const blockers = await io.writerBlockers(sessionId,undefined,moving !== null);
    if (blockers.length) return busy(blockers, "relocate", "checkout");
    const held = await io.inspect(sessionId);
    if (held) return busy([`PID ${held.identity.pid} (pi)`]);
    return {ok:true,value:undefined};
  } catch { return unverifiedStop(); }
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
    if (!row || row.file === null && row.cwd === null) {
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
const MAX_SEED_BATCHES = 64;
export class SessionSeedBusy extends Error {
  readonly code = "session-busy";
}
export function seedBusyRefusal<T = never>(error: SessionSeedBusy): V0Result<T> {
  return refusal(error.code,error.message,"Close running subagents, then rerun relocate.");
}
export async function seedLocalPlacement(placement: SessionPlacement, epoch: number, options: RelocateAdapterOptions, checkHome?: () => Promise<void>): Promise<void> {
  const stores = createStorePort(options.config,options.globalDb);
  try {
    for (const key of placement.stores) {
      if (checkHome) await checkHome();
      const db=stores.openStore(key).db;
      if (!key.startsWith("worktree:")) { enableMemoryCapture(db,key); continue; }
      let through = -1;
      for (let batch = 1; ; batch++) {
        if (batch > 1 && checkHome) await checkHome();
        const seeded = seedSession(db,placement.sessionId,epoch,key,options.limits.hardBatchBytes);
        if (seeded.complete) break;
        if (seeded.retryable || seeded.through <= through) throw new SessionSeedBusy("The session is too busy to prepare its capture rows.");
        if (batch === MAX_SEED_BATCHES) throw new SessionSeedBusy("The session has more capture rows to prepare.");
        through = seeded.through;
        await yieldTurn();
      }
    }
  } finally {stores.close();}
}
export async function captureOrdinarySource(plan: RelocatePlan, options: RelocateAdapterOptions): Promise<void> {
  if (options.globalDb.prepare("SELECT 1 FROM roam_locations WHERE session_id=? AND file IS NOT NULL AND cwd IS NOT NULL").get(plan.source.sessionId)) return;
  const home = await options.homes.read(plan.source.sessionId);
  if (!home || home.state !== "moving" || home.machineId !== options.config.machineId || home.moveId !== plan.moveId || home.epoch !== plan.source.epoch + 1 || home.destination !== plan.destinationPlacement.machineId) throw new Error("Ordinary capture requires the moving home");
  const ready = await inspectLocalSource(plan.source.sessionId, options);
  if (!ready.ok || !isDeepStrictEqual(ready.value.placement, plan.sourcePlacement)) throw new Error("Ordinary source changed before capture");
  await mapWorkspace(options.globalDb, { repoKey: plan.sourcePlacement.repoKey, workspaceId: plan.sourcePlacement.workspaceId, path: ready.value.root });
  await seedLocalPlacement(plan.sourcePlacement, plan.source.epoch, options);
  recordLocation(options.globalDb, { sessionId: plan.source.sessionId, stores: plan.sourcePlacement.stores, home: { sessionId: plan.source.sessionId, machineId: plan.source.machineId, epoch: plan.source.epoch, moveId: null, updatedAt: plan.source.updatedAt }, file: plan.sourcePlacement.file, cwd: plan.sourcePlacement.cwd });
}
/** Check and queue on the same connection so replication cannot change the row between them. */
export function requestLocalStop(home: StoppedHome, mode: StopMode, options: RelocateAdapterOptions): V0Result<void> {
  const { config, globalDb: db } = options;
  const conflict = () => refusal("home-conflict", "The exact stopped home is not present on its named machine.",
    "Publish the stopped home before requesting Stop again.");
  if (home.machineId !== config.machineId) return conflict();
  try {
    return db.raw.transaction(() => {
      if (!sameManagedHome(readManagedHome(db, home.sessionId), home)) return conflict();
      queueStopMode(db, home, mode);
      return { ok: true, value: undefined } as const;
    }).immediate();
  } catch {
    return refusal("home-unavailable", "The stopped replica or its mode could not be saved locally.", "Check local roaming storage, then retry Stop.");
  }
}

export interface LocalRuntime extends SessionMachinePorts {
  confirm(home: RunningHome, placement: SessionPlacement, exact?: true, admitted?: true): Promise<V0Result<{terminal:string}>>;
  owner(id: SessionId, placement?: SessionPlacement): Promise<SessionOwner>;
  stop(id: SessionId, moving?: MovingHome | null, beforeOrdinaryCapture?: boolean): Promise<V0Result<void>>;
  entries(): Promise<readonly SupervisorEntry[]>;
  enforceStopped(home: StoppedHome): Promise<StopObservation>;
  observeStopped(home: StoppedHome): Promise<StopObservation>;
  freezeStoppedPlacement(home: StoppedHome, placement: SessionPlacement, moving?: MovingHome): Promise<V0Result<void>>;
}
async function verifyLocalTranscript(placement: SessionPlacement, options: RelocateAdapterOptions): Promise<void> {
  if (await realpath(placement.file) !== placement.file || !(await stat(placement.cwd)).isDirectory())
    throw new Error("The local session transcript or checkout is unavailable.");
  const session = await inspectSession(placement.file, placement.sessionId, undefined, options.limits);
  if (session.cwd !== placement.cwd) throw new Error("The transcript does not match the recorded checkout.");
}

export function createLocalRuntime(options: RelocateAdapterOptions, io: LocalIO = createLocalIO(options)): LocalRuntime {
  const lockRoot = join(options.root, "herdr");
  const leases = createSessionLeases(lockRoot);
  function withSessionState<T>(id: SessionId, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withProcessLock(lockRoot, `v0-state:${id}`, run, { signal });
  }
  const stopped = createLocalStop(options, io, withSessionState);
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
  async function inspectAdmission(home: RunningHome, lock: IdLockObservation): Promise<boolean> {
    if (lock.pendingOperationId !== null) return false;
    // The pi socket checks its live admission gate and file lease, not merely
    // whether it has acquired an ID lock and appeared in the terminal list.
    const owner = { ...lock.identity, bootId: lock.bootId };
    const reply = await requestSessionControl(join(options.root, "roam", "s"), {
      id: `start-inspect-${home.epoch}`, kind: "session-inspect", machineId: home.machineId, expectedEpoch: home.epoch,
      args: { v0: true, sessionId: home.sessionId, homeMachineId: home.machineId, homeState: "running", owner },
    }, { timeoutMs: Math.min(options.limits.controlMs, options.limits.readyMs) });
    if (reply.code !== 0 || reply.reason !== "session-inspect" || reply.value?.version !== 1 || reply.value.sessionId !== home.sessionId ||
        !sameManagedHome(decodeManagedHome(object(reply.home)), home)) return false;
    const verified = object(reply.value.owner);
    return verified.pid === owner.pid && verified.startIdentity === owner.startIdentity && verified.bootId === owner.bootId;
  }
  async function confirm(home: RunningHome,placement: SessionPlacement,exact?: true, admitted?: true): Promise<V0Result<{terminal:string}>> {
    try {
      if (!await runnable(home,placement)) return refusal("start-pending","The local running home changed.");
      if (admitted && !exact) return refusal("start-pending", "Admission confirmation requires the exact launch.");
      if (!exact) {
        const current = await owner(home.sessionId);
        return current.kind === "live" && current.terminal ? {ok:true,value:{terminal:current.terminal}} : refusal("start-pending","Pi has not claimed this session's ID lock.");
      }
      const lock = await io.inspect(home.sessionId), current = await owner(home.sessionId);
      if (!lock || current.kind !== "live" || !current.terminal || current.pid !== lock.identity.pid) return refusal("start-pending","Pi has not claimed this session's ID lock.");
      const terminal = (await io.terminals(home.sessionId,undefined,true)).find(t=>t.state === "live" && t.pid === current.pid && t.terminal === current.terminal);
      const launch = terminal?.launch;
      if (!launch || launch.sessionId !== home.sessionId || launch.machineId !== home.machineId || launch.epoch !== home.epoch ||
          launch.cwd !== placement.cwd || launch.file !== placement.file) return refusal("start-pending","The session owner's launch does not match the running home.");
      if (admitted && !await inspectAdmission(home, lock)) return refusal("start-pending", "Pi has not admitted the exact running home.");
      const probe = await io.probe(lock.identity.pid);
      if (probe.kind !== "live" || !probe.pi || probe.startIdentity !== lock.identity.startIdentity ||
          !sameOwner(await io.inspect(home.sessionId),lock) || !(admitted
            ? sameManagedHome(await options.homes.read(home.sessionId), home)
            : await runnable(home,placement))) return refusal("start-pending","The session owner changed before confirmation.");
      return {ok:true,value:{terminal:current.terminal}};
    } catch { return refusal("start-pending","The session owner cannot be confirmed."); }
  }
  async function start(home: RunningHome,placement: SessionPlacement): Promise<V0Result<{terminal:string}>> {
    try { return await withSessionState(home.sessionId,async()=>{
      if (!await runnable(home,placement)) return refusal("start-pending","The local running home does not authorize launch.");
      const {owner:current,blockers} = await inspectOwner(home.sessionId,placement);
      if (blockers) return busy(blockers, "relocate", "checkout");
      if (current.kind === "live") return current.terminal ? {ok:true,value:{terminal:current.terminal}} : refusal("start-pending","The running pi terminal cannot be located.");
      if (current.kind !== "free") return refusal("start-pending","A session owner or pending terminal is still present.");
      // Reread immediately before the only spawn call.
      if (!await runnable(home,placement)) return refusal("start-pending","The home changed before launch.");
      const launched = await io.launch({home,placement}, async () => {
        // Core identity resolution can yield. Recheck under the state lock at
        // the native spawn boundary, without claiming pi's leases for it.
        const lease = await (io.fileLease ? io.fileLease(placement.file) : leases.get(placement.file));
        if (lease && !(lease.bootId && bootIdChanged(lease.bootId, await (io.bootId ? io.bootId() : localBootId())))) {
          const holder = await io.probe(lease.pid);
          if (holder.kind === "unknown" || holder.kind === "live" && holder.startIdentity === lease.startIdentity)
            throw new Error("The exact session file is still leased.");
        }
        await verifyLocalTranscript(placement, options);
        if ((await io.terminals(home.sessionId)).some(terminal => terminal.state === "live") ||
            await io.inspect(home.sessionId) || !sameManagedHome(await options.homes.read(home.sessionId), home))
          throw new Error("The session owner or home changed before the native spawn.");
      });
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
      await verifyLocalTranscript(placement, options);
      return {ok:true,value:placement};
    } catch {return refusal("destination-copy-missing","The destination has no verified local session copy.");}
  }
  async function publishHome(home: RelocateHome,machineId: string): Promise<V0Result<void>> {
    try { return machineId === options.config.machineId && exactHome(await options.homes.read(home.sessionId),home) ? {ok:true,value:undefined} : refusal("sync-failed","The exact home is not present on the local machine."); }
    catch {return refusal("sync-failed","The local home cannot be read back.");}
  }
  async function activate(home: RunningHome,placement: SessionPlacement): Promise<V0Result<void>> {
    try { return await withSessionState(home.sessionId,async()=>{
      parsePlacement(placement);
      async function authorized() {
        const current = await options.homes.read(home.sessionId);
        return sameManagedHome(current, home) || current?.state === "moving" && current.moveId === home.moveId &&
          current.epoch + 1 === home.epoch && (current.machineId === home.machineId || current.destination === home.machineId);
      }
      const checkHome = async () => {
        if (!await authorized()) throw new Error("The home changed during local activation.");
      };
      if (!await authorized() || home.state !== "running" || home.destination !== null || home.machineId !== options.config.machineId || placement.machineId !== home.machineId || home.sessionId !== placement.sessionId) return refusal("home-conflict","The home does not authorize this local activation.");
      const stores=createStorePort(options.config,options.globalDb);
      try { for(const key of placement.stores) if(key.startsWith("worktree:")) {
        await checkHome();
        const db=stores.openStore(key).db;
        const old=db.prepare("SELECT epoch FROM roam_sessions WHERE session_id=?").get(home.sessionId) as {epoch:number}|undefined;
        if(old && old.epoch>home.epoch) return refusal("home-conflict","The local membership has a newer epoch.");
        db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,?,'active') ON CONFLICT(session_id) DO UPDATE SET epoch=excluded.epoch,state='active'").run(home.sessionId,home.epoch);
      }} finally {stores.close();}
      await seedLocalPlacement(placement,home.epoch,options,checkHome);
      await checkHome();
      writeLocal(options.globalDb,"relocate-managed",home.sessionId,placement);
      recordLocation(options.globalDb,{sessionId:home.sessionId,stores:placement.stores,home,file:placement.file,cwd:placement.cwd});
      return {ok:true,value:undefined};
    }); } catch (error) {return error instanceof SessionSeedBusy ? seedBusyRefusal(error) : refusal("install-failed","Local capture membership could not be activated.");}
  }
  async function freezeStoppedPlacement(home: StoppedHome, placement: SessionPlacement, moving?: MovingHome): Promise<V0Result<void>> {
    const conflict = () => refusal("home-conflict", "The local home does not authorize this stopped placement.");
    try { return await withSessionState(home.sessionId, async () => {
      parsePlacement(placement);
      if (home.state !== "stopped" || home.machineId !== options.config.machineId ||
          placement.machineId !== home.machineId || placement.sessionId !== home.sessionId) return conflict();
      const predecessor = moving && moving.sessionId === home.sessionId && moving.destination === home.machineId &&
        moving.moveId === home.moveId && moving.epoch + 1 === home.epoch && moving.updatedAt === home.updatedAt ? moving : undefined;
      const authorized = async () => {
        const current = await options.homes.read(home.sessionId);
        return sameManagedHome(current, home) || predecessor !== undefined && sameManagedHome(current, predecessor);
      };
      if (!await authorized()) return conflict();
      await verifyLocalTranscript(placement, options);
      const stores = createStorePort(options.config, options.globalDb);
      try {
        for (const key of placement.stores) {
          if (!key.startsWith("worktree:")) continue;
          if (!await authorized()) return conflict();
          const db = stores.openStore(key).db;
          if (db.prepare(`INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,?,'frozen')
            ON CONFLICT(session_id) DO UPDATE SET epoch=excluded.epoch,state='frozen' WHERE roam_sessions.epoch<=excluded.epoch`)
            .run(home.sessionId, home.epoch).changes !== 1)
            return refusal("home-conflict", "The local membership has a newer epoch.");
        }
      } finally { stores.close(); }
      if (!await authorized()) return conflict();
      writeLocal(options.globalDb, "relocate-managed", home.sessionId, placement);
      recordLocation(options.globalDb, { sessionId: home.sessionId, stores: placement.stores, home, file: placement.file, cwd: placement.cwd });
      return { ok: true, value: undefined };
    }); } catch { return refusal("install-failed", "Local stopped membership could not be frozen."); }
  }
  async function stop(id: SessionId,moving: MovingHome|null=null,beforeOrdinaryCapture=false): Promise<V0Result<void>> {
    async function checkGenericStop(): Promise<V0Result<void> | undefined> {
      // An unreadable home does not authorize a managed pi to run.
      const current = await options.homes.read(id).catch(() => null);
      if (current?.state === "stopped") {
        return refusal("home-conflict", "This session now has a stopped home; generic shutdown did not signal pi.",
          "Wait for the local stopped-home check, or retry Stop on the Mac.");
      }
      if (current?.state === "running" && current.machineId === options.config.machineId) {
        return refusal("home-conflict","This machine is now the running home; the supervisor did not stop pi.","Leave the session open. To move it, run spider roam relocate.");
      }
    }
    try { return await withSessionState(id,async()=>{
      if (moving) {
        if (!exactHome(await options.homes.read(id),moving)) return refusal("home-conflict","The source moving home changed before shutdown.");
      } else {
        const blocked = await checkGenericStop(); if (blocked) return blocked;
      }
      const stopped=await stopLocalSession(id,moving,io,options.clock,options.limits.readyMs,moving ? undefined : checkGenericStop);if(!stopped.ok)return stopped;
      const known=readLocal<unknown>(options.globalDb,"relocate-managed",id);
      const row=options.globalDb.prepare("SELECT stores_json,file,cwd FROM roam_locations WHERE session_id=?").get(id) as {stores_json:string;file:string|null;cwd:string|null}|undefined;
      // A first-time ordinary source may be cataloged by mapWorkspace before
      // it finishes seeding. Keep its membership seedable until capture
      // records the verified transcript and cwd. The moving home bars pi.
      if (beforeOrdinaryCapture && moving && !known && row?.file === null && row.cwd === null) return stopped;
      const keys=known?parsePlacement(known).stores:row?parseLocationStores(JSON.parse(row.stores_json)):[];
      const stores=createStorePort(options.config,options.globalDb);
      try {for(const key of keys)if(key.startsWith("worktree:"))stores.openStore(key).db.prepare("UPDATE roam_sessions SET state='frozen' WHERE session_id=? AND state='active'").run(id);}
      finally {stores.close();}
      return stopped;
    }); } catch (error) {
      if ((error as {code?:string}|null)?.code === "lock-occupied") {
        return refusal("session-busy","Another local launch or state change is in progress for this session.","Wait for it to finish, then rerun relocate.");
      }
      return refusal("stop-timeout","The stopped source membership could not be frozen.");
    }
  }
  function retainedLocalCopy(id: SessionId): boolean {
    const db = options.globalDb;
    try {
      const row = db.prepare("SELECT file,cwd,stores_json FROM roam_locations WHERE session_id=?").get(id) as
        {file: string | null; cwd: string | null; stores_json: string} | undefined;
      if (!row) return false;
      if (row.file !== null && row.cwd !== null) return true;
      for (const key of parseLocationStores(JSON.parse(row.stores_json), { allowEmpty: true })) {
        if (!key.startsWith("worktree:")) continue;
        try {
          const store = openRoamStoreReadOnly(db, key);
          if (!store) continue;
          try {
            const meta = store.prepare("SELECT machine_id, store_key FROM roam_meta WHERE id=1").get() as
              {machine_id: string; store_key: string | null} | undefined;
            if (meta?.machine_id === options.config.machineId && (meta.store_key === null || meta.store_key === key) &&
                store.prepare("SELECT 1 FROM roam_sessions WHERE session_id=? AND state IN ('active','frozen')").get(id)) return true;
          } finally { store.close(); }
        } catch { /* An unreadable store does not establish local provenance. */ }
      }
    } catch { /* Leave an unknown foreign copy unconfirmed. */ }
    return false;
  }
  async function entries(): Promise<readonly SupervisorEntry[]> {
    const homes=await options.homes.list(), byId=new Map(homes.map(home=>[home.sessionId,home]));
    const placements = new Map<SessionId, SessionPlacement | null>();
    const rows = localRecordRows(options.globalDb, "relocate-managed");
    const unknownPlacement = rows.some(row => !row.valid && row.key === null);
    for (const {key,value,valid} of rows) {
      if (key === null) continue;
      const id = key as SessionId;
      let placement: SessionPlacement | null = null;
      if (valid && !placements.has(id)) {
        try {
          const parsed = parsePlacement(value);
          if (parsed.sessionId === id && parsed.machineId === options.config.machineId) placement = parsed;
        } catch { /* An invalid placement does not make the home list unavailable. */ }
      }
      placements.set(id,placement);
    }
    const machine = options.config.machineId;
    const ids = new Set(placements.keys());
    for (const home of homes) {
      if (home.machineId === machine || home.state === "moving" && home.destination === machine ||
          home.state === "stopped" && !ids.has(home.sessionId) && retainedLocalCopy(home.sessionId)) ids.add(home.sessionId);
    }
    const result: SupervisorEntry[]=[];
    for(const sessionId of ids) {
      const home = byId.get(sessionId) ?? null;
      if (home?.state === "stopped") {
        result.push({sessionId,home,placement:null});
        continue;
      }
      const saved = placements.get(sessionId);
      if (saved === null || saved === undefined && unknownPlacement) {
        result.push({sessionId,home,placement:null,placementRefusal:{code:"destination-copy-missing",
          message:"The saved placement for this session is invalid.",nextStep:"Restore this session's local placement before trying again."}});
        continue;
      }
      const found = saved ? null : await locate(options.config.machineId,sessionId);
      result.push({sessionId,home,placement:saved ?? (found?.ok ? found.value : null)});
    }
    return result;
  }
  return {owner,start,confirm,stop,locate,publishHome,activate,entries,freezeStoppedPlacement,...stopped};
}
export function createLocalSessionMachinePorts(options: RelocateAdapterOptions): SessionMachinePorts {
  const local=createLocalRuntime(options);
  return {locate:local.locate,publishHome:local.publishHome,activate:local.activate,start:local.start,confirm:local.confirm};
}
