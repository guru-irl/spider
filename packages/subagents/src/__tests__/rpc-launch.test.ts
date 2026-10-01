import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildChildSpawnSpec } from "../pi-args";
import { looksLikeSubagent } from "../process-identity";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function spec(mode?: "rpc" | "print") {
  const scratch = resolve(".spider/scratch/rpc-launch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-")); roots.push(root);
  return buildChildSpawnSpec({ runId: "abcdef12-1234-4000-8000-000000000000", sessionId: "parent", agent: "worker", name: "fix-it", task: "do work", model: "test/model", thinking: "high", context: "fresh", parentSessionId: "parent", childIndex: 0, scratchRoot: root, dbPath: join(root, "fixture.db"), childExtensionPath: "fixture-extension.ts", cwd: root, childMode: mode } as any);
}
describe("RPC launch contract", () => {
  it("sends the task only through RPC, names the session before extensions start", () => {
    const s = spec();
    expect(s.argv.slice(1, 3)).toEqual(["--mode", "rpc"]);
    expect(s.argv).not.toContain("-p");
    const exclusions = s.argv[s.argv.indexOf("--exclude-tools") + 1].split(",");
    expect(exclusions).toContain("intercom");
    expect(exclusions).toContain("contact_supervisor");
    expect(s.argv).not.toContain("Task: do work");
    expect(s.argv.slice(s.argv.indexOf("--name") + 1, s.argv.indexOf("--name") + 2)).toEqual(["fix-it-abcdef12"]);
    expect(s.argv).toContain("test/model:high");
    expect(s).toMatchObject({ childMode: "rpc", prompt: "Task: do work" });
  });
  it("retains legacy print argv and positional task", () => {
    const s = spec("print");
    expect(s.argv.slice(s.argv.indexOf("--mode"))).toEqual([
      "--mode", "json", "-p", "--session", s.sessionFile,
      "--model", "test/model:high", "--no-extensions", "--extension", "fixture-extension.ts",
      "--append-system-prompt", expect.stringMatching(/[/\\]prompt\.md$/), "Task: do work",
    ]);
    expect(s.argv.at(-1)).toBe("Task: do work");
    expect(s.argv).not.toContain("--name");
    expect(s.argv).not.toContain("--exclude-tools");
    expect((s as any).prompt).toBeUndefined();
  });
  it("recognises only RPC children carrying the spider session-path signature", () => {
    expect(looksLikeSubagent(42, () => "pi --mode rpc --session /repo/.spider/scratch/subagent-sessions/r/r.jsonl --name worker-r")).toBe(true);
    expect(looksLikeSubagent(42, () => "pi --mode rpc --session /repo/user.jsonl")).toBe(false);
    expect(looksLikeSubagent(42, () => "other --mode rpc --session /repo/.spider/scratch/subagent-sessions/r/r.jsonl")).toBe(false);
    expect(looksLikeSubagent(42, () => "other --mode rpc --session /repo/.spider/scratch/subagent-sessions/r/r.jsonl pi")).toBe(false);
    expect(looksLikeSubagent(42, () => "echo pi --mode rpc --session /repo/.spider/scratch/subagent-sessions/r/r.jsonl")).toBe(false);
    expect(looksLikeSubagent(42, () => "node /installed/bin/pi --mode rpc --session /repo/.spider/scratch/subagent-sessions/r/r.jsonl")).toBe(true);
    expect(looksLikeSubagent(42, () => "pi --mode json -p --session /repo/legacy.jsonl Task: work")).toBe(true);
  });
});
