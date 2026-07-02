import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { paths } from "@spider/db-core";
import { readTranscript } from "../transcript.js";

let f = "";
afterEach(() => {
  try {
    if (f) rmSync(f);
  } catch {}
});

describe("readTranscript", () => {
  it("normalizes a pi JSONL transcript into {role,text} messages (string + block content)", () => {
    const dir = paths.scratch("project", process.cwd());
    mkdirSync(dir, { recursive: true });
    f = join(dir, `tr-${randomUUID()}.jsonl`);
    writeFileSync(
      f,
      [
        JSON.stringify({ role: "user", content: "do X" }),
        JSON.stringify({ role: "assistant", content: [{ type: "text", text: "did X" }] }),
        JSON.stringify({ type: "model_change", modelId: "x" }),
        JSON.stringify({ type: "message", role: "user", content: [{ type: "text", text: "real fmt" }] }),
      ].join("\n"),
    );
    const t = readTranscript(f);
    expect(t.messages).toHaveLength(3);
    expect(t.messages[0]).toEqual({ role: "user", text: "do X" });
    expect(t.messages[1].text).toContain("did X");
    expect(t.messages[2].text).toBe("real fmt");
    expect(t.sourcePath).toBe(f);
  });
});
