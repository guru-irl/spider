import { randomUUID } from "node:crypto";
import { Worker, type WorkerOptions } from "node:worker_threads";
import type { UsageRoots } from "./discovery.js";
import type { UsageRuntimeSnapshot, UsageWorkerCommand, UsageWorkerEvent } from "./protocol.js";

export type UsageWorker = Pick<Worker, "on" | "off" | "postMessage" | "terminate" | "unref">;
export type UsageRuntimeOptions = {
  /** Pass loadedBundle.url, which is native import.meta.url even behind pi's shim. */
  bundleUrl: string | URL;
  roots: UsageRoots;
  child: boolean;
  workerFactory?: (entry: URL, options: WorkerOptions) => UsageWorker;
  onSnapshot?: (snapshot: UsageRuntimeSnapshot) => void;
  supportsWorkers?: () => boolean;
};

/** Capability, not binary names/install locations, mirrors the embedding adapter. */
export function supportsUsageWorkers(): boolean {
  let sea = false;
  try { sea = process.getBuiltinModule?.("node:sea")?.isSea?.() ?? false; } catch { /* optional runtime module */ }
  return !process.versions.bun && !sea && typeof Worker === "function";
}
const failureCode = (error: unknown): string => (error as { code?: string })?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "usage-worker-oom" : "usage-worker-failed";
const wireErrors = new Set(["usage-worker-failed", "usage-worker-oom", "usage-worker-unavailable", "usage-ledger-unavailable", "usage-ingest-failed", "usage-ingest-lease-lost", "usage-ingest-lease-busy"]);

/** No filesystem, transcript, DB, credential or model work runs on pi's thread. */
export class UsageRuntime {
  private worker: UsageWorker | undefined;
  private startup: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private stopped = false;
  private poll = false;
  private refreshPending = false;
  private workerFailed = false;
  private stopping: Promise<void> | undefined;
  private stoppedAck: (() => void) | undefined;
  private current: UsageRuntimeSnapshot = { health: null, counter: null, backfill: "pending", reconciliation: null, errorCode: null };
  constructor(private readonly options: UsageRuntimeOptions) {}

  start(poll: boolean): void {
    if (this.started || this.stopped || this.options.child) return;
    this.started = true; this.poll = poll;
    // A macrotask, not an awaited session_start hook or a microtask inside it.
    this.startup = setTimeout(() => {
      this.startup = undefined;
      if (this.stopped) return;
      if (!(this.options.supportsWorkers ?? supportsUsageWorkers)()) { this.fail("usage-worker-unavailable"); return; }
      try {
        const entry = new URL(this.options.bundleUrl);
        if (entry.protocol !== "file:" || !/\.m?js$/.test(entry.pathname)) { this.fail("usage-worker-unavailable"); return; }
        const command: Extract<UsageWorkerCommand, { type: "start" }> = {
          type: "start", roots: this.options.roots, owner: `${process.pid}:${randomUUID()}`, child: false, poll: this.poll,
        };
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        this.worker = (this.options.workerFactory ?? ((url, opts) => new Worker(url, opts)))(entry, {
          workerData: { spiderUsageWorker: 1, command },
          resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
          execArgv: [], // No inherited eval flags, inspector or arbitrary host preloads.
          env,
        });
        this.worker.on("message", this.onMessage);
        this.worker.on("error", this.onError);
        this.worker.on("exit", this.onExit);
        this.worker.unref();
      } catch (error) { this.fail(failureCode(error)); }
    }, 0);
    this.startup.unref?.();
  }
  refresh(): void {
    if (!this.worker || this.stopped || this.refreshPending) return;
    this.refreshPending = true; this.send({ type: "refresh" });
  }
  configure(poll: boolean): void {
    this.poll = poll;
    if (this.worker && !this.stopped) this.send({ type: "configure", poll });
  }
  snapshot(): UsageRuntimeSnapshot { return structuredClone(this.current); }
  private notify(): void { try { this.options.onSnapshot?.(this.snapshot()); } catch { /* UI errors do not escape the lifecycle */ } }
  private fail(code: string): void { this.refreshPending = false; this.current = { ...this.current, backfill: "failed", errorCode: code }; this.notify(); }
  private send(command: UsageWorkerCommand): void { try { this.worker?.postMessage(command); } catch (error) { if (!this.stopped) this.fail(failureCode(error)); } }
  private readonly onMessage = (event: UsageWorkerEvent): void => {
    if (event?.type === "stopped") { this.stoppedAck?.(); return; }
    if (this.stopped) return;
    if (event?.type === "snapshot") {
      this.refreshPending = false;
      this.current = { health: event.health, counter: event.counter, backfill: event.backfill, reconciliation: event.reconciliation, progress: event.progress, ingestRole: event.ingestRole, errorCode: null };
      this.notify();
    } else if (event?.type === "error") {
      if (event.code === "usage-ingest-lease-lost" || event.code === "usage-ingest-lease-busy") {
        this.refreshPending = false;
        this.current = { ...this.current, ingestRole: "follower" };
        this.notify();
      } else this.fail(wireErrors.has(event.code) ? event.code : "usage-worker-failed");
    }
  };
  private readonly onError = (error: Error): void => { this.workerFailed = true; if (!this.stopped) this.fail(failureCode(error)); this.stoppedAck?.(); };
  private readonly onExit = (): void => { const failed = this.workerFailed; this.workerFailed = true; if (!this.stopped && !failed && !this.current.errorCode) this.fail("usage-worker-failed"); this.stoppedAck?.(); };
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    if (this.startup) clearTimeout(this.startup);
    this.startup = undefined;
    const worker = this.worker;
    if (!worker) return this.stopping = Promise.resolve();
    this.stopping = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!this.workerFailed) await new Promise<void>(resolve => {
          this.stoppedAck = resolve;
          timer = setTimeout(resolve, 2000);
          this.send({ type: "stop" });
        });
      } finally {
        clearTimeout(timer); this.stoppedAck = undefined;
        worker.off("message", this.onMessage); worker.off("error", this.onError); worker.off("exit", this.onExit);
        // Keep an error sink until termination finishes to avoid unhandled emitter errors.
        const ignore = () => {}; worker.on("error", ignore);
        try { await worker.terminate(); } catch { /* worker already exited */ }
        worker.off("error", ignore); this.worker = undefined;
      }
    })();
    return this.stopping;
  }
}
