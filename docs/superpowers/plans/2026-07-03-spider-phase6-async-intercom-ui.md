# Spider Phase 6 — Async-Only Subagents + Footer-Selection UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make spider subagents purely asynchronous — kill the synchronous `wait` action and have completed runs push their full output back to the main agent — and replace the full-page agents grid with an in-footer selection UX, plus finish the run-block styling/alignment and thinking-level persistence.

**Architecture:** Async runs are already separate `pi -p` child processes whose exit is observed in the PARENT process by `Runner.runAsync` (`handle.wait().then(...)` → `onComplete`). We remove `wait`/`waitForRuns` and make `onComplete` deliver the child's real final output (its last `message` run_event) to the parent agent via `pi.sendMessage(..., { deliverAs: "nextTurn" })` — the same "notify the parent on completion" shape pi-subagents uses. For the UI, pi widgets are render-only (no keyboard input); only `ctx.ui.custom` overlays get focus. So we replace the full-page `Grid` overlay with a compact `ctx.ui.custom` overlay anchored `bottom-center` (right above the editor/footer) that reuses the footer's one-line row format with an arrow-key focus cursor; Enter renders `AgentDetail` above the list.

**Tech Stack:** TypeScript (extensionless ESM, `moduleResolution: bundler`), Vite 8 (Rolldown + Oxc) bundle, tsgo typecheck with `isolatedDeclarations`, Vitest, better-sqlite3, pi extension API (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`).

## Global Constraints

- **TDD always:** no production code without a failing test first (red → green). One behavior per test, real code over mocks.
- **One commit per task**, conventional-commit messages; keep `.superpowers/sdd/progress.md` + the `todo` list updated.
- **Verification gate every task:** `npx tsgo -p tsconfig.json` (0 errors), `npx vitest run` (all green), `npm run build` (exit 0), `npx --yes madge --circular --extensions ts packages/*/src` (acyclic).
- **No hardcoded colors** anywhere in `packages/*/src` — every color flows through pi theme tokens via the `ThemeAdapter` (`fg`/`bg`/`bold`/`italic`/`glyph`). No `\x1b[` / hex literals. The only allowed theme token names are those in `ThemeColor` (accent, border, borderMuted, success, error, warning, muted, dim, text, toolTitle, toolOutput, mdHeading, …).
- **Extensionless imports** (no `.js`/`.ts` suffixes in TS import specifiers).
- **`isolatedDeclarations`:** every exported symbol needs an explicit type annotation.
- **Never use `/tmp`** for scratch — use `paths.scratch` / `scratchDbPath` (tests already do).
- **`npm rebuild better-sqlite3 sqlite-vec`** before any DB-touching test run if native binding errors appear.
- **Subagents are async by definition** — there is NO synchronous/blocking subagent execution surface after this phase.

## Non-Goals (explicitly out of scope)

- **Cross-tool run-registry unification** (spider run IDs recognized by the `subagent`/pi-subagents tool's `status`). They are deliberately separate registries; not fixed here.
- **Two-way live "child asks parent a question mid-run" relay** beyond what Task 2 delivers on completion is a follow-on (see Task 2's note); this plan wires completion output delivery, not an interactive Q&A channel.

## Current-State Reference (read before starting)

- `packages/subagents/src/actions/wait.ts` — `makeWaitHandler()` (to be deleted).
- `packages/subagents/src/wait.ts` — `waitForRuns(...)` (to be deleted).
- `packages/subagents/src/index.ts` — `export * from "./wait";` and `host.registerAction("wait", makeWaitHandler());` (to be removed).
- `packages/subagents/src/actions/run.ts` — `makeAsyncNotifier(ctx)` (line ~14) builds the completion message and calls `ctx.pi.sendMessage({ customType: "spider.subagent_done", content, display: true, details }, { deliverAs: "nextTurn" })`. Wired into `Runner` deps as `onComplete`.
- `packages/subagents/src/runner.ts` — `runAsync` fires `this.deps.onComplete?.(store.get(run.id) ?? run, status, result)` on child exit.
- `packages/subagents/src/child-reporter.ts` — emits `message` run_events whose `summary` is the child's assistant prose (via `message_end`).
- `packages/db-core/src/events.ts` — `appendRunEvent`, and a `listEvents` that reads the **`events`** table (NOT `run_events`). run_events columns: `run_id, session_id, ts, type, tool, summary, payload`.
- `packages/host/src/render-result.ts` — `renderSpiderResult` (body-only), `renderRun`, `runBlock` (line ~56, header `◆ name · type · model · status`), `mkTheme`, `renderSpiderCall`.
- `packages/host/src/agents/agents-ui.ts` — `installAgentsUI(pi, ctx, deps)`; full-page `openOverlay` using `Grid` + `AgentDetail` via `ctx.ui.custom(..., { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } })`.
- `packages/ui/src/agents/footer.ts` — `formatAgentLine(t, a, width, now, lead)` (shared row format), `AgentFooter`.
- `packages/ui/src/agents/grid.ts` — `Grid` (full-page list; to be removed/replaced).
- `packages/ui/src/agents/agent-detail.ts` — `AgentDetail(store, runId, theme, opts?)`; renders a framed conversation panel.
- `packages/ui/src/agents/store.ts` — `AgentStore` (`snapshot()` pinned-first, `getById`, `events(runId)`, `togglePin`, `isPinned`, `onChange`, `hasRunning`).
- pi API facts: `setWidget` factories return a render-only `Component` (**no input**). `ctx.ui.custom(factory, { overlay, overlayOptions })` gives keyboard focus; `OverlayOptions` supports `anchor: "bottom-center"`, `width`, `maxHeight`, `margin`.

---

## Task 1: Remove the synchronous `wait` action

**Files:**
- Delete: `packages/subagents/src/actions/wait.ts`
- Delete: `packages/subagents/src/wait.ts`
- Modify: `packages/subagents/src/index.ts` (drop the `export * from "./wait"` and the `host.registerAction("wait", …)` line + its import)
- Modify: `packages/subagents/src/__tests__/actions.test.ts` (remove wait-handler tests; add the assertion below)
- Check: `packages/host/src/extension.ts` and `packages/subagents/src/schemas.ts` for any `wait` references and remove them

**Interfaces:**
- Consumes: the action-registry host shape (`host.registerAction(name, handler)`).
- Produces: a subagents action registry that has NO `wait` action. Callers use async runs + completion notification only.

- [ ] **Step 1: Write the failing test** — assert `wait` is not registered.

In `packages/subagents/src/__tests__/actions.test.ts` (replace the existing wait tests):

```typescript
import { describe, it, expect } from "vitest";
import { registerActions } from "../index"; // adjust to the actual registrar export

it("does not register a synchronous 'wait' action (subagents are async-only)", () => {
  const registered = new Map<string, unknown>();
  const host = { registerAction: (name: string, h: unknown) => registered.set(name, h) };
  registerActions(host as never); // pass whatever registerActions needs; see index.ts
  expect(registered.has("run")).toBe(true);
  expect(registered.has("wait")).toBe(false);
});
```

If `index.ts` exposes the registrar under a different name/shape, match it — the assertion that matters is `registered.has("wait") === false` and `run` still present.

- [ ] **Step 2: Run the test — verify it FAILS** (wait still registered).

Run: `npx vitest run packages/subagents/src/__tests__/actions.test.ts`
Expected: FAIL — `expected false to be … true` / `wait` present.

- [ ] **Step 3: Delete the files and registration.**

```bash
git rm packages/subagents/src/actions/wait.ts packages/subagents/src/wait.ts
```

In `packages/subagents/src/index.ts` remove `export * from "./wait";`, the `import { makeWaitHandler } from "./actions/wait";`, and the `host.registerAction("wait", makeWaitHandler());` line. Grep for stragglers:

```bash
grep -rn "wait" packages/subagents/src packages/host/src --include=*.ts | grep -viE "await|waiting|__tests__|hardwait|waitFor[A-Z]" 
```

Remove any `wait` entry from `packages/subagents/src/schemas.ts` (action enum / arg schema) and any `wait` handling in `packages/host/src/extension.ts`.

- [ ] **Step 4: Run tests — verify GREEN.**

Run: `npx vitest run` — all pass.

- [ ] **Step 5: Full gate + commit.**

```bash
npx tsgo -p tsconfig.json && npm run build && npx --yes madge --circular --extensions ts packages/*/src
git add -A
git commit -m "feat(subagents)!: remove synchronous wait action — subagents are async-only"
```

---

## Task 2: Completion notifier delivers the child's real output to the parent

**Files:**
- Create: `packages/subagents/src/completion-output.ts`
- Test: `packages/subagents/src/__tests__/completion-output.test.ts`
- Modify: `packages/subagents/src/actions/run.ts` (`makeAsyncNotifier` uses the new helper)
- Test: `packages/subagents/src/__tests__/runner.test.ts` (assert the notifier receives real output)

**Interfaces:**
- Produces: `export function latestRunOutput(db: Db, runId: string, fallback?: string): string` — returns the child's final assistant prose (the newest `run_events` row with `type='message'`, its `summary`), else `fallback` (the run's `result`), else `""`.
- Consumes: `makeAsyncNotifier(ctx)` already receives `(run, status, result)`; it will call `latestRunOutput(ctx.db, run.id, result)` to build the message body.

**Why:** `wait` used to be where a caller "collected" output; with `wait` gone, the completion push must carry the actual bullet-summary / result the agent produced — not just a status word. The child's final `message` event is that output (captured since Phase 5's #31 work).

- [ ] **Step 1: Write the failing test.**

`packages/subagents/src/__tests__/completion-output.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { latestRunOutput } from "../completion-output";
import { appendRunEvent } from "@spider/db-core";
import { freshDb } from "./helpers/testutil";

describe("latestRunOutput", () => {
  it("returns the newest assistant message summary for a run", () => {
    const db = freshDb();
    const ctx = { runId: "r1", sessionId: "s" };
    appendRunEvent(db, { ...ctx, ts: 1, type: "message", summary: "first pass notes" });
    appendRunEvent(db, { ...ctx, ts: 2, type: "tool_intent", tool: "read", summary: "read x" });
    appendRunEvent(db, { ...ctx, ts: 3, type: "message", summary: "FINAL: 3 TODOs found" });
    expect(latestRunOutput(db, "r1")).toBe("FINAL: 3 TODOs found");
  });

  it("falls back to the provided result when no message events exist", () => {
    const db = freshDb();
    expect(latestRunOutput(db, "missing", "fallback text")).toBe("fallback text");
    expect(latestRunOutput(db, "missing")).toBe("");
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (module missing).

Run: `npx vitest run packages/subagents/src/__tests__/completion-output.test.ts`
Expected: FAIL — cannot find `../completion-output`.

- [ ] **Step 3: Implement.**

`packages/subagents/src/completion-output.ts`:

```typescript
import type { Db } from "@spider/db-core";

/** The child's final assistant prose for a run (newest `message` run_event), else the
 *  fallback result string, else "". Used to push real output to the parent on completion. */
export function latestRunOutput(db: Db, runId: string, fallback?: string): string {
  const row = db
    .prepare(`SELECT summary FROM run_events WHERE run_id = ? AND type = 'message' ORDER BY ts DESC, id DESC LIMIT 1`)
    .get(runId) as { summary?: string } | undefined;
  const out = row?.summary?.trim();
  if (out) return out;
  return (fallback ?? "").trim();
}
```

- [ ] **Step 4: Run — verify GREEN.**

Run: `npx vitest run packages/subagents/src/__tests__/completion-output.test.ts`

- [ ] **Step 5: Wire into `makeAsyncNotifier`.**

In `packages/subagents/src/actions/run.ts`, import `latestRunOutput` and use it to build the message `content`:

```typescript
import { latestRunOutput } from "../completion-output";
// inside makeAsyncNotifier's callback, replacing the current result-preview logic:
const output = latestRunOutput(ctx.db, run.id, result);
const name = run.name ?? run.agent ?? "subagent";
const content = `🕸 subagent "${name}" (${run.agent}) finished: ${status}\n\n${output || "(no output)"}`;
ctx.pi?.sendMessage?.(
  { customType: "spider.subagent_done", content, display: true, details: { runId: run.id, status, agent: run.agent, output } },
  { deliverAs: "nextTurn" },
);
```

Keep the existing guarded `ctx.ui?.notify?.(...)` toast if present.

- [ ] **Step 6: Add a runner-level test** that the notifier gets the real output.

In `packages/subagents/src/__tests__/runner.test.ts`, add a case: spawn a fake child whose reporter appends a final `message` run_event, drive `runAsync` to completion, and assert the captured `onComplete` output (via `latestRunOutput`) equals that message. Follow the existing runner test's fake-spawn harness for shape.

- [ ] **Step 7: Full gate + commit.**

```bash
npx vitest run && npx tsgo -p tsconfig.json && npm run build && npx --yes madge --circular --extensions ts packages/*/src
git add -A
git commit -m "feat(subagents): push the child's real final output to the parent on async completion"
```

> **Note (follow-on, not this task):** children already receive an intercom identity (`intercomSessionName` in `RunOpts`/`buildChildSpawnSpec`). A future task can let a child `intercom ask` the parent mid-run for questions; this task delivers completion output, which is the reported gap.

---

## Task 3: Neutralize run-block status colors (#36)

**Files:**
- Modify: `packages/host/src/render-result.ts` (`runBlock`)
- Test: `packages/host/src/__tests__/render-result.test.ts` (add a marker-theme case; create the file if the repo keeps render tests via a `vis`-style harness — prefer a real unit test here)

**Interfaces:**
- Consumes: `mkTheme(theme)` adapter (`fg`/`bold`/`italic`).
- Produces: `runBlock` output where the leading glyph, the type (scout/worker), and the status word are NOT status-colored — they use neutral `toolTitle`/`muted` tokens. (Status is still conveyed by the glyph SHAPE ◆✓✗ and the status word text, just not by color — matching the footer, where only the spinner is colored.)

- [ ] **Step 1: Write the failing test** using a marker theme that reveals token routing.

```typescript
import { describe, it, expect } from "vitest";
import { renderSpiderResult } from "../render-result";

const marker = { fg: (t: string, s: string) => `⟨${t}|${s}⟩`, bold: (s: string) => s, italic: (s: string) => s };

it("run block does not status-color the glyph, type, or status word", () => {
  const details = { runs: [{ name: "todo-hunt", agent: "worker", model: "openai/gpt-5", status: "running", task: "" }] };
  const out = renderSpiderResult({ details }, { expanded: false }, marker, { args: { action: "run" } }).render(120).join("\n");
  // no success/error/accent/warning wrapping around glyph, type, or status:
  expect(out).not.toMatch(/⟨(success|error|warning|accent)\|/);
  // the type and status still present, in neutral tokens:
  expect(out).toContain("⟨toolTitle|");
});
```

(Confirm the exact `mkTheme` marker shape by checking `render-result.ts` — it reads `theme.fg/bold/italic` defensively, so a plain object works.)

- [ ] **Step 2: Run — verify FAIL** (glyph/status/type currently use `STOK`/`accent`).

Run: `npx vitest run packages/host/src/__tests__/render-result.test.ts`
Expected: FAIL — `⟨success|◆⟩` / `⟨accent|worker⟩` present.

- [ ] **Step 3: Implement — neutral run-block header.**

In `runBlock` (render-result.ts ~line 56), replace status-colored tokens with neutral ones:

```typescript
const glyph = t.fg("toolTitle", SG[status] ?? "•");
const name = t.bold(r.name ?? r.agent ?? "agent");
const sep = t.fg("dim", "·");
const head = `  ${glyph} ${name} ${sep} ${t.italic(t.fg("toolTitle", r.agent ?? "worker"))} ${sep} ${t.fg("muted", shortModel(r.model))} ${sep} ${t.fg("muted", status)}`;
```

(Drop the `STOK`-based coloring for glyph and status; keep `SG` glyph shapes. Leave `italic` on the type per the earlier request.)

- [ ] **Step 4: Run — verify GREEN**, plus full suite.

Run: `npx vitest run`

- [ ] **Step 5: Gate + commit.**

```bash
npx tsgo -p tsconfig.json && npm run build && npx --yes madge --circular --extensions ts packages/*/src
git add -A
git commit -m "feat(host): neutral run-block colours — glyph/type/status no longer status-coloured (#36)"
```

---

## Task 4: Result body alignment — indent + gap under the title (#alignment)

**Files:**
- Modify: `packages/host/src/render-result.ts` (`renderRun` — leading blank line + one extra leading space on body lines)
- Test: `packages/host/src/__tests__/render-result.test.ts`

**Interfaces:**
- Produces: `renderRun` output whose first line is empty (a one-row gap below the tool title), and whose content lines start one column further right than today (body indent `   ` (3) instead of `  ` (2) for headers; instruction lines shift from 4→5).

- [ ] **Step 1: Write the failing test.**

```typescript
it("run result body starts with a blank gap line and is indented one space further", () => {
  const details = { runs: [{ name: "a", agent: "worker", model: "x", status: "running", task: "" }] };
  const lines = renderSpiderResult({ details }, { expanded: false }, marker, { args: { action: "run" } }).render(120);
  expect(lines[0]).toBe("");                 // gap under the title
  expect(lines[1].startsWith("   ")).toBe(true); // 3-space indent (was 2)
});
```

- [ ] **Step 2: Run — verify FAIL** (no leading blank; 2-space indent).

- [ ] **Step 3: Implement.**

In `renderRun`, prepend an empty line and add one leading space to each emitted line. Cleanest: build the block lines as today, then map a one-space prefix and unshift `""`:

```typescript
render(width: number): string[] {
  if (runs.length === 0) return ["", t.fg("muted", "   (no runs)")];
  const lines: string[] = [];
  const multi = runs.length > 1;
  for (const r of runs) { lines.push(...runBlock(t, r, width, expanded)); if (multi) lines.push(""); }
  const anyTask = runs.some((r) => (r.task ?? "").trim());
  if (!expanded && anyTask) lines.push(t.fg("dim", "  ctrl+o to expand instructions"));
  return ["", ...lines.map((l) => (l === "" ? l : " " + l))]; // gap + 1-space right shift
}
```

(This keeps `runBlock`'s internal relative indentation intact; the global `+1` space and leading gap are applied once here.)

- [ ] **Step 4: Run — verify GREEN**, full suite.

- [ ] **Step 5: Gate + commit.**

```bash
git commit -am "feat(host): result body starts one space right with a gap under the tool title"
```

---

## Task 5: `AgentList` — focusable, footer-format selector component (#37 part 1)

**Files:**
- Create: `packages/ui/src/agents/agent-list.ts`
- Modify: `packages/ui/src/index.ts` (export `AgentList`)
- Test: `packages/ui/src/__tests__/agent-list.test.ts`

**Interfaces:**
- Consumes: `AgentStore` (`snapshot()` pinned-first, `isPinned`), `formatAgentLine(t, a, width, now, lead)`, `STATUS_GLYPH`, `statusToken`, `Spinner`, `ThemeAdapter`, pi-tui `Key`/`matchesKey`.
- Produces:
  ```typescript
  export class AgentList implements Component {
    constructor(store: AgentStore, theme: ThemeAdapter, opts?: { now?: () => number; spinner?: Spinner });
    onDrill(fn: (runId: string) => void): void;  // Enter on the focused row
    onClose(fn: () => void): void;                // Esc / ctrl+shift+g toggle-close
    handleInput(data: string): boolean;           // up/down/enter/esc/m/i/r/f
    render(width: number): string[];
    invalidate(): void;
  }
  ```
- Behavior: renders one row per `store.snapshot()` agent using `formatAgentLine`, prefixed with a focus cursor (`▸ ` on the focused row, `  ` otherwise). Up/Down move focus, clamped to `[0, n-1]`. Enter → `onDrill(focusedRunId)`. Esc → `onClose()`. Reuses footer keys (`m`/`i`/`r` via actions is optional here — keep it minimal: only focus/enter/esc for the first cut; do NOT add actions the footer didn't have). Empty list renders a single muted `(no active agents)` line and Enter is a no-op.

- [ ] **Step 1: Write the failing test.**

```typescript
import { describe, it, expect } from "vitest";
import { AgentList } from "../agents/agent-list";
import { AgentStore } from "../agents/store";
import type { RunRow, RunSource } from "../agents/types";

const th = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s, glyph: "🕸" };
function storeOf(rows: RunRow[]): AgentStore {
  const src: RunSource = { listActive: () => rows, getRun: (id) => rows.find(r => r.id === id), subscribe: () => () => {} };
  const s = new AgentStore(src); s.start(); return s;
}
const rows = [
  { id: "a1", session_id: "s", agent: "scout", name: "one", status: "running", step_count: 1, token_count: 0, started_at: 0 },
  { id: "a2", session_id: "s", agent: "worker", name: "two", status: "running", step_count: 1, token_count: 0, started_at: 0 },
] as RunRow[];

describe("AgentList", () => {
  it("focuses row 0, moves with arrows, and drills the focused run on enter", () => {
    const store = storeOf(rows);
    const list = new AgentList(store, th as never, { now: () => 0 });
    let drilled = "";
    list.onDrill((id) => { drilled = id; });
    // focus starts at row 0 → cursor on first line
    expect(list.render(80)[0].startsWith("▸")).toBe(true);
    list.handleInput("\x1b[B"); // Down arrow
    expect(list.render(80)[1].startsWith("▸")).toBe(true);
    list.handleInput("\r");     // Enter
    expect(drilled).toBe("a2");
  });

  it("esc closes", () => {
    const store = storeOf(rows);
    const list = new AgentList(store, th as never);
    let closed = false;
    list.onClose(() => { closed = true; });
    list.handleInput("\x1b"); // Esc
    expect(closed).toBe(true);
  });
});
```

(Confirm the exact key bytes with pi-tui's `Key`/`matchesKey`; the test may use `matchesKey(data, Key.down)` indirectly — if raw byte matching is fragile, drive input through `matchesKey` in the test the same way `grid.test.ts`/`agent-detail.test.ts` do.)

- [ ] **Step 2: Run — verify FAIL** (module missing).

- [ ] **Step 3: Implement `AgentList`.** Model it on the existing `Grid` list body (from #32) but strip the full-page frame; prefix each row with the focus cursor. Use `formatAgentLine(this.theme, a, width - 2, now, lead)` where `lead = a.status === "running" ? spinner.frame(now) : STATUS_GLYPH[a.status]`, then prepend `i === focus ? "▸ " : "  "`.

- [ ] **Step 4: Run — verify GREEN**, full suite.

- [ ] **Step 5: Gate + commit.**

```bash
git commit -am "feat(ui): AgentList — focusable footer-format selector (#37)"
```

---

## Task 6: Swap the full-page grid overlay for the bottom-anchored selector (#37 part 2)

**Files:**
- Modify: `packages/host/src/agents/agents-ui.ts` (`openOverlay` uses `AgentList` + `AgentDetail`, anchored `bottom-center`)
- Modify: `packages/host/src/__tests__/agents-ui.test.ts` (assert overlay wiring: opening yields an `AgentList`; Enter swaps to detail rendered ABOVE the list)
- Modify: `packages/ui/src/index.ts` (stop exporting `Grid` if now unused) — see Task 7

**Interfaces:**
- Consumes: `AgentList` (Task 5), `AgentDetail`, `ctx.ui.custom(factory, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "50%", margin: { bottom: 1 } } })`.
- Produces: `ctrl+shift+g` / `/agents` open a compact bottom overlay. The overlay renders `detail ? [...detail.render(w), "", ...list.render(w)] : list.render(w)` — i.e. when a row is drilled, the detail panel appears ABOVE the agent list (which sits just above the editor). Esc from detail returns to the list; Esc from the list closes; `ctrl+shift+g` while open closes (toggle).

- [ ] **Step 1: Write the failing test** in `agents-ui.test.ts`. Use the existing fake `ctx.ui.custom` harness (it captures the factory). Assert:
  - after opening, the rendered lines contain both agent names (list present),
  - after feeding a Down+Enter to the overlay's `handleInput`, the rendered output contains the detail frame markers (`╭─`) ABOVE the list rows.

Model the assertions on the current `agents-ui.test.ts` overlay tests (they already drive the captured factory's `render`/`handleInput`).

- [ ] **Step 2: Run — verify FAIL** (still renders the full-page `Grid`).

- [ ] **Step 3: Implement.** Rewrite `openOverlay`:

```typescript
const openOverlay = async () => {
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const th = piTheme(theme as never);
    const list = new AgentList(store, th);
    let detail: AgentDetail | undefined;
    const rr = () => (tui as { requestRender?: () => void }).requestRender?.();
    list.onClose(() => done());
    list.onDrill((runId) => {
      const d = new AgentDetail(store, runId, th);
      d.onBack(() => { detail = undefined; rr(); });
      detail = d; rr();
    });
    const stop = selfTick(tui, store);
    return {
      render: (w: number) => detail ? [...detail.render(w), "", ...list.render(w)] : list.render(w),
      invalidate: () => list.invalidate(),
      handleInput: (data: string) => { (detail ?? list).handleInput(data); rr(); },
      dispose: () => stop(),
    };
  }, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "50%", margin: { bottom: 1 } } });
};
```

Keep the mounted passive `AgentFooter` widget as-is (it stays visible below the overlay); the overlay is the interactive layer.

- [ ] **Step 4: Run — verify GREEN**, full suite.

- [ ] **Step 5: Gate + commit.**

```bash
git commit -am "feat(host): footer-anchored agent selector replaces the full-page grid (#37)"
```

---

## Task 7: Delete the now-unused `Grid` full-page component

**Files:**
- Delete: `packages/ui/src/agents/grid.ts` and `packages/ui/src/__tests__/grid.test.ts` (only if Task 6 left `Grid` unreferenced)
- Modify: `packages/ui/src/index.ts` (remove the `Grid` export)
- Check: `packages/ui/src/agents/grid-cell.ts`, `grid-layout.ts` — delete if they were only used by `Grid`

**Interfaces:**
- Produces: a `@spider/ui` barrel with no `Grid` export; `AgentList` is the only selector.

- [ ] **Step 1: Prove `Grid` is unreferenced.**

```bash
grep -rn "\bGrid\b" packages --include=*.ts | grep -v "grid.ts\|grid.test.ts\|grid-cell\|grid-layout\|AgentList"
```
Expected: no non-test references outside the files being deleted. If `grid-cell`/`grid-layout` are referenced elsewhere (e.g. `wrapText` from `grid-cell` used by `agent-detail.ts`), KEEP those and only delete `Grid` itself.

- [ ] **Step 2: Write/adjust the failing test** — the barrel no longer exports `Grid`.

In `packages/ui/src/__tests__/index.test.ts`:

```typescript
import * as ui from "../index";
it("no longer exports the removed full-page Grid", () => {
  expect((ui as Record<string, unknown>).Grid).toBeUndefined();
  expect(ui.AgentList).toBeDefined();
});
```

- [ ] **Step 3: Run — verify FAIL** (Grid still exported).

- [ ] **Step 4: Delete + remove export.**

```bash
git rm packages/ui/src/agents/grid.ts packages/ui/src/__tests__/grid.test.ts
```
Remove `Grid` from `packages/ui/src/index.ts`. Re-run the grep from Step 1 to confirm clean. Delete `grid-cell.ts`/`grid-layout.ts` (+ their tests) ONLY if the Step 1 grep proves them orphaned; otherwise leave them.

- [ ] **Step 5: Run — verify GREEN**, full suite + gate.

- [ ] **Step 6: Commit.**

```bash
git commit -am "chore(ui): remove the full-page Grid component, superseded by AgentList (#37)"
```

---

## Task 8: Persist thinking level on runs (#26 part 1)

**Files:**
- Modify: `packages/db-core/src/` migration (add a `thinking TEXT` column to `runs`) — follow the existing migration pattern (find it: `grep -rn "ALTER TABLE runs\|CREATE TABLE runs\|migrations" packages/db-core/src`)
- Modify: `packages/subagents/src/run-store.ts` (`create` accepts `thinking?`, persists it; `updateProgress` COALESCEs `thinking`; `RunRow` gains `thinking?: string | null`)
- Modify: `packages/subagents/src/runner.ts` + `pi-args.ts` (thread `thinking` from `RunOpts` into the child env, e.g. `PI_SPIDER_THINKING`) and `child-reporter.ts` (capture and `updateProgress({ thinking })` once, mirroring the model capture)
- Test: `packages/subagents/src/__tests__/run-store.test.ts`, `child-reporter.test.ts`

**Interfaces:**
- Produces: `runs.thinking` column; `RunStore.create({ ..., thinking? })`; `RunStore.updateProgress(id, { thinking? })`; `RunRow.thinking`.
- Consumes: whatever thinking-level value the `run` action already parses (find it: `grep -rn "thinking" packages/subagents/src`). If the action does not yet parse a per-task thinking level, add it to the run schema (`packages/subagents/src/schemas.ts`) as an optional string first.

- [ ] **Step 1: Write the failing test** (store round-trip).

```typescript
it("persists and updates the thinking level on a run", () => {
  const db = freshDb();
  const store = new RunStore(db);
  const { id } = store.create({ sessionId: "s", agent: "worker", thinking: "medium" });
  expect(store.get(id)!.thinking).toBe("medium");
  store.updateProgress(id, { thinking: "high" });
  expect(store.get(id)!.thinking).toBe("high");
});
```

- [ ] **Step 2: Run — verify FAIL** (no column / no field).

- [ ] **Step 3: Implement** — migration adds `thinking TEXT`; `create` inserts it; `updateProgress` adds `thinking = COALESCE(@thinking, thinking)`; `RunRow` type gains the field. Rebuild native bindings if needed: `npm rebuild better-sqlite3 sqlite-vec`.

- [ ] **Step 4: Run — verify GREEN**, full suite.

- [ ] **Step 5: Thread through child capture** — add `PI_SPIDER_THINKING` in `pi-args.ts` from `RunOpts.thinking`, and in `child-reporter.ts` add a `onThinking`/capture that calls `updateProgress({ thinking })` once (guarded like `modelSeen`). Add a child-reporter test mirroring the model-capture test.

- [ ] **Step 6: Gate + commit.**

```bash
git commit -am "feat(subagents): persist thinking level on runs (#26)"
```

---

## Task 9: Show thinking level in the UI (#26 part 2)

**Files:**
- Modify: `packages/ui/src/agents/types.ts` (`AgentSnapshot.thinking?`, `projectRow` maps it), `store.ts`
- Modify: `packages/ui/src/agents/footer.ts` (`formatAgentLine` appends `· <thinking>` when present, `dim`)
- Modify: `packages/host/src/render-result.ts` (`runBlock` appends thinking after model)
- Modify: `packages/ui/src/agents/agent-detail.ts` (meta line includes thinking)
- Test: `packages/ui/src/__tests__/footer.test.ts`, `render-result.test.ts`

**Interfaces:**
- Consumes: `AgentSnapshot.thinking` (Task 8's `RunRow.thinking` mapped in `projectRow`).
- Produces: footer/run-block/detail lines that include the thinking level (e.g. `… · gpt-5 · high · 3 turns …`) only when set; absent → omitted (no empty ` · `).

- [ ] **Step 1: Write the failing test** (footer includes thinking when present, omits when absent).

```typescript
it("footer line includes the thinking level when set", () => {
  const a = { runId: "a1", name: "x", agent: "worker", status: "running", model: "openai/gpt-5", thinking: "high", stepCount: 1, tokenCount: 0, startedAt: 0, recentActivity: [] };
  const line = formatAgentLine(th as never, a as never, 200, 0, "◆");
  expect(line).toContain("high");
});
```

- [ ] **Step 2: Run — verify FAIL.**
- [ ] **Step 3: Implement** the four render sites; guard each with `if (a.thinking) …`.
- [ ] **Step 4: Run — verify GREEN**, full suite.
- [ ] **Step 5: Gate + commit.**

```bash
git commit -am "feat(ui): surface thinking level in footer, run block, and detail (#26)"
```

---

## Task 10: Ledger + final whole-branch review

- [ ] Update `.superpowers/sdd/progress.md` with one line per completed task (commit range + "review clean").
- [ ] Toggle todos #26, #35, #36, #37 (+ the alignment item) done via the `todo` tool.
- [ ] Run the full gate once more: `npx tsgo -p tsconfig.json && npx vitest run && npm run build && npx --yes madge --circular --extensions ts packages/*/src`.
- [ ] Dispatch the final whole-branch code review (superpowers:requesting-code-review) on the most capable model; fix Critical/Important findings with ONE fix subagent.
- [ ] Hand back a `/reload` + prefixed live-test prompt (prepend: `"You are an agent helping me test the spider tool. DO NOT TRY TO DEBUG FURTHER, just report any issues."`).

---

## Self-Review (author checklist — completed)

**1. Spec coverage:**
- Remove `wait` entirely → Task 1. Async report-back with real output → Task 2. "Via intercom the same way pi-subagents does" → Task 2 uses the same completion→`sendMessage(deliverAs:nextTurn)` push; child intercom identity already exists (noted as follow-on for two-way questions).
- Remove run-block status colors (diamond/running/scout-worker) → Task 3.
- Title/text alignment (1 space right + larger gap) → Task 4.
- Kill the grid view; `ctrl+shift+g` focuses footer rows, arrows select, Enter opens detail above the footer → Tasks 5–7 (`AgentList` + bottom-anchored overlay + `Grid` deletion).
- Thinking-level persistence (#26) → Tasks 8–9.
- Cross-tool ID mismatch → explicit Non-Goal.

**2. Placeholder scan:** every code step carries real code or an exact grep/command; no TODO/TBD.

**3. Type consistency:** `latestRunOutput(db, runId, fallback?)`, `AgentList` ctor/`onDrill`/`onClose`/`handleInput`, `RunRow.thinking`, `AgentSnapshot.thinking`, and `formatAgentLine` usage are named identically across tasks. `AgentList` reuses the existing `formatAgentLine` signature `(t, a, width, now, lead)`.

**Risk notes for the executor:**
- Task 1: confirm the actual registrar export name in `index.ts` before writing the test; the binding assertion (`no "wait"`, `"run"` present) is the invariant.
- Task 6: `agents-ui.test.ts` must drive the captured `ctx.ui.custom` factory's `render`/`handleInput`; reuse the file's existing overlay-harness helpers.
- Task 8: locate and follow the existing db-core migration mechanism; `npm rebuild better-sqlite3 sqlite-vec` before DB tests.
