# End-to-end verification plan (executed by subagents)

**Purpose:** every feature on this branch is covered by unit tests that use **doubles** —
fake child handles, injected `alive`/`kill` probes, in-memory DBs. That is why eight wiring
defects shipped past a green suite during Plan 1. This plan verifies the features against
**real processes, real DBs, and real git worktrees**.

**Rules for every scenario below:**
- Run under `.spider/scratch/e2e/` — never `/tmp`, `$TMPDIR`, `/var/tmp`.
- `export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"` first. `volta` is NOT installed.
- Never `npm install`.
- Clean up spawned processes on exit, including on failure — a leaked `pi` child from a test
  run is itself a bug report, but it must not accumulate.
- **Report what actually happened, including negative results.** A scenario that cannot be
  executed must be reported as NOT RUN, never as passed. Do not infer success from absence of
  error output.
- Capture verbatim command output for every assertion.

---

## S1 — Kill a real subagent

**Why:** every kill test uses a fake handle or a pidless row. The pid path and the
handle path have never been exercised against a real process.

1. Spawn a real long-running subagent via `spider run` (give it a task that will not finish
   quickly, e.g. a long sleep loop, so it stays alive).
2. Record the child pid from the `runs` table (`pid`, `host_pid`).
3. Confirm the process exists: `ps -p <pid>`.
4. `spider kill id:"<name-or-prefix>"`.
5. Assert **all** of:
   - the process is gone (`ps -p <pid>` fails)
   - **the whole process group is gone**, not just the leader
   - `runs.status` is `cancelled` — **NOT `done`** (this is Plan 1's C2; the dying child's
     shutdown used to overwrite the status)
   - `runs.result` mentions the kill
   - **no "subagent done" notification / triggerTurn fired** (Plan 1 Task 5)

**Discriminating detail:** step 5's status check is the whole point. If it reads `done`, C2 has
regressed.

---

## S2 — Exiting the session kills its children (the user's HARD REQUIREMENT)

**Why:** this cannot be proven by any unit test. `teardownAll` is tested, but nothing proves
pi actually *emits* `session_shutdown` on real exits.

Run each exit path separately, with a live subagent:
1. `/quit`
2. `Ctrl-C`
3. closing the terminal (SIGHUP)

After each: `ps aux | grep "[p]i --mode json"` must show nothing.

**This scenario requires a real TTY.** If the executing agent cannot drive a TTY, it must
report S2 as **NOT RUN — requires human** and say so plainly. Do not simulate it and claim a
pass. A headless approximation (sending SIGTERM to the host and checking children) is worth
running as S2a, but must be labelled as an approximation, not as S2.

---

## S3 — Orphan reaper against a real orphan

**Why:** all reaper tests inject `alive`/`kill` doubles; the real
`isProcessAlive` + `killProcessGroup` + `ps`-identity path has never run against a real orphan.

1. Spawn a subagent, record `pid` and `host_pid`.
2. `SIGKILL` the **host** (so `session_shutdown` never fires) — this is exactly the crash case.
3. Confirm the child is still alive and its row is still non-terminal.
4. Start a new session in the same project.
5. Assert the orphan was reaped: process gone, row `cancelled`.
6. **Negative control:** repeat with the host still ALIVE and assert the child is
   **left alone** — a run whose `host_pid` is live belongs to a concurrent session. This is the
   worst possible failure mode (one session killing another's agents), so it must be verified
   positively, not assumed.
7. **Identity control:** confirm a run whose recorded `pid` now belongs to an unrelated process
   is NOT signalled (Plan 1 I1). Simulate by rewriting `runs.pid` to the pid of a known
   unrelated long-lived process you spawned yourself, then run the reaper and assert that
   process survives.

---

## S4 — Intercom without a broker (Plan 3)

**Why:** the old transport depended entirely on an external broker answering an event; when
nothing answered, messages went to a table nobody read.

1. With **no broker present**, `spider message` from session A to session B.
2. Assert the row is enqueued in `message_mirror` with `delivered_at IS NULL`.
3. Assert the result reports **queued**, not a plain error.
4. Start session B; let its poller run.
5. Assert B received the message and the row is now `delivered_at IS NOT NULL`.
6. **Negative control:** a message addressed to session C is NOT delivered to B and remains
   pending.

---

## S5 — Child → parent escalation (Plan 3)

1. Run a subagent whose task makes it escalate (blocked / question).
2. Assert a `run_events` row with `type='escalation'` and the severity in the payload.
3. Assert the orchestrator was notified **promptly** — before the run ended.
4. **Negative control:** cancel a run, then emit an escalation for it; assert **no**
   notification fires (consistent with the cancelled-suppression rule).

---

## S6 — DB tiering across real worktrees (Plan 2)

**Why:** this is the defect that motivated the plan — 18 worktrees collapsed onto one
`project_key` and project memory held 0 rows.

1. Under `.spider/scratch/e2e/`, `git init` a repo and `git worktree add` two worktrees, A and B.
2. From A, write a **repo-tier** memory and a **worktree-tier** record (a session/run).
3. From B, assert:
   - the repo-tier memory **is** visible (same repo)
   - A's sessions/runs are **not** visible (different worktree)
4. Assert `projects` has **two distinct rows** with **distinct `db_path`s**.
5. **The regression that motivated everything:** open A, then B, then A again, and assert A's
   `db_path` was never rewritten by opening B.
6. Assert no stray `.spider` directory was created in any subdirectory — run the operations
   from a nested subdir and confirm the DB landed at the worktree ROOT.

---

## S7 — bash enforcement is real and not self-disabling

1. Attempt a `bash` tool call. Assert it is **blocked** and the reason names the `spider exec`
   replacement.
2. Assert the reason does **not** contain any hint about disabling enforcement.
3. Attempt `spider control config set exec.enforce false` **as the model**. Assert it is
   REFUSED **and the stored value is unchanged** — read the value back; do not trust the
   returned message.
4. Assert a non-bash tool (e.g. `read`) is not blocked.
5. Confirm the user-only slash command path can toggle it.

---

## S8 — Fresh install from the built bundle

**Why:** everything above runs against the source tree. Users get the bundle.

1. `npm run build`; assert-bundle OK.
2. `pi update --extensions` (or the documented install path) so the system spider is the new build.
3. In a NEW session, confirm the new surfaces exist: `spider kill` is dispatchable,
   `/exec-enforce` is registered, `bash` is blocked, and schema is at the expected version.
4. Assert an existing populated DB migrates cleanly — back it up first.

---

## Reporting format

For each scenario: **PASS / FAIL / NOT RUN**, the verbatim evidence, and for any FAIL the
minimal reproduction. A scenario that could not be executed is NOT RUN with the reason —
never silently skipped, never inferred as passing.
