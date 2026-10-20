type Facts = Record<string, unknown[]>;

/** Expected additive changes only; every earlier field remains part of the comparison. */
export function withV6Metadata(facts: Facts): Facts {
  return {
    ...facts,
    calls: facts.calls.map(call => ({ ...call as Record<string, unknown>, thinking_level: null, provider_thinking_level: null, tool_call_id: null, tool_duration_ms: null })),
  };
}
