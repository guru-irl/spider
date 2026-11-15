// Shared by discovery, route cleanup, and session-move blockers. All use `r` for the run row.
export const PENDING_COMPLETION = `NOT EXISTS (
  SELECT 1 FROM run_events delivered WHERE delivered.run_id=r.id AND delivered.type='completion_delivered'
)`;
