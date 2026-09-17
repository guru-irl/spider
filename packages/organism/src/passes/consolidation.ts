import type { DigestBundle, DigestModel, DigestResult } from "../types.js";
import { emptyResult } from "../types.js";
import { parseCandidates } from "../aux-model.js";
import type { DigestMsg } from "@spider/memory";

// Bound how many tracked tool-event lines are folded into the no-transcript
// activity summary — never duplicate the full/unbounded raw event log.
const MAX_TRACKED_EVENT_LINES = 40;

/**
 * When there is no transcript (but the gate passed because there were runs),
 * build a concise, bounded activity summary from run rows, tracked tool
 * events, and the session label — so the model reviews SOMETHING instead of
 * a bare instruction with no conversation above it. Returns `[]` (send
 * nothing extra) when there is genuinely no activity to summarize.
 */
function summarizeRunActivity(bundle: DigestBundle): DigestMsg[] {
  const lines: string[] = [];
  if (bundle.sessionName) lines.push(`Session: ${bundle.sessionName}`);
  if (bundle.runs.length > 0) {
    lines.push("Runs:");
    for (const r of bundle.runs) {
      lines.push(`- run ${r.id} agent=${r.agent} role=${r.role ?? ""} status=${r.status} steps=${r.step_count} tokens=${r.token_count}`);
    }
  }
  if (bundle.runEvents.length > 0) {
    lines.push("Run events:");
    for (const e of bundle.runEvents) {
      lines.push(`- run=${e.runId ?? ""} type=${e.type}${e.tool ? ` tool=${e.tool}` : ""}${e.summary ? `: ${e.summary}` : ""}`);
    }
  }
  const trackedEvents = bundle.events.slice(-MAX_TRACKED_EVENT_LINES);
  if (trackedEvents.length > 0) {
    lines.push("Tracked activity:");
    for (const e of trackedEvents) {
      lines.push(`- ${e.phase} tool=${e.tool}${e.description ? `: ${e.description}` : ""}`);
    }
  }
  if (lines.length === 0) return [];
  return [{ role: "user", content: lines.join("\n") }];
}

/**
 * Prompt asking the aux model for a short session summary plus a short
 * "self name" slug for the broad ongoing task — the writer (Task 9) persists
 * these to `sessions.summary`/`sessions_fts` and `sessions.name` /
 * `projects.name`.
 */
export const CONSOLIDATION_PROMPT: string =
  "Review the conversation above and produce a JSON object with exactly two " +
  "fields:\n" +
  '  "summary": a 1-3 sentence summary of what this session accomplished.\n' +
  '  "selfName": a short slug (2-5 words) naming the broad ongoing task or ' +
  "project this session is part of — not a one-off session artifact.\n\n" +
  "Reply with ONLY the JSON object, no extra prose.";

/** lowercase, non-alphanumeric runs -> single hyphen, trim, cap at 48 chars. */
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 48);
}

/**
 * Pass 4: SESSION CONSOLIDATION. Produces a summary + self-name slug from the
 * transcript/runs; emits no memory/skill/todo candidates (the writer persists
 * summary/selfName directly, not via the staging pipeline). Pure aside from
 * the injected `model.complete` call. When there is neither a transcript nor
 * any runs, short-circuits to emptyResult() without a model call.
 */
export async function consolidationPass(bundle: DigestBundle, model: DigestModel): Promise<DigestResult> {
  if (bundle.transcript.length === 0 && bundle.runs.length === 0) return emptyResult();

  const messages = bundle.transcript.length > 0 ? bundle.transcript : summarizeRunActivity(bundle);
  const raw = await model.complete(CONSOLIDATION_PROMPT, messages);
  const parsed = parseCandidates(raw, { strict: true });
  return {
    ...emptyResult(),
    summary: parsed.summary,
    selfName: parsed.selfName === undefined ? undefined : slugify(parsed.selfName),
  };
}
