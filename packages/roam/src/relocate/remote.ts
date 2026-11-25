import type { JsonObject } from "@spider/db-core/roam/types";
import type { Operation, Peer, Transport } from "../contracts";
import { object, text } from "./journal";
import { isMachineId } from "../machine-id";
import type { V0RefusalCode, V0Result } from "./types";

export const dataKinds = new Set(["stores", "inventory", "enable-capture", "export", "release-export", "split", "assemble", "cursor", "receipt", "import", "recheck-store"]);
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
