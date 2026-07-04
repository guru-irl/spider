import { describe, it, expect } from "vitest";
import { catalogRows, resolveDefault, MODEL_ROLES } from "../models-model.js";
import type { ModelEntry } from "@spider/models";

const E = (over: Partial<ModelEntry> = {}): ModelEntry => ({
  provider: "copilot", id: "m", tier: "standard", thinking: false, vision: false,
  ctx: 1, speed: 1, costHint: 1, available: true, ...over,
});

describe("catalogRows", () => {
  it("groups by tier, marks isDefaultFor + availability, keeps a light group", () => {
    const entries = [
      E({ id: "claude-sonnet-5", tier: "standard" }),
      E({ id: "flash", tier: "light", available: false }),
    ];
    const groups = catalogRows(entries, { worker: "copilot/claude-sonnet-5" });
    const tiers = groups.map((g) => g.tier);
    expect(tiers).toEqual(["light", "standard"]); // ordered, empty groups dropped
    const light = groups.find((g) => g.tier === "light")!;
    expect(light.rows[0].ref).toBe("copilot/flash");
    expect(light.rows[0].available).toBe(false);
    const std = groups.find((g) => g.tier === "standard")!;
    expect(std.rows[0].ref).toBe("copilot/claude-sonnet-5");
    expect(std.rows[0].isDefaultFor).toEqual(["worker"]);
  });
});

describe("resolveDefault", () => {
  it("returns the ref when present + available", () => {
    const entries = [E({ id: "claude-sonnet-5" })];
    expect(resolveDefault({ worker: "copilot/claude-sonnet-5" }, "worker", entries)).toBe("copilot/claude-sonnet-5");
  });
  it("returns undefined when the ref vanished or is unavailable", () => {
    const gone = [E({ id: "other" })];
    expect(resolveDefault({ worker: "copilot/claude-sonnet-5" }, "worker", gone)).toBeUndefined();
    const unavail = [E({ id: "claude-sonnet-5", available: false })];
    expect(resolveDefault({ worker: "copilot/claude-sonnet-5" }, "worker", unavail)).toBeUndefined();
    expect(resolveDefault({}, "worker", unavail)).toBeUndefined();
  });
});

describe("MODEL_ROLES", () => {
  it("contains reviewer, worker, digest", () => {
    expect(MODEL_ROLES).toContain("reviewer");
    expect(MODEL_ROLES).toContain("worker");
    expect(MODEL_ROLES).toContain("digest");
  });
});
