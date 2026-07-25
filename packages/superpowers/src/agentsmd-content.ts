export const SPIDER_BLOCK_START = "<!-- spider:start -->";
export const SPIDER_BLOCK_END = "<!-- spider:end -->";

export const SPIDER_BLOCK_BODY = `# spider (managed — do not edit inside the markers)

This block is written and updated by the **spider** pi extension. Edits between
the markers are overwritten on upgrade. Put your own notes outside the markers.

**spider is the single unified extension** — subagents, memory, unified search,
todos, sandboxed exec, and web fetch on one shared SQLite DB. It **replaces** the
legacy \`pi-subagents\`, \`context-mode\` (\`ctx_*\`), and standalone todo tools —
do not reach for those; use the \`spider\` verbs below.

## Skills first

You have **superpowers** — a skills library. Before acting on any non-trivial
request, reflexively: if there is even a 1% chance a skill applies, load and
follow it (\`spider skill\`, or \`read\` its \`SKILL.md\`) BEFORE responding —
including before clarifying questions. Start process skills first
(\`brainstorming\`, \`systematic-debugging\`), then implementation
(\`test-driven-development\`, \`writing-plans\`,
\`subagent-driven-development\`, \`requesting-code-review\`,
\`finishing-a-development-branch\`). User instructions in this file always take
precedence over skills.

## The spider tool

Everything runs through the single \`spider\` tool. Prefer its verbs over raw
built-ins:

- \`spider search\` — unified FTS+vector search over memory, content, sessions,
  and todos. Reach for it before re-reading files.
- \`spider exec\` / \`spider exec_file\` / \`spider batch\` — run commands or
  analyze large files in a sandbox; only what you print/query enters context.
  **\`bash\` is mechanically blocked** — \`spider exec\` is the shell. Use plain
  \`read\` only when you will \`edit\` the file (so edits match exact text).
- \`spider index\` / \`spider fetch\` — index files/dirs or fetch+index URLs into
  the knowledge base for \`spider search\`.
- \`spider run\` — dispatch subagents (single / chain / parallel / pipeline,
  always async). Pass an explicit **provider-qualified** \`model:\` (e.g.
  \`github-copilot/claude-sonnet-5\`) scaled to task complexity (cheap for
  mechanical, capable for architecture/review), plus \`thinking:\`. Subagents run
  in the background and report back via a \`spider.subagent_done\` message — there
  is no blocking wait. For multi-phase work use
  \`pipeline:[worker, reviewer], handoff:"intercom"\`. Give review-only children
  \`context:"fresh"\` and tell them not to edit source.
- \`spider todo\` — durable, per-project + per-session task tracking
  (\`list\`/\`add\`/\`toggle\`/\`clear\`/\`sessions\`/\`view\`). One todo per
  checklist item; toggle as you complete each.
- \`spider message\` — wake a specific peer/reviewer session directly.
- \`spider control <command>\` — admin: \`doctor\`, \`stats\`, \`insights\`,
  \`models\`, \`config\` (get/set), \`memory\`, \`migrate\`, \`upstream-watch\`.
  Every result renders as a themed card, never raw JSON.

## Escalation

You MUST escalate when blocked, when the task is ambiguous in a way that
changes the outcome, when about to do something destructive or irreversible,
or when you discover the task's premise is wrong. Escalating is expected and
is NOT a failure — failing silently is worse.

## Slash commands

\`/todos\` and \`/agents\` open live overlays. \`/spider\` \`/search\` \`/memory\`
\`/insights\` \`/learn\` \`/doctor\` \`/stats\` forward to the matching spider action.

## Memory discipline

Memory is **DB-as-truth**. Use \`spider remember\` to store structured truths
that **link to** a file/skill — never duplicate a document or commit history.
Categories: preference, convention, tool-quirk, failure, correction, insight.
Background/\`[auto]\` writes are **staged and fail-closed**; approve or reject via
\`spider control memory\`. A frozen memory snapshot is injected each session —
new writes persist immediately and re-inject next session. Use \`spider recall\`
to fetch by category/scope.

## Scratch — never /tmp

Never use \`/tmp\`, \`$TMPDIR\`, or \`/var/tmp\` for scratch, golden data, or
logs — they are volatile and destroy baselines mid-task. Put all
scratch/intermediate/golden/log data under the project's \`.spider/scratch/\`
(or \`~/.pi/agent/spider/scratch/\` for global work).
`;

export function buildSpiderBlock(): string {
  return `${SPIDER_BLOCK_START}\n${SPIDER_BLOCK_BODY.trim()}\n${SPIDER_BLOCK_END}`;
}
