export const SPIDER_BLOCK_START = "<!-- spider:start -->";
export const SPIDER_BLOCK_END = "<!-- spider:end -->";

export const SPIDER_BLOCK_BODY = `# spider (managed — do not edit inside the markers)

This block is written and updated by the **spider** pi extension. Edits between
the markers are overwritten on upgrade. Put your own notes outside the markers.

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
  **Prefer these over raw \`bash\`/\`read\` whenever output could exceed ~10
  lines** (git, tests, logs, repo-wide grep). Use plain \`read\` only when you
  will \`edit\` the file (so edits match exact text).
- \`spider index\` / \`spider fetch\` — index files/dirs or fetch+index URLs into
  the knowledge base for \`spider search\`.
- \`spider run\` / \`spider wait\` — dispatch subagents (single/chain/parallel/
  async, \`context:"fresh"|"fork"\`). Always pass an explicit \`model:\` scaled
  to task complexity (cheap for mechanical, capable for architecture/review).
  For multi-phase work use push-based handoff:
  \`spider run { pipeline:[worker, reviewer], handoff:"intercom" }\` — the
  finishing stage wakes the next with its outputs instead of blocking on
  \`wait\`. Give review-only children fresh context and tell them not to edit
  source.
- \`spider todo\` — durable, per-project + per-session task tracking
  (\`list\`/\`add\`/\`toggle\`/\`clear\`/\`sessions\`/\`view\`). One todo per
  checklist item; toggle as you complete each.
- \`spider message\` — wake a specific peer/reviewer session directly.
- \`spider control <command>\` — admin: \`stats\`, \`doctor\`, \`memory\`,
  \`upstream-watch\`, \`config\`, \`insights\`, and more.

## Memory discipline

Memory is **DB-as-truth**. Use \`spider remember\` to store structured truths
that **link to** a file/skill — never duplicate a document or commit history.
Categories: preference, convention, tool-quirk, failure, correction, insight.
Background/\`[auto]\` writes are **staged and fail-closed**; approve or reject via
\`spider control memory\`. A frozen memory snapshot is injected each session —
new writes persist immediately and re-inject next session. Use \`spider recall\`
to fetch by category/scope.

## Scratch — never /tmp

Never use \`/tmp\`, \`\$TMPDIR\`, or \`/var/tmp\` for scratch, golden data, or
logs — they are volatile and destroy baselines mid-task. Put all
scratch/intermediate/golden/log data under the project's \`.spider/scratch/\`
(or \`~/.pi/agent/spider/scratch/\` for global work).
`;

export function buildSpiderBlock(): string {
  return `${SPIDER_BLOCK_START}\n${SPIDER_BLOCK_BODY.trim()}\n${SPIDER_BLOCK_END}`;
}
