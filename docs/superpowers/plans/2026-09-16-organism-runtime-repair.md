# Organism Runtime Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the documented lifecycle-driven learning loop and prove it produces reviewable proposals using the real pi runtime contract, rather than synthetic events and a disconnected fake model.

**Architecture:** Keep the existing drain → passes → staged writes pipeline and explicit approval policy. Resolve session identity, branch entries, CWD, config and the authenticated model registry from the current ExtensionContext. Use pi's public ModelRegistry.complete API. Record failure/skipped/completed outcomes independently of write counts and expose the last run through the existing diagnostic surface.

**Tech Stack:** TypeScript, pi 0.85.1 public extension/SDK APIs, Vitest, better-sqlite3, Vite, Node 26.4.0.

## Global Constraints

- Work on `fix/reporting-integrity`; main requires a PR and a passing build.
- Node: `export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"`.
- No dependency installation or native rebuild during implementation. Preserve better-sqlite3's existing ABI-147 binding.
- All scratch, receipts and isolated fixtures live under `.spider/scratch/`; never `/tmp` or user production databases.
- Git-init fixture directories before any project resolver runs so it cannot walk up to the real repository.
- No deep imports from pi. Use documented public exports; typecheck against actual installed declarations, not blanket ambient `any` modules.
- Automatic memory/skill output stays staged. Disabled mode performs no model calls/writes. No automatic file activation, pruning of user memory, or rewriting of user sessions.
- Reviewers: `github-copilot/claude-opus-5`, thinking xhigh; implementers: `github-copilot/claude-sonnet-5`.
- Existing workers own runner/run-store, intercom/dispatch, executor/exec, and memory/host extension. Do not edit a currently owned file until its worker hands it back. Models and context/transcript are independent of those assignments.
- Use real event shapes: session events do **not** carry `sessionId` or `cwd`. Use `ctx.sessionManager.getSessionId()` and `ctx.cwd`.

## Evidence before changes

- `packages/organism/src/index.ts` reads `event.sessionId` in both lifecycle handlers and returns immediately when it is absent. Pi's SessionStart/SessionShutdown/SessionBeforeCompact event types have no such field.
- `packages/host/src/hooks.ts` repeats the same mistake for session persistence; `extension.ts` repeats it for routing's currentSessionId. Read-only live inspection: zero `sessions` rows, all 1,834 tracked events unassociated with a session, zero organism drain receipts.
- `packages/models/src/complete.ts` uses `pi-ai.getModel` and `pi-ai.streamProxy`; neither exists in installed pi-ai. `ModelRegistry.complete` is the public authenticated completion path in pi 0.85.1, demonstrated by the shipped custom-compaction and summarize examples.
- `registerOrganism` never passes a transcript path. `context/src/transcript.ts` also skips every native `{type:'message', message:{role,content}}` record. Existing smoke tests inject legacy flat records and explicit paths.
- `controlConfig` reads/writes dotted keys. Organism and auxiliary config readers inspect nested objects, so actual overrides and the master disable switch are ignored.
- The loop swallows model errors as empty results; its tests inject a ready-made model and seed sessions manually. Those tests do not exercise the broken host boundaries.
- Skills are staged in the repo DB, not installed automatically. Candidate approval currently clears the only stored body without writing a skill file; no action exposes that approval method. This must not be represented as a working activation path.

## Task 1: Authenticated model completion

**Files:** `packages/models/src/complete.ts`, `packages/models/src/pi-ai.d.ts`, `packages/models/src/index.ts`, new `packages/models/src/__tests__/complete-registry.test.ts`.

**Interface:** Extend `CompleteOpts` with `registry?: Pick<ModelRegistry, 'find' | 'complete'>` and `signal?: AbortSignal`. Preserve the explicit injected `CompleteDeps` seam for its existing callers. Production callers supply the registry; missing registry/model is a clear error, not a guessed unauthenticated provider.

- [ ] Write RED tests for the default (non-CompleteDeps) path using the real registry contract: selection preserves provider+ID and custom model configuration; system goes into `Context.systemPrompt`; user messages have timestamps; thinking maps to `reasoningEffort`; signal and maxTokens propagate.
- [ ] Assert returned text comes from final `AssistantMessage.content` text blocks. Error/aborted stop reasons and an empty response reject with an actionable error, never successful empty text.
- [ ] Replace nonexistent pi-ai functions with `registry.find(...)` and `await registry.complete(handle, context, options)`. Remove the blanket `declare module` hiding type errors.
- [ ] Run focused tests and typecheck; save RED/GREEN evidence under `.spider/scratch/organism-investigation/`.

## Task 2: Real session input and context wiring

**Files:** `packages/host/src/hooks.ts`, `packages/host/src/extension.ts` after its worker hands it back, `packages/organism/src/index.ts`, `packages/organism/src/drain.ts`, `packages/context/src/transcript.ts`, corresponding new tests.

**Interfaces:** A lifecycle handler receives `(event, ctx)`; resolve identity/CWD from ctx. Capture branch messages synchronously at the trigger so background processing cannot observe a later branch/session. `DrainOpts` may carry a normalized transcript directly as well as a file path. A dependency factory may resolve WorkerDeps per actual session/project rather than binding to process.cwd at extension load.

- [ ] Add RED tests using public `SessionManager` + `ExtensionRunner` and real event shapes. Assert session_start inserts the correct row and routing events use the same ID.
- [ ] Add a real pi JSONL regression with nested text blocks and a branched path. Ignore thinking/custom bookkeeping; keep user and assistant prose with correct attribution. Preserve legacy flat input support.
- [ ] Fix transcript normalization and feed branch data from the lifecycle context into the drain. Never mutate the conversation or compaction preparation.
- [ ] Fix `before_agent_start` to return the updated systemPrompt using the actual runner protocol, rather than relying on mutation of its event argument. Verify approved memory is present in the next prompt and staged memory is absent.
- [ ] Share current runtime identity/model/config with manual and automatic organism paths. Honor the current worktree binding; do not pin all activity to the extension's activation CWD.
- [ ] Prove before-compact remains non-blocking and shutdown awaits its own worker without cancelling or overriding compaction.

## Task 3: Configuration, safe output and observable outcomes

**Files:** `packages/organism/src/config.ts`, `worker.ts`, `types.ts`, `apply.ts`, `aux-model.ts`, `skill-usage.ts`, `actions.ts`, `renderers.ts`; `packages/memory/src/aux.ts` only after handoff; host glue and docs.

- [ ] RED tests exercise dotted values exactly as returned by `controlConfig`: master disable, per-pass disable, write budget, curator settings and provider-qualified auxiliary override. Preserve existing nested config inputs; explicit dotted leaves win.
- [ ] Model selection defaults to the current parent model when no override exists; explicit provider/model is validated, not silently replaced with another available model.
- [ ] Distinguish disabled/no-input/no-model/failed/completed drains in a structured receipt. Record which pass failed and keep the other passes safe to run. A model/schema error must not become a success-looking zero-count result.
- [ ] Use the existing run_events log and diagnostic/card surfaces to show the last outcome and pending counts. Do not dump transcripts or credentials into diagnostics.
- [ ] Count only newly staged rows; a duplicate is not a new write. Prevent automatic candidates from downgrading/replacing approved, pinned or protected skills.
- [ ] Expose skill candidate review through the existing control/skill surface. Approval validates the name, writes a discoverable SKILL.md without overwriting an existing file, and only then activates the row. Rejection leaves no active artifact. Keep user review explicit.
- [ ] Bound the background request lifetime and surface timeout/error outcomes without blocking compaction or indefinitely delaying shutdown.

## Task 4: Integration, independent review and deployment

- [ ] Drive a real-API-shaped lifecycle through the real extension registry and real isolated SQLite schemas, mocking only the external model response. Check the provider request sees the session conversation; a proposal is staged, a summary is persisted/searchable, a receipt is visible, and approval feeds the next memory snapshot/skill discovery.
- [ ] Repeat without useful input, with disabled config, with missing auth/model, with provider failure and during a worktree/session switch. None may claim to have produced a proposal it did not store.
- [ ] Mutation-check the important boundaries: remove ctx session ID, drop transcript forwarding, disconnect registry completion. Each must make the integration test fail for the expected reason.
- [ ] Independently review the diff with Opus 5. Integrate the prior four defect workers without clobbering their files.
- [ ] Run `npm run typecheck`, `npm test`, `npm run build` with actual exit codes and logs under scratch. Check the native binding still loads.
- [ ] Exercise the built extension using a small synthetic conversation and the real authenticated registry, with all output DBs isolated. Report actual staged items/counters, not just a test pass.
- [ ] Open the PR; verify the required GitHub CI check actually runs. Update the installed checkout only after a reviewed green build, preserving local files and explaining that a reload is needed.
