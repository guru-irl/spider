import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { projectConversation, resolveAnchor, wrapConversation } from "../agents/detail-conversation";
import { messageBlock, plainTheme, snapshot, storedEvent } from "./fixtures/agent-detail";

const plain = (value: string) => stripTerminalSequences(value);

describe("detail conversation wrapping", () => {
  it("preserves indentation and wraps every row of unbroken text", () => {
    const block = messageBlock(7, "ab\n  cd\nabcdefgh");
    const rows = wrapConversation([block], 4);
    expect(rows.map(row => row.text)).toEqual(["ab", "  cd", "abcd", "efgh"]);
    expect(rows.at(-1)?.anchor).toEqual({ eventId: 7, textOffset: 12 });
    expect(wrapConversation([messageBlock(7, "x".repeat(500))], 4)).toHaveLength(125);
  });

  it("preserves ANSI, wide and combining graphemes, indentation and tabs", () => {
    const text = "\x1b[31mA  界e\u0301\n  next\tend\x1b[0m";
    const rows = wrapConversation([messageBlock(7, text)], 4);
    expect(rows.map(row => plain(row.text))).toEqual(["A  ", "界e\u0301", "  ", "next", "  ", "end"]);
    expect(rows.map(row => plain(row.text)).join("")).toBe("A  界e\u0301  next  end");
    expect(rows.every(row => visibleWidth(row.text) <= 4)).toBe(true);
    expect(rows.filter(row => plain(row.text)).every(row => row.text.includes("\x1b[31m"))).toBe(true);
    expect(rows.find(row => plain(row.text).includes("e"))?.text).toContain("e\u0301");
  });

  it("retains a wide grapheme's anchor at one column and restores the glyph when widened", () => {
    const block = messageBlock(8, "a界e\u0301");
    const narrow = wrapConversation([block], 1);
    expect(narrow.map(row => plain(row.text))).toEqual(["a", "�", "e\u0301"]);
    expect(narrow.map(row => row.anchor?.textOffset)).toEqual([0, 1, 2]);
    expect(narrow.every(row => visibleWidth(row.text) <= 1)).toBe(true);
    const wide = wrapConversation([block], 2);
    expect(wide.map(row => plain(row.text))).toEqual(["a", "界", "e\u0301"]);
    expect(resolveAnchor(narrow[1]!.anchor!, narrow, wide)).toBe(1);
  });

  it("normalizes CRLF and expands tabs before wrapping without losing offsets", () => {
    const rows = wrapConversation([messageBlock(9, "A\r\n\t界")], 4);
    expect(rows.map(row => plain(row.text))).toEqual(["A", "    ", "界"]);
    expect(rows.map(row => row.anchor?.textOffset)).toEqual([0, 3, 4]);
    const emptyLines = wrapConversation([messageBlock(9, "a\n\nb\n")], 4);
    expect(emptyLines.map(row => plain(row.text))).toEqual(["a", "", "b", ""]);
    expect(emptyLines.map(row => row.anchor?.textOffset)).toEqual([0, 2, 3, 5]);
  });

  it("keeps words whole when possible without dropping boundary spaces", () => {
    const rows = wrapConversation([messageBlock(10, "abc def")], 5);
    expect(rows.map(row => plain(row.text))).toEqual(["abc ", "def"]);
    expect(rows[1]?.anchor).toEqual({ eventId: 10, textOffset: 4 });
  });

  it("resolves source anchors after rewrap and when events disappear", () => {
    const blocks = [messageBlock(1, "first"), messageBlock(2, "abcdefghijklmnopqrstuvwxyz"), messageBlock(3, "last")];
    const previous = wrapConversation(blocks, 12);
    const anchor = { eventId: 2, textOffset: 13 };
    const narrow = wrapConversation(blocks, 6);
    const wide = wrapConversation(blocks, 20);
    expect(narrow[resolveAnchor(anchor, previous, narrow)]?.anchor).toEqual({ eventId: 2, textOffset: 12 });
    expect(wide[resolveAnchor(anchor, narrow, wide)]?.anchor).toEqual({ eventId: 2, textOffset: 0 });

    const noMiddle = wrapConversation([blocks[0]!, blocks[2]!], 4);
    expect(noMiddle[resolveAnchor(anchor, previous, noMiddle)]?.anchor?.eventId).toBe(3);
    const previousOnly = wrapConversation([blocks[0]!], 4);
    expect(previousOnly[resolveAnchor(anchor, previous, previousOnly)]?.anchor?.eventId).toBe(1);
    expect(resolveAnchor(anchor, previous, [])).toBe(0);
  });
});

describe("detail conversation projection", () => {
  it("projects prose, duration-only messages, tools, handoffs, warnings and activity", () => {
    const events = [
      { ...storedEvent(1, "Hello"), payload: { durationMs: 1250 } },
      { ...storedEvent(2, ""), payload: { durationMs: 250 } },
      { ...storedEvent(3, "read file"), type: "tool_intent" },
      { ...storedEvent(4, "result"), type: "tool_result", payload: { durationMs: 800 } },
      { ...storedEvent(5, "handoff"), type: "handoff" },
      { ...storedEvent(6, "thinking capped"), type: "warning" },
      { ...storedEvent(7, "unknown"), type: "unknown" },
      storedEvent(8, ""),
      { ...storedEvent(9, "legacy"), payload: { durationMs: "5" } },
      { ...storedEvent(10, "legacy tool"), type: "tool_result", payload: { durationMs: -1 } },
    ];
    const blocks = projectConversation(events, snapshot({ activity: "reading" }), plainTheme);
    expect(blocks.map(block => block.key)).toEqual([
      "event:1", "event:2", "event:3", "event:4", "event:5", "event:6", "event:9", "event:10", "activity",
    ]);
    expect(blocks[0]?.text).toContain("Hello");
    expect(blocks[0]?.text).toContain("response time 1.3s");
    expect(blocks[1]?.text).toContain("response time 250ms");
    expect(blocks[1]?.assistantMessage).toBe(true);
    expect(blocks[2]?.text).toContain("read file");
    expect(blocks[3]?.text).toContain("tool time 800ms");
    expect(blocks[4]?.text).toContain("handoff");
    expect(blocks[5]?.text).toContain("thinking capped");
    expect(blocks[6]?.text).not.toContain("time");
    expect(blocks[7]?.text).not.toContain("time");
    expect(blocks.at(-1)).toMatchObject({ key: "activity", assistantMessage: false });
    expect(blocks.at(-1)?.eventId).toBeUndefined();
  });

  it("italicizes only the agent roles in a pipeline handoff", () => {
    const theme = { ...plainTheme, italic: (text: string) => `<i>${text}</i>` };
    const event = { ...storedEvent(11, "worker→reviewer"), type: "handoff" };
    const block = projectConversation([event], snapshot(), theme)[0];
    expect(block?.text).toContain("<i>worker</i>→<i>reviewer</i>");
    const other = { ...event, summary: "plain handoff" };
    expect(projectConversation([other], snapshot(), theme)[0]?.text).not.toContain("<i>");
  });

  it("omits an empty or invalid message and does not show activity for ended runs", () => {
    const events = [storedEvent(1, ""), { ...storedEvent(2, ""), payload: { durationMs: Infinity } }];
    expect(projectConversation(events, snapshot({ status: "failed", activity: "stale" }), plainTheme)).toEqual([]);
  });
});
