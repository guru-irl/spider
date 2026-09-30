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
  new RegExp(`\\b(do not|don${APOS}t|does not|doesn${APOS}t|did not|didn${APOS}t|will not|won${APOS}t|cannot|can${APOS}t|could not|couldn${APOS}t|would not|wouldn${APOS}t)\\s+\\w*\\s*work\\b`, "i"),
  // "X is broken", "tool is broken/unusable/useless"
  /\bis\s+(broken|unusable|useless|not\s+usable|not\s+working)\b/i,
  // "cannot use Y", "can't use Y", "unable to use Y"
  new RegExp(`\\b(cannot|can${APOS}t|unable to)\\s+use\\b(?![^.]*\\bon (?:the )?(?:main|release) branch\\b)`, "i"),
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
  /\b(?:error|failure|issue|incident|outage|problem)\s+(?:was\s+)?(?:resolved|self-resolved)\b|\bresolved\s+(?:after|on\s+retry)\b/i,
  /\b(?:intermittent|flaky|transient)\s+(?:error|failure|issue|incident|outage|test run)\b|\b(?:error|failure|issue|incident|outage)\s+(?:was\s+)?(?:intermittent|flaky|transient)\b/i,
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
  /\bfresh[-\s]?install\s+(?:error|fail(?:ed|ure))\b|\b(?:error|fail(?:ed|ure))\s+(?:on|during)\s+(?:a\s+)?fresh[-\s]?install\b/i,
  /\bpost[-\s]?migration\b/i,
  /\bpath\s+mismatch\b/i,
  /\bnpm\s+install\s+failed\b/i,
];

// Rule 4 — ONE-OFF TASK NARRATIVES.
//   "One-off task narratives. A user asking 'summarize today's market' or
//    'analyze this PR' is not a class of work that warrants a skill."
const ONE_OFF_TASK = [
  /\b(?:this task's|checkpoint|today's|for (?:this|the) (?:task|run))\b[^.\n]*\bHANDOFF\.md\b/i,
  /\bCI\s+(?:failed|failure|blocker)\s+(?:at|on|in|seen)\b/i,
  /\.spider\/scratch\/[^\s/,]+\//i,
  /\btests?:?\s+\d+\s+(passed|failed)\b/i,
  /\b\d+\s+(passed|failed)\s*(,|\/|and)\s*\d+\s+(passed|failed)\b/i,
  /\b(run|branch)\s+(?:id\s*)?[#:]?\s*[a-f0-9]{7,}\b/i,
  /\bsummari[sz]e\s+(?:this|the)\s+(?:pr|pull request|diff|repo|file|commit|report)\b/i,
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
 * Apply the negative-lesson and task-narrative checks to every category.
 * A preference is exempt only when the caller verified a sufficiently long
 * quote against a top-level user transcript. Other callers cannot opt in by
 * supplying model-written evidence alone. Some ambiguous generic wording is
 * retained for durable conventions rather than discarded as a one-off error.
 */
export function shouldCapture(category: MemoryCategory, content: string, evidence?: string, verifiedUserQuote = false): CaptureVerdict {
  const text = content ?? "";
  if (verifiedUserQuote && category === "preference" && /^User(?: said)?:\s*["“].+["”]\s*$/is.test(evidence?.trim() ?? "")) {
    return { capture: true };
  }

  // Failure-oriented notes retain main's broad negative-lesson rules. Durable
  // conventions keep the narrower checks below so incidental words survive.
  if ((category === "failure" || category === "tool-quirk") &&
    new RegExp(`\\b(?:cannot|can${APOS}t|unable to)\\s+use\\b`, "i").test(text)) {
    return { capture: false, reason: "negative tool/feature claim (rule 2)" };
  }
  if ((category === "failure" || category === "tool-quirk") &&
    /\b(?:intermittent|flaky|transient)\b/i.test(text)) {
    return { capture: false, reason: "transient error that resolved (rule 3)" };
  }
  if ((category === "failure" || category === "tool-quirk") &&
    new RegExp(`\\bsummari[sz]e\\s+(?:today${APOS}s|this|the)\\b`, "i").test(text)) {
    return { capture: false, reason: "one-off task narrative (rule 4)" };
  }

  // Rule 2: negative claims about tools/features.
  const personalSchedule = category === "preference" && new RegExp(`\\bI\\s+(?:do not|don${APOS}t)\\s+work\\s+(?:on\\s+)?(?:Mondays?|Tuesdays?|Wednesdays?|Thursdays?|Fridays?|Saturdays?|Sundays?|weekends?)\\b`, "i").test(text);
  if (!personalSchedule && matchesAny(text, NEGATIVE_TOOL_CLAIM)) {
    return { capture: false, reason: "negative tool/feature claim (rule 2)" };
  }

  // Rule 3: session-specific transient errors that resolved.
  if (((category === "failure" || category === "tool-quirk") && /\bresolved\b/i.test(text)) || matchesAny(text, TRANSIENT_RESOLVED)) {
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

  // No task/transient markers detected.
  return { capture: true };
}
