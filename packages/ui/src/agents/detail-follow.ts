import { resolveAnchor } from "./detail-conversation";
import type { SourceAnchor, WrappedRow } from "./detail-conversation";

export type FollowState =
  | { mode: "following"; offset: number }
  | { mode: "paused"; offset: number; anchor: SourceAnchor };

export type FollowAction =
  | { type: "scroll"; delta: number }
  | { type: "end" }
  | { type: "layout"; previousRows: readonly WrappedRow[] };

export function initialFollowState(): FollowState { return { mode: "following", offset: 0 }; }

function nearestAnchor(rows: readonly WrappedRow[], offset: number): SourceAnchor | undefined {
  for (let distance = 0; distance < rows.length; distance++) {
    const next = rows[offset + distance]?.anchor;
    if (next) return next;
    if (distance > 0) {
      const previous = rows[offset - distance]?.anchor;
      if (previous) return previous;
    }
  }
  return undefined;
}

export function reduceFollow(
  state: FollowState, action: FollowAction, rows: readonly WrappedRow[], viewportRows: number,
): FollowState {
  const maxOffset = Math.max(0, rows.length - viewportRows);
  const following = (): FollowState => ({ mode: "following", offset: maxOffset });

  if (action.type === "end") return following();
  if (action.type === "layout") {
    if (state.mode === "following") return following();
    if (!rows.some(row => row.anchor)) return following();
    const inNext = rows.some(row => row.anchor?.eventId === state.anchor.eventId);
    const inPrevious = action.previousRows.some(row => row.anchor?.eventId === state.anchor.eventId);
    // Once an event has disappeared, resolve successive layouts from the
    // previous visible row while retaining the original source anchor.
    const source = !inNext && !inPrevious
      ? nearestAnchor(action.previousRows, state.offset) ?? state.anchor
      : state.anchor;
    const offset = Math.min(maxOffset, resolveAnchor(source, action.previousRows, rows));
    if (offset >= maxOffset) return following();
    return { mode: "paused", offset, anchor: state.anchor };
  }

  const current = state.mode === "following" ? maxOffset : Math.min(maxOffset, Math.max(0, state.offset));
  const offset = Math.max(0, Math.min(maxOffset, current + action.delta));
  if (offset === maxOffset) return following();
  if (offset === current && state.mode === "paused") return state;
  const anchor = nearestAnchor(rows, offset);
  if (!anchor) return following();
  return { mode: "paused", offset, anchor };
}
