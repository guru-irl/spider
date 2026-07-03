import type { AgentSnapshot, HandoffEdge, RunEvent, RunRow, RunSource } from "./types.js";

const RETENTION_MS = 10_000;
const TAIL_CAP = 5;
const MAX_HANDOFFS = 64;

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
      const finished = a.status === "done" || a.status === "failed" || a.status === "cancelled";
      if (finished && a.endedAt !== undefined && a.endedAt < cutoff) this.agents.delete(id);
    }
  }

  private emit(): void { for (const fn of this.listeners) { try { fn(); } catch { /* isolate */ } } }
}
