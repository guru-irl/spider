import { describe, it, expect } from "vitest";
import { shouldCapture } from "../guardrails.js";
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
});
