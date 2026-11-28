import type { AgentSnapshot, AgentStatus, FooterModel } from "./types";

const PRIORITY: Record<AgentStatus, number> = {
  running: 0, queued: 1, paused: 2, failed: 3, cancelled: 3, done: 4,
};

export function orderFooterAgents(agents: AgentSnapshot[]): AgentSnapshot[] {
  return [...agents].sort((x, y) => {
    const p = PRIORITY[x.status] - PRIORITY[y.status];
    if (p !== 0) return p;
    return (y.endedAt ?? y.startedAt ?? 0) - (x.endedAt ?? x.startedAt ?? 0);
  });
}

export function buildFooterModel(agents: AgentSnapshot[], maxVisible = 4, offset = 0): FooterModel {
  const sorted = orderFooterAgents(agents);
  const start = Math.max(0, Math.min(offset, Math.max(0, sorted.length - maxVisible)));
  const visible = sorted.slice(start, start + maxVisible);
  if (agents.length <= maxVisible) return { visible };
  const counts = { running: 0, queued: 0, paused: 0, done: 0, failed: 0, cancelled: 0 };
  for (const g of agents) {
    counts[g.status]++;
  }
  return { visible, overflow: { ...counts, hidden: agents.length - visible.length } };
}
