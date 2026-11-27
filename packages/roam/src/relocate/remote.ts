import type { JsonObject, StoreKey } from "@spider/db-core/roam/types";
import { storeScope } from "@spider/db-core/roam/codec";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { createAgentPorts, handleAgentOperation, handleAgentArtifactRequest } from "../agent";
import { createStorePort } from "../stores";
import { resolveParticipantPi } from "../launcher";
import { createLocalRuntime, inspectLocalSource, inspectLocalDestination, seedLocalPlacement, exactHome } from "./local";
import { beginLocalMove, captureLocalSession, installLocalSession, stagingRoot } from "./transfer";
import { json, parseCaptured, parseHome, parsePlan, parsePlacement } from "./journal";
import type { Operation, Peer, Transport } from "../contracts";
import { object, text } from "./journal";
import { isMachineId } from "../machine-id";
import type { V0RefusalCode, V0Result, RelocateAdapterOptions, RelocatePlan, SessionId, SessionPlacement, RunningHome, MovingHome } from "./types";

export const dataKinds: ReadonlySet<string> = new Set(["stores", "inventory", "enable-capture", "export", "release-export", "split", "assemble", "cursor", "receipt", "import", "recheck-store"]);
export function refusal<T = never>(code: V0RefusalCode, message: string, nextStep = "Retry spider roam relocate with the same session and target."): V0Result<T> {
  return {ok:false,refusal:{code,message,nextStep}};
}
export function parseDataOperation(value: unknown): Operation {
  const op = object(value); text(op.id);
  if (!isMachineId(op.machineId) || op.expectedEpoch !== null || !dataKinds.has(op.kind as string)) throw new Error("Invalid v0 data operation");
  object(op.args);
  return value as Operation;
}
export async function callV0(transport: Transport, peer: Peer, input: unknown, limits: {controlMs:number;replyBytes:number}): Promise<V0Result<Record<string,unknown>>> {
  const bytes = await transport.exec(peer,["roam","agent","--v0"],{stdin:Buffer.from(JSON.stringify(input)),timeoutMs:limits.controlMs,maxBytes:limits.replyBytes});
  if (!Buffer.isBuffer(bytes) || bytes.length > limits.replyBytes) throw new Error("Invalid v0 reply size");
  const reply = object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));
  if (reply.ok === false) {
    const r = object(reply.refusal); text(r.code); text(r.message); text(r.nextStep);
    return {ok:false,refusal:r as unknown as {code:V0RefusalCode;message:string;nextStep:string}};
  }
  if (reply.ok !== true) throw new Error("Invalid v0 reply");
  const value = object(reply.value);
  if (value.version !== 1) throw new Error("Peer does not support v0 version 1");
  return {ok:true,value};
}
export type RelocateAgentRequest =
  | {version:1;kind:"data";operation:Operation}
  | {version:1;kind:"hello"}
  | {version:1;kind:"source"|"locate"|"home"|"owner";sessionId:SessionId;allowStopped?:boolean}
  | {version:1;kind:"destination";source:SessionPlacement;relativeCwd:string}
  | {version:1;kind:"seed";placement:SessionPlacement;epoch:number;allowStopped?:boolean}
  | {version:1;kind:"prerequisite";sessionId:SessionId;candidate:string;allowStopped?:boolean}
  | {version:1;kind:"authorize"|"capture";plan:RelocatePlan}
  | {version:1;kind:"install";plan:RelocatePlan;captured:NonNullable<import("./types").RelocateCheckpoint["captured"]>;home:RunningHome}
  | {version:1;kind:"activate"|"start"|"confirm";home:RunningHome;placement:SessionPlacement}
  | {version:1;kind:"stop";sessionId:SessionId;moving:MovingHome|null}
  | {version:1;kind:"artifact";sourceMachine:string;input:unknown;bytes:string|null};
export function parseAgentRequest(input: unknown): RelocateAgentRequest {
  const r=object(input);if(r.version!==1)throw new Error("Unsupported private protocol");
  switch(r.kind) {
    case "data":parseDataOperation(r.operation);break;
    case "hello":break;
    case "source":if(r.allowStopped!==undefined && typeof r.allowStopped!=="boolean")throw new Error("Invalid stopped flag");text(r.sessionId);break;
    case "locate":case "home":case "owner":text(r.sessionId);break;
    case "destination":parsePlacement(r.source);if(typeof r.relativeCwd!=="string" || r.relativeCwd.length>4096)throw new Error("Invalid relative cwd");break;
    case "seed":parsePlacement(r.placement);if(!Number.isSafeInteger(r.epoch)||(r.epoch as number)<1 || r.allowStopped!==undefined && typeof r.allowStopped!=="boolean")throw new Error("Invalid seed epoch");break;
    case "prerequisite":text(r.sessionId);if(typeof r.candidate!=="string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(r.candidate))throw new Error("Invalid prerequisite");break;
    case "authorize":case "capture":parsePlan(r.plan);break;
    case "install":parsePlan(r.plan);parseCaptured(r.captured);if(parseHome(r.home).state!=="running")throw new Error("Invalid install home");break;
    case "activate":case "start":case "confirm":if(parseHome(r.home).state!=="running")throw new Error("Invalid launch home");parsePlacement(r.placement);break;
    case "stop":text(r.sessionId);if(r.moving!==null && parseHome(r.moving).state!=="moving")throw new Error("Invalid stop home");break;
    case "artifact":if(!isMachineId(r.sourceMachine))throw new Error("Invalid artifact sender");object(r.input);if(!(r.bytes===null || typeof r.bytes==="string"))throw new Error("Invalid artifact bytes");break;
    default:throw new Error("Unsupported v0 operation");
  }
  return input as RelocateAgentRequest;
}
function mappedKey(key: StoreKey,options:RelocateAdapterOptions): boolean {
  if(key==="global")return true;
  if(key.startsWith("repo:"))return !!options.globalDb.prepare("SELECT 1 FROM roam_repo_maps WHERE repo_key=?").get(key.slice(5));
  const at=key.lastIndexOf(":");return !!options.globalDb.prepare("SELECT 1 FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").get(key.slice(9,at),key.slice(at+1));
}
export async function incomingPlan(key:StoreKey,options:RelocateAdapterOptions):Promise<RelocatePlan|null> {
  if(!key.startsWith("worktree:"))return null;
  const pointer=readLocal<unknown>(options.globalDb,"relocate-incoming",key);if(!pointer)return null;
  const p=object(pointer);text(p.moveId);
  const row=options.journal.read(p.moveId).filter(row=>row.action==="relocate-incoming").at(-1);if(!row)throw new Error("Incoming journal unavailable");
  const plan=parsePlan(row.result.plan);
  if(plan.moveId!==p.moveId || plan.destinationPlacement.machineId!==options.config.machineId || key!==`worktree:${plan.destinationPlacement.repoKey}:${plan.destinationPlacement.workspaceId}`)throw new Error("Incoming key does not match move");
  const home=await options.homes.read(plan.source.sessionId);
  if(home && !(home.epoch<plan.source.epoch) && !(home.state==="moving" && home.moveId===plan.moveId && home.machineId===plan.source.machineId && home.destination===options.config.machineId && home.epoch===plan.source.epoch+1) && !(home.state!=="moving" && home.machineId===plan.source.machineId && home.epoch<=plan.source.epoch))throw new Error("Incoming home changed");
  return plan;
}
export async function handleRelocateAgent(input:unknown,options:RelocateAdapterOptions):Promise<V0Result<unknown>> {
  let r:RelocateAgentRequest;
  try {r=parseAgentRequest(input);}catch{return refusal("invalid-arguments","The private v0 request is invalid.");}
  const wrap=<T>(result:V0Result<T>,key?:string):V0Result<unknown>=>result.ok?{ok:true,value:key?{version:1,[key]:result.value}:{version:1,...(result.value && typeof result.value==="object"?result.value:{})}}:result;
  try {
    switch(r.kind) {
      case "hello":return {ok:true,value:{version:1,machineId:options.config.machineId,pi:!!resolveParticipantPi(),spider:true}};
      case "home":return {ok:true,value:{version:1,home:await options.homes.read(r.sessionId)}};
      case "source":{
        const home=r.allowStopped?await options.homes.read(r.sessionId):null;
        return wrap(await inspectLocalSource(r.sessionId,options,!!r.allowStopped && home?.state==="stopped" && home.machineId===options.config.machineId));
      }
      case "destination":return wrap(await inspectLocalDestination(r.source,r.relativeCwd,options));
      case "prerequisite":{
        const home=r.allowStopped?await options.homes.read(r.sessionId):null;
        const source=await inspectLocalSource(r.sessionId,options,!!r.allowStopped && home?.state==="stopped" && home.machineId===options.config.machineId);
        if(!source.ok)return source;
        let available=false;
        try{await options.git.run(source.value.root,["git","cat-file","-e",`${r.candidate}^{commit}`]);await options.git.run(source.value.root,["git","merge-base","--is-ancestor",r.candidate,source.value.head]);available=true;}catch{/* transfer full history */}
        return {ok:true,value:{version:1,available}};
      }
      case "seed":{
        const home=r.allowStopped?await options.homes.read(r.placement.sessionId):null;
        const stopped=!!r.allowStopped && home?.state==="stopped" && home.machineId===options.config.machineId && home.epoch===r.epoch;
        const source=await inspectLocalSource(r.placement.sessionId,options,stopped);
        if(!source.ok)return source;
        if(source.value.epoch!==r.epoch || JSON.stringify(source.value.placement)!==JSON.stringify(r.placement))return refusal("home-conflict","The active source placement changed before seeding.");
        if(stopped && source.value.state==="frozen") {
          const stores=createStorePort(options.config,options.globalDb);
          try{for(const key of r.placement.stores)if(key.startsWith("worktree:"))stores.openStore(key).db.prepare("UPDATE roam_sessions SET state='active' WHERE session_id=? AND epoch=? AND state='frozen'").run(r.placement.sessionId,r.epoch);}finally{stores.close();}
        }
        await seedLocalPlacement(r.placement,r.epoch,options);return {ok:true,value:{version:1}};
      }
      case "authorize":{
        const plan=r.plan,d=plan.destinationPlacement,key=`worktree:${d.repoKey}:${d.workspaceId}` as StoreKey;
        if(d.machineId!==options.config.machineId || !mappedKey(`repo:${d.repoKey}`,options))return refusal("repo-unmapped","The incoming repository is not locally mapped.","Run spider roam repo map on the destination, then retry.");
        const home=await options.homes.read(plan.source.sessionId);
        if(home && !(home.epoch<plan.source.epoch) && !(home.state==="moving" && home.moveId===plan.moveId && home.machineId===plan.source.machineId && home.destination===d.machineId && home.epoch===plan.source.epoch+1) && !(home.state!=="moving" && home.machineId===plan.source.machineId && home.epoch<=plan.source.epoch))return refusal("home-conflict","The destination has a newer or different home.");
        beginLocalMove(plan,options);
        const previous=options.journal.read(plan.moveId).find(row=>row.action==="relocate-incoming");
        if(!previous)options.journal.record(plan.moveId,"relocate-incoming",json({plan,expectedKey:key}));
        writeLocal(options.globalDb,"relocate-incoming",key,{moveId:plan.moveId});
        const stores=createStorePort(options.config,options.globalDb,{unmappedWorktree:key});try{stores.openStore(key);}finally{stores.close();}
        return {ok:true,value:{version:1}};
      }
      case "data":{
        const op=r.operation;let expected:StoreKey|undefined;
        if(op.args.storeKey!==undefined){storeScope(op.args.storeKey);const key=op.args.storeKey as StoreKey;if(!mappedKey(key,options)){if(!await incomingPlan(key,options))return refusal("repo-unmapped","This unmapped worktree is not authorized by the current move.");expected=key;}}
        const stores=createStorePort(options.config,options.globalDb,{unmappedWorktree:expected});
        try {
          const agent=createAgentPorts({config:options.config,journal:options.journal,root:stagingRoot(options),openStore:key=>{
            if(!mappedKey(key,options) && key!==expected)throw new Error("Unmapped v0 store refused");return stores.openStore(key);
          }});
          const outcome=await handleAgentOperation(op,agent);
          if(op.kind==="stores" && outcome.code===0 && outcome.value && Array.isArray(outcome.value.stores)) {
            const allowed:StoreKey[]=[];for(const raw of outcome.value.stores){storeScope(raw);const key=raw as StoreKey;if(mappedKey(key,options) || await incomingPlan(key,options))allowed.push(key);}
            outcome.value.stores=allowed;
          }
          return {ok:true,value:{version:1,outcome}};
        }finally{stores.close();}
      }
      case "artifact":{
        const enrolled=options.config.role==="box"?r.sourceMachine===options.config.hubMachineId:options.config.peers.some(peer=>peer.machineId===r.sourceMachine);
        if(!enrolled)return refusal("invalid-arguments","The artifact sender is not an enrolled v0 peer.");
        const bytes=r.bytes===null?undefined:Buffer.from(r.bytes,"base64");
        if(bytes && (bytes.length>options.limits.chunkBytes || bytes.toString("base64")!==r.bytes))return refusal("invalid-arguments","The artifact bytes exceed the private chunk boundary.");
        const stores=createStorePort(options.config,options.globalDb);
        try {
          const agent=createAgentPorts({config:options.config,journal:options.journal,root:stagingRoot(options),openStore:stores.openStore});
          const wire=await handleAgentArtifactRequest(r.input,bytes,r.sourceMachine,agent);
          return {ok:true,value:{version:1,wire:JSON.parse(wire.toString("utf8"))}};
        }finally{stores.close();}
      }
      case "capture":return wrap(await captureLocalSession(r.plan,options),"captured");
      case "install":return wrap(await installLocalSession(r.plan,r.captured,r.home,options),"installed");
      default:{
        const local=createLocalRuntime(options);
        switch(r.kind){
          case "locate":return wrap(await local.locate(options.config.machineId,r.sessionId),"placement");
          case "owner":return {ok:true,value:{version:1,owner:await local.owner(r.sessionId)}};
          case "stop":return wrap(await local.stop(r.sessionId,r.moving));
          case "activate":return wrap(await local.activate(r.home,r.placement));
          case "start":return wrap(await local.start(r.home,r.placement));
          case "confirm":return wrap(await local.confirm(r.home,r.placement));
        }
      }
    }
  }catch{return refusal("invalid-arguments","The private v0 operation could not be completed safely.");}
}
export function guardV0PeerTransport(transport: Transport, isRevoked: (machineId: string) => boolean): Transport {
  function check(peer: Peer) {
    if (isRevoked(peer.machineId)) throw new Error("V0 peer was forgotten");
  }
  return {
    ...transport,
    async resolve(peer, options) { check(peer); return transport.resolve(peer, options); },
    async exec(peer, argv, options) { check(peer); return transport.exec(peer, argv, options); },
    async run(peer, argv, operationId) { check(peer); return transport.run(peer, argv, operationId); },
    async read(peer, path, options) { check(peer); return transport.read(peer, path, options); },
    async write(peer, path, bytes, timeoutMs) { check(peer); return transport.write(peer, path, bytes, timeoutMs); },
  };
}

export function createV0ArtifactTransport(transport:Transport,sourceMachine:string):Transport {
  return {...transport,async exec(peer,argv,options){
    if(argv.length!==4 || argv[0]!=="roam" || argv[1]!=="artifact" || argv[2]!=="receive")return transport.exec(peer,argv,options);
    const bytes=await transport.exec(peer,["roam","agent","--v0"],{...options,stdin:Buffer.from(JSON.stringify({version:1,kind:"artifact",sourceMachine,input:JSON.parse(argv[3]),bytes:options.stdin?.toString("base64")??null}))});
    const reply=object(JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(bytes)));
    if(reply.ok!==true)throw new Error("Private artifact operation refused");const value=object(reply.value);
    if(value.version!==1)throw new Error("Unsupported private artifact reply");return Buffer.from(JSON.stringify(value.wire));
  }};
}
export function createV0SyncTransport(transport: Transport): Transport {
  return {...transport, async exec(peer,argv,options) {
    if (argv.length !== 3 || argv[0] !== "roam" || argv[1] !== "agent" || argv[2] === "--v0") return transport.exec(peer,argv,options);
    const operation = parseDataOperation(JSON.parse(argv[2]));
    const bytes = await transport.exec(peer,["roam","agent","--v0"],{...options,stdin:Buffer.from(JSON.stringify({version:1,kind:"data",operation}))});
    if (!Buffer.isBuffer(bytes) || bytes.length > options.maxBytes) throw new Error("Invalid v0 data reply size");
    const reply = object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));
    if (reply.ok !== true) throw new Error("V0 data operation refused");
    const value = object(reply.value);
    if (value.version !== 1) throw new Error("Unsupported v0 data reply");
    const outcome = object(value.outcome);
    if (![0,1,2,3].includes(outcome.code as number) || outcome.operationId !== operation.id) throw new Error("Mismatched v0 data reply");
    return Buffer.from(JSON.stringify(outcome as JsonObject));
  }};
}
