# Memory and learning

## Memory scope and review

- Use global scope only for facts true in every repository. Otherwise use repo scope; worktree/project memory scopes are removed.
- Categories: `preference`, `convention`, `tool-quirk`, `failure`, `correction`, `insight`.
- Store durable facts that link to source material, not document copies or task progress.
- Every `remember` needs a nonblank `justification`: future usefulness, usefulness to other agents, and why the scope is correct.
- The foreground reviewer checks durability, then active entries in both scopes for overlap, replacements, and scope.

| Verdict | Result |
| --- | --- |
| `new` | Store the proposal. |
| `already_present` | Return the existing UUID. |
| `supersedes` | Archive replaced entries and save the proposal. |
| `wrong_scope` | Save in the corrected scope. |
| `not_durable` | Leave task-only information in the conversation. |

- Review errors, unavailable models, timeouts, aborts, or disabled review store as requested and report `review skipped: <reason>`.
- Condensation through `supersedes` must preserve information. User preferences and standing instructions cannot lose information without a newer user statement; corrections require a newer user statement.
- Background and auto-captured writes are staged and fail closed. They become active only after explicit approval.
- Rejecting keeps a note outside the active set; it does not delete the row.

```text
spider control command:"memory" sub:"pending"
spider control command:"memory" sub:"approve" uuid:"<uuid>" scope:"repo"
spider control command:"memory" sub:"reject" uuid:"<uuid>" scope:"repo"
spider control command:"memory" sub:"forget" uuid:"<uuid>" scope:"repo"
```

## Storage and injection limits

- Active memory content has an `8000`-character storage cap per scope, independently for global and repo. Over-cap writes and approvals are refused, not truncated.
- Use `control memory sub:"status"` to inspect the budget and `sub:"forget"` to free active space. Remember a shorter version if condensing manually.
- `memory.snapshotCharCap` controls prompt injection only, not storage. By default all active memory is injected.
- The host reads a snapshot before each agent start. Newly approved memory affects the next turn, not a turn already in progress.
- An explicit injection cap can omit entries; `/doctor` reports the omitted count.
- Repo recall ranks all-word matches before any-word matches, strips FTS operators, and removes common words unless all words are common. Global recall uses the whole query as a substring.

## Reviewer settings

| Setting | Memory reviewer | Skill reviewer |
| --- | --- | --- |
| Key prefix | `memory.reviewer` | `skills.reviewer` |
| `.enabled` | `true` | `true` |
| `.model` | `github-copilot/gpt-6-luna` | `github-copilot/gpt-6-luna` |
| `.thinking` | `medium` | `xhigh` |
| `.timeoutMs` | `45000` | `180000` |
| Timeout range | Integer `1000` to `120000` | Integer `1000` to `600000` |

- Thinking accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, independently of the session or learner model.
- Reviewers use pi's authenticated `streamSimple(...).result()` with provider-neutral `reasoning`. Provider errors, aborts, and empty replies remain failures.
- Learner, memory review, skill review, and skill curation model usage appears in the pi footer, `/session`, and RPC session totals, including shutdown drain and curation. Calls still running after the session ends or switches are skipped rather than charged to another session.
- On hosts without model-attributed usage entries, pending usage is attached to the next spider tool result in its owning session and appears under tools and summaries.
- Configure the dotted keys through [Configuration](configuration.md).

## Background learning

- The organism registers compaction and shutdown work only in parent sessions. `PI_SUBAGENT_CHILD=1` disables those hooks and manual organism actions.
- Background learning and skill consolidation default to `github-copilot/gpt-6-luna` with `low` thinking, not the session model.
- Override with `auxiliary.background_review.model` and `.provider`. A provider-only override selects `<provider>/gpt-6-luna`.
- A bare model ID must match exactly one available catalog entry, restricted to the configured provider if present. It does not borrow the session provider.
- An unavailable model records a drain error; there is no fallback to another model.
- Disabling `organism.enabled` stops automatic work. Foreground memory and skill reviewer toggles are separate.
- The learner proposes new techniques; it cannot patch existing skills and defaults to no skill proposals in its result.
- Budgets and per-pass toggles are in [Configuration](configuration.md#common-defaults).

## Skill validation and staging

- `skill op:"add"` accepts a name and final-format `SKILL.md` text. It stages a candidate, never activates it.
- Names use lowercase letters/digits separated by single hyphens, at most `64` characters, without paths or `.md` suffixes.
- YAML frontmatter contains exactly `name` and `description`; its name matches the action name.
- Description starts with `Use when`, identifies discovery triggers, and is at most `500` characters. Frontmatter is at most `1024` characters.
- Instructions are nonempty and pass the strict memory threat scan.
- Learner/curator-origin validation permits `500` instruction words and `8000` UTF-8 bytes. Agent-origin additions, including distill output, permit `1500` instruction words and `16384` bytes for the full text.
- Deterministic failures reject without a model call, even when review is disabled.
- The curator archives existing skills; it does not stage candidates itself.
- The reviewer uses the complete bundled `writing-skills` rubric, then checks durability, text quality, and existing coverage. Staging does not require deployment or pressure-test evidence.
- Its catalog includes at most `150` entries, prioritizing bundled, active, pi-loaded, then recently updated staged skills. Descriptions are capped at `300` characters.
- The learner system prompt, including rubric, catalog, and active memory, is capped at `180000` UTF-8 bytes. Unavailable or oversized skill guidance is omitted without disabling memory learning.

## Learner review queue

- Deterministic-valid proposals within `organism.maxSkillProposals` enter the durable repo review queue. Drains report `skillsQueued`, not reviewed stages.
- Top-level sessions review asynchronously at session start and after a before-compact drain, never starting queue review during shutdown or in children.
- A repo database lease serializes reviews across processes and handles.
- Only `new` stages a skill and persists its reason. `duplicate`, `not_durable`, and `low_quality` remove the queued proposal, with recent verdicts visible in doctor.
- Errors, timeouts, aborts, and invalid replies remain queued with attempts and `last_error`. After three attempts, the proposal is dropped with a reason.
- Doctor shows queue length and recent review outcomes.
- Agent additions wait for inline review, including in children, without starting an organism worker. They return verdict/reason, existing name, or failed rules as applicable.
- Agent review failure stages as requested with `review skipped: <reason>`.
- Disabling the skill reviewer omits learner skill guidance and leaves queued reviews pending; agent additions still validate and stage as review-skipped.
- Children can `list`, `view`, and `add` skills, but cannot `distill`, `approve`, or `reject`. They also cannot run `control skill sub:"curate"` or `control insights`.
- Approve or reject staged skills explicitly with `skill op:"approve"|"reject" name:"<name>"`. `/learn` queues a distillation prompt; it never self-approves.

## Local diagnostics

- `.spider/logs/reviewer-thinking.jsonl` records requested/effective reasoning and notices when thinking changes or is unverifiable. Memory receipts also show caps, adjustments, off, and unknown-model notes.
- `.spider/logs/reviewer-errors.jsonl` records parse/transport failures with redacted errors and at most `2` KiB of raw reply. Raw replies do not enter model-visible tool output.
- Each log rotates at `1` MiB to one previous file. Logs stay local but can still contain sensitive text.
- Schema v12 adds skill review reasons and durable queue/results/lease tables; v13 repairs incomplete earlier deployments. Older skills remain readable.
- See [Data model](../architecture/data-model.md) for database tiers and migrations, and [Learning loops](../architecture/feedback-and-learning-loops.md) for diagrams.
