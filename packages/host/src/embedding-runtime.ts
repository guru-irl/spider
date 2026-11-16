import { openDb, openDbReadOnly, openGlobalReadOnly, resolveProject, paths, type Db, type ProjectInfo } from "@spider/db-core";
import { join } from "node:path";
import {
  resolveEmbedder, drainEmbedQueue, abortableEmbeddingTask, hasEmbeddingWork,
  hasEmbeddingTable, repairStaleVectors, isEmbeddingBusy, onEmbedEnqueued, onEmbeddingDiagnostic,
  markEmbedDrainAttempt, recordEmbedDrainError, safeReviewError, type Embedder,
} from "@spider/memory";
import { emitLog } from "@spider/subagents";
import { cwdOf, sessionIdOf } from "./session-context";

const runtimeErrors = { errors: 0, lastError: undefined as string | undefined, lastErrorAt: undefined as number | undefined, lastDrainAt: undefined as number | undefined };
export function getEmbeddingRuntimeErrors(): Readonly<typeof runtimeErrors> { return { ...runtimeErrors }; }
export function embeddingRepoPath(project: ProjectInfo): string {
  return project.repoKey ? join(project.repoKey, "spider", "repo.db") : join(paths.projectRoot(project.projectKey), "repo.db");
}

/** Storage maintenance is independent of organism learning. Only parents consume. */
export class HostEmbeddingRuntime {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #task: Promise<void> | undefined;
  #drainAbort: AbortController | undefined;
  #stopped = false;
  #paused = false;
  #paths: string[] = [];
  #project: ProjectInfo | undefined;
  #sessionId = "";
  #idleMs = 5000;
  #cursor = 0;
  #missingScans = new Map<string, number>();
  #unsubscribe: (() => void) | undefined;
  #unlog: (() => void) | undefined;
  #wakePending = false;
  constructor(
    private readonly getContext: () => unknown,
    private readonly getEmbedder: () => Promise<Embedder | null> = resolveEmbedder,
    private readonly opts: { intervalMs?: number; timeoutMs?: number; enabled?: (project: ProjectInfo) => boolean; admitted?: () => boolean } = {},
  ) {}

  start(): void {
    if (this.#stopped || this.#paused || this.#project || this.opts.admitted?.() === false || process.env.PI_SUBAGENT_CHILD === "1") return;
    const ctx = this.getContext();
    this.#sessionId = sessionIdOf(ctx) || "embedding-runtime";
    this.#project = resolveProject(cwdOf(ctx) ?? process.cwd(), { sessionId: sessionIdOf(ctx) || undefined, explicitCwd: false });
    this.#paths = [embeddingRepoPath(this.#project), this.#project.dbPath];
    this.#idleMs = this.opts.intervalMs ?? 5000;
    this.#unsubscribe = onEmbedEnqueued(path => {
      if (!this.#paths.includes(path) || this.#stopped || this.#paused || this.opts.admitted?.() === false) return;
      this.#idleMs = this.opts.intervalMs ?? 5000;
      if (this.#task) this.#wakePending = true;
      else this.#schedule(0);
    });
    this.#unlog = onEmbeddingDiagnostic((message, db) => {
      if (db && !this.#paths.includes(db.raw.name)) return;
      this.#log(message);
    });
    this.#repairLegacyGlobal();
    this.#schedule(this.#idleMs);
  }
  #repairLegacyGlobal(): void {
    if (this.opts.admitted?.() === false || this.opts.enabled?.(this.#project!) === false) return;
    let snapshot: Db | undefined, writer: Db | undefined;
    try {
      snapshot = openGlobalReadOnly();
      if (!snapshot || !hasEmbeddingTable(snapshot, "embed_queue") || !snapshot.prepare("SELECT 1 FROM embed_queue LIMIT 1").get()) return;
      const path = snapshot.raw.name; snapshot.close(); snapshot = undefined;
      writer = openDb(path, { fileMustExist: true, busyTimeoutMs: 250, checkpointOnClose: false });
      writer.raw.transaction(() => repairStaleVectors(writer!, 32)).immediate();
    } catch (error) {
      if (!isEmbeddingBusy(error)) this.#log(`embedding global repair: ${safeReviewError(error)}`);
    } finally { snapshot?.close(); writer?.close(); }
  }
  #schedule(delay: number): void {
    if (this.#stopped || this.#paused || this.opts.admitted?.() === false) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#timer = undefined; this.#tick(); }, delay);
    this.#timer.unref();
  }
  /** Stop timers and wait for an aborted in-flight drain before acknowledging a freeze. */
  async pause(): Promise<void> {
    this.#paused = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#drainAbort?.abort(new Error("embedding worker paused"));
    await this.#task;
  }
  resume(): void {
    if (!this.#paused || this.#stopped) return;
    if (this.opts.admitted?.() === false) throw new Error("Session ownership is not available");
    this.#paused = false;
    if (this.#project) this.#schedule(this.opts.intervalMs ?? 5000);
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.(); this.#unlog?.();
    this.#drainAbort?.abort(new Error("embedding worker stopped"));
    await this.#task;
  }
  #log(message: string): void {
    if (this.#stopped || this.#paused || !this.#project || this.opts.admitted?.() === false) return;
    let db: Db | undefined;
    try {
      db = openDb(this.#project.dbPath, { fileMustExist: true, busyTimeoutMs: 250, checkpointOnClose: false });
      emitLog(db, { sessionId: this.#sessionId, summary: message, payload: { embedding: true } });
    } catch { /* doctor also retains the in-process state when logging is unavailable */ }
    finally { db?.close(); }
  }
  #tick(): void {
    if (this.#task || this.#stopped || this.#paused || this.opts.admitted?.() === false || process.env.PI_SUBAGENT_CHILD === "1") return;
    const cancellation = new AbortController(); this.#drainAbort = cancellation;
    this.#task = this.#drain(cancellation.signal).catch(error => {
      if (cancellation.signal.aborted || isEmbeddingBusy(error)) return;
      runtimeErrors.errors++; runtimeErrors.lastError = safeReviewError(error); runtimeErrors.lastErrorAt = Date.now();
      this.#log(`embedding runtime: ${runtimeErrors.lastError}`);
    }).finally(() => {
      this.#drainAbort = undefined; this.#task = undefined;
      if (this.#wakePending) { this.#wakePending = false; this.#schedule(0); }
      else this.#schedule(this.#idleMs);
    });
  }
  async #provider(signal: AbortSignal): Promise<Embedder | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await abortableEmbeddingTask(Promise.race([
        Promise.resolve().then(() => this.getEmbedder()),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), this.opts.timeoutMs ?? 10000); timer.unref(); }),
      ]), signal);
    } finally { clearTimeout(timer); }
  }
  async #drain(signal: AbortSignal): Promise<void> {
    if (this.opts.admitted?.() === false) return;
    if (this.opts.enabled?.(this.#project!) === false) { this.#idleMs = Math.min(this.#idleMs * 2, 300000); return; }
    let activity = false, inferred = false;
    const offset = this.#cursor++ % this.#paths.length;
    for (let i = 0; i < this.#paths.length; i++) {
      if (signal.aborted || this.opts.admitted?.() === false) break;
      const path = this.#paths[(offset + i) % this.#paths.length];
      let db: Db | undefined;
      try {
        const snapshot = openDbReadOnly(path, { busyTimeoutMs: 250 });
        if (!snapshot) continue;
        let work: boolean;
        try { work = hasEmbeddingWork(snapshot, this.#missingScans); } finally { snapshot.close(); }
        if (!work || signal.aborted || this.opts.admitted?.() === false) continue;
        activity = true;
        db = openDb(path, { fileMustExist: true, busyTimeoutMs: 250, checkpointOnClose: false });
        const queued = hasEmbeddingTable(db, "embed_queue") && !!db.prepare("SELECT 1 FROM embed_queue WHERE COALESCE(tries, 0) < 5 LIMIT 1").get();
        let embedder: Embedder | null = null;
        if (queued && !inferred) {
          markEmbedDrainAttempt(db);
          embedder = await this.#provider(signal);
          inferred = true;
        }
        // Shutdown must fence repair as well as inference and late commits.
        if (signal.aborted || this.opts.admitted?.() === false) break;
        if (await drainEmbedQueue(db, embedder, 8, { signal, missingScans: this.#missingScans })) runtimeErrors.lastDrainAt = Date.now();
      } catch (error) {
        if (!signal.aborted && this.opts.admitted?.() !== false && !isEmbeddingBusy(error)) {
          if (db) recordEmbedDrainError(db, error);
          else throw error;
        }
      } finally { db?.close(); }
      let yieldTimer: ReturnType<typeof setTimeout> | undefined;
      try { await abortableEmbeddingTask(new Promise<void>(resolve => { yieldTimer = setTimeout(resolve, 0); yieldTimer.unref(); }), signal); }
      finally { clearTimeout(yieldTimer); }
    }
    this.#idleMs = activity ? this.opts.intervalMs ?? 5000 : Math.min(this.#idleMs * 2, 300000);
  }
}
