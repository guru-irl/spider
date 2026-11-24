import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { scratchDbPath } from "@spider/db-core/testutil";
import { installHubService, removeHubService } from "../launchd";
import * as launchd from "../launchd";
import { runLocalDoctor } from "../local-diagnostics";

const failures = vi.hoisted(() => ({ sync: false }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync(fd: number) {
    if (failures.sync) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return actual.fsyncSync(fd);
  } };
});
const roots: string[] = [];
afterEach(() => { failures.sync = false; vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const parent = dirname(scratchDbPath("roam-launchd"));
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "launchd-")); roots.push(root);
  const node = join(root, "node & runtime"), cli = join(root, "spider <cli>"), pi = join(root, "pi");
  writeFileSync(pi, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); vi.stubEnv("SPIDER_ROAM_PI", pi);
  writeFileSync(node, "fixture node", { mode: 0o700 });
  writeFileSync(cli, "fixture cli", { mode: 0o700 });
  const plistDir = join(root, "launch-agents"), globalRoot = join(root, "global");
  const calls: string[][] = [];
  return { root, node, cli, pi, plistDir, globalRoot, calls, ports: {
    plistDir,
    async launchctl(argv: readonly string[]) { calls.push([...argv]); },
  } };
}
function plistAt(directory: string, root: string) { return join(directory, `${launchd.hubServiceLabel(root)}.plist`); }
function decode(value: string) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function plist(file: string) {
  const xml = readFileSync(file, "utf8");
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1];
  return {
    RunAtLoad: /<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(xml),
    KeepAlive: /<key>KeepAlive<\/key>\s*<true\s*\/>/.test(xml),
    ProgramArguments: [...(args ?? "").matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => decode(match[1])),
    xml,
  };
}

it("different roots install independent labels and remove only their own plist", async () => {
  const f = fixture(), secondRoot = join(f.root, "other-global");
  mkdirSync(f.globalRoot); mkdirSync(secondRoot);
  await installHubService(f, f.ports);
  await expect(installHubService({ ...f, globalRoot: secondRoot }, f.ports)).resolves.toBeUndefined();
  const name = (root: string) => `com.spider.roam.hub.${createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16)}`;
  const first = name(f.globalRoot), second = name(secondRoot);
  expect(first).not.toBe(second);
  expect(readdirSync(f.plistDir).sort()).toEqual([`${first}.plist`, `${second}.plist`].sort());
  expect(plist(join(f.plistDir, `${first}.plist`)).xml).toContain(`<key>Label</key><string>${first}</string>`);
  expect(plist(join(f.plistDir, `${second}.plist`)).xml).toContain(`<key>Label</key><string>${second}</string>`);
  await removeHubService({ globalRoot: f.globalRoot }, f.ports);
  expect(existsSync(join(f.plistDir, `${first}.plist`))).toBe(false);
  expect(existsSync(join(f.plistDir, `${second}.plist`))).toBe(true);
  await removeHubService({ globalRoot: secondRoot }, f.ports);
  expect(readdirSync(f.plistDir)).toEqual([]);
}, 5000);

it("the default root keeps the production label beside a non-default root", async () => {
  const f = fixture(); vi.stubEnv("HOME", f.root);
  const defaultRoot = join(f.root, ".pi", "agent", "spider");
  await installHubService({ ...f, globalRoot: defaultRoot }, f.ports);
  await expect(installHubService(f, f.ports)).resolves.toBeUndefined();
  const file = join(f.plistDir, "com.spider.roam.hub.plist");
  expect(plist(file).xml).toContain("<key>Label</key><string>com.spider.roam.hub</string>");
  expect(readdirSync(f.plistDir)).toHaveLength(2);
  await removeHubService({ globalRoot: f.globalRoot }, f.ports);
  expect(existsSync(file)).toBe(true);
  await removeHubService({ globalRoot: defaultRoot }, f.ports);
  expect(existsSync(file)).toBe(false);
}, 5000);

it("canonical root aliases select the same service label", () => {
  const f = fixture(); mkdirSync(f.globalRoot);
  const alias = join(f.root, "alias"); symlinkSync(f.globalRoot, alias);
  const label = (launchd as { hubServiceLabel?: (root: string) => string }).hubServiceLabel;
  expect(typeof label).toBe("function");
  expect(label!(alias)).toBe(label!(f.globalRoot));
  expect(label!(join(alias, "future"))).toBe(label!(join(f.globalRoot, "future")));
}, 5000);

it("migrates only a legacy plist owned by the selected non-default root", async () => {
  const f = fixture(); mkdirSync(f.plistDir);
  const legacy = join(f.plistDir, "com.spider.roam.hub.plist");
  const definition = (root: string) => `<plist><dict><key>Label</key><string>com.spider.roam.hub</string><key>ProgramArguments</key><array><string>/home/fixture/node</string><string>/home/fixture/cli</string><string>roam</string><string>hub</string></array><key>SPIDER_GLOBAL_ROOT</key><string>${root}</string></dict></plist>`;
  writeFileSync(legacy, definition(f.globalRoot), { mode: 0o600 });
  await installHubService(f, f.ports);
  expect(existsSync(legacy)).toBe(false);
  expect(readdirSync(f.plistDir)).toHaveLength(1);
  await removeHubService({ globalRoot: f.globalRoot }, f.ports);
  writeFileSync(legacy, definition("/home/fixture/other"), { mode: 0o600 });
  await installHubService(f, f.ports);
  await removeHubService({ globalRoot: f.globalRoot }, f.ports);
  expect(readFileSync(legacy, "utf8")).toBe(definition("/home/fixture/other"));
}, 5000);

it("keeps an owned legacy service if its replacement pi is unavailable", async () => {
  const f = fixture(); mkdirSync(f.plistDir);
  const legacy = join(f.plistDir, "com.spider.roam.hub.plist");
  const definition = `<plist><dict><key>Label</key><string>com.spider.roam.hub</string><key>ProgramArguments</key><array><string>/home/fixture/node</string><string>/home/fixture/cli</string><string>roam</string><string>hub</string></array><key>SPIDER_GLOBAL_ROOT</key><string>${f.globalRoot}</string></dict></plist>`;
  writeFileSync(legacy, definition, { mode: 0o600 }); vi.stubEnv("SPIDER_ROAM_PI", "");
  await expect(installHubService({ ...f, pi: undefined }, f.ports)).rejects.toThrow("participant-pi-unavailable");
  expect(existsSync(legacy)).toBe(true);
  expect(readFileSync(legacy, "utf8")).toBe(definition);
  expect(f.calls).toEqual([]);
}, 5000);

it("enable writes resolved absolute executable paths", async () => {
  const f = fixture();
  const link = join(f.root, "node-link"); symlinkSync(f.node, link);
  await installHubService({ node: link, cli: f.cli, globalRoot: f.globalRoot }, f.ports);
  const result = plist(plistAt(f.plistDir, f.globalRoot));
  expect(result).toMatchObject({ RunAtLoad: true, KeepAlive: true });
  expect(result.ProgramArguments).toEqual([realpathSync(f.node), realpathSync(f.cli), "roam", "hub"]);
  expect(result.xml).toContain("node &amp; runtime");
  expect(result.xml).toContain("spider &lt;cli&gt;");
  expect(result.xml).toContain(`<string>${f.globalRoot}</string>`);
  const writtenPlistDir = dirname(f.calls.at(-1)!.at(-1)!);
  expect(writtenPlistDir).toBe(f.plistDir);
  expect(f.calls.map(call => call[0])).toEqual(["bootout", "bootstrap"]);
  expect(lstatSync(plistAt(f.plistDir, f.globalRoot)).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(f.globalRoot, "roam", "logs", "hub.out.log")).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(f.globalRoot, "roam", "logs", "hub.err.log")).mode & 0o777).toBe(0o600);
}, 5000);

it("enable repairs changed supported Node path", async () => {
  const f = fixture();
  await installHubService(f, f.ports);
  const replacement = join(f.root, "replacement-node");
  writeFileSync(replacement, "new fixture node", { mode: 0o700 });
  await installHubService({ ...f, node: replacement }, f.ports);
  expect(plist(plistAt(f.plistDir, f.globalRoot)).ProgramArguments[0]).toBe(realpathSync(replacement));
  expect(f.calls.map(call => call[0])).toEqual(["bootout", "bootstrap", "bootout", "bootstrap"]);
}, 5000);

it("enable retains log contents and tolerates a service that is not loaded", async () => {
  const f = fixture();
  const ports = { ...f.ports, async launchctl(argv: readonly string[]) {
    f.calls.push([...argv]);
    if (argv[0] === "bootout") throw Object.assign(new Error("not loaded"), { code: "service-not-loaded" });
  } };
  await installHubService(f, ports);
  writeFileSync(join(f.globalRoot, "roam", "logs", "hub.out.log"), "previous log\n");
  await installHubService(f, ports);
  expect(readFileSync(join(f.globalRoot, "roam", "logs", "hub.out.log"), "utf8")).toBe("previous log\n");
  expect(f.calls.map(call => call[0])).toEqual(["bootout", "bootstrap", "bootout", "bootstrap"]);
}, 5000);

it("refuses unsafe destinations or executables before calling launchctl", async () => {
  const f = fixture();
  await expect(installHubService({ ...f, node: "relative-node" }, f.ports)).rejects.toThrow(/absolute/i);
  chmodSync(f.node, 0o600);
  await expect(installHubService(f, f.ports)).rejects.toThrow(/executable/i);
  chmodSync(f.node, 0o700);
  mkdirSync(f.plistDir);
  const target = join(f.root, "existing"); writeFileSync(target, "untouched");
  symlinkSync(target, plistAt(f.plistDir, f.globalRoot));
  await expect(installHubService(f, f.ports)).rejects.toThrow(/unsafe|symlink/i);
  expect(readFileSync(target, "utf8")).toBe("untouched");
  expect(f.calls).toEqual([]);
}, 5000);

it("enable refuses to replace an unrelated service definition", async () => {
  const f = fixture(); mkdirSync(f.plistDir);
  writeFileSync(plistAt(f.plistDir, f.globalRoot), "unrelated service", { mode: 0o600 });
  await expect(installHubService(f, f.ports)).rejects.toThrow(/unrelated|unsafe/i);
  expect(readFileSync(plistAt(f.plistDir, f.globalRoot), "utf8")).toBe("unrelated service");
  expect(f.calls).toEqual([]);
}, 5000);

it("disable boots out its own service and never removes an unrelated definition", async () => {
  const f = fixture(); await installHubService(f, f.ports);
  await removeHubService({ globalRoot: f.globalRoot }, f.ports);
  expect(existsSync(plistAt(f.plistDir, f.globalRoot))).toBe(false);
  expect(f.calls.map(call => call[0])).toEqual(["bootout", "bootstrap", "bootout"]);
  await removeHubService({ globalRoot: f.globalRoot }, f.ports);
  expect(f.calls).toHaveLength(3);
  writeFileSync(plistAt(f.plistDir, f.globalRoot), "unrelated service", { mode: 0o600 });
  await expect(removeHubService({ globalRoot: f.globalRoot }, f.ports)).rejects.toThrow(/unrelated|unsafe/i);
  expect(readFileSync(plistAt(f.plistDir, f.globalRoot), "utf8")).toBe("unrelated service");
  expect(f.calls).toHaveLength(3);
}, 5000);

it("rejects control characters in resolved executable paths", async () => {
  const f = fixture();
  const unsafe = join(f.root, "node\x01unsafe"), alias = join(f.root, "safe-link");
  writeFileSync(unsafe, "#!/bin/sh\n", { mode: 0o700 }); symlinkSync(unsafe, alias);
  for (const node of [unsafe, alias]) {
    await expect(installHubService({ ...f, node }, f.ports)).rejects.toThrow(/absolute.*path/i);
  }
  expect(f.calls).toEqual([]);
  expect(existsSync(f.plistDir)).toBe(false);
}, 5000);

it("a failed plist write keeps the previous definition and removes its temporary file", async () => {
  const f = fixture(); await installHubService(f, f.ports);
  const previous = readFileSync(plistAt(f.plistDir, f.globalRoot), "utf8");
  failures.sync = true;
  await expect(installHubService(f, f.ports)).rejects.toThrow(/disk full/);
  expect(readFileSync(plistAt(f.plistDir, f.globalRoot), "utf8")).toBe(previous);
  expect(readdirSync(f.plistDir)).toEqual([`${launchd.hubServiceLabel(f.globalRoot)}.plist`]);
  expect(f.calls.map(call => call[0])).toEqual(["bootout", "bootstrap"]);
}, 5000);

it("reports an unexpected service failure without attempting bootstrap", async () => {
  const f = fixture();
  const ports = { ...f.ports, async launchctl(argv: readonly string[]) {
    f.calls.push([...argv]); throw new Error("fixture launchd failure");
  } };
  await expect(installHubService(f, ports)).rejects.toThrow(/fixture launchd failure/);
  expect(f.calls.map(call => call[0])).toEqual(["bootout"]);
}, 5000);

it("preserves the default definition apart from its stable working directory", async () => {
  const f = fixture(); vi.stubEnv("HOME", f.root);
  await installHubService({ ...f, env: { HOME: f.root } }, f.ports);
  const text = plist(plistAt(f.plistDir, f.globalRoot)).xml;
  const wd = `<key>WorkingDirectory</key><string>${f.globalRoot}</string>\n`;
  expect(text).toContain(wd);
  expect(text.replace(wd, "")).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${launchd.hubServiceLabel(f.globalRoot)}</string>
<key>ProgramArguments</key><array><string>${realpathSync(f.node).replaceAll("&", "&amp;")}</string><string>${realpathSync(f.cli).replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</string><string>roam</string><string>hub</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>EnvironmentVariables</key><dict><key>SPIDER_GLOBAL_ROOT</key><string>${f.globalRoot}</string><key>SPIDER_ROAM_PI</key><string>${f.pi}</string></dict>
<key>StandardOutPath</key><string>${join(f.globalRoot, "roam/logs/hub.out.log")}</string>
<key>StandardErrorPath</key><string>${join(f.globalRoot, "roam/logs/hub.err.log")}</string>
<key>Umask</key><integer>63</integer>
</dict></plist>\n`);
});

it("pins the selected session and normalized socket without copying unrelated environment", async () => {
  const f = fixture(); vi.stubEnv("HOME", f.root);
  const socket = join(f.root, "custom & core.sock");
  await installHubService({ ...f, env: { HOME: f.root, HC_SESSION: "  team  ", HC_SOCKET: join(f.root, "dir", "..", "custom & core.sock"), SECRET: "do-not-copy" } }, f.ports);
  const text = plist(plistAt(f.plistDir, f.globalRoot)).xml;
  expect(text).toContain(`<key>HC_SESSION</key><string>team</string>`);
  expect(text).toContain(`<key>HC_SOCKET</key><string>${socket.replaceAll("&", "&amp;")}</string>`);
  expect(text).not.toContain("do-not-copy");
});

it("pins a socket selected through XDG config and rejects unsafe selection", async () => {
  const f = fixture(); vi.stubEnv("HOME", f.root);
  const config = join(f.root, "alternate-config", "herdr-core"), socket = join(f.root, "configured.sock");
  mkdirSync(config, { recursive: true }); writeFileSync(join(config, "config.toml"), `socket = "${socket}"\n`);
  await installHubService({ ...f, env: { HOME: f.root, XDG_CONFIG_HOME: dirname(config) } }, f.ports);
  expect(plist(plistAt(f.plistDir, f.globalRoot)).xml).toContain(`<key>HC_SOCKET</key><string>${socket}</string>`);
  expect(plist(plistAt(f.plistDir, f.globalRoot)).xml).toContain("<key>HC_SESSION</key><string>default</string>");
  for (const env of [{ HOME: f.root, HC_SESSION: "../bad", HC_SOCKET: socket }, { HOME: f.root, HC_SOCKET: "relative.sock" }, { HOME: f.root, HC_SOCKET: "/home/fixture/bad\npath" },
    { HOME: f.root, HC_SESSION: "bad\ufffe", HC_SOCKET: socket }, { HOME: f.root, HC_SOCKET: "/home/fixture/bad\ud800" }]) {
    await expect(installHubService({ ...f, env }, f.ports)).rejects.toThrow();
  }
});

it.each(["session", "runtime", "state", "home", "socket-precedence"]) ("preserves the effective %s selection", async source => {
  const f = fixture(); vi.stubEnv("HOME", f.root);
  const otherHome = join(f.root, "other-home"), runtime = join(f.root, "run"), state = join(f.root, "state"), socket = join(f.root, "override.sock");
  const env = source === "session" ? { HOME: f.root, HC_SESSION: "team" }
    : source === "runtime" ? { HOME: f.root, XDG_RUNTIME_DIR: runtime }
    : source === "state" ? { HOME: f.root, XDG_STATE_HOME: state, XDG_RUNTIME_DIR: "" }
    : source === "home" ? { HOME: otherHome, XDG_RUNTIME_DIR: "" }
    : { HOME: f.root, HC_SOCKET: socket, XDG_CONFIG_HOME: join(f.root, "bad-config") };
  if (source === "socket-precedence") {
    mkdirSync(join(f.root, "bad-config", "herdr-core"), { recursive: true });
    writeFileSync(join(f.root, "bad-config", "herdr-core", "config.toml"), "socket = invalid\n");
  }
  await installHubService({ ...f, env }, f.ports);
  const text = plist(plistAt(f.plistDir, f.globalRoot)).xml;
  const { selectedSocket } = await import("@spider/herdr/client/parse");
  expect(text).toContain(`<key>HC_SOCKET</key><string>${selectedSocket(env)}</string>`);
  if (source === "session") expect(text).toContain("<key>HC_SESSION</key><string>team</string>");
});

it("preserves a shell HOME selection that differs from the service manager home", async () => {
  const f = fixture(), shellHome = join(f.root, "shell-home"); vi.stubEnv("HOME", shellHome);
  const ports = { ...f.ports, serviceHome: f.root }, env = { HOME: shellHome };
  await installHubService({ ...f, env }, ports);
  const file = plistAt(f.plistDir, f.globalRoot), text = readFileSync(file, "utf8");
  const { selectedSocket } = await import("@spider/herdr/client/parse");
  expect(text).toContain(`<key>HC_SOCKET</key><string>${selectedSocket(env)}</string>`);
  expect(launchd.hubServiceSelectionMatches(f.globalRoot, f.plistDir, env, f.root)).toBe(true);
  writeFileSync(file, text.replace(/<key>HC_SESSION<\/key><string>[^<]*<\/string>/, "").replace(/<key>HC_SOCKET<\/key><string>[^<]*<\/string>/, ""));
  expect(launchd.hubServiceSelectionMatches(f.globalRoot, f.plistDir, env, f.root)).toBe(false);
});

it("pins a socket configured in the default config home across config changes", async () => {
  const f = fixture(); vi.stubEnv("HOME", f.root);
  mkdirSync(join(f.root, ".config", "herdr-core"), { recursive: true });
  const config = join(f.root, ".config", "herdr-core", "config.toml"), socket = join(f.root, "selected.sock");
  writeFileSync(config, `socket = "${socket}"\n`);
  await installHubService({ ...f, env: { HOME: f.root } }, f.ports);
  expect(plist(plistAt(f.plistDir, f.globalRoot)).xml).toContain(`<key>HC_SOCKET</key><string>${socket}</string>`);
  writeFileSync(config, `socket = "${join(f.root, "changed.sock")}"\n`);
  expect(launchd.hubServiceSelectionMatches(f.globalRoot, f.plistDir, { HOME: f.root })).toBe(false);
});

it("an explicit socket remains usable when the default socket config is malformed", async () => {
  const f = fixture(); vi.stubEnv("HOME", f.root);
  mkdirSync(join(f.root, ".config", "herdr-core"), { recursive: true });
  writeFileSync(join(f.root, ".config", "herdr-core", "config.toml"), "socket = invalid\n");
  const socket = join(f.root, "selected.sock");
  await expect(installHubService({ ...f, env: { HOME: f.root, HC_SOCKET: socket } }, f.ports)).resolves.toBeUndefined();
  expect(plist(plistAt(f.plistDir, f.globalRoot)).xml).toContain(`<key>HC_SOCKET</key><string>${socket}</string>`);
});

it("doctor compares installed, current and legacy hub selections", async () => {
  const f = fixture(); vi.stubEnv("HOME", f.root);
  for (const key of ["HC_SESSION", "HC_SOCKET", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME"]) vi.stubEnv(key, undefined);
  const plistDir = join(f.root, "Library", "LaunchAgents"), socket = join(f.root, "selected.sock");
  const ports = { ...f.ports, plistDir };
  mkdirSync(join(f.globalRoot, "roam"), { recursive: true });
  writeFileSync(join(f.globalRoot, "roam", "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId: "00000000-0000-4000-8000-000000000001", hubMachineId: "00000000-0000-4000-8000-000000000001", coreUnit: "fixture.service", peers: [] }), { mode: 0o600 });
  vi.stubEnv("HC_SOCKET", socket); vi.stubEnv("HC_SESSION", "team");
  await installHubService({ ...f, env: { HOME: f.root, HC_SOCKET: socket, HC_SESSION: "team" } }, ports);
  const reasons = async () => (await runLocalDoctor({ root: f.globalRoot })).diagnostics.filter(row => row.reason.includes("hub-core-selection"));
  expect(await reasons()).toEqual([]);
  vi.stubEnv("HC_SESSION", "other-team");
  expect(await reasons()).toEqual([expect.objectContaining({ reason: expect.stringContaining("hub-core-selection-mismatch"), repairCommand: "spider roam enable" })]);
  vi.stubEnv("HC_SESSION", "team"); vi.stubEnv("HC_SOCKET", join(f.root, "other.sock"));
  expect(await reasons()).toEqual([expect.objectContaining({ reason: expect.stringContaining("hub-core-selection-mismatch"), repairCommand: "spider roam enable" })]);
  const file = plistAt(plistDir, f.globalRoot), installed = readFileSync(file, "utf8");
  writeFileSync(file, installed.replace(/<key>HC_SESSION<\/key><string>[^<]*<\/string>/, "").replace(/<key>HC_SOCKET<\/key><string>[^<]*<\/string>/, ""));
  expect(await reasons()).toEqual([expect.objectContaining({ reason: expect.stringContaining("hub-core-selection-mismatch"), repairCommand: "spider roam enable" })]);
  vi.stubEnv("HC_SOCKET", undefined); vi.stubEnv("HC_SESSION", undefined);
  expect(await reasons()).toEqual([]);
});

it("accepts valid supplementary Unicode in the selected session and socket", async () => {
  const f = fixture(); vi.stubEnv("HOME", f.root);
  const env = { HOME: f.root, HC_SOCKET: join(f.root, "core-🌿.sock"), HC_SESSION: "team-🌿" };
  await installHubService({ ...f, env }, f.ports);
  expect(launchd.hubServiceSelectionMatches(f.globalRoot, f.plistDir, env)).toBe(true);
});

it("doctor compares XML-escaped socket paths and session names", async () => {
  const f = fixture(); vi.stubEnv("HOME", f.root);
  const env = { HOME: f.root, HC_SOCKET: join(f.root, "a & b.sock"), HC_SESSION: "a & b" };
  await installHubService({ ...f, env }, f.ports);
  expect(launchd.hubServiceSelectionMatches(f.globalRoot, f.plistDir, env)).toBe(true);
  expect(launchd.hubServiceSelectionMatches(f.globalRoot, f.plistDir, { ...env, HC_SESSION: "other" })).toBe(false);
});

it("doctor warns rather than guessing when a service environment is malformed", async () => {
  const f = fixture(); vi.stubEnv("HOME", f.root);
  const plistDir = join(f.root, "Library", "LaunchAgents"), env = { HOME: f.root, HC_SOCKET: join(f.root, "selected.sock") };
  mkdirSync(join(f.globalRoot, "roam"), { recursive: true });
  writeFileSync(join(f.globalRoot, "roam", "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId: "00000000-0000-4000-8000-000000000001", hubMachineId: "00000000-0000-4000-8000-000000000001", coreUnit: "fixture.service", peers: [] }), { mode: 0o600 });
  await installHubService({ ...f, env }, { ...f.ports, plistDir });
  const file = plistAt(plistDir, f.globalRoot), text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace("</dict>\n<key>StandardOutPath", "<key>HC_SOCKET</key><string>/home/fixture/another.sock</string></dict>\n<key>StandardOutPath"));
  const diagnostics = (await runLocalDoctor({ root: f.globalRoot })).diagnostics;
  expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("hub-core-selection-unavailable"), repairCommand: null })]));
  expect(JSON.stringify(diagnostics)).not.toContain("/home/fixture/another.sock");
});

it("the installed hub pins the same pi PATH resolution as ordinary session launches", async () => {
  const { resolveParticipantPi } = await import("../launcher");
  const f = fixture(); vi.stubEnv("SPIDER_ROAM_PI", undefined); vi.stubEnv("PATH", f.root);
  expect(resolveParticipantPi()).toBe(f.pi);
  await installHubService(f, f.ports);
  expect(plist(plistAt(f.plistDir, f.globalRoot)).xml).toContain(`<key>SPIDER_ROAM_PI</key><string>${f.pi}</string>`);
}, 5000);
