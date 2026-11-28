import { execFile } from "node:child_process";
import { join } from "node:path";
import { openDb, openDbReadOnly, type Db } from "@spider/db-core";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import { probeLocal } from "../local-diagnostics";
import { createStorePort } from "../stores";
import { openLocalCore, readLocalIdentity, type LocalCore } from "../runtime";
import { openJournal } from "../journal";
import { forgottenDestinationRefusal, isRevoked } from "../revocation";
import { createTransport } from "../transport";
import { createSync } from "../sync";
import type { Clock, GitPorts, Transport } from "../contracts";
import { openOutgoingStaging } from "../staging";
import { createHomeStore, type HubHomeStore } from "./home";
import { withV0HomeLifecycle } from "./home-lifecycle";
import { relocate } from "./relocate";
import { setHome } from "./set-home";
import { createSessionOperations, type SessionOperations } from "./session-operations";
import { createRelocateAdapters, type StopRelocateAdapters } from "./adapters";
import { createV0SyncTransport, createV0ArtifactTransport, guardV0PeerTransport, handleRelocateAgent } from "./remote";
import { checkMacSourceWriters, exactHome, localHerdrConnection } from "./local";
import { parseCaptured } from "./journal";
import { resolveVerifiedArtifact } from "./transfer";
import { createHomeSupervisor } from "./supervisor";
import { serveV0Control, summarizeSync, type V0HubControlServices, type V0SyncOutcome } from "./service";
import type { RelocateAdapterOptions, HomeStore, RunningHome, SetHomePorts, V0ControlServices, V0Result } from "./types";

export interface V0RuntimeOverrides {
  openCore?: (root: string) => LocalCore;
  readConfig?: typeof readLocalIdentity;
  transport?: Transport;
  clock?: Clock;
  gitRun?: GitPorts["run"];
}
export interface V0Runtime {
  options: RelocateAdapterOptions;
  adapters: StopRelocateAdapters;
  homes: HubHomeStore;
  operations: SessionOperations;
  sync: ReturnType<typeof createSync>;
  services: V0HubControlServices;
  close(): Promise<void>;
}
function syncRefusal(code: 1 | 2, reason: string): V0SyncOutcome {
  return { code, reason, operationId: "", home: null, epoch: null, repairCommand: null, value: null };
}
const clock: Clock = { now: Date.now, later(ms, fn) { const timer=setTimeout(fn,ms);return ()=>clearTimeout(timer); } };
const runGit: GitPorts["run"] = (cwd, argv, options) => new Promise((done, reject) => {
  execFile(argv[0], [...argv.slice(1)], { cwd, env: { ...process.env, ...options?.env }, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
    if(error) reject(Object.assign(error, {status:typeof error.code === "number" ? error.code : -1,stdout,stderr}));
    else done(stdout);
  }).stdin?.end(options?.stdin);
});

/** Each machine opens only its own stores. No legacy hub or supervisor runs. */
export function createV0Runtime(root: string, overrides: V0RuntimeOverrides = {}): V0Runtime {
  const core=(overrides.openCore ?? openLocalCore)(root);
  let stores: ReturnType<typeof createStorePort> | undefined;
  let revocationDb: Db | undefined;
  function closeStores() {
    try { stores?.close(); }
    finally { try { revocationDb?.close(); } finally { core.close(); } }
  }
  try {
    const journalFile=join(root,"roam","journal.db");
    const journal=openJournal(journalFile);
    if (core.config.role === "hub") {
      revocationDb = openDbReadOnly(journalFile);
      if (!revocationDb) throw new Error("Cannot read peer revocations from the private journal");
    }
    const forgotten = (machine: string) => machine !== core.config.machineId && !!revocationDb && isRevoked(revocationDb, machine);
    const readConfig = overrides.readConfig ?? (overrides.openCore ? () => core.config : readLocalIdentity);
    const config = {
      ...core.config,
      get enabled() {
        try {
          const current = readConfig(root);
          return current.machineId === core.config.machineId && current.hubMachineId === core.config.hubMachineId && current.role === core.config.role && current.enabled;
        } catch { return false; }
      },
      get peers() { return core.config.peers.filter(peer => !forgotten(peer.machineId)); },
    };
    stores=createStorePort(config,core.db);
    const homeStore=createHomeStore({db:core.db,hubMachineId:config.hubMachineId,localMachineId:config.machineId});
    const homes: HubHomeStore = {
      ...homeStore,
      async initialize(sessionId, source) {
        if (forgotten(source)) throw new Error("Cannot adopt a home on a forgotten peer");
        return homeStore.initialize(sessionId, source);
      },
      async compareAndSwap(expected, next, checkMacSource, onApplied) {
        const swap = () => {
          if (forgotten(next.machineId) || next.destination !== null && forgotten(next.destination))
            throw new Error("Cannot assign a home to a forgotten peer");
          return homeStore.compareAndSwap(expected, next, checkMacSource, onApplied);
        };
        if (next.state !== "moving") return swap();
        return withV0HomeLifecycle(root, config.limits.controlMs, async () => {
          if (!config.enabled) throw new Error("Roaming replication is disabled");
          return swap();
        });
      },
    };
    const raw=guardV0PeerTransport(overrides.transport ?? createTransport({...localHerdrConnection(root),enrolled:core.config.peers}), machine => {
      if (forgotten(machine)) throw new Error("V0 peer was forgotten");
      if (config.role === "hub" && !config.enabled) throw new Error("Hub synchronization is disabled");
    });
    const transport=createV0ArtifactTransport(createV0SyncTransport(raw),config.machineId);
    const localClock=overrides.clock ?? clock;
    const sync=createSync({config,globalDb:core.db,transport,journal,clock:localClock,stores});
    const git:GitPorts={run:overrides.gitRun ?? runGit,journal,limits:core.config.limits,scratch:join(root,"roam","staging"),worktreeCommand:null};
    const options:RelocateAdapterOptions={root,config,globalDb:core.db,homes,journal,sync,transport:raw,clock:localClock,git,limits:core.config.limits,workspaceImport:{...git,
      async resolveCommonRepository({repoKey}) {
        const row=core.db.prepare("SELECT path,worktree_command_json FROM roam_repo_maps WHERE repo_key=?").get(repoKey) as {path:string;worktree_command_json:string|null}|undefined;
        return row?.worktree_command_json === null ? row.path : null;
      },
      async lastExportedSnapshot({repoKey,workspaceId,root:checkout}) {
        const db=openDb(join(root,"roam","journal.db"),{fileMustExist:true,checkpointOnClose:false});
        try {
          const rows=db.prepare("SELECT result_json FROM roam_operation_actions WHERE action='relocate-capture' AND json_extract(result_json,'$.captured.workspace.repoKey')=? AND json_extract(result_json,'$.captured.workspace.workspaceId')=? AND json_extract(result_json,'$.captured.workspace.root')=? ORDER BY seq DESC LIMIT 1").all(repoKey,workspaceId,checkout) as {result_json:string}[];
          return rows.length ? parseCaptured(JSON.parse(rows[0].result_json).captured).workspace : null;
        } finally {db.close();}
      },
      async verifiedArtifactPath(artifactId) {
        const outgoing=openOutgoingStaging(join(root,"roam","staging"),core.config.limits);
        try {const manifest=outgoing.inspect(artifactId).current;return manifest ? resolveVerifiedArtifact(manifest,core.config.machineId,options) : null;}
        finally {outgoing.close();}
      },
    }};
    const adapters=createRelocateAdapters(options);
    const setHomePorts: SetHomePorts = { ...adapters.setHome, homes: {
      ...homes,
      compareAndSwap: (expected, next) => homes.compareAndSwap(expected, next, id => checkMacSourceWriters(id, options)),
    } };
    const relocatePorts = {
      ...adapters.ports,
      async unlabelledLocalRunner(home: RunningHome) {
        if (home.machineId !== config.machineId) return null;
        const owner = await adapters.supervisor.owner(home.sessionId);
        return owner.kind === "live" && owner.terminal === null && exactHome(await homes.read(home.sessionId), home) ? owner.pid : null;
      },
      initialEpoch(sessionId: string) {
        const legacy = core.db.prepare("SELECT epoch FROM session_homes WHERE session_id=? AND state IS NULL").get(sessionId) as { epoch: number } | undefined;
        return legacy?.epoch ?? 1;
      },
    };
    const operations = createSessionOperations();
    let closing:Promise<void>|undefined;
    const revokedDestination = { ok: false, refusal: forgottenDestinationRefusal } as const;
    return {options,adapters,homes,operations,sync,services:{
      async sync({ machineId }) {
        if (config.role !== "hub" || config.machineId !== config.hubMachineId) return syncRefusal(1, "mac-hub-required");
        if (!config.enabled) return syncRefusal(1, "roaming-disabled");
        if (machineId !== undefined) {
          if (forgotten(machineId)) return syncRefusal(1, "machine-revoked");
          if (config.peers.filter(peer => peer.machineId === machineId).length !== 1) return syncRefusal(2, "machine-not-enrolled");
        }
        return summarizeSync(await sync.sync(machineId));
      },
      relocate(request) {
        return operations.relocate(request.sessionId, async mark => {
          if (forgotten(request.destinationMachine)) return { ...revokedDestination, step: "check", home: null, moveId: null };
          if (!config.enabled) return { ok: false, step: "check", home: null, moveId: null, refusal: {
            code: "replication-disabled", message: "Relocation needs replication enabled.", nextStep: "Run spider roam enable on the Mac, then retry relocation.",
          } };
          let readSource = false;
          const moveHomes: HomeStore = {
            ...homes,
            async read(id) {
              const home = await homes.read(id);
              if (!readSource) {
                readSource = true;
                if (home) mark(home);
              }
              return home;
            },
            async initialize(id, source) {
              const home = await homes.initialize(id, source);
              mark(home);
              return home;
            },
            async compareAndSwap(expected, next) {
              const result = await homes.compareAndSwap(expected, next);
              if (result.kind === "applied" && result.home.state === "moving") mark(result.home);
              return result;
            },
          };
          return relocate(request, { ...relocatePorts, homes: moveHomes }, { clock: localClock, timeoutMs: config.limits.readyMs });
        }, () => homes.read(request.sessionId));
      },
      setHome(request) {
        return operations.enqueue(request.sessionId, async () => {
          if (forgotten(request.destinationMachine)) return revokedDestination;
          return setHome(request,setHomePorts,config);
        });
      },
    },
      close() {return closing ??= (async()=>{sync.stop();try {await sync.drain();await adapters.dispose();}finally{closeStores();}})();},
    };
  } catch(error) {closeStores();throw error;}
}
export async function runV0Agent(input: unknown, root: string): Promise<V0Result<unknown>> {
  const runtime=createV0Runtime(root);
  try {return await handleRelocateAgent(input,runtime.options);}
  finally {await runtime.close();}
}
export class V0HubLockRefusal extends Error {
  constructor(cause: unknown) {
    super("Stop the existing roaming hub before starting the v0 hub. If none is running, run spider roam doctor.", { cause });
  }
}

async function withV0HubLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  // Use the same process-start identity as the legacy production hub.
  const self = await probeLocal(process.pid, false);
  if (self.kind !== "live") throw new Error("Cannot verify the hub process identity");
  let entered = false;
  try {
    return await withProcessLock(join(root,"roam"), "roam-hub", () => {
      entered = true;
      return run();
    }, { identity: { pid:process.pid,startIdentity:self.startIdentity }, timeoutMs:100,
      async probe(pid, owner) {
        const observed = await probeLocal(pid, false);
        if (owner && observed.kind === "live" && observed.startIdentity !== owner.startIdentity) {
          const format = /^(posix|linux):/.exec(owner.startIdentity)?.[0];
          if (format && observed.startIdentity.startsWith(format)) return {kind:"absent"};
        }
        return observed;
      },
    });
  } catch (error) {
    if (!entered && /^lock-/.test((error as { code?: string } | null)?.code ?? "")) throw new V0HubLockRefusal(error);
    throw error;
  }
}

export async function recoverMacHomeWithoutHub(root: string, request: Parameters<V0ControlServices["setHome"]>[0]): ReturnType<V0ControlServices["setHome"]> {
  return withV0HubLock(root, async () => {
    const config = readLocalIdentity(root);
    if (config.enabled || config.role !== "hub" || config.machineId !== config.hubMachineId || request.destinationMachine !== config.machineId) {
      return {ok:false,refusal:{code:"home-unavailable",message:"Local reassignment requires disabled roaming on the Mac.",
        nextStep:"If roaming is enabled, start the v0 hub on the Mac and retry set-home --force."}};
    }
    const runtime = createV0Runtime(root);
    try { return await runtime.services.setHome(request); }
    finally { await runtime.close(); }
  });
}

export async function startV0Hub(root: string, overrides: V0RuntimeOverrides = {}): Promise<{stop():Promise<void>}> {
  let ready!: (service: { stop(): Promise<void> }) => void, rejectReady!: (error: unknown) => void;
  const started = new Promise<{stop():Promise<void>}>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const lifetime = withV0HubLock(root, async () => {
    const service = await startLockedV0Hub(root, overrides);
    ready({ stop() { release(); return lifetime; } });
    try { await hold; } finally { await service.stop(); }
  });
  void lifetime.catch(rejectReady);
  return started;
}

async function startLockedV0Hub(root: string, overrides: V0RuntimeOverrides): Promise<{stop():Promise<void>}> {
  const runtime=createV0Runtime(root,overrides);
  try {
    if(runtime.options.config.role!=="hub" || runtime.options.config.machineId!==runtime.options.config.hubMachineId)throw new Error("mac-required");
    const socket=await serveV0Control(root,runtime.services);
    let cancelConfigCheck: (() => void) | undefined;
    let enabled: boolean | undefined;
    const checkConfig = () => {
      const next = runtime.options.config.enabled;
      if (enabled !== next) {
        enabled = next;
        if (next) runtime.sync.start(); else runtime.sync.stop();
      }
      cancelConfigCheck = runtime.options.clock.later(1_000, checkConfig);
    };
    checkConfig();
    let stopping:Promise<void>|undefined;
    return {stop(){return stopping ??= (async()=>{
      cancelConfigCheck?.(); runtime.sync.stop();
      try{await socket.close();}finally{await runtime.close();}
    })();}};
  } catch(error) {await runtime.close();throw error;}
}
export async function startV0Supervisor(root: string, overrides: V0RuntimeOverrides = {}): Promise<{stop():Promise<void>}> {
  const runtime=createV0Runtime(root,overrides);
  try {
    const supervisor=createHomeSupervisor(runtime.adapters.supervisor);supervisor.start();
    let stopping:Promise<void>|undefined;
    return {stop(){return stopping ??= (async()=>{try{await supervisor.stop();}finally{await runtime.close();}})();}};
  } catch(error) {await runtime.close();throw error;}
}
