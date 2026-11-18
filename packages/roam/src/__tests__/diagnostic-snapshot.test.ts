import { afterEach, expect, it, vi } from "vitest";
import { appendFileSync, copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { endianness } from "node:os";
import { migrate, openDb, openDbReadOnly } from "@spider/db-core";
import { scratchDbPath } from "@spider/db-core/testutil";
import { openDiagnosticSnapshot } from "../diagnostic-snapshot";
import { runLocalDoctor } from "../local-diagnostics";

const hooks = vi.hoisted(() => ({ afterRead: null as null | ((fd: number, count: number) => void) }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readSync: (...args: unknown[]) => {
    const count = Reflect.apply(actual.readSync, undefined, args);
    if (typeof args[0] === "number") hooks.afterRead?.(args[0], count);
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
  const { root, file, temp } = fixture(), writer = openDb(file);
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
    const target = clone("target.db"), before = hashes(target), source = statSync(target);
    let attempts = 0, failure: unknown;
    hooks.afterRead = fd => { const read = fstatSync(fd); if (read.dev === source.dev && read.ino === source.ino) attempts++; };
    expect(() => { try { openDiagnosticSnapshot(target); } catch (error) { failure = error; throw error; } }).toThrow(/WAL.*commit|changing/i);
    hooks.afterRead = null;
    expect(failure).toMatchObject({ code: "diagnostic-snapshot-wal-unpublished" });
    expect(attempts).toBe(3);
    expect(readdirSync(temp)).toEqual([]);
    expect(hashes(target)).toEqual(before);
  } finally { writer.close(); }
}, 5000);

it("retries when a writer publishes its WAL commit during the snapshot", () => {
  const { root, file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('visible')");
    const earlierIndex = readFileSync(`${file}-shm`);
    writer.exec("INSERT INTO fixture VALUES ('published')");
    const publishedIndex = readFileSync(`${file}-shm`), target = join(root, "publishing.db");
    copyFileSync(file, target); copyFileSync(`${file}-wal`, `${target}-wal`); writeFileSync(`${target}-shm`, earlierIndex);
    const sourceIndex = statSync(`${target}-shm`);
    let afterPublication: (string | null)[] | undefined;
    hooks.afterRead = (fd, count) => {
      if (count !== 96) return;
      const read = fstatSync(fd);
      if (read.dev !== sourceIndex.dev || read.ino !== sourceIndex.ino) return;
      hooks.afterRead = null;
      writeFileSync(`${target}-shm`, publishedIndex);
      afterPublication = hashes(target);
    };
    const snapshot = openDiagnosticSnapshot(target)!;
    try {
      expect(afterPublication).toBeDefined();
      expect(snapshot.prepare("SELECT value FROM fixture ORDER BY value").all()).toEqual([{ value: "published" }, { value: "visible" }]);
    } finally { snapshot.close(); }
    expect(hashes(target)).toEqual(afterPublication);
    expect(readdirSync(temp)).toEqual([]);
  } finally { writer.close(); }
}, 5000);

it("stops at a published commit while publication keeps advancing past three attempts", () => {
  const { root, file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('visible')");
    const versions: Array<{ index: Buffer; wal: Buffer }> = [];
    for (let i = 1; i <= 8; i++) {
      const index = readFileSync(`${file}-shm`);
      writer.prepare("INSERT INTO fixture VALUES (?)").run(`published-${i}`);
      versions.push({ index, wal: readFileSync(`${file}-wal`) });
    }
    const target = join(root, "continuous.db"); copyFileSync(file, target);
    const publish = (i: number) => {
      writeFileSync(`${target}-wal`, versions[i].wal);
      writeFileSync(`${target}-shm`, versions[i].index);
    };
    publish(0);
    const source = statSync(`${target}-shm`);
    let publications = 0;
    hooks.afterRead = (fd, count) => {
      const read = fstatSync(fd);
      if (count === 96 && read.dev === source.dev && read.ino === source.ino && publications < versions.length - 1) publish(++publications);
    };
    const snapshot = openDiagnosticSnapshot(target)!;
    hooks.afterRead = null;
    try {
      expect(publications).toBeGreaterThan(0);
      expect(publications).toBeLessThan(versions.length - 1);
      const rows = snapshot.prepare("SELECT value FROM fixture WHERE value != 'visible' ORDER BY value").all() as { value: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(publications);
      expect(rows.map(row => row.value)).toEqual(Array.from({ length: rows.length }, (_, i) => `published-${i + 1}`));
    } finally { snapshot.close(); }
    expect(readdirSync(temp)).toEqual([]);
  } finally { writer.close(); }
}, 5000);

it("copies a fixed published prefix while a live writer appends during every WAL chunk", () => {
  const { file, temp } = fixture(), writer = openDb(file);
  try {
    writer.raw.pragma("wal_autocheckpoint=0");
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES (hex(zeroblob(600000)))");
    const source = statSync(`${file}-wal`);
    let commits = 0;
    hooks.afterRead = fd => {
      const read = fstatSync(fd);
      if (read.dev === source.dev && read.ino === source.ino) {
        writer.prepare("INSERT INTO fixture VALUES (?)").run(`later-${++commits}`);
      }
    };
    const snapshot = openDiagnosticSnapshot(file)!;
    hooks.afterRead = null;
    try {
      expect(commits).toBeGreaterThan(3);
      expect(snapshot.prepare("SELECT length(value) AS length FROM fixture").all()).toEqual([{ length: 1_200_000 }]);
      expect(writer.prepare("SELECT count(*) AS count FROM fixture").get()).toEqual({ count: commits + 1 });
    } finally { snapshot.close(); }
    expect(readdirSync(temp)).toEqual([]);
  } finally { writer.close(); }
}, 5000);

it("retries a checkpoint and WAL generation reset during the copy", () => {
  const { file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('before')");
    const source = statSync(`${file}-wal`);
    let checkpoints = 0;
    hooks.afterRead = fd => {
      const read = fstatSync(fd);
      if (read.dev !== source.dev || read.ino !== source.ino) return;
      hooks.afterRead = null;
      writer.raw.pragma("wal_checkpoint(TRUNCATE)");
      writer.exec("INSERT INTO fixture VALUES ('after')");
      checkpoints++;
    };
    const snapshot = openDiagnosticSnapshot(file)!;
    try {
      expect(checkpoints).toBe(1);
      expect(snapshot.prepare("SELECT value FROM fixture ORDER BY value").all()).toEqual([{ value: "after" }, { value: "before" }]);
    } finally { snapshot.close(); }
    expect(readdirSync(temp)).toEqual([]);
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
    let failure: unknown;
    expect(() => { try { openDiagnosticSnapshot(unindexed); } catch (error) { failure = error; throw error; } }).toThrow(/WAL.*commit/i);
    expect(failure).toMatchObject({ code: "diagnostic-snapshot-wal-invalid" });
    expect(hashes(unindexed)).toEqual(before);
    const corrupt = clone("corrupt.db"), index = readFileSync(`${file}-shm`);
    index[40] ^= 1; index[88] ^= 1; // Both header copies agree but neither checksum is valid.
    writeFileSync(`${corrupt}-shm`, index);
    const corruptBefore = hashes(corrupt);
    const source = statSync(corrupt); let attempts = 0;
    hooks.afterRead = fd => { const read = fstatSync(fd); if (read.dev === source.dev && read.ino === source.ino) attempts++; };
    expect(() => { try { openDiagnosticSnapshot(corrupt); } catch (error) { failure = error; throw error; } }).toThrow(/WAL.*commit/i);
    hooks.afterRead = null;
    expect(failure).toMatchObject({ code: "diagnostic-snapshot-wal-invalid" });
    expect(attempts).toBeLessThanOrEqual(1);
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

it("doctor keeps at most one store snapshot while inspecting every registered store", async () => {
  const { root, temp } = fixture();
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root); vi.stubEnv("PATH", root);
  const machine = "00000000-0000-4000-8000-000000000001";
  const globalFile = join(root, "spider.db"), files = [globalFile];
  const global = openDb(globalFile);
  migrate(global, "global", { machineId: machine, globalRoot: root });
  global.exec("CREATE TABLE fixture_payload(bytes BLOB); INSERT INTO fixture_payload VALUES (zeroblob(262144))");
  for (let i = 0; i < 2; i++) {
    const file = join(root, `project-${i}.db`), project = openDb(file);
    migrate(project, "worktree", { machineId: machine, globalRoot: root });
    project.exec("CREATE TABLE fixture_payload(bytes BLOB); INSERT INTO fixture_payload VALUES (zeroblob(262144)); DROP TRIGGER roam_sessions_capture_ai");
    project.close(); files.push(file);
    global.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES (?,?,?,1,1)")
      .run(`project-${i}`, root, file);
  }
  global.close();
  const before = files.map(file => createHash("sha256").update(readFileSync(file)).digest("hex"));
  const maxStoreBytes = Math.max(...files.map(file => statSync(file).size));
  let peak = 0, peakBytes = 0;
  hooks.afterRead = () => {
    const directories = readdirSync(temp).filter(name => name.startsWith("spider-roam-inspect-"));
    peak = Math.max(peak, directories.length);
    const bytes = directories.flatMap(name => readdirSync(join(temp, name)).map(file => statSync(join(temp, name, file)).size))
      .reduce((sum, size) => sum + size, 0);
    peakBytes = Math.max(peakBytes, bytes);
  };
  const report = await runLocalDoctor({ root });
  hooks.afterRead = null;
  expect(report.diagnostics.filter(item => item.reason.includes("roam_sessions_capture_ai"))).toHaveLength(2);
  expect(peakBytes).toBeLessThanOrEqual(maxStoreBytes + 65_536);
  expect(peak).toBe(1);
  expect(readdirSync(temp)).toEqual([]);
  expect(files.map(file => createHash("sha256").update(readFileSync(file)).digest("hex"))).toEqual(before);
}, 5000);

it("box doctor treats a non-roamable store as blocking when hub scheduling is disabled", async () => {
  const { root } = fixture(), machineId = "00000000-0000-4000-8000-000000000002", hubMachineId = "00000000-0000-4000-8000-000000000001";
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root); vi.stubEnv("PATH", root);
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "box", machineId, hubMachineId, peers: [], coreUnit: "fixture.service" }), { mode: 0o600 });
  const db = openDb(join(root, "spider.db"));
  migrate(db, "global", { machineId, globalRoot: root });
  db.prepare("UPDATE roam_meta SET store_key='global',capture_enabled=1,roamable=0,problem='fixture problem'").run(); db.close();
  const report = await runLocalDoctor({ root });
  expect(report.diagnostics.find(item => /not roamable/i.test(item.reason))).toMatchObject({ severity: "block" });
}, 5000);

it("rejects symlinked source files", () => {
  const { root, file, temp } = fixture(), writer = openDb(file);
  writer.exec("CREATE TABLE fixture(value TEXT)"); writer.close();
  const alias = join(root, "alias.db"); symlinkSync(file, alias);
  let failure: unknown;
  expect(() => { try { openDiagnosticSnapshot(alias); } catch (error) { failure = error; throw error; } }).toThrow(/unsafe/i);
  expect(failure).toMatchObject({ code: "diagnostic-snapshot-unsafe" });
  expect(readdirSync(temp)).toEqual([]);
}, 5000);
