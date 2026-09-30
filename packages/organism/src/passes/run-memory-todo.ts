import { isSupportedMemoryCandidate } from "../memory-candidate.js";
import type { DigestMsg } from "@spider/memory";
import type { DigestBundle, DigestModel, DigestResult } from "../types.js";
import { capMemory, emptyResult } from "../types.js";
import { parseCandidates } from "../aux-model.js";

const SYSTEM = `You are the memory/todo digest for an autonomous coding agent's session.
Review the run activity below (subagent runs, their tool-result events, and bounded
tracked tool activity from the session itself) and surface:
- zero memory candidates by default; only a verified durable fact that changes future sessions (category one of: preference, convention, tool-quirk, failure, correction, insight). Never treat run counts, status, task progress, or a one-off tool result as durable memory.
- follow-up todos surfaced by the subagent activity (things left undone or worth doing next)
For each memory candidate supply scope (global only when true in every repo, else repo), justification (durability, utility to other agents, and scope), and evidence (current file:line or command output). Do not invent evidence.
Respond with a JSON object: { "memory": [{ "category": string, "content": string, "scope": "global" | "repo", "justification": string, "evidence": string }], "todos": [{ "text": string }], "skills": [] }.
If there is nothing worth recording, respond with "Nothing to save."`;

// Bound the number of tracked tool-event lines folded into the digest input
// so a busy session's raw activity log can't blow up the prompt with an
// unbounded/duplicated payload dump.
const MAX_TRACKED_EVENT_LINES = 40;

function summarizeBundle(bundle: DigestBundle): string {
  const runLines = bundle.runs.map(
    (r) => `run ${r.id} agent=${r.agent} role=${r.role ?? ""} status=${r.status} steps=${r.step_count} tokens=${r.token_count}`,
  );
  const eventLines = bundle.runEvents.map(
    (e) => `event run=${e.runId ?? ""} type=${e.type}${e.tool ? ` tool=${e.tool}` : ""}${e.summary ? `: ${e.summary}` : ""}`,
  );
  // Bounded, description-only summary of tracked tool activity — never the
  // raw/unbounded `payload` blob, and capped to the most recent N entries.
  const trackedLines = bundle.events
    .slice(-MAX_TRACKED_EVENT_LINES)
    .map((e) => `tracked ${e.phase} tool=${e.tool}${e.description ? `: ${e.description}` : ""}`);
  return [
    "Runs:", ...runLines, "",
    "Run events:", ...eventLines, "",
    "Tracked activity:", ...trackedLines,
  ].join("\n");
}

/**
 * Pass 1: run -> memory/todo. Pure aside from the injected `model.complete`
 * call. Summarizes subagent run activity AND bounded tracked-tool-event
 * activity (so a normal human-driven session with no subagent runs still has
 * real signal to review), asks the aux model for durable memory + follow-up
 * todo candidates, and applies the anti-poison guardrail to every memory
 * candidate before returning. Emits no skills.
 */
export async function runMemoryTodoPass(bundle: DigestBundle, model: DigestModel, maxMemoryProposals = 3): Promise<DigestResult> {
  if (bundle.runs.length === 0 && bundle.runEvents.length === 0 && bundle.events.length === 0) return emptyResult();

  const userMsg: DigestMsg = { role: "user", content: summarizeBundle(bundle) };
  const raw = await model.complete(SYSTEM, [userMsg]);
  const parsed = parseCandidates(raw, { strict: true });
  return capMemory({
    ...parsed,
    memory: parsed.memory.filter((m) => !/^User(?: said)?:/i.test(m.evidence?.trim() ?? "") && isSupportedMemoryCandidate(m)),
    skills: [],
  }, maxMemoryProposals);
}
