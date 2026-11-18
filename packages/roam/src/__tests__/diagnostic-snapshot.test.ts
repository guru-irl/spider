import { afterEach, expect, it, vi } from "vitest";
import { appendFileSync, copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { endianness } from "node:os";
import { migrate, openDb, openDbReadOnly } from "@spider/db-core";
import { scratchDbPath } from "@spider/db-core/testutil";
import { openDiagnosticSnapshot } from "../diagnostic-snapshot";
import { runLocalDoctor } from "../local-diagnostics";

const hooks = vi.hoisted(() => ({
  afterRead: null as null | ((fd: number, count: number) => void),
  fixedStamp: null as string | null,
  beforePrivateOpen: null as null | ((file: string) => void),
}));
vi.mock("@spider/db-core", async importOriginal => {
  const actual = await importOriginal<typeof import("@spider/db-core")>();
  return { ...actual, openDbReadOnly: (file: string) => {
    hooks.beforePrivateOpen?.(file);
    return actual.openDbReadOnly(file);
  } };
});
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fixed = (stat: ReturnType<typeof actual.fstatSync>, bigint: boolean) => {
    if (!hooks.fixedStamp || !bigint) return stat;
    const source = actual.statSync(hooks.fixedStamp);
    if (stat.dev !== BigInt(source.dev) || stat.ino !== BigInt(source.ino)) return stat;
    return Object.assign(stat, { mtimeNs: 0n, ctimeNs: 0n });
  };
  return { ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => fixed(Reflect.apply(actual.lstatSync, undefined, args), !!args[1]?.bigint),
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => fixed(Reflect.apply(actual.fstatSync, undefined, args), !!args[1]?.bigint),
    readSync: (...args: unknown[]) => {
    const count = Reflect.apply(actual.readSync, undefined, args);
    if (typeof args[0] === "number") hooks.afterRead?.(args[0], count);
    return count;
  } };
});
const roots: string[] = [];
afterEach(() => {
  hooks.afterRead = null;
  hooks.fixedStamp = null;
  hooks.beforePrivateOpen = null;
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

it("needs all three attempts while commits keep advancing", () => {
  const { file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('visible')");
    const source = statSync(file), wal = statSync(`${file}-wal`);
    let attempts = 0, publications = 0;
    hooks.afterRead = fd => {
      const read = fstatSync(fd);
      if (read.ino === source.ino && read.dev === source.dev) {
        attempts++;
        if (attempts < 3) writer.raw.pragma("wal_checkpoint(TRUNCATE)");
        else writer.prepare("INSERT INTO fixture VALUES (?)").run(`published-${++publications}`);
      }
      if (read.ino === wal.ino && read.dev === wal.dev) writer.prepare("INSERT INTO fixture VALUES (?)").run(`published-${++publications}`);
    };
    const snapshot = openDiagnosticSnapshot(file)!;
    hooks.afterRead = null;
    try {
      expect(attempts).toBe(3);
      expect(publications).toBeGreaterThan(0);
      expect(snapshot.prepare("SELECT value FROM fixture WHERE value = 'visible'").all()).toEqual([{ value: "visible" }]);
      const count = snapshot.prepare("SELECT count(*) AS count FROM fixture").get() as { count: number };
      expect(count.count).toBeLessThanOrEqual(publications + 1);
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

it.each([false, true])("retries a checkpoint and WAL generation reset during the copy (already flushed: %s)", flushed => {
  const { file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('before')");
    if (flushed) writer.raw.pragma("wal_checkpoint(PASSIVE)");
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

it("distinguishes a persistently missing WAL index from a corrupt one", () => {
  const { root, file } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('committed')");
    const clone = (name: string) => {
      const target = join(root, name);
      copyFileSync(file, target); copyFileSync(`${file}-wal`, `${target}-wal`);
      return target;
    };
    const unindexed = clone("unindexed.db"), before = hashes(unindexed);
    let failure: unknown, missingAttempts = 0;
    hooks.afterRead = fd => { if (isFile(fd, unindexed)) missingAttempts++; };
    expect(() => { try { openDiagnosticSnapshot(unindexed); } catch (error) { failure = error; throw error; } }).toThrow(/WAL.*index/i);
    hooks.afterRead = null;
    expect(failure).toMatchObject({ code: "diagnostic-snapshot-wal-index-missing" });
    expect(missingAttempts).toBe(3);
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

function isFile(fd: number, file: string): boolean {
  if (!existsSync(file)) return false;
  const a = fstatSync(fd), b = statSync(file);
  return a.dev === b.dev && a.ino === b.ino;
}
it("bounds the commit after the main copy even with coarse timestamps", () => {
  const { file, temp } = fixture(), writer = openDb(file);
  let reader: ReturnType<typeof openDb> | undefined;
  try {
    writer.exec("CREATE TABLE a(value TEXT); CREATE TABLE b(value TEXT); INSERT INTO a VALUES ('old'); INSERT INTO b VALUES ('old')");
    writer.raw.pragma("wal_checkpoint(TRUNCATE)");
    writer.exec("UPDATE a SET value='base'");
    hooks.fixedStamp = file;
    let indexReads = 0, walReads = 0;
    hooks.afterRead = (fd, count) => {
      if (isFile(fd, `${file}-shm`) && count === 96 && ++indexReads === 1) {
        writer.exec("BEGIN; UPDATE a SET value='new'; UPDATE b SET value='new'; COMMIT");
        reader = openDb(file);
        reader.exec("BEGIN"); reader.prepare("SELECT * FROM a").all();
        writer.raw.pragma("wal_checkpoint(PASSIVE)");
      }
      if (isFile(fd, `${file}-wal`) && ++walReads === 1) writer.exec("UPDATE a SET value='end'");
    };
    const snapshot = openDiagnosticSnapshot(file)!;
    hooks.afterRead = null;
    try {
      expect(snapshot.prepare("SELECT a.value AS a, b.value AS b FROM a,b").get()).toEqual({ a: "new", b: "new" });
      expect(walReads).toBeGreaterThan(0);
    } finally { snapshot.close(); }
    expect(readdirSync(temp)).toEqual([]);
  } finally { reader?.close(); writer.close(); }
}, 5000);

it("retries a half-backfilled main copy when the WAL becomes empty", () => {
  const { file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE a(value TEXT); INSERT INTO a VALUES ('o'||hex(zeroblob(180000))); CREATE TABLE b(value TEXT); INSERT INTO b VALUES ('o'||hex(zeroblob(180000)))");
    writer.raw.pragma("wal_checkpoint(TRUNCATE)");
    writer.exec("BEGIN; UPDATE a SET value='n'||substr(value,2); UPDATE b SET value='n'||substr(value,2); COMMIT");
    hooks.fixedStamp = file;
    let chunks = 0;
    hooks.afterRead = fd => {
      if (isFile(fd, file) && ++chunks === 1) writer.raw.pragma("wal_checkpoint(TRUNCATE)");
    };
    const snapshot = openDiagnosticSnapshot(file)!;
    hooks.afterRead = null;
    try { expect(snapshot.prepare("SELECT substr(a.value,1,1) AS a, substr(b.value,1,1) AS b FROM a,b").get()).toEqual({ a: "n", b: "n" }); }
    finally { snapshot.close(); }
    expect(chunks).toBeGreaterThan(3);
    expect(readdirSync(temp)).toEqual([]);
  } finally { writer.close(); }
}, 5000);

it("keeps the earlier commit when a restart overwrites a copied stale tail", () => {
  const { file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT)");
    writer.raw.transaction(() => { for (let i = 0; i < 80; i++) writer.prepare("INSERT INTO fixture VALUES (?)").run(`item-${i}`); })();
    writer.raw.pragma("wal_checkpoint(RESTART)");
    writer.exec("INSERT INTO fixture VALUES ('new-generation')");
    let copied = false;
    hooks.fixedStamp = file;
    hooks.afterRead = fd => {
      if (!copied && isFile(fd, `${file}-wal`)) {
        copied = true;
        writer.exec("INSERT INTO fixture VALUES ('later')");
      }
    };
    const snapshot = openDiagnosticSnapshot(file)!;
    hooks.afterRead = null;
    try {
      expect(copied).toBe(true);
      expect(snapshot.prepare("SELECT count(*) AS count FROM fixture").get()).toEqual({ count: 81 });
    } finally { snapshot.close(); }
    expect(readdirSync(temp)).toEqual([]);
  } finally { writer.close(); }
}, 5000);

it.each(["close", "short-index", "zero-index", "torn-index"])("retries the transient %s lifecycle window", event => {
  const { file, temp } = fixture();
  let writer: ReturnType<typeof openDb> | undefined = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('committed')");
    const index = readFileSync(`${file}-shm`);
    let fired = false, restored = false, attempts = 0;
    hooks.afterRead = (fd, count) => {
      if (isFile(fd, file)) attempts++;
      if (!fired && isFile(fd, event === "close" ? `${file}-wal` : file)) {
        fired = true;
        if (event === "close") { writer!.close(); writer = undefined; }
        else if (event === "short-index") truncateSync(`${file}-shm`, 3);
        else {
          const torn = Buffer.from(index);
          if (event === "zero-index") torn.fill(0, 0, 96); else torn[48 + 8] ^= 1;
          writeFileSync(`${file}-shm`, torn);
        }
      } else if (fired && !restored && event !== "close" && isFile(fd, `${file}-shm`) && (event === "torn-index" || event === "zero-index" || count === 0)) {
        restored = true; writeFileSync(`${file}-shm`, index);
      }
    };
    const snapshot = openDiagnosticSnapshot(file)!;
    hooks.afterRead = null;
    try { expect(snapshot.prepare("SELECT value FROM fixture").all()).toEqual([{ value: "committed" }]); }
    finally { snapshot.close(); }
    expect(fired).toBe(true);
    expect(attempts).toBeGreaterThan(1);
    expect(readdirSync(temp)).toEqual([]);
  } finally { writer?.close(); }
}, 5000);

it("retries the gap between publishing reset salts and rewriting the WAL header", () => {
  const { root, file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('committed')");
    const oldWal = readFileSync(`${file}-wal`);
    writer.raw.pragma("wal_checkpoint(RESTART)");
    writer.exec("INSERT INTO fixture VALUES ('next')");
    const nextWal = readFileSync(`${file}-wal`), target = join(root, "reset.db");
    copyFileSync(file, target); copyFileSync(`${file}-shm`, `${target}-shm`); writeFileSync(`${target}-wal`, oldWal);
    let rewritten = false;
    hooks.afterRead = fd => {
      if (!rewritten && isFile(fd, `${target}-wal`)) { rewritten = true; writeFileSync(`${target}-wal`, nextWal); }
    };
    const snapshot = openDiagnosticSnapshot(target)!;
    hooks.afterRead = null;
    try { expect(snapshot.prepare("SELECT value FROM fixture ORDER BY value").all()).toEqual([{ value: "committed" }, { value: "next" }]); }
    finally { snapshot.close(); }
    expect(rewritten).toBe(true);
    expect(readdirSync(temp)).toEqual([]);
  } finally { writer.close(); }
}, 5000);

it("retries a checkpoint whose backfill target overtakes the copied commit", () => {
  const { file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('base')");
    writer.raw.pragma("wal_checkpoint(TRUNCATE)");
    writer.exec("UPDATE fixture SET value='before'");
    hooks.fixedStamp = file;
    let checkpoints = 0, attempts = 0;
    hooks.afterRead = fd => {
      if (isFile(fd, file)) attempts++;
      if (isFile(fd, `${file}-wal`) && checkpoints++ === 0) {
        writer.exec("INSERT INTO fixture VALUES ('after')");
        writer.raw.pragma("wal_checkpoint(PASSIVE)");
      }
    };
    const snapshot = openDiagnosticSnapshot(file)!;
    hooks.afterRead = null;
    try { expect(snapshot.prepare("SELECT value FROM fixture ORDER BY value").all()).toEqual([{ value: "after" }, { value: "before" }]); }
    finally { snapshot.close(); }
    expect(attempts).toBeGreaterThan(1);
    expect(readdirSync(temp)).toEqual([]);
  } finally { writer.close(); }
}, 5000);

it("ignores checksum-valid uncommitted frames left by a spilled rollback", () => {
  const { file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('committed')");
    writer.raw.pragma("cache_size=1");
    writer.exec("BEGIN; INSERT INTO fixture VALUES (hex(zeroblob(100000))); ROLLBACK");
    const before = hashes(file), snapshot = openDiagnosticSnapshot(file)!;
    try { expect(snapshot.prepare("SELECT value FROM fixture").all()).toEqual([{ value: "committed" }]); }
    finally { snapshot.close(); }
    expect(hashes(file)).toEqual(before);
    expect(readdirSync(temp)).toEqual([]);
  } finally { writer.close(); }
}, 5000);

it("checks that private recovery reached the selected commit", () => {
  const { file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('before')");
    const earlier = readFileSync(`${file}-wal`);
    writer.exec("INSERT INTO fixture VALUES ('after')");
    let opens = 0;
    hooks.beforePrivateOpen = copy => {
      if (++opens === 1) writeFileSync(`${copy}-wal`, earlier);
    };
    const snapshot = openDiagnosticSnapshot(file)!;
    try { expect(snapshot.prepare("SELECT value FROM fixture ORDER BY value").all()).toEqual([{ value: "after" }, { value: "before" }]); }
    finally { snapshot.close(); }
    expect(opens).toBe(2);
    expect(readdirSync(temp)).toEqual([]);
  } finally { writer.close(); }
}, 5000);

it("accepts only recorded commits through automatic, RESTART and TRUNCATE checkpoints", () => {
  const { file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE a(value INTEGER); CREATE TABLE b(value INTEGER); INSERT INTO a VALUES (0); INSERT INTO b VALUES (0)");
    writer.raw.pragma("wal_autocheckpoint=4");
    const committed = new Set([JSON.stringify({ a: 0, b: 0 })]);
    let step = 0, accepted = 0;
    hooks.fixedStamp = file;
    for (const phase of ["index", "main", "wal"] as const) {
      for (const mode of ["PASSIVE", "RESTART", "TRUNCATE"]) {
        let fired = false;
        hooks.afterRead = (fd, count) => {
          if (fired || !isFile(fd, phase === "main" ? file : `${file}-${phase === "index" ? "shm" : "wal"}`) || phase === "index" && count !== 96) return;
          fired = true;
          step++;
          writer.exec(`BEGIN; UPDATE a SET value=${step}; UPDATE b SET value=${step}; COMMIT`);
          committed.add(JSON.stringify({ a: step, b: step }));
          writer.raw.pragma(`wal_checkpoint(${mode})`);
        };
        const snapshot = openDiagnosticSnapshot(file)!;
        hooks.afterRead = null;
        try { expect(committed.has(JSON.stringify(snapshot.prepare("SELECT a.value AS a,b.value AS b FROM a,b").get()))).toBe(true); }
        finally { snapshot.close(); }
        expect(fired).toBe(true);
        accepted++;
        writer.exec(`BEGIN; UPDATE a SET value=${++step}; UPDATE b SET value=${step}; COMMIT`);
        committed.add(JSON.stringify({ a: step, b: step }));
      }
    }
    expect(accepted).toBe(9);
    expect(readdirSync(temp)).toEqual([]);
  } finally { writer.close(); }
}, 5000);

it("refuses a corrupt checksum earlier than the selected commit without retrying", () => {
  const { root, file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('before'); INSERT INTO fixture VALUES ('after')");
    const target = join(root, "corrupt-frame.db"), wal = readFileSync(`${file}-wal`);
    wal[32 + 24 + 100] ^= 1;
    copyFileSync(file, target); copyFileSync(`${file}-shm`, `${target}-shm`); writeFileSync(`${target}-wal`, wal);
    const before = hashes(target);
    let failure: unknown, snapshot: ReturnType<typeof openDiagnosticSnapshot>, attempts = 0;
    hooks.afterRead = fd => { if (isFile(fd, target)) attempts++; };
    try {
      expect(() => { try { snapshot = openDiagnosticSnapshot(target); } catch (error) { failure = error; throw error; } }).toThrow(/WAL.*commit/i);
    } finally { snapshot?.close(); }
    hooks.afterRead = null;
    expect(failure).toMatchObject({ code: "diagnostic-snapshot-wal-invalid" });
    expect(attempts).toBe(1);
    expect(hashes(target)).toEqual(before);
    expect(readdirSync(temp)).toEqual([]);
  } finally { writer.close(); }
}, 5000);

it("retries an index missing at attempt start and accepts it when it appears", () => {
  const { root, file, temp } = fixture(), writer = openDb(file);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('committed')");
    const target = join(root, "opening.db"), index = readFileSync(`${file}-shm`);
    copyFileSync(file, target); copyFileSync(`${file}-wal`, `${target}-wal`);
    let attempts = 0;
    hooks.afterRead = fd => {
      if (isFile(fd, target) && ++attempts === 1) writeFileSync(`${target}-shm`, index);
    };
    const snapshot = openDiagnosticSnapshot(target)!;
    hooks.afterRead = null;
    try { expect(snapshot.prepare("SELECT value FROM fixture").all()).toEqual([{ value: "committed" }]); }
    finally { snapshot.close(); }
    expect(attempts).toBe(2);
    expect(readdirSync(temp)).toEqual([]);
  } finally { writer.close(); }
}, 5000);

it("doctor describes an absent WAL index as an opening or closing store", async () => {
  const { root, file } = fixture(), writer = openDb(file);
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root); vi.stubEnv("PATH", root);
  try {
    writer.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('committed')");
    const target = join(root, "spider.db");
    copyFileSync(file, target); copyFileSync(`${file}-wal`, `${target}-wal`);
    const report = await runLocalDoctor({ root });
    expect(report.diagnostics.find(item => item.reason.includes("cannot inspect the registered store"))?.reason).toContain("opening or closing");
    expect(report.diagnostics.find(item => item.reason.includes("cannot inspect the registered store"))?.reason).not.toMatch(/corrupt|recovery/i);
  } finally { writer.close(); }
}, 5000);
