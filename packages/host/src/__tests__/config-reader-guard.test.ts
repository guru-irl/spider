// Tracked guard follow-up: variable or template-literal keys, indexing a whole
// config map, aliased/namespace imports and wrappers, hand-kept organism,
// curator (CURATOR_CONFIG_KEYS) and auxiliary (AUXILIARY_CONFIG_KEYS) key
// inventories, and reads in never-called functions still evade this analysis.
// There is no behaviour test for the routing keys: routing.tracking,
// routing.secret_scrub, routing.injection_scan, routing.auto_index_threshold.
// The six original mutation evasions remain covered below; these are out of scope.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_SCHEMA } from "@spider/ui";
import { DEFAULTS } from "../control";
import { ORGANISM_DEFAULTS, CURATOR_DEFAULTS } from "@spider/organism";
import { DEFAULT_ROUTING_CONFIG } from "../routing/index";
import { productionReaders, mismatchedDefaults } from "./config-reader-analysis";

const root = resolve("packages");
const fields = CONFIG_SCHEMA.flatMap(group => group.fields);

function guard(defaults: Readonly<Record<string, unknown>>, overrides: Record<string, string> = {}): string[] {
  const readers = productionReaders(root, overrides);
  const declared = new Set(fields.map(field => field.key));
  return [
    ...[...declared].filter(key => !readers.has(key)).map(key => `no reader: ${key}`),
    ...[...readers].filter(key => !declared.has(key)).map(key => `no schema: ${key}`),
    ...mismatchedDefaults(defaults, fields).map(key => `default mismatch: ${key}`),
  ];
}

describe("configuration schema truthfulness", () => {
  it("documents curator and auxiliary inventory and routing-key behavior test gaps", () => {
    const header = readFileSync(new URL("./config-reader-guard.test.ts", import.meta.url), "utf8").split("import { describe")[0];
    for (const term of ["CURATOR_CONFIG_KEYS", "AUXILIARY_CONFIG_KEYS", "routing keys", "behaviour test"]) {
      expect(header).toContain(term);
    }
  });
  it("rejects comment-only, unreachable source and skill-example decoys when a real reader disappears", () => {
    expect(productionReaders(root).has("ui.footer")).toBe(true);
    const mount = resolve("packages/host/src/agents/mount.ts");
    const original = readFileSync(mount, "utf8");
    const without = original.replace(/controlConfig\("get", opts.cwd, "ui.footer"\)/, "true");
    expect(without).not.toBe(original);
    for (const decoy of [
      { [mount]: without + '\n// controlConfig("get", opts.cwd, "ui.footer")\n' },
      { [mount]: without, [resolve("packages/host/src/unused-helper.ts")]: 'controlConfig("get", cwd, "ui.footer");' },
      { [mount]: without, [resolve("packages/superpowers/skills/example.ts")]: 'controlConfig("get", cwd, "ui.footer");' },
    ]) expect(guard(DEFAULTS, decoy)).toContain("no reader: ui.footer");
  });

  it("checks imported DEFAULTS despite changed annotations, negative literals and two keys on one line", () => {
    expect(Object.keys(DEFAULTS).length).toBeGreaterThan(0);
    const control = resolve("packages/host/src/control.ts");
    const annotated = readFileSync(control, "utf8").replace(/export const DEFAULTS: [^=]+=/, "export const DEFAULTS: Readonly<Record<string, unknown>> =");
    expect(annotated).toContain("export const DEFAULTS: Readonly<Record<string, unknown>> =");
    expect(guard({ ...DEFAULTS, "ui.footer": false }, { [control]: annotated })).toContain("default mismatch: ui.footer");
    expect(guard({ ...DEFAULTS, "memory.snapshotCharCap": -1 })).toContain("default mismatch: memory.snapshotCharCap");
    expect(guard({ ...DEFAULTS, "ui.footer": true, "routing.tracking": false })).toContain("default mismatch: routing.tracking");
  });

  it("requires every declared key to have a reachable production reader, including whole-map keys", () => {
    expect(guard(DEFAULTS)).toEqual([]);
  });

  it.each(["compaction.summaryModel", "compaction.summaryThinking", "compaction.fileListCap", "compaction.minSummaryOutputTokens"])("recognizes validated compaction-map reads and catches a removed read %s", key => {
    expect(productionReaders(root).has(key)).toBe(true);
    const file = resolve("packages/host/src/compaction/config.ts");
    const source = readFileSync(file, "utf8");
    const without = source.replace(`effective['${key}']`, "undefined");
    expect(without).not.toBe(source);
    expect(guard(DEFAULTS, { [file]: without })).toContain(`no reader: ${key}`);
  });

  it("recognizes validated usage-map reads and catches a removed read", () => {
    expect(productionReaders(root).has("usage.footer")).toBe(true);
    const file = resolve("packages/host/src/usage/config.ts");
    const source = readFileSync(file, "utf8");
    const without = source.replace('values["usage.footer"] as boolean', "true");
    expect(without).not.toBe(source);
    expect(guard(DEFAULTS, { [file]: without })).toContain("no reader: usage.footer");
  });

  it.each(["usage.counter.poll", "usage.alerts.sessionCredits", "usage.alerts.runCredits"])("catches a removed spec-named reader %s", key => {
    expect(productionReaders(root).has(key)).toBe(true);
    const file = resolve("packages/host/src/usage/config.ts");
    const source = readFileSync(file, "utf8");
    const without = source.replace(`values["${key}"]`, "undefined");
    expect(guard(DEFAULTS, { [file]: without })).toContain(`no reader: ${key}`);
  });

  it("requires every production reader to have an editable schema field", () => {
    const readers = productionReaders(root);
    expect([...readers].filter(key => !fields.some(field => field.key === key))).toEqual([]);
  });

  it("documents the actual selector and model-default override locations without obsolete shortcut references", () => {
    const readme = readFileSync(resolve("README.md"), "utf8");
    const guide = readFileSync(resolve("docs/dev-ui-testing.md"), "utf8");
    const store = readFileSync(resolve("packages/ui/src/agents/store.ts"), "utf8");
    expect(readme).toContain("alt+shift+up");
    expect(readme).toContain("control models clear");
    expect(readme).toContain("ui.footer=false");
    expect(guide + store).not.toMatch(/ctrl\+shift\+g|Ctrl\+Shift\+G/);
    const subagents = readFileSync(resolve("packages/subagents/README.md"), "utf8");
    expect(subagents).not.toMatch(/agents grid/i);
    const childTest = readFileSync(resolve("packages/subagents/src/__tests__/child-reporter.test.ts"), "utf8");
    expect(childTest).not.toMatch(/\/Users\/[^/]+\//);
  });

  it("uses the runtime fallback values for whole-map and routing settings", () => {
    const fallback: Record<string, unknown> = {
      "organism.enabled": ORGANISM_DEFAULTS.enabled,
      ...Object.fromEntries(Object.entries(ORGANISM_DEFAULTS.passes).map(([name, value]) => [`organism.passes.${name}`, value])),
      "organism.selfNaming": ORGANISM_DEFAULTS.selfNaming,
      "organism.autoWriteBudget": ORGANISM_DEFAULTS.autoWriteBudget,
      "organism.maxMemoryProposals": ORGANISM_DEFAULTS.maxMemoryProposals,
      ...Object.fromEntries(Object.entries(CURATOR_DEFAULTS).map(([name, value]) => [`curator.${name}`, value])),
      "routing.tracking": DEFAULT_ROUTING_CONFIG.tracking,
      "routing.secret_scrub": DEFAULT_ROUTING_CONFIG.secretScrub,
      "routing.injection_scan": DEFAULT_ROUTING_CONFIG.injectionScan,
      "routing.auto_index_threshold": DEFAULT_ROUTING_CONFIG.autoIndexThreshold,
    };
    expect(Object.entries(fallback).filter(([key, value]) => !fields.some(field => field.key === key && field.default === value))).toEqual([]);
  });

  it("compares list defaults by contents and still catches mismatched entries", () => {
    const listField = { key: "subagents.extensions", label: "Extensions", type: "absolute-path-list" as const, default: [], description: "Child extensions" };
    expect(mismatchedDefaults({ "subagents.extensions": [] }, [listField])).toEqual([]);
    expect(mismatchedDefaults({ "subagents.extensions": ["/path/to/unexpected.ts"] }, [listField])).toEqual(["subagents.extensions"]);
  });

  it("requires nonempty host defaults to match schema keys and values", () => {
    expect(Object.keys(DEFAULTS).length).toBeGreaterThan(0);
    expect(fields.map(field => field.key).filter((key, i, keys) => keys.indexOf(key) !== i)).toEqual([]);
    expect(mismatchedDefaults(DEFAULTS, fields)).toEqual([]);
  });
});
