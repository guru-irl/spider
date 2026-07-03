import { Type } from "typebox";

const ContextEnum = Type.Optional(Type.String({ enum: ["fresh", "fork"], description: "'fresh' or fork from parent session" }));

const PipelineStageSchema = Type.Object({
  agent: Type.String(),
  role: Type.Optional(Type.String()),
  phase: Type.Optional(Type.String()),
  task: Type.Optional(Type.String({ description: "Template: {task},{previous},{handoff},{outputs.<as>}" })),
  as: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  skill: Type.Optional(Type.String()),
  context: ContextEnum,
  count: Type.Optional(Type.Integer({ minimum: 1 })),
  wakeOn: Type.Optional(Type.String({ enum: ["done", "accepted"] })),
}, { additionalProperties: false });

const TaskItem = Type.Object({ agent: Type.String(), task: Type.String(), count: Type.Optional(Type.Integer({ minimum: 1 })), model: Type.Optional(Type.String()), context: ContextEnum }, { additionalProperties: false });
const ChainItem = Type.Object({ agent: Type.Optional(Type.String()), task: Type.Optional(Type.String()), model: Type.Optional(Type.String()), context: ContextEnum }, { additionalProperties: false });

export const RunParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "SINGLE mode agent" })),
  task: Type.Optional(Type.String({ description: "SINGLE mode task" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "CHAIN mode: sequential steps ({previous} passed forward)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "PARALLEL mode tasks" })),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "PARALLEL max concurrent (default 4)" })),
  pipeline: Type.Optional(Type.Array(PipelineStageSchema, { description: "PIPELINE mode: push-based auto-wake stages" })),
  handoff: Type.Optional(Type.String({ enum: ["intercom", "wait"], description: "PIPELINE handoff mechanism (default intercom)" })),
  context: ContextEnum,
  async: Type.Optional(Type.Boolean({ description: "Run in background" })),
  model: Type.Optional(Type.String()),
  skill: Type.Optional(Type.String()),
});

export const WaitParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Run id/prefix to wait for one run; omit to wait across all active async runs" })),
  all: Type.Optional(Type.Boolean({ description: "Wait for ALL active runs (default false = first-finish)" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Give up after ms (default 1800000)" })),
});

export const MessageParams = Type.Object({
  to: Type.String({ description: "Target session name/id" }),
  message: Type.String({ description: "Message body" }),
  kind: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

export interface PipelineStage { agent: string; role?: string; phase?: string; task?: string; as?: string; model?: string; skill?: string; context?: "fresh" | "fork"; count?: number; wakeOn?: "done" | "accepted"; }
export interface RunPipelineArgs { pipeline: PipelineStage[]; handoff: "intercom" | "wait"; async?: boolean; }
