type Facts = Record<string, unknown[]>;

/** Expected additive changes only; every earlier field remains part of the comparison. */
export function withV6Metadata(facts: Facts): Facts {
  return {
    ...facts,
    calls: facts.calls.map(call => ({ ...call as Record<string, unknown>, thinking_level: null, provider_thinking_level: null, tool_call_id: null, tool_duration_ms: null })),
  };
}

/** Apply v7 after the v6 expectations, retaining every earlier field. */
export function withV7Metadata(facts: Facts): Facts {
  return { ...facts, calls: facts.calls.map(call => ({ ...call as Record<string, unknown>, execution_machine: null, managed_entry_key: null })) };
}
