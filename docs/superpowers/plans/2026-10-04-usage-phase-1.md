# Usage Ledger Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship estimated Copilot AI Credits (AIC), a narrow-pane footer, a local calls ledger, background history ingestion, counter snapshots, and actionable doctor diagnostics.

**Architecture:** Keep the feature in `packages/host/src/usage/`: host already owns session lifecycle, public pi context, configuration, and doctor integration, and can depend on db-core without changing the package DAG. A worker thread opens and migrates the separate `usage.db`, ingests transcripts, and polls the counter; pi's main thread maintains an incremental footer reducer and receives small diagnostic/counter snapshots. Start nothing at module import or extension registration.

**Tech Stack:** TypeScript, existing db-core/better-sqlite3, Node worker_threads, native fetch, Vitest, and public root exports of pi-coding-agent/pi-tui. No additional packages or build artifacts.

**Spec:** `docs/superpowers/specs/2026-10-04-usage-dashboard-design.md`, Phase 1 only.

## Global Constraints

- No new npm dependencies and no `package.json` or lockfile change; never run npm install or npm ci.
- Production code lives under `packages/host/src/usage/`, apart from narrow integration edits in existing host/UI files.
- Package DAG remains host -> subagents -> db-core and host -> ui. Memory must not import models or host.
- Import pi packages from their root, never deep paths. Inspected APIs are pi 0.87.1; retain compatibility with the declared floor 0.87.0.
- All data stays local in `usage.db`. Nothing is uploaded. Counter traffic is an authenticated GET, not a billing write.
- Test fixtures are synthetic and contain no real transcripts, accounts or counter values. Never read actual user DBs, sessions, credentials, or configs in tests.
- No real model calls. No nested subagents from implementation workers. The orchestrator owns dispatch and each fresh read-only reviewer gate.
- Every test/probe that loads spider or pi unsets PI_SUBAGENT_CHILD, PI_SUBAGENT_RUN_ID, PI_SPIDER_DB_PATH and PI_SPIDER_SESSION_ID at invocation. Child tests explicitly stub child identity locally.
- No git mutations under the binding worker rules: no add, commit, stash, checkout, reset, branch, or rebase. Checkpoints remain uncommitted for orchestration.
- Scratch, logs and reports go under the worktree's ignored `.spider/scratch/`; no system temporary directories. Subagent briefs must expand all report paths to absolute paths.
- No em-dashes in docs. No internal proprietary material, real account measurements, transcript evidence, or absolute user paths in tracked files.
- Ingestion never throws into pi. Errors are counted per source and shown in `/doctor`.
- Unknown models are `unpriced` and listed, never priced at 0. Pi dollar cost is secondary, never the AIC source.
- The server and ledger run outside pi's main thread. The footer and alert computations are O(new entries) per update; alerts and the server are not implemented in this phase.
- Poll every 10 minutes, parents only, with one lockfile-lease owner per machine. Every endpoint field is optional; failure or a missing credit counter records nothing.
- All usage configuration keys are global-only: `usage.footer` true, `usage.counter.poll` true, `usage.alerts.sessionCredits` 0, `usage.alerts.runCredits` 0. Alert thresholds are registered but inactive until Phase 4.
- Every task has a targeted RED/GREEN cycle and one worker plus one independent reviewer gate. Run the full suite once after final integration, not in each worker.

## Review Focus

1. A child transcript arrives after its parent aggregate, or becomes unavailable later: totals must never include both or lose the surviving aggregate. Task 4 tests atomic replacement and fallback restoration.
2. A writer stops mid-line, rotates a file, or truncates and regrows it between reads: committed offsets must not skip a call or count a partial JSON line as corruption. Task 4 tests byte boundaries and generation changes.
3. Multiple parent sessions race a stale lease or a reload while a fetch is outstanding: there must be one authorized poller and no stale-owner snapshot writes. Tasks 5 and 7 test fencing and shutdown.
4. A Unicode cwd/name, ANSI status, or absent model/context is rendered at 40 columns: model/thinking retain priority and stats remain whole items without overflow. Task 6 exhaustively tests widths 40 through 200.
5. A summary/tool usage lacks model attribution, a new response-model alias appears, or current rates do not cover the historical date: token parity must remain exact while AIC uncertainty is visible, never guessed away. Tasks 1, 3, and 6 pin these cases.

---

## Evidence decisions and validation status

The private Phase 1 facts report is outside version control. Do not copy its measurements or transcript citations into this plan, fixtures, reports intended for publishing, or CI logs.

- `usage.output` includes reasoning for anthropic-messages, openai-responses, and openai-completions. Real reasoning-bearing records were available for the first two; completions is source-confirmed only. Never add `reasoning` to output or `cacheWrite1h` to cacheWrite.
- Successful pi warmer requests persist as `usage` with `kind: "cache_warm"`, including in pi 0.87.0. Ingest them as `warmer`. Failed/aborted warmer requests can be absent.
- Resolved Copilot API keys are short-lived API tokens and are rejected by the account endpoint. The public root `readStoredCredential(providerId, authPath?)` helper is available in both supported versions. Use it to read `github-copilot.refresh` read-only; never use gh credentials, refresh auth storage, or execute configured key commands.
- Footer totals use ALL entries: assistant messages, every usage entry, tool-result usage, compaction usage, and branch-summary usage. Context percentage uses `ctx.getContextUsage()`, not accumulated tokens. Cache hit rate follows the latest assistant's prompt, not lifetime totals.
- Thinking and session name are public through pi getters; subscription metadata is available through the registry/provider OAuth flag. Auto-compaction enabled state is not exposed through the public extension context/API. Omit `(auto)` when unknown; do not claim the internal default is the live state.
- The read-only spike found a material discrepancy between computed AIC and the account counter. Alias normalization, aggregate suppression, duplicate-response checks, reasoning accounting, and tier selection were investigated; no confirmed explanation closed the discrepancy. Other clients and missing warmers cannot explain an overestimate by themselves. Billing accuracy is an OPEN acceptance concern, not a completed gate.
- The table is an estimate from the public GitHub snapshot dated 2026-10-04. Seed `effectiveFrom = "2026-10-01T00:00:00.000Z"` and `confidence = "estimated"`; this covers the inspected validation month without claiming unverified older rates. Earlier calls are still ingested, with `unpriced: "no-rate-at-time"`. Do not invent historical effective dates or tune rates to fit a counter.
- This plan can deliver an explicitly estimated footer/ledger and expose the signed gap. Before Phases 2 to 4 or a claim of exact/reconciled billing, the orchestrator must resolve or accept that open validation concern. A repeat real-account comparison needs separate authorization and remains scratch-only.

## File ownership and shared contracts

Use `.js` relative imports, matching existing host modules. Tests live beside the new units under `packages/host/src/usage/__tests__/`.

| Unit | Files | Responsibility |
| --- | --- | --- |
| Pricing | `types.ts`, `rates.ts`, `price.ts` | Shared token/model/result types; versioned public rates; deterministic pricing |
| Ledger | `schema.ts`, `migrate.ts`, `ledger.ts` | Four Phase 1 tables and short atomic mutations/queries |
| Parsing | `parse.ts` | Transcript entry normalization and source-local attribution |
| Ingestion | `discovery.ts`, `ingest.ts` | Registry-led discovery; byte resume; dedup and fallback reconciliation |
| Counter | `credential.ts`, `lease.ts`, `counter.ts` | Read-only credential helper; fenced leases; optional endpoint parsing/polling |
| Footer | `footer-state.ts`, `footer.ts` | Incremental pi-parity totals; pure display layout/component |
| Background | `protocol.ts`, `worker-entry.ts`, `runtime.ts` | Typed worker messages, off-thread ledger ownership, lifecycle |
| Integration | `mount.ts`, `config.ts`, `doctor.ts` | Public pi inputs, global config, diagnostic formatting |

Task 1 owns `types.ts`. Task 2 owns ledger row/store types in `ledger.ts`; Task 3 owns parser types in `parse.ts`; Task 4 owns discovery/ingest types; Task 5 owns lease/counter types; Task 6 owns footer types; Task 7 owns worker/runtime types. Later tasks consume these exports without renaming them.

### Verification command convention

Before an npm command in each worker, set `PLAN_SCRATCH="$PWD/.spider/scratch/usage-phase-1"` and create its `tmp`, `npm-cache`, `npm-logs`, and `reports` directories. Define:

```sh
gate() {
  env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_RUN_ID \
    -u PI_SPIDER_DB_PATH -u PI_SPIDER_SESSION_ID \
    TMPDIR="$PLAN_SCRATCH/tmp" npm_config_cache="$PLAN_SCRATCH/npm-cache" \
    npm_config_logs_dir="$PLAN_SCRATCH/npm-logs" npm "$@"
}
```

For each targeted run below, use `gate test -- <files>`. Save RED and GREEN stdout/stderr to the task report directory and record the exit code; an invocation error is not a RED test failure. Run `gate run typecheck` after GREEN. Existing Vitest setup supplies fixture global/agent roots; spawned fixtures must receive those roots explicitly. Any `cd` must use `cd <path> || exit 1`.

## Task 1: Versioned public rates and four-bucket pricing

**Dependencies:** none. **Gate:** one pricing reviewer, including every public row and threshold.

**Files:** Create `packages/host/src/usage/types.ts`, `rates.ts`, `price.ts`, `__tests__/rates.test.ts`, `__tests__/price.test.ts`.

**Interfaces:**
- `UsageTokens = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; reasoning?: number; totalTokens?: number }`.
- `ModelRef = { provider: string | null; id: string | null }`.
- `Actor = "parent" | "subagent" | "aux" | "compaction" | "warmer"`.
- `PriceResult = { status: "priced"; aic: number; components: { input: number; cacheRead: number; cacheWrite: number; output: number }; rateVersion: string; tier: string; confidence: "estimated" | "verified" } | { status: "unpriced"; reason: "unknown-model" | "unsupported-provider" | "missing-attribution" | "no-rate-at-time" | "invalid-usage" }`.
- `RateVersion = { id: string; effectiveFrom: string; source: string; sourceAsOf: string; confidence: "estimated" | "verified"; models: readonly ModelRate[] }`, `ModelRate = { id: string; aliases: readonly string[]; validUntil?: string; tiers: readonly RateTier[] }`, `RateTier = { name: string; abovePromptTokens: number; usdPerMillion: { input: number; cacheRead: number; cacheWrite: number; output: number } }`.
- Export `COPILOT_RATE_VERSIONS`, `canonicalModelId(id: string): string`, `priceCall(model: ModelRef, usage: UsageTokens, at: number, options?: { aggregate?: boolean }): PriceResult`. Aggregate mode uses the default tier as a lower-bound estimate, marks its tier `aggregate-default-lower-bound`, and never infers a long-context call from summed run tokens.

- [x] **Step 1: Write failing tests.** `rates.test.ts` test `covers every public model and tier` asserts exactly 31 canonical IDs and 43 rows, comparing all four rates against a separately written synthetic/public expected table. IDs: gpt-5-mini, gpt-5.3-codex, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5.5, gpt-5.6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-6-astra, gpt-6-luna, gpt-6-sol, gpt-6.1-sol, claude-haiku-4.5, claude-sonnet-4, claude-sonnet-4.6, claude-opus-4.8, claude-opus-5, claude-opus-5.5, claude-sonnet-5, claude-sonnet-5.5, claude-opus-4.8-fast, claude-fable-5, claude-fable-5.1, gemini-3.7-flash, gemini-3.8-flash, mai-code-1.1-flash, grok-4.5, grok-4.6, grok-4.7, kimi-k3. Treat Gemini trailing footnote markers as footnotes, not model IDs. Include the preview fast-mode row and promotional source note through 2026-12-31. No runtime web fetch.
- [x] **Step 2: Pin price assertions.** `price.test.ts` tests `bills output once including reasoning` with gpt-6.1-sol and `{input:1000000, cacheRead:1000000, cacheWrite:1000000, output:1000000, reasoning:600000, cacheWrite1h:500000}`: long tier components are `{input:400, cacheRead:20, cacheWrite:500, output:1500}`, total 2420. `uses strictly greater tier boundary` checks every tier at threshold-1, threshold, threshold+1 using input alone, read alone, write alone, and mixed prompt buckets. `normalizes explicit response aliases` maps claude-opus-5-5 to claude-opus-5.5, without fuzzy matching unknown models. `keeps historical and foreign models unpriced` checks pre-effective date, unknown model, missing model/provider, and non-Copilot provider. `rejects invalid tokens` checks NaN, infinity, negative values and cacheWrite1h > cacheWrite. Zero usage for a KNOWN model is a valid priced zero, unlike an unknown model. `does not silently extend promotional rates` marks dates after the stated promotion unpriced unless a newer table version covers them. `run aggregates do not invent long-context calls` uses aggregate:true with a summed prompt above the threshold and asserts default-tier components, tier `aggregate-default-lower-bound`, and confidence estimated.
Representative pricing oracle:

```ts
const priced = priceCall({ provider: "github-copilot", id: "gpt-6.1-sol" },
  { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6,
    reasoning: 600000, cacheWrite1h: 500000 }, Date.UTC(2026, 9, 2));
expect(priced).toMatchObject({ status: "priced", aic: 2420,
  components: { input: 400, cacheRead: 20, cacheWrite: 500, output: 1500 } });
expect(canonicalModelId("claude-opus-5-5")).toBe("claude-opus-5.5");
```

- [x] **Step 3: Run RED.** `gate test -- packages/host/src/usage/__tests__/rates.test.ts packages/host/src/usage/__tests__/price.test.ts`; expect failed imports/assertions for the missing units, not broken test tooling.
- [x] **Step 4: Implement and run GREEN.** Copy public rates from GitHub Docs, “Models and pricing for GitHub Copilot”, public source URL `https://docs.github.com/en/copilot/reference/ai-models/models-and-pricing`. Non-applicable cache-write cost is 0 with an explicit source note. Choose a version by timestamp, then a tier by `input + cacheRead + cacheWrite > abovePromptTokens`. AIC is the four weighted USD-per-million components divided by 10000. Apply the evidence date/confidence decision above and version aliases explicitly. Rerun both test files and typecheck.
- [x] **Step 5: Checkpoint and review.** Leave only these files uncommitted; report RED/GREEN counts and unresolved historical rate coverage. Reviewer checks all 43 rows against the public source, not just representative models.

## Task 2: Separate ledger schema, migrations, and atomic store

**Dependencies:** Task 1. **Gate:** one SQLite/transaction reviewer.

**Files:** Create `packages/host/src/usage/schema.ts`, `migrate.ts`, `ledger.ts`, `__tests__/ledger.test.ts`.

**Interfaces:**
- `CallRow` contains `id`, `ts`, `sourceFile`, `entryId`, `sourceGeneration`, `project`, `repo`, `sessionId`, `runId`, `actor`, `role`, `agent`, `runName`, `phase`, `parentRunId`, `auxPurpose`, `provider`, `model`, `requestedModel`, `thinking`, `api`, `usage: UsageTokens`, `price: PriceResult`, `piCost: number | null`, `latencyMs: number | null`, `aggregate: boolean`, `counted: boolean`, `originKey: string | null`, required `sourceKind: 'transcript' | 'run-db-aux' | 'report'`, optional `responseId`, and optional `copied`; nullable attribution stays null, not fabricated strings. Missing/unknown sourceKind and mismatched report labels are rejected at runtime.
- `RunMeta` contains `id`, `dbPath`, `project`, `repo`, `sessionId`, `parentRunId`, `agent`, `role`, `name`, `model`, `thinking`, `phase`, `startedAt`, `endedAt`, with absent legacy fields null.
- `ImportState = { path: string; inode: string; size: number; mtimeMs: number; offset: number; parseErrors: number; generation: number; prefixHash: string }`.
- `CounterSnapshot = { ts: number; accountLogin?: string; creditsUsed: number; entitlement?: number; remaining?: number; resetDate?: string; raw: Record<string, unknown> }`.
- `LedgerHealth = { schemaVersion: number; calls: number; sources: number; parseErrors: number; sourceErrors: number; unpricedModels: readonly string[]; aggregateCalls: number; lastIngestAt: number | null; possibleOverlaps?: number }`.
- `openUsageLedger(file: string): UsageLedger`; `UsageLedger` exposes `apply(batch: ImportBatch): void`, `getImportState(path: string): ImportState | undefined`, `getRuns(): readonly RunMeta[]`, `insertCounter(snapshot: CounterSnapshot): void`, `latestCounter(): CounterSnapshot | undefined`, `summarize(start: number, end: number): { aic: number; pricedCalls: number; unpricedCalls: number; estimated: boolean; possibleUndercount: boolean; possibleOverlap?: boolean }`, `health(): LedgerHealth`, `close(): void`. summarize selects globally before the half-open timestamp interval [start,end). `possibleUndercount` means a mid-file cursor or selected detail of a nonterminal run in that period; `possibleOverlap` means unresolved double-counting evidence. `estimated` is either completeness flag, not price confidence. Price-based estimated AIC labelling belongs to the UI.
- `ImportBatch = { calls: readonly CallRow[]; runs: readonly RunMeta[]; states: readonly ImportState[]; detailedRunIds: readonly string[]; restoreAggregateRunIds: readonly string[]; resetSources: readonly { path: string; generation: number }[]; sourceErrors: readonly { path: string; code: string }[]; at: number; coverageEdges?: readonly { reportRunId: string; includedRunId: string; evidence: 'transcript' | 'runs-db' | 'unknown' }[]; removeCoverageEdges?: readonly { reportRunId: string; includedRunId: string }[] }`. Store exported batch type here, not in ingest, to avoid dependency inversion. Coverage removals precede upserts atomically; detailedRunIds/restoreAggregateRunIds are ignored legacy compatibility signals.

- [x] **Step 1: Write failing `ledger.test.ts`.** `creates isolated usage tables` asserts calls/counter_snapshots/import_state/runs_meta/coverage_edges/ledger_totals/ledger_metadata/call_ancestry_edges exist, context tables do not, and a fixture spider.db's schema is unchanged. `migrates once and rejects future schema without modification` checks user_version=1, reopening is a no-op, and future version rejection leaves bytes/data unchanged. `round trips all nullable attribution and token fields` preserves reasoning/cacheWrite1h, secondary dollars, price status/components, aggregate flag, actor, latency and source identity. `applies offset and calls atomically` injects a failed row and asserts neither rows nor offset advance. `deduplicates source entry and fences stale state` applies the same batch twice and rejects offset rollback from an older generation/offset. `replaces aggregates atomically by run` never exposes a query sum with aggregate plus detail. `preserves uncertainty` stores unpriced as null AIC, not zero. `summarizes a bounded period without hidden aggregates` asserts the half-open interval, counted-only totals, unpriced count, and estimate flag.
Representative atomic/idempotence oracle, with a synthetic ImportBatch and fixture ledger:

```ts
ledger.apply(batch);
const first = ledger.health();
ledger.apply(batch);
expect(ledger.health()).toEqual(first);
expect(ledger.getImportState(batch.states[0].path)?.offset).toBe(batch.states[0].offset);
expect(ledger.summarize(0, 1).unpricedCalls).toBe(0); // no fixture call in this interval
```

- [x] **Step 2: Run RED.** `gate test -- packages/host/src/usage/__tests__/ledger.test.ts`; expect missing schema/store failures.
- [x] **Step 3: Implement store and migration.** Use db-core `openDb`/`openDbReadOnly`, not registry openers or spider's migrate function. Default file resolution is a caller responsibility; this unit requires an explicit file. Enable WAL via existing opener and use a short worker-side busy timeout. If a file exists, first open it read-only to reject a future user_version before the writable opener can change journal mode. Then open writable and recheck/migrate inside a transaction. Transactionally create schema/user_version; never apply spider DB migrations. SQL calls columns flatten token/price components, with nullable AIC plus price_status/unpriced_reason/confidence. Unique `(source_file, entry_id)`; include generation to handle replacements via transactional deletion/reset, not duplicate call identity. Index `(ts,actor)`, `(session_id,ts)`, `(run_id,aggregate,counted)`, `(provider,model,ts)`. Counter snapshots index ts. runs_meta primary key `(db_path,id)`; import_state primary key path with the resume fields, source error code, and last ingest timestamp. Use JSON for optional raw fields only, not transcript bodies. Set private file/directory permissions where supported. Context tables wait for Phase 2.
- [x] **Step 4: Run GREEN and typecheck.** Rerun `ledger.test.ts`; assert db handles close in teardown and fixture files remain inside the test roots.
- [x] **Step 5: Checkpoint and review.** Report schema and transaction tests. No git mutation. Reviewer checks retry/future-version behavior and that db-core's existing schema is never applied to usage.db.

## Task 3: Transcript normalization and honest attribution

**Dependencies:** Task 1. **Parallel:** with Tasks 2 and 6. **Gate:** one parser/accounting reviewer.

**Files:** Create `packages/host/src/usage/parse.ts`, `__tests__/parse.test.ts`.

**Interfaces:**
- `RunAttribution = { id: string; sessionId: string; parentRunId: string | null; agent: string; role: string | null; name: string | null; model: string | null; thinking: string | null; phase: string | null; startedAt: number | null }`, defined in parse.ts without a Task 2 import.
- `SourceInfo = { path: string; project: string | null; repo: string | null; run: RunAttribution | null }`.
- `ParsedCall = { id: string; ts: number; sourceFile: string; entryId: string; project: string | null; repo: string | null; sessionId: string | null; runId: string | null; actor: Actor; role: string | null; agent: string | null; runName: string | null; phase: string | null; parentRunId: string | null; auxPurpose: string | null; provider: string | null; model: string | null; requestedModel: string | null; thinking: string | null; api: string | null; usage: UsageTokens; price: PriceResult; piCost: number | null; latencyMs: number | null; aggregate: boolean }`, defined in parse.ts using only Task 1 types. Task 4 adds sourceGeneration, counted and originKey to satisfy CallRow structurally.
- `ParsedSource = { sessionId: string | null; parentSession: string | null; calls: readonly ParsedCall[]; errors: readonly { byteOffset: number; code: string }[] }`.
- `parseTranscript(lines: readonly { byteOffset: number; json: unknown }[], source: SourceInfo): ParsedSource`. It reads the full entry metadata/tree state provided by ingest, but never writes files or opens DBs.

- [x] **Step 1: Write failing `parse.test.ts`.** `classifies assistant aux compaction branch summary and warmer` asserts actors parent/subagent/aux/compaction/warmer for the corresponding entries. `preserves both requested and response models` uses requested claude-opus-5.5 and response claude-opus-5-5; price normalizes the latter. `handles anonymous tool and summary usage` counts tokens, sets provider/model null, and returns missing-attribution pricing; never uses surrounding model_change as proof of a summary's billing model. Mark combined summary usage aggregate=true. `keeps unknown usage kinds` stores them under the owning parent/subagent actor with the kind as purpose. `extracts subagent aggregate run id` parses the terminal parenthesized run ID in the note without guessing from the display name. `walks ancestor model and thinking changes` follows parentId for display attribution through a branch, not the latest linear model selection. `retains errored calls with nonzero usage` does not discard recorded billed tokens on error/abort. `uses deterministic identity for legacy entries` uses byte-offset fallback IDs when id is absent and validates token numbers without persisting content. `isolates bad entry shape` returns a sanitized error and still yields later valid calls.
Representative attribution oracle, with synthetic header/compaction entries in lines:

```ts
const parsed = parseTranscript(lines, source);
expect(parsed.calls[0]).toMatchObject({ actor: "compaction", provider: null,
  model: null, aggregate: true, price: { status: "unpriced", reason: "missing-attribution" } });
expect(parsed.calls[0].usage.reasoning).toBe(300);
expect(parsed.calls[0].usage.output).toBe(500); // not 800
```

- [x] **Step 2: Run RED.** `gate test -- packages/host/src/usage/__tests__/parse.test.ts`.
- [x] **Step 3: Implement normalization.** Parse header, model/thinking changes, all assistant messages, usage entries, compaction/branch-summary entries and usage-bearing tool results. Prefer responseModel for pricing and retain requestedModel separately. Use entry timestamp, falling back to numeric message timestamp; unusable dates are isolated errors. Map spider-aux notes to auxPurpose, cache_warm to warmer, and subagent reports to aggregate subagent calls. Tool usage without model attribution stays unpriced; use actor aux and purpose `tool:<toolName>` unless an explicit summary source identifies compaction. Usage from multiple summary requests remains a summary aggregate. Never retain content, commands, summaries, or error messages in Phase 1 call rows.
- [x] **Step 4: Run GREEN and typecheck.** Rerun `parse.test.ts`; every synthetic branch includes an assertion of recorded vs inferred fields.
- [x] **Step 5: Checkpoint and review.** Leave parser files uncommitted. Reviewer verifies unknown kinds, missing attribution and both output/reasoning mapping regressions, including source-confirmed openai-completions.

## Task 4: Discovery, byte-resume ingestion, and replacement-safe dedup

**Dependencies:** Tasks 2 and 3. **Gate:** one filesystem/import correctness reviewer.

**Files:** Create `packages/host/src/usage/discovery.ts`, `ingest.ts`, `__tests__/discovery.test.ts`, `__tests__/ingest.test.ts`.

**Interfaces:**
- `UsageRoots = { registryDb: string; sessionsDir: string; ledgerFile: string; authPath: string; leaseDir: string }`.
- `Discovery = { sources: readonly SourceInfo[]; runs: readonly RunMeta[]; errors: readonly { path: string; code: string }[] }`.
- `discoverUsageSources(roots: UsageRoots): Promise<Discovery>`; source roots and DB open functions are injectable for tests.
- `ingestOnce(ledger: UsageLedger, discovery: Discovery, at: number, signal: AbortSignal): Promise<LedgerHealth>`; consumes parseTranscript, priceCall and the ledger batch contract.
- Current runs schemas have no recorded cwd or scratch root. Use only canonical registered scratch roots, including symlink targets.
- Look up `<registered scratch>/subagent-sessions/<id>/<id>.jsonl` across all scratch roots in the global registry, including other repos. Prefer same-repo roots first. This is a registry lookup with one non-recursive listing per root, never a repository walk.
- Missing-source diagnostics list the paths actually checked; do not label an unknown launch root as an expected location.

- Import immutable raw facts; the ledger selects representations at read time. `counted`, `detailedRunIds` and `restoreAggregateRunIds` are compatibility-only and must not drive ingestion. Retain imported detail if its file later disappears; no restore replay is required.
- Set required `CallRow.sourceKind` to `transcript` for own transcript detail, `run-db-aux` for child auxiliary calls (spider-aux kind only), or `report` for subagent run reports. Import runs-DB `spider_usage` as child aux only when it represents the child's direct auxiliary sink: its payload has an auxiliary `purpose`, excluding `compaction`, `branch_summary`, and all nested-report kinds such as `spider-subagent`. The DB payload carries the auxiliary purpose, not a separate kind field. Transcript-copied call events must never be imported from the runs DB: assistant usage with no purpose, compaction/branch-summary usage, and nested reports mirror transcript entries. Do not treat every event with a purpose as aux. Preserve the owning run on DB-only aux. Only native own-transcript detail replaces a run's report. DB-only aux never replaces it and counts additively only when no selected report covers its run, because the report already includes aux.
- Supply `message.provider` and `responseModel ?? model`. The ledger canonicalizes explicit rates-table model aliases at write time and stores raw provider/model ids too. On open, an alias-table fingerprint change atomically rebuilds stored canonical ids and dedup fingerprints from raw ids without repricing. Use exact billing provider ids; the current price lookup defines no provider aliases. Preserve requestedModel separately and leave anonymous summary provider/model null.
- Reports are produced once per (run, provider, model). Import all per-model report groups for a run atomically. Coverage and replacement are RUN-wide, including every model and model-less compaction row; counted reports supply their own per-model breakdowns, not the covered detail's strings.
- Preserve `responseId`, original entryId, timestamp and tokens. Set `copied=true` for inherited fork entries, even if the parent file is gone. Entries timestamped before the fork header are inherited. Preserve original run attribution when known. Copies neither displace a report nor establish ancestry/source hints.
- Supply `coverageEdges: { reportRunId, includedRunId, evidence }[]` with evidence `transcript`, `runs-db`, or `unknown`. A transcript edge requires a native, newly appended subagent report for N in R's transcript. An inherited report, a direct child call, or execution ancestry alone is not inclusion proof.
- A runs-db edge requires N to belong to R's reporting context, reach terminal state, and have usage reported before R's report time. A spawned parent id, orphaned/still-running child, equal/ambiguous timestamps or incompatible legacy path is not proof. Use `unknown` when inclusion cannot be established; both contributions count and may flag possible overlap.
- Keep the best supported proof per pair. Revalidate or withdraw stale/disproved proof using `removeCoverageEdges` in the same batch as associated generation/cursor changes. Do not downgrade while another proof remains. Losing a file alone does not erase historically confirmed inclusion; removals precede upserts in a batch.
- Commit truthful source `size` and `offset`, plus run `endedAt`. While offset < size, or a run has endedAt=null and a report exists, every summary is conservatively estimated even for empty periods because unread timestamps are unknown. A retained report also makes selected own-transcript detail estimated, including truncated runs; the ledger never fills partial detail with invented usage.
- Dashboard period/session SQL must use `countedUsageSql` with bound timestamp/session predicates and the period/session read index. Include `possible_overlap` and `possible_undercount` in uncertainty. The unbounded `counted_calls` and overlap views are diagnostic interfaces, not period-query shortcuts.

- [x] **Step 1: Write failing discovery tests.** `lists only session directories and registry-derived runs` creates fixture parent dirs and global projects, plus repo/worktree runs and derived scratch transcripts; assert all discovered paths and source attribution. `does not scan repositories or migrate source DBs` spies on directory operations and DB open mode, comparing source DB schema before/after. `deduplicates shared repo registrations and canonical source paths` counts each physical source once. `handles legacy columns and missing registered roots` records diagnostics and continues. `does not discover child files by arbitrary recursion` places an unrelated JSONL under another repo directory and asserts it is never opened.
- [x] **Step 2: Write failing ingest tests.** `resumes only through complete UTF8 newline boundaries` appends half a JSON object containing a multibyte character; offset remains at the last newline, no parse error until completion, then exactly one new call. `isolates malformed complete lines` imports valid/bad/valid with one parse error, unchanged on reimport. `detects rotation truncation and same-inode regrowth` resets source generation and removes old source contributions transactionally. `suppresses copied fork ancestors but counts both branches` covers copied entry IDs, different branches, missing parent sources, and cyclic parentSession references; no arbitrary filesystem reads from parentSession. `selects reports or retained own-transcript detail` first imports a report with DB-only aux (report counts once), then complete transcript detail (detail plus aux), then removes the file without deleting imported facts (detail persists); a fresh ledger with no transcript retains the report. `covers nested runs only with explicit evidence` tests proven, unknown, late and withdrawn edges, alias models and model-less summaries. `flags partial imports` tests mid-file cursors, nonterminal runs and truncated detail beside a retained report. `does not double count nested run reports` recursively handles reports inside child sessions. `failed child import retains fallback` injects read/transaction failure; no premature aggregate removal. `reimport is idempotent and concurrent scans cannot regress offsets` compares complete rows/totals after repeated and raced passes. `cancelled batch advances no uncommitted offset` checks cancellation boundaries.
Representative resume oracle, with synthetic valid/bad/valid discovery and a fixture ledger:

```ts
await ingestOnce(ledger, discovery, at, new AbortController().signal);
expect(ledger.health()).toMatchObject({ calls: 2, parseErrors: 1 });
const before = ledger.summarize(0, at + 1);
await ingestOnce(ledger, discovery, at, new AbortController().signal);
expect(ledger.summarize(0, at + 1)).toEqual(before);
expect(ledger.health().parseErrors).toBe(1);
```

- [x] **Step 3: Run RED.** `gate test -- packages/host/src/usage/__tests__/discovery.test.ts packages/host/src/usage/__tests__/ingest.test.ts`.
- [x] **Step 4: Implement discovery/ingest and run GREEN.** Enumerate only the sessions root and its session directories. Open the global registry and each distinct registered worktree DB/repo DB read-only using db-core; do not resolve/register/migrate projects as a side effect. Query only run metadata columns. The runs schema has no launch-root column; look up `<registered scratch>/subagent-sessions/<id>/<id>.jsonl` across every scratch root in the global registry, including other repos, with one non-recursive listing per root. Prefer same-repo roots before the global fallback. Canonicalize paths; missing-source diagnostics list the actual candidate paths checked, not an assumed launch location. Stream bounded byte chunks, process complete newline-delimited records, and commit rows plus offsets atomically. Store inode/size/mtime and a fixed prefix hash; generation resets invalidate old source rows. Persist the session header and an append-only compact entry id/parentId/role attribution index with each cursor. Insert only new entry rows and use compressed state ancestry for incremental parsing, never rewrite a whole historical JSON array. Skip unchanged sources without reading; stream appended bytes from the committed offset without repricing old calls. Commit the initial size snapshot even if the source grows during the pass. Reports are written back-to-back only at run end, so the pending hold covers partly written groups, not future usage of a running child. Never fence the transcript cursor. Import complete groups atomically, or release terminal/aged incomplete groups with possibleUndercount. Clear that flag when imported plus appended parts complete the group. Recompute partial-tail state each pass and clamp firstSeen on backward clock steps. Preserve the ledger's stable response/entry fingerprint inputs and explicit copied provenance; count one surviving copy with deterministic native-first selection. Never drop a real new branch call because text/tokens happen to match. Atomically import raw calls, DB-only aux, complete report groups, evidence changes and cursors; do not toggle counted flags or infer inclusion from ancestry. Retained reports and partial detail remain explicitly estimated. Price run-level aggregates with `priceCall(ref, tokens, ts, { aggregate: true })`, storing the default-tier lower-bound estimate and its explicit uncertainty marker, never a fabricated per-call long-context tier. Parse errors and source errors remain separate. Rerun both tests and typecheck.
- [x] **Step 5: Checkpoint and review.** Report byte/generation/fork/fallback tests and leave uncommitted. Reviewer verifies no recursive repo scan and no source DB writes. All actual backfill execution waits for Task 7's worker.

## Task 5: Read-only Copilot credential, fenced lease, optional counter

**Dependencies:** Task 2. **Parallel:** with Tasks 3/4/6 once Task 2's contract is available. **Gate:** one credential/concurrency reviewer.

**Files:** Create `packages/host/src/usage/credential.ts`, `lease.ts`, `counter.ts`, `__tests__/credential.test.ts`, `__tests__/lease.test.ts`, `__tests__/counter.test.ts`.

**Interfaces:**
- `readCopilotOAuthToken(authPath: string): string | undefined`, using the public root readStoredCredential helper; no fallback to a different account.
- `LeaseClock = number | (() => number)`; runtime callers pass a clock callback and deterministic fixtures may pass a timestamp. `Lease = { owner: string; expiresAt: number; isCurrent(at?: LeaseClock): boolean; renew(at: LeaseClock): boolean; release(): boolean; nextPollAt(): number | null; claimPoll(at: LeaseClock, intervalMs: number): boolean; recordError(at: LeaseClock, code: string): boolean; saveIfCurrent(at: LeaseClock, snapshot: CounterSnapshot): boolean }`; `acquireUsageLease(ledger: UsageLedger, name: string, owner: string, at: LeaseClock, ttlMs: number): Lease | undefined`. Counter and ingest use distinct names (`counter`, `ingest`) in the usage ledger DB. Every lease write is one short synchronous BEGIN IMMEDIATE transaction; read-only paths use plain SELECTs; snapshot save checks the token and inserts the snapshot in the same transaction. Storage failures throw fixed lease-busy or lease-storage codes; release returns false only for a fenced successor. Every write decision samples its clock inside BEGIN IMMEDIATE. A lease is live while now < expires_at; expiry strictly beyond now plus TTL plus 30000 ms is invalid and permits clock-jump takeover.
- `inspectUsageLease(ledger: UsageLedger, name: string, at?: number, owner?: string): UsageLeaseInspection`, with `owner`, `expiresAt`, `role: "free" | "owner" | "follower" | "expired"`, `nextDueAt`, `lastErrorCode`, and `notice: { code: string; at: number } | null`, without the token, for /doctor. Repair notices never change polling errors or availability. They persist across ownership changes until recovery: lease-row-corrupt clears on valid acquisition, schedule-corrupt/clock-jump clear when the corrected poll is claimed, and clock-skew is persisted from the shared snapshot and cleared when its age is nonnegative. Acquisition clears only lease-busy/lease-lost errors; real poll errors remain until the next poll result. Corrupt rows are reset conservatively for one TTL with lease-row-corrupt; corrupt schedules reset for one interval with schedule-corrupt. Future cadence is clamped to now plus two intervals with clock-jump.
- `CounterState = { availability: "disabled" | "unavailable" | "available" | "stale"; role: "inactive" | "owner" | "follower"; lastAttemptAt: number | null; lastSuccessAt: number | null; nextPollAt: number | null; snapshotAgeMs: number | null; errorCode: string | null; notice: { code: string; at: number } | null; latest: CounterSnapshot | null }`. Healthy followers are available, not failures, and serve latestCounter() from the ledger with its age; a follower waiting for its first snapshot has latest and age null. Both roles read the shared snapshot and schedule and report stale strictly after the later of next_due_at plus two minutes and snapshot time plus two intervals plus two minutes, so a clamped cadence never makes a snapshot stale early. Future-dated snapshots have negative age, a clock-skew notice and stale availability; latestCounter selects insertion order. Unavailable and error codes indicate real failures.
- `parseCounterResponse(body: unknown, at: number): CounterSnapshot | undefined`.
- `CounterPoller` constructor takes explicit `authPath`, `ledger: UsageLedger`, `isChild`, `enabled`, `now`, and `fetch`; exposes `start(): void`, `setEnabled(enabled: boolean): void`, `state(): CounterState`, `stop(): Promise<void>`. These injected options keep credential and storage tests isolated.

- [x] **Step 1: Write failing tests.** `credential.test.ts`: `reads only the configured OAuth refresh credential` uses a synthetic auth file and asserts no access token, API-key credential, gh token, writes, or key-command execution. `lease.test.ts`: `one owner wins across processes`, `atomic snapshot save fences expired tokens, including identical owner names (C1)`, `expired owners cannot renew before takeover`, and `release is idempotent, transactional and token-fenced (M4)` use owned fixture child processes, all SIGKILLed in finally teardown if still alive. `counter.test.ts`: `polls at startup and ten minute intervals` fake clock asserts no second request before 600000 ms; `child and disabled modes never touch credentials or network`; `optional fields are optional (omitted) but missing credits records nothing`; `zero credits is valid`; `unknown nested fields are preserved without auth headers`; `401 timeout malformed JSON and missing auth record nothing`; `outstanding fetch cannot save after lease loss or shutdown`; `stale cached snapshot is explicitly unavailable after failed refresh`. Assert no token/header/body error strings reach diagnostics.
Representative optional-counter oracle:

```ts
expect(parseCounterResponse({}, 1000)).toBeUndefined();
expect(parseCounterResponse({ quota_snapshots: { premium_interactions: {
  credits_used: 0 } } }, 1000)).toMatchObject({ ts: 1000, creditsUsed: 0 });
expect(parseCounterResponse({ quota_snapshots: { premium_interactions: {
  credits_used: "0" } } }, 1000)).toBeUndefined();
```

- [x] **Step 2: Run RED.** `gate test -- packages/host/src/usage/__tests__/credential.test.ts packages/host/src/usage/__tests__/lease.test.ts packages/host/src/usage/__tests__/counter.test.ts`.
- [x] **Step 3: Implement credential, lease and poller.** Credential helper imports readStoredCredential from the root and requires type oauth plus a nonempty refresh field. GET `https://api.github.com/copilot_internal/user` with Bearer OAuth refresh, JSON accept and compatible Copilot client headers; fixed endpoint, no redirects and a 15000 ms abort deadline. Read premium_interactions.credits_used as a finite nonnegative number; keep login/entitlement/remaining/reset optional, preserve the response JSON without headers/credentials. Missing essential counter, wrong type, disabled token-based billing, or request failure yields no snapshot. Use a leases table in usage.db via openUsageLedger. Its bounded BUSY retry applies only to open; lease writes temporarily use a 25 ms SQLite busy timeout, and a renewal tick retries BUSY with asynchronous 75-149 ms jittered backoff for a total budget of three seconds. Exhausting that budget schedules a 500-999 ms follow-up, not a 40-second wait. A BUSY storm is a transient notice and does not make a valid owner with a snapshot unavailable. Use 120000 ms TTL and 40000 ms renewal. Acquire, renew, release and snapshot saves are short BEGIN IMMEDIATE transactions, never held across await; inspection, fence reads and next-due reads are plain SELECTs. A lapsed owner without a successor silently reacquires with its snapshot available; successful owner renewal or polling clears transient lease codes. Retry a BUSY save from memory on the next renewal tick without refetching or bypassing the ten-minute fetch minimum. No filesystem guards. Counter and ingest leases use distinct names. Snapshot storage is synchronous and bounded by the ledger busy timeout; stop always resolves within a few seconds even if fetch ignores abort or a mistaken save adapter never settles. Depth, node and byte limits reject oversized raw payloads with payload-limit and no snapshot; cancel HTTP error response bodies without reading them. Lease state retains the next-due timestamp across parent handovers so new parents cannot defeat the ten-minute limit. Abort timers/fetch on disable/shutdown and surface sanitized codes only.
- [x] **Step 4: Run GREEN and typecheck.** Rerun the three files. Verify fixtures have no surviving processes and file/network spies prove no production credential access.
- [x] **Step 5: Checkpoint and review.** Leave these files uncommitted. Reviewer checks stale takeover races, token handling, disabled/child paths, and all optional field cases. No real counter fetch in tests or CI.

## Task 6: Incremental pi-parity footer and whole-item narrow layout

**Dependencies:** Task 1. **Parallel:** with Tasks 2/3/4/5. **Gate:** one TUI/accounting reviewer.

**Files:** Create `packages/host/src/usage/footer-state.ts`, `footer.ts`, `__tests__/footer-state.test.ts`, `__tests__/footer-layout.test.ts`.

**Interfaces:**
- `FooterTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; piCost: number; aic: number; unpricedEntries: number; aggregateEntries: number; estimated: boolean; latestCacheHitRate: number | null }`.
- `FooterAccumulator` exposes `reset(entries: readonly unknown[]): void`, `append(entries: readonly unknown[]): void`, `snapshot(): FooterTotals`. It uses the same usage-kind extraction/pricing rules; Task 3 parsing is not a dependency because this reducer must support live public entries without disk access.
- `FooterInput = { cwd: string; branch: string | null; sessionName: string | null; modelId: string | null; thinking: string; context: { percent: number | null; contextWindow: number } | null; autoCompaction?: boolean; subscription: boolean; totals: FooterTotals; counter: CounterStateView; statuses: ReadonlyMap<string,string> }`; `CounterStateView = { availability: "disabled" | "unavailable" | "available"; snapshot: CounterSnapshotView | null }`; `CounterSnapshotView = { creditsUsed: number; entitlement?: number; ts: number }`. These are structural view types, not counter/ledger imports.
- `renderUsageFooter(input: FooterInput, width: number): string[]`; `createUsageFooter(getInput: () => FooterInput, theme: Theme, footerData: ReadonlyFooterDataProvider, requestRender: () => void): Component & { dispose(): void }`, using public root pi types.

- [x] **Step 1: Write failing parity tests.** `footer-state.test.ts` test `matches pi footer arithmetic across all entry kinds` uses a synthetic branched/compacted session with assistants on both branches, subagent/aux/cache_warm/unknown usage entries, a tool result, compaction and branch-summary usage. Expected input/output/read/write/piCost are independently summed exactly like installed `footer.js:77-94` and `usage-totals.js:10-15`; do not deep-import production pi helpers. `reasoning and 1h writes are subsets` adds nonzero optional counters without changing totals. `latest assistant cache ratio matches pi` ignores subsequent aux/warmer usage. `updates only new entries` instruments pricing: appending one entry invokes one new price calculation; render/invalidate never reprice history. `does not guess missing attribution` retains tool/summary tokens, increments unpricedEntries and labels AIC partial. `aggregate and current-table amounts stay estimated` prevents an exact-looking amount.
- [x] **Step 2: Write failing layout tests.** `footer-layout.test.ts` test `fits every width 40 to 200` loops all 161 widths and asserts visibleWidth(line)<=width using ANSI, wide Unicode, long cwd/branch/session, absent model, and unknown context. `row one preserves model thinking and name priority` asserts left-truncation of cwd precedes branch removal, which precedes session-name truncation. For a pathological model ID longer than the entire row, shorten the model with a visible ellipsis while retaining thinking, rather than overflow. `row two drops entire lowest priority items` asserts exactly this order: context, AIC, CH, month percentage, input/output pair, read/write pair; never cuts a numeric token or an ANSI sequence. `unknown auto state is not claimed` omits (auto), known true includes it and false omits it. `missing counter is not month zero` omits month on unavailable/disabled or missing/zero entitlement. `status row is retained` renders footerData statuses in order using ANSI-aware width truncation. Assert partial/estimated AIC indicators and no dollar-only replacement of AIC.
Representative width oracle, using a synthetic long Unicode/ANSI FooterInput:

```ts
for (let width = 40; width <= 200; width++) {
  const lines = renderUsageFooter(input, width);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  expect(lines[0]).toContain("high");
  expect(lines[1]).not.toContain("$");
}
```

- [x] **Step 3: Run RED.** `gate test -- packages/host/src/usage/__tests__/footer-state.test.ts packages/host/src/usage/__tests__/footer-layout.test.ts`.
- [x] **Step 4: Implement and run GREEN.** Row 1 is cwd/branch/session plus right-priority `<model> · <thinking>`; support all pi thinking levels including off. Row 2 builds six atomic items/pairs and removes the lowest priority until it fits; if context alone does not fit, omit the whole item, never slice it. Cache-hit display follows pi's latest assistant arithmetic. Use aggregate pricing mode for subagent run reports. Session AIC uses current session entries, including subagent and aux reports, not global ledger totals; preserve pi token parity even when ledger dedup suppresses global aggregates. Prefix estimate with `~`, and include `+ ?` in the AIC item when unpriced entries exist. Subscription changes optional secondary dollar labeling only, not AIC pricing. Row 3 preserves extension statuses. Use public visibleWidth/truncateToWidth utilities, theme colors at render time, and branch-change subscription disposal. Rerun both tests and typecheck.
- [x] **Step 5: Checkpoint and review.** Leave footer units uncommitted. Reviewer checks Unicode width and that render is disk/network/DB-free. No visual dashboard work in this phase.

## Task 7: Off-thread backfill, live ingestion, and packaged worker lifecycle

**Dependencies:** Tasks 2, 4 and 5. **Gate:** one runtime/packaging reviewer.

**Files:** Create `packages/host/src/usage/protocol.ts`, `worker-entry.ts`, `runtime.ts`, `__tests__/runtime.test.ts`, `__tests__/worker-bundle.test.ts`; modify `packages/host/src/extension.ts:1-75` for the guarded worker entry seam only. No vite/package/release layout changes.

**Interfaces:**
- `UsageWorkerCommand = { type: "start"; roots: UsageRoots; owner: string; child: boolean; poll: boolean } | { type: "refresh" } | { type: "configure"; poll: boolean } | { type: "stop" }`.
- `BackfillState = "pending" | "running" | "complete" | "failed"`.
- `ReconciliationView = { windowStart: number; windowEnd: number; computedAIC: number; counterAIC: number | null; gap: number | null; ratio: number | null; unpricedCalls: number; estimated: boolean }`.
- `UsageWorkerEvent = { type: "snapshot"; health: LedgerHealth; counter: CounterState; backfill: BackfillState; reconciliation: ReconciliationView } | { type: "error"; code: string } | { type: "stopped" }`.
- `bootUsageWorker(port: MessagePort, command: Extract<UsageWorkerCommand,{type:"start"}>): Promise<void>`.
- `UsageRuntime` constructor receives bundleUrl, roots, child flag, Worker factory, snapshot callback and clock. Exposes `start(poll: boolean): void`, `refresh(): void`, `configure(poll: boolean): void`, `snapshot(): { health: LedgerHealth | null; counter: CounterState | null; backfill: BackfillState; reconciliation: ReconciliationView | null; errorCode: string | null }`, `stop(): Promise<void>`.

- [x] **Step 1: Write failing lifecycle tests.** `runtime.test.ts`: `factory import and registration start nothing`; `parent startup returns before history work`; `child starts no worker ledger or poller`; `refresh coalesces without concurrent import`; `multiple parents have one ingest lease owner`; `lease loser can still read diagnostic and counter snapshots`; `worker failure leaves footer usable and reports doctor error`; `shutdown aborts fetch stops timers closes DB and terminates once`; `reload does not retain obsolete snapshot handlers`. Use fake worker and large synthetic history; assert no main-thread DB calls or transcript reads.
- [x] **Step 2: Write failing built-bundle smoke test.** `worker-bundle.test.ts` spawns a Node fixture with the built `dist/extension.js`, fixture roots/auth and network stub. Assert native bundle import exports a function and does not start resources. Start a real Worker on that bundle URL with `{spiderUsageWorker:1, command}`; assert the worker processes synthetic JSONL into fixture usage.db, emits protocol snapshots, honors disabled poll, and exits after stop. The fixture checks `dist` contains exactly `extension.js`, with no source `.ts`/worktree workspace dependency at runtime. Run this test only against a fresh build; the targeted script must fail explicitly if the bundle is missing/stale, not silently skip.
Representative lifecycle oracle, using the injected fake Worker factory:

```ts
childRuntime.start(true);
await childRuntime.stop();
expect(workerFactory).not.toHaveBeenCalled();
parentRuntime.start(false);
expect(workerFactory).toHaveBeenCalledTimes(1);
expect(parentRuntime.snapshot().backfill).toBe("pending");
// Each test finally block stops the parent and advances any fake shutdown deadline.
```

- [x] **Step 3: Run RED.** Run runtime tests first. Build the current bundle, then run worker-bundle test; expect unsupported worker-entry/protocol assertions to fail. Record both outputs; do not treat a stale artifact as meaningful RED.
- [x] **Step 4: Implement and run GREEN.** Choose a worker thread rather than a detached process: it isolates synchronous SQLite/transcript work, shares the existing packaged module path, and has bounded session cleanup without adding a long-lived daemon before Phase 3. Construct Worker from the actual loaded extension bundle URL, not a source file path. At extension module scope, dispatch ONLY when `!isMainThread && workerData?.spiderUsageWorker === 1`; this calls bootUsageWorker without invoking the extension factory, organism, tools, or model runtime. Native imports in the main thread stay inert. The worker opens usage.db, acquires a distinct ingest lease, backfills ALL discovered history on first run, resumes on restart, and repeats discovery/ingestion every 60000 ms while alive. Refresh events coalesce; counter writes also remain off-thread. Acquire/migrate/commit bounded batches, publish only aggregate health/counter/backfill/reconciliation state, and use sanitized error codes. Build reconciliation off-thread with ledger.summarize from the UTC first of the counter snapshot's month through that snapshot timestamp, not through a later live import timestamp. Set gap=counterAIC-computedAIC and ratio=computedAIC/counterAIC; ratio is null for a zero counter. Missing/unavailable counter yields null comparison fields and never a successful reconciliation assertion. Lease losers run read-only snapshot refreshes. On stop, abort, release owned leases, close handles, acknowledge stopped; force terminate after 2000 ms if acknowledgement fails. Unref idle worker/timers as appropriate and track the underlying owner PID for stale leases. Run runtime tests, fresh `gate run build`, built-bundle test, and typecheck.
- [x] **Step 5: Checkpoint and review.** Leave changes uncommitted. Reviewer verifies the single-file package invariant, no main-thread ledger/native DB calls, worker-only guarded startup, and no live fixture processes. This task owns the extension worker seam; Task 8 makes later session integration edits sequentially.

## Task 8: Public footer mount, global config, doctor, and user docs

**Dependencies:** Tasks 6 and 7, after all prerequisite review gates. **Gate:** one final integration reviewer.

**Files:** Create `packages/host/src/usage/mount.ts`, `config.ts`, `doctor.ts`, `__tests__/mount.test.ts`, `__tests__/config.test.ts`, `__tests__/doctor.test.ts`, `docs/guide/usage.md`; modify `packages/host/src/extension.ts:75-83,330-440,775-803,1115-1172`, `packages/host/src/control.ts:15-63,144-162,172-214`, `packages/host/src/control/config-cmd.ts:7-34`, `packages/host/src/config-reload.ts:6-12`, `packages/ui/src/screens/config-schema.ts:4-6,54-64`, `packages/ui/src/screens/config-view.ts` for global-only key guidance, `README.md`, `docs/README.md`.

**Interfaces:**
- `UsageConfig = { footer: boolean; counterPoll: boolean; alertsSessionCredits: number; alertsRunCredits: number }`; `readUsageConfig(global: Record<string,unknown>, local: Record<string,unknown>): { value: UsageConfig; errors: readonly string[] }`; `isUsageConfigKey(key: string): boolean`.
- `mountUsage(pi: ExtensionAPI, ctx: ExtensionContext, runtime: UsageRuntime, config: UsageConfig): { refresh(): void; configure(config: UsageConfig): void; dispose(): void }`.
- `usageDoctorLines(snapshot: ReturnType<UsageRuntime["snapshot"]>, config: UsageConfig): { ok: boolean; lines: readonly string[] }`.

- [x] **Step 1: Write failing config/doctor tests.** `config.test.ts`: `registers four global-only fields with exact defaults`; `set and unset reject local scope through tool and slash paths`; `manual local keys are ignored and diagnosed`; `validates booleans and finite nonnegative thresholds`; `global set is not reported shadowed by ignored local values`; `UI shows global-only scope before edit`. Check schema rendering and direct controlConfig, not only new helper. `doctor.test.ts`: `reports schema counts parse errors unpriced aggregate estimates backfill status and rate provenance`; `unavailable counter is not zero`; `reports latest successful snapshot age and stale failure`; `shows signed comparison without claiming reconciliation` uses synthetic computed=12 and counter=10 to assert gap=-2, ratio=1.2 and estimated labeling, plus zero-counter ratio=null; `no ledger yet is a non-creating diagnosis`; `sanitizes errors and never prints credentials/raw bodies`. Diagnostics should use already-published worker state; doctor must not open/create usage.db on pi's main thread.
- [x] **Step 2: Write failing mount tests.** `mount.test.ts`: `sets AIC footer on parent TUI startup`; `footer false restores pi with setFooter(undefined)`; `ui.footer remains independent agents widget`; `reads public thinking name context and subscription flag`; `unknown auto state omits marker`; `all-entry initial load and append cursor preserve parity after tree navigation`; `message usage summaries and async usage entries refresh after settlement`; `session replacement resets reducer and releases subscriptions`; `non TUI and child modes install no terminal footer`; `worker error does not uninstall working footer`. Stub pi/ctx only through their public interfaces. Spies forbid ledger open on main thread and repeated history repricing on invalidate/render.
Representative config/restoration oracles, with public UI stubs and fixture config:

```ts
expect(readUsageConfig({}, {}).value).toEqual({ footer: true, counterPoll: true,
  alertsSessionCredits: 0, alertsRunCredits: 0 });
expect(readUsageConfig({}, { "usage.footer": false }).value.footer).toBe(true);
mounted.configure({ footer: false, counterPoll: true, alertsSessionCredits: 0,
  alertsRunCredits: 0 });
expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(undefined);
```

- [x] **Step 3: Run RED.** `gate test -- packages/host/src/usage/__tests__/config.test.ts packages/host/src/usage/__tests__/doctor.test.ts packages/host/src/usage/__tests__/mount.test.ts`.
- [x] **Step 4: Implement integration.** Add four defaults and schema fields; add optional `scope: "global"` metadata to ConfigField and teach config UI to direct edits to global scope for those fields without changing ordinary keys. Enforce scope for BOTH set and unset in controlConfig, and discard/diagnose hand-written local usage overrides on effective reads. Hot-apply footer/poll switches through the existing config reload seam; do not implement alerts. Resolve registry/sessions/ledger/lease/auth roots using db-core paths and public getAgentDir. Lazily start UsageRuntime in parent session_start, never registration. Mount only when ctx.mode is tui and usage.footer is true; disabling restores built-in footer and leaves the agents widget intact. Use ctx.sessionManager.getEntries(), ctx.getContextUsage(), pi.getThinkingLevel()/ctx.thinkingLevel, pi.getSessionName(), ctx.model and registry.getProvider()/isUsingOAuth. Detect subscription using the provider's OAuth isSubscription flag when OAuth is active, plus pi's kimi-coding special case. Auto-compaction stays undefined unless a verified public getter exists at execution time. Use a last-entry cursor, refreshing on persisted-message/turn_end, agent_settled, compaction/tree, session_info_changed, model/thinking selection, and a lightweight 1000 ms UI tick to catch asynchronously appended usage/cache_warm entries not exposed by an extension entry event. Only new entries are priced after the one initial reduction; cursor mismatch resets only on session replacement/history reset. Render uses cached state; no synchronous disk or DB work. Dispose timers/branch subscriptions/footer ownership idempotently on shutdown/replacement. Wire doctor lines through existing controlDoctor/handleControl without duplicate live DB queries.
- [x] **Step 5: Write documentation and run GREEN.** `docs/guide/usage.md` documents rows and priority, estimate/partial markers, unpriced historical rates and missing summary attribution, four global-only switches/defaults, ten-minute parent counter polling, read-only credential choice, local paths using `~` rather than user paths, worker backfill/resume/error behavior, independence from ui.footer, and the unresolved reconciliation limitation. Document that phases 2 to 4, /usage server, composition and alerts are not present. Link it from README and docs/README. Rerun config/doctor/mount tests plus existing usage-accounting, usage-display, config-cmd, config-precedence, config-reload and extension-shim tests. Scan changed docs for em-dashes and tests/docs for real data or user paths.
- [x] **Step 6: Final integration gate and review.** Run `gate run typecheck`, the targeted usage files, `gate test` ONCE for the full suite, and `gate run build`; record exact passed/failed counts. Rerun only failed exec-timing files once if needed, disclose both results. Run the built-worker smoke again after the final build without rerunning the full suite. The orchestrator obtains a fresh read-only whole-branch review after integration, using the configured reviewer model. Record any open billing acceptance concern explicitly. Leave all changes uncommitted, with no publication/push/PR from implementation workers; orchestration owns later git/CI steps and must verify remote CI before any completion claim on a PR branch.

## Parallelism and integration map

Each task uses one isolated writer worktree and one reviewer gate. Parallel writers must not share files or node_modules symlinks. The orchestrator creates worktrees and APFS-cloned node_modules before dispatch; workers do not mutate git.

```text
Task 1 pricing/contracts
  +--> Task 2 ledger -------+--> Task 5 counter ----+
  |                        |                       |
  +--> Task 3 parsing -----+--> Task 4 ingest -------+--> Task 7 worker
  |                                                      |
  +--> Task 6 footer -------------------------------------+--> Task 8 integration/docs
```

Exact dependency sets: `1:{}`, `2:{1}`, `3:{1}`, `4:{2,3}`, `5:{2}`, `6:{1}`, `7:{2,4,5}`, `8:{6,7}`. Tasks 2, 3 and 6 can start together; Task 5 can start as soon as 2 passes; Tasks 4 and 5 can run together after 2 and 3 pass. Task 6 remains independent of 4/5/7. Tasks 7 and 8 are sequential, because both edit the extension entry. Never start a dependent task before its prerequisites' review gates pass.

## Self-review and handoff

- Spec coverage: Phase 1 pricing/footer/ledger/calls backfill/counter/doctor/config/docs are assigned above. The private validation spike is completed as evidence gathering, NOT as a passed billing-accuracy gate.
- Interfaces: task-local structural parser/footer views intentionally avoid runtime cross-imports; Task 7 consumes Task 2/4/5 exports, and Task 8 consumes Task 6/7 without renaming contracts.
- Review Focus: aggregate arrival/restoration -> Task 4; partial/rotated bytes -> Task 4; stale leases/reload -> Tasks 5/7; widths/Unicode -> Task 6; uncertain attribution/rates -> Tasks 1/3/6.
- Phase boundaries: context_items/call_composition migrations and all composition logic wait for Phase 2; server/web wait for Phase 3; insights/what-if/alerts wait for Phase 4.
- Checkpoint protocol: every worker writes an ignored task report with RED/GREEN evidence, counts and open concerns; the orchestrator reconciles these and the final review. No git add or commit steps under the binding rules.
- Task count: **8**. No implementation is authorized by this planning handoff alone.
