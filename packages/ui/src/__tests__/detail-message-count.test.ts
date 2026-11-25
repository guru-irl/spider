import { describe, expect, it } from "vitest";
import { projectConversation, wrapConversation } from "../agents/detail-conversation";
import { initialFollowState, reduceFollow } from "../agents/detail-follow";
import { initialMessageCount, updateMessageCount } from "../agents/detail-message-count";
import { messageBlock, plainTheme, snapshot, storedEvent } from "./fixtures/agent-detail";

describe("detail new-message counting", () => {
  it("baselines existing history and counts distinct newly observed messages once", () => {
    const events = [1, 2, 3].map(id => storedEvent(id, "same"));
    const blocks = [1, 2, 3].map(id => messageBlock(id, "same"));
    const baseline = initialMessageCount(events.slice(0, 1), blocks.slice(0, 1));
    expect([...baseline.seen]).toEqual([1]);
    expect(baseline.pending.size).toBe(0);
    const paused = updateMessageCount(baseline, events, blocks, false);
    expect([...paused.pending]).toEqual([2, 3]);
    expect([...baseline.seen]).toEqual([1]);
    expect(baseline.pending.size).toBe(0);
    expect(updateMessageCount(paused, events, blocks, false).pending.size).toBe(2);
    expect(updateMessageCount(paused, events, blocks, true).pending.size).toBe(0);
  });

  it("ignores tools, activity, empty and unknown events, but counts duration-only messages", () => {
    const initial = [storedEvent(1, "old")];
    const events = [
      ...initial,
      { ...storedEvent(2, "tool"), type: "tool_intent" },
      { ...storedEvent(3, "unknown"), type: "unknown" },
      storedEvent(4, ""),
      { ...storedEvent(5, ""), payload: { durationMs: 200 } },
      { ...storedEvent(6, "warn"), type: "warning" },
    ];
    const run = snapshot({ activity: "running tool" });
    const blocks = projectConversation(events, run, plainTheme);
    const initialBlocks = projectConversation(initial, run, plainTheme);
    const state = updateMessageCount(initialMessageCount(initial, initialBlocks), events, blocks, false);
    expect([...state.seen]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...state.pending]).toEqual([5]);
    expect(wrapConversation(blocks.filter(block => block.eventId === 5), 4).length).toBeGreaterThan(1);
  });

  it("counts timestamp ties and delayed insertions but not returning old ids", () => {
    const first = { ...storedEvent(1, "same"), ts: 10 };
    const second = { ...storedEvent(2, "same"), ts: 10 };
    const delayed = { ...storedEvent(3, "same"), ts: 1 };
    let state = initialMessageCount([first], [messageBlock(1, "same")]);
    state = updateMessageCount(state, [delayed, first, second], [3, 1, 2].map(id => messageBlock(id, "same")), false);
    expect([...state.pending]).toEqual([3, 2]);
    state = updateMessageCount(state, [second], [messageBlock(2, "same")], false);
    expect([...state.pending]).toEqual([3, 2]);
    state = updateMessageCount(state, [first, second, delayed], [1, 2, 3].map(id => messageBlock(id, "same")), false);
    expect([...state.pending]).toEqual([3, 2]);
  });

  it("retains the count through partial downward scroll and clears it at the bottom", () => {
    const initial = [storedEvent(1, "old")];
    const events = [storedEvent(1, "old"), storedEvent(2, "new")];
    const content = wrapConversation([messageBlock(1, "x".repeat(30)), messageBlock(2, "new")], 5);
    const following = reduceFollow(initialFollowState(), { type: "layout", previousRows: [] }, content, 2);
    const paused = reduceFollow(following, { type: "scroll", delta: -3 }, content, 2);
    let count = updateMessageCount(initialMessageCount(initial, [messageBlock(1, "old")]), events,
      [messageBlock(1, "old"), messageBlock(2, "new")], paused.mode === "following");
    const partial = reduceFollow(paused, { type: "scroll", delta: 1 }, content, 2);
    count = updateMessageCount(count, events, [messageBlock(1, "old"), messageBlock(2, "new")], partial.mode === "following");
    expect([...count.pending]).toEqual([2]);
    const resumed = reduceFollow(partial, { type: "end" }, content, 2);
    expect(updateMessageCount(count, events, [messageBlock(1, "old"), messageBlock(2, "new")], resumed.mode === "following").pending.size).toBe(0);
  });

  it("does not count an observed invisible event when its content later changes", () => {
    const events = [storedEvent(1, ""), storedEvent(2, "old")];
    const baseline = initialMessageCount(events, [messageBlock(2, "old")]);
    const changed = [storedEvent(1, "now visible"), storedEvent(2, "old")];
    expect(updateMessageCount(baseline, changed, [messageBlock(1, "now visible"), messageBlock(2, "old")], false).pending.size).toBe(0);
  });

  it("does not count rewraps, theme changes, or messages already seen while following", () => {
    const events = [storedEvent(1, "old"), storedEvent(2, "new")];
    const blocks = projectConversation(events, snapshot(), plainTheme);
    const baseline = initialMessageCount(events.slice(0, 1), blocks.slice(0, 1));
    const following = updateMessageCount(baseline, events, blocks, true);
    expect(following.pending.size).toBe(0);
    const colored = { ...plainTheme, fg: (_token: string, value: string) => `\x1b[31m${value}\x1b[0m` };
    const restyled = projectConversation(events, snapshot(), colored);
    expect(wrapConversation(restyled, 2).length).toBeGreaterThan(wrapConversation(blocks, 20).length);
    expect(updateMessageCount(following, events, restyled, false).pending.size).toBe(0);
  });
});
