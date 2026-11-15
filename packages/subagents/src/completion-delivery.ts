// Both queries use `r` for the run row. A failed chain step has two independent
// notices: its own completion and the final chain outcome. Keep its route until
// both have been claimed so a failed send can be retried after a reload.
export const PENDING_COMPLETION = `(
  NOT EXISTS (SELECT 1 FROM run_events delivered WHERE delivered.run_id=r.id AND delivered.type='completion_delivered')
  OR (r.status='failed'
    AND EXISTS (SELECT 1 FROM run_events chain WHERE chain.run_id=r.id AND chain.type='chain_steps'
      AND CASE WHEN json_valid(chain.payload) THEN json_extract(chain.payload, '$.stopOnFailure') = 1 ELSE 0 END)
    AND NOT EXISTS (SELECT 1 FROM run_events delivered_chain WHERE delivered_chain.run_id=r.id AND delivered_chain.type='chain_completion_delivered'))
)`;
