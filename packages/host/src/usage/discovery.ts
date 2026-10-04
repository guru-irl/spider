import { open, readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { openDbReadOnly, type Db } from "@spider/db-core";
import type { RunMeta } from "./ledger.js";
import type { SourceInfo as ParserSource } from "./parse.js";

export type UsageRoots = { registryDb: string; sessionsDir: string; ledgerFile: string; authPath: string; leaseDir: string };
/** Registry metadata can be absent in legacy databases. */
export type SourceInfo = Omit<ParserSource, "run"> & { run: RunMeta | null };
export type RunEvent = { dbPath: string; id: number; runId: string; sessionId: string | null; ts: number; type: string; payload: string | null };
export type RunState = { dbPath: string; id: string; status: string | null; childMode: string | null };
export type Discovery = {
  sources: readonly SourceInfo[]; runs: readonly RunMeta[]; errors: readonly { path: string; code: string; checkedPaths?: readonly string[] }[];
  /** Read-only snapshots, not handles. Optional for hand-built discovery inputs. */
  runEvents?: readonly RunEvent[]; runStates?: readonly RunState[]; runDbs?: readonly string[]; runDbIdentities?: Readonly<Record<string, string>>;
  /** Ledger destination supplied to the worker; never used to reconstruct open-ledger proof. */
  ledgerFile?: string;
};
export type DiscoveryDependencies = {
  openDb?: (path: string) => Db | undefined;
  readdir?: (path: string) => Promise<Dirent[]>;
};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const code = (error: unknown): string => text((error as { code?: unknown })?.code) ?? "source-read-error";

/** No registry resolution, registration, migration, git commands or repository walks. */
export async function discoverUsageSources(roots: UsageRoots, dependencies: DiscoveryDependencies = {}): Promise<Discovery> {
  const openSourceDb = dependencies.openDb ?? openDbReadOnly;
  const list = dependencies.readdir ?? (path => readdir(path, { withFileTypes: true }));
  const sources = new Map<string, SourceInfo>();
  const runs: RunMeta[] = [], runEvents: RunEvent[] = [], runStates: RunState[] = [];
  const errors: { path: string; code: string; checkedPaths?: readonly string[] }[] = [];
  const runDbs: string[] = [];
  const runDbIdentities: Record<string, string> = {};
  async function canonical(path: string): Promise<string> { try { return await realpath(path); } catch { return resolve(path); } }
  async function add(path: string, project: string | null, repo: string | null, run: RunMeta | null) {
    const key = await canonical(path);
    try { if (!(await stat(key)).isFile()) throw Object.assign(new Error("not a file"), { code: "not-file" }); }
    catch (error) { errors.push({ path: key, code: code(error) === "ENOENT" ? "missing-source" : code(error) }); return false; }
    // Native run ownership is more specific than an incidental parent listing.
    if (!sources.has(key) || run && !sources.get(key)!.run) sources.set(key, { path: key, project, repo, run });
    return true;
  }
  const sessions = await canonical(roots.sessionsDir);
  try {
    for (const dir of await list(sessions)) {
      if (!dir.isDirectory()) continue;
      const directory = join(sessions, dir.name);
      try {
        for (const file of await list(directory)) {
          if (file.isFile() && file.name.endsWith(".jsonl"))
            await add(join(directory, file.name), null, null, null);
        }
      }
      catch (error) { errors.push({ path: directory, code: code(error) }); }
    }
  } catch (error) { errors.push({ path: sessions, code: code(error) }); }

  const registrations: { project: string; repo: string | null; db: string; scratch: string }[] = [];
  const registryPath = await canonical(roots.registryDb);
  let registry: Db | undefined;
  try {
    registry = openSourceDb(registryPath);
    if (!registry) errors.push({ path: registryPath, code: "missing-db" });
    else {
      for (const row of registry.prepare("SELECT * FROM projects ORDER BY project_key").all() as Record<string, unknown>[]) {
        const project = text(row.project_key) ?? text(row.real_path), db = text(row.db_path);
        if (!project || !db) { errors.push({ path: registryPath, code: "invalid-project" }); continue; }
        const repo = text(row.repo_key) ?? text(row.git_common_dir);
        registrations.push({
          project: await canonical(project), repo: repo ? await canonical(repo) : null,
          db: await canonical(db), scratch: await canonical(text(row.scratch_root) ?? text(row.scratch_path) ?? join(project, ".spider", "scratch"))
        });
      }
    }
  } catch (error) { errors.push({ path: registryPath, code: code(error) }); }
  finally { registry?.close(); }

  // Header cwd only attributes a parent session to an already registered project.
  // It never authorizes a directory walk or an extra launch root.
  for (const source of sources.values()) {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(source.path, "r");
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      if (end < 0) continue;
      let header: Record<string, unknown>;
      try { header = JSON.parse(buffer.subarray(0, end).toString("utf8")); } catch { continue; }
      if (!header || header.type !== "session") continue;
      const cwd = text(header.cwd);
      if (!cwd) continue;
      const owner = registrations.filter(r => {
        const path = relative(r.project, resolve(cwd));
        return !isAbsolute(path) && path.split(sep)[0] !== "..";
      }).sort((a, b) => b.project.length - a.project.length)[0];
      if (owner) { source.project = owner.project; source.repo = owner.repo; }
    } catch (error) { errors.push({ path: source.path, code: code(error) }); }
    finally { await file?.close(); }
  }

  // Registry lookup only: one non-recursive directory listing per registered root.
  const scratchIndex = new Map<string, Set<string>>();
  const uniqueRoots = new Map(registrations.map(r => [r.scratch, r]));
  for (const scratch of uniqueRoots.keys()) {
    try {
      scratchIndex.set(scratch, new Set((await list(join(scratch, "subagent-sessions")))
        .filter(d => d.isDirectory()).map(d => d.name)));
    }
    catch (error) { if (code(error) !== "ENOENT") errors.push({ path: join(scratch, "subagent-sessions"), code: code(error) }); }
  }
  const candidates = new Map<string, typeof registrations>();
  for (const registration of registrations) {
    for (const path of [registration.db, ...(registration.repo ? [await canonical(join(registration.repo, "spider", "repo.db"))] : [])]) {
      const owners = candidates.get(path) ?? []; owners.push(registration); candidates.set(path, owners);
    }
  }
  for (const [dbPath, owners] of candidates) {
    let db: Db | undefined;
    try {
      db = openSourceDb(dbPath);
      if (!db) { errors.push({ path: dbPath, code: "missing-db" }); continue; }
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
      if (!tables.has("runs")) continue; // Repo tiers without runs are normal.
      runDbs.push(dbPath);
      const identity = await stat(dbPath);
      runDbIdentities[dbPath] = `${identity.dev}:${identity.ino}:${identity.birthtimeMs}`;
      const columns = new Set((db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map(c => c.name));
      const needed = ["id", "session_id", "parent_run_id", "agent", "role", "name", "model", "thinking", "phase",
        "started_at", "ended_at", "status", "child_mode"];
      const projection = needed.filter(c => columns.has(c)).join(",");
      for (const row of db.prepare(`SELECT ${projection} FROM runs ORDER BY id`).all() as Record<string, unknown>[]) {
        const id = text(row.id);
        // A DB run id is a path component, never a path supplied by the source.
        if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) { errors.push({ path: dbPath, code: "invalid-run-id" }); continue; }
        const owner = owners[0];
        const run: RunMeta = {
          id, dbPath, project: owner.project, repo: owner.repo, sessionId: text(row.session_id),
          parentRunId: text(row.parent_run_id), agent: text(row.agent), role: text(row.role), name: text(row.name),
          model: text(row.model), thinking: text(row.thinking), phase: text(row.phase),
          startedAt: number(row.started_at), endedAt: number(row.ended_at)
        };
        runs.push(run); runStates.push({ id, dbPath, status: text(row.status), childMode: text(row.child_mode) });
        // Current runs schemas (including migrations) contain no launch cwd or
        // scratch path. Only registry-derived, canonical roots are authorized.
        const sameRepo = registrations.filter(r => owner.repo ? r.repo === owner.repo : r.project === owner.project);
        const rootsToCheck = new Map<string, typeof owner>();
        for (const r of [...sameRepo, ...uniqueRoots.values()]) {
          if (!rootsToCheck.has(r.scratch)) rootsToCheck.set(r.scratch, r);
        }
        const checkedPaths: string[] = [];
        let found = false;
        for (const [scratch, candidate] of rootsToCheck) {
          const path = join(scratch, "subagent-sessions", id, `${id}.jsonl`);
          // The canonical root was listed above, including symlink targets. An
          // absent run directory rules out this candidate without a per-file stat.
          checkedPaths.push(path);
          if (!scratchIndex.get(scratch)?.has(id)) continue;
          const errorStart = errors.length;
          if (await add(path, candidate.project, candidate.repo, run)) { found = true; break; }
          // Keep actionable IO errors, but emit a single missing-source diagnostic below.
          const attempted = errors.splice(errorStart);
          errors.push(...attempted.filter(e => e.code !== "missing-source"));
        }
        if (!found) errors.push({ path: checkedPaths[0], code: "missing-source", checkedPaths });
      }
      if (tables.has("run_events")) {
        const columns = new Set((db.prepare("PRAGMA table_info(run_events)").all() as { name: string }[]).map(row => row.name));
        if (["id", "run_id", "ts", "type", "payload"].every(c => columns.has(c))) {
          const context = columns.has("session_id") ? "session_id" : "NULL AS session_id";
          const events = db.prepare(`SELECT id,run_id,ts,type,payload,${context} FROM run_events
            WHERE type IN ('spider_usage','spider_usage_reported') ORDER BY id`);
          for (const row of events.all() as Record<string, unknown>[]) {
            const id = number(row.id), runId = text(row.run_id), ts = number(row.ts), type = text(row.type);
            if (id === null || !runId || ts === null || !type) { errors.push({ path: dbPath, code: "invalid-run-event" }); continue; }
            runEvents.push({ dbPath, id, runId, ts, type, sessionId: text(row.session_id), payload: text(row.payload) });
          }
        } else errors.push({ path: dbPath, code: "legacy-run-events" });
      }
    } catch (error) { errors.push({ path: dbPath, code: code(error) }); }
    finally { db?.close(); }
  }
  return {
    sources: [...sources.values()].sort((a, b) => a.path.localeCompare(b.path)), runs, errors,
    runEvents, runStates, runDbs, runDbIdentities, ledgerFile: resolve(roots.ledgerFile)
  };
}
