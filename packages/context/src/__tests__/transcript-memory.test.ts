import { afterEach, expect, it } from "vitest";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { normalizeTranscriptEntries, readTranscript } from "../transcript";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
  const base = resolve(".spider/scratch/transcript-memory");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "case-")); roots.push(root); return root;
}
const options = { roles: ["user", "assistant"] };

it("selects conversation roles without reading excluded message content", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "Keep the chosen approach." } },
    { type: "message", message: { role: "toolResult", get content(): never { throw new Error("Excluded output was read"); } } },
    { role: "assistant", content: [{ type: "thinking", thinking: "Not prose" }, { type: "text", text: "Confirmed." }] },
  ];
  expect(normalizeTranscriptEntries(entries, options)).toEqual([
    { role: "user", text: "Keep the chosen approach." }, { role: "assistant", text: "Confirmed." },
  ]);
});

it("selects roles from the active parent chain when loading a session", () => {
  const file = join(fixture(), "session.jsonl");
  writeFileSync(file, [
    { type: "session", id: "selection" },
    { type: "message", id: "root", parentId: null, message: { role: "user", content: "Selected request." } },
    { type: "message", id: "old", parentId: "root", message: { role: "assistant", content: "Abandoned answer." } },
    { type: "message", id: "tool", parentId: "root", message: { role: "toolResult", content: "Evidence, not instructions." } },
    { type: "message", id: "answer", parentId: "tool", message: { role: "assistant", content: "Selected answer." } },
  ].map(entry => JSON.stringify(entry)).join("\n"));
  expect(readTranscript(file, options)).toMatchObject({ sessionId: "selection", messages: [
    { role: "user", text: "Selected request." }, { role: "assistant", text: "Selected answer." },
  ] });
});

it("preserves long UTF-8 lines and a final line without a delimiter", () => {
  const file = join(fixture(), "session.jsonl"), text = "界🙂é".repeat(20000);
  writeFileSync(file, JSON.stringify({ role: "user", content: text }) + "\r\n\ninvalid\n" + JSON.stringify({ role: "assistant", content: "Final reply." }));
  expect(readTranscript(file).messages).toEqual([{ role: "user", text }, { role: "assistant", text: "Final reply." }]);
});

it("loads large non-prose history without retaining a whole-file buffer", () => {
  const root = fixture(), file = join(root, "session.jsonl"), fd = openSync(file, "w");
  const thinking = "x".repeat(8192);
  try {
    for (let i = 0; i < 4096; i++) writeSync(fd, JSON.stringify({ type: "message", id: String(i), parentId: i ? String(i - 1) : null,
      message: { role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text: "Reply." }] } }) + "\n");
  } finally { closeSync(fd); }
  const source = new URL("../transcript.ts", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    const { readTranscript } = await import(${JSON.stringify(source)});
    for (let i = 0; i < 3; i++) global.gc();
    const before = process.resourceUsage().maxRSS;
    const result = readTranscript(${JSON.stringify(file)});
    console.log(JSON.stringify({ count: result.messages.length, growth: (process.resourceUsage().maxRSS - before) * 1024 }));
  `], { encoding: "utf8", env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: root, PATH: join(root, "missing-bin") } });
  const result = JSON.parse(output.trim()) as { count: number; growth: number };
  expect(result.count).toBe(4096);
  expect(result.growth).toBeLessThan(48 * 1024 * 1024);
});
