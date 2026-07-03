import type { MemoryCategory } from "./types";

export interface CaptureVerdict {
  capture: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Anti-poisoning guardrails — ported 1:1 from hermes-agent
// `agent/background_review.py` L250-273 ("Do NOT capture" rules). These decide
// what a background (auto/import) write is allowed to persist as durable
// memory. They exist because negative lessons harden into self-imposed
// constraints that bite the agent later when the environment changes:
//
//   "Do NOT capture (these become persistent self-imposed constraints that
//    bite you later when the environment changes)"
//
// Each rule below carries its verbatim rationale from the port source. On a
// match we reject with `{ capture:false, reason:"<rule>" }`; durable
// statements (conventions, preferences, insights not matching any rule) fall
// through to `{ capture:true }`.
// ---------------------------------------------------------------------------

// Apostrophe class: straight ', typographic ', or absent (do not / dont).
// Used to build robust "negated" patterns like don'?t / doesn'?t / can'?t.
const APOS = "['\u2019]?";

// Rule 2 — NEGATIVE CLAIMS ABOUT TOOLS/FEATURES.
//   "Negative claims about tools or features ('browser tools do not work',
//    'X tool is broken', 'cannot use Y from execute_code'). These harden into
//    refusals the agent cites against itself for months after the actual
//    problem was fixed."
const NEGATIVE_TOOL_CLAIM = [
  // "... do not work", "... don't work", "... doesn't work", "... won't work"
  new RegExp(`\\b(do not|don${APOS}t|does not|doesn${APOS}t|did not|didn${APOS}t|will not|won${APOS}t|cannot|can${APOS}t|could not|couldn${APOS}t|would not|wouldn${APOS}t)\\s+\\w*\\s*work`, "i"),
  // "X is broken", "tool is broken/unusable/useless"
  /\bis\s+(broken|unusable|useless|not\s+usable|not\s+working)\b/i,
  // "cannot use Y", "can't use Y", "unable to use Y"
  new RegExp(`\\b(cannot|can${APOS}t|unable to)\\s+use\\b`, "i"),
  // Direct "X tool is broken" / "tools don't work" phrasing
  new RegExp(`\\btools?\\b.*\\b(do not|don${APOS}t|does not|doesn${APOS}t)\\s+work`, "i"),
];

// Rule 3 — SESSION-SPECIFIC TRANSIENT ERRORS THAT RESOLVED.
//   "Session-specific transient errors that resolved before the conversation
//    ended. If retrying worked, the lesson is the retry pattern, not the
//    original failure."
const TRANSIENT_RESOLVED = [
  /\bthen\s+succeeded\b/i,
  /\bafter\s+(a\s+)?retry\b/i,
  /\bworked\s+after\b/i,
  /\bsucceeded\s+after\b/i,
  /\bretry(ing)?\s+(worked|succeeded|fixed)\b/i,
  /\b(resolved|self-resolved)\b/i,
  /\b(intermittent|flaky|transient)\b/i,
];

// Rule 1 — ENVIRONMENT-DEPENDENT FAILURES.
//   "Environment-dependent failures: missing binaries, fresh-install errors,
//    post-migration path mismatches, 'command not found', unconfigured
//    credentials, uninstalled packages. The user can fix these — they are not
//    durable rules."
const ENV_DEPENDENT_FAILURE = [
  /\bcommand not found\b/i,
  /\bno such file or directory\b/i,
  /\bmissing\s+(binar(y|ies)|dependenc(y|ies)|package|module)\b/i,
  /\b(module|package)\s+not\s+found\b/i,
  /\bnot\s+installed\b/i,
  /\buninstalled\s+packages?\b/i,
  /\b(un|not\s+)configured\s+credentials?\b/i,
  /\bfresh[-\s]?install\b/i,
  /\bpost[-\s]?migration\b/i,
  /\bpath\s+mismatch\b/i,
  /\bnpm\s+install\s+failed\b/i,
];

// Rule 4 — ONE-OFF TASK NARRATIVES.
//   "One-off task narratives. A user asking 'summarize today's market' or
//    'analyze this PR' is not a class of work that warrants a skill."
const ONE_OFF_TASK = [
  new RegExp(`\\bsummari[sz]e\\s+(today${APOS}s|this|the)\\b`, "i"),
  /\banalyze\s+this\s+(pr|pull request|diff|repo|file|commit)\b/i,
  new RegExp(`\\bsummari[sz]e\\s+today${APOS}s\\s+market\\b`, "i"),
];

function matchesAny(content: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(content));
}

/**
 * Guardrail: should this content become durable memory?
 *
 * Ported from background_review.py negative-lesson policy. Returns
 * `{ capture:false, reason }` when the content matches one of the four
 * "Do NOT capture" rules, otherwise `{ capture:true }`.
 *
 * The four rules are FAILURE lessons — they only make sense applied to
 * failure-oriented categories ("failure", "tool-quirk"). Durable categories
 * ("preference", "convention", "correction", "insight") are always captured
 * without running the content heuristics, because incidental failure-words
 * inside genuinely durable statements (e.g. a convention that mentions
 * "cannot use force-push") must not be rejected.
 *
 * Accepted Phase-1 tradeoff: Rule 4 (one-off task narratives) is therefore
 * under-covered for durable categories — a durable-labelled note that is
 * actually a one-off task narrative will still be captured. This fail-safe
 * favors under-rejection of durable memory over over-rejection.
 */
export function shouldCapture(category: MemoryCategory, content: string): CaptureVerdict {
  const text = content ?? "";

  // Negative-lesson rules only apply to failure-oriented categories.
  if (category !== "failure" && category !== "tool-quirk") {
    return { capture: true };
  }

  // Rule 2: negative claims about tools/features.
  if (matchesAny(text, NEGATIVE_TOOL_CLAIM)) {
    return { capture: false, reason: "negative tool/feature claim (rule 2)" };
  }

  // Rule 3: session-specific transient errors that resolved.
  if (matchesAny(text, TRANSIENT_RESOLVED)) {
    return { capture: false, reason: "transient error that resolved (rule 3)" };
  }

  // Rule 1: environment-dependent failures.
  if (matchesAny(text, ENV_DEPENDENT_FAILURE)) {
    return { capture: false, reason: "environment-dependent failure (rule 1)" };
  }

  // Rule 4: one-off task narratives.
  if (matchesAny(text, ONE_OFF_TASK)) {
    return { capture: false, reason: "one-off task narrative (rule 4)" };
  }

  // Durable: conventions, preferences, insights that don't match the above.
  return { capture: true };
}
