import { open, readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { openDbReadOnly, type Db } from "@spider/db-core";
import { normalizeRunStatus, type RunMeta, type SourceError } from "./ledger.js";
import type { SourceInfo as ParserSource } from "./parse.js";
import { summarizeRunEvents, type RunEvent, type RunEventFacts } from "./run-events.js";
import { UsageJsonLine } from "./jsonl-projection.js";
export type { RunEvent } from "./run-events.js";

export type UsageRoots = { registryDb: string; sessionsDir: string; ledgerFile: string; authPath: string; leaseDir: string };
/** Registry metadata can be absent in legacy databases. */
export type SourceInfo = Omit<ParserSource, "run"> & {
  run: RunMeta | null;
  roaming?: { localMachine: string; originMachine: string | null };
};
export type RunState = { dbPath: string; id: string; status: string | null; childMode: string | null };
export type Discovery = {
  sources: readonly SourceInfo[]; runs: readonly RunMeta[]; errors: readonly SourceError[];
  /** Read-only snapshots, not handles. Optional for hand-built discovery inputs. */
  runEvents?: RunEventFacts; runStates?: readonly RunState[]; runDbs?: readonly string[]; runDbIdentities?: Readonly<Record<string, string>>;
  /** Ledger destination supplied to the worker; never used to reconstruct open-ledger proof. */
  ledgerFile?: string;
};
export type DiscoveryDependencies = {
  openDb?: (path: string) => Db | undefined;
  readdir?: (path: string) => Promise<Dirent[]>;
};
// Only compact attribution heads survive discovery. Stamp checks invalidate
// replacements, truncation and appends; no transcript content or DB handle stays.
const attributionHeads = new WeakMap<UsageRoots, Map<string, { stamp: string; cwd: string | null; sessionId: string | null }>>();
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const code = (error: unknown): string => text((error as { code?: unknown })?.code) ?? "source-read-error";

async function sessionHeader(file: Awaited<ReturnType<typeof open>>): Promise<{ cwd: string | null; sessionId: string | null } | null> {
  const line = new UsageJsonLine(), buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) return null;
    const data = buffer.subarray(0, bytesRead), end = data.indexOf(10);
    line.write(end < 0 ? data : data.subarray(0, end + 1));
    if (end >= 0) {
      const header = line.finish() as { type?: unknown; cwd?: unknown; id?: unknown } | null | undefined;
      return header?.type === "session" ? { cwd: text(header.cwd), sessionId: text(header.id) } : null;
    }
    offset += bytesRead;
  }
}

/** No registry resolution, registration, migration, git commands or repository walks. */
export async function discoverUsageSources(roots: UsageRoots, dependencies: DiscoveryDependencies = {}): Promise<Discovery> {
  const openSourceDb = dependencies.openDb ?? openDbReadOnly;
  const list = dependencies.readdir ?? (path => readdir(path, { withFileTypes: true }));
  const sources = new Map<string, SourceInfo>();
  const stamps = new Map<string, string>();
  const heads = attributionHeads.get(roots) ?? new Map(); attributionHeads.set(roots, heads);
  const runs: RunMeta[] = [], runStates: RunState[] = [];
  const runEvents = summarizeRunEvents([]);
  const errors: SourceError[] = [];
  const runDbs: string[] = [];
  const runDbIdentities: Record<string, string> = {};
  async function canonical(path: string): Promise<string> { try { return await realpath(path); } catch { return resolve(path); } }
  async function add(path: string, project: string | null, repo: string | null, run: RunMeta | null, roaming?: SourceInfo["roaming"]) {
    const key = await canonical(path);
    try {
      const info = await stat(key);
      if (!info.isFile()) throw Object.assign(new Error("not a file"), { code: "not-file" });
      stamps.set(key, `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`);
    }
    catch (error) { errors.push({ path: key, code: code(error) === "ENOENT" ? "missing-source" : code(error) }); return false; }
    // Native run ownership is more specific than an incidental parent listing.
    if (!sources.has(key) || run && !sources.get(key)!.run) sources.set(key, { path: key, project, repo, run, ...(roaming ? { roaming } : {}) });
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
    const stamp = stamps.get(source.path)!;
    let head = heads.get(source.path);
    if (head?.stamp !== stamp) {
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await open(source.path, "r");
        const header = await sessionHeader(file);
        head = { stamp, cwd: header?.cwd ?? null, sessionId: header?.sessionId ?? null }; heads.set(source.path, head);
      } catch (error) { errors.push({ path: source.path, code: code(error) }); }
      finally { await file?.close(); }
    }
    if (!head?.cwd) continue;
    const owner = registrations.filter(r => {
      const path = relative(r.project, resolve(head.cwd!));
      return !isAbsolute(path) && path.split(sep)[0] !== "..";
    }).sort((a, b) => b.project.length - a.project.length)[0];
    if (owner) { source.project = owner.project; source.repo = owner.repo; }
  }
  for (const path of heads.keys()) if (!sources.has(path)) heads.delete(path);

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
      const meta = tables.has("roam_meta") ? db.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as { machine_id: unknown } | undefined : undefined;
      const localMachine = text(meta?.machine_id);
      const participants = new Map<string, string | null>();
      if (tables.has("roam_sessions") && tables.has("sessions")) {
        const sessionColumns = new Set((db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map(column => column.name));
        const origin = sessionColumns.has("origin_machine") ? "s.origin_machine" : "NULL";
        for (const row of db.prepare(`SELECT rs.session_id, ${origin} AS origin_machine FROM roam_sessions rs
          LEFT JOIN sessions s ON s.id=rs.session_id`).all() as { session_id: string; origin_machine: unknown }[])
          participants.set(row.session_id, text(row.origin_machine));
        for (const source of sources.values()) {
          const sessionId = heads.get(source.path)?.sessionId;
          if (sessionId && participants.has(sessionId))
            source.roaming = { localMachine: localMachine ?? "", originMachine: participants.get(sessionId) ?? null };
        }
      }
      if (!tables.has("runs")) continue; // Repo tiers without runs are normal.
      runDbs.push(dbPath);
      const identity = await stat(dbPath);
      runDbIdentities[dbPath] = `${identity.dev}:${identity.ino}:${identity.birthtimeMs}`;
      const columns = new Set((db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map(c => c.name));
      const needed = ["id", "session_id", "parent_run_id", "agent", "role", "name", "model", "thinking", "phase",
        "started_at", "ended_at", "status", "child_mode", "origin_machine"];
      const projection = needed.filter(c => columns.has(c)).join(",");
      const localRunIds = new Set<string>();
      for (const row of db.prepare(`SELECT ${projection} FROM runs ORDER BY id`).all() as Record<string, unknown>[]) {
        const originMachine = typeof row.origin_machine === "string" ? row.origin_machine : "";
        if (originMachine !== "" && originMachine !== localMachine) continue;
        const id = text(row.id);
        // A DB run id is a path component, never a path supplied by the source.
        if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) { errors.push({ path: dbPath, code: "invalid-run-id" }); continue; }
        localRunIds.add(id);
        const owner = owners[0];
        const run: RunMeta = {
          id, dbPath, project: owner.project, repo: owner.repo, sessionId: text(row.session_id),
          parentRunId: text(row.parent_run_id), agent: text(row.agent), role: text(row.role), name: text(row.name),
          model: text(row.model), thinking: text(row.thinking), phase: text(row.phase),
          startedAt: number(row.started_at), endedAt: number(row.ended_at), status: normalizeRunStatus(row.status)
        };
        runs.push(run); runStates.push({ id, dbPath, status: text(row.status), childMode: text(row.child_mode) });
        // Current runs schemas (including migrations) contain no launch cwd or
        // scratch path. Only registry-derived, canonical roots are authorized.
        const sameRepo = registrations.filter(r => owner.repo ? r.repo === owner.repo : r.project === owner.project);
        const rootsToCheck = new Map<string, typeof owner>();
        for (const r of [...sameRepo, ...uniqueRoots.values()]) {
          if (!rootsToCheck.has(r.scratch)) rootsToCheck.set(r.scratch, r);
        }
        const roaming = run.sessionId && participants.has(run.sessionId)
          ? { localMachine: localMachine ?? "", originMachine: originMachine || localMachine } : undefined;
        const checkedPaths: string[] = [];
        let checkedPathCount = 0;
        const rememberPath = (path: string) => {
          checkedPathCount++;
          // Flatten the bounded sample so joins retain no intermediate strings.
          if (checkedPaths.length < 8) checkedPaths.push(Buffer.from(path).toString());
        };
        let found = false;
        for (const [scratch, candidate] of rootsToCheck) {
          const path = join(scratch, "subagent-sessions", id, `${id}.jsonl`);
          // The canonical root was listed above, including symlink targets. An
          // absent run directory rules out this candidate without a per-file stat.
          rememberPath(path);
          if (!scratchIndex.get(scratch)?.has(id)) continue;
          const errorStart = errors.length;
          if (await add(path, candidate.project, candidate.repo, run, roaming)) { found = true; break; }
          // Keep actionable IO errors, but emit a single missing-source diagnostic below.
          const attempted = errors.splice(errorStart);
          errors.push(...attempted.filter(e => e.code !== "missing-source"));
          // Forks use --session-id <run id>; pi chooses a timestamped filename.
          // Only inspect matching filenames in this registered run directory.
          const directory = join(scratch, "subagent-sessions", id);
          try {
            for (const file of (await list(directory)).sort((a, b) => a.name.localeCompare(b.name))) {
              if (!file.isFile() || !file.name.endsWith(`_${id}.jsonl`)) continue;
              const forkPath = join(directory, file.name);
              rememberPath(forkPath);
              const handle = await open(forkPath, "r");
              let matches = false;
              try { matches = (await sessionHeader(handle))?.sessionId === id; }
              finally { await handle.close(); }
              if (matches && await add(forkPath, candidate.project, candidate.repo, run, roaming)) { found = true; break; }
            }
          } catch (error) { if (code(error) !== "ENOENT") errors.push({ path: directory, code: code(error) }); }
          if (found) break;
        }
        if (!found) errors.push({ path: checkedPaths[0], code: "missing-source", checkedPaths, checkedPathCount });
      }
      if (tables.has("run_events")) {
        const columns = new Set((db.prepare("PRAGMA table_info(run_events)").all() as { name: string }[]).map(row => row.name));
        if (["id", "run_id", "ts", "type", "payload"].every(c => columns.has(c))) {
          const context = columns.has("session_id") ? "session_id" : "NULL AS session_id";
          const events = db.prepare(`SELECT id,run_id,ts,type,payload,${context} FROM run_events
            WHERE type IN ('spider_usage','spider_usage_reported') ORDER BY id`);
          function* readEvents(): IterableIterator<RunEvent> {
            for (const row of events.iterate() as IterableIterator<Record<string, unknown>>) {
              const id = number(row.id), runId = text(row.run_id), ts = number(row.ts), type = text(row.type);
              if (id === null || !runId || ts === null || !type) { errors.push({ path: dbPath, code: "invalid-run-event" }); continue; }
              if (!localRunIds.has(runId)) continue;
              yield { dbPath, id, runId, ts, type, sessionId: text(row.session_id), payload: text(row.payload) };
            }
          }
          const facts = summarizeRunEvents(readEvents());
          for (const [key, summary] of facts.runs) runEvents.runs.set(key, summary);
          for (const event of facts.auxiliary) runEvents.auxiliary.push(event);
          for (const diagnostic of facts.unknown) runEvents.unknown.push(diagnostic);
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
