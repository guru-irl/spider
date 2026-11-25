import type { ConversationBlock } from "./detail-conversation";
import type { StoredRunEvent } from "./types";

export interface MessageCountState { seen: ReadonlySet<number>; pending: ReadonlySet<number>; }

export function initialMessageCount(
  events: readonly StoredRunEvent[], _blocks: readonly ConversationBlock[],
): MessageCountState {
  return { seen: new Set(events.map(event => event.id)), pending: new Set() };
}

export function updateMessageCount(
  state: MessageCountState, events: readonly StoredRunEvent[], blocks: readonly ConversationBlock[], following: boolean,
): MessageCountState {
  const seen = new Set(state.seen);
  const pending = following ? new Set<number>() : new Set(state.pending);
  const messages = new Set<number>();
  for (const block of blocks) {
    if (block.assistantMessage && block.eventId !== undefined) messages.add(block.eventId);
  }
  for (const event of events) {
    if (!seen.has(event.id) && !following && messages.has(event.id)) pending.add(event.id);
    seen.add(event.id);
  }
  return { seen, pending };
}
