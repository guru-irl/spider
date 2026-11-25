import { afterEach, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { createJobStore, type JournalJob } from "@spider/herdr/jobs/store";
import { MessageStore } from "../../../../subagents/src/message-store.js";
import { createBlockerPorts, readHostJobJournals, readLocalRoutes } from "../evidence.js";
import { inspectBlockers } from "../blockers.js";

const roots: string[] = [], replicas: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of replicas.splice(0)) f.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(resolve(".spider/scratch/evidence-")); roots.push(path); return path; }
function remote(id: string, runId?: string): JournalJob {
  const owner = { sessionId: "owner", generation: "generation", cwd: "/fixture", sessionFile: null, name: null,
    terminal: { coreId: "core", terminalId: "terminal", address: "terminal", socket: "/fixture/socket", sessionNamespace: "fixture" } } as JournalJob["owner"];
  return { version: 1, id: id as never, owner, ...(runId ? { runId: runId as never } : {}), machine: "box.invalid" as never,
    kind: "exec", phase: { kind: "running", address: "box/terminal" as never, releasedAt: 1 }, viewer: null,
    remoteDirectory: "/fixture/remote", localDirectory: "/fixture/local", detached: true, noticeMode: "async", notice: "pending",
    nonce: "nonce", releaseDeadlineAt: 1, originalFinish: null, output: null, callerOwned: true, uncertain: false,
    evidenceConflict: false, noticeDelivered: false, settledMarked: false, terminalExpired: false, updatedAt: 1 };
}

it("reads top-level and every child journal without modifying them", async () => {
  const dir = root(), top = createJobStore(dir, "owner" as never), child = createJobStore(dir, "owner" as never, "run-1" as never);
  await top.write({ version: 1, sessionId: "owner" as never, revision: 1, updatedAt: 1, jobs: [remote("top")] });
  await child.write({ version: 1, sessionId: "owner" as never, revision: 1, updatedAt: 1, jobs: [remote("child", "run-1")],
    child: { id: "run-1" as never, pid: process.pid, startIdentity: "fixture", ended: false } });
  const before = [readFileSync(top.path), readFileSync(child.path)];
  expect((await readHostJobJournals([dir], "owner")).top.map(job => job.id)).toEqual(["top"]);
  expect((await readHostJobJournals([dir], "owner")).children.map(job => job.id)).toEqual(["child"]);
  expect([readFileSync(top.path), readFileSync(child.path)]).toEqual(before);
}, 5000);

it("treats a missing job root as empty without creating it and still reads other roots", async () => {
  const dir = root(), missing = join(dir, "missing", "jobs"), existing = join(dir, "existing");
  const store = createJobStore(existing, "owner" as never);
  await store.write({ version: 1, sessionId: "owner" as never, revision: 1, updatedAt: 1, jobs: [remote("top")] });
  expect(await readHostJobJournals([missing], "owner")).toEqual({ top: [], children: [] });
  const result = await readHostJobJournals([missing, existing], "owner");
  expect(result.top.map(job => job.id)).toEqual(["top"]);
  expect(result.children).toEqual([]);
  expect(existsSync(join(dir, "missing"))).toBe(false);
}, 5000);

it("does not report unavailable job evidence for a fresh agent", async () => {
  const dir = root(), missing = join(dir, "jobs");
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111"); replicas.push(replica);
  const routes = createReplica("global", "11111111-1111-4111-8111-111111111111"); replicas.push(routes);
  new MessageStore(routes.db);
  const address = { sessionId: "owner", scopeId: null };
  const empty = { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] };
  const ports = createBlockerPorts({ sessionId: "owner", address,
    activity: { busy: () => false, bashRunning: () => false, promptOpen: () => false },
    routeStores: [routes.db], jobRoots: [missing], scratchRoots: [dir],
    broker: async () => empty, bridge: () => empty, settlement: async () => null });
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "owner" },
    isIdle: () => true, hasPendingMessages: () => false, ui: { getEditorText: () => "" } } as never;
  expect(await inspectBlockers(ctx, [replica.db], ports)).toEqual([]);
  expect(existsSync(missing)).toBe(false);
}, 5000);

it.each(["symlink root", "file root", "symlink component", "file component"])("rejects an unsafe job root: %s", async kind => {
  const dir = root(), target = join(dir, "target"), unsafe = join(dir, "unsafe");
  if (kind.startsWith("symlink")) { mkdirSync(target); symlinkSync(target, unsafe); }
  else writeFileSync(unsafe, "fixture");
  const path = kind.endsWith("component") ? join(unsafe, "jobs") : unsafe;
  await expect(readHostJobJournals([path], "owner")).rejects.toThrow();
}, 5000);

it("rejects a relative job root rather than treating validation errors as empty", async () => {
  await expect(readHostJobJournals(["relative"], "owner")).rejects.toThrow();
}, 5000);

it("propagates filesystem errors other than ENOENT", async () => {
  await expect(readHostJobJournals([join(root(), "x".repeat(300))], "owner")).rejects.toMatchObject({ code: "ENAMETOOLONG" });
}, 5000);

it("reads an existing root without changing or restricting its mode", async () => {
  const dir = root(); chmodSync(dir, 0o755);
  expect(await readHostJobJournals([dir], "owner")).toEqual({ top: [], children: [] });
  expect(statSync(dir).mode & 0o777).toBe(0o755);
}, 5000);

it("does not hide an unreadable or malformed child journal", async () => {
  const dir = root(), child = createJobStore(dir, "owner" as never, "run-1" as never);
  mkdirSync(child.directory, { recursive: true }); writeFileSync(child.path, "{broken");
  await expect(readHostJobJournals([dir], "owner")).rejects.toThrow();
  expect(readFileSync(child.path, "utf8")).toBe("{broken");
}, 5000);

it("reads real pending routes without migration and requires exact bridge settlement", async () => {
  const f = createReplica("global", "11111111-1111-4111-8111-111111111111"); replicas.push(f);
  const mail = new MessageStore(f.db);
  mail.enqueue({ fromSession: "other", toSession: "owner", body: "local fixture", route: { kind: "local", messageId: "local-1" } });
  mail.enqueue({ fromSession: "owner", toSession: "other", body: "bridge fixture", route: { kind: "bridge", messageId: "bridge-1" } });
  const directory = join(f.root, "intercom-routes"), before = readdirSync(directory).sort().map(name => readFileSync(join(directory, name)));
  const pending = await readLocalRoutes([f.db], "owner", async () => null);
  expect(pending).toEqual(expect.arrayContaining([
    { id: "local-1", route: "local", fromSessionId: "other", toSessionId: "owner" },
    { id: "bridge-1", route: "bridge", fromSessionId: "owner", toSessionId: "other" },
  ]));
  const wrongSender = await readLocalRoutes([f.db], "owner", async query => ({ ...query, fromSessionId: "foreign", kind: "receipt" }));
  expect(wrongSender.find(route => route.id === "bridge-1")).not.toHaveProperty("settlement");
  const wrongEndpoint = await readLocalRoutes([f.db], "owner", async query => ({ ...query, toSessionId: "foreign", kind: "receipt" }));
  expect(wrongEndpoint.find(route => route.id === "bridge-1")).not.toHaveProperty("settlement");
  const wrongScope = await readLocalRoutes([f.db], "owner", async query => ({ ...query, scopeId: "foreign", kind: "receipt" }));
  expect(wrongScope.find(route => route.id === "bridge-1")).not.toHaveProperty("settlement");
  const settled = await readLocalRoutes([f.db], "owner", async query => ({ ...query, kind: "receipt" }));
  expect(settled.find(route => route.id === "bridge-1")).toMatchObject({ settlement: { messageId: "bridge-1", kind: "receipt" } });
  expect(readdirSync(directory).sort().map(name => readFileSync(join(directory, name)))).toEqual(before);
}, 5000);

it("treats a missing route file as unknown rather than inventing local delivery", async () => {
  const f = createReplica("global", "11111111-1111-4111-8111-111111111111"); replicas.push(f);
  const mail = new MessageStore(f.db);
  mail.enqueue({ fromSession: "other", toSession: "owner", body: "fixture", route: { kind: "local", messageId: "local-1" } });
  const directory = join(f.root, "intercom-routes"); rmSync(join(directory, readdirSync(directory)[0]));
  expect(await readLocalRoutes([f.db], "owner", async () => null)).toMatchObject([{ route: "unknown", fromSessionId: "other", toSessionId: "owner" }]);
  expect(readdirSync(directory)).toEqual([]);
}, 5000);
