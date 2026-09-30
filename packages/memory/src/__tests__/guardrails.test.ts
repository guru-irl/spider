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
  it("filters transient and task narrative patterns in every category", () => {
    for (const category of ["preference", "convention", "correction", "insight", "failure", "tool-quirk"] as const) {
      expect(shouldCapture(category, "The CI failure was flaky then succeeded after retry").capture).toBe(false);
      expect(shouldCapture(category, "Summarize this pull request before merging").capture).toBe(false);
      expect(shouldCapture(category, "Tests: 956 passed, 2 failed on this run").capture).toBe(false);
      expect(shouldCapture(category, "Store the review output under .spider/scratch/review-3/report.md").capture).toBe(false);
      expect(shouldCapture(category, "Record this task's checkpoint in HANDOFF.md and include the full test counts").capture).toBe(false);
      expect(shouldCapture(category, "CI failed at npm ci on run 99999999999 with a stale lockfile").capture).toBe(false);
    }
  });
  it("exempts a direct quoted user preference, but not an unattributed quote or a non-preference", () => {
    const content = "Prefer to summarize this PR before opening a review.";
    expect(shouldCapture("preference", content, 'User: "Prefer to summarize this PR before opening a review."').capture).toBe(false); // an unverified model quote is not an exemption
    expect(shouldCapture("preference", content, 'User: "Prefer to summarize this PR before opening a review."', true).capture).toBe(true);
    expect(shouldCapture("preference", content, 'Agent: "Prefer to summarize this PR before opening a review."').capture).toBe(false);
    expect(shouldCapture("convention", content, 'User: "Prefer to summarize this PR before opening a review."').capture).toBe(false);
    expect(shouldCapture("convention", content, 'User: "Prefer to summarize this PR before opening a review."', true).capture).toBe(false);
  });
  it("does not over-reject durable memory that contains incidental failure-words", () => {
    expect(shouldCapture("convention", "cannot use force-push on the main branch").capture).toBe(true);
    expect(shouldCapture("preference", "I don't work Mondays").capture).toBe(true);
    expect(shouldCapture("convention", "all PR threads must be resolved before merge").capture).toBe(true);
    expect(shouldCapture("convention", "quarantine flaky tests").capture).toBe(true);
    expect(shouldCapture("insight", "always summarize the key decisions each session").capture).toBe(true);
    expect(shouldCapture("convention", "do a fresh install after switching branches").capture).toBe(true);
  });
  it("rejects resolved failure and tool-quirk notes without generic error wording", () => {
    expect(shouldCapture("failure", "Lockfile drift resolved by pinning versions").capture).toBe(false);
    expect(shouldCapture("tool-quirk", "Hook timeouts resolved by raising the timeout").capture).toBe(false);
    expect(shouldCapture("convention", "Resolve every review thread before merging").capture).toBe(true);
  });
  it("restores strict transient and one-off wording for failure notes but not durable conventions", () => {
    for (const category of ["failure", "tool-quirk"] as const) {
      for (const text of ["The integration test is flaky on CI", "Builds are intermittent under load",
        "Summarize the logs before filing an issue", "cannot use git stash on the main branch in this setup"]) {
        expect(shouldCapture(category, text).capture).toBe(false);
      }
    }
    expect(shouldCapture("convention", "quarantine flaky tests").capture).toBe(true);
    expect(shouldCapture("convention", "cannot use force-push on the main branch").capture).toBe(true);
  });
  it("keeps ordinary durable statements without transient markers", () => {
    expect(shouldCapture("convention", "this repo uses conventional commits").capture).toBe(true);
    expect(shouldCapture("preference", "I prefer concise responses").capture).toBe(true);
    expect(shouldCapture("convention", "all PR threads must be resolved before merge").capture).toBe(true);
    expect(shouldCapture("insight", "always summarize the key decisions each session").capture).toBe(true);
    expect(shouldCapture("convention", "cannot use force-push on the main branch").capture).toBe(true);
    expect(shouldCapture("preference", "I don't work Mondays").capture).toBe(true);
    expect(shouldCapture("convention", "quarantine flaky tests").capture).toBe(true);
    expect(shouldCapture("convention", "do a fresh install after switching branches").capture).toBe(true);
    expect(shouldCapture("convention", "Scratch files go under .spider/scratch/, never /tmp").capture).toBe(true);
    expect(shouldCapture("convention", "Write a HANDOFF.md before ending a long session").capture).toBe(true);
    expect(shouldCapture("failure", "The problem was resolved by pinning the lockfile").capture).toBe(false);
  });
});
