import { describe, it, expect } from "vitest";
import { readOrganismConfig, readCuratorConfig, ORGANISM_DEFAULTS } from "../config.js";
import { CURATOR_DEFAULTS } from "../curator.js";

describe("readOrganismConfig — actual dotted controlConfig keys", () => {
  it("reads the real dotted master switch key (organism.enabled)", () => {
    expect(readOrganismConfig({ "organism.enabled": false }).enabled).toBe(false);
    expect(readOrganismConfig({ "organism.enabled": true }).enabled).toBe(true);
  });

  it("reads a real dotted per-pass key (organism.passes.learning)", () => {
    const cfg = readOrganismConfig({ "organism.passes.learning": false });
    expect(cfg.passes.learning).toBe(false);
    // untouched passes keep the default
    expect(cfg.passes.consolidation).toBe(ORGANISM_DEFAULTS.passes.consolidation);
  });

  it("reads the real dotted write-budget key (organism.autoWriteBudget)", () => {
    expect(readOrganismConfig({ "organism.autoWriteBudget": 5 }).autoWriteBudget).toBe(5);
  });

  it("still honors nested legacy input ({ organism: { enabled, passes, autoWriteBudget } })", () => {
    const cfg = readOrganismConfig({
      organism: { enabled: false, passes: { learning: false }, autoWriteBudget: 7 },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.passes.learning).toBe(false);
    expect(cfg.autoWriteBudget).toBe(7);
  });

  it("an explicit dotted leaf overrides a conflicting nested/default value", () => {
    const cfg = readOrganismConfig({
      organism: { enabled: true, passes: { learning: true }, autoWriteBudget: 20 },
      "organism.enabled": false,
      "organism.passes.learning": false,
      "organism.autoWriteBudget": 3,
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.passes.learning).toBe(false);
    expect(cfg.autoWriteBudget).toBe(3);
  });

  it("falls back to defaults when neither dotted nor nested keys are present", () => {
    expect(readOrganismConfig({})).toEqual(ORGANISM_DEFAULTS);
    expect(readOrganismConfig(undefined)).toEqual(ORGANISM_DEFAULTS);
  });

  describe("autoWriteBudget validation: nonnegative finite integer only", () => {
    it("rejects a fractional budget and falls back to the default", () => {
      expect(readOrganismConfig({ "organism.autoWriteBudget": 2.5 }).autoWriteBudget).toBe(ORGANISM_DEFAULTS.autoWriteBudget);
    });
    it("rejects a negative budget and falls back to the default", () => {
      expect(readOrganismConfig({ "organism.autoWriteBudget": -1 }).autoWriteBudget).toBe(ORGANISM_DEFAULTS.autoWriteBudget);
    });
    it("rejects Infinity/NaN and falls back to the default", () => {
      expect(readOrganismConfig({ "organism.autoWriteBudget": Infinity }).autoWriteBudget).toBe(ORGANISM_DEFAULTS.autoWriteBudget);
      expect(readOrganismConfig({ "organism.autoWriteBudget": Number.NaN }).autoWriteBudget).toBe(ORGANISM_DEFAULTS.autoWriteBudget);
    });
    it("accepts zero (nonnegative integer boundary)", () => {
      expect(readOrganismConfig({ "organism.autoWriteBudget": 0 }).autoWriteBudget).toBe(0);
    });
  });
});

describe("readCuratorConfig — actual dotted controlConfig keys", () => {
  it("reads the real dotted curator.minIntervalHours key", () => {
    expect(readCuratorConfig({ "curator.minIntervalHours": 48 }).minIntervalHours).toBe(48);
  });

  it("still honors nested legacy input ({ curator: { minIntervalHours } })", () => {
    expect(readCuratorConfig({ curator: { minIntervalHours: 12 } }).minIntervalHours).toBe(12);
  });

  it("an explicit dotted leaf overrides a conflicting nested value", () => {
    const cfg = readCuratorConfig({ curator: { minIntervalHours: 12 }, "curator.minIntervalHours": 48 });
    expect(cfg.minIntervalHours).toBe(48);
  });

  it("falls back to CURATOR_DEFAULTS when nothing is set", () => {
    expect(readCuratorConfig({})).toEqual(CURATOR_DEFAULTS);
  });
});
