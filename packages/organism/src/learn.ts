/**
 * `/learn` — build the standards-guided prompt that turns whatever the user
 * described into a reusable skill.
 *
 * `/learn` is open-ended. The user can point it at anything they can describe:
 * a directory of code, an API doc URL, a workflow they just walked the agent
 * through in this conversation, or pasted notes. This module builds ONE prompt
 * that instructs the live agent to gather the named sources with its own
 * spider tools and author a single `SKILL.md` via the `spider skill` action.
 *
 * There is no separate distillation engine and no model-tool footprint: the
 * agent does the work with its existing toolset, so this works identically on
 * local, Docker, and remote backends.
 *
 * The authoring contract matches the shared deterministic skill gate.
 */
export const AUTHORING_STANDARDS: string = `Author ONE reusable technique, not a task report or a renamed synonym of an existing skill.
Final-format SKILL.md starts with YAML frontmatter containing exactly name and description:
---
name: tracing-writers
description: Use when asynchronous writes need completion evidence
---
# Tracing writers
Trace ownership and verify the last writer closes its output.

- Name matches ^[a-z0-9]+(?:-[a-z0-9]+)*$, at most 64 characters, no paths or .md. It equals the action name.
- Description starts with "Use when", names concrete discovery triggers, and is at most 500 characters. Quote YAML values that contain a colon.
- Frontmatter is at most 1024 characters. Do not add any other fields.
- Agent-origin instructions are at most 1500 words and the full body at most 16 KB (16384 UTF-8 bytes). Prefer much less; the reviewer judges concision.
- Use a short title, a concise procedure, necessary pitfalls and a verification check. Include one useful example if needed, not a source-document copy.
- Verify commands, flags and APIs against the named sources. Never invent facts or make temporary permissions or concurrency limits into standing policy.
- Frame script execution through spider exec and source lookup through read, scoped search or spider fetch. Put needed code inline; staging does not upload companion files.
- Stage for review only. Staging is not deployment or approval.`;

/**
 * Build the agent prompt for an open-ended `/learn` request.
 *
 * @param userRequest the free-text the user gave after `/learn` — a
 *   description of the workflow, paths, URLs, or "what I just did". When empty
 *   or whitespace, falls back to distilling the current conversation.
 * @returns A complete instruction the agent runs as a normal turn. The agent
 *   gathers the described sources with its existing tools and authors the
 *   skill via the `spider skill` action.
 */
export function buildLearnPrompt(userRequest: string): string {
  let req = (userRequest || "").trim();
  if (!req) {
    req =
      "the workflow we just went through in this conversation — review " +
      "the steps taken and distill them into a reusable skill";
  }

  return (
    "[/learn] The user wants you to learn a reusable skill from the " +
    "request below, and save it.\n\n" +
    `THE REQUEST:\n${req}\n\n` +
    "The request is open-ended and may mix two kinds of content, in any " +
    'order: SOURCES to gather (directories, file paths, URLs, "what we ' +
    'just did", pasted notes) AND REQUIREMENTS that shape the skill ' +
    "(what to focus on, what to leave out, scope, naming, the angle to " +
    "take). Treat EVERY part of the request as load-bearing. In " +
    "particular, prose that comes after a path or link is NOT incidental " +
    "— it is the user telling you what they want from that source. A " +
    "request like `<url> focus on the auth flow, skip the deprecated " +
    "endpoints` means: gather the URL AND honor \"focus on auth, skip " +
    'deprecated" as authoring requirements. Never fetch the first source ' +
    "and ignore the rest.\n\n" +
    "Do this:\n" +
    "1. Gather every source the user named, using the tools you already " +
    "have — `read`/`grep`/`find` for local files or directories, " +
    "`spider fetch` for URLs, the current conversation history if they " +
    "referred to something you just did, and the text they pasted as-is. " +
    "If the request is ambiguous about scope, make a reasonable choice " +
    "and note it; do not stall.\n" +
    "1b. Apply every requirement, focus, and constraint in the request to " +
    "the skill you author — these govern what the SKILL.md covers and " +
    "emphasizes, not just which sources you read.\n" +
    "2. Stage ONE SKILL.md candidate via the `skill` action with op:\"add\", " +
    'passing `name` (lowercase-hyphenated) and `text` set to the FULL markdown ' +
    "body INCLUDING your own YAML frontmatter with exactly name and description. " +
    "Pick a sensible category if one applies. This only STAGES a candidate for " +
    "review; it does not activate anything, and you must never call op:\"approve\" " +
    "yourself. Tell the user to run `spider skill op=approve name=<name>` when " +
    "they are ready to activate it.\n\n" +
    `${AUTHORING_STANDARDS}\n\n` +
    "When done, tell the user the skill name, its category, and a " +
    "one-line summary of what it captured."
  );
}
