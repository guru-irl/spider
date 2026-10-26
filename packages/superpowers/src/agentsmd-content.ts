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

## pstack skills

spider also ships 31 skills adapted from pstack. Use them alongside the
superpowers skills above; they replace none of them.

- \`how\`: how code works, a walkthrough before changing it, or where code should
  live. \`why\`: why code or a decision is the way it is, with cited evidence.
  \`teach\`: explain a body of work so a person understands it; it runs \`how\`
  and \`why\`.
- \`unslop\`: any prose a person will read, your reply included.
  \`technical-writing\`: docs, READMEs, RFCs, PR descriptions and commit
  messages, on top of \`unslop\`. \`bro\`: restate the last message in plain words
  when asked.
- \`show-me-your-work\`: keep its decision log for long, unattended or
  multi-phase work.
- \`principle-*\`: each description says when it applies. When a decision
  matches one, read that skill in full first. In your reply, name each
  principle you applied and the choice it changed.

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
  \`github-copilot/gpt-6.1-sol\`) scaled to task complexity (cheap for
  mechanical, capable for architecture/review), plus \`thinking:\`. Subagents run
  in the background and report back via a \`spider.subagent_done\` message — there
  is no blocking wait. For multi-phase work use
  \`pipeline:[worker, reviewer], handoff:"intercom"\`. Give review-only children
  \`context:"fresh"\` and tell them not to edit source.
  While a child runs, \`spider exec\` and \`spider batch\` block foreground sleeps,
  even with \`background:true\`; use \`spider schedule\` for external waits.
- \`spider todo\` — durable, per-project + per-session task tracking
  (\`list\`/\`add\`/\`toggle\`/\`remove\`/\`clear\`/\`sessions\`/\`view\`). One todo per
  checklist item; toggle as you complete each. Remove obsolete items with op=remove;
  clear only removes done items unless force:true, always in the current session;
  clear rejects session selectors. Use session id/prefix/name for
  toggle/remove in another session in this project; session:"all" is rejected.
- \`spider loop\` / \`spider schedule\` wait on external work (CI, deploys,
  timers), never subagents; completion notices arrive automatically. Persistent
  top-level sessions only, including RPC. Named triggers replace only the same
  name, with defaults \`loop\` and \`wakeup\`. Loop accepts \`interval\` or numeric
  \`cron\` with an IANA \`tz\`; cron has no immediate first prompt. Schedule accepts
  \`delaySeconds\` or an offset-bearing \`at\`. Self-paced re-arms require the same
  name and exact \`/loop <prompt>\`; pass \`name:"loop"\` for the default loop.
  Busy interval occurrences stay due and fire once, then advance from the anchor.
  Tool loop stop leaves an independent one-shot intact. \`/loop\` lists all triggers;
  \`/loop stop\` stops both defaults, \`/loop stop <name>\` stops one, and
  \`/loop stop all\` stops all. Extra stop words are not a self-paced prompt.
  Definitions survive \`/reload\` and same-session resume; new and fork start empty.
  Nothing fires while closed or asleep. Missed once and cron run once late;
  intervals resume from their anchor without catch-up.
- \`spider message\` — wake a specific peer/reviewer session directly.
- \`spider control <command>\` — admin: \`doctor\`, \`stats\`, \`insights\`,
  \`models\`, \`config\` (get/set), \`memory\`, \`migrate\`, \`bind\`, \`unbind\`,
  \`upstream-watch\`. Every result renders as a themed card, never raw JSON.

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
Every remember requires a \`justification\`: why the fact remains true and useful
after this task, how it helps other agents, and why its scope is correct (global
only if true in every repo, otherwise repo). A reviewer checks durability,
overlap, and scope before storing; task-only facts belong in the conversation.
If review fails, the write is stored as requested and marked \`review skipped\`.
Categories: preference, convention, tool-quirk, failure, correction, insight.
Background/\`[auto]\` writes are **staged and fail-closed**; approve or reject via
\`spider control memory\`.
- The first agent start freezes the session's memory block; later turns reuse it.
- New writes persist immediately and re-inject next session. A changed session ID
  or file, extension reload, or changed memory binding target refreshes the block.
- Subagent sessions freeze independently. Use \`spider recall\` to fetch current
  active memory by category/scope.

**Scope rule:** "Is this true in every repo?" → **global**; otherwise → **repo**.
Worktree memory was removed; use repo for facts specific to a repository.

## Scratch — never /tmp

Never use \`/tmp\`, \`$TMPDIR\`, or \`/var/tmp\` for scratch, golden data, or
logs — they are volatile and destroy baselines mid-task. Put all
scratch/intermediate/golden/log data under the project's \`.spider/scratch/\`
(or \`~/.pi/agent/spider/scratch/\` for global work).
`;

export function buildSpiderBlock(): string {
  return `${SPIDER_BLOCK_START}\n${SPIDER_BLOCK_BODY.trim()}\n${SPIDER_BLOCK_END}`;
}
