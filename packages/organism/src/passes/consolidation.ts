import type { DigestBundle, DigestModel, DigestResult } from "../types.js";
import { emptyResult } from "../types.js";
import { parseCandidates } from "../aux-model.js";

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

  const raw = await model.complete(CONSOLIDATION_PROMPT, bundle.transcript);
  const parsed = parseCandidates(raw);
  return {
    ...emptyResult(),
    summary: parsed.summary,
    selfName: parsed.selfName === undefined ? undefined : slugify(parsed.selfName),
  };
}
