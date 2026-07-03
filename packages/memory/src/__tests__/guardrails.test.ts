import { describe, it, expect } from "vitest";
import { shouldCapture } from "../guardrails";
describe("anti-poisoning guardrails", () => {
  it("rejects negative tool claims", () => {
    expect(shouldCapture("failure", "the browser tools don't work here").capture).toBe(false);
  });
  it("rejects transient/resolved errors", () => {
    expect(shouldCapture("failure", "npm install failed once then succeeded after retry").capture).toBe(false);
  });
  it("keeps durable conventions", () => {
    expect(shouldCapture("convention", "this repo uses conventional commits").capture).toBe(true);
  });
  it("does not over-reject durable memory that contains incidental failure-words", () => {
    expect(shouldCapture("convention", "cannot use force-push on the main branch").capture).toBe(true);
    expect(shouldCapture("preference", "I don't work Mondays").capture).toBe(true);
    expect(shouldCapture("convention", "all PR threads must be resolved before merge").capture).toBe(true);
    expect(shouldCapture("convention", "quarantine flaky tests").capture).toBe(true);
    expect(shouldCapture("insight", "always summarize the key decisions each session").capture).toBe(true);
    expect(shouldCapture("convention", "do a fresh install after switching branches").capture).toBe(true);
  });
});
