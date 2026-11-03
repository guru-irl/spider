import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { testScratchPath } from "./helpers/testutil";
import { checkProcessIdentity, processCommand, looksLikeSubagent } from "../process-identity";

describe("processCommand", () => {
  it("returns the command line when ps succeeds", () => {
    // Real implementation will use ps; for now we're just writing the interface
    const result = processCommand(process.pid);
    expect(typeof result).toBe("string");
  });

  it("returns null when pid does not exist", () => {
    const result = processCommand(999999);
    expect(result).toBeNull();
  });

  it("returns null on win32", () => {
    // Will be implemented to always return null on Windows
  });
});

const identityRoots: string[] = [];
afterEach(() => { for (const root of identityRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("recognizes the running entry within the pi package", () => {
  const root = testScratchPath(`pi-identity-${randomUUID()}`); identityRoots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
  const entry = join(root, "src", "cli.ts"); writeFileSync(entry, "// entry\n");
  expect(looksLikeSubagent(1, () => `node ${entry} --mode rpc --session /p/subagent-sessions/r/r.jsonl`)).toBe(true);
});

it("recognizes a pi entry whose path contains spaces", () => {
  const root = testScratchPath(`pi-identity-${randomUUID()}`); identityRoots.push(root);
  mkdirSync(join(root, "space dir"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
  const entry = join(root, "space dir", "cli.js"); writeFileSync(entry, "// entry\n");
  expect(looksLikeSubagent(1, () => `node ${entry} --mode rpc --session /p/subagent-sessions/r/r.jsonl`)).toBe(true);
});

it("does not mistake a Node flag value for the pi entry", () => {
  expect(looksLikeSubagent(1, () => "node --title pi /opt/other.js --mode rpc --session /p/subagent-sessions/r/r.jsonl")).toBe(false);
});

describe("looksLikeSubagent", () => {
  it("returns true when command looks like a spawned pi subagent", () => {
    const probe = () => "pi --mode json -p --session /path/to/.spider/scratch/subagent-sessions/r1/r1.jsonl Task: do it";
    expect(looksLikeSubagent(12345, probe)).toBe(true);
  });

  it("returns true when command is node running pi with --mode json -p", () => {
    const probe = () => "node /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode json -p --session /x/session.jsonl Task: work";
    expect(looksLikeSubagent(12345, probe)).toBe(true);
  });

  it("rejects Node flags and unrelated scripts before the pi entry", () => {
    const args = "--mode rpc --session /p/subagent-sessions/r/r.jsonl";
    const cli = "/opt/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
    expect(looksLikeSubagent(12345, () => `node --require /opt/preload.cjs --max-old-space-size=256 ${cli} ${args}`)).toBe(false);
    expect(looksLikeSubagent(12345, () => `node -r/opt/preload.cjs ${cli} ${args}`)).toBe(false);
    expect(looksLikeSubagent(12345, () => `node /opt/other.js ${cli} ${args}`)).toBe(false);
  });

  it("returns false when command is a different program", () => {
    const probe = () => "/usr/bin/postgres -D /var/lib/postgresql/data";
    expect(looksLikeSubagent(12345, probe)).toBe(false);
  });

  it("returns false when command is pi but without the subagent signature", () => {
    const probe = () => "pi --session mysession";
    expect(looksLikeSubagent(12345, probe)).toBe(false);
  });

  it("returns false when probe returns null (unknown)", () => {
    const probe = () => null;
    expect(looksLikeSubagent(12345, probe)).toBe(false);
  });

  for (const mode of ["--mode rpc", "--mode json -p"]) {
    it(`recognizes only this run's fork with ${mode}`, () => {
      const command = `pi ${mode} --fork /parent/session.jsonl --session-id run-1 --session-dir /project/.spider/scratch/subagent-sessions/run-1`;
      expect(checkProcessIdentity(12345, null, { command: () => command, runId: "run-1" }).matches).toBe(true);
      expect(checkProcessIdentity(12345, null, { command: () => command, runId: "run-2" }).matches).toBe(false);
      expect(checkProcessIdentity(12345, null, { command: () => command }).matches).toBe(false);
    });
  }

  it.each([
    "pi --mode rpc --fork /parent.jsonl --session-id other --session-dir /p/subagent-sessions/run-1",
    "pi --mode rpc --fork /parent.jsonl --session-id run-1 --session-dir /p/subagent-sessions/other",
    "pi --mode rpc --fork /parent.jsonl --session-id run-1 --session-dir /p/unrelated/run-1",
    "pi --mode rpc --fork /parent.jsonl --session-id run-1",
    "pi --mode rpc --fork /parent.jsonl --session-dir /p/subagent-sessions/run-1",
    "pi --mode rpc --session-id run-1 --session-dir /p/subagent-sessions/run-1",
    "other --mode rpc --fork /parent.jsonl --session-id run-1 --session-dir /p/subagent-sessions/run-1",
    "echo pi --mode rpc --fork /parent.jsonl --session-id run-1 --session-dir /p/subagent-sessions/run-1",
    "pi --mode rpc --fork /parent.jsonl --session-id run-1 --session-id other --session-dir /p/subagent-sessions/run-1",
    "pi --mode rpc --fork /parent.jsonl --session-id run-1 --session-dir /p/subagent-sessions/run-1 --session-dir /elsewhere",
  ])("rejects unrelated or mismatched fork argv: %s", command => {
    expect(checkProcessIdentity(12345, null, { command: () => command, runId: "run-1" }).matches).toBe(false);
  });

  it("returns false when probe returns empty string", () => {
    const probe = () => "";
    expect(looksLikeSubagent(12345, probe)).toBe(false);
  });
});
