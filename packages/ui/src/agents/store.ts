import type { AgentSnapshot, HandoffEdge, RunEvent, RunRow, RunSource } from "./types";

const RETENTION_MS = 10_000;
const TAIL_CAP = 20;
const MAX_HANDOFFS = 64;

export function projectRow(row: RunRow): AgentSnapshot {
  return {
    runId: row.id,
    parentRunId: row.parent_run_id ?? undefined,
    name: row.name ?? row.role ?? row.agent,
    agent: row.agent,
    role: row.role ?? undefined,
    status: row.status,
    phase: row.phase ?? undefined,
    model: row.model ?? undefined,
    thinking: row.thinking ?? undefined,
    task: row.task ?? undefined,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    stepCount: row.step_count ?? 0,
    tokenCount: row.token_count ?? 0,
    recentActivity: [],
  };
}

export function applyEvent(snap: AgentSnapshot, e: RunEvent): AgentSnapshot {
  const next = { ...snap, recentActivity: [...snap.recentActivity] };
  let feedLine: string | undefined;
  if (e.type === "tool_intent") {
    next.activityTool = e.tool ?? next.activityTool;
    feedLine = e.summary ?? e.tool;
    if (feedLine) next.activity = feedLine;
  } else if ((e.type === "tool_result" || e.type === "log") && e.summary) {
    feedLine = e.summary;
    next.activity = e.summary;
  }
  // NOTE: status/handoff events deliberately do NOT feed the activity tail. They
  // carry the run *name* as their summary, which previously flooded recentActivity
  // (and the footer's activity column) with the agent name repeated over and over.
  if (feedLine) {
    next.recentActivity.push(feedLine);
    if (next.recentActivity.length > TAIL_CAP) next.recentActivity.shift();
  }
  return next;
}

type Listener = () => void;

export class AgentStore {
  private agents = new Map<string, AgentSnapshot>();
  private pins = new Set<string>();
  private handoffs: HandoffEdge[] = [];
  private listeners = new Set<Listener>();
  private off?: () => void;
  private now: () => number;
  private selecting = false;
  private sel = 0;

  constructor(private src: RunSource, now: () => number = Date.now) { this.now = now; }

  start(): void {
    for (const row of this.src.listActive()) this.agents.set(row.id, projectRow(row));
    this.off = this.src.subscribe((e) => this.ingest(e));
  }

  stop(): void { this.off?.(); this.off = undefined; }

  onChange(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  snapshot(): AgentSnapshot[] {
    this.evict();
    // Pinned agents float to the top (stable within group), so they stay visible in the
    // footer's limited window and at the head of the grid list.
    const all = [...this.agents.values()];
    return all.sort((a, b) => (this.pins.has(b.runId) ? 1 : 0) - (this.pins.has(a.runId) ? 1 : 0));
  }

  /** Pin state is session-lived (survives grid close/reopen) and exempts a run from
   *  retention eviction, so a pinned agent stays in the footer + grid after it finishes. */
  togglePin(id: string): boolean { if (this.pins.has(id)) { this.pins.delete(id); this.emit(); return false; } this.pins.add(id); this.emit(); return true; }
  isPinned(id: string): boolean { return this.pins.has(id); }
  pinnedIds(): string[] { return [...this.pins]; }

  /** Look up one run even if it has been evicted from the live snapshot (reads the row).
   *  The detail view uses this so drilling into a just-finished run isn't a blank screen. */
  getById(id: string): AgentSnapshot | undefined {
    const cached = this.agents.get(id);
    if (cached) return cached;
    const row = this.src.getRun(id);
    return row ? projectRow(row) : undefined;
  }

  edges(): HandoffEdge[] { return this.handoffs; }

  /** Footer selection (ctrl+shift+g): the footer widget itself renders a ▸ cursor on the
   *  selected row while a key-capturing overlay drives the index — so the footer stays put
   *  (the chat/editor never move). Selection runs over the current snapshot() order. */
  beginSelect(): void { const n = this.snapshot().length; if (n === 0) return; this.selecting = true; if (this.sel < 0 || this.sel >= n) this.sel = 0; this.emit(); }
  endSelect(): void { this.selecting = false; this.emit(); }
  isSelecting(): boolean { return this.selecting; }
  moveSelect(delta: number): void {
    if (!this.selecting) return;
    const n = this.snapshot().length;
    if (n === 0) { this.sel = 0; return; }
    this.sel = Math.max(0, Math.min(n - 1, this.sel + delta));
    this.emit();
  }
  selectedRunId(): string | undefined { if (!this.selecting) return undefined; return this.snapshot()[this.sel]?.runId; }

  /** Full chronological event log for one run (assistant text + tool calls/results). */
  events(runId: string): RunEvent[] { return this.src.listEvents?.(runId) ?? []; }

  hasRunning(): boolean {
    for (const a of this.agents.values()) if (a.status === "running" || a.status === "queued") return true;
    return false;
  }

  private ingest(e: RunEvent): void {
    if (e.type === "handoff" && e.payload && typeof e.payload === "object") {
      const p = e.payload as { from?: string; to?: string; phase?: string };
      if (p.from && p.to) {
        this.handoffs.push({ from: p.from, to: p.to, phase: p.phase, ts: e.ts });
        // Cap to the last MAX_HANDOFFS to prevent unbounded growth
        if (this.handoffs.length > MAX_HANDOFFS) {
          this.handoffs.shift();
        }
      }
    }
    const id = e.runId;
    if (id) {
      const existing = this.agents.get(id);
      const row = this.src.getRun(id);
      if (row) {
        // Fold the event even on first sight (when existing is undefined)
        const merged = applyEvent(existing ?? projectRow(row), e);
        const base = projectRow(row);
        base.activity = merged.activity ?? base.activity;
        base.activityTool = merged.activityTool ?? base.activityTool;
        base.recentActivity = merged.recentActivity;
        this.agents.set(id, base);
      } else if (existing) {
        // Row deleted but we have a cached snapshot; apply event to it
        const merged = applyEvent(existing, e);
        this.agents.set(id, merged);
      }
    }
    this.emit();
  }

  private evict(): void {
    const cutoff = this.now() - RETENTION_MS;
    for (const [id, a] of this.agents) {
      if (this.pins.has(id)) continue; // pinned runs are never evicted
      const finished = a.status === "done" || a.status === "failed" || a.status === "cancelled";
      if (finished && a.endedAt !== undefined && a.endedAt < cutoff) this.agents.delete(id);
    }
  }

  private emit(): void { for (const fn of this.listeners) { try { fn(); } catch { /* isolate */ } } }
}
