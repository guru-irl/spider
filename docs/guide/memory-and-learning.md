# Memory and learning

## Memory scope and review

- Use global scope only for facts that are true in every repository. Use repo scope for everything else. The worktree and project memory scopes are removed.
- The categories are `preference`, `convention`, `tool-quirk`, `failure`, `correction` and `insight`.
- Store durable facts that link to their source material. Do not store copies of documents or task progress.
- Every `remember` needs a nonblank `justification`. It says why the fact stays useful later, how it helps other agents, and why the scope is correct.
- The foreground reviewer first checks durability. It then checks active entries in both scopes for overlap, replacements and scope.

| Verdict | Result |
| --- | --- |
| `new` | Store the proposal. |
| `already_present` | Return the existing UUID. |
| `supersedes` | Archive replaced entries and save the proposal. |
| `wrong_scope` | Save in the corrected scope. |
| `not_durable` | Leave task-only information in the conversation. |

- If review fails with an error, an unavailable model, a timeout or an abort, or if review is disabled, spider stores the write as requested and reports `review skipped: <reason>`.
- Condensing entries through `supersedes` must keep their information. User preferences and standing instructions cannot lose information unless the user has said something newer. Corrections need a newer user statement.
- Foreground `remember` accepts `supersedes:["<uuid-or-unique-prefix>"]` to replace active entries in the same scope. If a target is unknown, ambiguous, inactive or in another scope, the call is rejected and nothing is written. The reviewer still checks durability, usefulness and scope, and it may add targets in the same scope. A rejected write archives nothing. If the reviewer redirects the scope of a write with explicit targets, the write is rejected instead of archiving across scopes. If review is skipped but the write goes ahead, the explicit targets still apply.
- Background and auto-captured writes are staged and fail closed. They become active only after someone approves them. Staged writes do not support explicit `supersedes`, and a staged write that uses it is rejected without writing. Targets the reviewer suggests are only listed as related entries, so approving a staged entry archives nothing. To replace or remove entries, use foreground `remember` with `supersedes`, or `forget`.
- Rejecting a staged entry keeps a note outside the active set. It does not delete the row.

```text
spider control command:"memory" sub:"pending"
spider control command:"memory" sub:"approve" uuid:"<uuid>" scope:"repo"
spider control command:"memory" sub:"reject" uuid:"<uuid>" scope:"repo"
spider control command:"memory" sub:"forget" uuid:"<uuid>" scope:"repo"
```

## Storage and injection limits

- Active memory content has a storage cap of `8000` characters per scope, counted separately for global and repo. Spider refuses writes and approvals that would go over the cap. It does not truncate them.
- To see the budget, run `control memory sub:"status"`. To free active space, use `sub:"forget"`. To replace or condense an active entry in one atomic step, use `remember` with `supersedes`.
- To decide whether a replacement fits, spider takes current usage, subtracts the sizes of all active targets in the same scope, and adds the size of the new content. The cap check, the archives and the insert run in one immediate transaction. Approval also checks the cap and activates the entry inside an immediate transaction.
- When an overflow can be fixed, the card lists all active entries. It marks the replacement targets and shows the space each frees and the projected usage. If a new entry is larger than the cap on its own, you must shorten it, and its card lists no entries to evict.
- `memory.snapshotCharCap` limits prompt injection only, not storage. By default spider injects all active memory.
- The first `before_agent_start` reads a memory snapshot and freezes it for the session, even if the snapshot is empty. The hook sets the named `spider_memory` prompt section, or removes only that section when the snapshot is empty. Pi 1.2.0 runs this hook for user turns and for idle completion notifications. It keeps the section through queued work, tool cycles, steers and follow-ups.
- New writes, approvals and supersessions are saved at once, but they do not change the block in the current session. They enter the prompt next session. `recall` reads the current active rows.
- Spider takes a fresh snapshot when the session ID or file changes, the working directory changes, the extension reloads, or the memory binding target changes. That covers new, resumed and forked sessions. Each subagent session freezes its own snapshot.
- Spider does not force the whole prompt in order to add memory. If an earlier extension already forced it, spider appends the frozen block only if the block is not there yet. Later extensions should build on the current prompt instead of replacing it with unrelated text.
- Pi saves the global and repo memory text in the local session file. An unchanged section produces one saved patch, and each change adds another patch. Compaction checkpoints can save another copy of the current section. Removing a section does not erase its old values from history, or from requests that keep historical system messages. HTML and JSONL exports can contain this memory. Review sessions and exports before you share them.
- An explicit injection cap can leave entries out, and the cap is frozen with the snapshot. `/doctor` reads the current memory and config, so its counts can differ from the frozen block of a running session.
- Repo recall ranks matches on all words before matches on any word. It strips FTS operators and removes common words, unless every word is common. Global recall matches the whole query as a substring.

## Reviewer settings

| Setting | Memory reviewer | Skill reviewer |
| --- | --- | --- |
| Key prefix | `memory.reviewer` | `skills.reviewer` |
| `.enabled` | `true` | `true` |
| `.model` | `github-copilot/gpt-6-luna` | `github-copilot/gpt-6-luna` |
| `.thinking` | `medium` | `xhigh` |
| `.timeoutMs` | `45000` | `180000` |
| Timeout range | Integer `1000` to `120000` | Integer `1000` to `600000` |

- Thinking accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. It is set separately from the session model and the learner model.
- Reviewers call pi's authenticated `streamSimple(...).result()` with the provider-neutral `reasoning` option. Provider errors, aborts and empty replies count as failures.
- Model usage by the learner, memory review, skill review and skill curation appears in the pi footer, in `/session` and in RPC session totals. This includes the drain at shutdown and curation. Spider skips calls still running after the session ends or switches. It does not charge them to another session.
- On hosts without usage entries attributed to a model, spider attaches pending usage to the next spider tool result in the session that owns it. The usage then appears under tools and in summaries.
- Set the dotted keys as described in [Configuration](configuration.md).

## Background learning

- Optional [managed compaction](compaction.md) is separate from learning. The organism drain does not replace its summary result.
- The organism (spider's background learning process) registers compaction and shutdown work only in parent sessions. `PI_SUBAGENT_CHILD=1` turns off those hooks and the manual organism actions.
- Background learning and skill consolidation default to `github-copilot/gpt-6-luna` with `low` thinking, not the session model.
- To override the model, set `auxiliary.background_review.model` and `.provider`. If you set only the provider, spider uses `<provider>/gpt-6-luna`.
- A bare model ID must match exactly one available catalog entry, limited to the configured provider if there is one. It does not fall back to the session's provider.
- If the model is unavailable, the drain records an error. Spider does not fall back to another model.
- Turning off `organism.enabled` stops automatic work. The foreground memory and skill reviewer toggles are separate settings.
- The learner proposes new techniques. It cannot patch existing skills, and by default its result proposes no skills.
- [Configuration](configuration.md#common-defaults) lists the budgets and the toggles for each pass.

## Skill validation and staging

- `skill op:"add"` takes a name and the final `SKILL.md` text. It stages a candidate and never activates it.
- A name is lowercase letters and digits joined by single hyphens, at most `64` characters, with no path and no `.md` suffix.
- The YAML frontmatter has exactly `name` and `description`, and its name matches the name passed to the action.
- The description starts with `Use when`, names the triggers that should surface the skill, and is at most `500` characters. The frontmatter is at most `1024` characters.
- The instructions must not be empty and must pass the strict memory threat scan.
- Skills from the learner or curator may have up to `500` instruction words and `8000` UTF-8 bytes. Skills added by agents, distill output included, may have up to `1500` instruction words and `16384` bytes for the full text.
- If a deterministic check fails, spider rejects the skill without a model call, even when review is disabled.
- The curator archives existing skills created by the project or by agents. It does not stage candidates itself. The bundled superpowers and pstack skills stay on disk outside the skill database, so the decay, staleness, archive and consolidation passes never pick them.
- The reviewer applies the full bundled `writing-skills` rubric, then checks durability, text quality and whether existing skills already cover the topic. Staging does not need deployment or pressure-test evidence.
- The reviewer's catalog holds at most `150` entries. It lists bundled superpowers and pstack skills first, then active skills, then skills pi has loaded, then recently updated staged skills. Each description is cut to `300` characters.
- The learner system prompt, with the rubric, the catalog and active memory, is capped at `180000` UTF-8 bytes. If skill guidance is unavailable or too large, spider leaves it out and memory learning still runs.

## Learner review queue

- Proposals that pass the deterministic checks, up to `organism.maxSkillProposals`, enter the durable review queue in the repo. Drains report `skillsQueued`, not reviewed stages.
- Top-level sessions review the queue in the background at session start and after a drain before compaction. Queue review never starts during shutdown or in children.
- A lease in the repo database makes reviews run one at a time across processes and handles.
- Only a `new` verdict stages a skill and saves its reason. `duplicate`, `not_durable` and `low_quality` remove the queued proposal, and doctor shows recent verdicts.
- After an error, a timeout, an abort or an invalid reply, the proposal stays queued, with its attempt count and `last_error`. After three attempts, spider drops the proposal and records a reason.
- Doctor shows the queue length and recent review outcomes.
- Skills added by agents wait for an inline review, in children too, without starting an organism worker. The result gives the verdict and reason, the existing skill's name, or the failed rules, as applicable.
- If an agent's review fails, spider stages the skill as requested with `review skipped: <reason>`.
- Turning off the skill reviewer leaves skill guidance out of the learner prompt and leaves queued reviews pending. Skills added by agents are still validated and staged as review-skipped.
- Children can `list`, `view` and `add` skills, but cannot `distill`, `approve` or `reject`. They also cannot run `control skill sub:"curate"` or `control insights`.
- To approve or reject a staged skill, call `skill op:"approve"|"reject" name:"<name>"`. `/learn` queues a distillation prompt and never approves its own result.

## Local diagnostics

- `.spider/logs/reviewer-thinking.jsonl` records the requested and effective reasoning levels, with a notice when thinking changes or cannot be verified. Memory receipts also note caps, adjustments, thinking turned off, and unknown models.
- `.spider/logs/reviewer-errors.jsonl` records parse and transport failures, with redacted errors and at most `2` KiB of the raw reply. Raw replies never appear in tool output that the model sees.
- Each log rotates at `1` MiB and keeps one previous file. The logs stay on the local machine but can still hold sensitive text.
- Schema v12 adds skill review reasons and durable tables for the queue, results and lease. v13 repairs incomplete earlier deployments. Older skills stay readable.
- [Data model](../architecture/data-model.md) covers database tiers and migrations. [Learning loops](../architecture/feedback-and-learning-loops.md) has diagrams.
