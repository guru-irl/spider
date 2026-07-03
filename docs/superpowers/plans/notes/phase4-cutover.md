# Phase 4 cutover

- spider `run` (single / chain / parallel / pipeline), `wait`, and `message` are **live** on the
  shared per-project DB (`runs` / `run_events`) + global `message_mirror` — no tmpdir JSON/JSONL
  state, persists across restarts, and every run's activity streams on the in-process `bus` for the
  Phase 5 footer/grid + organism.
- The legacy pi-subagents `subagent`/`wait` tools (external global extension) + their `os.tmpdir()`
  `RESULTS_DIR`/`ASYNC_DIR`/`CHAIN_RUNS_DIR` state are **deprecated** (kept, not removed). spider does
  not register a competing `subagent` tool; its surface is `run`/`wait`/`message` via `registerAction`.
- **Removal condition:** once the Phase 5 footer/grid consume `runs`/`run_events`, delete the legacy
  tool registration + tmpdir consts from the external pi-subagents package (owned by that package).
- **Open sub-decision RESOLVED:** pipeline-with-handoff is a **first-class** `run {pipeline,
  handoff:"intercom"}` runtime construct (`PipelineCoordinator`), not prompt-driven — see plan Task 10
  justification (deterministic `run_events(type='handoff')` edges for the UI, correct pre-spawn
  addressing/wake, unit-testability, queryable `message_mirror` history).
- **Child guard:** in a subagent child process (`PI_SUBAGENT_CHILD=1`) spider registers NO
  orchestration surface — it only attaches the `run_events` reporter (`attachChildReporter`).
- **Deferred (out of Phase 4 scope, documented not guessed):** `wakeOn:"accepted"` acceptance-gated
  handoff + `count>1` multi-worker stage fan-out (Phase 8); worktree isolation; dynamic expand/collect
  fanout; clarify TUI; cost/profiles/doctor management actions.
- **Security note (carried from Phase 3):** tool tracking/scrub applies to agent-facing tools; the
  `spider` mega-tool + spider's internal service calls are exempt (no feedback loops).
