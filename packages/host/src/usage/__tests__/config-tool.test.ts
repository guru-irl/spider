import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, setGlobalDbPathForTests } from "@spider/db-core";
import spiderExtension from "../../extension.js";
import { controlDoctor } from "../../control.js";

let root: string, previous: string;
let slash: (args: string) => Promise<any>;
let doctorSlash: () => Promise<any>;
let messages: any[];
let run: (args: Record<string, unknown>) => Promise<any>;
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-tool-"));
  execFileSync("git", ["init", "-q", root]);
  previous = paths.globalRoot; paths.globalRoot = join(root, "global");
  mkdirSync(paths.globalRoot); mkdirSync(join(root, ".spider"));
  setGlobalDbPathForTests(join(paths.globalRoot, "spider.db"));
  vi.stubGlobal("fetch", () => { throw new Error("network forbidden"); });
  let tool: any;
  const handlers: Record<string, (args: string, ctx: unknown) => Promise<any>> = {};
  messages = [];
  spiderExtension({ registerTool: (t: any) => { if (t.name === "spider") tool = t; }, registerCommand: (name: string, opts: any) => { handlers[name] = opts.handler; }, sendMessage: (m: any) => messages.push(m), on() {} } as never);
  slash = args => handlers.spider(args, { cwd: root, ui: {} });
  doctorSlash = () => handlers.doctor("", { cwd: root, ui: {} });
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
  expect((await run({ op: "unset", key, scope: "repo" })).details).toMatchObject({ ok: true, scope: "local", notice: expect.stringMatching(/removed the ignored local value; the global value is unchanged:/) });
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
  expect(report.lines.join("\n")).toMatch(/config:.*usage.footer.*ignored.*remove with \/spider config unset usage\.footer/);
  expect(report.lines.join("\n")).not.toMatch(/config: FAILED/);
  expect(controlDoctor(root).ok).toBe(true);
});

it.each(["tool", "slash"])("%s doctor awaits code-only startup diagnostics", async path => {
  const baseline = path === "tool" ? (await run({ command: "doctor" })).details
    : (await doctorSlash(), messages.at(-1)?.details.result);
  const server = join(paths.globalRoot, "usage-server");
  mkdirSync(server, { mode: 0o700 });
  writeFileSync(join(server, "crash.log"), "usage-server-startup-invalid\nsynthetic-secret /private/path\n", { mode: 0o600 });
  writeFileSync(join(server, "startup.json"), "corrupt startup synthetic-secret", { mode: 0o600 });
  const report = path === "tool" ? (await run({ command: "doctor" })).details
    : (await doctorSlash(), messages.at(-1)?.details.result);
  expect(report.lines.join("\n")).toContain("Last dashboard server failure: usage-server-startup-invalid,");
  expect(report.lines.join("\n")).not.toMatch(/synthetic-secret|corrupt startup|private\/path/);
  // This headless fixture has no active organism runtime. Dashboard history must not alter its health.
  expect(report.ok).toBe(baseline.ok);
});

it.each(["tool", "slash"])("%s local usage unset distinguishes an ignored value from no local value", async path => {
  const key = "usage.footer";
  await run({ op: "set", key, value: false, scope: "global" });
  const globalBefore = readFileSync(join(paths.globalRoot, "config.json"), "utf8");
  for (const existed of [true, false]) {
    writeFileSync(join(root, ".spider/config.json"), JSON.stringify({ ...(existed ? { [key]: true } : {}), "ui.footer": false }));
    let result: any;
    if (path === "tool") result = (await run({ op: "unset", key })).details;
    else { await slash(`config unset ${key}`); result = messages.at(-1)?.details.result.details; }
    expect(result).toMatchObject({ ok: true, scope: "local", notice: existed
      ? "removed the ignored local value; the global value is unchanged: false"
      : "no local value to remove; usage keys are global-only, use --global to reset the global value" });
    expect(JSON.parse(readFileSync(join(root, ".spider/config.json"), "utf8"))).toEqual({ "ui.footer": false });
    expect(readFileSync(join(paths.globalRoot, "config.json"), "utf8")).toBe(globalBefore);
  }
});

it("calibration config preserves dotted key conventions", async () => {
  expect((await run({ op: "get", key: "usage.calibration" })).details).toMatchObject({ value: "auto", source: "default" });
  await slash("config set usage.calibration off --global");
  expect((await run({ op: "get", key: "usage.calibration" })).details).toMatchObject({ value: "off", source: "global" });
  expect((await run({ op: "set", key: "usage.calibration", value: "auto", scope: "repo" })).isError).toBe(true);
  writeFileSync(join(root, ".spider/config.json"), JSON.stringify({ "usage.calibration": "auto" }));
  expect((await run({ op: "get", key: "usage.calibration" })).details).toMatchObject({ value: "off", source: "global" });
  await slash("config unset usage.calibration");
  expect(JSON.parse(readFileSync(join(root, ".spider/config.json"), "utf8"))).toEqual({});
  await slash("config unset usage.calibration --global");
  expect((await run({ op: "get", key: "usage.calibration" })).details).toMatchObject({ value: "auto", source: "default" });
  await slash("config set usage.counter.poll false --global");
  expect((await run({ op: "get", key: "usage.counter.poll" })).details.value).toBe(false);
});
