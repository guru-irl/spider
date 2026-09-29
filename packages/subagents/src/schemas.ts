import { Type, type TObject, type TString, type TOptional, type TInteger } from "typebox";

export const MessageParams: TObject = Type.Object({
  to: Type.String({ description: "Target session name/id" }) as TString,
  message: Type.String({ description: "Message body" }) as TString,
  kind: Type.Optional(Type.String()) as TOptional<TString>,
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })) as TOptional<TInteger>,
});

export interface PipelineStage { agent: string; role?: string; phase?: string; task?: string; as?: string; model?: string; thinking?: string; skill?: string; context?: "fresh" | "fork"; count?: number; wakeOn?: "done" | "accepted"; }
export interface RunPipelineArgs { pipeline: PipelineStage[]; handoff: "intercom" | "wait"; async?: boolean; }
