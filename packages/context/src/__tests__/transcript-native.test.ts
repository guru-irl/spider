import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readTranscript } from "../transcript";

const scratch = resolve(".spider/scratch/native-transcripts");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function transcript(entries: unknown[]): string {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "case-"));
  roots.push(dir);
  const file = join(dir, "session.jsonl");
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  return file;
}
const header = { type: "session", version: 3, id: "native-session", cwd: "/fixture", timestamp: "2026-01-01T00:00:00.000Z" };
function message(id: string, parentId: string | null, role: string, content: unknown) {
  return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role, content, timestamp: 1 } };
}

describe("native pi transcripts", () => {
  it("unwraps message.role/content and preserves tool-result attribution without including thinking", () => {
    const file = transcript([
      header,
      message("u", null, "user", [{ type: "text", text: "Keep regression tests deterministic." }]),
      message("a", "u", "assistant", [
        { type: "thinking", thinking: "Private reasoning is not conversation prose." },
        { type: "text", text: "I created an isolated fixture." },
        { type: "toolCall", id: "call", name: "test", arguments: {} },
      ]),
      { type: "message", id: "t", parentId: "a", message: {
        role: "toolResult", toolCallId: "call", toolName: "test", isError: false, timestamp: 2,
        content: [{ type: "text", text: "Tests passed." }],
      } },
      { type: "thinking_level_change", id: "meta", parentId: "t", thinkingLevel: "high" },
    ]);
    const actual = readTranscript(file);
    expect(actual.sessionId).toBe("native-session");
    expect(actual.messages).toEqual([
      { role: "user", text: "Keep regression tests deterministic." },
      { role: "assistant", text: "I created an isolated fixture." },
      { role: "toolResult", text: "Tests passed." },
    ]);
  });

  it("uses the active parent chain rather than learning from abandoned branches", () => {
    const file = transcript([
      header,
      message("root", null, "user", "Original request."),
      message("answer", "root", "assistant", "Choose an approach."),
      message("abandoned", "answer", "user", "Discarded direction."),
      message("abandoned-answer", "abandoned", "assistant", "Discarded work."),
      message("selected", "answer", "user", "Use the revised approach."),
      { type: "custom", id: "bookkeeping", parentId: "selected", customType: "fixture", data: {} },
    ]);
    expect(readTranscript(file).messages).toEqual([
      { role: "user", text: "Original request." },
      { role: "assistant", text: "Choose an approach." },
      { role: "user", text: "Use the revised approach." },
    ]);
  });
});
