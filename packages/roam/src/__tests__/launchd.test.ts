import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { scratchDbPath } from "@spider/db-core/testutil";
import { installHubService, removeHubService } from "../launchd";
import * as launchd from "../launchd";

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
function plistAt(directory: string) { return join(directory, "com.spider.roam.hub.plist"); }
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
}, 5000);

it("enable writes resolved absolute executable paths", async () => {
  const f = fixture();
  const link = join(f.root, "node-link"); symlinkSync(f.node, link);
  await installHubService({ node: link, cli: f.cli, globalRoot: f.globalRoot }, f.ports);
  const result = plist(plistAt(f.plistDir));
  expect(result).toMatchObject({ RunAtLoad: true, KeepAlive: true });
  expect(result.ProgramArguments).toEqual([realpathSync(f.node), realpathSync(f.cli), "roam", "hub"]);
  expect(result.xml).toContain("node &amp; runtime");
  expect(result.xml).toContain("spider &lt;cli&gt;");
  expect(result.xml).toContain(`<string>${f.globalRoot}</string>`);
  const writtenPlistDir = dirname(f.calls.at(-1)!.at(-1)!);
  expect(writtenPlistDir).toBe(f.plistDir);
  expect(f.calls.map(call => call[0])).toEqual(["bootout", "bootstrap"]);
  expect(lstatSync(plistAt(f.plistDir)).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(f.globalRoot, "roam", "logs", "hub.out.log")).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(f.globalRoot, "roam", "logs", "hub.err.log")).mode & 0o777).toBe(0o600);
}, 5000);

it("enable repairs changed supported Node path", async () => {
  const f = fixture();
  await installHubService(f, f.ports);
  const replacement = join(f.root, "replacement-node");
  writeFileSync(replacement, "new fixture node", { mode: 0o700 });
  await installHubService({ ...f, node: replacement }, f.ports);
  expect(plist(plistAt(f.plistDir)).ProgramArguments[0]).toBe(realpathSync(replacement));
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
  symlinkSync(target, plistAt(f.plistDir));
  await expect(installHubService(f, f.ports)).rejects.toThrow(/unsafe|symlink/i);
  expect(readFileSync(target, "utf8")).toBe("untouched");
  expect(f.calls).toEqual([]);
}, 5000);

it("enable refuses to replace an unrelated service definition", async () => {
  const f = fixture(); mkdirSync(f.plistDir);
  writeFileSync(plistAt(f.plistDir), "unrelated service", { mode: 0o600 });
  await expect(installHubService(f, f.ports)).rejects.toThrow(/unrelated|unsafe/i);
  expect(readFileSync(plistAt(f.plistDir), "utf8")).toBe("unrelated service");
  expect(f.calls).toEqual([]);
}, 5000);

it("disable boots out its own service and never removes an unrelated definition", async () => {
  const f = fixture(); await installHubService(f, f.ports);
  await removeHubService({ globalRoot: f.globalRoot }, f.ports);
  expect(existsSync(plistAt(f.plistDir))).toBe(false);
  expect(f.calls.map(call => call[0])).toEqual(["bootout", "bootstrap", "bootout"]);
  await removeHubService({ globalRoot: f.globalRoot }, f.ports);
  expect(f.calls).toHaveLength(3);
  writeFileSync(plistAt(f.plistDir), "unrelated service", { mode: 0o600 });
  await expect(removeHubService({ globalRoot: f.globalRoot }, f.ports)).rejects.toThrow(/unrelated|unsafe/i);
  expect(readFileSync(plistAt(f.plistDir), "utf8")).toBe("unrelated service");
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
  const previous = readFileSync(plistAt(f.plistDir), "utf8");
  failures.sync = true;
  await expect(installHubService(f, f.ports)).rejects.toThrow(/disk full/);
  expect(readFileSync(plistAt(f.plistDir), "utf8")).toBe(previous);
  expect(readdirSync(f.plistDir)).toEqual(["com.spider.roam.hub.plist"]);
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

it("the installed hub pins the same pi PATH resolution as ordinary session launches", async () => {
  const { resolveParticipantPi } = await import("../launcher");
  const f = fixture(); vi.stubEnv("SPIDER_ROAM_PI", undefined); vi.stubEnv("PATH", f.root);
  expect(resolveParticipantPi()).toBe(f.pi);
  await installHubService(f, f.ports);
  expect(plist(plistAt(f.plistDir)).xml).toContain(`<key>SPIDER_ROAM_PI</key><string>${f.pi}</string>`);
}, 5000);
