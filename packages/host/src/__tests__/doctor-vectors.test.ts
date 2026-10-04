import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { openRepo, openProject, resolveProject, setGlobalDbPathForTests, openDbReadOnlyAt, commandEnv } from "@spider/db-core";
import { upsertVector, drainEmbedQueue, enqueueEmbed, getVectorState, addMemory, recordEmbedDrainError, markEmbedDrained, resolveEmbedder, startEmbedderSession, stopEmbedder } from "@spider/memory";
import { controlDoctor, controlConfig } from "../control";
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn() { throw new Error("fixture worker unavailable"); },
}));

it.each([true, false])("reads native vector diagnostics without changing snapshot bytes (table exists: %s)", native => {
  root = resolve(".spider/scratch", `doctor-readonly-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  setGlobalDbPathForTests(join(root, "global.db"));
  const info = resolveProject(root);
  const writer = openRepo(info.repoKey!);
  const path = writer.raw.name;
  const v = new Float32Array(384); v[0] = 1;
  try {
    if (native) upsertVector(writer, "memory", "fixture", v, "fixture");
    else writer.prepare("INSERT INTO vector_map(owner_kind, owner_id, model, dim, embedding) VALUES ('memory', 'fixture', 'fixture', 384, ?)").run(Buffer.from(v.buffer));
  } finally { writer.close(); }
  const hash = () => createHash("sha256").update(readFileSync(path)).digest("hex");
  const before = hash();
  const reader = openDbReadOnlyAt(path)!;
  try {
    reader.loadVec();
    expect(getVectorState(reader)).toEqual({ mapped: 1, indexed: native ? 1 : 0, missing: native ? 0 : 1, pending: 0, retried: 0, dead: 0 });
    expect(!!reader.prepare("SELECT 1 FROM sqlite_master WHERE name = 'vectors'").get()).toBe(native);
    expect(reader.pragma("user_version")).toBe(13);
  } finally { reader.close(); }
  expect(hash()).toBe(before);
});

let root: string | undefined;
afterEach(async () => {
  await stopEmbedder();
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("spider.embedder.v3:BGE-small-en-v1.5")];
  vi.restoreAllMocks();
  setGlobalDbPathForTests(null);
  if (root) rmSync(root, { recursive: true, force: true });
});

it("doctor reports repo/worktree indexing gaps, queue state and process vector failures", async () => {
  root = resolve(".spider/scratch", `doctor-vectors-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  setGlobalDbPathForTests(join(root, "global.db"));
  const info = resolveProject(root);
  const repo = openRepo(info.repoKey!);
  const worktree = openProject(info.projectKey);
  const v = new Float32Array(384); v[0] = 1;
  try {
    repo.loadVec(); worktree.loadVec();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = vi.spyOn(repo, "loadVec").mockImplementation(() => { throw new Error("fixture insert unavailable"); });
    repo.prepare("INSERT INTO memory(uuid,category,content,status,created_at) VALUES ('missing', 'insight', 'fixture', 'active', 1)").run();
    upsertVector(repo, "memory", "missing", v, "fixture");
    failure.mockRestore();
    upsertVector(worktree, "session", "indexed", v, "fixture");
    enqueueEmbed(repo, "memory", "pending", "fixture");
    enqueueEmbed(repo, "memory", "retried", "fixture");
    repo.exec("UPDATE embed_queue SET tries = 2 WHERE owner_id = 'retried'");
    const report = controlDoctor(root);
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toMatch(/vector recall \(repo\).*mapped=1.*indexed=0.*missing=1.*pending=1.*retried=1/);
    expect(report.lines.join("\n")).toMatch(/vector recall \(worktree\).*mapped=1.*indexed=1.*missing=0/);
    expect(report.lines.join("\n")).toMatch(/vector errors.*insert=1.*knn=0.*repair=0/);
    expect(report.lines.join("\n")).toContain("fixture insert unavailable");
    await drainEmbedQueue(repo, null);
    expect(controlDoctor(root).lines.join("\n")).toMatch(/vector recall \(repo\).*mapped=1.*indexed=1.*missing=0/);
  } finally { repo.close(); worktree.close(); }
});

it.each(["live", "expired", "dead"])("doctor reports %s embedding lease state without its token", mode => {
  root = resolve(".spider/scratch", `doctor-lease-${randomUUID()}`);
  mkdirSync(root, { recursive: true }); execFileSync("git", ["init", "-q"], { cwd: root });
  setGlobalDbPathForTests(join(root, "global.db"));
  const info = resolveProject(root); const repo = openRepo(info.repoKey!);
  try {
    const pid = mode === "dead" ? Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { env: commandEnv(), encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" })) : process.pid;
    const lock = `${repo.raw.name}.embed-lock`;
    writeFileSync(lock, JSON.stringify({ pid, token: "fixture-private-lease" }));
    if (mode === "expired") utimesSync(lock, new Date(1), new Date(1));
    const output = controlDoctor(root).lines.join("\n");
    expect(output).toMatch(new RegExp(`embedding lease \\(repo\\): pid=${pid} age_ms=\\d+ stale=${mode !== "live"}`));
    expect(output).not.toContain("fixture-private-lease");
  } finally { repo.close(); }
});

it.each(["gap", "retried", "old", "error", "disabled", "dead", "unavailable"])("classifies current %s health independently of historical counters", async mode => {
  root = resolve(".spider/scratch", `doctor-health-${randomUUID()}`);
  mkdirSync(root, { recursive: true }); execFileSync("git", ["init", "-q"], { cwd: root });
  setGlobalDbPathForTests(join(root, "global.db")); const info = resolveProject(root); const repo = openRepo(info.repoKey!);
  try {
    const m = addMemory(repo, "repo", { category: "insight", content: "fixture" });
    if (mode === "gap") repo.prepare("INSERT INTO vector_map(owner_kind,owner_id,model,dim,embedding) VALUES ('memory', ?, 'fixture', 384, ?)").run(m.uuid, Buffer.from(new Float32Array(384).buffer));
    if (mode === "retried") repo.exec("UPDATE embed_queue SET tries = 1");
    if (mode === "dead") { repo.exec("UPDATE embed_queue SET tries = 5"); recordEmbedDrainError(repo, new Error("fixture dead item")); }
    if (mode === "old") repo.exec("UPDATE embed_queue SET enqueued_at = 1");
    if (mode === "error") recordEmbedDrainError(repo, new Error("fixture transient"));
    if (mode === "disabled") { repo.exec("UPDATE embed_queue SET enqueued_at = 1"); controlConfig("set", root, "embeddings.drain", false); }
    if (mode === "unavailable") { startEmbedderSession(); expect(await resolveEmbedder()).toBeNull(); }
    const report = controlDoctor(root);
    expect(report.ok).toBe(mode === "disabled" || mode === "dead");
    if (mode === "disabled") expect(report.lines.join("\n")).toContain("drain disabled");
    if (mode === "dead") expect(report.lines.join("\n")).toMatch(/warning.*dead.*skipped/i);
    if (mode === "unavailable") expect(report.lines.join("\n")).toContain("fixture worker unavailable");
    if (mode === "error") {
      markEmbedDrained(repo);
      expect(controlDoctor(root).ok).toBe(true);
    }
  } finally { repo.close(); }
});
