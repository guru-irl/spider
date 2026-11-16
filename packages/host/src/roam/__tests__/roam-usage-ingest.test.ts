import { afterEach, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { openUsageLedger } from "../../usage/ledger.js";
import { acquireUsageLease } from "../../usage/lease.js";
import { createUsageIngestThrough } from "../usage-ingest.js";

const roots: string[] = [], replicas: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of replicas.splice(0)) f.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(resolve(".spider/scratch/usage-freeze-")); roots.push(root);
  const global = createReplica("global", "11111111-1111-4111-8111-111111111111");
  const worktree = createReplica("worktree", "11111111-1111-4111-8111-111111111111"); replicas.push(global, worktree);
  global.db.prepare("INSERT INTO projects(project_key,real_path,repo_key,db_path,created_at,last_seen_at) VALUES (?,?,NULL,?,1,1)")
    .run(worktree.root, worktree.root, worktree.db.raw.name);
  worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES ('session-1',1,?)").run("11111111-1111-4111-8111-111111111111");
  worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('session-1',2,'frozen')").run();
  const sessionsDir = join(root, "sessions"), dir = join(sessionsDir, "fixture"); mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.jsonl"), timestamp = "2026-10-04T12:00:00.000Z";
  const message = (id: string) => JSON.stringify({ type: "message", id, parentId: null, timestamp, message: { role: "assistant", provider: "github-copilot", model: "fixture", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } }) + "\n";
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: worktree.root, timestamp }) + "\n" + message("first"));
  const paths = { registryDb: global.db.raw.name, sessionsDir, ledgerFile: join(root, "usage.db"), authPath: join(root, "auth.json"), leaseDir: join(root, "leases") };
  return { paths, file, message };
}

it("ingests the exact frozen prefix into the real usage ledger", async () => {
  const f = fixture(), ingest = createUsageIngestThrough(f.paths, "session-1", "11111111-1111-4111-8111-111111111111");
  const size = statSync(f.file).size;
  await ingest(f.file, size);
  const ledger = openUsageLedger(f.paths.ledgerFile);
  try {
    expect(ledger.getImportState(f.file)).toMatchObject({ offset: size, size });
    expect(ledger.health().calls).toBe(1);
    appendFileSync(f.file, f.message("after"));
    expect(ledger.health().calls).toBe(1);
  } finally { ledger.close(); }
}, 10000);

it("refuses a transcript belonging to another participant", async () => {
  const f = fixture(), ingest = createUsageIngestThrough(f.paths, "other-session", "11111111-1111-4111-8111-111111111111");
  await expect(ingest(f.file, statSync(f.file).size)).rejects.toThrow(/identity/i);
  const ledger = openUsageLedger(f.paths.ledgerFile);
  try { expect(ledger.health().calls).toBe(0); } finally { ledger.close(); }
}, 10000);

it("does not write or acknowledge when another usage producer owns the ingest lease", async () => {
  const f = fixture(), ledger = openUsageLedger(f.paths.ledgerFile);
  const held = acquireUsageLease(ledger, "ingest", `${process.pid}:other`, Date.now, 120000);
  expect(held).toBeDefined();
  try {
    const ingest = createUsageIngestThrough(f.paths, "session-1", "11111111-1111-4111-8111-111111111111");
    await expect(ingest(f.file, statSync(f.file).size)).rejects.toThrow(/lease/i);
    expect(ledger.health().calls).toBe(0);
  } finally { held?.release(); ledger.close(); }
}, 10000);
