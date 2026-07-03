import type { AgentSnapshot, AgentStatus, FooterModel } from "./types.js";

const PRIORITY: Record<AgentStatus, number> = {
  running: 0, queued: 1, paused: 2, failed: 3, cancelled: 3, done: 4,
};

export function buildFooterModel(agents: AgentSnapshot[], maxVisible = 4): FooterModel {
  const sorted = [...agents].sort((x, y) => {
    const p = PRIORITY[x.status] - PRIORITY[y.status];
    if (p !== 0) return p;
    return (y.endedAt ?? y.startedAt ?? 0) - (x.endedAt ?? x.startedAt ?? 0);
  });
  const visible = sorted.slice(0, maxVisible);
  if (agents.length <= maxVisible) return { visible };
  const counts = { running: 0, queued: 0, paused: 0, done: 0, failed: 0, cancelled: 0 };
  for (const g of agents) {
    counts[g.status]++;
  }
  return { visible, overflow: { ...counts, hidden: agents.length - visible.length } };
}
