---
name: why
description: "Use for 'why does X work this way', 'why we picked Y', design rationale, regressions, or postmortems. Queries each evidence category spider can reach (git history and the codebase, GitHub issues through gh, past sessions and memory through spider search, web pages through spider fetch) in parallel, then returns a cited read on decisions and tradeoffs. Use how for runtime behavior."
---

# Why

Investigate the motivation and intent behind code. The companion `how` skill answers what the code does and how it works. `why` answers what forces led to its shape.

Every spawn below is a `spider run` child with `agent: "scout"` and `context: "fresh"`, and names a role in [Models](#models). Resolve that role's model from `spider control models` and pass it as `model`. Pick each subagent's `thinking` level for the job.

Tell every spawn not to edit files, commit, or change external state. Investigators still need `spider exec` (for `git`, `gh`, and `rg`), `spider search`, and `spider fetch`, and the synthesizer needs them for its citation spot-checks, so don't strip those tools.

## Operating Posture

Operate as a **careful, cautious, and precise investigator**. Be honest about what you know vs what you're inferring. Read `references/epistemics.md` for the full confidence framework and phrasing guide. The synthesizer must follow it.

## Step 1. Understand the Target and the Question

The **target** is usually a chunk of code, a pattern, a feature, or a named design decision. The **question** is usually a design rationale, a tradeoff, a motivating edge case, an external constraint, dead code, or a broad history sweep.

If the target is vague ("why do we do it this way?" with no clear referent), make your best guess from conversation context (open files, recent edits, cursor location, what was just discussed). State your interpretation briefly so the user can redirect if you're off, then proceed.

## Step 2. Establish the Code Anchor

Before spawning investigators, build the seed context inline: file paths and line ranges, key symbols (functions, classes, constants), the last few commits touching the target, PR numbers from merge commits (pattern `(#1234)` in the subject line), and any linked ticket IDs. Run these through `spider exec`: `git blame -L <start>,<end> <file>` for last-touch commits, `git log --follow -p -- <file>` for full history with patches through renames, `git log --oneline -20 -- <file>` for recent commits with PR numbers visible, and `git log -1 --format=%B <commit>` to extract PR numbers. Then pull the PR bodies and discussion for any substantive commit: `gh pr view <number> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews`. This anchor goes to every investigator and to the synthesizer.

## Step 3. Spawn Parallel Investigators

**Default to the full parallel investigation.** The goal is a complete coverage map, not a minimal one. Document the null, don't skip the search.

### Discovery

Map each source spider can reach to one evidence category:

1. Source control history and the codebase: `git` and `rg` through `spider exec`
2. Issue tracker on GitHub: `gh` through `spider exec`
3. Past agent sessions and memory: `spider search` and `spider recall`
4. Web pages and external docs: `spider fetch`

Source control is always available through git. Check the others before spawning: the repository has a GitHub remote and `gh auth status` passes, `spider search` returns session or memory results for the target, and the anchor, code comments, or docs name URLs worth reading. Record ambiguous cases in the coverage map.

Spawn one investigator per category with a reachable source, all in one `spider run` call (`tasks: [...]`) so they run concurrently, each owning exactly one source. Don't ask one agent to cover several sources. `model`: the why investigators role in [Models](#models).

Each investigator's prompt is `references/investigator-prompt.md` filled in, plus:
- the playbook for its category from `references/source-playbook.md` (for source control, the full guide `references/sources/code-archaeology.md`)
- `references/sources/incident-postmortem.md` **if the target code looks defensive** (null checks, retry logic, timeout handling, rate limiting, feature flags, egress guards, OOM handlers)
- the code anchor and the user's original question

### Investigator roster, one per reachable evidence category

Each category below is uniquely positioned to surface one shape of "why", shown after "Best at". Use it to know what to expect back, to name a gap when a category returns empty, and, only in the rare provably-irrelevant case, to justify a skip.

1. **Source control** (git history, `gh` for PRs, code comments, tests). Always spawn, the only guaranteed source. Best at *implementation-time rationale captured during review*.
2. **Issue tracker on GitHub** (`gh issue`, `gh search issues`, linked discussions). Best at *the product or business forcing function*. Strongest when the why is external to engineering.
3. **Past agent sessions and memory** (`spider search` over sessions and memory, `spider recall`). Best at *deliberation with an agent that never reached a commit message or PR*. Especially important when the source control and ticket paper trail is thin.
4. **Web pages and external docs** (`spider fetch` on URLs from the anchor, code comments, docs, or upstream projects). Best at *external constraints that shaped the code*: an upstream API's limits, a spec, a changelog, a published design doc.

Team chat, long-form docs behind a login, infrastructure observability, error tracking, and product analytics are out of spider's reach. When the question turns on one of them, name it as a gap in Sources Consulted so the user knows where to look.

### When to skip an investigator

Only with an **explicit, written justification** that goes in the final Sources Consulted. Two valid reasons:

- **The source is unreachable** in this environment. Flag it as a gap, not a choice: "Issue tracker skipped. The repository has no GitHub remote, so its issues were not searchable."
- **The source is provably irrelevant**, not just "probably irrelevant." A high bar: "Web pages skipped. The target names no external system, spec, or URL."

If your scope assessment suggests a single-commit trivial target where the PR description already contains the complete answer, you may answer inline **only after** confirming all four category searches would be redundant. Say so explicitly. This should be rare.

## Step 4. Synthesize

Spawn one synthesizer. `model`: the why synthesizer role in [Models](#models). It gets:
1. The investigator findings, including any null results and any categories skipped with justification
2. The code anchor
3. The user's original question
4. The epistemics framework from `references/epistemics.md`
5. The synthesizer prompt template from `references/synthesizer-prompt.md`

## Step 5. Present

Present the synthesizer's output to the user. You may lightly edit for clarity or add context from the conversation, but **do not rewrite the confidence language**.

## Output Format

The structure is the one in `references/synthesizer-prompt.md`: The Question, The Code in Question, What We Found, What We Can Reasonably Infer, Competing Hypotheses, What We Don't Know, Sources Consulted, Confidence Summary. Adapt as needed, but keep the confidence separation intact, and keep Sources Consulted as one line per investigator, including the ones that returned nothing or were skipped, with the reason.

After Sources Consulted, if the user's `why` question is a precursor to changing this code, convert the lineage findings into a Preserve / Change / Avoid / Risk constraint set for planning the change.

## Common Failure Modes to Avoid

- **Recency bias**. Assuming the most recent commit is authoritative. The current shape is often the accretion of many earlier decisions. Trace back.

## Models

Name roles, not model ids. Resolve each from `spider control models` when you dispatch.

- why investigators: a capable model
- why synthesizer: a capable model
