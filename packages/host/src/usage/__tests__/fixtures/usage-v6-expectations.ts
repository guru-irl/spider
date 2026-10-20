type Facts = Record<string, unknown[]>;

/** Expected additive changes only; every earlier field remains part of the comparison. */
export function withV6Metadata(facts: Facts): Facts {
  return {
    ...facts,
    calls: facts.calls.map(call => ({ ...call as Record<string, unknown>, thinking_level: null, provider_thinking_level: null, tool_call_id: null, tool_duration_ms: null })),
    import_state: facts.import_state.map(row => {
      const state = row as Record<string, unknown>;
      return { ...state, inode: state.inode !== null && !String(state.path).endsWith("#spider-aux") ? `usage-v6:${state.inode}` : state.inode };
    }),
  };
}
