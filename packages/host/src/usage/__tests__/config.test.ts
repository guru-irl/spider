import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { getField, renderConfig } from "@spider/ui";
import { UI_CONFIG_SCHEMA } from "../../ui-thinking.js";
import { configValues, controlConfig, DEFAULTS } from "../../control.js";
import { applyConfigEdit, applyConfigUnset } from "../../control/config-cmd.js";
import { makeConfigReloader } from "../../config-reload.js";
import { readUsageConfig, isUsageConfigKey } from "../config.js";

const defaults = { footer: true, counterPoll: true, alertsSessionCredits: 0, alertsRunCredits: 0 };
const keys = ["usage.footer", "usage.counterPoll", "usage.alertsSessionCredits", "usage.alertsRunCredits"];
let root: string, previous: string;
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-config-"));
  previous = paths.globalRoot; paths.globalRoot = join(root, "global");
  vi.spyOn(paths, "projectRoot").mockReturnValue(join(root, "local"));
  mkdirSync(paths.globalRoot); mkdirSync(join(root, "local"));
});
afterEach(() => { paths.globalRoot = previous; vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("usage config", () => {
  it("registers four global-only fields with exact defaults", () => {
    expect(readUsageConfig({}, {}).value).toEqual(defaults);
    keys.forEach((key, index) => {
      const field = getField(key, UI_CONFIG_SCHEMA);
      expect(field).toMatchObject({ scope: "global", default: index < 2 ? true : 0 });
      expect(DEFAULTS[key]).toBe(index < 2 ? true : 0);
      expect(isUsageConfigKey(key)).toBe(true);
    });
    expect(isUsageConfigKey("usage.other")).toBe(false);
  });
  it.each(keys)("set and unset reject local scope for %s through direct and command paths", key => {
    expect(() => controlConfig("set", root, key, true)).toThrow(/global/);
    expect(() => controlConfig("unset", root, key)).toThrow(/global/);
    expect(applyConfigEdit(root, key, key.includes("alerts") ? "1" : "false")).toMatchObject({ ok: false, error: expect.stringMatching(/global/) });
    expect(applyConfigUnset(root, key)).toMatchObject({ ok: false, error: expect.stringMatching(/global/) });
  });
  it("manual local keys are ignored and diagnosed", () => {
    const local = Object.fromEntries(keys.map(key => [key, false]));
    expect(readUsageConfig({}, local)).toMatchObject({ value: defaults, errors: expect.arrayContaining([expect.stringMatching(/usage.footer.*ignored.*global/)]) });
    writeFileSync(join(root, "local/config.json"), JSON.stringify(local));
    const got = configValues(root);
    expect(got.config["usage.footer"]).toBe(true);
    expect(got.sources["usage.footer"]).toBe("default");
    expect(got.errors.join("\n")).toMatch(/usage.counterPoll.*ignored/);
  });
  it.each([["usage.footer", "false"], ["usage.counterPoll", 1], ["usage.alertsSessionCredits", -1], ["usage.alertsRunCredits", Infinity], ["usage.alertsRunCredits", NaN]])("validates %s", (key, value) => {
    expect(readUsageConfig({ [key]: value }, {}).errors.length).toBe(1);
    expect(() => controlConfig("set", root, String(key), value, "global")).toThrow(/must|expected/);
  });
  it("global set is not reported shadowed by ignored local values", () => {
    writeFileSync(join(root, "local/config.json"), JSON.stringify({ "usage.footer": true }));
    expect(applyConfigEdit(root, "usage.footer", "false", "global")).not.toHaveProperty("shadowedBy");
    expect(configValues(root)).toMatchObject({ config: { "usage.footer": false }, sources: { "usage.footer": "global" } });
    expect(applyConfigUnset(root, "usage.footer", "global").ok).toBe(true);
    expect(controlConfig("get", root, "usage.footer")).toBe(true);
  });
  it("UI shows global-only scope before edit", () => {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
    const lines = renderConfig({}, theme, 160, true, UI_CONFIG_SCHEMA).join("\n");
    expect(lines).toMatch(/Usage footer.*global/);
    expect(lines).toMatch(/Counter poll.*global/);
  });
  it("reload pins the project root and does not rediscover git paths on idle ticks", () => {
    const reloader = makeConfigReloader(root, () => {});
    vi.mocked(paths.projectRoot).mockClear();
    reloader.reload(); reloader.reload();
    expect(paths.projectRoot).not.toHaveBeenCalled();
  });
  it("reload hands global-only footer and poll changes to the live consumer", () => {
    writeFileSync(join(root, "local/config.json"), JSON.stringify({ "usage.footer": true, "usage.counterPoll": true }));
    let value = defaults;
    const reload = makeConfigReloader(root, merged => { value = readUsageConfig(merged as Record<string, unknown>, {}).value; });
    applyConfigEdit(root, "usage.footer", "false", "global");
    applyConfigEdit(root, "usage.counterPoll", "false", "global");
    reload.reload();
    expect(value).toEqual({ ...defaults, footer: false, counterPoll: false });
    expect(JSON.parse(readFileSync(join(paths.globalRoot, "config.json"), "utf8"))).toMatchObject({ "usage.counterPoll": false });
  });
});
