import { afterEach, expect, it } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as release from "../release-receipt";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Input = { directory: string; operationId: string; digest: string; owner: { pid: number; bootId: string; start: string } };
type Begin = (input: Input) => { kind: "acquired"; token: string } | { kind: "duplicate"; state: "started" | "finished" | "failed" };
type Finish = (input: Input, token: string, outcome: { state: "finished"; value: { pi: string; cli: string; supervisor: string } } | { state: "failed"; reason: string }) => void;
type Inspect = (input: Omit<Input, "owner">, probe: (owner: Input["owner"]) => "live" | "absent" | "unknown") =>
  { state: "absent" | "started" | "failed"; reason?: string } | { state: "finished"; value: { pi: string; cli: string; supervisor: string } };
const api = release as { beginRelease?: Begin; finishRelease?: Finish; inspectRelease?: Inspect };
function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "release-receipt-")); roots.push(directory);
  return { directory, operationId: "install-1", digest: "a".repeat(64), owner: { pid: 123, bootId: "fixture-boot", start: "42" } };
}
const installed = { pi: "/home/fixture/bin/pi", cli: "/home/fixture/cli.mjs", supervisor: "/home/fixture/supervisor.mjs" };

it("runs effects once across a concurrent and a completed duplicate launch", () => {
  expect(api.beginRelease).toBeTypeOf("function"); expect(api.finishRelease).toBeTypeOf("function"); expect(api.inspectRelease).toBeTypeOf("function");
  const f = fixture(), first = api.beginRelease!(f); expect(first.kind).toBe("acquired");
  const started = JSON.parse(readFileSync(join(f.directory, "release-receipt.json"), "utf8")); expect(started.state).toBe("started");
  expect(api.beginRelease!(f)).toMatchObject({ kind: "duplicate", state: "started" });
  let effects = 0; if (first.kind === "acquired") { effects++; api.finishRelease!(f, first.token, { state: "finished", value: installed }); }
  expect(api.beginRelease!(f)).toMatchObject({ kind: "duplicate", state: "finished" });
  expect(api.inspectRelease!(f, () => "absent")).toEqual({ state: "finished", value: installed });
  expect(effects).toBe(1);
}, 5000);

it("trusts a terminal receipt while a same-ID duplicate briefly holds another lock", () => {
  expect(api.beginRelease).toBeTypeOf("function"); expect(api.finishRelease).toBeTypeOf("function"); expect(api.inspectRelease).toBeTypeOf("function");
  const f = fixture(), first = api.beginRelease!(f);
  if (first.kind === "acquired") api.finishRelease!(f, first.token, { state: "finished", value: installed });
  writeFileSync(join(f.directory, "release.lock"), JSON.stringify({ version: 1, operationId: f.operationId, digest: f.digest, owner: f.owner,
    token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), { mode: 0o600 });
  expect(api.inspectRelease!(f, () => "live")).toEqual({ state: "finished", value: installed });
  expect(api.beginRelease!(f)).toMatchObject({ kind: "duplicate", state: "finished" });
}, 5000);

it("recovers an interrupted atomic lock publication without replacing its owner", () => {
  expect(api.beginRelease).toBeTypeOf("function"); expect(api.inspectRelease).toBeTypeOf("function");
  const f = fixture(); api.beginRelease!(f);
  const temporary = join(f.directory, ".release-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp");
  linkSync(join(f.directory, "release.lock"), temporary);
  expect(api.inspectRelease!(f, () => "live")).toEqual({ state: "started" });
  expect(existsSync(temporary)).toBe(false);
}, 5000);

it("refuses an operation ID reused with different release arguments", () => {
  expect(api.beginRelease).toBeTypeOf("function"); expect(api.inspectRelease).toBeTypeOf("function");
  const f = fixture(); api.beginRelease!(f);
  const changed = { ...f, digest: "b".repeat(64) };
  expect(() => api.beginRelease!(changed)).toThrow(expect.objectContaining({ code: "release-arguments-changed" }));
  expect(() => api.inspectRelease!(changed, () => "live")).toThrow(expect.objectContaining({ code: "release-arguments-changed" }));
}, 5000);

it("does not replace a finished receipt when the installer exits during observation", () => {
  expect(api.beginRelease).toBeTypeOf("function"); expect(api.finishRelease).toBeTypeOf("function"); expect(api.inspectRelease).toBeTypeOf("function");
  const f = fixture(), first = api.beginRelease!(f); expect(first.kind).toBe("acquired");
  const result = api.inspectRelease!(f, () => {
    if (first.kind === "acquired") api.finishRelease!(f, first.token, { state: "finished", value: installed });
    return "absent";
  });
  expect(result).toEqual({ state: "finished", value: installed });
  expect(JSON.parse(readFileSync(join(f.directory, "release-receipt.json"), "utf8")).state).toBe("finished");
}, 5000);

it("turns a proved mid-install crash into a durable failure without replaying effects", () => {
  expect(api.beginRelease).toBeTypeOf("function"); expect(api.inspectRelease).toBeTypeOf("function");
  const f = fixture(); let effects = 0; const first = api.beginRelease!(f); if (first.kind === "acquired") effects++;
  expect(api.inspectRelease!(f, () => "unknown")).toMatchObject({ state: "started" });
  expect(api.inspectRelease!(f, () => "absent")).toEqual({ state: "failed", reason: "installer-interrupted" });
  expect(JSON.parse(readFileSync(join(f.directory, "release-receipt.json"), "utf8"))).toMatchObject({ state: "failed", reason: "installer-interrupted" });
  expect(api.beginRelease!(f)).toMatchObject({ kind: "duplicate", state: "failed" });
  expect(effects).toBe(1);
}, 5000);

it("reconciles a crash between lock creation and the started receipt", () => {
  expect(api.beginRelease).toBeTypeOf("function"); expect(api.inspectRelease).toBeTypeOf("function");
  const f = fixture(); api.beginRelease!(f); unlinkSync(join(f.directory, "release-receipt.json"));
  expect(api.inspectRelease!(f, () => "live")).toMatchObject({ state: "started" });
  expect(api.inspectRelease!(f, () => "absent")).toEqual({ state: "failed", reason: "installer-interrupted" });
  expect(api.beginRelease!(f)).toMatchObject({ kind: "duplicate", state: "failed" });
}, 5000);
