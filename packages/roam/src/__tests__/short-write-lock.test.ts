import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";

const interleaving = vi.hoisted(() => ({
  beforeUnlink: null as null | ((file: string) => void),
  beforeRename: null as null | (() => void),
  afterLink: null as null | (() => void),
}));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, unlinkSync(file: import("node:fs").PathLike) {
    interleaving.beforeUnlink?.(String(file));
    return fs.unlinkSync(file);
  }, renameSync(from: import("node:fs").PathLike, to: import("node:fs").PathLike) {
    interleaving.beforeRename?.();
    return fs.renameSync(from, to);
  }, linkSync(from: import("node:fs").PathLike, to: import("node:fs").PathLike) {
    fs.linkSync(from, to);
    interleaving.afterLink?.();
  } };
});
import { join } from "node:path";
import * as receipts from "../release-receipt";

const begin = receipts.beginShortWrite;
const finish = receipts.endShortWrite;
const roots: string[] = [];
function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "short-write-lock-")); roots.push(directory);
  return { directory, operationId: "op-1", digest: "a".repeat(64), owner: { pid: 123, bootId: "fixture", start: "1" } };
}
afterEach(() => {
  interleaving.beforeUnlink = null; interleaving.beforeRename = null; interleaving.afterLink = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("serializes concurrent writes and allows the same operation to retry after release", () => {
  expect(begin).toBeTypeOf("function"); expect(finish).toBeTypeOf("function");
  const f = fixture(), first = begin!(f, () => "live"); expect(first.kind).toBe("acquired");
  if (first.kind !== "acquired") throw new Error("lock not acquired");
  expect(begin!(f, () => "live")).toEqual({ kind: "busy" });
  finish!(f, "wrong-token"); expect(begin!(f, () => "live")).toEqual({ kind: "busy" });
  finish!(f, first.token); const retry = begin!(f, () => "live"); expect(retry.kind).toBe("acquired");
  if (retry.kind !== "acquired") throw new Error("retry lock not acquired");
  finish!(f, retry.token);
}, 5000);

it("competing stale reapers never remove a fresh writer's lock", () => {
  const f = fixture(), stale = begin(f, () => "live");
  if (stale.kind !== "acquired") throw new Error("lock not acquired");
  const next = { ...f, owner: { ...f.owner, pid: 124 } };
  let competing: ReturnType<typeof begin> | undefined;
  interleaving.beforeUnlink = file => {
    if (!file.endsWith(".lock") || JSON.parse(readFileSync(file, "utf8")).token !== stale.token) return;
    interleaving.beforeUnlink = null;
    // Both reapers have observed the dead owner before either removal completes.
    competing = begin({ ...f, owner: { ...f.owner, pid: 125 } }, owner => owner.pid === f.owner.pid ? "absent" : "live");
  };
  const first = begin(next, owner => owner.pid === f.owner.pid ? "absent" : "live");
  expect(competing).toBeDefined();
  const claims = [first, competing!].filter(claim => claim.kind === "acquired");
  expect(claims).toHaveLength(1);
  expect(begin({ ...f, owner: { ...f.owner, pid: 126 } }, () => "live")).toEqual({ kind: "busy" });
  finish(f, stale.token);
  expect(begin(f, () => "live")).toEqual({ kind: "busy" });
  finish(f, claims[0].token);
  expect(begin(f, () => "live").kind).toBe("acquired");
}, 5000);

it("a failed ticket publication does not strand a live choosing writer", () => {
  const f = fixture();
  interleaving.afterLink = () => {
    interleaving.afterLink = null;
    throw Object.assign(new Error("fixture publication failure"), { code: "EIO" });
  };
  expect(() => begin(f, () => "live")).toThrow("fixture publication failure");
  const retry = begin(f, () => "live");
  expect(retry.kind).toBe("acquired");
  if (retry.kind !== "acquired") throw new Error("lock not acquired");
  finish(f, retry.token);
  expect(readdirSync(f.directory)).toEqual([]);
}, 5000);

it("a choosing writer blocks a contender before either enters its critical section", () => {
  const f = fixture();
  let competing: ReturnType<typeof begin> | undefined;
  interleaving.beforeRename = () => {
    interleaving.beforeRename = null;
    competing = begin({ ...f, owner: { ...f.owner, pid: 124 } }, () => "live");
  };
  const first = begin(f, () => "live");
  expect(competing).toEqual({ kind: "busy" });
  expect(first.kind).toBe("acquired");
  expect(begin(f, () => "live")).toEqual({ kind: "busy" });
  if (first.kind !== "acquired") throw new Error("lock not acquired");
  finish(f, first.token);
  expect(begin(f, () => "live").kind).toBe("acquired");
}, 5000);

it("recovers after a reaper exits at stale-lock removal without deleting another writer", async () => {
  const f = fixture(), stale = begin(f, () => "live");
  if (stale.kind !== "acquired") throw new Error("lock not acquired");
  const script = `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const unlink = fs.unlinkSync;
    fs.unlinkSync = file => {
      if (String(file).endsWith('.lock') && JSON.parse(fs.readFileSync(file, 'utf8')).token === ${JSON.stringify(stale.token)}) {
        fs.writeSync(1, 'reaping');
        process.kill(process.pid, 'SIGKILL');
      }
      return unlink(file);
    };
    syncBuiltinESMExports();
    const {beginShortWrite} = await import(${JSON.stringify(new URL("../release-receipt.ts", import.meta.url).href)});
    try { beginShortWrite({...${JSON.stringify(f)},owner:{pid:process.pid,bootId:'fixture',start:'2'}}, () => 'absent'); }
    catch { /* Leave the inspected stale lock in place. */ }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    expect(String((await once(child.stdout!, "data"))[0])).toBe("reaping");
    expect(await exited).toEqual([null, "SIGKILL"]);
    const recovered = begin({ ...f, owner: { ...f.owner, pid: 124 } }, () => "absent");
    expect(recovered.kind).toBe("acquired");
    finish(f, stale.token);
    expect(begin(f, () => "live")).toEqual({ kind: "busy" });
    if (recovered.kind !== "acquired") throw new Error("recovery lock not acquired");
    finish(f, recovered.token);
    expect(readdirSync(f.directory).filter(name => name.endsWith(".lock"))).toEqual([]);
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await exited; }
}, 5000);

it("reclaims only a proved-dead writer and refuses unknown or corrupted ownership", () => {
  expect(begin).toBeTypeOf("function"); expect(finish).toBeTypeOf("function");
  const f = fixture(), first = begin!(f, () => "live"); expect(first.kind).toBe("acquired");
  if (first.kind !== "acquired") throw new Error("lock not acquired");
  expect(begin!(f, () => "unknown")).toEqual({ kind: "busy" });
  const recovered = begin!(f, () => "absent"); expect(recovered.kind).toBe("acquired");
  if (recovered.kind !== "acquired") throw new Error("recovery lock not acquired");
  finish!(f, first.token); expect(begin!(f, () => "live")).toEqual({ kind: "busy" });
  finish!(f, recovered.token);
  writeFileSync(join(f.directory, "write-11111111-1111-4111-8111-111111111111.lock"), "not-json", { mode: 0o600 });
  expect(() => begin!(f, () => "absent")).toThrow();
}, 5000);
