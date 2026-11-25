import { describe, expect, it } from "vitest";
import { wrapConversation } from "../agents/detail-conversation";
import type { WrappedRow } from "../agents/detail-conversation";
import { initialFollowState, reduceFollow } from "../agents/detail-follow";
import { messageBlock } from "./fixtures/agent-detail";

const rows = (count: number): WrappedRow[] => Array.from({ length: count }, (_, i) => ({
  text: `row-${i}`, anchor: { eventId: 7, textOffset: i },
}));
const bottom = (content: readonly WrappedRow[] = rows(10), height = 4) =>
  reduceFollow(initialFollowState(), { type: "layout", previousRows: [] }, content, height);

describe("detail follow state", () => {
  it("pauses on upward scroll and End resumes following", () => {
    const content = rows(10);
    const following = bottom(content);
    expect(following).toEqual({ mode: "following", offset: 6 });
    const paused = reduceFollow(following, { type: "scroll", delta: -1 }, content, 4);
    expect(paused).toEqual({ mode: "paused", offset: 5, anchor: content[5]!.anchor });
    expect(reduceFollow(paused, { type: "end" }, content, 4)).toEqual(following);
  });

  it("scrolls from the current bottom before the first layout", () => {
    const content = rows(10);
    expect(reduceFollow(initialFollowState(), { type: "scroll", delta: -1 }, content, 4))
      .toEqual({ mode: "paused", offset: 5, anchor: content[5]!.anchor });
  });

  it("clamps both ends", () => {
    const content = rows(10);
    const top = reduceFollow(bottom(content), { type: "scroll", delta: -100 }, content, 4);
    expect(top).toEqual({ mode: "paused", offset: 0, anchor: content[0]!.anchor });
    expect(reduceFollow(top, { type: "scroll", delta: -1 }, content, 4)).toEqual(top);
    expect(reduceFollow(top, { type: "scroll", delta: 100 }, content, 4)).toEqual({ mode: "following", offset: 6 });
  });

  it("does not pause when all content fits", () => {
    const content = rows(3);
    expect(reduceFollow(bottom(content), { type: "scroll", delta: -1 }, content, 4))
      .toEqual({ mode: "following", offset: 0 });
    expect(reduceFollow(initialFollowState(), { type: "layout", previousRows: [] }, [], 4))
      .toEqual({ mode: "following", offset: 0 });
  });

  it("keeps the bottom on append", () => {
    const before = rows(10), after = rows(14);
    expect(reduceFollow(bottom(before), { type: "layout", previousRows: before }, after, 4))
      .toEqual({ mode: "following", offset: 10 });
  });

  it("resumes when downward scrolling reaches the bottom", () => {
    const content = rows(10);
    const paused = reduceFollow(bottom(content), { type: "scroll", delta: -3 }, content, 4);
    const stillPaused = reduceFollow(paused, { type: "scroll", delta: 2 }, content, 4);
    expect(stillPaused).toEqual({ mode: "paused", offset: 5, anchor: content[5]!.anchor });
    expect(reduceFollow(stillPaused, { type: "scroll", delta: 1 }, content, 4))
      .toEqual({ mode: "following", offset: 6 });
  });

  it("preserves the original source anchor on rewrap and content changes", () => {
    const blocks = [messageBlock(1, "a".repeat(30)), messageBlock(2, "b".repeat(30)), messageBlock(3, "c".repeat(30))];
    const before = wrapConversation(blocks, 5);
    const paused = reduceFollow(bottom(before, 3), { type: "scroll", delta: -7 }, before, 3);
    expect(paused).toEqual({ mode: "paused", offset: 8, anchor: { eventId: 2, textOffset: 10 } });
    const narrow = wrapConversation(blocks, 3);
    const afterNarrow = reduceFollow(paused, { type: "layout", previousRows: before }, narrow, 3);
    expect(afterNarrow).toEqual({ mode: "paused", offset: 13, anchor: { eventId: 2, textOffset: 10 } });
    const wider = wrapConversation(blocks, 10);
    const afterWide = reduceFollow(afterNarrow, { type: "layout", previousRows: narrow }, wider, 3);
    expect(afterWide).toEqual({ mode: "paused", offset: 4, anchor: { eventId: 2, textOffset: 10 } });
    expect(reduceFollow(afterNarrow, { type: "scroll", delta: 0 }, narrow, 3)).toEqual(afterNarrow);
  });

  it("uses the next surviving event on a tie and keeps that position through later updates", () => {
    const blocks = [messageBlock(1, "a".repeat(30)), messageBlock(2, "b".repeat(30)), messageBlock(3, "c".repeat(30))];
    const before = wrapConversation(blocks, 5);
    const paused = reduceFollow(bottom(before, 3), { type: "scroll", delta: -7 }, before, 3);
    const deleted = wrapConversation([blocks[0]!, blocks[2]!], 5);
    const afterDelete = reduceFollow(paused, { type: "layout", previousRows: before }, deleted, 3);
    expect(afterDelete).toEqual({ mode: "paused", offset: 6, anchor: { eventId: 2, textOffset: 10 } });
    const appended = [...deleted, ...wrapConversation([messageBlock(4, "dddddddddd")], 5)];
    expect(reduceFollow(afterDelete, { type: "layout", previousRows: deleted }, appended, 3))
      .toEqual({ mode: "paused", offset: 6, anchor: { eventId: 2, textOffset: 10 } });
    expect(reduceFollow(afterDelete, { type: "layout", previousRows: deleted }, before, 3))
      .toEqual({ mode: "paused", offset: 8, anchor: { eventId: 2, textOffset: 10 } });
  });

  it("resumes following when a larger viewport includes the remaining rows", () => {
    const content = rows(10);
    const paused = reduceFollow(bottom(content), { type: "scroll", delta: -1 }, content, 4);
    expect(reduceFollow(paused, { type: "layout", previousRows: content }, content, 5))
      .toEqual({ mode: "following", offset: 5 });
    expect(reduceFollow(paused, { type: "layout", previousRows: content }, content, 20))
      .toEqual({ mode: "following", offset: 0 });
  });

  it("uses a nearby stored anchor for an activity row and remains following without one", () => {
    const content: WrappedRow[] = [
      { text: "event", anchor: { eventId: 1, textOffset: 0 } },
      { text: "activity" },
      { text: "event", anchor: { eventId: 2, textOffset: 0 } },
      { text: "end", anchor: { eventId: 2, textOffset: 1 } },
    ];
    expect(reduceFollow(bottom(content, 1), { type: "scroll", delta: -2 }, content, 1))
      .toEqual({ mode: "paused", offset: 1, anchor: { eventId: 2, textOffset: 0 } });
    const previousOnly: WrappedRow[] = [content[0]!, { text: "a" }, { text: "b" }, { text: "c" }];
    expect(reduceFollow(bottom(previousOnly, 1), { type: "scroll", delta: -2 }, previousOnly, 1))
      .toEqual({ mode: "paused", offset: 1, anchor: { eventId: 1, textOffset: 0 } });
    const activityOnly = [{ text: "a" }, { text: "b" }, { text: "c" }];
    expect(reduceFollow(bottom(activityOnly, 1), { type: "scroll", delta: -1 }, activityOnly, 1))
      .toEqual({ mode: "following", offset: 2 });
    const paused = reduceFollow(bottom(content, 1), { type: "scroll", delta: -2 }, content, 1);
    expect(reduceFollow(paused, { type: "layout", previousRows: content }, activityOnly, 1))
      .toEqual({ mode: "following", offset: 2 });
  });
});
