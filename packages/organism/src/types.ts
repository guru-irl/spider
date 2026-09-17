import type { MemoryCategory } from "@spider/memory";
import type { DigestMsg } from "@spider/memory";
import type { RunRow } from "@spider/subagents";
import type { Todo } from "@spider/todo";

export type DrainReason = "before_compact" | "shutdown";
export type PassName = "runMemoryTodo" | "todoMemory" | "learning" | "consolidation" | "reflection" | "insights";

export interface TrackEventRow { id: number; ts: number; phase: "before" | "after"; tool: string; description?: string; flagged?: string; payload?: unknown; }
export interface RunEventRow { id: number; runId?: string; ts: number; type: string; tool?: string; summary?: string; payload?: unknown; }

export interface DigestBundle {
  sessionId: string;
  reason: DrainReason;
  runs: RunRow[];
  runEvents: RunEventRow[];
  events: TrackEventRow[];
  todos: Todo[];
  transcript: DigestMsg[];       // normalized conversation (may be empty when no transcript on disk)
  sessionName?: string;
}

export interface MemoryCandidate { category: MemoryCategory; content: string; link?: string | null; confidence?: number; }
export interface TodoCandidate { text: string; }
export interface SkillCandidate { name: string; category?: string; body: string; related?: string[]; }
export interface DigestResult {
  memory: MemoryCandidate[];
  todos: TodoCandidate[];
  skills: SkillCandidate[];
  summary?: string;
  selfName?: string;
}
export function emptyResult(): DigestResult { return { memory: [], todos: [], skills: [] }; }

// The ONLY non-purity in a pass: injected aux-model completion.
export interface DigestModel { complete(system: string, messages: DigestMsg[]): Promise<string>; }

export interface WriteBudget { max: number; used: number; }
export interface AppliedSummary { memoryStaged: number; todosAdded: number; skillsStaged: number; dropped: number; rejected: number; }

export interface DrainError { phase: string; message: string; }
/** Counts describe new staged proposals, not approvals or completed user work. */
export interface DrainReport extends AppliedSummary {
  kind: "organism-drain";
  sessionId: string;
  reason: DrainReason;
  status: "completed" | "partial" | "failed" | "skipped";
  skipReason?: "disabled" | "no-input" | "no-model";
  startedAt: number;
  finishedAt: number;
  modelCalls: number;
  inputs: { messages: number; runs: number; runEvents: number; events: number; completedTodos: number };
  errors: DrainError[];
}
