import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { createJobStore, type JournalJob } from "@spider/herdr/jobs/store";
import { MessageStore } from "../../../../subagents/src/message-store.js";
import { readHostJobJournals, readLocalRoutes } from "../evidence.js";

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
