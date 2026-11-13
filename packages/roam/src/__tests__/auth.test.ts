import { afterEach, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as auth from "../auth";
import type { Journal, Peer } from "../contracts";
import { bootstrapPeer } from "./bootstrap-fixture";

type Stage = { file: string };
type Ports = { stage(bytes: Buffer): Promise<Stage>; install(stage: Stage, providers: readonly string[]): Promise<void>; remove(stage: Stage): Promise<void> };
type Copy = (input: { sourceRoot: string; peer: Peer; operationId: string; providers: readonly string[]; journal: Journal; maxBytes: number }, ports: Ports) => Promise<void>;
type Install = (input: { destinationRoot: string; stagingRoot: string; stagedFile: string; providers: readonly string[] }) => void;
const copy = (auth as { copyPiAuth?: Copy }).copyPiAuth;
const install = (auth as { installPiAuth?: Install }).installPiAuth;
const roots: string[] = [];

function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "auth-copy-")); roots.push(root);
  const sourceRoot = join(root, "source"), destinationRoot = join(root, "destination"), stagingRoot = join(root, "staging");
  for (const dir of [sourceRoot, destinationRoot, stagingRoot]) mkdirSync(dir, { mode: 0o700 });
  const actions: { action: string; result: Parameters<Journal["record"]>[2] }[] = [], events: string[] = [];
  const journal: Journal = {
    begin() { return { kind: "pending", result: null }; },
    record(_id, action, result) { actions.push({ action, result }); }, read() { return actions; },
  };
  const file = join(stagingRoot, "auth.stage");
  const ports: Ports = {
    async stage(bytes) { events.push("stage"); writeFileSync(file, bytes, { mode: 0o600 }); return { file }; },
    async install(stage, providers) { events.push("install"); install!({ destinationRoot, stagingRoot, stagedFile: stage.file, providers }); },
    async remove(stage) { events.push("remove"); rmSync(stage.file); },
  };
  const input = { sourceRoot, peer: bootstrapPeer, operationId: "op-1", providers: ["github-copilot"], journal, maxBytes: 1024 * 1024 };
  const approve = (peer: Peer = bootstrapPeer, providers: readonly string[] = input.providers) => journal.record("op-1", "provision-consent", {
    approved: true, target: peer.alias, machineId: peer.machineId, providers: [...providers],
  });
  return { root, sourceRoot, destinationRoot, stagingRoot, file, journal, ports, input, approve, events };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("rejected consent transfers zero auth bytes and does not read the source", async () => {
  expect(copy).toBeTypeOf("function");
  const f = fixture();
  await expect(copy!({ ...f.input, sourceRoot: join(f.root, "missing") }, f.ports)).rejects.toMatchObject({ code: "consent-required" });
  expect(f.events).toEqual([]);
  expect(existsSync(f.file)).toBe(false);
}, 5000);

it("requires consent for the exact target and every provider", async () => {
  expect(copy).toBeTypeOf("function");
  const f = fixture(); f.approve({ ...bootstrapPeer, alias: "box-2.invalid" });
  await expect(copy!(f.input, f.ports)).rejects.toMatchObject({ code: "consent-required" });
  f.approve(bootstrapPeer, ["other"]);
  await expect(copy!(f.input, f.ports)).rejects.toMatchObject({ code: "consent-required" });
  expect(f.events).toEqual([]);
}, 5000);

it("copies only approved providers with private mode and removes staging", async () => {
  expect(copy).toBeTypeOf("function"); expect(install).toBeTypeOf("function");
  const f = fixture(); f.approve();
  const permitted = { type: "oauth", access: "fixture-secret", refresh: "fixture-refresh", expires: 12345 };
  writeFileSync(join(f.sourceRoot, "auth.json"), JSON.stringify({ "github-copilot": permitted, other: { type: "api_key", key: "other-secret" } }), { mode: 0o600 });
  writeFileSync(join(f.destinationRoot, "auth.json"), JSON.stringify({ local: { type: "api_key", key: "local-secret" } }), { mode: 0o600 });
  await copy!(f.input, f.ports);
  const installed = join(f.destinationRoot, "auth.json");
  expect(JSON.parse(readFileSync(installed, "utf8"))).toEqual({ local: { type: "api_key", key: "local-secret" }, "github-copilot": permitted });
  expect(lstatSync(installed).mode & 0o777).toBe(0o600);
  expect(existsSync(f.file)).toBe(false);
  expect(f.events).toEqual(["stage", "install", "remove"]);
  expect(readFileSync(join(f.destinationRoot, "auth.json.spider-roam.bak"), "utf8")).toContain("local-secret");
}, 5000);

it("cleans secret staging when installation fails", async () => {
  expect(copy).toBeTypeOf("function");
  const f = fixture(); f.approve();
  writeFileSync(join(f.sourceRoot, "auth.json"), JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture-secret" } }), { mode: 0o600 });
  f.ports.install = async () => { throw new Error("fixture-secret"); };
  const error = await copy!(f.input, f.ports).catch(value => value);
  expect(error).toMatchObject({ code: "auth-install-failed" });
  expect(String(error)).not.toContain("fixture-secret");
  expect(existsSync(f.file)).toBe(false);
  expect(f.events).toEqual(["stage", "remove"]);
}, 5000);

it("reports changed auth arguments after cleaning a partial stage", async () => {
  expect(copy).toBeTypeOf("function");
  const f = fixture(); f.approve();
  writeFileSync(join(f.sourceRoot, "auth.json"), JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture-secret" } }), { mode: 0o600 });
  f.ports.stage = async () => { throw Object.assign(new Error("fixture-secret"), { code: "operation-arguments-changed" }); };
  f.ports.remove = async () => { f.events.push("remove"); };
  const error = await copy!(f.input, f.ports).catch(value => value);
  expect(error).toMatchObject({ code: "operation-arguments-changed" });
  expect(String(error)).not.toContain("fixture-secret"); expect(f.events).toEqual(["remove"]);
}, 5000);

it("refuses unsafe auth modes and symlinks before staging", async () => {
  expect(copy).toBeTypeOf("function");
  const f = fixture(); f.approve();
  const file = join(f.sourceRoot, "auth.json"); writeFileSync(file, "{}", { mode: 0o600 }); chmodSync(file, 0o644);
  await expect(copy!(f.input, f.ports)).rejects.toMatchObject({ code: "unsafe-auth" });
  rmSync(file); const target = join(f.root, "outside"); writeFileSync(target, "{}", { mode: 0o600 }); symlinkSync(target, file);
  await expect(copy!(f.input, f.ports)).rejects.toMatchObject({ code: "unsafe-auth" });
  expect(f.events).toEqual([]);
}, 5000);

it("never executes a credential command stored in an auth file", async () => {
  expect(copy).toBeTypeOf("function");
  const f = fixture(); f.approve(); const sentinel = join(f.root, "sentinel");
  writeFileSync(join(f.sourceRoot, "auth.json"), JSON.stringify({ "github-copilot": { type: "api_key", key: `!touch ${sentinel}` } }), { mode: 0o600 });
  await expect(copy!(f.input, f.ports)).rejects.toMatchObject({ code: "unsupported-credential-command" });
  expect(existsSync(sentinel)).toBe(false);
  expect(f.events).toEqual([]);
}, 5000);

it("refuses a staging artifact containing an unapproved provider", () => {
  expect(install).toBeTypeOf("function");
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ "github-copilot": {}, other: { key: "other-secret" } }), { mode: 0o600 });
  expect(() => install!({ destinationRoot: f.destinationRoot, stagingRoot: f.stagingRoot, stagedFile: f.file, providers: ["github-copilot"] })).toThrow();
  expect(existsSync(join(f.destinationRoot, "auth.json"))).toBe(false);
}, 5000);
