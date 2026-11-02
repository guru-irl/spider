// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Live child events (streamed text, tool starts and ends) for anything in this
// process that previews a run, such as a Herdr viewer stream. Nothing here is
// persisted: the child's session file and run_events stay authoritative.
type Listener = (event: Record<string, any>) => void;
// Symbol.for keeps one hub across a /reload, where the old module's child pipe
// keeps reporting while the new module's viewers subscribe.
const HUB = Symbol.for('spider.liveRunEvents.v1');
function hub(): Map<string, Set<Listener>> {
  const scope = globalThis as Record<symbol, Map<string, Set<Listener>> | undefined>;
  return scope[HUB] ??= new Map();
}
/** Event types a viewer can render live. Everything else reaches it through the transcript. */
export const LIVE_EVENT_TYPES: readonly string[] = ['message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end'];
export function publishLiveRunEvent(runId: string, event: Record<string, any>): void {
  const listeners = hub().get(runId); if (!listeners?.size || !LIVE_EVENT_TYPES.includes(event?.type)) return;
  // A viewer can never break the child pipe that reports these events.
  for (const listener of [...listeners]) { try { listener(event); } catch { /* preview only */ } }
}
export function subscribeLiveRunEvents(runId: string, listener: Listener): () => void {
  const map = hub(); let listeners = map.get(runId);
  if (!listeners) map.set(runId, listeners = new Set());
  listeners.add(listener);
  return () => { listeners!.delete(listener); if (!listeners!.size && map.get(runId) === listeners) map.delete(runId); };
}
