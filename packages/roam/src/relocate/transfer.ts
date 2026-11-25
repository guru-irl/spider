import { join, dirname, relative, isAbsolute } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { claimIdLock, localBootId } from "@spider/herdr/sessions/id-lock";
import { canonicalSessionFile, withProcessLock } from "@spider/herdr/sessions/registry";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";
import { mapWorkspace } from "@spider/db-core/roam/repo-map";
import { writeLocal } from "@spider/db-core/roam/local-state";
import type { ArtifactManifest, WorkspaceSnapshot } from "../contracts";
import { stageArtifact } from "../artifacts";
import { storedManifestLimits } from "../artifact-layout";
import { snapshotWorkspace } from "../workspace";
import { bundleWorkspace } from "../git-bundle";
import { prepareWorkspace, verifyWorkspace } from "../workspace-import";
import { createStorePort } from "../stores";
import { inspectSession, stageSession, installSession } from "../session-file";
import { openOutgoingStaging, openStaging, privateDirectory, readPrivate, sourceChunk, validateManifest, writeImmutable, verifyStagedFile } from "../staging";
import { createLocalRuntime, digestIdentity, exactHome, probeLocalProcess } from "./local";
import { json, parseCaptured, parsePlan, parsePlacement } from "./journal";
import { refusal } from "./remote";
import type { CapturedSession, InstalledSession, RelocateAdapterOptions, RelocatePlan, RunningHome, SessionOwner, V0Result } from "./types";

export const stagingRoot = (options: RelocateAdapterOptions): string => join(options.root,"roam","staging");
export function beginLocalMove(plan: RelocatePlan, options: RelocateAdapterOptions): void {
  parsePlan(plan);
  options.journal.begin({id:plan.moveId,machineId:options.config.hubMachineId,expectedEpoch:plan.source.epoch,kind:"relocate-v0",args:json({plan})});
}
/** Resolve only verified bytes in this machine's private transfer stores. */
export async function resolveVerifiedArtifact(manifest: ArtifactManifest, sourceMachine: string, options: RelocateAdapterOptions): Promise<string> {
  const limits=storedManifestLimits(manifest,options.limits);validateManifest(manifest,limits);
  const root=stagingRoot(options),store=openStaging(root,sourceMachine,limits);
  try {
    try {const file=store.assemble(manifest);verifyStagedFile(file,manifest);return file;}
    catch {
      // A local capture has immutable outgoing chunks but no incoming assembly.
      const outgoing=openOutgoingStaging(root,limits);
      try {
        const current=outgoing.inspect(manifest.id).current;
        if (!current || current.sha256!==manifest.sha256 || current.byteLength!==manifest.byteLength || JSON.stringify(current.chunks)!==JSON.stringify(manifest.chunks)) throw new Error("Verified artifact is unavailable");
        store.declare(manifest,`v0-local-${manifest.id}`);
        for(const chunk of manifest.chunks)store.receive(manifest,chunk.index,readPrivate(sourceChunk(root,manifest.id,chunk.index,chunk.sha256),chunk.rawLength));
        const file=store.assemble(manifest);verifyStagedFile(file,manifest);return file;
      } finally {outgoing.close();}
    }
  } finally {store.close();}
}
export async function captureLocalSession(plan: RelocatePlan, options: RelocateAdapterOptions, owner: ()=>Promise<SessionOwner> = ()=>createLocalRuntime(options).owner(plan.source.sessionId)): Promise<V0Result<CapturedSession>> {
  try {
    beginLocalMove(plan,options);
    const home=await options.homes.read(plan.source.sessionId);
    if (!home || home.state!=="moving" || home.moveId!==plan.moveId || home.epoch!==plan.source.epoch+1 || home.machineId!==options.config.machineId || home.destination!==plan.destinationPlacement.machineId) return refusal("home-conflict","The source is not in this move's moving home.");
    if ((await owner()).kind!=="free") return refusal("stop-timeout","The source ID lock must be free before final capture.");
    const prior=options.journal.read(plan.moveId).filter(row=>row.action==="relocate-capture").at(-1);
    if(prior)return {ok:true,value:parseCaptured(prior.result.captured)};
    const root=(await options.git.run(plan.sourcePlacement.cwd,["git","rev-parse","--show-toplevel"])).toString().trim();
    const git={...options.git,journal:options.journal,scratch:stagingRoot(options),worktreeCommand:null};
    const snapshot=await snapshotWorkspace({root,cwd:plan.sourcePlacement.cwd,repoKey:plan.sourcePlacement.repoKey,workspaceId:plan.sourcePlacement.workspaceId,moveId:plan.moveId,stage:"final",writers:[]},{...git,run:(cwd,argv,call)=>git.run(cwd,["git",...argv],call)});
    let workspace: CapturedSession["workspace"];
    if(plan.destinationPrerequisites.length) {
      workspace=await bundleWorkspace({...snapshot,prerequisites:plan.destinationPrerequisites},plan.destinationPrerequisites,git) as CapturedSession["workspace"];
    } else {
      const artifactId=`workspace-${digestIdentity(JSON.stringify([plan.moveId,snapshot.repoKey,snapshot.workspaceId,snapshot.stage]))}`;
      const directory=join(stagingRoot(options),"v0-bundles",digestIdentity(plan.moveId));privateDirectory(directory);
      const file=join(directory,"workspace.bundle");
      // Full history is required when the machines share no verified base.
      await git.run(root,["git","bundle","create",file,...snapshot.refs]);
      await git.run(root,["git","bundle","verify",file]);
      const manifest=await stageArtifact(file,"workspace",options.limits,{root:stagingRoot(options),artifactId});
      workspace={...snapshot,prerequisites:[],bundle:{kind:"ready",artifactId,byteLength:manifest.byteLength}};
      options.journal.record(plan.moveId,"workspace-bundle",{artifactId,byteLength:manifest.byteLength,stage:"final"});
    }
    const session=await inspectSession(plan.sourcePlacement.file,plan.source.sessionId,undefined,options.limits);
    const transcriptArtifact=await stageArtifact(session.file,"session",options.limits,{root:stagingRoot(options),artifactId:`session-${digestIdentity(plan.moveId)}`});
    const outgoing=openOutgoingStaging(stagingRoot(options),options.limits);
    let bundleArtifact:ArtifactManifest;
    try {const found=outgoing.inspect(workspace.bundle.artifactId).current;if(!found)throw new Error("Bundle staging missing");bundleArtifact=found;}finally{outgoing.close();}
    const captured:CapturedSession={session:{...session,artifactId:transcriptArtifact.id},workspace,transcriptArtifact,bundleArtifact};
    parseCaptured(captured);options.journal.record(plan.moveId,"relocate-capture",json({captured}));
    return {ok:true,value:captured};
  } catch {return refusal("transfer-failed","The stopped source could not be captured into verified artifacts.");}
}

async function withPhysicalLocks<T>(options:RelocateAdapterOptions,file:string,id:string,run:()=>Promise<T>):Promise<T> {
  const root=join(options.root,"herdr"),startIdentity=processStartIdentity(process.pid);
  if(!startIdentity)throw new Error("Local identity unavailable");
  const held=await claimIdLock(root,id,{pid:process.pid,startIdentity},probeLocalProcess,{bootId:localBootId});
  try {
    const canonical=await canonicalSessionFile(file);
    return await withProcessLock(root,`lease:${canonical}`,async()=>{
      const lease=await createSessionLeases(root).get(canonical);
      if(lease && (await probeLocalProcess(lease.pid)).kind!=="absent")throw new Error("Exact-file lease is occupied");
      return run();
    });
  } finally {await held.release();}
}
/** The old importer needs a first local preparation; no source pre-stage occurs. */
async function initialImportSnapshot(snapshot:CapturedSession["workspace"],bundleFile:string,options:RelocateAdapterOptions):Promise<{snapshot:WorkspaceSnapshot;file:string}> {
  const bytes=readPrivate(bundleFile,options.limits.workspaceBytes),boundary=bytes.indexOf("\n\n");
  if(boundary<0)throw new Error("Invalid bundle header");
  const oldRefs=snapshot.refs,newRefs=oldRefs.map(ref=>ref.replace(`/${snapshot.moveId}/final/`,`/${snapshot.moveId}/pre/`));
  let header=bytes.subarray(0,boundary).toString("utf8");
  for(let i=0;i<oldRefs.length;i++) {
    if(!header.includes(` ${oldRefs[i]}\n`) && !header.endsWith(` ${oldRefs[i]}`))throw new Error("Bundle ref missing");
    header=header.replace(` ${oldRefs[i]}`,` ${newRefs[i]}`);
  }
  const directory=join(stagingRoot(options),"v0-install",digestIdentity(snapshot.moveId));privateDirectory(directory);
  const file=join(directory,"initial.bundle");writeImmutable(file,Buffer.concat([Buffer.from(header),bytes.subarray(boundary)]));
  const manifest=await stageArtifact(file,"workspace",options.limits,{root:stagingRoot(options),artifactId:`${snapshot.bundle.artifactId}-initial`});
  return {snapshot:{...snapshot,stage:"pre",refs:newRefs,bundle:{kind:"ready",artifactId:manifest.id,byteLength:manifest.byteLength}},file};
}
export async function installLocalSession(plan:RelocatePlan,captured:CapturedSession,home:RunningHome,options:RelocateAdapterOptions,withBothLocks?:<T>(id:string,run:()=>Promise<T>)=>Promise<T>,owner:()=>Promise<SessionOwner>=()=>createLocalRuntime(options).owner(home.sessionId)):Promise<V0Result<InstalledSession>> {
  try {
    beginLocalMove(plan,options);parseCaptured(captured);
    const placement=parsePlacement(plan.destinationPlacement),current=await options.homes.read(home.sessionId);
    if(home.sessionId!==plan.source.sessionId || home.machineId!==options.config.machineId || home.machineId!==placement.machineId || home.epoch!==plan.source.epoch+2 || home.moveId!==plan.moveId || !(exactHome(current,home) || current?.state==="moving" && current.moveId===plan.moveId && current.machineId===plan.source.machineId && current.destination===home.machineId && current.epoch===plan.source.epoch+1))return refusal("home-conflict","The home does not authorize this destination install.");
    if((await owner()).kind!=="free")return refusal("install-failed","The destination ID lock is occupied or uncertain.");
    const transcript=await resolveVerifiedArtifact(captured.transcriptArtifact,options.config.hubMachineId,options);
    const bundle=await resolveVerifiedArtifact(captured.bundleArtifact,options.config.hubMachineId,options);
    const repo=options.globalDb.prepare("SELECT path,worktree_command_json FROM roam_repo_maps WHERE repo_key=?").get(placement.repoKey) as {path:string;worktree_command_json:string|null}|undefined;
    if(!repo || repo.path!==placement.repository)return refusal("repo-unmapped","The destination repository mapping changed.","Run spider roam repo map on the destination, then retry.");
    if(repo.worktree_command_json!==null)return refusal("unsupported-workspace","Configured worktree commands are not supported by v0.");
    const cwdParts=captured.workspace.relativeCwd.split(/[\\/]/).filter(Boolean);
    let checkout=placement.cwd;for(const _part of cwdParts)checkout=dirname(checkout);
    if(join(checkout,captured.workspace.relativeCwd)!==placement.cwd)return refusal("install-failed","The destination cwd does not match the mapped checkout.");
    privateDirectory(dirname(checkout));
    const initial=await initialImportSnapshot(captured.workspace,bundle,options);
    const imports={...options.workspaceImport,journal:options.journal,worktreeCommand:null,
      run:async(cwd:string,argv:readonly string[],call?:{env?:Readonly<NodeJS.ProcessEnv>;stdin?:Buffer})=>argv.length===4 && argv[0]==="git" && argv[1]==="fetch" && argv[2]==="--quiet" && argv[3]==="origin" ? Buffer.alloc(0) : options.workspaceImport.run(cwd,argv,call),
      resolveCommonRepository:async()=>repo.path,
      verifiedArtifactPath:async(id:string)=>id===captured.workspace.bundle.artifactId?bundle:initial.snapshot.bundle.kind==="ready" && id===initial.snapshot.bundle.artifactId?initial.file:options.workspaceImport.verifiedArtifactPath(id),
    };
    const prior=options.journal.read(plan.moveId).some(row=>row.action==="workspace-prepared" && row.result.root===checkout && row.result.stage==="final");
    if(!prior){const prepared=await prepareWorkspace(initial.snapshot,checkout,imports);await verifyWorkspace(prepared,imports);}
    const prepared=await prepareWorkspace(captured.workspace,checkout,imports);await verifyWorkspace(prepared,imports);
    const incoming=createStorePort(options.config,options.globalDb,{unmappedWorktree:`worktree:${placement.repoKey}:${placement.workspaceId}`});
    try {incoming.openStore(`worktree:${placement.repoKey}:${placement.workspaceId}`);}finally{incoming.close();}
    await mapWorkspace(options.globalDb,{repoKey:placement.repoKey,workspaceId:placement.workspaceId,path:checkout});
    const staged=await stageSession({source:{...captured.session,file:transcript},destinationCwd:placement.cwd,destinationParent:null,segment:{version:1,moveId:plan.moveId,epoch:home.epoch,previousMachine:plan.source.machineId,nextMachine:home.machineId,historyMachine:placement.historyMachine,parentRef:null},limits:options.limits},stagingRoot(options));
    await installSession(staged,placement.file,{journal:options.journal,limits:options.limits,
      withBothLocks:withBothLocks??((id,run)=>withPhysicalLocks(options,placement.file,id,run)),
      ownership:async()=>({kind:"absent"}),
    });
    const local=createLocalRuntime(options),activated=await local.activate(home,placement);if(!activated.ok)return activated;
    writeLocal(options.globalDb,"relocate-incoming",`worktree:${placement.repoKey}:${placement.workspaceId}`,undefined);
    const installed={placement,session:{...staged,file:placement.file}};
    options.journal.record(plan.moveId,"relocate-installed",json({installed}));
    return {ok:true,value:installed};
  } catch(error) {
    const message=error instanceof Error?error.message:"";
    return /workspace-(?:baseline|diverged|preparation-diverged|busy)/.test(message)?refusal("destination-dirty","The destination checkout is not an unchanged exported backup."):refusal("install-failed","The verified destination files could not be installed.");
  }
}
