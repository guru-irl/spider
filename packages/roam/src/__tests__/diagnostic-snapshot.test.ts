import { afterEach, expect, it, vi } from "vitest";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { endianness } from "node:os";
import { openDb, openDbReadOnly } from "@spider/db-core";
import { scratchDbPath } from "@spider/db-core/testutil";
import { openDiagnosticSnapshot } from "../diagnostic-snapshot";

const hooks = vi.hoisted(() => ({ afterRead: null as null | (() => void) }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readSync: (...args: unknown[]) => {
    const count = Reflect.apply(actual.readSync, undefined, args);
    hooks.afterRead?.();
    return count;
  } };
});
const roots: string[] = [];
afterEach(() => {
  hooks.afterRead = null;
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): { root: string; temp: string; file: string } {
  const root = mkdtempSync(join(dirname(scratchDbPath("diagnostic-snapshot")), "diagnostic-snapshot-"));
  roots.push(root);
  const temp = join(root, "temp"); mkdirSync(temp);
  vi.stubEnv("TMPDIR", temp);
  return { root, temp, file: join(root, "store.db") };
}
function hashes(file: string): (string | null)[] {
  return [file, `${file}-wal`, `${file}-shm`].map(path => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);
}

it("reads committed live WAL without changing source files and removes its private copy", () => {
  const { file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('committed')");
    const before = hashes(file);
    expect(before[1]).not.toBeNull();
    const snapshot = openDiagnosticSnapshot(file)!;
    try {
      expect(snapshot.prepare("SELECT value FROM fixture").all()).toEqual([{ value: "committed" }]);
      expect(() => snapshot.prepare("INSERT INTO fixture VALUES ('no')").run()).toThrow(/readonly/i);
      if (process.platform !== "win32") {
        expect(statSync(dirname(snapshot.raw.name)).mode & 0o777).toBe(0o700);
        expect(statSync(snapshot.raw.name).mode & 0o777).toBe(0o600);
      }
      expect(hashes(file)).toEqual(before);
    } finally { snapshot.close(); }
    expect(readdirSync(temp)).toEqual([]);
    expect(hashes(file)).toEqual(before);
  } finally { writer.close(); }
}, 5000);

it("refuses a WAL that extends beyond the published commit index", () => {
  const { root, file } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('visible')");
    const earlierIndex = readFileSync(`${file}-shm`);
    writer.exec("INSERT INTO fixture VALUES ('not-yet-published')");
    const clone = (name: string) => {
      const target = join(root, name);
      copyFileSync(file, target); copyFileSync(`${file}-wal`, `${target}-wal`); writeFileSync(`${target}-shm`, earlierIndex);
      return target;
    };
    const reference = openDbReadOnly(clone("reference.db"))!;
    try { expect(reference.prepare("SELECT value FROM fixture ORDER BY value").all()).toEqual([{ value: "not-yet-published" }, { value: "visible" }]); }
    finally { reference.close(); }
    const target = clone("target.db"), before = hashes(target);
    expect(() => openDiagnosticSnapshot(target)).toThrow(/WAL.*commit|changing/i);
    expect(hashes(target)).toEqual(before);
  } finally { writer.close(); }
}, 5000);

it("refuses an unindexed WAL and a corrupt published index", () => {
  const { root, file } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('committed')");
    const clone = (name: string) => {
      const target = join(root, name);
      copyFileSync(file, target); copyFileSync(`${file}-wal`, `${target}-wal`);
      return target;
    };
    const unindexed = clone("unindexed.db"), before = hashes(unindexed);
    expect(() => openDiagnosticSnapshot(unindexed)).toThrow(/WAL.*commit/i);
    expect(hashes(unindexed)).toEqual(before);
    const corrupt = clone("corrupt.db"), index = readFileSync(`${file}-shm`);
    index[40] ^= 1; index[88] ^= 1; // Both header copies agree but neither checksum is valid.
    writeFileSync(`${corrupt}-shm`, index);
    const corruptBefore = hashes(corrupt);
    expect(() => openDiagnosticSnapshot(corrupt)).toThrow(/WAL.*commit/i);
    expect(hashes(corrupt)).toEqual(corruptBefore);
  } finally { writer.close(); }
}, 5000);

it("accepts stale WAL tail frames from a previous checkpoint generation", () => {
  const { file } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT)");
    writer.raw.transaction(() => { for (let i = 0; i < 80; i++) writer.prepare("INSERT INTO fixture VALUES (?)").run(`item-${i}`); })();
    writer.raw.pragma("wal_checkpoint(RESTART)");
    writer.exec("INSERT INTO fixture VALUES ('new-generation')");
    const index = readFileSync(`${file}-shm`), wal = readFileSync(`${file}-wal`);
    const frames = endianness() === "LE" ? index.readUInt32LE(16) : index.readUInt32BE(16);
    const end = 32 + frames * (wal.readUInt32BE(8) + 24);
    expect(wal.length).toBeGreaterThan(end + 24);
    expect(wal.subarray(end + 8, end + 16)).not.toEqual(wal.subarray(16, 24));
    const before = hashes(file), snapshot = openDiagnosticSnapshot(file)!;
    try { expect(snapshot.prepare("SELECT count(*) AS count FROM fixture").get()).toEqual({ count: 81 }); }
    finally { snapshot.close(); }
    expect(hashes(file)).toEqual(before);
  } finally { writer.close(); }
}, 5000);

it("does not create sidecars on an inactive source", () => {
  const { file, temp } = fixture(), writer = openDb(file);
  writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('saved')");
  writer.close();
  const before = hashes(file);
  expect(before.slice(1)).toEqual([null, null]);
  const snapshot = openDiagnosticSnapshot(file)!;
  try { expect(snapshot.prepare("SELECT value FROM fixture").all()).toEqual([{ value: "saved" }]); }
  finally { snapshot.close(); }
  expect(hashes(file)).toEqual(before);
  expect(readdirSync(temp)).toEqual([]);
}, 5000);

it("refuses a source that changes during every snapshot and removes partial copies", () => {
  const { file, temp } = fixture(), writer = openDb(file);
  writer.exec("CREATE TABLE fixture(value TEXT)"); writer.close();
  hooks.afterRead = () => appendFileSync(file, "x");
  expect(() => openDiagnosticSnapshot(file)).toThrow(/changed/i);
  hooks.afterRead = null;
  expect(readdirSync(temp)).toEqual([]);
}, 5000);

it("rejects symlinked source files", () => {
  const { root, file, temp } = fixture(), writer = openDb(file);
  writer.exec("CREATE TABLE fixture(value TEXT)"); writer.close();
  const alias = join(root, "alias.db"); symlinkSync(file, alias);
  expect(() => openDiagnosticSnapshot(alias)).toThrow(/unsafe/i);
  expect(readdirSync(temp)).toEqual([]);
}, 5000);
