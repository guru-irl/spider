import { shouldCapture } from "@spider/memory";
import type { DigestMsg } from "@spider/memory";
import type { DigestBundle, DigestModel, DigestResult } from "../types.js";
import { emptyResult } from "../types.js";
import { parseCandidates } from "../aux-model.js";
import type { Todo } from "@spider/todo";

const SYSTEM = `You are the memory digest for an autonomous coding agent's completed todos.
Review the completed todos below and surface durable memory candidates
(category one of: preference, convention, tool-quirk, failure, correction, insight)
that capture recurring conventions or insights worth remembering long-term.
Respond with a JSON object: { "memory": [{ "category": string, "content": string }], "todos": [], "skills": [] }.
If there is nothing worth recording, respond with "Nothing to save."`;

function summarizeCompletedTodos(todos: Todo[]): string {
  const lines = todos.map((t) => `- ${t.text}`);
  return ["Completed todos:", ...lines].join("\n");
}

/**
 * Pass 2: todo -> memory. Pure aside from the injected `model.complete` call.
 * Digests COMPLETED todos into durable memory candidates, applying the
 * anti-poison guardrail before returning. Emits no skills or todos. When no
 * todos are done, short-circuits to emptyResult() without calling the model.
 */
export async function todoMemoryPass(bundle: DigestBundle, model: DigestModel): Promise<DigestResult> {
  const completed = bundle.todos.filter((t) => t.done);
  if (completed.length === 0) return emptyResult();

  const userMsg: DigestMsg = { role: "user", content: summarizeCompletedTodos(completed) };
  const raw = await model.complete(SYSTEM, [userMsg]);
  const parsed = parseCandidates(raw);
  return {
    ...parsed,
    memory: parsed.memory.filter((m) => shouldCapture(m.category, m.content).capture),
    todos: [],
    skills: [],
  };
}
