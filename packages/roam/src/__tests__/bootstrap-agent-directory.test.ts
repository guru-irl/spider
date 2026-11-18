import { afterEach, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import * as bootstrap from "../bootstrap-script";
import { PROVISION_REMOTE_SCRIPT } from "../provision-remote-script";
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
  function run(agentDir?: string, manager = "", fail = false, requestedHome = home, cwd = home, configured?: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: bin, FIXTURE_SYSTEMD_ENV: manager, FIXTURE_SYSTEMD_FAIL: fail ? "1" : "0" };
    if (agentDir === undefined) delete env.PI_CODING_AGENT_DIR; else env.PI_CODING_AGENT_DIR = agentDir;
    const child = spawnSync(process.execPath, ["-e", source!], { input: JSON.stringify({ home: requestedHome, ...(configured ? { agentDir: configured } : {}) }), cwd, env, encoding: "utf8", timeout: 3000 });
    expect(child.status).toBe(0); expect(child.stderr).toBe("");
    return { reply: JSON.parse(child.stdout) as { version: number; kind: string; value: string }, output: child.stdout };
  }
  return { root, home, run };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each(["settings preview", "provisioning"] as const)("%s starts without installed packages", kind => {
  const f = fixture(), agentDir = join(f.home, ".pi", "agent"), hook = join(f.root, "builtins-only.mjs");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(hook, `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (!specifier.startsWith("node:")) throw new Error("external module unavailable: " + specifier);
  return next(specifier, context);
} });\n`);
  const settings = kind === "settings preview";
  const input = settings ? { home: f.home, agentDir, paths: [["defaultThinkingLevel"]], maximum: 1024 * 1024 } : {};
  const child = spawnSync(process.execPath, ["--import", hook, "--input-type=module-typescript", "-e", settings ? settingsSource! : PROVISION_REMOTE_SCRIPT], {
    input: JSON.stringify(input), cwd: f.home, env: { ...process.env, HOME: f.home }, encoding: "utf8", timeout: 3000,
  });
  expect(child.status, child.stderr).toBe(0);
  const reply = JSON.parse(child.stdout);
  if (settings) expect(reply).toMatchObject({ version: 1, kind: "settings-preview", value: { digests: [null] } });
  else expect(reply).toEqual({ version: 1, kind: "provision", error: "invalid-request" });
}, 5000);

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


it("requires the configured directory to exist and match the launching process", () => {
  const f = fixture(), agent = join(f.home, "custom-agent");
  expect(f.run(agent, `PI_CODING_AGENT_DIR=${agent}\n`, false, f.home, f.home, agent).reply.value).toBe("custom");
  mkdirSync(agent, { mode: 0o700 });
  expect(f.run(agent, `PI_CODING_AGENT_DIR=${agent}\n`, false, f.home, f.home, agent).reply.value).toBe("default");
  expect(f.run(undefined, `PI_CODING_AGENT_DIR=${agent}\n`, false, f.home, f.home, agent).reply.value).toBe("custom");
  expect(f.run(agent, "", false, f.home, f.home, agent).reply.value).toBe("default");
  expect(f.run(agent, "PI_CODING_AGENT_DIR=\n", false, f.home, f.home, agent).reply.value).toBe("default");
  expect(f.run(agent, `PI_CODING_AGENT_DIR=${join(f.home, "other-agent")}\n`, false, f.home, f.home, agent).reply.value).toBe("custom");
  expect(f.run(agent, `PI_CODING_AGENT_DIR=${agent}\nPI_CODING_AGENT_DIR=${agent}\n`, false, f.home, f.home, agent).reply.value).toBe("unknown");
  expect(f.run(join(f.home, "wrong"), `PI_CODING_AGENT_DIR=${agent}\n`, false, f.home, f.home, agent).reply.value).toBe("custom");
  expect(f.run(agent, `PI_CODING_AGENT_DIR=${agent}\n`, true, f.home, f.home, agent).reply.value).toBe("unknown");
}, 5000);

it("verifies destination sign-in by metadata without reading credential contents", () => {
  const f = fixture(), agentDir = join(f.home, "agent"), globalRoot = join(f.home, "state"), prefix = join(f.home, "prefix");
  for (const dir of [agentDir, join(globalRoot, "roam"), join(prefix, "bin")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const machineId = "00000000-0000-4000-8000-000000000002", auth = join(agentDir, "auth.json"), audit = join(f.root, "auth-read");
  writeFileSync(join(globalRoot, "roam", "machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  writeFileSync(auth, "contents must not be inspected", { mode: 0o600 });
  const hook = join(f.root, "guard.mjs");
  writeFileSync(hook, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
for(const key of ['openSync','readFileSync']){const original=fs[key];fs[key]=function(file,...args){if(file===${JSON.stringify(auth)}){fs.writeFileSync(${JSON.stringify(audit)},'read');throw new Error('auth-read-forbidden');}return original(file,...args);};}syncBuiltinESMExports();`);
  const run = () => {
    const request = { action: "verify", operationId: "metadata-only", machineId, home: f.home, agentDir, globalRoot, npmPrefix: prefix,
      unitDir: join(f.home, ".config/systemd/user"), cli: join(prefix, "lib/package/dist/roam/cli.mjs"), pi: join(prefix, "bin/pi"),
      providers: [], files: [], maximum: 1024 * 1024, chunkBytes: 1024 };
    const child = spawnSync(process.execPath, ["--import", hook, "--input-type=module-typescript", "-e", PROVISION_REMOTE_SCRIPT], {
      input: JSON.stringify(request), cwd: f.home, env: { ...process.env, HOME: f.home }, encoding: "utf8", timeout: 3000,
    });
    expect(child.status).toBe(0); return JSON.parse(child.stdout);
  };
  expect(run()).toMatchObject({ value: { piSignedIn: true } }); expect(existsSync(audit)).toBe(false);
  for (const mode of [0o400, 0o000, 0o644, 0o1600]) {
    chmodSync(auth, mode);
    expect(run()).toMatchObject({ value: { piSignedIn: false, privateModes: false } }); expect(existsSync(audit)).toBe(false);
  }
}, 5000);
