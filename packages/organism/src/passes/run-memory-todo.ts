import { shouldCapture } from "@spider/memory";
import type { DigestMsg } from "@spider/memory";
import type { DigestBundle, DigestModel, DigestResult } from "../types.js";
import { emptyResult } from "../types.js";
import { parseCandidates } from "../aux-model.js";

const SYSTEM = `You are the memory/todo digest for an autonomous coding agent's subagent runs.
Review the run activity below (subagent runs and their tool-result events) and surface:
- durable memory candidates (category one of: preference, convention, tool-quirk, failure, correction, insight)
- follow-up todos surfaced by the subagent activity (things left undone or worth doing next)
Respond with a JSON object: { "memory": [{ "category": string, "content": string }], "todos": [{ "text": string }], "skills": [] }.
If there is nothing worth recording, respond with "Nothing to save."`;

function summarizeBundle(bundle: DigestBundle): string {
  const runLines = bundle.runs.map(
    (r) => `run ${r.id} agent=${r.agent} role=${r.role ?? ""} status=${r.status} steps=${r.step_count} tokens=${r.token_count}`,
  );
  const eventLines = bundle.runEvents.map(
    (e) => `event run=${e.runId ?? ""} type=${e.type}${e.tool ? ` tool=${e.tool}` : ""}${e.summary ? `: ${e.summary}` : ""}`,
  );
  return ["Runs:", ...runLines, "", "Run events:", ...eventLines].join("\n");
}

/**
 * Pass 1: run -> memory/todo. Pure aside from the injected `model.complete`
 * call. Summarizes subagent run activity, asks the aux model for durable
 * memory + follow-up todo candidates, and applies the anti-poison guardrail
 * to every memory candidate before returning. Emits no skills.
 */
export async function runMemoryTodoPass(bundle: DigestBundle, model: DigestModel): Promise<DigestResult> {
  if (bundle.runs.length === 0 && bundle.runEvents.length === 0) return emptyResult();

  const userMsg: DigestMsg = { role: "user", content: summarizeBundle(bundle) };
  const raw = await model.complete(SYSTEM, [userMsg]);
  const parsed = parseCandidates(raw);
  return {
    ...parsed,
    memory: parsed.memory.filter((m) => shouldCapture(m.category, m.content).capture),
    skills: [],
  };
}
