import { afterEach, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import * as bootstrap from "../bootstrap-script";
import { selectedSettingsDigests } from "../selected-files";

const settingsSource = (bootstrap as { BOOTSTRAP_SETTINGS_SCRIPT?: string }).BOOTSTRAP_SETTINGS_SCRIPT;
const source = (bootstrap as { BOOTSTRAP_AGENT_DIRECTORY_SCRIPT?: string }).BOOTSTRAP_AGENT_DIRECTORY_SCRIPT;
const roots: string[] = [];
function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "agent-directory-")); roots.push(root);
  const home = join(root, "home dir"), bin = join(root, "bin");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(bin, { mode: 0o700 });
  const systemctl = join(bin, "systemctl");
  writeFileSync(systemctl, '#!/bin/sh\n[ "$1" = --user ] && [ "$2" = show-environment ] || exit 2\n[ "$FIXTURE_SYSTEMD_FAIL" = 1 ] && exit 1\nprintf "%s" "$FIXTURE_SYSTEMD_ENV"\n');
  chmodSync(systemctl, 0o700);
  function run(agentDir?: string, manager = "", fail = false, requestedHome = home, cwd = home) {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: bin, FIXTURE_SYSTEMD_ENV: manager, FIXTURE_SYSTEMD_FAIL: fail ? "1" : "0" };
    if (agentDir === undefined) delete env.PI_CODING_AGENT_DIR; else env.PI_CODING_AGENT_DIR = agentDir;
    const child = spawnSync(process.execPath, ["-e", source!], { input: JSON.stringify({ home: requestedHome }), cwd, env, encoding: "utf8", timeout: 3000 });
    expect(child.status).toBe(0); expect(child.stderr).toBe("");
    return { reply: JSON.parse(child.stdout) as { version: number; kind: string; value: string }, output: child.stdout };
  }
  return { root, home, run };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("probes selected box settings through a fixed read-only program", () => {
  expect(settingsSource).toBeTypeOf("string");
  const f = fixture(), agentDir = join(f.home, ".pi", "agent"); mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const target = join(agentDir, "settings.json"), existing = '{"theme":"old-value","defaultModel":"same-value","defaultProjectTrust":"never"}';
  writeFileSync(target, existing, { mode: 0o600 });
  const entries = selectedSettingsDigests({ path: "settings.json", bytes: Buffer.from('{"theme":"new-value","defaultModel":"same-value"}'), mode: 0o600 });
  const child = spawnSync(process.execPath, ["--input-type=module-typescript", "-e", settingsSource!], {
    input: JSON.stringify({ home: f.home, agentDir, paths: entries.map(entry => entry.path), maximum: 1024 * 1024 }), cwd: f.home,
    env: { ...process.env, HOME: f.home }, encoding: "utf8", timeout: 3000,
  });
  expect(child.status).toBe(0); expect(child.stderr).toBe("");
  const reply = JSON.parse(child.stdout) as { version: number; kind: string; value: { fingerprint: string; digests: (string | null)[] } };
  expect(reply).toMatchObject({ version: 1, kind: "settings-preview", value: { fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(reply.value.digests).toHaveLength(entries.length);
  expect(entries.filter((entry, index) => entry.sha256 !== reply.value.digests[index]).map(entry => entry.path.join("."))).toEqual(["theme"]);
  expect(child.stdout).not.toContain("old-value"); expect(child.stdout).not.toContain("new-value"); expect(child.stdout).not.toContain("same-value");
  expect(readFileSync(target, "utf8")).toBe(existing); expect(existsSync(`${target}.spider-roam.bak`)).toBe(false);
}, 5000);

it("refuses requests to hash unlisted box settings", () => {
  const f = fixture(), agentDir = join(f.home, ".pi", "agent"); mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const target = join(agentDir, "settings.json"), original = '{"defaultProjectTrust":"never"}'; writeFileSync(target, original, { mode: 0o600 });
  const child = spawnSync(process.execPath, ["--input-type=module-typescript", "-e", settingsSource!], {
    input: JSON.stringify({ home: f.home, agentDir, paths: [["defaultProjectTrust"]], maximum: 1024 * 1024 }), cwd: f.home,
    env: { ...process.env, HOME: f.home }, encoding: "utf8", timeout: 3000,
  });
  expect(child.status).toBe(0); expect(JSON.parse(child.stdout)).toEqual({ version: 1, kind: "settings-preview", error: "invalid-settings-preview" });
  expect(child.stdout).not.toContain("never"); expect(readFileSync(target, "utf8")).toBe(original);
}, 5000);

it("reports invalid box settings without changing them during the read-only preview", () => {
  expect(settingsSource).toBeTypeOf("string");
  const f = fixture(), agentDir = join(f.home, ".pi", "agent"); mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const target = join(agentDir, "settings.json"); writeFileSync(target, "[broken", { mode: 0o600 });
  const entries = selectedSettingsDigests({ path: "settings.json", bytes: Buffer.from('{"theme":"sample"}'), mode: 0o600 });
  const child = spawnSync(process.execPath, ["--input-type=module-typescript", "-e", settingsSource!], {
    input: JSON.stringify({ home: f.home, agentDir, paths: entries.map(entry => entry.path), maximum: 1024 * 1024 }), cwd: f.home,
    env: { ...process.env, HOME: f.home }, encoding: "utf8", timeout: 3000,
  });
  expect(child.status).toBe(0); expect(JSON.parse(child.stdout)).toEqual({ version: 1, kind: "settings-preview", error: "invalid-destination-settings" });
  expect(readFileSync(target, "utf8")).toBe("[broken"); expect(existsSync(`${target}.spider-roam.bak`)).toBe(false);
}, 5000);

it("accepts only overrides that resolve to the default pi agent directory", () => {
  expect(source).toBeTypeOf("string");
  const f = fixture(), expected = { version: 1, kind: "agent-directory", value: "default" };
  expect(f.run().reply).toEqual(expected);
  expect(f.run("~/.pi/agent").reply).toEqual(expected);
  expect(f.run(".pi/agent").reply).toEqual(expected);
  expect(f.run(pathToFileURL(join(f.home, ".pi", "agent")).href).reply).toEqual(expected);
  expect(f.run(undefined, "PI_CODING_AGENT_DIR=~/.pi/agent\n").reply).toEqual(expected);
}, 5000);

it("detects a custom target or user-manager environment without revealing values", () => {
  expect(source).toBeTypeOf("string");
  const f = fixture(), secret = join(f.home, "fixture-secret");
  const target = f.run(secret, "OTHER_SECRET=fixture-secret\n");
  expect(target.reply.value).toBe("custom"); expect(target.output).not.toContain("fixture-secret");
  const manager = f.run(undefined, `PI_CODING_AGENT_DIR=${secret}\nOTHER_SECRET=fixture-secret\n`);
  expect(manager.reply.value).toBe("custom"); expect(manager.output).not.toContain("fixture-secret");
  expect(f.run(".pi/agent", "", false, f.home, f.root).reply.value).toBe("custom");
  expect(f.run(undefined, "", false, join(f.home, "other")).reply.value).toBe("custom");
}, 5000);

it("fails closed if the user-manager environment cannot be read", () => {
  expect(source).toBeTypeOf("string");
  const f = fixture();
  expect(f.run(undefined, "", true).reply.value).toBe("unknown");
}, 5000);
