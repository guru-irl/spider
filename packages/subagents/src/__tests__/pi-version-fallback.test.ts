import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync, utimesSync } from "node:fs";
import { join, delimiter } from "node:path";
import { randomUUID } from "node:crypto";
import { freshDb, testScratchPath } from "./helpers/testutil";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";

const state = vi.hoisted(() => ({ reads: 0, unreadable: "" }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: any[]) => {
    if (String(args[0]).includes("pi-version-") && String(args[0]).endsWith("package.json")) state.reads++;
    if (String(args[0]) === state.unreadable) throw Object.assign(new Error("EACCES fixture"), { code: "EACCES" });
    return (actual.readFileSync as any)(...args);
  } };
});
const roots: string[] = [];
afterEach(() => { state.unreadable = ""; vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function binary(version: unknown, failure?: "unreadable" | "missing") {
  const root = testScratchPath(`pi-version-${randomUUID()}`); roots.push(root);
  mkdirSync(join(root, "dist"), { recursive: true });
  const entry = join(root, "dist", "cli.js");
  writeFileSync(entry, "#!/usr/bin/env node\nthrow new Error('Version lookup must never spawn pi');\n"); chmodSync(entry, 0o755);
  if (failure !== "missing") writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, bin: { pi: "dist/cli.js" } }));
  return { entry, root };
}
const cases: Array<[string, "print" | "rpc"]> = [
  ["0.80.0", "print"], ["0.84.9", "print"], ["0.85.0", "print"],
  ["0.85.1-beta.1", "print"], ["0.85.1-0", "print"], ["0.85.1-beta+build", "print"],
  ["0.85.1", "rpc"], ["0.85.1+build.7", "rpc"], ["0.85.2-rc.1", "rpc"],
  ["0.86.0-alpha", "rpc"], ["0.87.0", "rpc"], ["1.0.0-rc.1", "rpc"], ["10.0.0", "rpc"],
];
const input = () => ({ runId: randomUUID(), sessionId: "owner", parentSessionId: "owner", childIndex: 0, agent: "worker", task: "work", context: "fresh" as const, dbPath: "fixture.db", scratchRoot: testScratchPath("version-cache"), intercomExtensions: ["intercom.ts"], orchestratorTarget: "parent" });

it.each(cases)("uses %s metadata from the launched binary to choose %s", async (version, mode) => {
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", binary(version).entry);
  const { Runner } = await import("../runner");
  const db = freshDb();
  try {
    const store = new RunStore(db); let spec: any;
    const runner = new Runner(db, "version", process.cwd(), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("version"), dbPath: "fixture.db", intercomExtensions: ["intercom.ts"], orchestratorTarget: "parent", spawn: s => {
      spec = s; return { wait: async () => ({ exitCode: 0, result: "report" }), kill() {}, detach() {} };
    } });
    const run = await runner.runForeground({ agent: "worker", task: "work", context: "fresh" });
    expect(run.child_mode).toBe(mode); expect(spec.argv).toContain(mode === "print" ? "json" : "rpc");
    if (mode === "print") {
      expect(spec.argv).toContain("-p"); expect(spec.argv).toContain("Task: work");
      expect(spec.argv).not.toContain("--exclude-tools"); expect(spec.prompt).toBeUndefined();
      expect(spec.env.PI_INTERCOM_STABLE_ID).toBeUndefined(); expect(run.intercom_session).toBeNull();
      expect(spec.env.PI_SUBAGENT_ORCHESTRATOR_TARGET).toBeUndefined();
      expect(run.result).toBe("report");
      expect(spec.launchWarning).toContain(version);
    }
  } finally { db.close(); }
});

it.each(["v0.80.0", "0.80", "garbage", ""])("unknown version %j keeps RPC with a run-detail diagnostic", async version => {
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", binary(version).entry);
  await assertUnknown();
});
it.each(["unreadable", "missing", "nonstring"] as const)("%s metadata keeps RPC with a diagnostic and caches failure", async failure => {
  const fixture = binary(failure === "nonstring" ? 85 : "0.80.0", failure === "nonstring" ? undefined : failure);
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", fixture.entry);
  if (failure === "unreadable") state.unreadable = join(fixture.root, "package.json");
  state.reads = 0;
  const { buildChildSpawnSpec } = await import("../pi-args");
  const first = buildChildSpawnSpec(input());
  expect(first.childMode).toBe("rpc"); expect(first.launchWarning).toMatch(/pi version unknown.*RPC/i);
  const count = state.reads;
  const second = buildChildSpawnSpec(input());
  expect(second.childMode).toBe("rpc"); expect(second.launchWarning).toMatch(/pi version unknown.*RPC/i);
  expect(state.reads).toBe(count);
});
async function assertUnknown() {
  const { makeRunHandler } = await import("../actions/run");
  const { teardownAllAsync } = await import("../coordinators");
  const db = freshDb(); const sent: any[] = [];
  try {
    const result = await makeRunHandler({ spawner: () => ({ wait: async () => ({ exitCode: 0, result: "report" }), kill() {}, detach() {} }) })({ agent: "worker", task: "work" }, { db, sessionId: "unknown", cwd: process.cwd(), runDbPath: "fixture.db", pi: { sendMessage(m: any) { sent.push(m); } } });
    expect(result.details.run.child_mode).toBe("rpc");
    expect(result.details.warning).toMatch(/pi version unknown.*RPC/i);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(new RunStore(db).get(result.details.run.id)?.result).toBe("report");
    const warnings = db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='warning'").all(result.details.run.id) as Array<{payload: string}>;
    expect(warnings.map(e => JSON.parse(e.payload))).toContainEqual(expect.objectContaining({ launchWarning: true, message: expect.stringMatching(/pi version unknown.*RPC/i) }));
    expect(sent[0].details.output).toBe("report");
    expect(sent[0].content).not.toMatch(/pi version unknown/i);
  } finally { await teardownAllAsync(); db.close(); }
}

it("caches metadata per resolved binary, not the host process or another pi installation", async () => {
  const older = binary("0.85.0"), newer = binary("0.87.0");
  const { buildChildSpawnSpec } = await import("../pi-args");
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", older.entry);
  expect(buildChildSpawnSpec(input()).childMode).toBe("print");
  state.reads = 0;
  const alias = join(older.root, "alias"); symlinkSync(older.entry, alias);
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", alias);
  expect(buildChildSpawnSpec(input()).childMode).toBe("print");
  expect(state.reads).toBe(0);
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", newer.entry);
  expect(buildChildSpawnSpec(input()).childMode).toBe("rpc");
  expect(state.reads).toBeGreaterThan(0);
});
it.skipIf(process.platform === "win32")("resolves PATH pi symlinks rather than the host pi dependency", async () => {
  const fixture = binary("0.85.0"); const binDir = join(fixture.root, "bin"); mkdirSync(binDir);
  symlinkSync(fixture.entry, join(binDir, "pi"));
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", undefined); vi.stubEnv("PATH", binDir);
  const { buildChildSpawnSpec } = await import("../pi-args");
  expect(buildChildSpawnSpec(input()).childMode).toBe("print");
});
it("print fallback is visible in tool details and the completion notification", async () => {
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", binary("0.85.0").entry);
  const { makeRunHandler } = await import("../actions/run");
  const { teardownAllAsync } = await import("../coordinators");
  const db = freshDb(); const sent: any[] = [];
  try {
    const result = await makeRunHandler({ spawner: () => ({ wait: async () => ({ exitCode: 0, result: "report" }), kill() {}, detach() {} }) })({ agent: "worker", task: "work" }, { db, sessionId: "fallback", cwd: process.cwd(), runDbPath: "fixture.db", pi: { sendMessage(m: any) { sent.push(m); } } });
    expect(result.details.warning).toMatch(/print.*0\.85\.0.*0\.85\.1/i);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(new RunStore(db).get(result.details.run.id)?.result).toBe("report");
    expect(sent[0].details.output).toMatch(/print.*0\.85\.0.*0\.85\.1/i);
    expect(sent[0].content).toMatch(/print.*0\.85\.0.*0\.85\.1/i);
  } finally { await teardownAllAsync(); db.close(); }
});

it("an own kill stays silent when its launch has an unknown-version diagnostic", async () => {
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", binary("garbage").entry);
  const { makeRunHandler } = await import("../actions/run");
  const { makeKillHandler } = await import("../actions/kill");
  const { teardownAllAsync } = await import("../coordinators");
  const db = freshDb(); const sent: any[] = [];
  let finish!: (v: any) => void; const exit = new Promise<{ exitCode: number }>(resolve => { finish = resolve; });
  try {
    const ctx = { db, sessionId: "warning-kill", cwd: process.cwd(), runDbPath: "fixture.db", pi: { sendMessage(m: any) { sent.push(m); } } };
    const result = await makeRunHandler({ spawner: () => ({ wait: () => exit, detach() {}, kill() { finish({ exitCode: 143 }); } }) })({ agent: "worker", task: "work" }, ctx);
    expect((await makeKillHandler()({ id: result.details.run.id }, ctx)).isError).toBe(false);
    await exit; await Promise.resolve();
    expect(new RunStore(db).get(result.details.run.id)?.result).toBe("killed by spider kill from this session");
    expect(sent).toEqual([]);
  } finally { await teardownAllAsync(); db.close(); }
});

it.each(["chain", "pipeline"])("%s hands off only the deliverable, never launch diagnostics", async mode => {
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", binary("0.85.0").entry);
  const { makeRunHandler } = await import("../actions/run");
  const { teardownAllAsync } = await import("../coordinators");
  const db = freshDb(); const tasks: string[] = []; const sent: any[] = [];
  try {
    const handler = makeRunHandler({ spawner: spec => {
      tasks.push(spec.argv.find(a => a.startsWith("Task: "))!);
      return { wait: async () => ({ exitCode: 0, result: tasks.length === 1 ? "first deliverable" : "second deliverable" }), kill() {}, detach() {} };
    } });
    await handler({ [mode]: [{agent: "worker", task: "first"}, {agent: "worker", task: "Use {previous}"}] }, { db, sessionId: mode, cwd: process.cwd(), runDbPath: "fixture.db", pi: { sendMessage(m: any) { sent.push(m); } } });
    await vi.waitFor(() => expect(new RunStore(db).listActive(mode)).toHaveLength(0));
    expect(tasks).toEqual(["Task: first", "Task: Use first deliverable"]);
    expect((db.prepare("SELECT result FROM runs WHERE session_id=?").all(mode) as Array<{result: string}>).map(row => row.result)).toEqual(expect.arrayContaining(["first deliverable", "second deliverable"]));
    expect(sent.some(m => /Using print mode/.test(m.content))).toBe(true);
  } finally { await teardownAllAsync(); db.close(); }
});

it.each(["fallback", "steer", "both"])("shutdown with %s diagnostics queues the completion without triggering a turn", async diagnostic => {
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", binary(diagnostic === "steer" ? "0.85.1" : "0.85.0").entry);
  const { makeRunHandler } = await import("../actions/run");
  const { teardownAllAsync } = await import("../coordinators");
  const { appendRunEvent } = await import("@spider/db-core");
  const db = freshDb(); const sent: any[] = [];
  let finish!: (v: {exitCode: number}) => void;
  const exit = new Promise<{exitCode: number}>(resolve => { finish = resolve; });
  try {
    const result = await makeRunHandler({ spawner: () => ({ wait: () => exit, detach() {}, kill() { finish({exitCode: 143}); } }) })({agent: "worker", task: "work"}, { db, sessionId: "shutdown-warning", cwd: process.cwd(), runDbPath: "fixture.db", pi: { sendMessage(message: any, options: any) { sent.push({message, options}); } } });
    if (diagnostic !== "fallback") appendRunEvent(db, {runId: result.details.run.id, sessionId: "shutdown-warning", ts: Date.now(), type: "steer_delivery", payload: {requestId: "pending", delivered: false}});
    await teardownAllAsync(); await exit;
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].options).toEqual({triggerTurn: false, deliverAs: "nextTurn"});
    expect(sent[0].message.details.output).toMatch(/Session shutdown cancelled this run/);
    if (diagnostic !== "steer") expect(sent[0].message.content).toMatch(/Using print mode/);
    if (diagnostic !== "fallback") expect(sent[0].message.content).toMatch(/1 accepted steer.*not delivered/);
    expect(new RunStore(db).get(result.details.run.id)?.result).not.toMatch(/Using print mode/);
  } finally { finish({exitCode: 143}); await teardownAllAsync(); db.close(); }
});

it.skipIf(process.platform === "win32")("PATH chooses the first executable file, skipping directories and non-executable entries", async () => {
  const older = binary("0.85.0"), newer = binary("0.87.0");
  const invalid = join(newer.root, "invalid"), nonexec = join(older.root, "nonexec");
  const oldBin = join(older.root, "bin"), newBin = join(newer.root, "bin");
  for (const dir of [invalid, nonexec, oldBin, newBin]) mkdirSync(dir);
  mkdirSync(join(invalid, "pi"));
  writeFileSync(join(nonexec, "package.json"), JSON.stringify({name: "@earendil-works/pi-coding-agent", version: "0.87.0"}));
  writeFileSync(join(nonexec, "pi"), "not executable"); chmodSync(join(nonexec, "pi"), 0o644);
  symlinkSync(older.entry, join(oldBin, "pi")); symlinkSync(newer.entry, join(newBin, "pi"));
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", undefined);
  const { buildChildSpawnSpec } = await import("../pi-args");
  vi.stubEnv("PATH", [invalid, nonexec, oldBin, newBin].join(delimiter));
  expect(buildChildSpawnSpec(input()).childMode).toBe("print");
  vi.stubEnv("PATH", [newBin, oldBin].join(delimiter));
  expect(buildChildSpawnSpec(input()).childMode).toBe("rpc");
});

it.skipIf(process.platform === "win32")("relative PATH entries resolve against the child cwd, not the host cwd", async () => {
  const fixture = binary("0.85.0"); const binDir = join(fixture.root, "bin"); mkdirSync(binDir);
  symlinkSync(fixture.entry, join(binDir, "pi"));
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", undefined); vi.stubEnv("PATH", "bin");
  const { buildChildSpawnSpec } = await import("../pi-args");
  expect(buildChildSpawnSpec({...input(), cwd: fixture.root}).childMode).toBe("print");
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", "./dist/cli.js");
  expect(buildChildSpawnSpec({...input(), cwd: fixture.root}).childMode).toBe("print");
});

it("an unresolved custom binary never borrows the host or PATH pi version", async () => {
  const fixture = binary("0.85.0"); const binDir = join(fixture.root, "bin"); mkdirSync(binDir);
  symlinkSync(fixture.entry, join(binDir, "pi"));
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", join(fixture.root, "missing-pi")); vi.stubEnv("PATH", binDir);
  const { buildChildSpawnSpec } = await import("../pi-args");
  const argv1 = process.argv[1];
  process.argv[1] = fixture.entry; // emulate a host pi whose metadata must not be borrowed
  try {
    const spec = buildChildSpawnSpec(input());
    expect(spec.childMode).toBe("rpc"); expect(spec.launchWarning).toMatch(/pi version unknown/);
    expect(spec.argv[0]).toBe(join(fixture.root, "missing-pi"));
  } finally { process.argv[1] = argv1; }
});

it("an in-place pi upgrade invalidates cached compatibility at the same resolved path", async () => {
  const fixture = binary("0.85.0"); vi.stubEnv("PI_SUBAGENT_PI_BINARY", fixture.entry);
  const { buildChildSpawnSpec } = await import("../pi-args");
  expect(buildChildSpawnSpec(input()).childMode).toBe("print");
  writeFileSync(fixture.entry, "#!/usr/bin/env node\n// upgraded CLI\n");
  utimesSync(fixture.entry, new Date("2030-01-01"), new Date("2030-01-01"));
  writeFileSync(join(fixture.root, "package.json"), JSON.stringify({name: "@earendil-works/pi-coding-agent", version: "0.85.1"}));
  expect(buildChildSpawnSpec(input()).childMode).toBe("rpc");
  state.reads = 0;
  expect(buildChildSpawnSpec(input()).childMode).toBe("rpc");
  expect(state.reads).toBe(0);
});

it("package metadata changes also invalidate cached compatibility without replacing the CLI", async () => {
  const fixture = binary("0.85.0"); vi.stubEnv("PI_SUBAGENT_PI_BINARY", fixture.entry);
  const { buildChildSpawnSpec } = await import("../pi-args");
  expect(buildChildSpawnSpec(input()).childMode).toBe("print");
  const metadata = join(fixture.root, "package.json");
  writeFileSync(metadata, JSON.stringify({name: "@earendil-works/pi-coding-agent", version: "0.85.1"}));
  utimesSync(metadata, new Date("2030-01-01"), new Date("2030-01-01"));
  expect(buildChildSpawnSpec(input()).childMode).toBe("rpc");
});

it.each(["mtime", "size"])("CLI %s alone invalidates the binary cache", async field => {
  const fixture = binary("0.85.0"); const metadata = join(fixture.root, "package.json");
  const fixed = new Date("2030-01-01");
  utimesSync(fixture.entry, fixed, fixed); utimesSync(metadata, fixed, fixed);
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", fixture.entry);
  const { buildChildSpawnSpec } = await import("../pi-args");
  expect(buildChildSpawnSpec(input()).childMode).toBe("print");
  // Same-size metadata with its mtime retained isolates the CLI fingerprint.
  writeFileSync(metadata, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.1", bin: { pi: "dist/cli.js" } }));
  utimesSync(metadata, fixed, fixed);
  if (field === "mtime") utimesSync(fixture.entry, fixed, new Date("2031-01-01"));
  else {
    writeFileSync(fixture.entry, "#!/usr/bin/env node\n// different size\n");
    utimesSync(fixture.entry, fixed, fixed);
  }
  expect(buildChildSpawnSpec(input()).childMode).toBe("rpc");
});
