import { describe, it, expect } from "vitest";
import { processCommand, looksLikeSubagent } from "../process-identity";

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

describe("looksLikeSubagent", () => {
  it("returns true when command looks like a spawned pi subagent", () => {
    const probe = () => "pi --mode json -p --session /path/to/.spider/scratch/subagent-sessions/r1/r1.jsonl Task: do it";
    expect(looksLikeSubagent(12345, probe)).toBe(true);
  });

  it("returns true when command is node running pi with --mode json -p", () => {
    const probe = () => "node /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode json -p --session /x/session.jsonl Task: work";
    expect(looksLikeSubagent(12345, probe)).toBe(true);
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

  it("returns false when probe returns empty string", () => {
    const probe = () => "";
    expect(looksLikeSubagent(12345, probe)).toBe(false);
  });
});
