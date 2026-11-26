import { execFile } from "node:child_process";
import { join } from "node:path";
import { openDb } from "@spider/db-core";
import { createStorePort } from "../stores";
import { openLocalCore, type LocalCore } from "../runtime";
import { openJournal } from "../journal";
import { createTransport } from "../transport";
import { createSync } from "../sync";
import type { Clock, GitPorts, Transport } from "../contracts";
import { openOutgoingStaging } from "../staging";
import { createHomeStore } from "./home";
import { relocate } from "./relocate";
import { setHome } from "./set-home";
import { createRelocateAdapters } from "./adapters";
import { createV0SyncTransport, createV0ArtifactTransport, handleRelocateAgent } from "./remote";
import { localLaunchEnvironment } from "./local";
import { parseCaptured } from "./journal";
import { resolveVerifiedArtifact } from "./transfer";
import { createHomeSupervisor } from "./supervisor";
import { serveV0Control } from "./service";
import type { RelocateAdapterOptions, RelocateAdapters, HomeStore, V0ControlServices, V0Result } from "./types";

export interface V0RuntimeOverrides {
  openCore?: (root: string) => LocalCore;
  transport?: Transport;
  clock?: Clock;
  gitRun?: GitPorts["run"];
}
export interface V0Runtime {
  options: RelocateAdapterOptions;
  adapters: RelocateAdapters;
  homes: HomeStore;
  sync: ReturnType<typeof createSync>;
  services: V0ControlServices;
  close(): Promise<void>;
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
  const stores=createStorePort(core.config,core.db);
  try {
    const journal=openJournal(join(root,"roam","journal.db"));
    const homes=createHomeStore({db:core.db,hubMachineId:core.config.hubMachineId,localMachineId:core.config.machineId});
    const raw=overrides.transport ?? createTransport({binary:process.env.SPIDER_ROAM_HC ?? "hc",env:{...localLaunchEnvironment(),SPIDER_GLOBAL_ROOT:root},enrolled:core.config.peers});
    const transport=createV0ArtifactTransport(createV0SyncTransport(raw),core.config.machineId);
    const localClock=overrides.clock ?? clock;
    const sync=createSync({config:core.config,globalDb:core.db,transport,journal,clock:localClock,stores});
    const git:GitPorts={run:overrides.gitRun ?? runGit,journal,limits:core.config.limits,scratch:join(root,"roam","staging"),worktreeCommand:null};
    const options:RelocateAdapterOptions={root,config:core.config,globalDb:core.db,homes,journal,sync,transport:raw,clock:localClock,git,limits:core.config.limits,workspaceImport:{...git,
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
    let closing:Promise<void>|undefined;
    return {options,adapters,homes,sync,services:{relocate:request=>relocate(request,adapters.ports),setHome:request=>setHome(request,adapters.setHome)},
      close() {return closing ??= (async()=>{sync.stop();try {await sync.drain();await adapters.dispose();}finally{stores.close();core.close();}})();},
    };
  } catch(error) {stores.close();core.close();throw error;}
}
export async function runV0Agent(input: unknown, root: string): Promise<V0Result<unknown>> {
  const runtime=createV0Runtime(root);
  try {return await handleRelocateAgent(input,runtime.options);}
  finally {await runtime.close();}
}
export async function startV0Hub(root: string, overrides: V0RuntimeOverrides = {}): Promise<{stop():Promise<void>}> {
  const runtime=createV0Runtime(root,overrides);
  try {
    if(runtime.options.config.role!=="hub" || runtime.options.config.machineId!==runtime.options.config.hubMachineId)throw new Error("mac-required");
    const socket=await serveV0Control(root,runtime.services);
    runtime.sync.start();
    let stopping:Promise<void>|undefined;
    return {stop(){return stopping ??= (async()=>{try{await socket.close();}finally{await runtime.close();}})();}};
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
