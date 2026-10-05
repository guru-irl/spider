import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, setGlobalDbPathForTests } from "@spider/db-core";
import spiderExtension from "../../extension.js";
import { controlDoctor } from "../../control.js";

let root: string, previous: string;
let run: (args: Record<string, unknown>) => Promise<any>;
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-tool-"));
  execFileSync("git", ["init", "-q", root]);
  previous = paths.globalRoot; paths.globalRoot = join(root, "global");
  mkdirSync(paths.globalRoot); mkdirSync(join(root, ".spider"));
  setGlobalDbPathForTests(join(paths.globalRoot, "spider.db"));
  vi.stubGlobal("fetch", () => { throw new Error("network forbidden"); });
  let tool: any;
  spiderExtension({ registerTool: (t: any) => { if (t.name === "spider") tool = t; }, registerCommand() {}, on() {} } as never);
  run = args => tool.execute("usage-config", { action: "control", command: "config", cwd: root, ...args }, undefined, undefined, { cwd: root });
});
afterEach(() => {
  paths.globalRoot = previous; setGlobalDbPathForTests(null); vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

it.each([["usage.counter.poll", false, true], ["usage.alerts.sessionCredits", 2.5, 0], ["usage.alerts.runCredits", 4, 0]] as const)("registered tool set/get/unset respects global-only %s", async (key, value, fallback) => {
  expect((await run({ op: "set", key, value, scope: "repo" })).isError).toBe(true);
  expect((await run({ op: "set", key, value, scope: "global" })).details).toMatchObject({ ok: true, key, scope: "global" });
  expect((await run({ op: "get", key })).details).toMatchObject({ value, source: "global" });
  const globalBefore = readFileSync(join(paths.globalRoot, "config.json"), "utf8");
  writeFileSync(join(root, ".spider/config.json"), JSON.stringify({ [key]: "ignored", "ui.footer": false }));
  expect((await run({ op: "unset", key, scope: "repo" })).details).toMatchObject({ ok: true, scope: "local", notice: expect.stringMatching(/ignored anyway/) });
  expect(JSON.parse(readFileSync(join(root, ".spider/config.json"), "utf8"))).toEqual({ "ui.footer": false });
  expect(readFileSync(join(paths.globalRoot, "config.json"), "utf8")).toBe(globalBefore);
  expect((await run({ op: "get", key })).details.value).toBe(value);
  expect((await run({ op: "unset", key, scope: "global" })).details.ok).toBe(true);
  expect((await run({ op: "get", key })).details).toMatchObject({ value: fallback, source: "default" });
});

it("doctor diagnoses a hand-written ignored local usage key without failing config", async () => {
  writeFileSync(join(root, ".spider/config.json"), JSON.stringify({ "usage.footer": false }));
  const config = (await run({ op: "get", key: "usage.footer" })).details;
  expect(config).toMatchObject({ value: true, source: "default" });
  expect(config.errors.join("\n")).toMatch(/usage.footer.*ignored/);
  const report = (await run({ command: "doctor" })).details;
  expect(report.lines.join("\n")).toMatch(/config:.*usage.footer.*ignored/);
  expect(report.lines.join("\n")).not.toMatch(/config: FAILED/);
  expect(controlDoctor(root).ok).toBe(true);
});
