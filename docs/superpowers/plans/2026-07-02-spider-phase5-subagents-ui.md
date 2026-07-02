# spider Phase 5 — Subagents UI (footer + live grid) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy pi-subagents live UI wholesale with an event-driven `@spider/ui` stack — a persistent agents **footer** above the chat bar and a **Ctrl+G live grid** — driven by `store → coalesced frames → line-diff → paint` (no polling), pipeline-aware (handoff edges + phase state) from the start.

**Architecture:** A pure, DB-decoupled `AgentStore` projects the shared `runs`/`run_events` tables into `AgentSnapshot[]` + `HandoffEdge[]`, hydrating from a `RunSource` adapter (host wraps `@spider/db-core`) and updating **on `db-core` `bus` append** (in-process emitter). A single `FrameScheduler` coalesces all change notifications into ~16–33 ms frames. Each component (`AgentFooter`, `Grid`) rebuilds its line array on a frame, runs `diffLines(prev,next)`, and calls `tui.requestRender()` **only when a visible line changed** — killing the old 250 ms poll, full-subtree rebuild, and `JSON.stringify`-of-22-fields gate. All layout math (grid tiers, footer overflow, line diff, coalescing cadence) lives in pure functions with Vitest tests.

**Tech Stack:** TypeScript (ESM), `@spider/ui` over `@earendil-works/pi-tui` + `@earendil-works/pi-coding-agent` (peer), `@spider/db-core` (`runs`/`run_events`/`bus`), `@spider/host` for mounting, Vitest (TDD).

## Global Constraints

- **Language:** TypeScript, Node ≥ 22.19.0 (target Node 24). ESM (`"type":"module"`).
- **UI:** all visual output through `@spider/ui`; honor pi **active theme tokens** (light/dark/user colors) via an injected `ThemeAdapter`; signature glyph is **🕸** (spider/web); **never color-only** (always glyph + color).
- **No polling:** the footer/grid update model is event-driven on `db-core` `bus` append + coalesced frames + line-diff. No `setInterval` poll of the DB. The ONLY timer permitted is a wall-clock **animation/elapsed ticker** (~100 ms, `unref`) that advances spinner frames and live durations, and it must stop when zero agents are running.
- **Width safety (non-negotiable):** every string returned from `render(width)` MUST be `≤ width`; run each through `truncateToWidth(line, width)`; use `visibleWidth` for alignment math; guard `width < 3`.
- **Stable, diffable trees:** never `container.clear()`+rebuild every frame; cache `{cachedWidth,cachedLines}`; recompute only on version/theme/width change; implement `invalidate()` to rebuild themed content (pi calls it on theme change).
- **Zero temp-dir:** integration DBs + scratch under `packages/<pkg>/.spider/scratch/`. NEVER `/tmp`, `$TMPDIR`, `/var/tmp`.
- **Canonical names (do not rename):** tables `runs`/`run_events`; `RunEvent` shape and `bus`/`appendRunEvent` from `@spider/db-core` (see `plans/README.md`); packages `@spider/ui`, `@spider/host`. The tool is `spider`; glyph is 🕸.
- **Tests:** Vitest; TDD (test first → red → green → refactor); pure functions get unit tests; host wiring gets adapter/mount tests with fakes.
- **Cleanup:** every `setWidget`/shortcut/ticker registered on `session_start` MUST be torn down on `session_shutdown`.

---

## Dependencies & preconditions

- **Phase 0** delivered `@spider/ui` skeleton (`Component`, `theme` with glyph 🕸, `Panel`, `SectionRule`, `StatusLine`, `LiveWidget`) and `@spider/db-core` (`runs`/`run_events` schema, `bus`, `appendRunEvent`, `openProject`). This plan **extends** the `@spider/ui` barrel; it does not rewrite the skeleton.
- **Phase 4 (Subagents runtime) MUST land first** — it writes `runs` rows and appends `run_events` (via `appendRunEvent`, which emits on `bus`) for every meaningful transition, and it exposes a control surface for message/wake/interrupt/resume. This plan defines the exact `RunSource` (read) and `AgentActions` (control) interfaces Phase 5 consumes; **if Phase 4's control API is not yet wired, the interaction keys degrade to a toast** ("action unavailable") and the store/footer/grid still function read-only. See Risks.
- The store depends only on the **existing** `runs`/`run_events` columns; it re-reads the single affected `runs` row on each bus event (indexed by `id`) rather than requiring Phase 4 to emit rich payloads.

---

## File Structure

New/modified files (all under `/mnt/data/src/spider/`):

```
packages/ui/src/
├── agents/
│   ├── types.ts            # AgentStatus, AgentSnapshot, HandoffEdge, RunRow, RunSource,
│   │                       #   AgentActions, ThemeAdapter, FooterModel, GridLayout, LineDiff
│   ├── store.ts            # applyRunRow / applyEvent reducer + AgentStore (subscribe→notify)
│   ├── coalesce.ts         # FrameScheduler (injectable clock+timer; ~16–33ms)
│   ├── diff.ts             # diffLines(prev,next) + hasChanges
│   ├── grid-layout.ts      # layoutGrid(count,page) tier + pagination math
│   ├── footer-model.ts     # buildFooterModel(agents,maxVisible) overflow aggregation
│   ├── footer.ts           # AgentFooter component (widget factory)
│   ├── grid.ts             # Grid component (overlay): layout+focus+keys+pagination+edges
│   ├── grid-cell.ts        # GridCell component
│   └── agent-detail.ts     # Full-screen drill view (Enter)
├── components/
│   ├── spinner.ts          # Spinner (wall-clock braille frames)
│   ├── progress-bar.ts     # ProgressBar(value,max,width)
│   ├── diff-view.ts        # DiffView (added/removed/context, theme diff tokens)
│   └── table.ts            # Table (column-aligned; no pi Table primitive exists)
├── index.ts                # MODIFY: re-export the Phase 5 surface
└── __tests__/
    ├── store.test.ts  coalesce.test.ts  diff.test.ts  grid-layout.test.ts
    ├── footer-model.test.ts  spinner.test.ts  progress-bar.test.ts
    ├── table.test.ts  diff-view.test.ts  footer.test.ts  grid-cell.test.ts
    ├── grid.test.ts  agent-detail.test.ts  index.test.ts

packages/host/src/
├── agents/
│   ├── run-source.ts       # RunSource impl over @spider/db-core (Db + bus, session-filtered)
│   ├── theme-adapter.ts    # piTheme(theme): ThemeAdapter (pi Theme → ThemeAdapter)
│   ├── actions.ts          # AgentActions impl (calls Phase 4 subagents control; toast fallback)
│   └── agents-ui.ts        # mount footer widget + Ctrl+G grid shortcut + ticker + shutdown
├── extension.ts            # MODIFY: call installAgentsUI(pi, ctx) on session_start
└── __tests__/
    ├── run-source.test.ts  agents-ui.test.ts
```

---

## Interfaces (canonical for this phase — define once, reuse verbatim)

```ts
// @spider/ui/agents/types.ts

// Mirrors runs.status (README canonical): queued|running|paused|done|error|interrupted
export type AgentStatus = "queued" | "running" | "paused" | "done" | "error" | "interrupted";

// One row of the `runs` table (column names verbatim from README canonical schema).
export interface RunRow {
  id: string;
  session_id: string;
  parent_run_id?: string | null;
  agent: string;
  role?: string | null;
  name?: string | null;
  status: AgentStatus;
  phase?: string | null;
  model?: string | null;
  task?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  step_count: number;
  token_count: number;
  result?: string | null;
}

// Projected, render-ready view of one agent.
export interface AgentSnapshot {
  runId: string;
  parentRunId?: string;
  name: string;          // self-name ?? role ?? agent
  role?: string;
  status: AgentStatus;
  phase?: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  activity?: string;     // latest tool/summary (current activity)
  activityTool?: string; // latest tool name
  stepCount: number;
  tokenCount: number;
  recentActivity: string[]; // tail of run_events summaries (cap 5, newest last)
}

// A pipeline handoff (worker→reviewer / next-phase auto-wake).
export interface HandoffEdge { from: string; to: string; phase?: string; ts: number; }

// The db read surface the store consumes (host implements over @spider/db-core).
import type { RunEvent } from "@spider/db-core";
export interface RunSource {
  listActive(): RunRow[];                         // runs for this session not older than retention
  getRun(runId: string): RunRow | undefined;      // single indexed lookup
  subscribe(fn: (e: RunEvent) => void): () => void; // bus.on filtered to this session
}

// The control surface the grid/detail invoke (host implements over Phase 4 subagents runtime).
export interface AgentActions {
  message(runId: string): void | Promise<void>;   // m — message/wake
  interrupt(runId: string): void | Promise<void>; // i
  resume(runId: string): void | Promise<void>;    // r
  follow(runId: string): void;                     // f — pin/follow (UI-local)
}

// Decouples components from pi's concrete Theme; host builds this from pi Theme.
export interface ThemeAdapter {
  fg(token: string, s: string): string;
  bg(token: string, s: string): string;
  bold(s: string): string;
  glyph: string; // "🕸"
}

export interface FooterModel {
  visible: AgentSnapshot[];
  overflow?: {
    running: number; queued: number; paused: number; done: number; error: number;
    hidden: number; // agents.length - visible.length
  };
}

export interface GridLayout {
  rows: number; cols: number; perPage: number; pages: number; page: number;
}

export interface LineChange { index: number; line: string; }
export interface LineDiff { changed: LineChange[]; removedFrom?: number; lengthChanged: boolean; }
```

Status glyph vocabulary (single source, used everywhere): `queued ○` · `running` (spinner frame, `accent`) · `paused ■` · `done ✓` (`success`) · `error ✗` (`error`) · `interrupted ⚠` (`warning`).

---

## Task 1: Agent types + interface surface

**Files:**
- Create: `packages/ui/src/agents/types.ts`
- Test: `packages/ui/src/__tests__/index.test.ts` (extended in Task 15; here just compile)

**Interfaces:**
- Consumes: `RunEvent` from `@spider/db-core`.
- Produces: every type in the Interfaces block above, plus `STATUS_GLYPH: Record<AgentStatus,string>` and `statusToken(status): string` (semantic theme token per status).

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/types.test.ts
import { describe, it, expect } from "vitest";
import { STATUS_GLYPH, statusToken } from "../agents/types.js";

describe("agent status vocabulary", () => {
  it("has a glyph for every status", () => {
    for (const s of ["queued","running","paused","done","error","interrupted"] as const) {
      expect(typeof STATUS_GLYPH[s]).toBe("string");
      expect(STATUS_GLYPH[s].length).toBeGreaterThan(0);
    }
  });
  it("maps status to a semantic theme token", () => {
    expect(statusToken("done")).toBe("success");
    expect(statusToken("error")).toBe("error");
    expect(statusToken("interrupted")).toBe("warning");
    expect(statusToken("running")).toBe("accent");
    expect(statusToken("queued")).toBe("muted");
    expect(statusToken("paused")).toBe("muted");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/types.test.ts`
Expected: FAIL — `Cannot find module '../agents/types.js'`.

- [ ] **Step 3: Write the types module**

```ts
// packages/ui/src/agents/types.ts
import type { RunEvent } from "@spider/db-core";

export type AgentStatus = "queued" | "running" | "paused" | "done" | "error" | "interrupted";

export interface RunRow {
  id: string; session_id: string; parent_run_id?: string | null;
  agent: string; role?: string | null; name?: string | null;
  status: AgentStatus; phase?: string | null; model?: string | null; task?: string | null;
  started_at?: number | null; ended_at?: number | null;
  step_count: number; token_count: number; result?: string | null;
}

export interface AgentSnapshot {
  runId: string; parentRunId?: string; name: string; role?: string;
  status: AgentStatus; phase?: string; model?: string;
  startedAt?: number; endedAt?: number;
  activity?: string; activityTool?: string;
  stepCount: number; tokenCount: number; recentActivity: string[];
}

export interface HandoffEdge { from: string; to: string; phase?: string; ts: number; }

export interface RunSource {
  listActive(): RunRow[];
  getRun(runId: string): RunRow | undefined;
  subscribe(fn: (e: RunEvent) => void): () => void;
}

export interface AgentActions {
  message(runId: string): void | Promise<void>;
  interrupt(runId: string): void | Promise<void>;
  resume(runId: string): void | Promise<void>;
  follow(runId: string): void;
}

export interface ThemeAdapter {
  fg(token: string, s: string): string;
  bg(token: string, s: string): string;
  bold(s: string): string;
  glyph: string;
}

export interface FooterModel {
  visible: AgentSnapshot[];
  overflow?: {
    running: number; queued: number; paused: number; done: number; error: number; hidden: number;
  };
}
export interface GridLayout { rows: number; cols: number; perPage: number; pages: number; page: number; }
export interface LineChange { index: number; line: string; }
export interface LineDiff { changed: LineChange[]; removedFrom?: number; lengthChanged: boolean; }

export const STATUS_GLYPH: Record<AgentStatus, string> = {
  queued: "○", running: "◆", paused: "■", done: "✓", error: "✗", interrupted: "⚠",
};

export function statusToken(status: AgentStatus): string {
  switch (status) {
    case "done": return "success";
    case "error": return "error";
    case "interrupted": return "warning";
    case "running": return "accent";
    default: return "muted"; // queued | paused
  }
}

export type { RunEvent };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/agents/types.ts packages/ui/src/__tests__/types.test.ts
git commit -m "feat(ui): agent UI types + status glyph/token vocabulary"
```

---

## Task 2: AgentStore reducer + subscription projection

**Files:**
- Create: `packages/ui/src/agents/store.ts`
- Test: `packages/ui/src/__tests__/store.test.ts`

**Interfaces:**
- Consumes: `RunSource`, `RunRow`, `RunEvent`, `AgentSnapshot`, `HandoffEdge`.
- Produces: `projectRow(row): AgentSnapshot`; `applyEvent(snap, e): AgentSnapshot` (activity/tail from a `run_events` row); `class AgentStore` with `.snapshot(): AgentSnapshot[]`, `.edges(): HandoffEdge[]`, `.onChange(fn): () => void`, `.start()`, `.stop()`, `.hasRunning(): boolean`.

Reducer rules (pure, event-triggered — NOT polling):
- On any `RunEvent` for a known/active run: append activity from the event (`type:"tool_intent"` → `activity`/`activityTool`; `type:"tool_result"`/`"status"`/`"log"` → push `summary` to `recentActivity` capped at 5), then re-read the authoritative `runs` row via `RunSource.getRun` to refresh `status`/`step_count`/`token_count`/`phase`/`ended_at`. `type:"handoff"` → push a `HandoffEdge` from `payload {from,to,phase}`.
- Retention: keep `done`/`error`/`interrupted` runs visible for `RETENTION_MS = 10_000`, then drop on the next change.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/store.test.ts
import { describe, it, expect, vi } from "vitest";
import { AgentStore, projectRow } from "../agents/store.js";
import type { RunRow, RunSource, RunEvent } from "../agents/types.js";

function row(over: Partial<RunRow>): RunRow {
  return { id: "r1", session_id: "s", agent: "worker", status: "running",
    step_count: 0, token_count: 0, ...over };
}

class FakeSource implements RunSource {
  rows = new Map<string, RunRow>();
  private fn?: (e: RunEvent) => void;
  listActive() { return [...this.rows.values()]; }
  getRun(id: string) { return this.rows.get(id); }
  subscribe(fn: (e: RunEvent) => void) { this.fn = fn; return () => { this.fn = undefined; }; }
  emit(e: RunEvent) { this.fn?.(e); }
}

describe("projectRow", () => {
  it("prefers self-name then role then agent", () => {
    expect(projectRow(row({ name: "scribe" })).name).toBe("scribe");
    expect(projectRow(row({ name: null, role: "reviewer" })).name).toBe("reviewer");
    expect(projectRow(row({ name: null, role: null, agent: "worker" })).name).toBe("worker");
  });
});

describe("AgentStore", () => {
  it("seeds from listActive on start", () => {
    const src = new FakeSource();
    src.rows.set("r1", row({ id: "r1" }));
    const store = new AgentStore(src);
    store.start();
    expect(store.snapshot().map(a => a.runId)).toEqual(["r1"]);
    store.stop();
  });

  it("updates activity + counts on a bus event and notifies once", () => {
    const src = new FakeSource();
    src.rows.set("r1", row({ id: "r1", step_count: 1, token_count: 10 }));
    const store = new AgentStore(src);
    const spy = vi.fn();
    store.onChange(spy);
    store.start();
    src.rows.set("r1", row({ id: "r1", step_count: 2, token_count: 25 }));
    src.emit({ runId: "r1", sessionId: "s", ts: 1, type: "tool_intent", tool: "bash", summary: "ls" });
    const a = store.snapshot()[0];
    expect(a.activityTool).toBe("bash");
    expect(a.stepCount).toBe(2);
    expect(a.tokenCount).toBe(25);
    expect(spy).toHaveBeenCalled();
    store.stop();
  });

  it("records handoff edges (pipeline-aware)", () => {
    const src = new FakeSource();
    src.rows.set("r1", row({ id: "r1" }));
    const store = new AgentStore(src);
    store.start();
    src.emit({ runId: "r1", sessionId: "s", ts: 2, type: "handoff",
      payload: { from: "r1", to: "r2", phase: "review" } });
    expect(store.edges()).toEqual([{ from: "r1", to: "r2", phase: "review", ts: 2 }]);
    store.stop();
  });

  it("hasRunning reflects any running agent", () => {
    const src = new FakeSource();
    src.rows.set("r1", row({ id: "r1", status: "done", ended_at: Date.now() }));
    const store = new AgentStore(src);
    store.start();
    expect(store.hasRunning()).toBe(false);
    store.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/store.test.ts`
Expected: FAIL — `Cannot find module '../agents/store.js'`.

- [ ] **Step 3: Write the store**

```ts
// packages/ui/src/agents/store.ts
import type { AgentSnapshot, HandoffEdge, RunEvent, RunRow, RunSource } from "./types.js";

const RETENTION_MS = 10_000;
const TAIL_CAP = 5;

export function projectRow(row: RunRow): AgentSnapshot {
  return {
    runId: row.id,
    parentRunId: row.parent_run_id ?? undefined,
    name: row.name ?? row.role ?? row.agent,
    role: row.role ?? undefined,
    status: row.status,
    phase: row.phase ?? undefined,
    model: row.model ?? undefined,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    stepCount: row.step_count ?? 0,
    tokenCount: row.token_count ?? 0,
    recentActivity: [],
  };
}

export function applyEvent(snap: AgentSnapshot, e: RunEvent): AgentSnapshot {
  const next = { ...snap, recentActivity: [...snap.recentActivity] };
  if (e.type === "tool_intent") {
    next.activityTool = e.tool ?? next.activityTool;
    next.activity = e.summary ?? e.tool ?? next.activity;
  } else if (e.summary) {
    next.recentActivity.push(e.summary);
    if (next.recentActivity.length > TAIL_CAP) next.recentActivity.shift();
    next.activity = e.summary;
  }
  return next;
}

type Listener = () => void;

export class AgentStore {
  private agents = new Map<string, AgentSnapshot>();
  private handoffs: HandoffEdge[] = [];
  private listeners = new Set<Listener>();
  private off?: () => void;
  private now: () => number;

  constructor(private src: RunSource, now: () => number = Date.now) { this.now = now; }

  start(): void {
    for (const row of this.src.listActive()) this.agents.set(row.id, projectRow(row));
    this.off = this.src.subscribe((e) => this.ingest(e));
  }

  stop(): void { this.off?.(); this.off = undefined; }

  onChange(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  snapshot(): AgentSnapshot[] {
    this.evict();
    return [...this.agents.values()];
  }

  edges(): HandoffEdge[] { return this.handoffs; }

  hasRunning(): boolean {
    for (const a of this.agents.values()) if (a.status === "running" || a.status === "queued") return true;
    return false;
  }

  private ingest(e: RunEvent): void {
    if (e.type === "handoff" && e.payload && typeof e.payload === "object") {
      const p = e.payload as { from?: string; to?: string; phase?: string };
      if (p.from && p.to) this.handoffs.push({ from: p.from, to: p.to, phase: p.phase, ts: e.ts });
    }
    const id = e.runId;
    if (id) {
      const existing = this.agents.get(id);
      const merged = existing ? applyEvent(existing, e) : undefined;
      const row = this.src.getRun(id);
      if (row) {
        const base = row ? projectRow(row) : undefined;
        if (base) {
          base.activity = merged?.activity ?? base.activity;
          base.activityTool = merged?.activityTool ?? base.activityTool;
          base.recentActivity = merged?.recentActivity ?? [];
          this.agents.set(id, base);
        }
      } else if (merged) {
        this.agents.set(id, merged);
      }
    }
    this.emit();
  }

  private evict(): void {
    const cutoff = this.now() - RETENTION_MS;
    for (const [id, a] of this.agents) {
      const finished = a.status === "done" || a.status === "error" || a.status === "interrupted";
      if (finished && a.endedAt !== undefined && a.endedAt < cutoff) this.agents.delete(id);
    }
  }

  private emit(): void { for (const fn of this.listeners) { try { fn(); } catch { /* isolate */ } } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/agents/store.ts packages/ui/src/__tests__/store.test.ts
git commit -m "feat(ui): AgentStore — event-driven runs/run_events projection (no polling)"
```

---

## Task 3: FrameScheduler (coalescing)

**Files:**
- Create: `packages/ui/src/agents/coalesce.ts`
- Test: `packages/ui/src/__tests__/coalesce.test.ts`

**Interfaces:**
- Consumes: nothing (injectable `schedule`/`cancel` timer + `flush` callback).
- Produces: `class FrameScheduler` with `.request()` (coalesce a frame), `.dispose()`; constructor `(flush: () => void, opts?: { frameMs?: number; schedule?; cancel? })`. Default `frameMs = 24` (~16–33 ms window). Multiple `.request()` calls inside one window collapse to a single `flush`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/coalesce.test.ts
import { describe, it, expect, vi } from "vitest";
import { FrameScheduler } from "../agents/coalesce.js";

describe("FrameScheduler", () => {
  it("collapses many requests in one window into a single flush", () => {
    let cb: (() => void) | undefined;
    const schedule = vi.fn((fn: () => void) => { cb = fn; return 1 as unknown as ReturnType<typeof setTimeout>; });
    const cancel = vi.fn();
    const flush = vi.fn();
    const s = new FrameScheduler(flush, { frameMs: 24, schedule, cancel });
    s.request(); s.request(); s.request();
    expect(schedule).toHaveBeenCalledTimes(1);
    cb!();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("schedules a fresh frame after the previous one fired", () => {
    let cb: (() => void) | undefined;
    const schedule = vi.fn((fn: () => void) => { cb = fn; return 1 as unknown as ReturnType<typeof setTimeout>; });
    const s = new FrameScheduler(() => {}, { schedule, cancel: () => {} });
    s.request(); cb!();      // frame 1 fired
    s.request();             // must schedule again
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it("dispose cancels a pending frame", () => {
    const cancel = vi.fn();
    const s = new FrameScheduler(() => {}, { schedule: () => 7 as unknown as ReturnType<typeof setTimeout>, cancel });
    s.request();
    s.dispose();
    expect(cancel).toHaveBeenCalledWith(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/coalesce.test.ts`
Expected: FAIL — `Cannot find module '../agents/coalesce.js'`.

- [ ] **Step 3: Write the scheduler**

```ts
// packages/ui/src/agents/coalesce.ts
type Timer = ReturnType<typeof setTimeout>;
interface Opts {
  frameMs?: number;
  schedule?: (fn: () => void, ms: number) => Timer;
  cancel?: (t: Timer) => void;
}

export class FrameScheduler {
  private frameMs: number;
  private schedule: (fn: () => void, ms: number) => Timer;
  private cancel: (t: Timer) => void;
  private pending: Timer | null = null;

  constructor(private flush: () => void, opts: Opts = {}) {
    this.frameMs = opts.frameMs ?? 24;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((t) => clearTimeout(t));
  }

  request(): void {
    if (this.pending !== null) return; // already a frame in flight → coalesce
    this.pending = this.schedule(() => {
      this.pending = null;
      this.flush();
    }, this.frameMs);
    // Best-effort: don't hold the event loop open for a UI frame.
    (this.pending as unknown as { unref?: () => void }).unref?.();
  }

  dispose(): void {
    if (this.pending !== null) { this.cancel(this.pending); this.pending = null; }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/coalesce.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/agents/coalesce.ts packages/ui/src/__tests__/coalesce.test.ts
git commit -m "feat(ui): FrameScheduler — coalesce store notifications into ~24ms frames"
```

---

## Task 4: Line-diff engine

**Files:**
- Create: `packages/ui/src/agents/diff.ts`
- Test: `packages/ui/src/__tests__/diff.test.ts`

**Interfaces:**
- Consumes: `LineChange`, `LineDiff`.
- Produces: `diffLines(prev, next): LineDiff`, `hasChanges(d): boolean`. `changed` lists indices where `next[i] !== prev[i]` (including new indices beyond `prev.length`); `removedFrom` set when `next` shorter; `lengthChanged` when lengths differ.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/diff.test.ts
import { describe, it, expect } from "vitest";
import { diffLines, hasChanges } from "../agents/diff.js";

describe("diffLines", () => {
  it("reports no change for identical arrays", () => {
    const d = diffLines(["a","b"], ["a","b"]);
    expect(d.changed).toEqual([]);
    expect(d.lengthChanged).toBe(false);
    expect(hasChanges(d)).toBe(false);
  });
  it("reports only changed indices", () => {
    const d = diffLines(["a","b","c"], ["a","B","c"]);
    expect(d.changed).toEqual([{ index: 1, line: "B" }]);
    expect(hasChanges(d)).toBe(true);
  });
  it("reports appended lines", () => {
    const d = diffLines(["a"], ["a","b"]);
    expect(d.changed).toEqual([{ index: 1, line: "b" }]);
    expect(d.lengthChanged).toBe(true);
  });
  it("reports removed tail", () => {
    const d = diffLines(["a","b","c"], ["a"]);
    expect(d.removedFrom).toBe(1);
    expect(d.lengthChanged).toBe(true);
    expect(hasChanges(d)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/diff.test.ts`
Expected: FAIL — `Cannot find module '../agents/diff.js'`.

- [ ] **Step 3: Write the diff engine**

```ts
// packages/ui/src/agents/diff.ts
import type { LineChange, LineDiff } from "./types.js";

export function diffLines(prev: string[], next: string[]): LineDiff {
  const changed: LineChange[] = [];
  for (let i = 0; i < next.length; i++) {
    if (prev[i] !== next[i]) changed.push({ index: i, line: next[i] });
  }
  const lengthChanged = prev.length !== next.length;
  const removedFrom = next.length < prev.length ? next.length : undefined;
  return { changed, removedFrom, lengthChanged };
}

export function hasChanges(d: LineDiff): boolean {
  return d.changed.length > 0 || d.removedFrom !== undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/diff.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/agents/diff.ts packages/ui/src/__tests__/diff.test.ts
git commit -m "feat(ui): line-diff engine (replaces JSON.stringify change-detect gate)"
```

---

## Task 5: Grid layout math

**Files:**
- Create: `packages/ui/src/agents/grid-layout.ts`
- Test: `packages/ui/src/__tests__/grid-layout.test.ts`

**Interfaces:**
- Consumes: `GridLayout`.
- Produces: `layoutGrid(count, page = 0): GridLayout`. Tiers (from spec): `1→1×1`, `2→1×2`, `3–4→2×2`, `5–9→3×3`, `10–16→4×4`, `>16→4×4 paginated` (16 per page). `pages = ceil(count / perPage)`; `page` clamped to `[0, pages-1]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/grid-layout.test.ts
import { describe, it, expect } from "vitest";
import { layoutGrid } from "../agents/grid-layout.js";

describe("layoutGrid", () => {
  it("1 → 1x1 full", () => expect(layoutGrid(1)).toMatchObject({ rows: 1, cols: 1, perPage: 1, pages: 1 }));
  it("2 → 1x2", () => expect(layoutGrid(2)).toMatchObject({ rows: 1, cols: 2, perPage: 2, pages: 1 }));
  it("3 → 2x2", () => expect(layoutGrid(3)).toMatchObject({ rows: 2, cols: 2, perPage: 4, pages: 1 }));
  it("4 → 2x2", () => expect(layoutGrid(4)).toMatchObject({ rows: 2, cols: 2, perPage: 4 }));
  it("9 → 3x3", () => expect(layoutGrid(9)).toMatchObject({ rows: 3, cols: 3, perPage: 9, pages: 1 }));
  it("16 → 4x4 single page", () => expect(layoutGrid(16)).toMatchObject({ rows: 4, cols: 4, perPage: 16, pages: 1 }));
  it("17 → 4x4 paginated (2 pages)", () => expect(layoutGrid(17)).toMatchObject({ rows: 4, cols: 4, perPage: 16, pages: 2 }));
  it("clamps page into range", () => expect(layoutGrid(17, 99).page).toBe(1));
  it("0 → empty", () => expect(layoutGrid(0)).toMatchObject({ rows: 0, cols: 0, pages: 1 }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/grid-layout.test.ts`
Expected: FAIL — `Cannot find module '../agents/grid-layout.js'`.

- [ ] **Step 3: Write the layout math**

```ts
// packages/ui/src/agents/grid-layout.ts
import type { GridLayout } from "./types.js";

export function layoutGrid(count: number, page = 0): GridLayout {
  if (count <= 0) return { rows: 0, cols: 0, perPage: 0, pages: 1, page: 0 };
  let rows: number, cols: number;
  if (count === 1) { rows = 1; cols = 1; }
  else if (count === 2) { rows = 1; cols = 2; }
  else if (count <= 4) { rows = 2; cols = 2; }
  else if (count <= 9) { rows = 3; cols = 3; }
  else { rows = 4; cols = 4; } // 10–16 and paginated beyond
  const perPage = rows * cols;
  const pages = Math.max(1, Math.ceil(count / perPage));
  const clamped = Math.min(Math.max(0, page), pages - 1);
  return { rows, cols, perPage, pages, page: clamped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/grid-layout.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/agents/grid-layout.ts packages/ui/src/__tests__/grid-layout.test.ts
git commit -m "feat(ui): grid layout tier + pagination math"
```

---

## Task 6: Footer overflow aggregation

**Files:**
- Create: `packages/ui/src/agents/footer-model.ts`
- Test: `packages/ui/src/__tests__/footer-model.test.ts`

**Interfaces:**
- Consumes: `AgentSnapshot`, `FooterModel`.
- Produces: `buildFooterModel(agents, maxVisible = 4): FooterModel`. Sort priority: `running` → `queued` → `paused` → recently `done`/`error`/`interrupted` (by `endedAt` desc). Show up to `maxVisible`; when `agents.length > maxVisible`, populate `overflow` with per-status totals across ALL agents plus `hidden = agents.length - visible.length`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/footer-model.test.ts
import { describe, it, expect } from "vitest";
import { buildFooterModel } from "../agents/footer-model.js";
import type { AgentSnapshot, AgentStatus } from "../agents/types.js";

function a(runId: string, status: AgentStatus, endedAt?: number): AgentSnapshot {
  return { runId, name: runId, status, stepCount: 0, tokenCount: 0, recentActivity: [], endedAt };
}

describe("buildFooterModel", () => {
  it("no overflow when within maxVisible", () => {
    const m = buildFooterModel([a("1","running"), a("2","done",1)], 4);
    expect(m.visible).toHaveLength(2);
    expect(m.overflow).toBeUndefined();
  });
  it("prioritizes running over done", () => {
    const m = buildFooterModel([a("d","done",1), a("r","running")], 4);
    expect(m.visible[0].runId).toBe("r");
  });
  it("aggregates overflow beyond maxVisible", () => {
    const agents = [
      a("1","running"), a("2","running"), a("3","running"), a("4","running"),
      a("5","done",2), a("6","done",3), a("7","error",4),
    ];
    const m = buildFooterModel(agents, 4);
    expect(m.visible).toHaveLength(4);
    expect(m.overflow).toMatchObject({ running: 4, done: 2, error: 1, hidden: 3 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/footer-model.test.ts`
Expected: FAIL — `Cannot find module '../agents/footer-model.js'`.

- [ ] **Step 3: Write the aggregator**

```ts
// packages/ui/src/agents/footer-model.ts
import type { AgentSnapshot, AgentStatus, FooterModel } from "./types.js";

const PRIORITY: Record<AgentStatus, number> = {
  running: 0, queued: 1, paused: 2, error: 3, interrupted: 3, done: 4,
};

export function buildFooterModel(agents: AgentSnapshot[], maxVisible = 4): FooterModel {
  const sorted = [...agents].sort((x, y) => {
    const p = PRIORITY[x.status] - PRIORITY[y.status];
    if (p !== 0) return p;
    return (y.endedAt ?? y.startedAt ?? 0) - (x.endedAt ?? x.startedAt ?? 0);
  });
  const visible = sorted.slice(0, maxVisible);
  if (agents.length <= maxVisible) return { visible };
  const counts = { running: 0, queued: 0, paused: 0, done: 0, error: 0 };
  for (const g of agents) {
    if (g.status === "interrupted") counts.error++;
    else counts[g.status]++;
  }
  return { visible, overflow: { ...counts, hidden: agents.length - visible.length } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/footer-model.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/agents/footer-model.ts packages/ui/src/__tests__/footer-model.test.ts
git commit -m "feat(ui): footer overflow aggregation (▸ N running · N done · +N more)"
```

---

## Task 7: Spinner (wall-clock animation)

**Files:**
- Create: `packages/ui/src/components/spinner.ts`
- Test: `packages/ui/src/__tests__/spinner.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class Spinner` with `.frame(now?: number): string` (braille frame chosen by wall-clock, NOT data-seeded), constructor `(opts?: { frames?: string[]; intervalMs?: number })`. Default braille frames, `intervalMs = 100`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/spinner.test.ts
import { describe, it, expect } from "vitest";
import { Spinner, BRAILLE_FRAMES } from "../components/spinner.js";

describe("Spinner", () => {
  it("advances by wall-clock, not by call count", () => {
    const s = new Spinner({ intervalMs: 100 });
    expect(s.frame(0)).toBe(BRAILLE_FRAMES[0]);
    expect(s.frame(0)).toBe(BRAILLE_FRAMES[0]);   // same time → same frame (time-driven)
    expect(s.frame(100)).toBe(BRAILLE_FRAMES[1]);
    expect(s.frame(100 * BRAILLE_FRAMES.length)).toBe(BRAILLE_FRAMES[0]); // wraps
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/spinner.test.ts`
Expected: FAIL — `Cannot find module '../components/spinner.js'`.

- [ ] **Step 3: Write the spinner**

```ts
// packages/ui/src/components/spinner.ts
export const BRAILLE_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

export class Spinner {
  private frames: string[];
  private intervalMs: number;
  constructor(opts: { frames?: string[]; intervalMs?: number } = {}) {
    this.frames = opts.frames ?? BRAILLE_FRAMES;
    this.intervalMs = opts.intervalMs ?? 100;
  }
  frame(now: number = Date.now()): string {
    const i = Math.floor(now / this.intervalMs) % this.frames.length;
    return this.frames[i];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/spinner.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/spinner.ts packages/ui/src/__tests__/spinner.test.ts
git commit -m "feat(ui): Spinner — wall-clock braille frames (fixes data-seeded stutter)"
```

---

## Task 8: ProgressBar

**Files:**
- Create: `packages/ui/src/components/progress-bar.ts`
- Test: `packages/ui/src/__tests__/progress-bar.test.ts`

**Interfaces:**
- Consumes: `ThemeAdapter`.
- Produces: `renderProgressBar(theme, opts): string` where `opts = { value: number; max: number; width: number; filled?: string; empty?: string }`. Never exceeds `width`; clamps ratio to `[0,1]`; guards `width < 1` → `""`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/progress-bar.test.ts
import { describe, it, expect } from "vitest";
import { renderProgressBar } from "../components/progress-bar.js";
import type { ThemeAdapter } from "../agents/types.js";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("renderProgressBar", () => {
  it("fills proportionally and respects width", () => {
    const bar = renderProgressBar(id, { value: 5, max: 10, width: 10, filled: "#", empty: "-" });
    expect(bar).toBe("#####-----");
    expect(bar.length).toBe(10);
  });
  it("clamps overflow and underflow", () => {
    expect(renderProgressBar(id, { value: 20, max: 10, width: 4, filled: "#", empty: "-" })).toBe("####");
    expect(renderProgressBar(id, { value: -3, max: 10, width: 4, filled: "#", empty: "-" })).toBe("----");
  });
  it("guards tiny width", () => {
    expect(renderProgressBar(id, { value: 1, max: 2, width: 0 })).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/progress-bar.test.ts`
Expected: FAIL — `Cannot find module '../components/progress-bar.js'`.

- [ ] **Step 3: Write the progress bar**

```ts
// packages/ui/src/components/progress-bar.ts
import type { ThemeAdapter } from "../agents/types.js";

export function renderProgressBar(
  theme: ThemeAdapter,
  opts: { value: number; max: number; width: number; filled?: string; empty?: string },
): string {
  const { value, max, width } = opts;
  if (width < 1) return "";
  const filled = opts.filled ?? "█";
  const empty = opts.empty ?? "░";
  const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  const n = Math.round(ratio * width);
  return theme.fg("accent", filled.repeat(n)) + theme.fg("muted", empty.repeat(width - n));
}
```

Note: the ANSI-wrapped return can exceed `width` in *bytes* but not in *visible* width; callers embedding it in a fixed cell must budget by `visibleWidth`. The identity-theme test asserts visible width because `fg` is identity.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/progress-bar.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/progress-bar.ts packages/ui/src/__tests__/progress-bar.test.ts
git commit -m "feat(ui): ProgressBar"
```

---

## Task 9: Table (column-aligned)

**Files:**
- Create: `packages/ui/src/components/table.ts`
- Test: `packages/ui/src/__tests__/table.test.ts`

**Interfaces:**
- Consumes: `ThemeAdapter`; pi-tui `visibleWidth`/`truncateToWidth` (imported lazily so headless tests pass — pass identity theme, and re-implement a tiny `vwidth` fallback guarded by try/catch is NOT needed; import from peer at top is fine because pi-tui is resolvable in the workspace).
- Produces: `renderTable(theme, opts): string[]` where `opts = { columns: { header: string; align?: "left"|"right"; token?: string }[]; rows: string[][]; width: number }`. Computes column widths, right-aligns numeric columns, truncates the last/over-budget column, every line `≤ width`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/table.test.ts
import { describe, it, expect } from "vitest";
import { renderTable } from "../components/table.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("renderTable", () => {
  it("aligns columns and never exceeds width", () => {
    const lines = renderTable(id, {
      columns: [{ header: "name" }, { header: "tok", align: "right" }],
      rows: [["worker", "1200"], ["reviewer", "42"]],
      width: 24,
    });
    expect(lines.length).toBe(3); // header + 2 rows
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(24);
    expect(lines[1]).toContain("worker");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/table.test.ts`
Expected: FAIL — `Cannot find module '../components/table.js'`.

- [ ] **Step 3: Write the table**

```ts
// packages/ui/src/components/table.ts
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";

interface Col { header: string; align?: "left" | "right"; token?: string }

export function renderTable(
  theme: ThemeAdapter,
  opts: { columns: Col[]; rows: string[][]; width: number },
): string[] {
  const { columns, rows, width } = opts;
  const nCols = columns.length;
  const raw = [columns.map((c) => c.header), ...rows];
  const colW = new Array(nCols).fill(0);
  for (const r of raw) for (let i = 0; i < nCols; i++) colW[i] = Math.max(colW[i], visibleWidth(r[i] ?? ""));

  // Shrink columns right-to-left to fit width (gap = 1 space between columns).
  const gap = 1;
  let total = colW.reduce((s, w) => s + w, 0) + gap * (nCols - 1);
  for (let i = nCols - 1; i >= 0 && total > width; i--) {
    const over = total - width;
    const shrink = Math.min(over, colW[i]);
    colW[i] -= shrink; total -= shrink;
  }

  const pad = (s: string, w: number, align?: "left" | "right"): string => {
    const t = truncateToWidth(s, w, "");
    const fill = " ".repeat(Math.max(0, w - visibleWidth(t)));
    return align === "right" ? fill + t : t + fill;
  };

  return raw.map((r, ri) =>
    truncateToWidth(
      columns.map((c, i) => {
        const cell = pad(r[i] ?? "", colW[i], c.align);
        if (ri === 0) return theme.fg("muted", cell);
        return c.token ? theme.fg(c.token, cell) : cell;
      }).join(" ".repeat(gap)),
      width,
    ),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/table.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/table.ts packages/ui/src/__tests__/table.test.ts
git commit -m "feat(ui): Table — column-aligned rows (no pi Table primitive)"
```

---

## Task 10: DiffView

**Files:**
- Create: `packages/ui/src/components/diff-view.ts`
- Test: `packages/ui/src/__tests__/diff-view.test.ts`

**Interfaces:**
- Consumes: `ThemeAdapter`; `truncateToWidth`.
- Produces: `renderDiffView(theme, opts): string[]` where `opts = { hunks: { kind: "add"|"remove"|"context"; text: string }[]; width: number; maxLines?: number }`. Uses tokens `toolDiffAdded`/`toolDiffRemoved`/`toolDiffContext`, prefixes `+`/`-`/` `; collapses to `maxLines` with `… N more`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/diff-view.test.ts
import { describe, it, expect } from "vitest";
import { renderDiffView } from "../components/diff-view.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("renderDiffView", () => {
  it("prefixes +/-/space and respects width", () => {
    const lines = renderDiffView(id, {
      hunks: [{ kind: "add", text: "new" }, { kind: "remove", text: "old" }, { kind: "context", text: "ctx" }],
      width: 20,
    });
    expect(lines[0]).toBe("+new");
    expect(lines[1]).toBe("-old");
    expect(lines[2]).toBe(" ctx");
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(20);
  });
  it("collapses to maxLines with a more-indicator", () => {
    const hunks = Array.from({ length: 8 }, (_, i) => ({ kind: "add" as const, text: `l${i}` }));
    const lines = renderDiffView(id, { hunks, width: 20, maxLines: 3 });
    expect(lines).toHaveLength(4); // 3 + summary
    expect(lines[3]).toContain("5 more");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/diff-view.test.ts`
Expected: FAIL — `Cannot find module '../components/diff-view.js'`.

- [ ] **Step 3: Write the diff view**

```ts
// packages/ui/src/components/diff-view.ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";

interface Hunk { kind: "add" | "remove" | "context"; text: string }
const PREFIX = { add: "+", remove: "-", context: " " } as const;
const TOKEN = { add: "toolDiffAdded", remove: "toolDiffRemoved", context: "toolDiffContext" } as const;

export function renderDiffView(
  theme: ThemeAdapter,
  opts: { hunks: Hunk[]; width: number; maxLines?: number },
): string[] {
  const { hunks, width } = opts;
  const max = opts.maxLines ?? hunks.length;
  const shown = hunks.slice(0, max);
  const lines = shown.map((h) => {
    const raw = truncateToWidth(PREFIX[h.kind] + h.text, width, "");
    return theme.fg(TOKEN[h.kind], raw);
  });
  const rest = hunks.length - shown.length;
  if (rest > 0) lines.push(theme.fg("muted", truncateToWidth(`… ${rest} more`, width, "")));
  return lines;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/diff-view.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/diff-view.ts packages/ui/src/__tests__/diff-view.test.ts
git commit -m "feat(ui): DiffView — themed +/-/context hunks with collapse"
```

---

## Task 11: AgentFooter component

**Files:**
- Create: `packages/ui/src/agents/footer.ts`
- Test: `packages/ui/src/__tests__/footer.test.ts`

**Interfaces:**
- Consumes: `AgentStore`, `ThemeAdapter`, `Spinner`, `buildFooterModel`, `diffLines`/`hasChanges`, `STATUS_GLYPH`/`statusToken`, `truncateToWidth`/`visibleWidth`.
- Produces: `class AgentFooter implements Component` with `render(width): string[]`, `invalidate()`, and `hasVisibleChange(width): boolean` (recompute lines, diff vs cache, update cache, return `hasChanges`). Constructor `(store, theme, opts?: { maxVisible?: number; now?: () => number; spinner?: Spinner })`. Line format per agent: `<statusGlyph/spinner> <🕸 name/role> <elapsed> · <activity> · <steps>/<tokens>`; overflow line `▸ N running · N done · +N more`; the header/first line carries the 🕸 signature. Returns `[]` when zero agents (footer hidden at zero).

Elapsed = `formatDuration(now - startedAt)` for running, `(endedAt - startedAt)` for finished. `hasVisibleChange` is what the host calls each coalesced frame to decide whether to `requestRender` — this replaces the old poll+stringify gate.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/footer.test.ts
import { describe, it, expect } from "vitest";
import { AgentFooter } from "../agents/footer.js";
import { AgentStore } from "../agents/store.js";
import type { RunRow, RunSource, RunEvent, ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };
function row(o: Partial<RunRow>): RunRow {
  return { id: "r1", session_id: "s", agent: "worker", status: "running", step_count: 3, token_count: 120,
    started_at: 0, ...o };
}
class Src implements RunSource {
  rows = new Map<string, RunRow>(); private fn?: (e: RunEvent) => void;
  listActive() { return [...this.rows.values()]; }
  getRun(id: string) { return this.rows.get(id); }
  subscribe(fn: (e: RunEvent) => void) { this.fn = fn; return () => {}; }
  emit(e: RunEvent) { this.fn?.(e); }
}

describe("AgentFooter", () => {
  it("renders empty when no agents", () => {
    const src = new Src(); const store = new AgentStore(src); store.start();
    const f = new AgentFooter(store, id, { now: () => 1000 });
    expect(f.render(40)).toEqual([]);
  });
  it("renders one agent line with glyph, name, steps/tokens, within width", () => {
    const src = new Src(); src.rows.set("r1", row({ name: "scribe" }));
    const store = new AgentStore(src); store.start();
    const f = new AgentFooter(store, id, { now: () => 5000 });
    const lines = f.render(60);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.join("\n")).toContain("🕸");
    expect(lines.join("\n")).toContain("scribe");
    expect(lines.join("\n")).toMatch(/3.*120|120.*3/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });
  it("hasVisibleChange is false when nothing changed between frames", () => {
    const src = new Src(); src.rows.set("r1", row({ name: "scribe" }));
    const store = new AgentStore(src); store.start();
    const f = new AgentFooter(store, id, { now: () => 5000 });
    expect(f.hasVisibleChange(60)).toBe(true);   // first paint
    expect(f.hasVisibleChange(60)).toBe(false);  // no change
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/footer.test.ts`
Expected: FAIL — `Cannot find module '../agents/footer.js'`.

- [ ] **Step 3: Write the footer** (complete file)

```ts
// packages/ui/src/agents/footer.ts
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "../index.js";
import { buildFooterModel } from "./footer-model.js";
import { diffLines, hasChanges } from "./diff.js";
import { Spinner } from "../components/spinner.js";
import { STATUS_GLYPH, statusToken } from "./types.js";
import type { AgentSnapshot, ThemeAdapter } from "./types.js";
import type { AgentStore } from "./store.js";

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export class AgentFooter implements Component {
  private theme: ThemeAdapter;
  private maxVisible: number;
  private now: () => number;
  private spinner: Spinner;
  private cachedWidth?: number;
  private cachedLines: string[] = [];

  constructor(private store: AgentStore, theme: ThemeAdapter,
    opts: { maxVisible?: number; now?: () => number; spinner?: Spinner } = {}) {
    this.theme = theme;
    this.maxVisible = opts.maxVisible ?? 4;
    this.now = opts.now ?? Date.now;
    this.spinner = opts.spinner ?? new Spinner();
  }

  private glyphFor(a: AgentSnapshot): string {
    const g = a.status === "running" ? this.spinner.frame(this.now()) : STATUS_GLYPH[a.status];
    return this.theme.fg(statusToken(a.status), g);
  }

  private agentLine(a: AgentSnapshot, width: number): string {
    const t = this.theme;
    const elapsedMs = a.startedAt === undefined ? 0
      : (a.endedAt ?? this.now()) - a.startedAt;
    const parts = [
      this.glyphFor(a),
      `${t.glyph} ${t.bold(a.name)}`,
      t.fg("muted", formatDuration(elapsedMs)),
    ];
    if (a.activity) parts.push(t.fg("muted", "· " + a.activity));
    parts.push(t.fg("dim", `· ${a.stepCount}⋯${a.tokenCount}t`));
    return truncateToWidth(parts.join(" "), width, "…");
  }

  private build(width: number): string[] {
    const agents = this.store.snapshot();
    if (agents.length === 0) return [];
    const model = buildFooterModel(agents, this.maxVisible);
    const lines = model.visible.map((a) => this.agentLine(a, width));
    if (model.overflow) {
      const o = model.overflow;
      const seg: string[] = [];
      if (o.running) seg.push(`${o.running} running`);
      if (o.done) seg.push(`${o.done} done`);
      if (o.error) seg.push(`${o.error} error`);
      seg.push(`+${o.hidden} more`);
      lines.push(truncateToWidth(this.theme.fg("muted", `${this.theme.glyph} ▸ ` + seg.join(" · ")), width, "…"));
    }
    return lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width, "…") : l));
  }

  hasVisibleChange(width: number): boolean {
    const next = this.build(width);
    const d = diffLines(this.cachedLines, next);
    const changed = this.cachedWidth !== width || hasChanges(d);
    this.cachedLines = next;
    this.cachedWidth = width;
    return changed;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines.length) return this.cachedLines;
    this.cachedLines = this.build(width);
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void { this.cachedWidth = undefined; this.cachedLines = []; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/footer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/agents/footer.ts packages/ui/src/__tests__/footer.test.ts
git commit -m "feat(ui): AgentFooter — diffed, coalesced, spinner-animated agents footer"
```

---

## Task 12: GridCell component

**Files:**
- Create: `packages/ui/src/agents/grid-cell.ts`
- Test: `packages/ui/src/__tests__/grid-cell.test.ts`

**Interfaces:**
- Consumes: `AgentSnapshot`, `ThemeAdapter`, `Spinner`, `renderProgressBar`, `STATUS_GLYPH`/`statusToken`, `formatDuration`, `truncateToWidth`/`visibleWidth`.
- Produces: `renderGridCell(theme, opts): string[]` where `opts = { agent: AgentSnapshot; width: number; height: number; focused: boolean; pinned: boolean; now: number; spinner: Spinner }`. Layout: line 1 header `<glyph> <🕸 name/role> · <status> · <elapsed>`; middle = tail of `recentActivity` (newest last) filling `height-2`; last line = progress bar (phase or step progress). Focused cell prefixes header with `▸`/uses `accent`; pinned adds `📌`. Exactly `height` lines, each `≤ width`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/grid-cell.test.ts
import { describe, it, expect } from "vitest";
import { renderGridCell } from "../agents/grid-cell.js";
import { Spinner } from "../components/spinner.js";
import type { AgentSnapshot, ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };
const agent: AgentSnapshot = {
  runId: "r1", name: "worker", role: "worker", status: "running", phase: "impl",
  startedAt: 0, stepCount: 2, tokenCount: 50, recentActivity: ["read a.ts", "edit a.ts"],
};

describe("renderGridCell", () => {
  it("emits exactly `height` lines, each within width", () => {
    const lines = renderGridCell(id, { agent, width: 30, height: 5, focused: false, pinned: false, now: 1000, spinner: new Spinner() });
    expect(lines).toHaveLength(5);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(30);
    expect(lines[0]).toContain("worker");
    expect(lines[0]).toContain("🕸");
  });
  it("marks a focused cell", () => {
    const lines = renderGridCell(id, { agent, width: 30, height: 4, focused: true, pinned: false, now: 1000, spinner: new Spinner() });
    expect(lines[0]).toContain("▸");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/grid-cell.test.ts`
Expected: FAIL — `Cannot find module '../agents/grid-cell.js'`.

- [ ] **Step 3: Write the grid cell** (complete file)

```ts
// packages/ui/src/agents/grid-cell.ts
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderProgressBar } from "../components/progress-bar.js";
import { Spinner } from "../components/spinner.js";
import { formatDuration } from "./footer.js";
import { STATUS_GLYPH, statusToken } from "./types.js";
import type { AgentSnapshot, ThemeAdapter } from "./types.js";

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}

export function renderGridCell(
  theme: ThemeAdapter,
  opts: { agent: AgentSnapshot; width: number; height: number; focused: boolean; pinned: boolean; now: number; spinner: Spinner },
): string[] {
  const { agent: a, width, height, focused, pinned, now, spinner } = opts;
  const glyph = a.status === "running" ? spinner.frame(now) : STATUS_GLYPH[a.status];
  const marker = focused ? "▸ " : "  ";
  const pin = pinned ? "📌" : "";
  const elapsedMs = a.startedAt === undefined ? 0 : (a.endedAt ?? now) - a.startedAt;
  const header = fit(
    `${marker}${theme.fg(statusToken(a.status), glyph)} ${theme.glyph} ${theme.bold(a.name)}${pin} ` +
      theme.fg("muted", `· ${a.status} · ${formatDuration(elapsedMs)}`),
    width,
  );

  const bodyRows = Math.max(0, height - 2);
  const tail = a.recentActivity.slice(-bodyRows);
  const body: string[] = [];
  for (let i = 0; i < bodyRows; i++) {
    const s = tail[i];
    body.push(s ? fit("  " + theme.fg("muted", s), width) : "");
  }

  const bar = renderProgressBar(theme, { value: a.stepCount, max: Math.max(a.stepCount, 1), width: Math.max(1, width - 8) });
  const phaseLabel = theme.fg("dim", (a.phase ? a.phase + " " : "") + `${a.stepCount}⋯${a.tokenCount}t`);
  const footer = fit(`${bar} ${phaseLabel}`, width);

  const lines = [header, ...body, footer];
  // Guarantee exactly `height` lines.
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/grid-cell.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/agents/grid-cell.ts packages/ui/src/__tests__/grid-cell.test.ts
git commit -m "feat(ui): GridCell — header + activity tail + progress"
```

---

## Task 13: Grid component (overlay: layout, focus, keys, pagination, edges)

**Files:**
- Create: `packages/ui/src/agents/grid.ts`
- Test: `packages/ui/src/__tests__/grid.test.ts`

**Interfaces:**
- Consumes: `AgentStore`, `AgentActions`, `ThemeAdapter`, `Spinner`, `layoutGrid`, `renderGridCell`, `HandoffEdge`, `matchesKey`/`Key`, `truncateToWidth`.
- Produces: `class Grid implements Component` with `render(width): string[]`, `handleInput(data): boolean`, `invalidate()`, plus `.setDrillHandler(fn)` and `.onClose(fn)`. Grid composes cells via `layoutGrid(agents.length, page)`; arranges rows of cells side-by-side by column; shows a handoff-edge line (`worker →review→ reviewer`) beneath the grid when `store.edges()` non-empty; footer hint line lists keys. Focus is a linear index over visible cells (arrows move it in 2-D). Keys: `↑↓←→` move focus; `Enter` → drill (`setDrillHandler`); `Esc` → close; `m/i/r/f` → `AgentActions.{message,interrupt,resume,follow}` on the focused run (`f` toggles a local pinned set); `[`/`]` (or `PageUp`/`PageDown`) change page. `handleInput` returns `true` when it consumed the key.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/grid.test.ts
import { describe, it, expect, vi } from "vitest";
import { Grid } from "../agents/grid.js";
import { AgentStore } from "../agents/store.js";
import type { RunRow, RunSource, RunEvent, ThemeAdapter, AgentActions } from "../agents/types.js";
import { Key } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };
function row(i: number): RunRow {
  return { id: `r${i}`, session_id: "s", agent: "worker", status: "running", step_count: 0, token_count: 0, started_at: 0 };
}
class Src implements RunSource {
  rows = new Map<string, RunRow>(); listActive() { return [...this.rows.values()]; }
  getRun(id: string) { return this.rows.get(id); } subscribe(_: (e: RunEvent) => void) { return () => {}; }
}
function makeStore(n: number) {
  const src = new Src(); for (let i = 0; i < n; i++) src.rows.set(`r${i}`, row(i));
  const store = new AgentStore(src); store.start(); return store;
}
const actions: AgentActions = { message: vi.fn(), interrupt: vi.fn(), resume: vi.fn(), follow: vi.fn() };

describe("Grid", () => {
  it("renders cells for all agents on the page", () => {
    const g = new Grid(makeStore(4), actions, id, { now: () => 1 });
    const out = g.render(80).join("\n");
    for (let i = 0; i < 4; i++) expect(out).toContain(`r${i}`);
  });
  it("Enter drills the focused run", () => {
    const g = new Grid(makeStore(4), actions, id, { now: () => 1 });
    const drill = vi.fn(); g.setDrillHandler(drill);
    g.render(80);
    expect(g.handleInput(Key.enter)).toBe(true);
    expect(drill).toHaveBeenCalledWith("r0");
  });
  it("i interrupts the focused run", () => {
    const g = new Grid(makeStore(2), actions, id, { now: () => 1 });
    g.render(80);
    expect(g.handleInput("i")).toBe(true);
    expect(actions.interrupt).toHaveBeenCalledWith("r0");
  });
  it("Esc closes", () => {
    const g = new Grid(makeStore(2), actions, id, { now: () => 1 });
    const close = vi.fn(); g.onClose(close);
    expect(g.handleInput(Key.escape)).toBe(true);
    expect(close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/grid.test.ts`
Expected: FAIL — `Cannot find module '../agents/grid.js'`.

- [ ] **Step 3: Write the grid** (complete file)

```ts
// packages/ui/src/agents/grid.ts
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "../index.js";
import { Spinner } from "../components/spinner.js";
import { layoutGrid } from "./grid-layout.js";
import { renderGridCell } from "./grid-cell.js";
import type { AgentActions, AgentSnapshot, ThemeAdapter } from "./types.js";
import type { AgentStore } from "./store.js";

const CELL_HEIGHT = 5;

export class Grid implements Component {
  private focus = 0;
  private page = 0;
  private pinned = new Set<string>();
  private spinner: Spinner;
  private now: () => number;
  private drill?: (runId: string) => void;
  private close?: () => void;

  constructor(private store: AgentStore, private actions: AgentActions, private theme: ThemeAdapter,
    opts: { now?: () => number; spinner?: Spinner } = {}) {
    this.now = opts.now ?? Date.now;
    this.spinner = opts.spinner ?? new Spinner();
  }

  setDrillHandler(fn: (runId: string) => void): void { this.drill = fn; }
  onClose(fn: () => void): void { this.close = fn; }

  private pageAgents(): AgentSnapshot[] {
    const all = this.store.snapshot();
    const l = layoutGrid(all.length, this.page);
    this.page = l.page;
    const start = l.page * l.perPage;
    return all.slice(start, start + l.perPage);
  }

  private focusedRunId(): string | undefined { return this.pageAgents()[this.focus]?.runId; }

  handleInput(data: string): boolean {
    const all = this.store.snapshot();
    const l = layoutGrid(all.length, this.page);
    const onPage = this.pageAgents().length;
    if (matchesKey(data, Key.escape)) { this.close?.(); return true; }
    if (matchesKey(data, Key.enter)) { const id = this.focusedRunId(); if (id) this.drill?.(id); return true; }
    if (matchesKey(data, Key.right)) { this.focus = Math.min(onPage - 1, this.focus + 1); return true; }
    if (matchesKey(data, Key.left)) { this.focus = Math.max(0, this.focus - 1); return true; }
    if (matchesKey(data, Key.down)) { this.focus = Math.min(onPage - 1, this.focus + l.cols); return true; }
    if (matchesKey(data, Key.up)) { this.focus = Math.max(0, this.focus - l.cols); return true; }
    if (data === "]" || matchesKey(data, "pagedown")) { this.page = Math.min(l.pages - 1, this.page + 1); this.focus = 0; return true; }
    if (data === "[" || matchesKey(data, "pageup")) { this.page = Math.max(0, this.page - 1); this.focus = 0; return true; }
    const id = this.focusedRunId();
    if (!id) return false;
    if (data === "m") { void this.actions.message(id); return true; }
    if (data === "i") { void this.actions.interrupt(id); return true; }
    if (data === "r") { void this.actions.resume(id); return true; }
    if (data === "f") { if (this.pinned.has(id)) this.pinned.delete(id); else this.pinned.add(id); this.actions.follow(id); return true; }
    return false;
  }

  render(width: number): string[] {
    const all = this.store.snapshot();
    const l = layoutGrid(all.length, this.page);
    const cells = this.pageAgents();
    if (cells.length === 0) {
      return [truncateToWidth(this.theme.fg("muted", `${this.theme.glyph} no active agents`), width, "…")];
    }
    const cols = Math.max(1, l.cols);
    const cellW = Math.max(3, Math.floor((width - (cols - 1)) / cols));
    const lines: string[] = [];
    for (let r = 0; r < l.rows; r++) {
      const rowCells = cells.slice(r * cols, r * cols + cols);
      if (rowCells.length === 0) break;
      const rendered = rowCells.map((a, ci) =>
        renderGridCell(this.theme, {
          agent: a, width: cellW, height: CELL_HEIGHT,
          focused: r * cols + ci === this.focus, pinned: this.pinned.has(a.runId),
          now: this.now(), spinner: this.spinner,
        }),
      );
      for (let li = 0; li < CELL_HEIGHT; li++) {
        const joined = rendered.map((c) => padTo(c[li] ?? "", cellW)).join(" ");
        lines.push(truncateToWidth(joined, width, ""));
      }
      lines.push("");
    }
    // Pipeline handoff edges (pipeline-aware).
    const edges = this.store.edges();
    if (edges.length) {
      const e = edges[edges.length - 1];
      lines.push(truncateToWidth(this.theme.fg("accent", `${this.theme.glyph} ${e.from} →${e.phase ? e.phase : ""}→ ${e.to}`), width, "…"));
    }
    const hint = `↑↓←→ focus · enter drill · m msg · i interrupt · r resume · f pin${l.pages > 1 ? " · [ ] page" : ""} · esc close`;
    lines.push(truncateToWidth(this.theme.fg("dim", hint), width, "…"));
    return lines;

    function padTo(s: string, w: number): string {
      const fill = w - visibleWidth(s);
      return fill > 0 ? s + " ".repeat(fill) : s;
    }
  }

  invalidate(): void { /* stateless render; nothing cached */ }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/grid.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/agents/grid.ts packages/ui/src/__tests__/grid.test.ts
git commit -m "feat(ui): Grid overlay — tiered layout, focus/keys, pagination, handoff edges"
```

---

## Task 14: Full-screen agent detail (drill-down)

**Files:**
- Create: `packages/ui/src/agents/agent-detail.ts`
- Test: `packages/ui/src/__tests__/agent-detail.test.ts`

**Interfaces:**
- Consumes: `AgentStore`, `ThemeAdapter`, `Spinner`, `renderTable`, `renderDiffView`(if `result` carries a diff), `SectionRule` (from Phase 0 barrel), `truncateToWidth`.
- Produces: `class AgentDetail implements Component` with `render(width): string[]`, `handleInput(data): boolean` (Esc → `onBack`), `.onBack(fn)`, constructor `(store, runId, theme, opts?)`. Renders one agent full-screen: header rule with 🕸 + name/role/status, a stats table (model / phase / steps / tokens / elapsed), the full `recentActivity` list, and (if finished) the `result` text. Esc returns to grid.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/agent-detail.test.ts
import { describe, it, expect, vi } from "vitest";
import { AgentDetail } from "../agents/agent-detail.js";
import { AgentStore } from "../agents/store.js";
import type { RunRow, RunSource, RunEvent, ThemeAdapter } from "../agents/types.js";
import { Key, visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };
class Src implements RunSource {
  rows = new Map<string, RunRow>([["r1", { id: "r1", session_id: "s", agent: "worker", role: "reviewer",
    name: "critic", status: "running", model: "gpt", phase: "review", step_count: 4, token_count: 88, started_at: 0 }]]);
  listActive() { return [...this.rows.values()]; }
  getRun(id: string) { return this.rows.get(id); } subscribe(_: (e: RunEvent) => void) { return () => {}; }
}

describe("AgentDetail", () => {
  it("renders the agent name, model and phase within width", () => {
    const store = new AgentStore(new Src()); store.start();
    const d = new AgentDetail(store, "r1", id, { now: () => 1000 });
    const out = d.render(70);
    const joined = out.join("\n");
    expect(joined).toContain("critic");
    expect(joined).toContain("gpt");
    expect(joined).toContain("review");
    for (const l of out) expect(visibleWidth(l)).toBeLessThanOrEqual(70);
  });
  it("Esc returns to grid", () => {
    const store = new AgentStore(new Src()); store.start();
    const d = new AgentDetail(store, "r1", id); const back = vi.fn(); d.onBack(back);
    expect(d.handleInput(Key.escape)).toBe(true);
    expect(back).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/agent-detail.test.ts`
Expected: FAIL — `Cannot find module '../agents/agent-detail.js'`.

- [ ] **Step 3: Write the detail view** (complete file)

```ts
// packages/ui/src/agents/agent-detail.ts
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "../index.js";
import { renderTable } from "../components/table.js";
import { formatDuration } from "./footer.js";
import { STATUS_GLYPH, statusToken } from "./types.js";
import type { ThemeAdapter } from "./types.js";
import type { AgentStore } from "./store.js";

export class AgentDetail implements Component {
  private now: () => number;
  private back?: () => void;
  constructor(private store: AgentStore, private runId: string, private theme: ThemeAdapter,
    opts: { now?: () => number } = {}) { this.now = opts.now ?? Date.now; }

  onBack(fn: () => void): void { this.back = fn; }

  handleInput(data: string): boolean {
    if (matchesKey(data, Key.escape)) { this.back?.(); return true; }
    return false;
  }

  render(width: number): string[] {
    const a = this.store.snapshot().find((x) => x.runId === this.runId);
    const t = this.theme;
    if (!a) return [truncateToWidth(t.fg("muted", `${t.glyph} run ${this.runId} not found`), width, "…")];
    const elapsedMs = a.startedAt === undefined ? 0 : (a.endedAt ?? this.now()) - a.startedAt;
    const rule = truncateToWidth(
      `${t.fg(statusToken(a.status), STATUS_GLYPH[a.status])} ${t.glyph} ${t.bold(a.name)} ` +
        t.fg("muted", `${a.role ?? a.status}`), width, "…");
    const table = renderTable(t, {
      columns: [{ header: "field" }, { header: "value" }],
      rows: [
        ["status", a.status],
        ["model", a.model ?? "—"],
        ["phase", a.phase ?? "—"],
        ["steps", String(a.stepCount)],
        ["tokens", String(a.tokenCount)],
        ["elapsed", formatDuration(elapsedMs)],
      ],
      width,
    });
    const activity = a.recentActivity.map((s) => truncateToWidth("  " + t.fg("muted", s), width, "…"));
    const lines = [rule, "", ...table, "", t.fg("dim", `${t.glyph} recent activity`), ...activity];
    lines.push("", truncateToWidth(t.fg("dim", "esc back to grid"), width, "…"));
    return lines;
  }

  invalidate(): void { /* stateless render */ }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/agent-detail.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/agents/agent-detail.ts packages/ui/src/__tests__/agent-detail.test.ts
git commit -m "feat(ui): AgentDetail — full-screen drill-down view"
```

---

## Task 15: Extend the `@spider/ui` barrel

**Files:**
- Modify: `packages/ui/src/index.ts` (append Phase 5 exports; do NOT remove Phase 0 exports)
- Test: `packages/ui/src/__tests__/index.test.ts`

**Interfaces:**
- Produces: the Phase 5 public surface exported from `@spider/ui`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/index.test.ts
import { describe, it, expect } from "vitest";
import * as ui from "../index.js";

describe("@spider/ui Phase 5 surface", () => {
  it("re-exports agent UI symbols", () => {
    for (const name of [
      "AgentStore", "AgentFooter", "Grid", "AgentDetail", "FrameScheduler",
      "diffLines", "hasChanges", "layoutGrid", "buildFooterModel",
      "renderGridCell", "renderProgressBar", "renderDiffView", "renderTable", "Spinner",
      "STATUS_GLYPH", "statusToken", "formatDuration",
    ]) {
      expect(ui).toHaveProperty(name);
    }
    // Phase 0 skeleton still present
    for (const name of ["Panel", "SectionRule", "StatusLine", "LiveWidget", "theme"]) {
      expect(ui).toHaveProperty(name);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/index.test.ts`
Expected: FAIL — missing exports.

- [ ] **Step 3: Append to the barrel**

```ts
// packages/ui/src/index.ts  (APPEND below the existing Phase 0 exports)

// ---- Phase 5: subagents footer + live grid ----
export * from "./agents/types.js";
export { AgentStore, projectRow, applyEvent } from "./agents/store.js";
export { FrameScheduler } from "./agents/coalesce.js";
export { diffLines, hasChanges } from "./agents/diff.js";
export { layoutGrid } from "./agents/grid-layout.js";
export { buildFooterModel } from "./agents/footer-model.js";
export { AgentFooter, formatDuration } from "./agents/footer.js";
export { Grid } from "./agents/grid.js";
export { renderGridCell } from "./agents/grid-cell.js";
export { AgentDetail } from "./agents/agent-detail.js";
export { Spinner, BRAILLE_FRAMES } from "./components/spinner.js";
export { renderProgressBar } from "./components/progress-bar.js";
export { renderDiffView } from "./components/diff-view.js";
export { renderTable } from "./components/table.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add packages/ui/src/index.ts packages/ui/src/__tests__/index.test.ts
git commit -m "feat(ui): export Phase 5 agents footer/grid surface"
```

---

## Task 16: Host `RunSource` + `ThemeAdapter` + `AgentActions` adapters

**Files:**
- Create: `packages/host/src/agents/run-source.ts`
- Create: `packages/host/src/agents/theme-adapter.ts`
- Create: `packages/host/src/agents/actions.ts`
- Test: `packages/host/src/__tests__/run-source.test.ts`

**Interfaces:**
- Consumes: `@spider/db-core` (`Db`, `bus`, `appendRunEvent`), `@spider/ui` (`RunSource`, `RunRow`, `AgentActions`, `ThemeAdapter`).
- Produces:
  - `createRunSource(db, sessionId): RunSource` — `listActive()` = `SELECT * FROM runs WHERE session_id=? AND (ended_at IS NULL OR ended_at > ?)`; `getRun(id)` = single indexed `SELECT`; `subscribe(fn)` = `bus.on` filtered to `e.sessionId === sessionId`.
  - `piTheme(theme): ThemeAdapter` — wraps pi `Theme.fg/bg/bold`, sets `glyph:"🕸"`.
  - `createAgentActions(pi, ctx, sessionId): AgentActions` — dispatches to Phase 4's subagents control surface (`spider control` / subagents runtime API). If the control action is unregistered, calls `ctx.ui.notify("agent control unavailable", "error")` (graceful fallback). `follow` is UI-local (no-op passthrough).

- [ ] **Step 1: Write the failing test** (RunSource over a real project DB)

```ts
// packages/host/src/__tests__/run-source.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { openDb, migrate, appendRunEvent } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil"; // exported test helper (Phase 0 Task 3)
import { createRunSource } from "../agents/run-source.js";

const opened: { close(): void }[] = [];
afterEach(() => { for (const d of opened) d.close(); opened.length = 0; cleanupScratch(); });

describe("createRunSource", () => {
  it("lists active runs for the session and reads a single run", () => {
    const db = openDb(scratchDbPath("runsrc")); opened.push(db); migrate(db, "project");
    db.prepare(`INSERT INTO runs (id, session_id, agent, status, step_count, token_count, started_at)
                VALUES ('r1','s','worker','running',1,10,0)`).run();
    const src = createRunSource(db, "s");
    expect(src.listActive().map(r => r.id)).toEqual(["r1"]);
    expect(src.getRun("r1")?.status).toBe("running");
  });

  it("subscribe fires only for the matching session on appendRunEvent", () => {
    const db = openDb(scratchDbPath("runsrc2")); opened.push(db); migrate(db, "project");
    const src = createRunSource(db, "s");
    const seen: string[] = [];
    const off = src.subscribe((e) => seen.push(e.sessionId));
    appendRunEvent(db, { runId: "r1", sessionId: "s", ts: 1, type: "status", summary: "running" });
    appendRunEvent(db, { runId: "r2", sessionId: "other", ts: 2, type: "status", summary: "running" });
    off();
    expect(seen).toEqual(["s"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/host/src/__tests__/run-source.test.ts`
Expected: FAIL — `Cannot find module '../agents/run-source.js'`.

- [ ] **Step 3: Write the adapters**

```ts
// packages/host/src/agents/run-source.ts
import { bus, type Db } from "@spider/db-core";
import type { RunEvent, RunRow, RunSource } from "@spider/ui";

const RETENTION_MS = 10_000;

export function createRunSource(db: Db, sessionId: string): RunSource {
  const listStmt = db.prepare(
    `SELECT * FROM runs WHERE session_id = ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at ASC`);
  const getStmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);
  return {
    listActive(): RunRow[] {
      return listStmt.all(sessionId, Date.now() - RETENTION_MS) as RunRow[];
    },
    getRun(runId: string): RunRow | undefined {
      return (getStmt.get(runId) as RunRow | undefined) ?? undefined;
    },
    subscribe(fn: (e: RunEvent) => void): () => void {
      return bus.on((e) => { if (e.sessionId === sessionId) fn(e); });
    },
  };
}
```

```ts
// packages/host/src/agents/theme-adapter.ts
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ThemeAdapter } from "@spider/ui";

export function piTheme(theme: Theme): ThemeAdapter {
  return {
    fg: (token, s) => theme.fg(token as never, s),
    bg: (token, s) => theme.bg(token as never, s),
    bold: (s) => theme.bold(s),
    glyph: "🕸",
  };
}
```

```ts
// packages/host/src/agents/actions.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentActions } from "@spider/ui";

// Phase 4 registers the subagents control action (spider control: interrupt/resume/message).
// Until then, these dispatch calls resolve to a graceful "unavailable" toast.
export function createAgentActions(pi: ExtensionAPI, ctx: { ui: { notify(t: string, level: "info" | "error"): void } }): AgentActions {
  const dispatch = async (command: string, runId: string) => {
    try {
      // Phase 4 exposes control via the spider tool dispatch map.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sub = (pi as any).spiderSubagentsControl as ((c: { command: string; runId: string }) => Promise<void>) | undefined;
      if (!sub) { ctx.ui.notify(`agent ${command} unavailable (subagents runtime not loaded)`, "error"); return; }
      await sub({ command, runId });
    } catch (err) {
      ctx.ui.notify(`agent ${command} failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };
  return {
    message: (runId) => dispatch("message", runId),
    interrupt: (runId) => dispatch("interrupt", runId),
    resume: (runId) => dispatch("resume", runId),
    follow: () => { /* UI-local pin; no runtime call */ },
  };
}
```

> **Phase 4 contract note:** Phase 4 must expose its per-run control (`interrupt`/`resume`/`message`) to the host in a way `createAgentActions` can call. The exact hook (a shared function reference vs. `registerAction("control", …)` dispatch) is a **Phase 4 decision**; this adapter isolates the coupling to one file. Keep the placeholder `spiderSubagentsControl` name as a TODO marker for the Phase 4 wiring task.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/host/src/__tests__/run-source.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/agents/run-source.ts packages/host/src/agents/theme-adapter.ts packages/host/src/agents/actions.ts packages/host/src/__tests__/run-source.test.ts
git commit -m "feat(host): RunSource/ThemeAdapter/AgentActions adapters over db-core + Phase4 control"
```

---

## Task 17: Mount footer + Ctrl+G grid + animation ticker + shutdown cleanup

**Files:**
- Create: `packages/host/src/agents/agents-ui.ts`
- Modify: `packages/host/src/extension.ts` (call `installAgentsUI` on `session_start`; already registers hooks in Phase 0)
- Test: `packages/host/src/__tests__/agents-ui.test.ts`

**Interfaces:**
- Consumes: `@spider/ui` (`AgentStore`, `AgentFooter`, `Grid`, `AgentDetail`, `FrameScheduler`), the Task 16 adapters, pi `ExtensionAPI`/`ExtensionContext` (`ctx.ui.setWidget`, `ctx.ui.custom`, `pi.registerShortcut`).
- Produces: `installAgentsUI(pi, ctx, deps): () => void` (returns a disposer). Behavior:
  - Build `AgentStore` from `createRunSource(db, sessionId)`; `.start()`.
  - Mount the footer via `ctx.ui.setWidget("spider-agents", (_tui, theme) => footerComponent(piTheme(theme)), { placement: "aboveEditor" })`. When `store.snapshot()` is empty, set the widget to `undefined` (footer hidden at zero agents).
  - A single `FrameScheduler` subscribes to `store.onChange`; on each frame, if `footer.hasVisibleChange(width)` OR agent-count crossed 0↔≥1, re-`setWidget`/clear and call `ctx.ui.requestRender?.()`. **No DB poll.**
  - A wall-clock **ticker** (`setInterval(100).unref()`) requests a frame ONLY while `store.hasRunning()` (advances spinner + elapsed); it self-stops when no agents run and restarts on the next change.
  - `pi.registerShortcut("ctrl+g", { description: "Toggle spider agents grid", handler })` opens the grid via `ctx.ui.custom(overlay)`. Grid `Enter` swaps to `AgentDetail` (via re-`ctx.ui.custom`), `Esc` returns/closes. Wire `Grid`'s `AgentActions` from Task 16.
  - Disposer: `store.stop()`, `scheduler.dispose()`, `clearInterval(ticker)`, `ctx.ui.setWidget("spider-agents", undefined)`, unsubscribe.
  - Register the disposer to run on `session_shutdown`.

- [ ] **Step 1: Write the failing test** (headless, with a fake pi/ctx)

```ts
// packages/host/src/__tests__/agents-ui.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { openDb, migrate } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil";
import { installAgentsUI } from "../agents/agents-ui.js";

const opened: { close(): void }[] = [];
afterEach(() => { for (const d of opened) d.close(); opened.length = 0; cleanupScratch(); });

function fakeUi() {
  const widgets = new Map<string, unknown>();
  return {
    widgets,
    setWidget: vi.fn((k: string, v: unknown) => { if (v === undefined) widgets.delete(k); else widgets.set(k, v); }),
    custom: vi.fn(),
    requestRender: vi.fn(),
    notify: vi.fn(),
    theme: { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s, bold: (s: string) => s },
  };
}

describe("installAgentsUI", () => {
  it("mounts a footer widget when an agent is active and clears on dispose", () => {
    const db = openDb(scratchDbPath("aui")); opened.push(db); migrate(db, "project");
    db.prepare(`INSERT INTO runs (id, session_id, agent, status, step_count, token_count, started_at)
                VALUES ('r1','s','worker','running',1,10,0)`).run();
    const ui = fakeUi();
    const pi = { registerShortcut: vi.fn(), on: vi.fn() };
    const dispose = installAgentsUI(pi as never, { ui } as never, { db, sessionId: "s" });
    expect(ui.setWidget).toHaveBeenCalledWith("spider-agents", expect.anything(), { placement: "aboveEditor" });
    expect(pi.registerShortcut).toHaveBeenCalledWith("ctrl+g", expect.objectContaining({ description: expect.any(String) }));
    dispose();
    expect(ui.setWidget).toHaveBeenLastCalledWith("spider-agents", undefined);
  });

  it("does not mount a footer when there are zero agents", () => {
    const db = openDb(scratchDbPath("aui0")); opened.push(db); migrate(db, "project");
    const ui = fakeUi();
    const pi = { registerShortcut: vi.fn(), on: vi.fn() };
    const dispose = installAgentsUI(pi as never, { ui } as never, { db, sessionId: "s" });
    expect(ui.widgets.has("spider-agents")).toBe(false);
    dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/host/src/__tests__/agents-ui.test.ts`
Expected: FAIL — `Cannot find module '../agents/agents-ui.js'`.

- [ ] **Step 3: Write `installAgentsUI`** (complete file)

```ts
// packages/host/src/agents/agents-ui.ts
import type { Db } from "@spider/db-core";
import { AgentStore, AgentFooter, Grid, AgentDetail, FrameScheduler } from "@spider/ui";
import { createRunSource } from "./run-source.js";
import { createAgentActions } from "./actions.js";
import { piTheme } from "./theme-adapter.js";

interface HostUi {
  setWidget(key: string, value: unknown, opts?: { placement?: "aboveEditor" | "belowEditor" }): void;
  custom<T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => unknown, opts?: unknown): Promise<T>;
  requestRender?(): void;
  notify(text: string, level: "info" | "error"): void;
  theme?: unknown;
}
interface HostPi { registerShortcut(key: string, opts: { description?: string; handler: (ctx: unknown) => void }): void; }
interface Deps { db: Db; sessionId: string; width?: () => number }

const WIDGET = "spider-agents";

export function installAgentsUI(pi: HostPi, ctx: { ui: HostUi }, deps: Deps): () => void {
  const { db, sessionId } = deps;
  const width = deps.width ?? (() => process.stdout.columns || 80);
  const store = new AgentStore(createRunSource(db, sessionId));
  const actions = createAgentActions(pi as never, ctx as never);
  store.start();

  let mounted = false;
  let footer: AgentFooter | undefined;

  const syncWidget = () => {
    const active = store.snapshot().length > 0;
    if (active && !mounted) {
      ctx.ui.setWidget(WIDGET, (_tui: unknown, theme: unknown) => {
        footer = new AgentFooter(store, piTheme(theme as never));
        return footer;
      }, { placement: "aboveEditor" });
      mounted = true;
    } else if (!active && mounted) {
      ctx.ui.setWidget(WIDGET, undefined);
      mounted = false; footer = undefined;
    }
  };

  const scheduler = new FrameScheduler(() => {
    const before = mounted;
    syncWidget();
    const changed = footer?.hasVisibleChange(width()) ?? false;
    if (changed || before !== mounted) ctx.ui.requestRender?.();
    ensureTicker();
  });

  const offChange = store.onChange(() => scheduler.request());
  syncWidget(); // initial mount if agents already active

  // Wall-clock animation ticker — only runs while an agent is running.
  let ticker: ReturnType<typeof setInterval> | null = null;
  const ensureTicker = () => {
    if (store.hasRunning() && ticker === null) {
      ticker = setInterval(() => scheduler.request(), 100);
      (ticker as unknown as { unref?: () => void }).unref?.();
    } else if (!store.hasRunning() && ticker !== null) {
      clearInterval(ticker); ticker = null;
    }
  };
  ensureTicker();

  // Ctrl+G — toggle the grid overlay. (NOTE: overrides pi's built-in external-editor Ctrl+G.)
  pi.registerShortcut("ctrl+g", {
    description: "Toggle spider agents grid",
    handler: () => { void openGrid(); },
  });

  const openGrid = async () => {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const grid = new Grid(store, actions, piTheme(theme as never));
      grid.onClose(() => done());
      grid.setDrillHandler((runId) => { done(); void openDetail(runId); });
      const off = store.onChange(() => (tui as { requestRender?: () => void }).requestRender?.());
      return {
        render: (w: number) => grid.render(w),
        invalidate: () => grid.invalidate(),
        handleInput: (data: string) => { grid.handleInput(data); (tui as { requestRender?: () => void }).requestRender?.(); },
        dispose: () => off(),
      };
    }, { overlay: true });
  };

  const openDetail = async (runId: string) => {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const detail = new AgentDetail(store, runId, piTheme(theme as never));
      detail.onBack(() => { done(); void openGrid(); });
      const off = store.onChange(() => (tui as { requestRender?: () => void }).requestRender?.());
      return {
        render: (w: number) => detail.render(w),
        invalidate: () => {},
        handleInput: (data: string) => { detail.handleInput(data); (tui as { requestRender?: () => void }).requestRender?.(); },
        dispose: () => off(),
      };
    }, { overlay: true });
  };

  return function dispose() {
    offChange();
    scheduler.dispose();
    if (ticker !== null) { clearInterval(ticker); ticker = null; }
    store.stop();
    if (mounted) { ctx.ui.setWidget(WIDGET, undefined); mounted = false; }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/host/src/__tests__/agents-ui.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire into `extension.ts`**

In `packages/host/src/extension.ts`, on `session_start` (where the project `Db` and `sessionId` are resolved — the Phase 0 hook already resolves the project via `resolveProject`/`openProject`), call:

```ts
import { installAgentsUI } from "./agents/agents-ui.js";
// inside session_start handler, after opening the project db:
if (ctx.hasUI) {
  const disposeAgentsUI = installAgentsUI(pi, ctx, { db: projectDb, sessionId: ctx.sessionManager.id });
  // register on session_shutdown (Phase 0 registered an empty handler; append the dispose call):
  disposers.push(disposeAgentsUI); // disposers drained in the session_shutdown handler
}
```

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/host/src/agents/agents-ui.ts packages/host/src/extension.ts packages/host/src/__tests__/agents-ui.test.ts
git commit -m "feat(host): mount agents footer + Ctrl+G grid; event-driven, ticker-animated, shutdown-clean"
```

---

## Task 18: Strangler cutover — deprecate the legacy pi-subagents live UI

**Files:**
- Modify: the Phase 4 `@spider/subagents` package entry (`packages/subagents/src/index.ts`) — ensure it does NOT register its own `subagent-async` widget/poller; the footer/grid are now owned by `@spider/host` + `@spider/ui`.
- Test: `packages/host/src/__tests__/agents-ui.test.ts` (already asserts host owns the `spider-agents` widget) + a grep-guard test.

**Interfaces:**
- Consumes: nothing new.
- Produces: single source of truth for live agent UI (host). The legacy 250 ms poller / `JSON.stringify` gate / full-subtree rebuild are gone.

- [ ] **Step 1: Add a guard test that the legacy widget key is not registered**

```ts
// packages/host/src/__tests__/no-legacy-widget.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

describe("no legacy subagents widget", () => {
  it("subagents package does not register subagent-async widget or a poll interval", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const src = readFileSync(join(root, "subagents", "src", "index.ts"), "utf-8");
    expect(src).not.toContain("subagent-async");
    expect(src).not.toMatch(/setInterval\([^)]*250/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run packages/host/src/__tests__/no-legacy-widget.test.ts`
Expected: PASS if Phase 4 already omitted the widget; FAIL if legacy code leaked in — in which case remove the `subagent-async` `setWidget` + 250 ms poller from `packages/subagents/src/index.ts` (keep only `runs`/`run_events` writes via `appendRunEvent`).

- [ ] **Step 3: Full suite + typecheck**

Run: `npm run test`
Expected: all Phase 5 suites green.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/subagents/src/index.ts packages/host/src/__tests__/no-legacy-widget.test.ts
git commit -m "chore(subagents): strangler cutover — host/@spider/ui own the live agent UI"
```

---

## Self-Review (spec coverage)

- **Footer above chat bar, visible ≥1 agent, hidden at zero** → Task 11 (`AgentFooter` returns `[]` at zero) + Task 17 (`setWidget aboveEditor`, clears at zero). ✅
- **Per-agent: status glyph + self-name/role + elapsed + activity + step/token** → Task 11 `agentLine`. ✅
- **Overflow beyond ~4 aggregates (`▸ N running · N done · +N more`)** → Task 6 `buildFooterModel` + Task 11 overflow line. ✅
- **Update model: subscribe bus, coalesce ~16–33 ms, line-diff repaint, NO polling** → Task 2 store (`bus`), Task 3 `FrameScheduler` (24 ms), Task 4 `diffLines`, Task 11 `hasVisibleChange`, Task 17 (no DB poll; ticker only for animation). ✅
- **Grid via Ctrl+G; scaling 1→full…>16 paginated** → Task 5 `layoutGrid` + Task 13 `Grid` + Task 17 `registerShortcut("ctrl+g")`. ✅
- **Cell = header + activity tail + progress** → Task 12 `renderGridCell` + Task 8 `renderProgressBar`. ✅
- **Interaction: arrows focus, Enter drill, Esc return; m/i/r/f** → Task 13 `handleInput` + Task 14 detail + Task 16 `AgentActions`. ✅
- **Pipeline-aware: handoff edges + phase state** → Task 2 `edges()`, Task 13 edge line, Task 12/14 phase in cell/detail. ✅
- **Components AgentFooter/Grid/GridCell/ProgressBar/DiffView/Spinner/Table** → Tasks 7–14. ✅
- **Honor pi theme tokens + 🕸 glyph** → `ThemeAdapter` + Task 16 `piTheme`; glyph in footer/cell/detail. ✅
- **TDD pure functions (diff, grid layout, coalescing, footer overflow)** → Tasks 3–6 all test-first. ✅
- **Fixes named defects** (full-subtree rebuild / 250 ms poll / stringify gate) → diff+coalesce+cache (Tasks 3,4,11) + Task 18 strangler. ✅

## Risks & things needing explicit validation

1. **Ctrl+G conflicts with pi's built-in external-editor binding** (`docs/usage.md`: "Ctrl+G opens externalEditor"). `pi.registerShortcut("ctrl+g", …)` will emit an extension-shortcut conflict diagnostic and, per `runner.js`, an extension shortcut can win for non-reserved bindings — but this silently removes the user's external-editor hotkey. **Decision needed:** keep Ctrl+G (spec-literal, override external editor) vs. use a namespaced keybinding id (e.g. `spider.grid.toggle`, default `ctrl+g`, user-rebindable) or a `/agents` slash command. Recommendation: register the shortcut AND a `/agents` command so users who rebind still have access. Flag to supervisor if the literal Ctrl+G override is unacceptable.
2. **Phase 4 control surface is not yet specified** (`AgentActions` wiring). The `spiderSubagentsControl` marker in Task 16 is a placeholder; Phase 4's plan must expose per-run `interrupt`/`resume`/`message`. Until then keys degrade to a toast. Verify the real hook name during Phase 4 and update `actions.ts`.
3. **Widgets don't receive keyboard focus.** The footer (`setWidget`) is display-only; all interaction happens in the Ctrl+G overlay (`ctx.ui.custom`). Confirmed against `docs/tui.md` (widgets = display; `custom` overlay = focus/input). No footer-level key handling is attempted.
4. **`ThemeAdapter.fg(token, …)` token names** must be real pi theme tokens (`accent`,`muted`,`dim`,`success`,`error`,`warning`,`toolDiffAdded/Removed/Context`). `statusToken` only emits those. Any typo silently no-colors — covered by the "never color-only" rule (glyph always present), but verify token names against the running pi theme.
5. **`better-sqlite3` in Vitest** must use `pool: "forks"` (already set in Phase 0 `vitest.config.ts`); host tests open real DBs under `packages/host/.spider/scratch/` via the Phase 0 `scratchDbPath` helper — confirm that helper is exported from `@spider/db-core/testutil` and reachable from the host package (add the subpath export in `packages/db-core/package.json` if missing).
6. **Coalescing cadence** default 24 ms is inside the 16–33 ms band; validate perceived smoothness on a real terminal and expose via config (`ui.footer` group, Phase 8) if needed — do not hardcode-forever.
7. **Elapsed/spinner smoothness** depends on the 100 ms ticker; ensure it truly `unref`s so it never blocks process exit, and that it stops at zero running agents (Task 17 `ensureTicker`). Validate with a headless timer test if flakiness appears.
8. **Width math for multi-cell rows**: `renderGridCell` returns ANSI-wrapped strings; `Grid.render` pads by `visibleWidth` and truncates the joined row by `width`. Validate on narrow terminals (width < ~40) that cells degrade to fewer columns gracefully (layout tier is by count, not width — a very narrow terminal with 4 agents still asks for 2 cols; if `cellW < 3` the truncation guards prevent overflow but content is unusable — consider a width-based tier fallback in Phase 8).
