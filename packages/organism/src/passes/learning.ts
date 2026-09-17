import { shouldCapture } from "@spider/memory";
import type { DigestBundle, DigestModel, DigestResult, SkillCandidate } from "../types.js";
import { emptyResult } from "../types.js";
import { parseCandidates } from "../aux-model.js";

// ---------------------------------------------------------------------------
// Review-prompt strings — a faithful port of Hermes background_review.py's
// `_MEMORY_REVIEW_PROMPT`, `_SKILL_REVIEW_PROMPT`, `_COMBINED_REVIEW_PROMPT`,
// and the negative-lesson "Do NOT capture" block. Ported VERBATIM: the only
// edits retarget Hermes tool/command framing to the spider equivalents
// (`skill_manage`/`skill_view`/`skills_list` → `spider skill ...`, the memory
// tool stays "the memory tool", `execute_code` → `exec`, Hermes CLI/product
// refs → spider). Behavioral wording, bullets, and joins are unchanged.
// ---------------------------------------------------------------------------

export const MEMORY_REVIEW_PROMPT: string =
  "Review the conversation above and consider saving to memory if appropriate.\n\n" +
  "Focus on:\n" +
  "1. Has the user revealed things about themselves — their persona, desires, " +
  "preferences, or personal details worth remembering?\n" +
  "2. Has the user expressed expectations about how you should behave, their work " +
  "style, or ways they want you to operate?\n\n" +
  "If something stands out, save it using the memory tool. " +
  "If nothing is worth saving, just say 'Nothing to save.' and stop.";

export const SKILL_REVIEW_PROMPT: string =
  "Review the conversation above and update the skill library. Be " +
  "ACTIVE — most sessions produce at least one skill update, even if " +
  "small. A pass that does nothing is a missed learning opportunity, " +
  "not a neutral outcome.\n\n" +
  "Target shape of the library: CLASS-LEVEL skills, each with a rich " +
  "SKILL.md and a `references/` directory for session-specific detail. " +
  "Not a long flat list of narrow one-session-one-skill entries. This " +
  "shapes HOW you update, not WHETHER you update.\n\n" +
  "Signals to look for (any one of these warrants action):\n" +
  "  • User corrected your style, tone, format, legibility, or " +
  "verbosity. Frustration signals like 'stop doing X', 'this is too " +
  "verbose', 'don't format like this', 'why are you explaining', " +
  "'just give me the answer', 'you always do Y and I hate it', or an " +
  "explicit 'remember this' are FIRST-CLASS skill signals, not just " +
  "memory signals. Update the relevant skill(s) to embed the " +
  "preference so the next session starts already knowing.\n" +
  "  • User corrected your workflow, approach, or sequence of steps. " +
  "Encode the correction as a pitfall or explicit step in the skill " +
  "that governs that class of task.\n" +
  "  • Non-trivial technique, fix, workaround, debugging path, or " +
  "tool-usage pattern emerged that a future session would benefit " +
  "from. Capture it.\n" +
  "  • A skill that got loaded or consulted this session turned out " +
  "to be wrong, missing a step, or outdated. Patch it NOW.\n\n" +
  "Preference order — prefer the earliest action that fits, but do " +
  "pick one when a signal above fired:\n" +
  "  1. UPDATE A CURRENTLY-LOADED SKILL. Look back through the " +
  "conversation for skills the user loaded via /skill-name or you " +
  "read via spider skill view. If any of them covers the territory of the " +
  "new learning, PATCH that one first. It is the skill that was in " +
  "play, so it's the right one to extend.\n" +
  "  2. UPDATE AN EXISTING UMBRELLA (via spider skill list + spider skill view). " +
  "If no loaded skill fits but an existing class-level skill does, " +
  "patch it. Add a subsection, a pitfall, or broaden a trigger.\n" +
  "  3. ADD A SUPPORT FILE under an existing umbrella. Skills can be " +
  "packaged with three kinds of support files — use the right " +
  "directory per kind:\n" +
  "     • `references/<topic>.md` — session-specific detail (error " +
  "transcripts, reproduction recipes, provider quirks) AND " +
  "condensed knowledge banks: quoted research, API docs, external " +
  "authoritative excerpts, or domain notes you found while working " +
  "on the problem. Write it concise and for the value of the task, " +
  "not as a full mirror of upstream docs.\n" +
  "     • `templates/<name>.<ext>` — starter files meant to be " +
  "copied and modified (boilerplate configs, scaffolding, a " +
  "known-good example the agent can `reproduce with modifications`).\n" +
  "     • `scripts/<name>.<ext>` — statically re-runnable actions " +
  "the skill can invoke directly (verification scripts, fixture " +
  "generators, deterministic probes, anything the agent should run " +
  "rather than hand-type each time).\n" +
  "     Add support files via spider skill action=write_file with " +
  "file_path starting 'references/', 'templates/', or 'scripts/'. " +
  "The umbrella's SKILL.md should gain a one-line pointer to any " +
  "new support file so future agents know it exists.\n" +
  "  4. CREATE A NEW CLASS-LEVEL UMBRELLA SKILL when no existing " +
  "skill covers the class. The name MUST be at the class level. " +
  "The name MUST NOT be a specific PR number, error string, feature " +
  "codename, library-alone name, or 'fix-X / debug-Y / audit-Z-today' " +
  "session artifact. If the proposed name only makes sense for " +
  "today's task, it's wrong — fall back to (1), (2), or (3).\n\n" +
  "User-preference embedding (important): when the user expressed a " +
  "style/format/workflow preference, the update belongs in the " +
  "SKILL.md body, not just in memory. Memory captures 'who the user " +
  "is and what the current situation and state of your operations " +
  "are'; skills capture 'how to do this class of task for this " +
  "user'. When they complain about how you handled a task, the " +
  "skill that governs that task needs to carry the lesson.\n\n" +
  "If you notice two existing skills that overlap, note it in your " +
  "reply — the background curator handles consolidation at scale.\n\n" +
  "Protected skills (DO NOT edit these):\n" +
  "  • Bundled skills (shipped with Spider, e.g. 'spider-agent').\n" +
  "  • Hub-installed skills (installed via 'spider skills install').\n" +
  "Pinned skills (marked via 'spider curator pin') CAN be improved — " +
  "pin only blocks deletion/archive/consolidation by the curator, not " +
  "content updates. Patch them when a pitfall or missing step turns up, " +
  "same as any other agent-created skill.\n" +
  "If the only skills that need updating are protected, say\n" +
  "'Nothing to save.' and stop.\n\n" +
  "Do NOT capture (these become persistent self-imposed constraints " +
  "that bite you later when the environment changes):\n" +
  "  • Environment-dependent failures: missing binaries, fresh-install " +
  "errors, post-migration path mismatches, 'command not found', " +
  "unconfigured credentials, uninstalled packages. The user can fix " +
  "these — they are not durable rules.\n" +
  "  • Negative claims about tools or features ('browser tools do not " +
  "work', 'X tool is broken', 'cannot use Y from exec'). These " +
  "harden into refusals the agent cites against itself for months " +
  "after the actual problem was fixed.\n" +
  "  • Session-specific transient errors that resolved before the " +
  "conversation ended. If retrying worked, the lesson is the retry " +
  "pattern, not the original failure.\n" +
  "  • One-off task narratives. A user asking 'summarize today's " +
  "market' or 'analyze this PR' is not a class of work that warrants " +
  "a skill.\n\n" +
  "If a tool failed because of setup state, capture the FIX (install " +
  "command, config step, env var to set) under an existing setup or " +
  "troubleshooting skill — never 'this tool does not work' as a " +
  "standalone constraint.\n\n" +
  "'Nothing to save.' is a real option but should NOT be the " +
  "default. If the session ran smoothly with no corrections and " +
  "produced no new technique, just say 'Nothing to save.' and stop. " +
  "Otherwise, act.";

export const COMBINED_REVIEW_PROMPT: string =
  "Review the conversation above and update two things:\n\n" +
  "**Memory**: who the user is. Did the user reveal persona, " +
  "desires, preferences, personal details, or expectations about " +
  "how you should behave? Include facts about the user and durable " +
  "preferences as memory candidates in your JSON reply (see OUTPUT " +
  "FORMAT below).\n\n" +
  "**Skills**: how to do this class of task. Be ACTIVE — most " +
  "sessions produce at least one skill update. A pass that does " +
  "nothing is a missed learning opportunity, not a neutral outcome.\n\n" +
  "Target shape of the skill library: CLASS-LEVEL skills with a rich " +
  "SKILL.md and a `references/` directory for session-specific detail. " +
  "Not a long flat list of narrow one-session-one-skill entries.\n\n" +
  "Signals that warrant a skill update (any one is enough):\n" +
  "  • User corrected your style, tone, format, legibility, " +
  "verbosity, or approach. Frustration is a FIRST-CLASS skill " +
  "signal, not just a memory signal. 'stop doing X', 'don't format " +
  "like this', 'I hate when you Y' — embed the lesson in the skill " +
  "that governs that task so the next session starts fixed.\n" +
  "  • Non-trivial technique, fix, workaround, or debugging path " +
  "emerged.\n" +
  "  • A skill that was loaded or consulted turned out wrong, " +
  "missing, or outdated — patch it now.\n\n" +
  "Preference order for skills — pick the earliest that fits:\n" +
  "  1. UPDATE A CURRENTLY-LOADED SKILL. Check what skills were " +
  "loaded via /skill-name or spider skill view in the conversation. If one " +
  "of them covers the learning, PATCH it first. It was in play; " +
  "it's the right place.\n" +
  "  2. UPDATE AN EXISTING UMBRELLA (spider skill list + spider skill view to " +
  "find the right one). Patch it.\n" +
  "  3. ADD A SUPPORT FILE under an existing umbrella by proposing " +
  "its content in your JSON reply's `skills` array (see OUTPUT " +
  "FORMAT below) with a `body` that documents the support content and " +
  "the umbrella it belongs under. Three kinds of support content: " +
  "`references/<topic>.md` for session-specific detail OR condensed " +
  "knowledge banks (quoted research, API docs excerpts, domain " +
  "notes) written concise and task-focused; `templates/<name>.<ext>` " +
  "for starter files meant to be copied and modified; " +
  "`scripts/<name>.<ext>` for statically re-runnable actions " +
  "(verification, fixture generators, probes). A human/automated " +
  "reviewer applies the actual file; you never write files yourself.\n" +
  "  4. CREATE A NEW CLASS-LEVEL UMBRELLA when nothing exists. " +
  "Name at the class level — NOT a PR number, error string, " +
  "codename, library-alone name, or 'fix-X / debug-Y' session " +
  "artifact. If the name only fits today's task, fall back to (1), " +
  "(2), or (3).\n\n" +
  "User-preference embedding: when the user complains about how " +
  "you handled a task, update the skill that governs that task — " +
  "memory alone isn't enough. Memory says 'who the user is and " +
  "what the current situation and state of your operations are'; " +
  "skills say 'how to do this class of task for this user'. Both " +
  "should carry user-preference lessons when relevant.\n\n" +
  "If you notice overlapping existing skills, mention it — the " +
  "background curator handles consolidation.\n\n" +
  "Protected skills (DO NOT edit these):\n" +
  "  • Bundled skills (shipped with Spider, e.g. 'spider-agent').\n" +
  "  • Hub-installed skills (installed via 'spider skills install').\n" +
  "Pinned skills (marked via 'spider curator pin') CAN be improved — " +
  "pin only blocks deletion/archive/consolidation by the curator, not " +
  "content updates. Patch them when a pitfall or missing step turns up, " +
  "same as any other agent-created skill.\n" +
  "If the only skills that need updating are protected, say\n" +
  "'Nothing to save.' and stop.\n\n" +
  "Do NOT capture as skills (these become persistent self-imposed " +
  "constraints that bite you later when the environment changes):\n" +
  "  • Environment-dependent failures: missing binaries, fresh-install " +
  "errors, post-migration path mismatches, 'command not found', " +
  "unconfigured credentials, uninstalled packages. The user can fix " +
  "these — they are not durable rules.\n" +
  "  • Negative claims about tools or features ('browser tools do not " +
  "work', 'X tool is broken', 'cannot use Y from exec'). These " +
  "harden into refusals the agent cites against itself for months " +
  "after the actual problem was fixed.\n" +
  "  • Session-specific transient errors that resolved before the " +
  "conversation ended. If retrying worked, the lesson is the retry " +
  "pattern, not the original failure.\n" +
  "  • One-off task narratives. A user asking 'summarize today's " +
  "market' or 'analyze this PR' is not a class of work that warrants " +
  "a skill.\n\n" +
  "If a tool failed because of setup state, capture the FIX (install " +
  "command, config step, env var to set) under an existing setup or " +
  "troubleshooting skill — never 'this tool does not work' as a " +
  "standalone constraint.\n\n" +
  "Act on whichever of the two dimensions has real signal. If " +
  "genuinely nothing stands out on either, say 'Nothing to save.' " +
  "and stop — but don't reach for that conclusion as a default.\n\n" +
  "OUTPUT FORMAT (required — you are a plain-text completion, not a " +
  "tool-calling agent; do not call any tool, and do not write files " +
  "yourself): reply with ONLY a single JSON object of exactly this " +
  "shape, no other prose:\n" +
  '{ "memory": [ { "category": string, "content": string, "link"?: string } ], ' +
  '"skills": [ { "name": string, "body": string, "related"?: string[] } ], ' +
  '"todos": [] }\n' +
  "`category` MUST be exactly one of: preference, convention, tool-quirk, " +
  "failure, correction, insight. This JSON is a REVIEW CANDIDATE only — it " +
  "is staged for human/automated review, never auto-approved and never " +
  "activated by you. If nothing is worth saving on either dimension, reply " +
  "with empty arrays: " +
  '{ "memory": [], "skills": [], "todos": [] } (equivalent to "Nothing to save.").';

// The negative-lesson "Do NOT capture" block (background_review.py, originally
// ~L250-273). Ported verbatim, retargeting `execute_code` → `exec`. This is the
// block driven alongside COMBINED_REVIEW_PROMPT in the learning pass.
export const DO_NOT_CAPTURE: string =
  "Do NOT capture (these become persistent self-imposed constraints " +
  "that bite you later when the environment changes):\n" +
  "  • Environment-dependent failures: missing binaries, fresh-install " +
  "errors, post-migration path mismatches, 'command not found', " +
  "unconfigured credentials, uninstalled packages. The user can fix " +
  "these — they are not durable rules.\n" +
  "  • Negative claims about tools or features ('browser tools do not " +
  "work', 'X tool is broken', 'cannot use Y from exec'). These " +
  "harden into refusals the agent cites against itself for months " +
  "after the actual problem was fixed.\n" +
  "  • Session-specific transient errors that resolved before the " +
  "conversation ended. If retrying worked, the lesson is the retry " +
  "pattern, not the original failure.\n" +
  "  • One-off task narratives. A user asking 'summarize today's " +
  "market' or 'analyze this PR' is not a class of work that warrants " +
  "a skill.\n\n" +
  "If a tool failed because of setup state, capture the FIX (install " +
  "command, config step, env var to set) under an existing setup or " +
  "troubleshooting skill — never 'this tool does not work' as a " +
  "standalone constraint.";

/**
 * A skill NAME is a session artifact (not class-level) when it encodes a
 * one-session referent: a PR/issue number, or a `fix-/debug-/audit-` prefix,
 * or a `-today` suffix. Mirrors the SKILL_REVIEW_PROMPT "MUST NOT" rule.
 */
function isSessionArtifactName(name: string): boolean {
  const n = name.trim();
  if (/\bpr[-_ ]?\d+/i.test(n)) return true; // PR/issue number reference
  if (/\d{3,}/.test(n)) return true; // bare long number (issue/PR id)
  if (/^(fix|debug|audit)[-_]/i.test(n)) return true; // session-task prefix
  if (/-today$/i.test(n)) return true; // "…-today" session artifact
  return false;
}

function isKeepableSkill(s: SkillCandidate): boolean {
  return s.body.trim().length > 0 && !isSessionArtifactName(s.name);
}

/**
 * Pass 3: the LEARNING LOOP. A faithful port of Hermes background_review that
 * emits BOTH staged memory AND staged skill candidates CO-EQUALLY (TC5 — no
 * promotion pipeline). Drives the model with COMBINED_REVIEW_PROMPT +
 * DO_NOT_CAPTURE over the session transcript (failures / corrections /
 * frustration signals). Memory candidates are guardrail-filtered; skill
 * candidates keep the class-level naming rule (reject session-artifact names
 * and empty bodies). Pure aside from the injected `model.complete` call. When
 * the transcript is empty, short-circuits to emptyResult() without a model call.
 */
export async function learningPass(bundle: DigestBundle, model: DigestModel): Promise<DigestResult> {
  if (bundle.transcript.length === 0) return emptyResult();

  const raw = await model.complete(COMBINED_REVIEW_PROMPT + "\n\n" + DO_NOT_CAPTURE, bundle.transcript);
  const parsed = parseCandidates(raw, { strict: true });
  return {
    ...parsed,
    memory: parsed.memory.filter((m) => shouldCapture(m.category, m.content).capture),
    skills: parsed.skills.filter(isKeepableSkill),
    todos: [],
  };
}
