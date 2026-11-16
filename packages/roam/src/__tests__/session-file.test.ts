import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { scratchDbPath } from "@spider/db-core/testutil";
import type { Segment } from "@spider/db-core/roam/types";
import { openJournal } from "../journal";
import { DEFAULT_LIMITS } from "../contracts";
import { stageArtifact } from "../artifacts";
import { openOutgoingStaging } from "../staging";
import { inspectSession, installSession, stageSession, verifyFrozenSession } from "../session-file";

const fault = vi.hoisted(() => ({ diskFull: false, markerPartial: false, markerWrote: false,
  descriptors: new Map<number, string>(), observe: null as null | ((kind: string, path: string) => void) }));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    openSync: (...args: unknown[]) => {
      const fd = (real.openSync as (...values: unknown[]) => number)(...args);
      if (typeof args[0] === "string") fault.descriptors.set(fd, args[0]);
      return fd;
    },
    closeSync: (fd: number) => { fault.descriptors.delete(fd); real.closeSync(fd); },
    writeSync: (...args: unknown[]) => {
      if (fault.diskFull) throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
      if (fault.markerPartial && fault.descriptors.get(args[0] as number)?.endsWith("/prepared/marker.json.part")) {
        if (!fault.markerWrote && Buffer.isBuffer(args[1])) {
          fault.markerWrote = true;
          return real.writeSync(args[0] as number, args[1], args[2] as number, 170, args[4] as number);
        }
        throw Object.assign(new Error("fixture marker interruption"), { code: "ENOSPC" });
      }
      const count = (real.writeSync as (...values: unknown[]) => number)(...args);
      fault.observe?.("write", fault.descriptors.get(args[0] as number) ?? "");
      return count;
    },
    linkSync: (...args: unknown[]) => {
      (real.linkSync as (...values: unknown[]) => void)(...args);
      fault.observe?.("backup", String(args[1]));
    },
    renameSync: (...args: unknown[]) => {
      (real.renameSync as (...values: unknown[]) => void)(...args);
      fault.observe?.("rename", String(args[1]));
    },
  };
});

const roots: string[] = [];
const stamp = "2026-01-02T03:04:05.000Z";
const sessionId = "session-1";
const machineA = "00000000-0000-4000-8000-000000000001";
const machineB = "00000000-0000-4000-8000-000000000002";
const segment: Segment = {
  version: 1, moveId: "move-1", epoch: 2, previousMachine: machineA,
  nextMachine: machineB, historyMachine: machineA, parentRef: null,
};
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const entry = (id: string, parentId: string | null, content = id) => ({
  type: "message", id, parentId, timestamp: stamp, message: { role: "user", content, timestamp: 1 },
});

function fixture(parentSession?: string) {
  const root = mkdtempSync(join(dirname(scratchDbPath("session-file")), "session-file-"));
  roots.push(root);
  const cwd = join(root, "old-cwd"), mappedCwd = join(root, "new-cwd");
  mkdirSync(cwd); mkdirSync(mappedCwd);
  const file = join(root, "source.jsonl");
  const header = { type: "session", version: 3, id: sessionId, timestamp: stamp, cwd,
    ...(parentSession === undefined ? {} : { parentSession }) };
  const history = line(entry("root", null)) + line(entry("selected", "root")) + line(entry("later", "root"));
  writeFileSync(file, line(header) + history, { mode: 0o600 });
  return { root, cwd, mappedCwd, file, header, history };
}
function journal(root: string) {
  const result = openJournal(join(root, "journal.db"));
  result.begin({ id: segment.moveId, machineId: machineA, expectedEpoch: 1, kind: "move", args: {} });
  return result;
}
const withBothLocks = async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn();
interface QueuedLocks {
  withBothLocks<T>(id: string, fn: () => Promise<T>): Promise<T>;
  claim(): Promise<void>;
  held(): boolean;
  events: Array<{ name: string; held: boolean }>;
}
function queuedLocks(): QueuedLocks {
  let held = false;
  const events: QueuedLocks["events"] = [], waiters: Array<() => void> = [];
  return {
    events, held: () => held,
    async withBothLocks<T>(id: string, fn: () => Promise<T>): Promise<T> {
      if (held || id !== sessionId) throw new Error("lock unavailable");
      held = true; events.push({ name: "acquired", held });
      try { return await fn(); }
      finally {
        held = false; events.push({ name: "released", held });
        for (const resolve of waiters.splice(0)) resolve();
      }
    },
    async claim() {
      events.push({ name: held ? "claim-waiting" : "claim-ready", held });
      if (held) await new Promise<void>(resolve => waiters.push(resolve));
      events.push({ name: "claim-acquired", held });
    },
  };
}
function lines(file: string) { return readFileSync(file, "utf8").trimEnd().split("\n"); }
function marker(file: string) { return JSON.parse(lines(file).at(-1)!) as { id: string; parentId: string; type: string; customType: string; data: Segment }; }

afterEach(() => {
  fault.diskFull = false;
  fault.markerPartial = false; fault.markerWrote = false; fault.descriptors.clear();
  fault.observe = null;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("rewrite changes only header and appends non-context marker", async () => {
  const f = fixture("/origin/parent.jsonl");
  const source = await inspectSession(f.file, sessionId, "selected");
  const staged = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent: null, segment }, join(f.root, "staging"));
  const output = lines(staged.file), header = JSON.parse(output[0]);
  const appended = marker(staged.file);
  expect(header).toEqual({ ...f.header, cwd: f.mappedCwd, parentSession: undefined });
  expect(output.slice(1, -1).join("\n") + "\n").toBe(f.history);
  expect(staged.historySha256).toBe(digest(f.history));
  expect(staged.sha256).toBe(digest(readFileSync(staged.file)));
  expect(appended).toMatchObject({ type: "custom", customType: "spider-roam-segment", parentId: "selected" });
  expect(appended.id).not.toBe("selected");
  expect(appended.data).toEqual({ ...segment, parentRef: { machineId: machineA, reference: "/origin/parent.jsonl" } });
  expect(staged.leaf).toBe(appended.id);
}, 5000);

it("maps a known destination parent without rewriting historical paths", async () => {
  const f = fixture("/origin/parent.jsonl");
  const source = await inspectSession(f.file, sessionId);
  const destinationParent = join(f.root, "mapped-parent.jsonl");
  const stale = { machineId: machineA, reference: "/stale/parent.jsonl" };
  const staged = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent,
    segment: { ...segment, parentRef: stale } }, join(f.root, "staging"));
  expect(JSON.parse(lines(staged.file)[0]).parentSession).toBe(destinationParent);
  expect(marker(staged.file).data.parentRef).toBeNull();
  expect(lines(staged.file).slice(1, -1).join("\n") + "\n").toBe(f.history);
}, 5000);

it.each(["first", "middle", "last", "missing"] as const)("header rewrite preserves unknown metadata with parent %s", async position => {
  const f = fixture();
  const parentSession = "/origin/parent.jsonl";
  const extra = { text: "☃", nested: [1, { path: "/historical/path" }] };
  const header = position === "first" ? { parentSession, ...f.header, extra }
    : position === "middle" ? { type: "session", version: 3, parentSession, id: sessionId, timestamp: stamp, cwd: f.cwd, extra }
    : position === "last" ? { ...f.header, extra, parentSession } : { ...f.header, extra };
  writeFileSync(f.file, line(header) + f.history);
  const mappedParent = position === "middle" || position === "missing" ? join(f.root, "mapped-parent.jsonl") : null;
  const source = await inspectSession(f.file, sessionId, "selected");
  const staged = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent: mappedParent, segment }, join(f.root, "staging"));
  const expected: Record<string, unknown> = { ...header, cwd: f.mappedCwd };
  if (mappedParent === null) delete expected.parentSession; else expected.parentSession = mappedParent;
  expect(JSON.parse(lines(staged.file)[0])).toEqual(expected);
  expect(lines(staged.file).slice(1, -1).join("\n") + "\n").toBe(f.history);
  expect(marker(staged.file).data.parentRef).toEqual(mappedParent === null && position !== "missing"
    ? { machineId: machineA, reference: parentSession } : null);
}, 5000);

it("header rewrite preserves opaque fields larger than a staging chunk", async () => {
  const f = fixture();
  const opaque = "x".repeat(DEFAULT_LIMITS.chunkBytes + 100);
  const header = { type: "session", version: 3, id: sessionId, opaque, timestamp: stamp, cwd: f.cwd };
  writeFileSync(f.file, line(header) + f.history);
  const source = await inspectSession(f.file, sessionId, "selected");
  const staged = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent: null, segment }, join(f.root, "staging"));
  expect(JSON.parse(lines(staged.file)[0])).toEqual({ ...header, cwd: f.mappedCwd });
  expect(lines(staged.file).slice(1, -1).join("\n") + "\n").toBe(f.history);
}, 5000);

it("rewrites escaped header keys without changing other header bytes", async () => {
  const f = fixture("/origin/parent.jsonl");
  const mappedParent = join(f.root, "parent.jsonl");
  const header = `{ "type": "session", "version": 3, "id": ${JSON.stringify(sessionId)}, "timestamp": ${JSON.stringify(stamp)}, "c\\u0077d": ${JSON.stringify(f.cwd)}, "parent\\u0053ession": "/origin/parent.jsonl", "extra": [1, {"untouched": true}] }\r\n`;
  writeFileSync(f.file, header + f.history);
  const source = await inspectSession(f.file, sessionId, "selected");
  const staged = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent: mappedParent, segment }, join(f.root, "staging"));
  const expectedHeader = header.replace(JSON.stringify(f.cwd), JSON.stringify(f.mappedCwd))
    .replace(JSON.stringify("/origin/parent.jsonl"), JSON.stringify(mappedParent));
  expect(readFileSync(staged.file, "utf8").startsWith(expectedHeader + f.history)).toBe(true);
  expect(marker(staged.file).data.parentRef).toBeNull();
}, 5000);

it("validates ignored JSON payload syntax across chunks", async () => {
  const f = fixture();
  const prefix = `{"type":"future_extension","id":"root","parentId":null,"timestamp":${JSON.stringify(stamp)},"payload":`;
  const valid = [null, true, false, 0, -0.02, 1e30, "quotes \\\" and snow ☃", [1, { deep: [null, true] }],
    { data: { parentRef: { machineId: "opaque", reference: "x" } }, escaped: "\\n\\t" }, "x".repeat(65_450) + "☃"];
  for (const payload of valid) {
    writeFileSync(f.file, line(f.header) + prefix + JSON.stringify(payload) + "}\n");
    expect((await inspectSession(f.file, sessionId)).leaf).toBe("root");
  }
  const invalidPayloads = ["01", "1.", "+1", ".1", "1e", "truex", "[1,]", '{"x":1,}', '"\\q"', '"\\uZZZZ"',
    '"' + String.fromCharCode(1) + '"', "[1 2]", "Infinity"];
  for (const payload of invalidPayloads) {
    const raw = prefix + payload + "}";
    expect(() => JSON.parse(raw)).toThrow();
    writeFileSync(f.file, line(f.header) + raw + "\n");
    await expect(inspectSession(f.file, sessionId)).rejects.toThrow();
  }
}, 5000);

it("unknown entries and compaction bytes remain unchanged", async () => {
  const f = fixture();
  const unknown = '{ "type" : "future_extension", "id":"opaque", "parentId":"selected", "timestamp":"2026-01-02T03:04:05.000Z", "payload": { "path":"/old/path", "nested": [1, null] } }\n';
  const compact = '{"type":"compaction", "id":"compact", "parentId":"opaque", "timestamp":"2026-01-02T03:04:05.000Z", "firstKeptEntryId":"selected", "summary":"old /path", "tokensBefore":42, "details":{"readFiles":["/old/path"]}}\n';
  const history = line(entry("root", null)) + line(entry("selected", "root")) + unknown + compact;
  writeFileSync(f.file, line(f.header) + history);
  const source = await inspectSession(f.file, sessionId);
  const staged = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent: null, segment }, join(f.root, "staging"));
  expect(lines(staged.file).slice(1, -1).join("\n") + "\n").toBe(history);
  expect(staged.historySha256).toBe(digest(history));
}, 5000);

it("empty missing partial or invalid graph refuses", async () => {
  const f = fixture();
  const goodHeader = line(f.header);
  const goodRoot = line(entry("root", null));
  const invalidFiles: Array<[string, string | Buffer]> = [
    ["empty", ""],
    ["header-only", goodHeader],
    ["partial", goodHeader + goodRoot.trimEnd()],
    ["invalid-json", goodHeader + goodRoot + '{"type":}\n'],
    ["bad-header", line({ ...f.header, version: 2 }) + goodRoot],
    ["bad-header-time", line({ ...f.header, timestamp: "not-a-date" }) + goodRoot],
    ["bad-entry-time", goodHeader + line({ ...entry("root", null), timestamp: "not-a-date" })],
    ["wrong-id", line({ ...f.header, id: "other" }) + goodRoot],
    ["duplicate", goodHeader + goodRoot + line(entry("root", "root"))],
    ["bad-parent", goodHeader + goodRoot + line(entry("child", "missing"))],
    ["future-parent", goodHeader + line(entry("child", "root")) + goodRoot],
    ["bad-compaction", goodHeader + goodRoot + line({ type: "compaction", id: "compact", parentId: "root", timestamp: stamp, firstKeptEntryId: "missing", summary: "x", tokensBefore: 1 })],
    ["invalid-utf8", Buffer.concat([Buffer.from(goodHeader + goodRoot), Buffer.from([0xff, 0x0a])])],
  ];
  await expect(inspectSession(join(f.root, "missing.jsonl"), sessionId)).rejects.toThrow();
  for (const [name, content] of invalidFiles) {
    const path = join(f.root, `${name}.jsonl`);
    writeFileSync(path, content);
    await expect(inspectSession(path, sessionId), name).rejects.toThrow();
  }
  await expect(inspectSession(f.file, sessionId, "missing-leaf")).rejects.toThrow();
}, 5000);

it.each(["header", "entry"] as const)("streams large opaque %s data without buffering the transcript", kind => {
  const f = fixture(), payloadSize = 32 * 1024 * 1024;
  const fd = openSync(f.file, "w", 0o600);
  try {
    if (kind === "header") {
      writeSync(fd, `{"type":"session","version":3,"id":${JSON.stringify(sessionId)},"timestamp":${JSON.stringify(stamp)},"opaque":"`);
    } else {
      writeSync(fd, line(f.header));
      writeSync(fd, '{"type":"future_extension","id":"root","parentId":null,"timestamp":"2026-01-02T03:04:05.000Z","payload":"');
    }
    const block = Buffer.alloc(64 * 1024, "x");
    for (let at = 0; at < payloadSize; at += block.length) writeSync(fd, block);
    if (kind === "header") writeSync(fd, `","cwd":${JSON.stringify(f.cwd)}}\n${line(entry("root", null))}`);
    else writeSync(fd, '"}\n');
  } finally { closeSync(fd); }
  const loader = join(f.root, "loader.mjs"), runner = join(f.root, "runner.mjs");
  writeFileSync(loader, `import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !/\\.[a-z]+$/i.test(specifier)) return next(specifier + ".ts", context);
      throw error;
    }
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".ts"))
      return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "strip" }), shortCircuit: true };
    return next(url, context);
  },
});\n`);
  const moduleUrl = pathToFileURL(join(process.cwd(), "packages/roam/src/session-file.ts")).href;
  writeFileSync(runner, `const { inspectSession } = await import(${JSON.stringify(moduleUrl)});
const before = process.memoryUsage().rss;
const result = await inspectSession(process.argv[2], ${JSON.stringify(sessionId)});
console.log(JSON.stringify({ before, maxRss: process.resourceUsage().maxRSS, leaf: result.leaf }));\n`);
  const global = join(f.root, "global"); mkdirSync(global);
  const child = spawnSync(process.execPath, ["--no-warnings", "--max-old-space-size=64", "--import", loader, runner, f.file], {
    encoding: "utf8", timeout: 4000, env: { ...process.env, HOME: f.root, SPIDER_GLOBAL_ROOT: global, NODE_OPTIONS: "" },
  });
  expect(child.status, child.error?.message ?? child.stderr).toBe(0);
  const measured = JSON.parse(child.stdout) as { before: number; maxRss: number; leaf: string };
  expect(measured.leaf).toBe("root");
  expect(measured.maxRss * 1024 - measured.before).toBeLessThan(payloadSize * 2);
}, 5000);

it("rejects session IDs Pi cannot safely reopen", async () => {
  const f = fixture();
  const id = "../bad/session";
  writeFileSync(f.file, line({ ...f.header, id }) + line(entry("root", null)));
  await expect(inspectSession(f.file, id)).rejects.toThrow();
}, 5000);

it("accepts retain-none compaction and selects the last physical entry when dormant", async () => {
  const f = fixture();
  appendFileSync(f.file, line({ type: "compaction", id: "compact", parentId: "later", timestamp: stamp, firstKeptEntryId: "compact", summary: "x", tokensBefore: 1 }));
  const inspected = await inspectSession(f.file, sessionId);
  expect(inspected.leaf).toBe("compact");
  expect(inspected.sha256).toBe(digest(readFileSync(f.file)));
  expect(inspected.cwd).toBe(f.cwd);
}, 5000);

it("source prefix or metadata append invalidates frozen manifest", async () => {
  const f = fixture();
  const original = readFileSync(f.file);
  const frozen = await inspectSession(f.file, sessionId, "selected");
  appendFileSync(f.file, line({ type: "session_info", id: "metadata", parentId: "later", timestamp: stamp, name: "changed" }));
  await expect(verifyFrozenSession(frozen)).rejects.toThrow();
  await expect(stageSession({ source: frozen, destinationCwd: f.mappedCwd, destinationParent: null, segment }, join(f.root, "staging"))).rejects.toThrow();
  const changed = Buffer.from(original);
  const at = changed.indexOf(Buffer.from('"root"'));
  changed[at + 1] = "R".charCodeAt(0);
  writeFileSync(f.file, changed);
  await expect(verifyFrozenSession(frozen)).rejects.toThrow();
}, 5000);

it("pre-staged source chunks are reused and changed prefixes refuse", async () => {
  const f = fixture();
  const bigHistory = line(entry("root", null, "root")) + line(entry("selected", "root", "x".repeat(DEFAULT_LIMITS.chunkBytes + 100)));
  writeFileSync(f.file, line(f.header) + bigHistory);
  const staging = join(f.root, "staging");
  const source = await inspectSession(f.file, sessionId);
  const first = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent: null, segment }, staging);
  let store = openOutgoingStaging(staging, { ...DEFAULT_LIMITS }, false);
  const pre = store.inspect(first.artifactId).current; store.close();
  expect(pre?.sha256).toBe(source.sha256);
  expect(pre?.chunks[0].rawLength).toBe(DEFAULT_LIMITS.chunkBytes);
  appendFileSync(f.file, line(entry("next", "selected")));
  const finalSource = await inspectSession(f.file, sessionId);
  const final = await stageSession({ source: finalSource, destinationCwd: f.mappedCwd, destinationParent: null, segment }, staging);
  store = openOutgoingStaging(staging, { ...DEFAULT_LIMITS }, false);
  const complete = store.inspect(final.artifactId).current; store.close();
  expect(final.artifactId).toBe(first.artifactId);
  expect(complete?.chunks[0]).toEqual(pre?.chunks[0]);
  expect(complete?.sha256).toBe(finalSource.sha256);
  const priorOutput = readFileSync(final.file);
  writeFileSync(f.file, readFileSync(f.file, "utf8").replace('"content":"root"', '"content":"ROOT"'));
  const changed = await inspectSession(f.file, sessionId);
  await expect(stageSession({ source: changed, destinationCwd: f.mappedCwd, destinationParent: null, segment }, staging)).rejects.toThrow(/prefix|changed|conflict/i);
  expect(readFileSync(final.file)).toEqual(priorOutput);
}, 5000);

it("prepared sessions count against outgoing quota and share artifact cleanup", async () => {
  const f = fixture(), source = await inspectSession(f.file, sessionId, "selected"), root = join(f.root, "staging");
  const limits = { ...DEFAULT_LIMITS, stagingBytes: source.size * 3 + 1024 };
  const input = { source, destinationCwd: f.mappedCwd, destinationParent: null, segment, limits };
  const staged = await stageSession(input, root);
  expect(staged.file.startsWith(join(root, "outgoing", segment.moveId) + sep)).toBe(true);
  expect((await stageSession(input, root)).sha256).toBe(staged.sha256);
  const other = join(f.root, "other");
  writeFileSync(other, Buffer.alloc(limits.stagingBytes - source.size - 1, "x"));
  await expect(stageArtifact(other, "agent", limits, { root, artifactId: "other" }))
    .rejects.toMatchObject({ code: "STAGING_FULL", retryable: true });
  expect(existsSync(staged.file)).toBe(true);
  const store = openOutgoingStaging(root, limits, false);
  try { store.remove(segment.moveId); } finally { store.close(); }
  expect(existsSync(staged.file)).toBe(false);
  expect((await stageArtifact(other, "agent", limits, { root, artifactId: "other" })).byteLength)
    .toBe(limits.stagingBytes - source.size - 1);
}, 5000);

it("session preparation honors configured chunk and session limits", async () => {
  const f = fixture(), source = await inspectSession(f.file, sessionId), root = join(f.root, "staging");
  const limits = { ...DEFAULT_LIMITS, chunkBytes: 64, sessionBytes: source.size + 4096 };
  const input = { source, destinationCwd: f.mappedCwd, destinationParent: null, segment, limits };
  const staged = await stageSession(input, root);
  const store = openOutgoingStaging(root, limits, false);
  try {
    const artifact = store.inspect(segment.moveId).current;
    expect(artifact?.chunks.length).toBeGreaterThan(1);
    expect(artifact?.chunks.every(chunk => chunk.rawLength <= 64)).toBe(true);
  } finally { store.close(); }
  expect(staged.size).toBeGreaterThan(source.size);
  await expect(stageSession({ ...input, limits: { ...limits, sessionBytes: source.size } }, join(f.root, "small-staging")))
    .rejects.toThrow(/size limit/i);
}, 5000);

it("inspection, freeze verification, and installation honor configured session limits", async () => {
  const f = fixture(), source = await inspectSession(f.file, sessionId);
  const tooSmall = { ...DEFAULT_LIMITS, sessionBytes: source.size - 1 };
  await expect(inspectSession(f.file, sessionId, undefined, tooSmall)).rejects.toThrow(/oversized|size/i);
  await expect(verifyFrozenSession(source, tooSmall)).rejects.toThrow(/oversized|size/i);
  const staged = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent: null, segment }, join(f.root, "staging"));
  const target = join(f.root, "destination", "session.jsonl"), ports = { journal: journal(f.root), withBothLocks,
    ownership: async () => ({ kind: "absent" as const }), limits: { ...DEFAULT_LIMITS, sessionBytes: staged.size - 1 } };
  await expect(installSession(staged, target, ports)).rejects.toThrow(/oversized|size/i);
  expect(existsSync(target)).toBe(false);
  await installSession(staged, target, { ...ports, limits: { ...DEFAULT_LIMITS, sessionBytes: staged.size } });
  expect(readFileSync(target)).toEqual(readFileSync(staged.file));
}, 5000);

it("retrying a prepared session never writes a second unreserved copy", async () => {
  const f = fixture(), source = await inspectSession(f.file, sessionId), root = join(f.root, "staging");
  const input = { source, destinationCwd: f.mappedCwd, destinationParent: null, segment };
  const staged = await stageSession(input, root), identity = join(dirname(staged.file), "marker.json");
  const quota = source.size + staged.size + lstatSync(identity).size;
  let peak = quota;
  fault.observe = (kind, path) => {
    if (kind !== "write" || !path.startsWith(dirname(staged.file))) return;
    const part = `${staged.file}.part`;
    peak = Math.max(peak, source.size + lstatSync(identity).size + lstatSync(staged.file).size +
      (existsSync(part) ? lstatSync(part).size : 0));
  };
  const retried = await stageSession({ ...input, limits: { ...DEFAULT_LIMITS, stagingBytes: quota } }, root);
  expect(retried.sha256).toBe(staged.sha256);
  expect(peak).toBeLessThanOrEqual(quota);
}, 5000);

it("prestage and freeze can select different leaves without changing source bytes", async () => {
  const f = fixture(), root = join(f.root, "staging");
  const firstSource = await inspectSession(f.file, sessionId, "selected");
  const first = await stageSession({ source: firstSource, destinationCwd: f.mappedCwd, destinationParent: null, segment }, root);
  const original = readFileSync(first.file);
  const finalSource = await inspectSession(f.file, sessionId, "later");
  expect(finalSource.sha256).toBe(firstSource.sha256);
  const final = await stageSession({ source: finalSource, destinationCwd: f.mappedCwd, destinationParent: null, segment }, root);
  expect(marker(final.file).parentId).toBe("later");
  expect(marker(first.file).parentId).toBe("selected");
  expect(readFileSync(first.file)).toEqual(original);
  expect(final.file).not.toBe(first.file);
}, 5000);

it("a partial marker write can be retried under the same reservation", async () => {
  const f = fixture(), source = await inspectSession(f.file, sessionId), root = join(f.root, "staging");
  const input = { source, destinationCwd: f.mappedCwd, destinationParent: null, segment };
  fault.markerPartial = true;
  await expect(stageSession(input, root)).rejects.toThrow(/marker interruption/i);
  fault.markerPartial = false;
  const partial = join(root, "outgoing", segment.moveId, "prepared", "marker.json.part");
  expect(existsSync(partial)).toBe(true);
  const staged = await stageSession(input, root);
  expect(marker(staged.file).data.moveId).toBe(segment.moveId);
  expect(existsSync(partial)).toBe(false);
}, 5000);

it.skipIf(process.platform === "win32")("restaging repairs exposed prepared file and marker permissions", async () => {
  const f = fixture(), source = await inspectSession(f.file, sessionId), root = join(f.root, "staging");
  const input = { source, destinationCwd: f.mappedCwd, destinationParent: null, segment };
  const staged = await stageSession(input, root), identity = join(dirname(staged.file), "marker.json");
  chmodSync(staged.file, 0o644); chmodSync(identity, 0o644);
  const retried = await stageSession(input, root);
  expect(retried.sha256).toBe(staged.sha256);
  expect(lstatSync(retried.file).mode & 0o777).toBe(0o600);
  expect(lstatSync(identity).mode & 0o777).toBe(0o600);
}, 5000);

it.skipIf(process.platform === "win32")("creates a readable prepared file under a restrictive umask in an existing artifact", async () => {
  const f = fixture(), source = await inspectSession(f.file, sessionId), root = join(f.root, "staging");
  await stageArtifact(f.file, "session", DEFAULT_LIMITS, { root, artifactId: segment.moveId });
  mkdirSync(join(root, "outgoing", segment.moveId, "prepared"), { mode: 0o700 });
  const previous = process.umask(0o777);
  try {
    const staged = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent: null, segment }, root);
    expect(lstatSync(staged.file).mode & 0o777).toBe(0o600);
    expect(readFileSync(staged.file).length).toBe(staged.size);
  } finally { process.umask(previous); }
}, 5000);

it.skipIf(process.platform === "win32")("restages a private readable session under a restrictive umask", async () => {
  const f = fixture();
  const source = await inspectSession(f.file, sessionId, "selected");
  const input = { source, destinationCwd: f.mappedCwd, destinationParent: null, segment };
  const root = join(f.root, "staging");
  const first = await stageSession(input, root);
  const previous = process.umask(0o777);
  try {
    const again = await stageSession(input, root);
    expect(again.sha256).toBe(first.sha256);
    expect(readFileSync(again.file)).toEqual(readFileSync(first.file));
    expect(lstatSync(again.file).mode & 0o777).toBe(0o600);
  } finally { process.umask(previous); }
}, 5000);

it("journal exposes the stored machine and operation state", () => {
  const f = fixture();
  const log = journal(f.root);
  expect(log.lookupOperation(segment.moveId)).toEqual({ machineId: machineA, state: "pending" });
  expect(log.lookupOperation("missing")).toBeNull();
  log.record(segment.moveId, "done", { complete: true });
  expect(openJournal(join(f.root, "journal.db")).lookupOperation(segment.moveId)).toEqual({ machineId: machineA, state: "done" });
}, 5000);

it("prior same-ID file requires dormancy prefix and backup", async () => {
  const f = fixture();
  const source = await inspectSession(f.file, sessionId, "selected");
  const staged = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent: null, segment }, join(f.root, "staging"));
  const destination = join(f.root, "destination"); mkdirSync(destination, { mode: 0o700 });
  const target = join(destination, "session.jsonl");
  const prior = line({ ...f.header, cwd: f.mappedCwd }) + line(entry("root", null));
  writeFileSync(target, prior, { mode: 0o600 });
  const log = journal(f.root);
  const before = readFileSync(target);
  await expect(installSession(staged, target, { journal: log, withBothLocks, ownership: async () => ({ kind: "uncertain" }) })).rejects.toThrow();
  expect(readFileSync(target)).toEqual(before);
  await expect(installSession(staged, target, { journal: log, withBothLocks, ownership: async () => ({ kind: "live", identity: { bootId: "boot", pid: 1, startTime: "1" } }) })).rejects.toThrow();
  expect(readFileSync(target)).toEqual(before);
  const divergent = line({ ...f.header, cwd: f.mappedCwd }) + line(entry("different", null));
  writeFileSync(target, divergent);
  await expect(installSession(staged, target, { journal: log, withBothLocks, ownership: async () => ({ kind: "absent" }) })).rejects.toThrow();
  expect(readFileSync(target, "utf8")).toBe(divergent);
  writeFileSync(target, prior);
  await installSession(staged, target, { journal: log, withBothLocks, ownership: async () => ({ kind: "absent" }) });
  expect(readFileSync(target)).toEqual(readFileSync(staged.file));
  const backup = readdirSync(destination).map(name => join(destination, name)).find(path => path !== target && lstatSync(path).isFile() && readFileSync(path, "utf8") === prior);
  expect(backup).toBeDefined();
  if (process.platform !== "win32") expect(lstatSync(backup!).mode & 0o777).toBe(0o600);
}, 5000);

it("destination locks cover ownership backup and rename while a claimant waits", async () => {
  const f = fixture();
  const source = await inspectSession(f.file, sessionId, "selected");
  const staged = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent: null, segment }, join(f.root, "staging"));
  const directory = join(f.root, "destination"); mkdirSync(directory, { mode: 0o700 });
  const target = join(directory, "session.jsonl");
  writeFileSync(target, line({ ...f.header, cwd: f.mappedCwd }) + line(entry("root", null)), { mode: 0o600 });
  const locks = queuedLocks();
  fault.observe = (kind, path) => {
    if (kind === "backup" || kind === "rename" && path === target) locks.events.push({ name: kind, held: locks.held() });
  };
  let claim: Promise<void> | undefined;
  await installSession(staged, target, {
    journal: journal(f.root), withBothLocks: locks.withBothLocks,
    ownership: async () => {
      locks.events.push({ name: "ownership", held: locks.held() });
      claim ??= locks.claim();
      return { kind: "absent" };
    },
  });
  await claim;
  for (const name of ["ownership", "backup", "rename"]) {
    const observations = locks.events.filter(event => event.name === name);
    expect(observations.length, name).toBeGreaterThan(0);
    expect(observations.every(event => event.held), name).toBe(true);
  }
  expect(locks.events.find(event => event.name === "claim-waiting")?.held).toBe(true);
  expect(locks.events.findIndex(event => event.name === "claim-acquired")).toBeGreaterThan(locks.events.findIndex(event => event.name === "released"));
  expect(readFileSync(target)).toEqual(readFileSync(staged.file));
}, 5000);

it("a failed install releases both destination locks", async () => {
  const f = fixture();
  const source = await inspectSession(f.file, sessionId);
  const staged = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent: null, segment }, join(f.root, "staging"));
  const directory = join(f.root, "destination"); mkdirSync(directory, { mode: 0o700 });
  const target = join(directory, "session.jsonl"), locks = queuedLocks(), log = journal(f.root);
  fault.diskFull = true;
  await expect(installSession(staged, target, { journal: log, withBothLocks: locks.withBothLocks,
    ownership: async () => ({ kind: "absent" }) })).rejects.toThrow();
  fault.diskFull = false;
  expect(locks.events.map(event => event.name)).toEqual(["acquired", "released"]);
  expect(locks.held()).toBe(false);
  await locks.claim();
  expect(locks.events.at(-1)?.name).toBe("claim-acquired");
  expect(existsSync(target)).toBe(false);
}, 5000);

it.each(["header", "history", "marker"] as const)("install rejects tampered %s without replacing the target", async kind => {
  const f = fixture();
  const source = await inspectSession(f.file, sessionId, "selected");
  const staged = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent: null, segment }, join(f.root, "staging"));
  const directory = join(f.root, "destination"); mkdirSync(directory, { mode: 0o700 });
  const target = join(directory, "session.jsonl");
  const prior = line({ ...f.header, cwd: f.mappedCwd }) + line(entry("root", null));
  writeFileSync(target, prior, { mode: 0o600 });
  let bytes = readFileSync(staged.file, "utf8");
  if (kind === "header") bytes = bytes.replace(JSON.stringify(f.mappedCwd), JSON.stringify(f.cwd));
  if (kind === "history") bytes = bytes.replace('"content":"root"', '"content":"ROOT"');
  if (kind === "marker") bytes = bytes.replace("spider-roam-segment", "spider-roam-other");
  writeFileSync(staged.file, bytes);
  const forged = { ...staged, size: Buffer.byteLength(bytes), sha256: digest(bytes) };
  await expect(installSession(forged, target, { journal: journal(f.root), withBothLocks, ownership: async () => ({ kind: "absent" }) })).rejects.toThrow();
  expect(readFileSync(target, "utf8")).toBe(prior);
}, 5000);

it("install rejects a forged history digest even when no destination exists", async () => {
  const f = fixture();
  const source = await inspectSession(f.file, sessionId, "selected");
  const staged = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent: null, segment }, join(f.root, "staging"));
  const directory = join(f.root, "destination"); mkdirSync(directory, { mode: 0o700 });
  const target = join(directory, "session.jsonl");
  const changed = readFileSync(staged.file, "utf8").replace('"content":"root"', '"content":"ROOT"');
  writeFileSync(staged.file, changed);
  const forged = { ...staged, size: Buffer.byteLength(changed), sha256: digest(changed) };
  await expect(installSession(forged, target, { journal: journal(f.root), withBothLocks, ownership: async () => ({ kind: "absent" }) })).rejects.toThrow();
  expect(existsSync(target)).toBe(false);
}, 5000);

it("atomic install refuses symlink or disk-full", async () => {
  const f = fixture();
  const source = await inspectSession(f.file, sessionId);
  const staged = await stageSession({ source, destinationCwd: f.mappedCwd, destinationParent: null, segment }, join(f.root, "staging"));
  const destination = join(f.root, "destination"); mkdirSync(destination, { mode: 0o700 });
  const target = join(destination, "session.jsonl"), unrelated = join(f.root, "unrelated");
  const log = journal(f.root);
  writeFileSync(unrelated, "do not change");
  symlinkSync(unrelated, target);
  await expect(installSession(staged, target, { journal: log, withBothLocks, ownership: async () => ({ kind: "absent" }) })).rejects.toThrow();
  expect(readFileSync(unrelated, "utf8")).toBe("do not change");
  expect(lstatSync(target).isSymbolicLink()).toBe(true);
  rmSync(target);
  fault.diskFull = true;
  await expect(installSession(staged, target, { journal: log, withBothLocks, ownership: async () => ({ kind: "absent" }) })).rejects.toThrow();
  fault.diskFull = false;
  expect(existsSync(target)).toBe(false);
  const prior = line({ ...f.header, cwd: f.mappedCwd }) + line(entry("root", null));
  writeFileSync(target, prior, { mode: 0o600 });
  const before = readFileSync(target);
  fault.diskFull = true;
  await expect(installSession(staged, target, { journal: log, withBothLocks, ownership: async () => ({ kind: "absent" }) })).rejects.toThrow();
  fault.diskFull = false;
  expect(readFileSync(target)).toEqual(before);
  expect(existsSync(staged.file)).toBe(true);
}, 5000);
