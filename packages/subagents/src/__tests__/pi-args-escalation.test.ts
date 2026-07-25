import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildChildSpawnSpec } from "../pi-args";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let scratchRoot: string;

beforeAll(() => {
  // Use .spider/scratch under a temp directory (never /tmp directly)
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "spider-test-"));
  scratchRoot = path.join(tmpBase, ".spider", "scratch");
  fs.mkdirSync(scratchRoot, { recursive: true });
});

afterAll(() => {
  // Clean up test scratch
  if (scratchRoot) {
    try {
      fs.rmSync(path.dirname(path.dirname(scratchRoot)), { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

const base = {
  runId: "r1",
  sessionId: "s1",
  agent: "worker",
  task: "do it",
  context: "fresh" as const,
  parentSessionId: "s1",
  childIndex: 0,
  dbPath: "/x/.spider/project.db",
  scratchRoot: "", // Will be set in tests
};

describe("child escalation instruction", () => {
  it("the composed child system prompt contains the MUST escalate rule (mutation: delete instruction → fails)", () => {
    // The child's system prompt is passed to buildPiArgs as systemPrompt and written
    // to a file under scratchRoot. We need to verify that buildChildSpawnSpec composes
    // a systemPrompt that includes the escalation instruction.
    
    // For now, we'll check that argv contains --append-system-prompt and verify the
    // file content once implementation is done. This test will guide the implementation.
    const spec = buildChildSpawnSpec({ ...base, scratchRoot });
    
    // The argv should contain --append-system-prompt followed by a file path
    const idx = spec.argv.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    
    // Read the prompt file to verify it contains the escalation instruction
    const promptPath = spec.argv[idx + 1];
    expect(promptPath).toBeTruthy();
    
    // The prompt file should exist and contain the key phrase "MUST escalate"
    const promptContent = fs.readFileSync(promptPath, "utf8");
    
    // Assert on a stable substring, not the full paragraph
    expect(promptContent).toContain("MUST escalate");
    expect(promptContent).toContain("blocked");
  });

  it("the escalation instruction includes concrete triggers (mutation: delete triggers → fails)", () => {
    const spec = buildChildSpawnSpec({ ...base, scratchRoot });
    const idx = spec.argv.indexOf("--append-system-prompt");
    const promptPath = spec.argv[idx + 1];
    const promptContent = fs.readFileSync(promptPath, "utf8");
    
    // Must include specific escalation triggers
    expect(promptContent).toContain("blocked");
    expect(promptContent).toContain("ambiguous");
    expect(promptContent).toContain("destructive");
  });
});
