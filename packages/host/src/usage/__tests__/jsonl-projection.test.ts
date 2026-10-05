import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { UsageJsonLine } from "../jsonl-projection.js";
beforeEach(() => vi.stubGlobal("fetch", () => { throw new Error("network forbidden"); }));
afterEach(() => vi.unstubAllGlobals());
function project(raw: string, size = 1) {
  const line = new UsageJsonLine(), bytes = Buffer.from(raw);
  for (let i = 0; i < bytes.length; i += size) line.write(bytes.subarray(i, i + size));
  return line.finish();
}
it.each([1, 7, 65536])("preserves usage fields and UTF-8 while discarding content across %i-byte chunks", size => {
  const raw = JSON.stringify({ type: "message", id: "雪\"\\", message: { content: [{ text: "ignored\"\\雪".repeat(10000) }], usage: { input: 1000, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 10, cost: { total: 1 } }, provider: "github-copilot", model: "gpt-6.1-sol", role: "assistant" }, irrelevant: { nested: [true, false, null, -1.5e-8, [], {}] } });
  expect(project(raw, size)).toMatchObject({ type: "message", id: "雪\"\\", message: { content: null, usage: { input: 1000, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 10, cost: { total: 1 } }, role: "assistant" }, irrelevant: null });
});
it("handles model changes headers and root usage without inventing fields", () => {
  expect(project('{"type":"session","id":"s","cwd":"/fixture","parentSession":null,"timestamp":"2026-10-04"}')).toEqual({ type: "session", id: "s", cwd: "/fixture", parentSession: null, timestamp: "2026-10-04" });
  expect(project('{"type":"usage","kind":"cache_warm","provider":"github-copilot","model":"gpt-6.1-sol","usage":{"input":1,"output":2},"other":123}')).toMatchObject({ kind: "cache_warm", usage: { input: 1, output: 2 }, other: null });
});
it.each([
  '{"unknown":[1,]}', '{"unknown":{"a":1,}}', '{"unknown":01}', '{"unknown":1.}',
  '{"unknown":1e+}', '{"unknown":tru}', '{"unknown":"\\x"}', '{"unknown":"\\u12XX"}',
  '{"unknown":"bad\u0001"}', '{"unknown":[1 2]}', '{"unknown":{} []}', '{"unknown":true} false',
  '{"unknown":', '{"unknown":"unterminated}', '{"unknown":[[[}', '{"unknown":+1}',
])("does not hide malformed JSON inside discarded fields: %s", raw => {
  expect(project(raw)).toBeUndefined();
});
it("retains valid scalar syntax and handles empty containers and CR whitespace", () => {
  expect(project('{"usage":{"input":0,"output":1e+2,"cacheRead":-0.5,"cacheWrite":1E-2},"other":[[],{},"",true,false,null]}\r')).toMatchObject({ usage: { input: 0, output: 100, cacheRead: -0.5, cacheWrite: 0.01 }, other: null });
});
it("bounds oversized selected metadata and nesting instead of retaining an arbitrary line", () => {
  expect(project(JSON.stringify({ type: "usage", note: "x".repeat(2 * 1024 * 1024) }), 65536)).toBeUndefined();
  expect(project('{"ignored":' + '['.repeat(600) + '0' + ']'.repeat(600) + '}', 65536)).toBeUndefined();
});
