import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb } from "@spider/db-core";
import { scratchDbPath } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS } from "../contracts";
import type { ArtifactManifest } from "../contracts";
import { manifestDigest, openOutgoingStaging, openStaging, readPrivate, sourceChunk } from "../staging";
import { createManifestPages, stageArtifact } from "../artifacts";

const fault = vi.hoisted(() => ({ active: false, writes: 0, directory: null as string | null, descriptors: new Map<number, string>() }));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    openSync: (...args: unknown[]) => {
      const fd = (real.openSync as (...values: unknown[]) => number)(...args);
      if (typeof args[0] === "string" && typeof args[1] === "number" && (args[1] & real.constants.O_DIRECTORY)) fault.descriptors.set(fd, args[0]);
      return fd;
    },
    closeSync: (fd: number) => { fault.descriptors.delete(fd); real.closeSync(fd); },
    fsyncSync: (fd: number) => {
      if (fault.directory && fault.descriptors.get(fd) === fault.directory) throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
      real.fsyncSync(fd);
    },
    writeSync: (...args: unknown[]) => {
      if (fault.active) {
        if (++fault.writes === 1 && Buffer.isBuffer(args[1]) && typeof args[3] === "number" && args[3] > 2) {
          return real.writeSync(args[0] as number, args[1], args[2] as number, 2, args[4] as number);
        }
        const error = new Error("fixture disk full") as NodeJS.ErrnoException;
        error.code = "ENOSPC";
        throw error;
      }
      return (real.writeSync as (...values: unknown[]) => number)(...args);
    },
  };
});

const roots: string[] = [];
const peer = "00000000-0000-4000-8000-000000000001";
function fixture(): string {
  const root = mkdtempSync(join(dirname(scratchDbPath("artifact-staging")), "staging-"));
  roots.push(root);
  return join(root, "staging");
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function makeManifest(id: string, bytes: Buffer, chunkSize = 4): ArtifactManifest {
  const chunks: { index: number; rawLength: number; sha256: string }[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    chunks.push({ index: chunks.length, rawLength: chunk.length, sha256: digest(chunk) });
  }
  return { id, kind: "batch", byteLength: bytes.length, sha256: digest(bytes), chunks };
}
afterEach(() => {
  fault.active = false;
  fault.directory = null;
  fault.descriptors.clear();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(dirname(root), { recursive: true, force: true });
});

it.each(["quota.db", "quota.db-wal", "quota.db-shm"])("reserved quota file name %s cannot become an artifact", async id => {
  const root = fixture(), file = join(dirname(root), "empty"); writeFileSync(file, "", { mode: 0o600 });
  await expect(stageArtifact(file, "session", DEFAULT_LIMITS, { root, artifactId: id })).rejects.toThrow(/artifact ID/i);
  expect(existsSync(join(root, "outgoing", "quota.db"))).toBe(false);
}, 5000);
it("reading a removed artifact does not recreate its parent directories", () => {
  const root = fixture();
  const file = sourceChunk(root, "removed", 0, "a".repeat(64));
  expect(() => readPrivate(file, 4)).toThrow();
  expect(existsSync(join(root, "outgoing"))).toBe(false);
}, 5000);
it("discarded files remove claim and page rows and retention removes cleaned history", () => {
  const root = fixture(), bytes = Buffer.from("abcdefgh"), manifest = makeManifest("cleaned", bytes);
  const limits = { ...DEFAULT_LIMITS, retentionMs: 1000 }, store = openStaging(root, peer, limits);
  const pages = createManifestPages(manifest, limits);
  store.beginPages({ artifact: { id: manifest.id, kind: manifest.kind, byteLength: 8, sha256: manifest.sha256 },
    manifestDigest: manifestDigest(manifest), head: pages.head, pageCount: pages.pages.length }, "transfer-cleaned");
  store.writePage("transfer-cleaned", 0, pages.pages[0]); store.declare(manifest, "transfer-cleaned");
  for (const chunk of manifest.chunks) store.receive(manifest, chunk.index, bytes.subarray(chunk.index * 4, chunk.index * 4 + 4));
  store.assemble(manifest); store.release(manifest.id, "transfer-cleaned");
  store.removeAfterReceipt(manifest, { artifactId: manifest.id, sha256: manifest.sha256 }, () => true);
  const db = openDb(join(root, "incoming", peer, "quota.db"));
  try {
    expect(db.prepare("SELECT count(*) AS n FROM staging_claims").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM staging_pages").get()).toEqual({ n: 0 });
    store.sweep(Date.now() + 2000, () => false);
    expect(db.prepare("SELECT count(*) AS n FROM staging_versions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM staging_artifacts").get()).toEqual({ n: 0 });
  } finally { db.close(); store.close(); }
}, 5000);
it("bounded incoming sweeps advance past retained claims after reopening", () => {
  const root = fixture(), limits = { ...DEFAULT_LIMITS, retentionMs: 1000 };
  let store = openStaging(root, peer, limits);
  const empty = Buffer.alloc(0);
  for (let i = 0; i < 260; i++) store.declare(makeManifest(`held-${i}`, empty), `op-${i}`);
  store.declare(makeManifest("zz-orphan", empty), "orphan-op");
  const now = Date.now() + 2000;
  expect(store.sweep(now, id => id !== "zz-orphan")).toEqual([]); store.close();
  store = openStaging(root, peer, limits);
  try { expect(store.sweep(now, id => id !== "zz-orphan")).toEqual(["zz-orphan"]); }
  finally { store.close(); }
}, 5000);
it("explicit cancellation discards only the inactive incoming artifact", () => {
  const root = fixture(), store = openStaging(root, peer, DEFAULT_LIMITS), manifest = makeManifest("cancelled", Buffer.from("abcd"));
  try {
    store.declare(manifest, "cancelled-transfer"); store.receive(manifest, 0, Buffer.from("abcd"));
    const file = store.assemble(manifest); store.declare(makeManifest("held", Buffer.alloc(0)), "held-transfer");
    expect(() => store.discard(manifest.id, () => false)).toThrow(/active/i);
    expect(existsSync(file)).toBe(true);
    store.discard(manifest.id, () => true);
    expect(existsSync(file)).toBe(false);
    expect(store.manifestFor("held-transfer").id).toBe("held");
  } finally { store.close(); }
}, 5000);
it("a proved inactive abandoned incoming claim can be swept", () => {
  const root = fixture(), bytes = Buffer.from("abcd"), manifest = makeManifest("abandoned", bytes);
  const limits = { ...DEFAULT_LIMITS, retentionMs: 1000 }, store = openStaging(root, peer, limits);
  try {
    store.declare(manifest, "abandoned-transfer"); store.receive(manifest, 0, bytes);
    const file = store.assemble(manifest);
    expect(store.sweep(Date.now() + 2000, () => true)).toEqual([]);
    expect(store.sweep(Date.now() + 2000, () => false)).toEqual([manifest.id]);
    expect(existsSync(file)).toBe(false);
  } finally { store.close(); }
}, 5000);
it.each(["missing", "truncated", "misindexed", "corrupt"] as const)("missing truncated misindexed or corrupt chunks cannot install (%s)", mode => {
  const root = fixture();
  const bytes = Buffer.from("abcdefgh");
  const manifest = makeManifest("batch-1", bytes);
  const store = openStaging(root, peer, DEFAULT_LIMITS);
  try {
    store.declare(manifest, "operation-1");
    store.receive(manifest, 0, bytes.subarray(0, 4));
    expect(store.missing(manifest)).toEqual([1]);
    if (mode === "missing") expect(() => store.assemble(manifest)).toThrow(/missing|chunk/i);
    if (mode === "truncated") expect(() => store.receive(manifest, 1, bytes.subarray(4, 7))).toThrow(/length|chunk/i);
    if (mode === "misindexed") expect(() => store.receive(manifest, 3, bytes.subarray(4, 8))).toThrow(/index|chunk/i);
    if (mode === "corrupt") expect(() => store.receive(manifest, 1, Buffer.from("xxxx"))).toThrow(/digest|chunk/i);
    expect(store.missing(manifest)).toEqual([1]);
    store.receive(manifest, 1, bytes.subarray(4));
    expect(readFileSync(store.assemble(manifest))).toEqual(bytes);
  } finally { store.close(); }
}, 5000);

it("quota and disk-full retain referenced evidence", () => {
  const root = fixture();
  const bytes = Buffer.from("abcdefgh");
  const manifest = makeManifest("batch-1", bytes, 8);
  const limits = { ...DEFAULT_LIMITS, stagingBytes: 15 };
  let store = openStaging(root, peer, limits);
  store.declare(manifest, "operation-1");
  store.receive(manifest, 0, bytes);
  let full: unknown;
  try { store.assemble(manifest); } catch (error) { full = error; }
  expect(full).toMatchObject({ code: "STAGING_FULL", retryable: true });
  expect((full as Error).message).toContain(root);
  expect(store.missing(manifest)).toEqual([]);
  store.close();
  store = openStaging(root, peer, { ...limits, stagingBytes: 16 });
  try {
    fault.active = true;
    fault.writes = 0;
    expect(() => store.assemble(manifest)).toThrow(/disk full/i);
    fault.active = false;
    expect(store.missing(manifest)).toEqual([]);
    expect(readFileSync(store.assemble(manifest))).toEqual(bytes);
  } finally { store.close(); }
}, 5000);

it("restart resumes private reconstruction without counting it twice", () => {
  const root = fixture();
  const bytes = Buffer.from("abcdefgh");
  const manifest = makeManifest("batch-1", bytes, 8);
  const limits = { ...DEFAULT_LIMITS, stagingBytes: 16 };
  let store = openStaging(root, peer, limits);
  store.declare(manifest, "operation-1");
  store.receive(manifest, 0, bytes);
  fault.active = true;
  fault.writes = 0;
  expect(() => store.assemble(manifest)).toThrow(/disk full/i);
  fault.active = false;
  store.close();
  store = openStaging(root, peer, limits);
  try {
    store.declare(manifest, "operation-1");
    store.receive(manifest, 0, bytes);
    const file = store.assemble(manifest);
    expect(readFileSync(file)).toEqual(bytes);
    if (process.platform !== "win32") expect(lstatSync(file).mode & 0o777).toBe(0o600);
  } finally { store.close(); }
}, 5000);

it("symlink replacement cannot escape private staging", () => {
  const root = fixture();
  const outside = join(dirname(root), "outside");
  writeFileSync(outside, "untouched");
  const bytes = Buffer.from("data");
  const manifest = makeManifest("batch-1", bytes);
  const store = openStaging(root, peer, DEFAULT_LIMITS);
  try {
    store.declare(manifest, "operation-1");
    const chunk = store.chunkFile(manifest, 0);
    symlinkSync(outside, chunk);
    expect(() => store.receive(manifest, 0, bytes)).toThrow(/symlink|unsafe|loop/i);
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(() => store.assemble(manifest)).toThrow();
  } finally { store.close(); }
}, 5000);

it.skipIf(process.platform === "win32" || typeof process.getuid !== "function")("refuses a foreign-owned staging root without changing it", () => {
  const root = fixture();
  const store = openStaging(root, peer, DEFAULT_LIMITS);
  store.close();
  const uid = process.getuid!();
  const identity = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
  try { expect(() => openStaging(root, peer, DEFAULT_LIMITS)).toThrow(/unsafe|foreign/i); }
  finally { identity.mockRestore(); }
  expect(existsSync(root)).toBe(true);
}, 5000);

it.skipIf(process.platform === "win32")("repairs permissive incoming parent directories before reading", () => {
  const root = fixture();
  const bytes = Buffer.from("data");
  const manifest = makeManifest("private-parent", bytes);
  const store = openStaging(root, peer, DEFAULT_LIMITS);
  try {
    store.declare(manifest, "private-op");
    store.receive(manifest, 0, bytes);
    const parent = join(root, "incoming", peer, "artifacts", manifest.id);
    chmodSync(parent, 0o777);
    expect(store.missing(manifest)).toEqual([]);
    expect(lstatSync(parent).mode & 0o777).toBe(0o700);
  } finally { store.close(); }
}, 5000);

it("rejects a replaced incoming chunk parent instead of following it", () => {
  const root = fixture();
  const bytes = Buffer.from("data");
  const manifest = makeManifest("parent-check", bytes);
  const store = openStaging(root, peer, DEFAULT_LIMITS);
  try {
    store.declare(manifest, "parent-op");
    store.receive(manifest, 0, bytes);
    const directory = join(root, "incoming", peer, "artifacts", manifest.id, "chunks");
    renameSync(directory, `${directory}-moved`);
    symlinkSync(`${directory}-moved`, directory);
    expect(() => store.missing(manifest)).toThrow(/symlink|unsafe/i);
  } finally { store.close(); }
}, 5000);

it("outgoing staging has a per-root quota and never evicts another artifact", async () => {
  const root = fixture();
  const firstFile = join(dirname(root), "first"), secondFile = join(dirname(root), "second");
  writeFileSync(firstFile, "first");
  writeFileSync(secondFile, "four");
  const limits = { ...DEFAULT_LIMITS, stagingBytes: 8, chunkBytes: 4 };
  const first = await stageArtifact(firstFile, "agent", limits, { root, artifactId: "first" });
  let failure: unknown;
  try { await stageArtifact(secondFile, "agent", limits, { root, artifactId: "second" }); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ code: "STAGING_FULL", retryable: true });
  expect((failure as Error).message).toMatch(/staging full/i);
  expect((failure as Error).message).toContain(root);
  expect(await stageArtifact(firstFile, "agent", limits, { root, artifactId: "first" })).toEqual(first);
  writeFileSync(secondFile, "two");
  expect((await stageArtifact(secondFile, "agent", limits, { root, artifactId: "second" })).byteLength).toBe(3);
}, 5000);

it("source staging does not publish before its parent directories are durable", async () => {
  const root = fixture();
  const source = join(dirname(root), "source");
  writeFileSync(source, "bytes");
  const options = { root, artifactId: "sync-stage" };
  fault.directory = join(root, "outgoing", options.artifactId);
  await expect(stageArtifact(source, "agent", DEFAULT_LIMITS, options)).rejects.toThrow(/directory sync failed/);
  fault.directory = null;
  const manifest = await stageArtifact(source, "agent", DEFAULT_LIMITS, options);
  expect(manifest.sha256).toBe(digest(Buffer.from("bytes")));
}, 5000);

it("an interrupted source stage keeps its quota reservation and refuses a different artifact under the same ID", async () => {
  const root = fixture();
  const source = join(dirname(root), "source");
  const limits = { ...DEFAULT_LIMITS, stagingBytes: 4, chunkBytes: 4 };
  writeFileSync(source, "data");
  fault.active = true; fault.writes = 0;
  await expect(stageArtifact(source, "agent", limits, { root, artifactId: "fixed" })).rejects.toThrow(/disk full/i);
  fault.active = false;
  writeFileSync(source, "evil");
  await expect(stageArtifact(source, "agent", limits, { root, artifactId: "fixed" })).rejects.toThrow(/conflict|changed/i);
  writeFileSync(source, "data");
  const resumed = await stageArtifact(source, "agent", limits, { root, artifactId: "fixed" });
  expect(resumed.sha256).toBe(digest(Buffer.from("data")));
  expect(await stageArtifact(source, "agent", limits, { root, artifactId: "fixed" })).toEqual(resumed);
}, 5000);

it("an older stage cannot clear a pending session extension", async () => {
  const root = fixture();
  const source = join(dirname(root), "source");
  const limits = { ...DEFAULT_LIMITS, chunkBytes: 4, stagingBytes: 8 };
  writeFileSync(source, "abcd");
  const first = await stageArtifact(source, "session", limits, { root, artifactId: "concurrent-session" });
  const next = { ...makeManifest(first.id, Buffer.from("abcdefgh")), kind: "session" as const };
  const store = openOutgoingStaging(root, limits, false);
  try {
    store.prepare(next, manifestDigest(first));
    store.commit(first);
    expect(store.inspect(first.id).pending).toEqual(next);
  } finally { store.close(); }
  writeFileSync(source, "abcdefgh");
  expect(await stageArtifact(source, "session", limits, { root, artifactId: first.id })).toEqual(next);
}, 5000);

it("an old session retry cannot roll back a newer committed version", async () => {
  const root = fixture();
  const source = join(dirname(root), "source");
  const limits = { ...DEFAULT_LIMITS, chunkBytes: 4, stagingBytes: 8 };
  writeFileSync(source, "abcd");
  const first = await stageArtifact(source, "session", limits, { root, artifactId: "concurrent-session" });
  writeFileSync(source, "abcdefgh");
  const next = await stageArtifact(source, "session", limits, { root, artifactId: first.id });
  const store = openOutgoingStaging(root, limits, false);
  try {
    expect(() => store.writeChunk(first.id, manifestDigest(first), first.chunks[0], Buffer.from("abcd"))).not.toThrow();
    expect(() => store.commit(first)).not.toThrow();
    expect(store.inspect(first.id).current).toEqual(next);
  } finally { store.close(); }
}, 5000);

it("startup sweep removes only old outgoing artifacts with no journal operation", async () => {
  const root = fixture();
  const source = join(dirname(root), "source");
  const limits = { ...DEFAULT_LIMITS, stagingBytes: 8, retentionMs: 1000, chunkBytes: 4 };
  writeFileSync(source, "data");
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const live = await stageArtifact(source, "agent", limits, { root, artifactId: "live" });
  const orphan = await stageArtifact(source, "agent", limits, { root, artifactId: "orphan" });
  const store = openOutgoingStaging(root, limits, false);
  const file = (manifest: ArtifactManifest) => sourceChunk(root, manifest.id, 0, manifest.chunks[0].sha256);
  try {
    expect(store.sweep(1999, id => id === "live")).toEqual([]);
    expect(() => store.sweep(2001, id => { if (id === "orphan") throw new Error("journal unavailable"); return false; })).toThrow(/journal unavailable/);
    expect(existsSync(file(live))).toBe(true);
    expect(existsSync(file(orphan))).toBe(true);
    expect(store.sweep(2001, id => id === "live")).toEqual(["orphan"]);
    expect(existsSync(file(live))).toBe(true);
    expect(existsSync(file(orphan))).toBe(false);
  } finally { store.close(); }
}, 5000);

it.each(["chunk", "reconstruction"])("concurrent processes safely publish the same incoming %s", async phase => {
  const root = fixture();
  const bytes = Buffer.alloc(4096, 42);
  const manifest = makeManifest("concurrent-incoming", bytes, bytes.length);
  const limits = { ...DEFAULT_LIMITS, chunkBytes: bytes.length, stagingBytes: bytes.length * 2 };
  const initial = openStaging(root, peer, limits);
  initial.declare(manifest, "initial-op");
  if (phase === "reconstruction") initial.receive(manifest, 0, bytes);
  initial.close();
  const script = `
    import fs from 'node:fs';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL?.endsWith('.ts') && (specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[cm]?[jt]s$/.test(specifier)) {
        return next(specifier + '.ts', context);
      }
      return next(specifier, context);
    } });
    const wait = (path, ms) => {
      const end = Date.now() + ms;
      while (!fs.existsSync(path) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    };
    const original = fs.renameSync;
    fs.renameSync = (from, to) => {
      const part = String(from).includes(input.phase === 'chunk' ? '/chunks/' : '/complete/') && String(from).endsWith('.part');
      if (part && input.role === 'a') { fs.writeFileSync(input.ready, '1'); wait(input.otherDone, 700); }
      const result = original(from, to);
      if (part && input.role === 'b') fs.writeFileSync(input.otherDone, '1');
      return result;
    };
    syncBuiltinESMExports();
    const { openStaging } = await import(pathToFileURL(input.module).href);
    if (input.role === 'b') wait(input.ready, 2500);
    const store = openStaging(input.root, input.peer, input.limits);
    try {
      store.declare(input.manifest, input.role + '-op');
      if (input.phase === 'chunk') store.receive(input.manifest, 0, Buffer.alloc(4096, 42));
      else store.assemble(input.manifest);
      process.stdout.write(JSON.stringify({ ok: true }));
    } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: String(error) })); }
    finally { store.close(); }
  `;
  const child = (role: "a" | "b") => new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    const proc = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", data => { stdout += data; });
    proc.stderr.on("data", data => { stderr += data; });
    proc.on("error", reject);
    proc.on("close", code => {
      if (code !== 0 || stderr) return reject(new Error(`child ${role}: ${stderr || code}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    proc.stdin.end(JSON.stringify({ role, phase, root, peer, limits, manifest, module: join(process.cwd(), "packages/roam/src/staging.ts"),
      ready: join(dirname(root), `${phase}-ready`), otherDone: join(dirname(root), `${phase}-done`) }));
  });
  const [a, b] = await Promise.all([child("a"), child("b")]);
  expect(a.error).toBeUndefined();
  expect(b.error).toBeUndefined();
  expect(a.ok && b.ok).toBe(true);
  const verify = openStaging(root, peer, limits);
  try { expect(readFileSync(verify.assemble(manifest))).toEqual(bytes); } finally { verify.close(); }
}, 5000);

it("reconstruction does not commit before its parent directories are durable", () => {
  const root = fixture();
  const bytes = Buffer.from("data");
  const manifest = makeManifest("sync-reconstruction", bytes);
  const store = openStaging(root, peer, DEFAULT_LIMITS);
  try {
    store.declare(manifest, "sync-op");
    store.receive(manifest, 0, bytes);
    fault.directory = join(root, "incoming", peer, "artifacts", manifest.id);
    expect(() => store.assemble(manifest)).toThrow(/directory sync failed/);
    fault.directory = null;
    expect(readFileSync(store.assemble(manifest))).toEqual(bytes);
  } finally { store.close(); }
}, 5000);

it("restart recovers a renamed reconstruction when recording completion failed", () => {
  const root = fixture();
  const bytes = Buffer.from("recover-after-rename");
  const manifest = makeManifest("rename-crash", bytes);
  let store = openStaging(root, peer, DEFAULT_LIMITS);
  const control = openDb(join(root, "incoming", peer, "quota.db"));
  try {
    store.declare(manifest, "rename-op");
    for (const chunk of manifest.chunks) store.receive(manifest, chunk.index, bytes.subarray(chunk.index * 4, chunk.index * 4 + chunk.rawLength));
    control.exec(`CREATE TRIGGER stop_completion BEFORE UPDATE OF complete ON staging_versions
      WHEN NEW.complete = 1 BEGIN SELECT RAISE(ABORT, 'stop after rename'); END;`);
    expect(() => store.assemble(manifest)).toThrow(/stop after rename/);
    const target = join(root, "incoming", peer, "artifacts", manifest.id, "complete", manifestDigest(manifest));
    expect(readFileSync(target)).toEqual(bytes);
    store.close();
    control.exec("DROP TRIGGER stop_completion");
    store = openStaging(root, peer, DEFAULT_LIMITS);
    expect(readFileSync(store.assemble(manifest))).toEqual(bytes);
  } finally { store.close(); control.close(); }
}, 5000);

it("validation copies reserve quota once per attempt before writing", () => {
  const root = fixture();
  const bytes = Buffer.from("data");
  const manifest = makeManifest("validation-copy", bytes);
  let store = openStaging(root, peer, { ...DEFAULT_LIMITS, stagingBytes: 11 });
  try {
    store.declare(manifest, "validation-op");
    store.receive(manifest, 0, bytes);
    const reconstructed = store.assemble(manifest);
    expect(() => store.reserveValidationCopy(manifest, "attempt-1")).toThrow(/staging full/i);
    expect(existsSync(join(dirname(dirname(reconstructed)), "validation"))).toBe(false);
    expect(readFileSync(reconstructed)).toEqual(bytes);
    store.close();
    store = openStaging(root, peer, { ...DEFAULT_LIMITS, stagingBytes: 12 });
    const input = store.reserveValidationCopy(manifest, "attempt-1");
    expect(typeof input).toBe("string");
    expect(readFileSync(input)).toEqual(bytes);
    if (process.platform !== "win32") expect(lstatSync(input).ino).toBe(lstatSync(reconstructed).ino);
    store.close();
    store = openStaging(root, peer, { ...DEFAULT_LIMITS, stagingBytes: 12 });
    expect(() => store.reserveValidationCopy(manifest, "attempt-1")).toThrow(/attempt|reservation/i);
    expect(() => store.reserveValidationCopy(manifest, "attempt-2")).toThrow(/staging full/i);
    const output = join(dirname(input), "00000000-0000-4000-8000-000000000001.ndjson");
    writeFileSync(output, bytes, { mode: 0o600 });
    expect(() => store.cancelValidationCopy(manifest, "attempt-1")).toThrow(/output|validation/i);
    expect(store.promoteValidationCopy(manifest, "attempt-1", output)).toBe(reconstructed);
    expect(readFileSync(reconstructed)).toEqual(bytes);
    expect(existsSync(input)).toBe(false);
    expect(existsSync(output)).toBe(false);
    const failedInput = store.reserveValidationCopy(manifest, "attempt-2");
    store.cancelValidationCopy(manifest, "attempt-2");
    expect(existsSync(failedInput)).toBe(false);
    const interruptedInput = store.reserveValidationCopy(manifest, "attempt-3");
    const interruptedOutput = join(dirname(interruptedInput), "00000000-0000-4000-8000-000000000002.ndjson");
    writeFileSync(interruptedOutput, bytes, { mode: 0o600 });
    expect(() => store.cancelValidationCopy(manifest, "attempt-3", () => false)).toThrow(/output|validation/i);
    expect(existsSync(interruptedOutput)).toBe(true);
    store.cancelValidationCopy(manifest, "attempt-3", () => true);
    expect(existsSync(interruptedOutput)).toBe(false);
    store.reserveValidationCopy(manifest, "attempt-4");
    store.cancelValidationCopy(manifest, "attempt-4");
    store.release(manifest.id, "validation-op");
    store.removeAfterReceipt(manifest, { artifactId: manifest.id, sha256: manifest.sha256 }, () => true);
    expect(existsSync(reconstructed)).toBe(false);
  } finally { store.close(); }
}, 5000);

it("validation cleanup rejects a replaced parent without deleting evidence", () => {
  const root = fixture();
  const bytes = Buffer.from("data");
  const manifest = makeManifest("validation-parent", bytes);
  const store = openStaging(root, peer, DEFAULT_LIMITS);
  try {
    store.declare(manifest, "validation-op");
    store.receive(manifest, 0, bytes);
    const reconstructed = store.assemble(manifest);
    const input = store.reserveValidationCopy(manifest, "validation-attempt");
    const parent = dirname(dirname(input));
    renameSync(parent, `${parent}-moved`);
    symlinkSync(`${parent}-moved`, parent);
    expect(() => store.cancelValidationCopy(manifest, "validation-attempt")).toThrow(/symlink|unsafe/i);
    expect(existsSync(input)).toBe(true);
    expect(readFileSync(reconstructed)).toEqual(bytes);
  } finally { store.close(); }
}, 5000);

it("a pre-existing reconstruction cannot bypass the session prefix check", () => {
  const root = fixture();
  const store = openStaging(root, peer, DEFAULT_LIMITS);
  const oldBytes = Buffer.from("abcd"), nextBytes = Buffer.from("xbcd!");
  const first: ArtifactManifest = { ...makeManifest("session-id", oldBytes), kind: "session" };
  const next: ArtifactManifest = { ...makeManifest("session-id", nextBytes), kind: "session" };
  try {
    store.declare(first, "first-op");
    store.receive(first, 0, oldBytes);
    const original = store.assemble(first);
    store.declare(next, "next-op");
    store.receive(next, 0, nextBytes.subarray(0, 4));
    store.receive(next, 1, nextBytes.subarray(4));
    const impostor = join(root, "incoming", peer, "artifacts", next.id, "complete", manifestDigest(next));
    writeFileSync(impostor, nextBytes, { mode: 0o600 });
    expect(() => store.assemble(next)).toThrow(/prefix/i);
    expect(readFileSync(original)).toEqual(oldBytes);
  } finally { store.close(); }
}, 5000);

it("an undeclared page transfer still binds its artifact kind", () => {
  const root = fixture();
  const bytes = Buffer.from("data");
  const first: ArtifactManifest = { ...makeManifest("reserved-kind", bytes), kind: "agent" };
  const pages = createManifestPages(first, DEFAULT_LIMITS);
  const store = openStaging(root, peer, DEFAULT_LIMITS);
  try {
    store.beginPages({ artifact: { id: first.id, kind: first.kind, byteLength: first.byteLength, sha256: first.sha256 },
      manifestDigest: manifestDigest(first), head: pages.head, pageCount: pages.pages.length }, "page-op");
    expect(() => store.declare({ ...first, kind: "batch" }, "other-op")).toThrow(/conflict/i);
    const changed: ArtifactManifest = { ...makeManifest(first.id, Buffer.from("data!")), kind: "agent" };
    expect(() => store.declare(changed, "other-op-2")).toThrow(/conflict/i);
  } finally { store.close(); }
}, 5000);

it("rejects a conflicting artifact ID before receiving pages", () => {
  const root = fixture();
  const store = openStaging(root, peer, DEFAULT_LIMITS);
  const first = makeManifest("fixed-id", Buffer.from("first"));
  const changed = makeManifest("fixed-id", Buffer.from("other"));
  const pages = createManifestPages(changed, DEFAULT_LIMITS);
  try {
    store.declare(first, "first-op");
    const { chunks: _chunks, ...artifact } = changed;
    expect(() => store.beginPages({ artifact, manifestDigest: manifestDigest(changed), head: pages.head, pageCount: pages.pages.length }, "other-op"))
      .toThrow(/conflict/i);
    expect(store.missing(first)).toEqual([0, 1]);
  } finally { store.close(); }
}, 5000);

it("one peer's quota does not consume another peer's staging budget", () => {
  const root = fixture();
  const bytes = Buffer.from("data");
  const limits = { ...DEFAULT_LIMITS, stagingBytes: 4 };
  const first = openStaging(root, peer, limits);
  const second = openStaging(root, "00000000-0000-4000-8000-000000000002", limits);
  const manifest = makeManifest("batch-1", bytes);
  try {
    first.declare(manifest, "operation-1");
    second.declare(manifest, "operation-1");
    first.receive(manifest, 0, bytes);
    second.receive(manifest, 0, bytes);
    expect(first.missing(manifest)).toEqual([]);
    expect(second.missing(manifest)).toEqual([]);
    expect(() => first.assemble(manifest)).toThrow(/quota/i);
    expect(second.missing(manifest)).toEqual([]);
  } finally { first.close(); second.close(); }
}, 5000);

it("retention cleanup rejects a replaced artifacts parent before deletion", () => {
  const root = fixture();
  const bytes = Buffer.from("data");
  const manifest = makeManifest("sweep-parent", bytes);
  const limits = { ...DEFAULT_LIMITS, retentionMs: 1000 };
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const store = openStaging(root, peer, limits);
  try {
    store.declare(manifest, "sweep-op");
    store.receive(manifest, 0, bytes);
    const chunk = store.chunkFile(manifest, 0);
    store.release(manifest.id, "sweep-op");
    const parent = join(root, "incoming", peer, "artifacts");
    renameSync(parent, `${parent}-moved`);
    symlinkSync(`${parent}-moved`, parent);
    expect(() => store.sweep(2000)).toThrow(/symlink|unsafe/i);
    expect(existsSync(chunk)).toBe(true);
  } finally { store.close(); clock.mockRestore(); }
}, 5000);

it("retains active evidence and starts its retention window when released", () => {
  const root = fixture();
  const limits = { ...DEFAULT_LIMITS, retentionMs: 1000 };
  const bytes = Buffer.from("data");
  const manifest = makeManifest("aged", bytes);
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const store = openStaging(root, peer, limits);
  try {
    store.declare(manifest, "aged-op");
    store.receive(manifest, 0, bytes);
    clock.mockReturnValue(10_000);
    expect(store.sweep(10_000)).toEqual([]);
    store.release(manifest.id, "aged-op");
    expect(store.sweep(10_999)).toEqual([]);
    expect(existsSync(store.chunkFile(manifest, 0))).toBe(true);
    expect(store.sweep(11_000)).toEqual([manifest.id]);
  } finally { store.close(); clock.mockRestore(); }
}, 5000);

it("sweeps an abandoned session extension after its completed prefix is receipted", () => {
  const root = fixture();
  const limits = { ...DEFAULT_LIMITS, retentionMs: 1000 };
  const first: ArtifactManifest = { ...makeManifest("abandoned-session", Buffer.from("abcd")), kind: "session" };
  const next: ArtifactManifest = { ...makeManifest("abandoned-session", Buffer.from("abcdefgh")), kind: "session" };
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const store = openStaging(root, peer, limits);
  try {
    store.declare(first, "prefix-op");
    store.receive(first, 0, Buffer.from("abcd"));
    const file = store.assemble(first);
    store.declare(next, "extension-op");
    store.release(first.id, "prefix-op");
    store.release(next.id, "extension-op");
    store.removeAfterReceipt(first, { artifactId: first.id, sha256: first.sha256 }, () => true);
    expect(existsSync(file)).toBe(true);
    expect(store.sweep(2000)).toEqual([first.id]);
    expect(existsSync(file)).toBe(false);
  } finally { store.close(); clock.mockRestore(); }
}, 5000);

it("expires only old unreferenced incomplete staging and requires a matching receipt for complete files", () => {
  const root = fixture();
  const bytes = Buffer.from("data");
  const limits = { ...DEFAULT_LIMITS, retentionMs: 1000 };
  const store = openStaging(root, peer, limits);
  const stale = makeManifest("stale", bytes);
  const referenced = makeManifest("referenced", bytes);
  const complete = makeManifest("complete", bytes);
  try {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    store.declare(stale, "old-op");
    store.declare(referenced, "live-op");
    store.declare(complete, "done-op");
    store.receive(stale, 0, bytes);
    store.receive(referenced, 0, bytes);
    store.receive(complete, 0, bytes);
    const installed = store.assemble(complete);
    store.release("stale", "old-op");
    store.release("complete", "done-op");
    expect(store.sweep(1999)).toEqual([]);
    expect(store.sweep(2001)).toEqual(["stale"]);
    expect(store.missing(referenced)).toEqual([]);
    expect(existsSync(installed)).toBe(true);
    expect(() => store.removeAfterReceipt(complete, { artifactId: "complete", sha256: "0".repeat(64) }, () => true)).toThrow(/receipt/i);
    expect(() => store.removeAfterReceipt(complete, { artifactId: "complete", sha256: complete.sha256 }, () => false)).toThrow(/receipt/i);
    expect(existsSync(installed)).toBe(true);
    store.removeAfterReceipt(complete, { artifactId: "complete", sha256: complete.sha256 }, () => true);
    expect(existsSync(installed)).toBe(false);
  } finally { store.close(); }
}, 5000);
