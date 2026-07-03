import { Type, type TSchema, type TObject, type TString, type TOptional, type TArray, type TInteger, type TBoolean } from "typebox";

const ContextEnum: TOptional<TString> = Type.Optional(Type.String({ enum: ["fresh", "fork"], description: "'fresh' or fork from parent session" }));

const PipelineStageSchema: TObject = Type.Object({
  agent: Type.String() as TString,
  role: Type.Optional(Type.String()) as TOptional<TString>,
  phase: Type.Optional(Type.String()) as TOptional<TString>,
  task: Type.Optional(Type.String({ description: "Template: {task},{previous},{handoff},{outputs.<as>}" })) as TOptional<TString>,
  as: Type.Optional(Type.String()) as TOptional<TString>,
  model: Type.Optional(Type.String()) as TOptional<TString>,
  skill: Type.Optional(Type.String()) as TOptional<TString>,
  context: ContextEnum,
  count: Type.Optional(Type.Integer({ minimum: 1 })) as TOptional<TInteger>,
  wakeOn: Type.Optional(Type.String({ enum: ["done", "accepted"] })) as TOptional<TString>,
}, { additionalProperties: false });

const TaskItem: TObject = Type.Object({ agent: Type.String() as TString, task: Type.String() as TString, count: Type.Optional(Type.Integer({ minimum: 1 })) as TOptional<TInteger>, model: Type.Optional(Type.String()) as TOptional<TString>, context: ContextEnum }, { additionalProperties: false });
const ChainItem: TObject = Type.Object({ agent: Type.Optional(Type.String()) as TOptional<TString>, task: Type.Optional(Type.String()) as TOptional<TString>, model: Type.Optional(Type.String()) as TOptional<TString>, context: ContextEnum }, { additionalProperties: false });

export const RunParams: TObject = Type.Object({
  agent: Type.Optional(Type.String({ description: "SINGLE mode agent" })) as TOptional<TString>,
  task: Type.Optional(Type.String({ description: "SINGLE mode task" })) as TOptional<TString>,
  chain: Type.Optional(Type.Array(ChainItem, { description: "CHAIN mode: sequential steps ({previous} passed forward)" })) as TOptional<TArray>,
  tasks: Type.Optional(Type.Array(TaskItem, { description: "PARALLEL mode tasks" })) as TOptional<TArray>,
  concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "PARALLEL max concurrent (default 4)" })) as TOptional<TInteger>,
  pipeline: Type.Optional(Type.Array(PipelineStageSchema, { description: "PIPELINE mode: push-based auto-wake stages" })) as TOptional<TArray>,
  handoff: Type.Optional(Type.String({ enum: ["intercom", "wait"], description: "PIPELINE handoff mechanism (default intercom)" })) as TOptional<TString>,
  context: ContextEnum,
  async: Type.Optional(Type.Boolean({ description: "Run in background" })) as TOptional<TBoolean>,
  model: Type.Optional(Type.String()) as TOptional<TString>,
  skill: Type.Optional(Type.String()) as TOptional<TString>,
});

export const WaitParams: TObject = Type.Object({
  id: Type.Optional(Type.String({ description: "Run id/prefix to wait for one run; omit to wait across all active async runs" })) as TOptional<TString>,
  all: Type.Optional(Type.Boolean({ description: "Wait for ALL active runs (default false = first-finish)" })) as TOptional<TBoolean>,
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Give up after ms (default 1800000)" })) as TOptional<TInteger>,
});

export const MessageParams: TObject = Type.Object({
  to: Type.String({ description: "Target session name/id" }) as TString,
  message: Type.String({ description: "Message body" }) as TString,
  kind: Type.Optional(Type.String()) as TOptional<TString>,
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })) as TOptional<TInteger>,
});

export interface PipelineStage { agent: string; role?: string; phase?: string; task?: string; as?: string; model?: string; skill?: string; context?: "fresh" | "fork"; count?: number; wakeOn?: "done" | "accepted"; }
export interface RunPipelineArgs { pipeline: PipelineStage[]; handoff: "intercom" | "wait"; async?: boolean; }
