import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import { isMachineId } from "../machine-id";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { resolveParticipantPi } from "../launcher";
import { pullArtifact, stageArtifact, transferArtifact } from "../artifacts";
import { storedManifestLimits } from "../artifact-layout";
import type { Peer } from "../contracts";
import { createRelocateJournal, parseCaptured, parseHome, parsePlacement, parsePlan, text, object } from "./journal";
import { callV0, createV0ArtifactTransport, handleRelocateAgent, refusal } from "./remote";
import { createLocalRuntime, exactHome, inspectLocalSource, inspectLocalDestination, seedLocalPlacement, captureOrdinarySource, type LocalSource } from "./local";
import { captureLocalSession, installLocalSession, stagingRoot } from "./transfer";
import type { RelocateAdapterOptions, RelocateAdapters, RelocateId, RelocatePorts, SessionId, SessionPlacement, SettledHome, V0Result, RelocatePlan, CapturedSession, RunningHome, InstalledSession } from "./types";

export function createRelocateAdapters(options: RelocateAdapterOptions): RelocateAdapters {
  const local=createLocalRuntime(options),journal=createRelocateJournal(options.journal,options.config.hubMachineId);
  const artifactTransport=createV0ArtifactTransport(options.transport,options.config.machineId);
  const hub=options.config.machineId===options.config.hubMachineId && options.config.role==="hub";
  async function peer(machineId:string):Promise<Peer> {
    const configured=options.config.peers.find(p=>p.machineId===machineId);if(!configured)throw new Error("Peer not configured");
    const resolved=await options.transport.resolve(configured,{timeoutMs:options.limits.controlMs});if(resolved.machineId!==machineId)throw new Error("Peer identity changed");return resolved;
  }
  async function rpc(machineId:string,input:unknown):Promise<V0Result<Record<string,unknown>>> {
    if(machineId===options.config.machineId) {
      const result=await handleRelocateAgent(input,options);return result as V0Result<Record<string,unknown>>;
    }
    return callV0(options.transport,await peer(machineId),input,options.limits);
  }
  async function sourceInfo(machineId:string,id:SessionId,allowStopped=false):Promise<V0Result<LocalSource>> {
    if(machineId===options.config.machineId)return inspectLocalSource(id,options,allowStopped);
    try {
      const result=await rpc(machineId,{version:1,kind:"source",sessionId:id,allowStopped});if(!result.ok)return result;
      const value=result.value,placement=parsePlacement(value.placement);text(value.root);text(value.head);
      if(placement.machineId!==machineId || placement.sessionId!==id || !Number.isSafeInteger(value.epoch) || (value.epoch as number)<1 || !["active","frozen"].includes(value.state as string) || typeof value.relativeCwd!=="string")throw new Error("Invalid source reply");
      return {ok:true,value:{placement,epoch:value.epoch as number,state:value.state as "active"|"frozen",root:value.root,relativeCwd:value.relativeCwd,head:value.head}};
    }catch{return refusal("source-unreachable","The source v0 agent is unreachable.");}
  }
  async function initialSource(id:SessionId):Promise<V0Result<string>> {
    if(!hub)return refusal("mac-required","Only the hub can select the initial home.","Run spider roam relocate on the Mac.");
    try {
      const legacy=options.globalDb.prepare("SELECT machine_id,epoch,move_id FROM session_homes WHERE session_id=?").get(id) as {machine_id:string;epoch:number;move_id:string|null}|undefined;
      const location=options.globalDb.prepare("SELECT home_json FROM roam_locations WHERE session_id=?").get(id) as {home_json:string|null}|undefined;
      const catalog=location?.home_json?object(JSON.parse(location.home_json)):null;
      const known=legacy?.machine_id??catalog?.machineId;
      if(legacy && (!isMachineId(legacy.machine_id) || legacy.move_id!==null))return refusal("home-conflict","The legacy home is unowned or has an unfinished move.");
      if(known!==undefined) {
        if(!isMachineId(known))return refusal("home-conflict","The source has no ordinary home owner.");
        const ready=await sourceInfo(known,id);if(!ready.ok)return ready;
        if(ready.value.state!=="active" || legacy && legacy.epoch!==ready.value.epoch)return refusal("home-conflict","The source membership is not active at its home epoch.");
        return {ok:true,value:known};
      }
      const candidates:string[]=[];
      for(const machine of [options.config.machineId,...options.config.peers.map(p=>p.machineId)]) {
        const ready=await sourceInfo(machine,id);
        if(ready.ok)candidates.push(machine);
        else if(ready.refusal.code==="source-unreachable")return ready;
      }
      return candidates.length===1?{ok:true,value:candidates[0]}:candidates.length?refusal("ambiguous-session",`The session is active on multiple machines: ${candidates.join(", ")}.`):refusal("session-not-found","No ordinary active source was found.");
    }catch{return refusal("home-unavailable","The source catalog could not be read safely.");}
  }
  async function available(machineId:string,source:boolean):Promise<V0Result<void>> {
    if(machineId===options.config.machineId)return resolveParticipantPi()?{ok:true,value:undefined}:refusal("destination-not-provisioned","The local pi executable is unavailable.","Install pi and spider before retrying.");
    try {
      const reply=await rpc(machineId,{version:1,kind:"hello"});if(!reply.ok)return reply;
      if(reply.value.machineId!==machineId || reply.value.pi!==true || reply.value.spider!==true)return refusal("destination-not-provisioned",`The ${source?"source":"destination"} needs executable pi and spider with v0 support.`,"Install pi and spider on that machine before retrying.");
      return {ok:true,value:undefined};
    }catch{return refusal(source?"source-unreachable":"destination-unreachable",`The ${source?"source":"destination"} v0 agent is unreachable.`);}
  }
  async function check(request:Parameters<RelocatePorts["check"]>[0],source:SettledHome,moveId:RelocateId):Promise<V0Result<RelocatePlan>> {
    if(!hub)return refusal("mac-required","Relocation must run on the hub.","Run spider roam relocate on the Mac.");
    if(!options.config.enabled)return refusal("replication-disabled","Replication is disabled.","Enable roaming replication, then retry relocate.");
    const destinationAvailable=await available(request.destinationMachine,false);if(!destinationAvailable.ok)return destinationAvailable;
    const sourceAvailable=await available(source.machineId,true);if(!sourceAvailable.ok)return sourceAvailable;
    const ready=await sourceInfo(source.machineId,request.sessionId,source.state==="stopped");if(!ready.ok)return ready;
    if(ready.value.epoch!==source.epoch || ready.value.placement.sessionId!==source.sessionId)return refusal("home-conflict","The source membership epoch changed before check.");
    let destination:SessionPlacement,head:string;
    try {
      if(request.destinationMachine===options.config.machineId) {
        const result=await inspectLocalDestination(ready.value.placement,ready.value.relativeCwd,options);if(!result.ok)return result;destination=result.value.placement;head=result.value.head;
      } else {
        const result=await rpc(request.destinationMachine,{version:1,kind:"destination",source:ready.value.placement,relativeCwd:ready.value.relativeCwd});if(!result.ok)return result;
        destination=parsePlacement(result.value.placement);text(result.value.head);head=result.value.head;
        if(destination.machineId!==request.destinationMachine || destination.sessionId!==request.sessionId)throw new Error("Destination placement mismatch");
      }
      let prerequisite=false;
      if(source.machineId===options.config.machineId) {
        try {await options.git.run(ready.value.root,["git","cat-file","-e",`${head}^{commit}`]);await options.git.run(ready.value.root,["git","merge-base","--is-ancestor",head,ready.value.head]);prerequisite=true;}catch{/* full bundle */}
      }else{
        const reply=await rpc(source.machineId,{version:1,kind:"prerequisite",sessionId:request.sessionId,candidate:head,allowStopped:source.state==="stopped"});if(!reply.ok)return reply;prerequisite=reply.value.available===true;
      }
      if(source.machineId===options.config.machineId) {
        if(ready.value.state==="frozen") {
          const reply=await rpc(source.machineId,{version:1,kind:"seed",placement:ready.value.placement,epoch:source.epoch,allowStopped:true});if(!reply.ok)return reply;
        }else await seedLocalPlacement(ready.value.placement,source.epoch,options);
      }else{const reply=await rpc(source.machineId,{version:1,kind:"seed",placement:ready.value.placement,epoch:source.epoch,allowStopped:source.state==="stopped"});if(!reply.ok)return reply;}
      const plan=parsePlan({moveId,source,sourcePlacement:ready.value.placement,destinationPlacement:destination,destinationPrerequisites:prerequisite?[head]:[],startedAt:options.clock.now()});
      return {ok:true,value:plan};
    }catch{return refusal("unsupported-workspace","The source or destination checkout could not pass v0 check.");}
  }
  async function sync(machineId:string):Promise<V0Result<void>> {
    if(machineId===options.config.machineId)return {ok:true,value:undefined};
    try {const results=await options.sync.sync(machineId);return results.every(result=>result.code===0)?{ok:true,value:undefined}:refusal("sync-failed","The final row synchronization did not complete.");}
    catch{return refusal("sync-failed","The peer row synchronization could not complete.");}
  }
  const machines={
    async locate(machineId:string,id:SessionId):Promise<V0Result<SessionPlacement>> {
      if(machineId===options.config.machineId)return local.locate(machineId,id);
      try{const result=await rpc(machineId,{version:1,kind:"locate",sessionId:id});if(!result.ok)return result;const placement=parsePlacement(result.value.placement);return placement.machineId===machineId && placement.sessionId===id?{ok:true,value:placement}:refusal("destination-copy-missing","The remote copy has a different identity.");}catch{return refusal("destination-copy-missing","No verified destination copy is available.");}
    },
    async publishHome(home:Parameters<RelocatePorts["publishHome"]>[0],machineId:string):Promise<V0Result<void>> {
      if(machineId===options.config.machineId)return local.publishHome(home,machineId);
      const synchronized=await sync(machineId);if(!synchronized.ok)return synchronized;
      try{const reply=await rpc(machineId,{version:1,kind:"home",sessionId:home.sessionId});if(!reply.ok)return reply;const observed=reply.value.home===null?null:parseHome(reply.value.home);return exactHome(observed,home)?{ok:true,value:undefined}:refusal("sync-failed","The peer has not replicated the exact requested home.");}catch{return refusal("sync-failed","The peer home could not be read back.");}
    },
    async activate(home:RunningHome,placement:SessionPlacement):Promise<V0Result<void>> {
      if(home.machineId===options.config.machineId)return local.activate(home,placement);
      try{const reply=await rpc(home.machineId,{version:1,kind:"activate",home,placement});return reply.ok?{ok:true,value:undefined}:reply;}catch{return refusal("install-failed","The destination membership could not be activated.");}
    },
    async start(home:RunningHome,placement:SessionPlacement):Promise<V0Result<{terminal:string}>> {
      if(home.machineId===options.config.machineId)return local.start(home,placement);
      try{const reply=await rpc(home.machineId,{version:1,kind:"start",home,placement});if(!reply.ok)return reply;text(reply.value.terminal);return {ok:true,value:{terminal:reply.value.terminal}};}catch{return refusal("start-pending","The destination launch reply is pending.");}
    },
    async confirm(home:RunningHome,placement:SessionPlacement):Promise<V0Result<{terminal:string}>> {
      if(home.machineId===options.config.machineId)return local.confirm(home,placement);
      try{const reply=await rpc(home.machineId,{version:1,kind:"confirm",home,placement});if(!reply.ok)return reply;text(reply.value.terminal);return {ok:true,value:{terminal:reply.value.terminal}};}catch{return refusal("start-pending","The destination ID-lock owner is not confirmed.");}
    },
  };
  async function ownerAt(machineId:string,id:SessionId):Promise<boolean> {
    if(machineId===options.config.machineId)return (await local.owner(id)).kind==="free";
    const result=await rpc(machineId,{version:1,kind:"owner",sessionId:id});return result.ok && object(result.value.owner).kind==="free";
  }
  const shared={homes:options.homes,newMoveId:()=>`v0-${randomUUID()}` as RelocateId,withSession:async<T>(id:SessionId,run:()=>Promise<T>):Promise<T>=>{
    if(!hub)throw new Error("Only the hub may mutate a v0 home");return withProcessLock(join(options.root,"roam","v0-locks"),id,run,{timeoutMs:options.limits.controlMs});
  },...machines};
  const ports:RelocatePorts={...shared,journal,initialSource,check,
    async stopSource(plan,moving){
      if(plan.source.machineId===options.config.machineId){
        const stopped=await local.stop(plan.source.sessionId,moving);if(!stopped.ok)return stopped;
        try {await captureOrdinarySource(plan,options);}
        catch {return refusal("stop-timeout","The stopped ordinary source could not be captured.");}
        // Freeze any membership created after the first, confirmed stop.
        return local.stop(plan.source.sessionId,moving);
      }
      try{const reply=await rpc(plan.source.machineId,{version:1,kind:"stop",sessionId:plan.source.sessionId,moving});return reply.ok?{ok:true,value:undefined}:reply;}catch{return refusal("stop-timeout","The source stop acknowledgement is unavailable.");}
    },
    async pullSource(plan) {
      try {
        if(!await ownerAt(plan.source.machineId,plan.source.sessionId))return refusal("stop-timeout","The source ID lock is not free for final row sync.");
        const rows=await sync(plan.source.machineId);if(!rows.ok)return rows;
        let captured:CapturedSession;
        if(plan.source.machineId===options.config.machineId){const result=await captureLocalSession(plan,options,()=>local.owner(plan.source.sessionId));if(!result.ok)return result;captured=result.value;}
        else{
          const reply=await rpc(plan.source.machineId,{version:1,kind:"capture",plan});if(!reply.ok)return reply;captured=parseCaptured(reply.value.captured);
          const p=await peer(plan.source.machineId);
          for(const [kind,manifest] of [["session",captured.transcriptArtifact],["workspace",captured.bundleArtifact]] as const){
            const pulled=await pullArtifact(p,manifest,{transport:artifactTransport,journal:options.journal,root:stagingRoot(options),limits:options.limits,operationId:`${plan.moveId}-pull-${kind}`});if(pulled.code!==0 || !pulled.value)return refusal("transfer-failed","A final source artifact could not be pulled.");
            await stageArtifact(pulled.value.file,manifest.kind,storedManifestLimits(manifest,options.limits),{root:stagingRoot(options),artifactId:manifest.id});
          }
        }
        return {ok:true,value:captured};
      }catch{return refusal("transfer-failed","The stopped source could not be pulled safely.");}
    },
    async pushDestination(plan,captured){
      try {
        const authorized=await rpc(plan.destinationPlacement.machineId,{version:1,kind:"authorize",plan});if(!authorized.ok)return authorized;
        const rows=await sync(plan.destinationPlacement.machineId);if(!rows.ok)return rows;
        if(plan.destinationPlacement.machineId!==options.config.machineId){const p=await peer(plan.destinationPlacement.machineId);for(const [kind,manifest]of[["session",captured.transcriptArtifact],["workspace",captured.bundleArtifact]]as const){const pushed=await transferArtifact(p,manifest,{transport:artifactTransport,journal:options.journal,root:stagingRoot(options),limits:options.limits,operationId:`${plan.moveId}-push-${kind}`});if(pushed.code!==0)return refusal("transfer-failed","A destination artifact transfer did not complete.");}}
        return {ok:true,value:undefined};
      }catch{return refusal("transfer-failed","The destination rows and artifacts could not be pushed.");}
    },
    async installDestination(plan,captured,home):Promise<V0Result<InstalledSession>>{
      if(home.machineId===options.config.machineId)return installLocalSession(plan,captured,home,options,undefined,()=>local.owner(home.sessionId));
      try{const result=await rpc(home.machineId,{version:1,kind:"install",plan,captured,home});if(!result.ok)return result;const installed=object(result.value.installed);parsePlacement(installed.placement);object(installed.session);return {ok:true,value:installed as unknown as InstalledSession};}catch{return refusal("install-failed","The destination install acknowledgement is unavailable.");}
    },
  };
  return {ports,setHome:shared,supervisor:{machineId:options.config.machineId,clock:options.clock,entries:local.entries,owner:local.owner,stop:id=>local.stop(id),activate:local.activate,start:local.start,report(sessionId,refusal){writeLocal(options.globalDb,"relocate-supervisor-refusal",sessionId??"service",refusal);}},async dispose(){/* Per-call local stores and staging handles are already closed. */}};
}
