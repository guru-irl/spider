import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildChildSpawnSpec } from "../pi-args";
import { looksLikeSubagent } from "../process-identity";

it('bundled RPC children have a stable intercom identity without settings lookup', () => {
  const s = spec();
  expect(s.argv.filter(value => value === '--extension')).toHaveLength(1);
  expect(s.argv).toContain('--no-extensions');
  expect(s.env.PI_INTERCOM_STABLE_ID).toBe('spider-abcdef12-1234-4000-8000-000000000000');
  expect(s.env.PI_SUBAGENT_INTERCOM_SESSION_NAME).toBe('fix-it-abcdef12');
}, 5000);
it('explicit legacy child extension paths are refused before spawn', () => {
  expect(() => buildChildSpawnSpec({ runId: 'fixture', sessionId: 'parent', agent: 'worker', task: 'work', context: 'fresh', parentSessionId: 'parent', childIndex: 0,
    scratchRoot: resolve('.spider/scratch/rpc-legacy'), dbPath: 'fixture.db', subagentOnlyExtensions: ['/fixture/pi-intercom/index.ts'] })).toThrow('Legacy intercom extension');
}, 5000);
it('renamed legacy package directories are refused before spawn', () => {
  const scratch = resolve('.spider/scratch/rpc-legacy-directory'); mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'renamed-')); roots.push(directory);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'pi-intercom' }));
  writeFileSync(join(directory, 'index.ts'), 'export default function() {}');
  expect(() => buildChildSpawnSpec({ runId: 'fixture', sessionId: 'parent', agent: 'worker', task: 'work', context: 'fresh', parentSessionId: 'parent', childIndex: 0,
    scratchRoot: directory, dbPath: 'fixture.db', subagentOnlyExtensions: [directory] })).toThrow('Legacy intercom extension');
}, 5000);
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function spec(mode?: "rpc" | "print") {
  const scratch = resolve(".spider/scratch/thinking-policy-tests/rpc-launch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-")); roots.push(root);
  return buildChildSpawnSpec({ runId: "abcdef12-1234-4000-8000-000000000000", sessionId: "parent", agent: "worker", name: "fix-it", task: "do work", model: "test/model", thinking: "high", context: "fresh", parentSessionId: "parent", childIndex: 0, scratchRoot: root, dbPath: join(root, "fixture.db"), childExtensionPath: "fixture-extension.ts", cwd: root, childMode: mode } as any);
}
describe("RPC launch contract", () => {
  it("sends the task only through RPC, names the session before extensions start", () => {
    vi.stubEnv("PI_SUBAGENT_PI_BINARY", undefined);
    const s = spec();
    const piArgsStart = s.argv[0] === process.execPath ? 2 : 1;
    expect(s.argv.slice(piArgsStart, piArgsStart + 2)).toEqual(["--mode", "rpc"]);
    expect(s.argv).not.toContain("-p");
    const exclusions = s.argv[s.argv.indexOf("--exclude-tools") + 1].split(",");
    expect(exclusions).toContain("intercom");
    expect(exclusions).toContain("contact_supervisor");
    expect(s.argv).not.toContain("Task: do work");
    expect(s.argv.slice(s.argv.indexOf("--name") + 1, s.argv.indexOf("--name") + 2)).toEqual(["fix-it-abcdef12"]);
    expect(s.argv).toContain("test/model");
    expect(s.argv.slice(s.argv.indexOf("--thinking"), s.argv.indexOf("--thinking") + 2)).toEqual(["--thinking", "high"]);
    expect(s).toMatchObject({ childMode: "rpc", prompt: "Task: do work" });
  });
  it("retains legacy print argv and positional task", () => {
    const s = spec("print");
    expect(s.argv.slice(s.argv.indexOf("--mode"))).toEqual([
      "--mode", "json", "-p", "--session", s.sessionFile,
      "--model", "test/model", "--thinking", "high", "--no-extensions", "--extension", "fixture-extension.ts",
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
