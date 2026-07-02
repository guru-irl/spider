// packages/host/src/hooks.ts
// Phase 0 registers EMPTY (no-op) handlers for every hook in the contract's
// "Hook wiring" table. Later phases replace each body.
//
// A6 VALIDATE-FIRST resolution: the draft contract named the tool hooks
// `beforeToolCall`/`afterToolCall`, but pi's real ExtensionAPI.on() fires
// `tool_call` (result {block?,reason?}) and `tool_result`
// (result {content?,details?,isError?}) — verified against
// @earendil-works/pi-coding-agent .../core/extensions/types.d.ts. We register the
// REAL event names so Phase 0 handlers actually fire; Phase 3 fills their bodies.
//   - before_agent_start     -> memory snapshot (Phase 1), active-agents (Phase 5)
//   - tool_call              -> intent log (Phase 3)   [deny-only: may return {block?,reason?}]
//   - tool_result            -> scrub/scan/auto-index (Phase 3) [may replace {content?,details?,isError?}]
//   - session_start          -> session upsert + self-name (Phase 1/6)
//   - session_before_compact -> organism drain (Phase 6)
//   - session_compact        -> bookkeeping (Phase 6)
//   - session_shutdown       -> organism final consolidation (Phase 6)
//   - resources_discover     -> contribute skills dirs + config hot-reload (Phase 0/7)

export interface PiLikeAPI {
  on(name: string, fn: (...args: unknown[]) => unknown): void;
}

export const HOOK_NAMES = [
  "before_agent_start",
  "tool_call",
  "tool_result",
  "session_start",
  "session_before_compact",
  "session_compact",
  "session_shutdown",
  "resources_discover",
] as const;

export function registerHooks(pi: PiLikeAPI): void {
  // Phase 0: every handler is a no-op. ExtensionHandler<E,R=undefined> permits
  // returning void, so `undefined` is a universally-valid pass-through
  // (tool_call: no {block} = do not block; tool_result: no {content} = unchanged).
  for (const name of HOOK_NAMES) {
    pi.on(name, () => undefined);
  }
}
