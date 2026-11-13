import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, createReadStream, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { createReplica, scratchDbPath } from "@spider/db-core/testutil";
import { applyBatch } from "@spider/db-core/roam/apply";
import { validateBatch } from "@spider/db-core/roam/codec";
import { DEFAULT_LIMITS } from "../contracts";
import type { CallOptions, Journal, Limits, Operation, Peer, Transport } from "../contracts";
import { openJournal } from "../journal";
import { defaultStagingRoot, openStaging, sourceChunk } from "../staging";
import { createManifestPages, handleArtifactRequest, pullArtifact, readManifestPages, stageArtifact, transferArtifact } from "../artifacts";

const roots: string[] = [];
function fixture(): { root: string; source: string; staging: string } {
  const root = mkdtempSync(join(dirname(scratchDbPath("artifact")), "artifact-"));
  roots.push(root);
  return { root, source: join(root, "source"), staging: join(root, "staging") };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

it("stages immutable binary chunks with exact lengths and hashes", async () => {
  const { source, staging } = fixture();
  const bytes = Buffer.from([0, 255, 10, 128, 1, 2, 3]);
  writeFileSync(source, bytes);
  const manifest = await stageArtifact(source, "agent", { ...DEFAULT_LIMITS, chunkBytes: 3 }, { root: staging, artifactId: "artifact-1" });
  expect(manifest).toEqual({
    id: "artifact-1", kind: "agent", byteLength: 7, sha256: digest(bytes),
    chunks: [
      { index: 0, rawLength: 3, sha256: digest(bytes.subarray(0, 3)) },
      { index: 1, rawLength: 3, sha256: digest(bytes.subarray(3, 6)) },
      { index: 2, rawLength: 1, sha256: digest(bytes.subarray(6, 7)) },
    ],
  });
  if (process.platform !== "win32") expect(lstatSync(staging).mode & 0o777).toBe(0o700);
}, 5000);

it.each([
  ["batch", "hardBatchBytes"], ["session", "sessionBytes"], ["workspace", "workspaceBytes"],
  ["release", "agentBytes"], ["agent", "agentBytes"], ["auth", "agentBytes"],
] as const)("refuses an oversized %s artifact", async (kind, key) => {
  const { source, staging } = fixture();
  writeFileSync(source, Buffer.alloc(5));
  await expect(stageArtifact(source, kind, { ...DEFAULT_LIMITS, [key]: 4 }, { root: staging })).rejects.toThrow(/limit|large|size/i);
}, 5000);

it.each(["../outside", "a/b", "a\\b", "", ".", "..", "x".repeat(256)])("rejects unsafe artifact ID %s", async artifactId => {
  const { source, staging } = fixture();
  writeFileSync(source, "safe");
  await expect(stageArtifact(source, "agent", DEFAULT_LIMITS, { root: staging, artifactId })).rejects.toThrow(/artifact|id/i);
}, 5000);

it("refuses conflicting content for an existing artifact ID", async () => {
  const { source, staging } = fixture();
  writeFileSync(source, "original");
  const options = { root: staging, artifactId: "fixed-id" };
  await stageArtifact(source, "agent", DEFAULT_LIMITS, options);
  writeFileSync(source, "modified");
  await expect(stageArtifact(source, "agent", DEFAULT_LIMITS, options)).rejects.toThrow(/conflict|changed/i);
}, 5000);

it("manifest pages obey byte and digest bounds", async () => {
  const { source, staging } = fixture();
  writeFileSync(source, Buffer.from("abcdefghijklmnopqrstuvwx"));
  const limits = { ...DEFAULT_LIMITS, chunkBytes: 2, manifestBytes: 420, replyBytes: 420 };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const { head, pages } = createManifestPages(manifest, limits);
  expect(pages.length).toBeGreaterThan(1);
  expect(Math.max(...pages.map(page => page.length))).toBeLessThanOrEqual(420);
  expect(readManifestPages(head, pages, limits)).toEqual(manifest);
  const corrupted = pages.map(page => Buffer.from(page));
  corrupted[1][corrupted[1].length - 1] ^= 1;
  expect(() => readManifestPages(head, corrupted, limits)).toThrow(/digest|manifest|page/i);
  expect(() => readManifestPages(head, [...pages].reverse(), limits)).toThrow(/digest|manifest|page/i);
  expect(() => readManifestPages(head, pages.slice(0, -1), limits)).toThrow(/digest|manifest|page/i);
}, 5000);

it("stops reading manifest pages as soon as a chunk descriptor is invalid", () => {
  const page = Buffer.from(JSON.stringify({ version: 1, artifact: { id: "invalid-page", kind: "agent", byteLength: 1, sha256: "0".repeat(64) },
    index: 0, next: "0".repeat(64), chunks: [null] }));
  function* pages(): Iterable<Buffer> { yield page; throw new Error("read beyond invalid page"); }
  expect(() => readManifestPages(digest(page), pages(), DEFAULT_LIMITS)).toThrow(/invalid artifact chunk/i);
}, 5000);

it("rejects a dense malformed manifest page without argument overflow", () => {
  const limits = { ...DEFAULT_LIMITS, manifestBytes: 1024 * 1024, replyBytes: 1024 * 1024 };
  const page = Buffer.from(JSON.stringify({ version: 1, artifact: { id: "dense-page", kind: "agent", byteLength: 130_000, sha256: "0".repeat(64) },
    index: 0, next: null, chunks: Array(130_000).fill(null) }));
  expect(page.length).toBeLessThanOrEqual(limits.manifestBytes);
  expect(() => readManifestPages(digest(page), [page], limits)).toThrow(/invalid artifact chunk/i);
}, 5000);

it("ignores untrusted path fields in manifest pages", async () => {
  const { source, staging } = fixture();
  writeFileSync(source, "bytes");
  const manifest = await stageArtifact(source, "agent", DEFAULT_LIMITS, { root: staging });
  const page = JSON.parse(createManifestPages(manifest, DEFAULT_LIMITS).pages[0].toString("utf8"));
  page.artifact.file = "/outside/staging";
  page.chunks[0].path = "/outside/chunk";
  const bytes = Buffer.from(JSON.stringify(page));
  const result = readManifestPages(createHash("sha256").update(bytes).digest("hex"), [bytes], DEFAULT_LIMITS);
  expect(result).toEqual(manifest);
}, 5000);

const hubId = "00000000-0000-4000-8000-000000000001";
const boxId = "00000000-0000-4000-8000-000000000002";
function memoryJournal(): Journal {
  const rows = new Map<string, { encoded: string; actions: { action: string; result: Record<string, never> }[]; result: Record<string, never> | null }>();
  return {
    begin(operation: Operation) {
      const encoded = JSON.stringify(operation);
      const row = rows.get(operation.id);
      if (row && row.encoded !== encoded) throw new Error("Operation ID has different arguments");
      if (row) return row.result ? { kind: "done", result: row.result } : { kind: "pending", result: null };
      rows.set(operation.id, { encoded, actions: [], result: null });
      return { kind: "new", result: null };
    },
    record(id, action, result) {
      const row = rows.get(id);
      if (!row) throw new Error("Operation has not begun");
      row.actions.push({ action, result: result as Record<string, never> });
      if (action === "done") row.result = result as Record<string, never>;
    },
    read(id) { return rows.get(id)?.actions ?? []; },
  };
}
function link(root: string, limits: Limits, inMemory = false, targetId = boxId): {
  peer: Peer; transport: Transport; localJournal: Journal; sent: number[]; payloads: string[]; calls: string[];
  setFailure(index: number | null): void; loseAssemblyReply(): void; afterBegin(fn: () => void): void;
  pauseNextBegin(): { entered: Promise<void>; release(): void };
  restart(nextLimits?: Limits): void; close(): void; resolved(): number; largestReply(): number; largestChunk(): number;
} {
  const globalRoot = join(root, "remote");
  const peer: Peer = { machineId: targetId, alias: "box-1.invalid", node: "/node", pi: "/pi", cli: "/cli", core: "/core", globalRoot };
  const localJournal = inMemory ? memoryJournal() : openJournal(join(root, "local", "journal.db"));
  const remoteJournal = inMemory ? memoryJournal() : openJournal(join(globalRoot, "roam", "journal.db"));
  let remoteLimits = limits;
  let store = openStaging(join(globalRoot, "roam", "staging"), hubId, remoteLimits);
  let failure: number | null = null, lost = false, resolutionCount = 0, replySize = 0, chunkSize = 0;
  let beginHook: (() => void) | undefined;
  let beginPause: { enter(): void; wait: Promise<void> } | undefined;
  const sent: number[] = [], payloads: string[] = [], calls: string[] = [];
  const transport: Transport = {
    async resolve(value) { resolutionCount++; return { ...value }; },
    async exec(_peer, argv, options: CallOptions) {
      const request = JSON.parse(argv[argv.length - 1]) as { action: string; index?: number };
      calls.push(request.action);
      if (request.action === "chunk") {
        chunkSize = Math.max(chunkSize, options.stdin?.length ?? 0);
        sent.push(request.index!);
        payloads.push(digest(options.stdin!));
        if (request.index === failure) throw new Error("connection lost");
      }
      const reply = await handleArtifactRequest(request, options.stdin, { store, journal: remoteJournal, machineId: targetId, limits: remoteLimits });
      replySize = Math.max(replySize, reply.length);
      if (request.action === "begin") {
        beginHook?.();
        const pause = beginPause;
        beginPause = undefined;
        if (pause) { pause.enter(); await pause.wait; }
      }
      if (request.action === "assemble" && lost) { lost = false; throw new Error("reply lost"); }
      return reply;
    },
    async run() { throw new Error("unexpected background launch"); },
    async read() { throw new Error("unexpected file read"); },
    async write() { throw new Error("unexpected unverified file write"); },
  };
  return {
    peer, transport, localJournal, sent, payloads, calls,
    setFailure(index) { failure = index; },
    loseAssemblyReply() { lost = true; },
    afterBegin(fn) { beginHook = fn; },
    pauseNextBegin() {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      beginPause = { enter, wait };
      return { entered, release };
    },
    restart(nextLimits) { store.close(); remoteLimits = nextLimits ?? remoteLimits; store = openStaging(join(globalRoot, "roam", "staging"), hubId, remoteLimits); },
    close() { store.close(); },
    resolved() { return resolutionCount; },
    largestReply() { return replySize; },
    largestChunk() { return chunkSize; },
  };
}

it.each(["agent", "session"] as const)("streams a binary and session artifact above 64 MiB (%s)", async kind => {
  const { root, source, staging } = fixture();
  const out = openSync(source, "w", 0o600);
  const sourceHash = createHash("sha256");
  let length = 0, index = 0;
  try {
    while (length <= 64 * 1024 * 1024) {
      const bytes = kind === "session"
        ? Buffer.from(JSON.stringify({ type: "message", id: `m${index}`, text: "s".repeat(65_000) }) + "\n")
        : Buffer.alloc(384 * 1024, index % 251);
      let at = 0;
      while (at < bytes.length) at += writeSync(out, bytes, at, bytes.length - at);
      sourceHash.update(bytes);
      length += bytes.length;
      index++;
    }
  } finally { closeSync(out); }
  const expected = sourceHash.digest("hex");
  const manifest = await stageArtifact(source, kind, DEFAULT_LIMITS, { root: staging });
  const remote = link(root, DEFAULT_LIMITS, true);
  try {
    const result = await transferArtifact(remote.peer, manifest,
      { transport: remote.transport, journal: remote.localJournal, limits: DEFAULT_LIMITS, root: staging, operationId: `large-${kind}` });
    expect(result.code).toBe(0);
    expect(manifest.byteLength).toBeGreaterThan(64 * 1024 * 1024);
    expect(manifest.sha256).toBe(expected);
    const installed = createHash("sha256");
    for await (const bytes of createReadStream(result.value!.file)) installed.update(bytes);
    expect(installed.digest("hex")).toBe(expected);
    expect(remote.largestChunk()).toBeLessThanOrEqual(384 * 1024);
    expect(remote.largestReply()).toBeLessThanOrEqual(1024 * 1024);
  } finally { remote.close(); }
}, 5000);

it("resume reuses verified immutable chunks", async () => {
  const { root, source, staging } = fixture();
  const bytes = Buffer.from([0, 255, 10, 128, 1, 2, 3, 4, 5]);
  writeFileSync(source, bytes);
  const limits = { ...DEFAULT_LIMITS, chunkBytes: 4, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const remote = link(root, limits);
  const ports = { transport: remote.transport, journal: remote.localJournal, limits, root: staging, operationId: "transfer-1" };
  try {
    remote.setFailure(1);
    expect((await transferArtifact(remote.peer, manifest, ports)).code).toBe(3);
    expect(remote.sent).toContain(0);
    remote.restart();
    remote.setFailure(null);
    remote.sent.length = 0;
    const result = await transferArtifact(remote.peer, manifest, ports);
    expect(result.code).toBe(0);
    expect(remote.sent).not.toContain(0);
    expect(result.value).not.toBeNull();
    expect(readFileSync(result.value!.file)).toEqual(bytes);
    expect(remote.resolved()).toBe(2);
    expect(remote.largestReply()).toBeLessThanOrEqual(limits.replyBytes);
  } finally { remote.close(); }
}, 5000);

it("never overlaps transfers to the same peer", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "content");
  const limits = { ...DEFAULT_LIMITS, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const remote = link(root, limits);
  const ports = { transport: remote.transport, journal: remote.localJournal, limits, root: staging };
  const paused = remote.pauseNextBegin();
  let first: ReturnType<typeof transferArtifact> | undefined;
  try {
    first = transferArtifact(remote.peer, manifest, { ...ports, operationId: "active-1" });
    await paused.entered;
    const second = await transferArtifact(remote.peer, manifest, { ...ports, operationId: "active-2" });
    expect(second.code).toBe(3);
    expect(remote.calls).toEqual(["begin"]);
    paused.release();
    expect((await first).code).toBe(0);
    remote.sent.length = 0;
    expect((await transferArtifact(remote.peer, manifest, { ...ports, operationId: "active-2" })).code).toBe(0);
    expect(remote.sent).toEqual([]);
  } finally { paused.release(); await first; remote.close(); }
}, 5000);

it("admits at most two peer transfers and leaves the third pending", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "content");
  const limits = { ...DEFAULT_LIMITS, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const remotes = [
    link(join(root, "a"), limits, true, "00000000-0000-4000-8000-000000000002"),
    link(join(root, "b"), limits, true, "00000000-0000-4000-8000-000000000003"),
    link(join(root, "c"), limits, true, "00000000-0000-4000-8000-000000000004"),
  ];
  const pauses = remotes.slice(0, 2).map(remote => remote.pauseNextBegin());
  const send = (index: number) => transferArtifact(remotes[index].peer, manifest, {
    transport: remotes[index].transport, journal: remotes[index].localJournal, limits, root: staging, operationId: `parallel-${index}`,
  });
  let first: ReturnType<typeof transferArtifact> | undefined, second: ReturnType<typeof transferArtifact> | undefined;
  try {
    first = send(0);
    await pauses[0].entered;
    second = send(1);
    await pauses[1].entered;
    expect((await send(2)).code).toBe(3);
    expect(remotes[2].calls).toEqual([]);
    pauses.forEach(pause => pause.release());
    expect((await first).code).toBe(0);
    expect((await second).code).toBe(0);
    expect((await send(2)).code).toBe(0);
  } finally {
    pauses.forEach(pause => pause.release());
    await first; await second;
    remotes.forEach(remote => remote.close());
  }
}, 5000);

it("a transfer ID cannot be reused for a different artifact", async () => {
  const { root, source, staging } = fixture();
  const limits = { ...DEFAULT_LIMITS, retryDelaysMs: [] };
  writeFileSync(source, "first");
  const first = await stageArtifact(source, "agent", limits, { root: staging, artifactId: "first" });
  writeFileSync(source, "second");
  const second = await stageArtifact(source, "agent", limits, { root: staging, artifactId: "second" });
  const remote = link(root, limits);
  const ports = { transport: remote.transport, journal: remote.localJournal, limits, root: staging, operationId: "same-operation" };
  try {
    expect((await transferArtifact(remote.peer, first, ports)).code).toBe(0);
    const calls = [...remote.calls];
    const result = await transferArtifact(remote.peer, second, ports);
    expect(result.code).toBe(2);
    expect(remote.calls).toEqual(calls);
  } finally { remote.close(); }
}, 5000);

it("invalid transfer IDs refuse before journaling or transport", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "content");
  const manifest = await stageArtifact(source, "agent", DEFAULT_LIMITS, { root: staging });
  const remote = link(root, DEFAULT_LIMITS);
  try {
    const result = await transferArtifact(remote.peer, manifest,
      { transport: remote.transport, journal: remote.localJournal, limits: DEFAULT_LIMITS, root: staging, operationId: "../outside" });
    expect(result.code).toBe(2);
    expect(remote.calls).toEqual([]);
    expect(remote.localJournal.read("../outside")).toEqual([]);
  } finally { remote.close(); }
}, 5000);

it.skipIf(process.platform === "win32")("repairs an outgoing artifact parent before transfer", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "bytes");
  const limits = { ...DEFAULT_LIMITS, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const directory = join(staging, "outgoing", manifest.id);
  chmodSync(directory, 0o777);
  const remote = link(root, limits);
  try {
    const result = await transferArtifact(remote.peer, manifest, { transport: remote.transport, journal: remote.localJournal, limits, root: staging });
    expect(result.code).toBe(0);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  } finally { remote.close(); }
}, 5000);

it("rejects a replaced source parent symlink before contacting the peer", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "bytes");
  const limits = { ...DEFAULT_LIMITS, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const directory = join(staging, "outgoing", manifest.id);
  renameSync(directory, `${directory}-moved`);
  symlinkSync(`${directory}-moved`, directory);
  const remote = link(root, limits);
  try {
    const result = await transferArtifact(remote.peer, manifest, { transport: remote.transport, journal: remote.localJournal, limits, root: staging });
    expect(result.code).toBe(1);
    expect(remote.resolved()).toBe(0);
    expect(remote.sent).toEqual([]);
  } finally { remote.close(); }
}, 5000);

it("missing staged source is a refusal without a remote command", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "content");
  const manifest = await stageArtifact(source, "agent", DEFAULT_LIMITS, { root: staging });
  rmSync(sourceChunk(staging, manifest.id, 0, manifest.chunks[0].sha256));
  const remote = link(root, DEFAULT_LIMITS);
  try {
    const result = await transferArtifact(remote.peer, manifest,
      { transport: remote.transport, journal: remote.localJournal, limits: DEFAULT_LIMITS, root: staging, operationId: "lost-source" });
    expect(result.code).toBe(1);
    expect(remote.calls).toEqual([]);
  } finally { remote.close(); }
}, 5000);

it("retries the same immutable chunk after one, two, and four seconds", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "content");
  const limits = { ...DEFAULT_LIMITS, retryDelaysMs: [1000, 2000, 4000] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const remote = link(root, limits);
  remote.setFailure(0);
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  try {
    const pending = transferArtifact(remote.peer, manifest,
      { transport: remote.transport, journal: remote.localJournal, limits, root: staging, operationId: "retry-operation" });
    await vi.advanceTimersByTimeAsync(0);
    expect(remote.sent).toEqual([0]);
    await vi.advanceTimersByTimeAsync(999);
    expect(remote.sent).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(remote.sent).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(remote.sent).toEqual([0, 0, 0]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(remote.sent).toEqual([0, 0, 0, 0]);
    expect(new Set(remote.payloads).size).toBe(1);
    expect((await pending).code).toBe(3);
  } finally { remote.close(); }
}, 5000);

it("the file deadline bounds a transport that ignores its timeout", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "bytes");
  const limits = { ...DEFAULT_LIMITS, fileMs: 20, transferMs: 1000, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const remote = link(root, limits);
  const original = remote.transport.exec.bind(remote.transport);
  let settle!: (bytes: Buffer) => void;
  const pending = new Promise<Buffer>(resolve => { settle = resolve; });
  const transport: Transport = { ...remote.transport, async exec(peer, argv, options) {
    const request = JSON.parse(argv[argv.length - 1]) as { action: string };
    if (request.action === "chunk") return pending;
    return original(peer, argv, options);
  } };
  try {
    const start = Date.now();
    const result = await transferArtifact(remote.peer, manifest, { transport, journal: remote.localJournal, limits, root: staging });
    expect(result.code).toBe(3);
    expect(Date.now() - start).toBeLessThan(500);
  } finally { settle(Buffer.from("late reply")); await new Promise(resolve => setImmediate(resolve)); remote.close(); }
}, 5000);

it("separate staging roots have independent peer-transfer locks", async () => {
  const { root, source, staging } = fixture();
  const otherRoot = join(root, "other-staging");
  writeFileSync(source, "bytes");
  const limits = { ...DEFAULT_LIMITS, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging, artifactId: "same-id" });
  await stageArtifact(source, "agent", limits, { root: otherRoot, artifactId: manifest.id });
  const firstRemote = link(root, limits);
  const otherRemote = link(join(root, "other-peer"), limits);
  const pause = firstRemote.pauseNextBegin();
  const first = transferArtifact(firstRemote.peer, manifest, { transport: firstRemote.transport, journal: firstRemote.localJournal, limits, root: staging });
  try {
    await pause.entered;
    const other = await transferArtifact(otherRemote.peer, manifest, { transport: otherRemote.transport, journal: otherRemote.localJournal, limits, root: otherRoot });
    expect(other.code).toBe(0);
    expect(readFileSync(other.value!.file, "utf8")).toBe("bytes");
  } finally { pause.release(); await first; firstRemote.close(); otherRemote.close(); }
}, 5000);

it("a timed-out remote call keeps the peer lease until it settles", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "bytes");
  const limits = { ...DEFAULT_LIMITS, fileMs: 20, transferMs: 1000, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const remote = link(root, limits);
  const original = remote.transport.exec.bind(remote.transport);
  let settle!: (bytes: Buffer) => void, stall = true;
  const pending = new Promise<Buffer>(resolve => { settle = resolve; });
  const transport: Transport = { ...remote.transport, async exec(peer, argv, options) {
    const request = JSON.parse(argv[argv.length - 1]) as { action: string };
    if (request.action === "chunk" && stall) { stall = false; return pending; }
    return original(peer, argv, options);
  } };
  const ports = { transport, journal: remote.localJournal, limits, root: staging };
  try {
    expect((await transferArtifact(remote.peer, manifest, { ...ports, operationId: "timed-out" })).code).toBe(3);
    expect((await transferArtifact(remote.peer, manifest, { ...ports, operationId: "waiting" })).code).toBe(3);
    expect(remote.resolved()).toBe(1);
    settle(Buffer.from("late reply"));
    await new Promise(resolve => setImmediate(resolve));
    expect((await transferArtifact(remote.peer, manifest, { ...ports, operationId: "waiting" })).code).toBe(0);
  } finally { settle(Buffer.from("late reply")); await new Promise(resolve => setImmediate(resolve)); remote.close(); }
}, 5000);

it("the total transfer deadline includes source verification", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "abcdefghijklmnopqrst");
  const limits = { ...DEFAULT_LIMITS, chunkBytes: 1, transferMs: 5, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const remote = link(root, limits);
  let now = 1000;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now++);
  try {
    const result = await transferArtifact(remote.peer, manifest, { transport: remote.transport, journal: remote.localJournal, limits, root: staging });
    expect(result.code).toBe(3);
    expect(remote.resolved()).toBe(0);
  } finally { clock.mockRestore(); remote.close(); }
}, 5000);

it("concurrent processes can stage the same artifact without duplicate partial files", async () => {
  const { root, source, staging } = fixture();
  const bytes = Buffer.alloc(4096, 42);
  writeFileSync(source, bytes);
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
      const chunk = String(from).includes('/outgoing/') && String(from).endsWith('.part');
      if (chunk && input.role === 'a') { fs.writeFileSync(input.ready, '1'); wait(input.otherDone, 700); }
      const result = original(from, to);
      if (chunk && input.role === 'b') fs.writeFileSync(input.otherDone, '1');
      return result;
    };
    syncBuiltinESMExports();
    const { stageArtifact } = await import(pathToFileURL(input.module).href);
    if (input.role === 'b') wait(input.ready, 2500);
    try {
      const manifest = await stageArtifact(input.source, 'agent', input.limits, { root: input.staging, artifactId: 'concurrent-id' });
      process.stdout.write(JSON.stringify({ ok: true, manifest }));
    } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: String(error) })); }
  `;
  const child = (role: "a" | "b") => new Promise<{ ok: boolean; manifest?: unknown; error?: string }>((resolve, reject) => {
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
    proc.stdin.end(JSON.stringify({ role, source, staging, limits: { ...DEFAULT_LIMITS, chunkBytes: bytes.length, stagingBytes: bytes.length },
      module: join(process.cwd(), "packages/roam/src/artifacts.ts"), ready: join(root, "ready"), otherDone: join(root, "other-done") }));
  });
  const [a, b] = await Promise.all([child("a"), child("b")]);
  expect(a.error).toBeUndefined();
  expect(b.error).toBeUndefined();
  expect(a).toMatchObject({ ok: true });
  expect(b).toMatchObject({ ok: true });
  expect(a.manifest).toEqual(b.manifest);
}, 5000);

it("peer exclusion and concurrency survive separate hub processes", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "bytes");
  const limits = { ...DEFAULT_LIMITS, fileMs: 3500, transferMs: 4000, peerConcurrency: 2, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const otherRoot = join(root, "other-staging");
  await stageArtifact(source, "agent", limits, { root: otherRoot, artifactId: manifest.id });
  const script = `
    import fs from 'node:fs';
    import { registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL?.endsWith('.ts') && (specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[cm]?[jt]s$/.test(specifier)) {
        return next(specifier + '.ts', context);
      }
      return next(specifier, context);
    } });
    const { transferArtifact } = await import(pathToFileURL(input.artifacts).href);
    const { openJournal } = await import(pathToFileURL(input.journal).href);
    let resolves = 0;
    const transport = {
      async resolve(peer) { resolves++; return peer; },
      async exec() {
        if (input.hold) {
          fs.writeFileSync(input.ready, '1');
          while (!fs.existsSync(input.release)) await new Promise(done => setTimeout(done, 5));
        }
        throw new Error('offline');
      },
      async read() { throw new Error('unexpected read'); },
      async run() { throw new Error('unexpected run'); },
      async write() { throw new Error('unexpected write'); },
    };
    const journal = openJournal(input.journalPath);
    const result = await transferArtifact(input.peer, input.manifest, { transport, journal, limits: input.limits, root: input.staging, operationId: input.role });
    process.stdout.write(JSON.stringify({ code: result.code, resolves }));
  `;
  const child = (role: string, machineId: string, hold = false, stageRoot = staging) => {
    const ready = join(root, `${role}-ready`), release = join(root, `${role}-release`);
    const proc = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const result = new Promise<{ code: number; resolves: number }>((resolve, reject) => {
      let stdout = "", stderr = "";
      proc.stdout.on("data", data => { stdout += data; });
      proc.stderr.on("data", data => { stderr += data; });
      proc.on("error", reject);
      proc.on("close", code => {
        if (code !== 0 || stderr) return reject(new Error(`child ${role}: ${stderr || code}`));
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
    });
    proc.stdin.end(JSON.stringify({ role, hold, ready, release, manifest, limits, staging: stageRoot,
      peer: { machineId, alias: `peer-${machineId}`, node: "/node", pi: "/pi", cli: "/cli", core: "/core", globalRoot: join(root, "peer") },
      artifacts: join(process.cwd(), "packages/roam/src/artifacts.ts"), journal: join(process.cwd(), "packages/roam/src/journal.ts"),
      journalPath: join(root, role, "journal.db") }));
    return { ready, release, result, proc };
  };
  const waitReady = async (path: string) => {
    const end = performance.now() + 1800;
    while (!existsSync(path) && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
    if (!existsSync(path)) throw new Error(`child did not reach ${path}`);
  };
  const peer2 = "00000000-0000-4000-8000-000000000003";
  const peer3 = "00000000-0000-4000-8000-000000000004";
  const first = child("hold-one", boxId, true);
  let second: ReturnType<typeof child> | undefined;
  try {
    await waitReady(first.ready);
    expect(await child("same-peer", boxId).result).toEqual({ code: 3, resolves: 0 });
    expect(await child("different-root", boxId, false, otherRoot).result).toEqual({ code: 3, resolves: 1 });
    second = child("hold-two", peer2, true);
    await waitReady(second.ready);
    expect(await child("third-peer", peer3).result).toEqual({ code: 3, resolves: 0 });
    writeFileSync(first.release, "1");
    expect((await first.result).code).toBe(3);
    expect(await child("third-retry", peer3).result).toEqual({ code: 3, resolves: 1 });
    writeFileSync(second.release, "1");
    await second.result;
    const localPeer = (machineId: string): Peer => ({ machineId, alias: `peer-${machineId}`, node: "/node", pi: "/pi", cli: "/cli", core: "/core", globalRoot: join(root, "peer") });
    const hold = () => {
      let ready!: () => void, stop!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const pending = new Promise<Buffer>((_resolve, reject) => { stop = () => reject(new Error("offline")); });
      const transport: Transport = {
        async resolve(value) { return value; }, async exec() { ready(); return pending; },
        async read() { throw new Error("unexpected read"); }, async run() { throw new Error("unexpected run"); },
        async write() { throw new Error("unexpected write"); },
      };
      return { started, stop, transport };
    };
    const a = hold(), b = hold();
    const localA = transferArtifact(localPeer(boxId), manifest, { transport: a.transport, journal: memoryJournal(), limits, root: staging, operationId: "local-a" });
    let localB: Promise<unknown> | undefined;
    try {
      await a.started;
      localB = transferArtifact(localPeer(peer2), manifest, { transport: b.transport, journal: memoryJournal(), limits, root: staging, operationId: "local-b" });
      await b.started;
      expect(await child("mixed-probe", peer3).result).toEqual({ code: 3, resolves: 0 });
    } finally { a.stop(); b.stop(); await localA; await localB; }
    const crashed = child("crash-holder", boxId, true);
    const crashResult = crashed.result.catch(error => error);
    await waitReady(crashed.ready);
    crashed.proc.kill("SIGKILL");
    expect(await crashResult).toBeInstanceOf(Error);
    expect(await child("after-crash", boxId).result).toEqual({ code: 3, resolves: 1 });
  } finally {
    writeFileSync(first.release, "1");
    if (second) { writeFileSync(second.release, "1"); await second.result; }
    await first.result;
  }
}, 5000);

it("a backward wall clock cannot extend the transfer deadline", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "bytes");
  const limits = { ...DEFAULT_LIMITS, fileMs: 500, transferMs: 50, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const remote = link(root, limits);
  const original = remote.transport.exec.bind(remote.transport);
  let settle!: (bytes: Buffer) => void;
  const pending = new Promise<Buffer>(resolve => { settle = resolve; });
  const transport: Transport = { ...remote.transport, async exec(peer, argv, options) {
    const request = JSON.parse(argv[argv.length - 1]) as { action: string };
    if (request.action === "chunk") return pending;
    return original(peer, argv, options);
  } };
  let wall = 1_000_000_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => { wall -= 1_000_000; return wall; });
  try {
    const start = performance.now();
    const result = await transferArtifact(remote.peer, manifest, { transport, journal: remote.localJournal, limits, root: staging });
    expect(result.code).toBe(3);
    expect(performance.now() - start).toBeLessThan(250);
  } finally { clock.mockRestore(); settle(Buffer.from("late reply")); await new Promise(resolve => setImmediate(resolve)); remote.close(); }
}, 5000);

it("pulls byte-exact chunks into private local staging", async () => {
  const { root, source } = fixture();
  const peerRoot = join(root, "peer");
  const bytes = Buffer.from([0, 255, 10, 128, 9, 8, 7]);
  const limits = { ...DEFAULT_LIMITS, chunkBytes: 3, retryDelaysMs: [] };
  writeFileSync(source, bytes);
  const manifest = await stageArtifact(source, "agent", limits, { root: join(peerRoot, "roam", "staging") });
  const peer: Peer = { machineId: boxId, alias: "box-1.invalid", node: "/node", pi: "/pi", cli: "/cli", core: "/core", globalRoot: peerRoot };
  const paths: string[] = [];
  let resolved = 0;
  const transport: Transport = {
    async resolve(value) { resolved++; return { ...value }; },
    async read(_peer, file, options) {
      paths.push(file);
      const data = readFileSync(file);
      if (data.length > options.maxBytes) throw new Error("reply too large");
      return data;
    },
    async exec() { throw new Error("unexpected command"); },
    async run() { throw new Error("unexpected background launch"); },
    async write() { throw new Error("unexpected write"); },
  };
  const journal = openJournal(join(root, "local", "journal.db"));
  const result = await pullArtifact(peer, manifest, { transport, journal, limits, root: join(root, "local-staging"), operationId: "pull-1" });
  expect(result.code).toBe(0);
  expect(readFileSync(result.value!.file)).toEqual(bytes);
  expect(paths).toHaveLength(3);
  expect(paths.every(file => file.startsWith(join(peerRoot, "roam", "staging") + "/"))).toBe(true);
  const ports = { transport, journal, limits, root: join(root, "local-staging"), operationId: "pull-1" };
  expect((await pullArtifact(peer, manifest, ports)).code).toBe(0);
  expect(resolved).toBe(1);
  rmSync(result.value!.file);
  expect((await pullArtifact(peer, manifest, ports)).code).toBe(3);
}, 5000);

it("a disconnected pull resumes without reading verified chunks again", async () => {
  const { root, source } = fixture();
  const peerRoot = join(root, "peer");
  const limits = { ...DEFAULT_LIMITS, chunkBytes: 4, retryDelaysMs: [] };
  writeFileSync(source, "abcdefghij");
  const manifest = await stageArtifact(source, "agent", limits, { root: join(peerRoot, "roam", "staging") });
  const peer: Peer = { machineId: boxId, alias: "box-1.invalid", node: "/node", pi: "/pi", cli: "/cli", core: "/core", globalRoot: peerRoot };
  const reads: string[] = [];
  let disconnect = true;
  const transport: Transport = {
    async resolve(value) { return value; },
    async read(_peer, file) {
      reads.push(file);
      if (disconnect && reads.length === 2) throw new Error("offline");
      return readFileSync(file);
    },
    async exec() { throw new Error("unexpected command"); },
    async run() { throw new Error("unexpected background launch"); },
    async write() { throw new Error("unexpected write"); },
  };
  const journal = openJournal(join(root, "local", "journal.db"));
  const ports = { transport, journal, limits, root: join(root, "local-staging"), operationId: "resume-pull" };
  expect((await pullArtifact(peer, manifest, ports)).code).toBe(3);
  disconnect = false;
  reads.length = 0;
  const resumed = await pullArtifact(peer, manifest, ports);
  expect(resumed.code).toBe(0);
  expect(readFileSync(resumed.value!.file, "utf8")).toBe("abcdefghij");
  expect(reads).toEqual(manifest.chunks.slice(1).map(chunk => sourceChunk(join(peerRoot, "roam", "staging"), manifest.id, chunk.index, chunk.sha256)));
}, 5000);

it("corrupt inbound bytes cannot install or advance a replica cursor", async () => {
  const { root, source } = fixture();
  const peerRoot = join(root, "peer");
  const stream = "00000000-0000-4000-8000-000000000005";
  const header = { protocol: 1 as const, schema: 14 as const, batchId: "batch-8", senderMachine: boxId, senderStream: stream,
    storeKey: "global" as const, after: 7, through: 8, count: 1 };
  const record = { seq: 8, changeId: "memory-change", entity: "global_memory", rowKey: "memory-1", op: "put",
    clock: { ms: 1000, count: 0, machine: boxId, stream }, writerSession: null, writerEpoch: null, schema: 14,
    body: { uuid: "memory-1", category: "insight", content: "synthetic", link: null, status: "active", source: "user",
      confidence: null, scope: "global", created_at: 1, updated_at: null, justification: null, evidence: null, machine_id: null } };
  const bytes = Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(record)}\n`);
  const limits = { ...DEFAULT_LIMITS, chunkBytes: 128, stagingBytes: bytes.length * 3, retryDelaysMs: [] };
  writeFileSync(source, bytes, { mode: 0o600 });
  const manifest = await stageArtifact(source, "batch", limits, { root: join(peerRoot, "roam", "staging") });
  const peer: Peer = { machineId: boxId, alias: "box-1.invalid", node: "/node", pi: "/pi", cli: "/cli", core: "/core", globalRoot: peerRoot };
  let corrupt = true;
  const transport: Transport = {
    async resolve(value) { return value; },
    async read(_peer, file) { const data = readFileSync(file); if (corrupt) data[0] ^= 1; return data; },
    async exec() { throw new Error("unexpected command"); },
    async run() { throw new Error("unexpected background launch"); },
    async write() { throw new Error("unexpected write"); },
  };
  const replica = createReplica("global", hubId);
  try {
    replica.db.prepare("INSERT INTO roam_cursors(peer_machine, peer_stream, last_seq) VALUES (?, ?, ?)").run(boxId, stream, 7);
    const cursorBefore = replica.db.prepare("SELECT * FROM roam_cursors").all();
    const journal = openJournal(join(root, "local", "journal.db"));
    const localRoot = join(root, "local-staging");
    const ports = { transport, journal, limits, root: localRoot, operationId: "corrupt-pull" };
    const result = await pullArtifact(peer, manifest, ports);
    expect(result.code).toBe(1);
    expect(result.value).toBeNull();
    expect(replica.db.prepare("SELECT * FROM roam_cursors").all()).toEqual(cursorBefore);
    expect(replica.db.prepare("SELECT * FROM roam_receipts").all()).toEqual([]);
    expect(journal.read("corrupt-pull").some(row => row.action === "done")).toBe(false);
    corrupt = false;
    const recovered = await pullArtifact(peer, manifest, ports);
    expect(recovered.code).toBe(0);
    const store = openStaging(localRoot, boxId, limits);
    try {
      const failedInput = store.reserveValidationCopy(manifest, "failed-validation");
      await expect(validateBatch({ file: failedInput, byteLength: bytes.length, sha256: digest(bytes), header },
        { storeKey: "global", senderMachine: hubId, senderStream: stream, now: Date.now() })).rejects.toThrow(/identity|header/i);
      store.cancelValidationCopy(manifest, "failed-validation");
      expect(existsSync(failedInput)).toBe(false);
      const input = store.reserveValidationCopy(manifest, "validation-attempt-1");
      const validated = await validateBatch({ file: input, byteLength: bytes.length, sha256: digest(bytes), header },
        { storeKey: "global", senderMachine: boxId, senderStream: stream, now: Date.now() });
      const file = store.promoteValidationCopy(manifest, "validation-attempt-1", validated.file);
      applyBatch(replica.db, { ...validated, file }, { hubMachine: hubId, now: Date.now(), sessionHome: () => null,
        effects: { winning() {}, committed() {} } });
      expect(replica.db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine = ? AND peer_stream = ?").get(boxId, stream)).toEqual({ last_seq: 8 });
      const receipt = () => !!replica.db.prepare("SELECT 1 FROM roam_receipts WHERE peer_machine = ? AND batch_id = ? AND sha256 = ?")
        .get(boxId, header.batchId, manifest.sha256);
      store.release(manifest.id, "corrupt-pull");
      store.removeAfterReceipt(manifest, { artifactId: manifest.id, sha256: manifest.sha256 }, receipt);
      expect(existsSync(recovered.value!.file)).toBe(false);
    } finally { store.close(); }
  } finally { replica.close(); }
}, 5000);

it("journal I/O failure is a refusal and never starts a transfer", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "bytes");
  const limits = { ...DEFAULT_LIMITS, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const remote = link(root, limits);
  const journal: Journal = { ...remote.localJournal, begin() {
    throw Object.assign(new Error("journal disk full"), { code: "ENOSPC" });
  } };
  try {
    const result = await transferArtifact(remote.peer, manifest, { transport: remote.transport, journal, limits, root: staging });
    expect(result.code).toBe(1);
    expect(result.reason).toMatch(/journal disk full/);
    const inbound = await pullArtifact(remote.peer, manifest, { transport: remote.transport, journal, limits, root: staging });
    expect(inbound.code).toBe(1);
    expect(remote.resolved()).toBe(0);
  } finally { remote.close(); }
}, 5000);

it("a full peer quota retains chunks and retries the same operation", async () => {
  const { root, source, staging } = fixture();
  const bytes = Buffer.from("data");
  writeFileSync(source, bytes);
  const manifest = await stageArtifact(source, "agent", DEFAULT_LIMITS, { root: staging });
  const pageBytes = createManifestPages(manifest, DEFAULT_LIMITS).pages.reduce((total, page) => total + page.length, 0);
  const limits = { ...DEFAULT_LIMITS, stagingBytes: pageBytes + bytes.length * 2 - 1, retryDelaysMs: [] };
  const remote = link(root, limits);
  const ports = { transport: remote.transport, journal: remote.localJournal, limits, root: staging, operationId: "quota-retry" };
  try {
    const first = await transferArtifact(remote.peer, manifest, ports);
    expect(first.code).toBe(1);
    expect(first.reason).toMatch(/staging full/i);
    expect(remote.localJournal.read("quota-retry").some(item => item.action === "done")).toBe(false);
    remote.restart({ ...limits, stagingBytes: limits.stagingBytes + 1 });
    remote.sent.length = 0;
    const retry = await transferArtifact(remote.peer, manifest, { ...ports, limits: { ...limits, stagingBytes: limits.stagingBytes + 1 } });
    expect(retry.code).toBe(0);
    expect(remote.sent).toEqual([]);
    expect(readFileSync(retry.value!.file)).toEqual(bytes);
  } finally { remote.close(); }
}, 5000);

it("a growing session resends only the new suffix and preserves its prefix", async () => {
  const { root, source, staging } = fixture();
  const limits = { ...DEFAULT_LIMITS, chunkBytes: 4, retryDelaysMs: [] };
  const options = { root: staging, artifactId: "move-session" };
  writeFileSync(source, "abcdef");
  const first = await stageArtifact(source, "session", limits, options);
  const remote = link(root, limits);
  const ports = { transport: remote.transport, journal: remote.localJournal, limits, root: staging };
  try {
    const initial = await transferArtifact(remote.peer, first, { ...ports, operationId: "prefix-op" });
    expect(initial.code).toBe(0);
    writeFileSync(source, "abcdefghij");
    const final = await stageArtifact(source, "session", limits, options);
    remote.sent.length = 0;
    const result = await transferArtifact(remote.peer, final, { ...ports, operationId: "final-op" });
    expect(result.code).toBe(0);
    expect(remote.sent).toEqual([1, 2]);
    expect(readFileSync(initial.value!.file, "utf8")).toBe("abcdef");
    expect(readFileSync(result.value!.file, "utf8")).toBe("abcdefghij");
  } finally { remote.close(); }
}, 5000);

it("three-argument staging and the default operation ID remain usable", async () => {
  const { root, source } = fixture();
  writeFileSync(source, "default-root");
  const manifest = await stageArtifact(source, "agent", DEFAULT_LIMITS);
  expect(defaultStagingRoot()).toBe(join(process.env.SPIDER_GLOBAL_ROOT!, "roam", "staging"));
  const limits = { ...DEFAULT_LIMITS, retryDelaysMs: [] };
  const remote = link(root, limits);
  const ports = { transport: remote.transport, journal: remote.localJournal, limits, root: defaultStagingRoot() };
  try {
    const first = await transferArtifact(remote.peer, manifest, ports);
    const replay = await transferArtifact(remote.peer, manifest, ports);
    expect(first.code).toBe(0);
    expect(replay.code).toBe(0);
    expect(replay.operationId).toBe(first.operationId);
    expect(readFileSync(replay.value!.file, "utf8")).toBe("default-root");
  } finally { remote.close(); }
}, 5000);

it("a malformed success reply cannot advance the transfer", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "bytes");
  const limits = { ...DEFAULT_LIMITS, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const remote = link(root, limits);
  const actions: string[] = [];
  const transport: Transport = { ...remote.transport, async exec(_peer, argv) {
    actions.push((JSON.parse(argv[argv.length - 1]) as { action: string }).action);
    return Buffer.from(JSON.stringify({ code: 0, reason: "incomplete" }));
  } };
  try {
    const result = await transferArtifact(remote.peer, manifest, { transport, journal: remote.localJournal, limits, root: staging });
    expect(result.code).toBe(3);
    expect(actions).toEqual(["begin"]);
  } finally { remote.close(); }
}, 5000);

it("a completion reply cannot select another staged artifact path", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "bytes");
  const limits = { ...DEFAULT_LIMITS, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const remote = link(root, limits);
  const transport: Transport = { ...remote.transport, async exec(peer, argv) {
    const request = JSON.parse(argv[argv.length - 1]) as { operation: Operation };
    const version = request.operation.args.manifestDigest as string;
    return Buffer.from(JSON.stringify({ code: 0, reason: "complete", state: "done",
      file: join(peer.globalRoot, "roam", "staging", "incoming", hubId, "artifacts", "other-artifact", "complete", version),
      artifactId: manifest.id, sha256: manifest.sha256, manifestDigest: version }));
  } };
  try {
    const result = await transferArtifact(remote.peer, manifest, { transport, journal: remote.localJournal, limits, root: staging, operationId: "forged-path" });
    expect(result.code).toBe(3);
    expect(result.value).toBeNull();
    expect(remote.localJournal.read("forged-path").some(row => row.action === "done")).toBe(false);
  } finally { remote.close(); }
}, 5000);

it("a lost assembly reply reconciles the original operation", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "verified content");
  const limits = { ...DEFAULT_LIMITS, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const remote = link(root, limits);
  const ports = { transport: remote.transport, journal: remote.localJournal, limits, root: staging, operationId: "transfer-2" };
  try {
    remote.loseAssemblyReply();
    expect((await transferArtifact(remote.peer, manifest, ports)).code).toBe(3);
    remote.restart();
    remote.sent.length = 0;
    const result = await transferArtifact(remote.peer, manifest, ports);
    expect(result.code).toBe(0);
    expect(remote.sent).toEqual([]);
    expect(readFileSync(result.value!.file, "utf8")).toBe("verified content");
  } finally { remote.close(); }
}, 5000);

it("transfer expiry is durable pending and reuses the operation", async () => {
  const { root, source, staging } = fixture();
  writeFileSync(source, "data");
  const limits = { ...DEFAULT_LIMITS, transferMs: 1, retryDelaysMs: [] };
  const manifest = await stageArtifact(source, "agent", limits, { root: staging });
  const remote = link(root, limits);
  const ports = { transport: remote.transport, journal: remote.localJournal, limits, root: staging, operationId: "transfer-3" };
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  let monotonic = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  remote.afterBegin(() => { vi.setSystemTime(1002); monotonic = 2; });
  try {
    const expired = await transferArtifact(remote.peer, manifest, ports);
    expect(expired.code).toBe(3);
    expect(expired.operationId).toBe("transfer-3");
    expect(remote.calls).toContain("begin");
    expect(remote.localJournal.read("transfer-3").some(item => item.action === "done")).toBe(false);
    remote.afterBegin(() => {});
    const resumed = await transferArtifact(remote.peer, manifest, { ...ports, limits: { ...limits, transferMs: 100 } });
    expect(resumed.code, resumed.reason).toBe(0);
  } finally { clock.mockRestore(); remote.close(); }
}, 5000);

it("restages a growing session only when its original prefix is unchanged", async () => {
  const { source, staging } = fixture();
  const options = { root: staging, artifactId: "move-1" };
  const limits = { ...DEFAULT_LIMITS, chunkBytes: 4 };
  writeFileSync(source, "abcdef");
  const first = await stageArtifact(source, "session", limits, options);
  writeFileSync(source, "abcdefghij");
  const next = await stageArtifact(source, "session", limits, options);
  expect(next.id).toBe(first.id);
  expect(next.chunks[0]).toEqual(first.chunks[0]);
  expect(next.sha256).toBe(digest(Buffer.from("abcdefghij")));
  writeFileSync(source, "abXdefghij");
  await expect(stageArtifact(source, "session", limits, options)).rejects.toThrow(/prefix|changed|conflict/i);
}, 5000);
