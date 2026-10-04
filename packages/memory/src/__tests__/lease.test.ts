import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { paths, commandEnv } from "@spider/db-core";
import { acquireEmbedLease, getEmbedLeaseState } from "../embeddings/lease";

const race = vi.hoisted(() => ({ replace: undefined as (() => void) | undefined }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readFileSync(...args: Parameters<typeof fs.readFileSync>) {
    const data = fs.readFileSync(...args);
    const replace = race.replace; race.replace = undefined; replace?.();
    return data;
  } };
});
let root: string;
afterEach(() => { race.replace = undefined; vi.useRealTimers(); if (root) rmSync(root, { recursive: true, force: true }); });
const fixture = () => { root = join(paths.globalRoot, `lease-${randomUUID()}`); mkdirSync(root); return join(root, "fixture.db"); };
const moduleUrl = new URL("../embeddings/lease.ts", import.meta.url).href;
it("excludes a competing process and releases only its own token", () => {
  const db = fixture(); const release = acquireEmbedLease(db); expect(release).toBeTypeOf("function");
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { acquireEmbedLease } = await import(${JSON.stringify(moduleUrl)});
    const release = acquireEmbedLease(${JSON.stringify(db)});
    process.stdout.write(release ? 'acquired' : 'busy'); release?.();
  `], { env: commandEnv(), encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" });
  expect(result).toBe("busy"); release!();
  const next = acquireEmbedLease(db); expect(next).toBeTypeOf("function");
  writeFileSync(`${db}.embed-lock`, JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "different" }));
  next!(); expect(JSON.parse(readFileSync(`${db}.embed-lock`, "utf8")).token).toBe("different");
});
it("reclaims a dead pid and an alive-pid lease older than two minutes", () => {
  const db = fixture();
  const dead = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { env: commandEnv(), encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" }));
  writeFileSync(`${db}.embed-lock`, JSON.stringify({ pid: dead, timestamp: 1 }));
  const release = acquireEmbedLease(db); expect(release).toBeTypeOf("function"); release!();
  writeFileSync(`${db}.embed-lock`, JSON.stringify({ pid: process.pid, timestamp: 1 }));
  utimesSync(`${db}.embed-lock`, new Date(1), new Date(1));
  const reclaimed = acquireEmbedLease(db); expect(reclaimed).toBeTypeOf("function"); reclaimed!();
  expect(existsSync(`${db}.embed-lock`)).toBe(false);
});
it.each([{ age: 119999, acquired: false }, { age: 120001, acquired: true }])("expires a live-pid lease at the two-minute boundary: $age", ({ age, acquired }) => {
  vi.useFakeTimers();
  const db = fixture(); const old = new Date(Date.now() - age);
  writeFileSync(`${db}.embed-lock`, JSON.stringify({ pid: process.pid, token: "foreign" }));
  utimesSync(`${db}.embed-lock`, old, old);
  const release = acquireEmbedLease(db); expect(!!release).toBe(acquired); release?.();
});
it("refreshes mtime on heartbeat ticks", async () => {
  vi.useFakeTimers();
  const db = fixture(); const release = acquireEmbedLease(db)!;
  try {
    const holder = JSON.parse(readFileSync(`${db}.embed-lock`, "utf8"));
    expect(holder.token).toEqual(expect.any(String));
    const old = Date.now() - 110000;
    utimesSync(`${db}.embed-lock`, new Date(old), new Date(old));
    await vi.advanceTimersByTimeAsync(5000);
    expect(statSync(`${db}.embed-lock`).mtimeMs).toBeGreaterThan(old + 100000);
    expect(acquireEmbedLease(db)).toBeUndefined();
  } finally { release(); }
  expect(existsSync(`${db}.embed-lock`)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("releases twice without closing again or touching a replacement lease", () => {
  vi.useFakeTimers();
  const db = fixture(); const release = acquireEmbedLease(db)!;
  release();
  expect(existsSync(`${db}.embed-lock`)).toBe(false);
  const replacement = acquireEmbedLease(db)!;
  try {
    expect(() => release()).not.toThrow();
    expect(acquireEmbedLease(db)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
  } finally { replacement(); }
  expect(vi.getTimerCount()).toBe(0);
});

it("reports a fresh dead-pid lease as stale just as acquisition does", () => {
  const db = fixture();
  const dead = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { env: commandEnv(), encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" }));
  writeFileSync(`${db}.embed-lock`, JSON.stringify({ pid: dead }));
  expect(getEmbedLeaseState(db)).toMatchObject({ pid: dead, stale: true });
  const release = acquireEmbedLease(db); expect(release).toBeTypeOf("function"); release!();
});

it("does not unlink a fresh replacement created during stale reclamation", () => {
  const db = fixture(); const path = `${db}.embed-lock`;
  writeFileSync(path, JSON.stringify({ pid: process.pid, token: "old" }));
  utimesSync(path, new Date(1), new Date(1));
  race.replace = () => { unlinkSync(path); writeFileSync(path, JSON.stringify({ pid: process.pid, token: "replacement" })); };
  expect(acquireEmbedLease(db)).toBeUndefined();
  expect(JSON.parse(readFileSync(path, "utf8")).token).toBe("replacement");
});
it("only expires an incomplete file after the mtime grace", () => {
  const db = fixture(); writeFileSync(`${db}.embed-lock`, "incomplete");
  expect(acquireEmbedLease(db)).toBeUndefined();
  utimesSync(`${db}.embed-lock`, new Date(1), new Date(1));
  const release = acquireEmbedLease(db); expect(release).toBeTypeOf("function"); release!();
});
