import { statSync } from "node:fs";
import { openDashboardReader } from "./dashboard-reader.js";
import type { DashboardReader } from "./dashboard-contract.js";
import { billingPeriod } from "./billing-pace.js";
import { readCorrectedTotal } from "./query-redesign-shared.js";
import { calibrationFallback } from "./calibration.js";
import type { MessagePort } from "node:worker_threads";
import { discoverUsageSources } from "./discovery.js";
import { ingestOnce } from "./ingest.js";
import { backfillSessionMetadata, METADATA_BACKFILL_BYTES_PER_PASS } from "./session-backfill.js";
import { openUsageLedger, openUsageLedgerReadOnly, type UsageLedger, type ImportBatch } from "./ledger.js";
import { acquireUsageLease, UsageLeaseError, type Lease } from "./lease.js";
import { CounterPoller, counterSnapshotIsFresh } from "./counter.js";
import type { BackfillState, ReconciliationView, UsageWorkerCommand, UsageWorkerEvent } from "./protocol.js";

export type UsageWorkerDependencies = {
  discover?: typeof discoverUsageSources;
  ingest?: (...args: Parameters<typeof ingestOnce>) => ReturnType<typeof ingestOnce>;
  now?: () => number;
  monotonicNow?: () => number;
  fetch?: typeof globalThis.fetch;
};
const TTL_MS = 120000;
export const CYCLE_MS = 60000;
const BATCH_SOURCES = 8;
const BATCH_BYTES = 4 * 1024 * 1024;
export const SNAPSHOT_MS = 3000;
export const DASHBOARD_BACKOFF_MS = 10000;

/** Boot only from the marked worker seam, never from extension registration. */
export async function bootUsageWorker(
  port: MessagePort, command: Extract<UsageWorkerCommand, { type: "start" }>, dependencies: UsageWorkerDependencies = {},
): Promise<void> {
  const post = (event: UsageWorkerEvent) => { try { port.postMessage(event); } catch { /* parent gone */ } };
  if (command.child) { post({ type: "stopped" }); port.close(); return; }
  const now = dependencies.now ?? Date.now;
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const discover = dependencies.discover ?? discoverUsageSources;
  const ingest = dependencies.ingest ?? ingestOnce;
  let ledger: UsageLedger | undefined, lease: Lease | undefined, poller: CounterPoller | undefined;
  let monthReader: DashboardReader | undefined;
  let stopped = false, pending = false, task: Promise<void> | undefined, stopping: Promise<void> | undefined;
  let poll = !command.dashboardMode && command.poll;
  let calibrationMode = command.calibration ?? "auto";
  let reopen = false;
  let opened = false, openFailures = 0, retryOpenAt = 0;
  function failedFirstOpen(failure: unknown): void {
    if (opened) return;
    const permanent = failure instanceof Error && /^Unsupported (?:future )?usage schema /.test(failure.message);
    const delay = permanent ? CYCLE_MS : Math.min(CYCLE_MS, SNAPSHOT_MS * 2 ** Math.min(openFailures++, 5));
    retryOpenAt = monotonicNow() + delay;
  }
  let dashboardPass = false, standbyUntil = 0, nextPassAt = 0;
  let dashboardLease: Lease | undefined;
  let pendingRelease: { lease: Lease; ledger: UsageLedger } | undefined;
  let backfill: BackfillState = "pending";
  let metadataBackfill: BackfillState = "pending", monthDirty = true;
  let progress = { sourcesCompleted: 0, sourcesTotal: 0 };
  let cachedSnapshot: Extract<UsageWorkerEvent, { type: "snapshot" }> | undefined;
  let version = -1, lastPublish = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let controller = new AbortController();
  const error = (_failure: unknown, code = "usage-ingest-failed") => post({ type: "error", code });
  function follow(code: "usage-ingest-lease-lost" | "usage-ingest-lease-busy"): void {
    controller.abort(); lease = undefined; reopen = true;
    // A normal ownership transition, not a failed import. Reopen only after the
    // current ingest settles so its native connection is not closed underneath it.
    post({ type: "error", code });
  }
  const guard = () => !stopped && !controller.signal.aborted && !!lease?.isCurrent(now);
  const stateBatch = (state: BackfillState): ImportBatch => ({ calls: [], runs: [], states: [], resetSources: [], sourceErrors: [], detailedRunIds: [], restoreAggregateRunIds: [], at: now(), commitGuard: guard, backfillState: state });
  function counter(): void {
    poller = new CounterPoller({ ledger: ledger!, authPath: command.roots.authPath, enabled: poll, isChild: false, readOnly: !lease, now, fetch: dependencies.fetch ?? globalThis.fetch });
    poller.start();
    opened = true;
  }
  // Detach before a fallible close/stop/open, so the next cycle can retry.
  function closeLedger(): void {
    monthReader?.close(); monthReader = undefined;
    const previous = ledger; ledger = undefined;
    previous?.close();
  }
  async function stopCounter(): Promise<void> {
    const previous = poller; poller = undefined;
    await previous?.stop();
  }
  function retryRelease(): void {
    const previous = pendingRelease;
    if (!previous) return;
    try { previous.lease.release(); }
    catch (failure) {
      error(failure, failure instanceof UsageLeaseError && failure.code === "lease-busy"
        ? "usage-ingest-lease-busy" : "usage-ingest-failed");
      return;
    }
    pendingRelease = undefined;
    previous.ledger.close();
  }
  function open(): void {
    // SQLite data_version is connection-local, not a ledger-wide revision.
    version = -1; cachedSnapshot = undefined; monthDirty = true;
    // A live owner means followers never even use the writable opener/migrations.
    ledger = openUsageLedgerReadOnly(command.roots.ledgerFile);
    if (command.dashboardMode && monotonicNow() < nextPassAt) {
      if (!ledger) throw new Error("ledger unavailable");
      counter(); return;
    }
    if (ledger && ledger.leases.inspect("ingest", now(), command.owner).role === "follower") { counter(); return; }
    closeLedger(); ledger = openUsageLedger(command.roots.ledgerFile);
    try { lease = acquireUsageLease(ledger, "ingest", command.owner, now, TTL_MS); }
    catch (failure) { if (!(failure instanceof UsageLeaseError && failure.code === "lease-busy")) throw failure; }
    if (!lease) { closeLedger(); ledger = openUsageLedgerReadOnly(command.roots.ledgerFile); }
    if (!ledger) throw new Error("ledger unavailable");
    counter();
  }
  function comparisonCounter(counterState: ReturnType<CounterPoller["state"]>) {
    const candidate = counterState.availability === "disabled" ? ledger!.latestCounter() : counterState.latest;
    return (counterState.availability === "available" || counterState.availability === "disabled")
      && counterSnapshotIsFresh(candidate, now(), counterState.nextPollAt) ? candidate : null;
  }
  function reconciliation(): ReconciliationView {
    const latest = comparisonCounter(poller!.state());
    const end = latest?.ts ?? now();
    const date = new Date(end);
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const summary = ledger!.summarize(start, end);
    const credits = latest?.creditsUsed ?? null;
    return { windowStart: start, windowEnd: end, computedAIC: summary.aic, counterAIC: credits, gap: credits === null ? null : credits - summary.aic, ratio: credits === null || credits === 0 ? null : summary.aic / credits, unpricedCalls: summary.unpricedCalls, estimated: true };
  }
  function publish(full = true): void {
    if (stopped || !ledger || !poller) return;
    const counterState = poller.state();
    // No opaque endpoint body/account identifiers cross to pi or the shared row.
    if (counterState.latest) {
      const { raw: _raw, accountLogin: _login, ...fields } = counterState.latest;
      counterState.latest = { ...fields, raw: {} };
    }
    if (!lease) {
      const currentVersion = ledger.dataVersion();
      if (version !== currentVersion) { cachedSnapshot = ledger.getPublishedSnapshot(); version = currentVersion; }
      const snapshot = cachedSnapshot ?? { type: "snapshot" as const, calibration: calibrationFallback(), health: { schemaVersion: 1, ...ledger.getProgress(), aggregateCalls: 0, unpricedModels: [] }, backfill, reconciliation: { windowStart: 0, windowEnd: 0, computedAIC: 0, counterAIC: null, gap: null, ratio: null, unpricedCalls: 0, estimated: true } };
      const comparison = { ...snapshot.reconciliation };
      // Until the owner publishes the matching window, do not compare a new
      // counter to a summary of a different interval. No follower ledger scan.
      const latest = comparisonCounter(counterState);
      if (!latest || latest.ts !== comparison.windowEnd) {
        comparison.counterAIC = comparison.gap = comparison.ratio = null;
      }
      const calibration = calibrationMode === "off" ? calibrationFallback("off")
        : snapshot.calibration?.status === "off" ? calibrationFallback() : snapshot.calibration ?? calibrationFallback();
      const ingestRole = command.dashboardMode && ledger.leases.inspect("ingest", now(), command.owner).role !== "follower"
        ? "standby" : "follower";
      post({ ...snapshot, calibration, ingestRole, counter: counterState, reconciliation: comparison });
      return;
    }
    const health = full || !cachedSnapshot ? ledger.health() : { ...cachedSnapshot.health, ...ledger.getProgress() };
    const comparison = full || !cachedSnapshot ? reconciliation() : cachedSnapshot.reconciliation;
    const monthPeriod = billingPeriod(now(), ledger.latestCounter());
    const sameMonth = cachedSnapshot?.monthPeriod?.start === monthPeriod.start && cachedSnapshot.monthPeriod.end === monthPeriod.end;
    let monthUsed = sameMonth ? cachedSnapshot?.monthUsed ?? null : null;
    if (monthDirty || !sameMonth) {
      try {
      monthReader ??= openDashboardReader(command.roots.ledgerFile, { instanceId: "usage-footer", serverBuild: "worker", now,
        calibrationMode: () => calibrationMode });
      monthUsed = monthReader?.snapshot(ctx => readCorrectedTotal(ctx, { start: monthPeriod.start, end: now() })) ?? null;
      } catch { monthUsed = null; /* Footer data must never fail ingestion. */ }
      monthDirty = false;
    }
    const snapshot: Extract<UsageWorkerEvent, { type: "snapshot" }> = { type: "snapshot", metadataBackfill, monthUsed, monthPeriod, collector: { kind: command.dashboardMode ? "dashboard" : "pi", sessionId: command.dashboardMode ? null : command.sessionId ?? null, owner: command.owner }, sourceErrorDiagnostics: ledger.getSourceErrorDiagnostics(20), calibration: ledger.getCalibration(calibrationMode), ingestRole: "owner", health, counter: counterState, backfill, reconciliation: comparison, progress: { ...progress } };
    if (!ledger.apply({ ...stateBatch(backfill), publishedSnapshot: snapshot })) return;
    cachedSnapshot = snapshot; lastPublish = performance.now(); post(snapshot);
  }
  async function standby(): Promise<void> {
    const completedAt = monotonicNow();
    standbyUntil = completedAt + DASHBOARD_BACKOFF_MS;
    nextPassAt = completedAt + CYCLE_MS;
    controller.abort(); reopen = true;
    await stopCounter();
    const release = lease ?? dashboardLease;
    lease = dashboardLease = undefined;
    if (release && ledger) {
      monthReader?.close(); monthReader = undefined;
      pendingRelease = { lease: release, ledger }; ledger = undefined;
      retryRelease();
    } else closeLedger();
    if (stopped) return;
    controller = new AbortController(); reopen = false;
    version = -1; cachedSnapshot = undefined; monthDirty = true;
    ledger = openUsageLedgerReadOnly(command.roots.ledgerFile);
    if (!ledger) throw new Error("ledger unavailable");
    counter(); post({ type: "standby" });
  }
  async function cycle(): Promise<void> {
    dashboardPass = !!command.dashboardMode && !!lease;
    dashboardLease = dashboardPass ? lease : undefined;
    retryRelease();
    if (stopped || !opened && monotonicNow() < retryOpenAt || command.dashboardMode && monotonicNow() < standbyUntil) return;
    if (reopen) {
      await stopCounter(); closeLedger();
      controller = new AbortController(); reopen = false;
    }
    if (!ledger) open();
    // Capture a recovery acquisition before its first fallible renewal.
    if (command.dashboardMode && lease) { dashboardPass = true; dashboardLease = lease; }
    if (lease && !lease.renew(now)) {
      controller.abort(); lease = undefined;
      await stopCounter(); closeLedger();
      controller = new AbortController(); open();
    }
    if (command.dashboardMode && !lease) {
      const owner = ledger!.leases.inspect("ingest", now(), command.owner);
      // Once another participant owns the lease, its departure is takeover,
      // not a second unattended pass. Dead-PID/host/TTL rules stay in the store.
      if (owner.owner !== null && owner.owner !== command.owner) nextPassAt = 0;
      if (monotonicNow() < nextPassAt) { publish(); return; }
    }
    if (!lease && ledger!.leases.inspect("ingest", now(), command.owner).role !== "follower") {
      await stopCounter(); closeLedger(); open();
    }
    if (!lease) { backfill = ledger!.getBackfillState(); publish(); return; }
    dashboardPass = !!command.dashboardMode;
    if (dashboardPass) dashboardLease = lease;
    const first = ledger!.getBackfillState() !== "complete";
    if (first) { ledger!.apply(stateBatch("running")); backfill = "running"; publish(); }
    const discovery = await discover(command.roots);
    if (!guard()) return;
    // Stat filtering precedes any transcript open. Discovery stays complete for
    // fork and report attribution, but unchanged files pay no per-batch work.
    const changed: string[] = [];
    const persistedContexts = new Set(ledger!.getSourceHeaders().map(source => source.path));
    for (const source of discovery.sources) {
      const state = ledger!.getImportState(source.path);
      let info;
      try { info = statSync(source.path); } catch { changed.push(source.path); continue; }
      if (!(state && persistedContexts.has(source.path) && state.inode === `${info.dev}:${info.ino}` && state.size === info.size
        && state.mtimeMs === info.mtimeMs && state.offset === info.size)) changed.push(source.path);
    }
    progress = { sourcesCompleted: discovery.sources.length - changed.length, sourcesTotal: discovery.sources.length };
    let firstCall = true;
    if (!changed.length) { await ingest(ledger!, discovery, now(), controller.signal, { sourcePaths: [], skipHealth: true, commitGuard: guard, onCallsAdded: () => { monthDirty = true; } }); firstCall = false; }
    for (let i = 0; i < changed.length && guard(); i += BATCH_SOURCES) {
      let remaining = changed.slice(i, i + BATCH_SOURCES);
      while (remaining.length && guard()) {
        const offsets = new Map(remaining.map(path => [path, ledger!.getImportState(path)?.offset ?? -1]));
        await ingest(ledger!, discovery, now(), controller.signal, { sourcePaths: remaining, maxBytes: BATCH_BYTES, commitGuard: guard, skipHealth: true, skipShared: !firstCall, onCallsAdded: () => { monthDirty = true; } });
        firstCall = false;
        remaining = remaining.filter(path => { const state = ledger!.getImportState(path); return state && state.offset < state.size && state.offset > offsets.get(path)!; });
        if (guard() && performance.now() - lastPublish >= SNAPSHOT_MS) publish(false);
        // Stop, heartbeat and counter timers also run between slices of one file.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      progress.sourcesCompleted += Math.min(BATCH_SOURCES, changed.length - i);
      if (guard() && (performance.now() - lastPublish >= SNAPSHOT_MS || first && progress.sourcesCompleted % 32 === 0)) publish(false);
    }
    if (!guard()) return;
    const metadata = await backfillSessionMetadata(ledger!, discovery, now(), controller.signal, guard, METADATA_BACKFILL_BYTES_PER_PASS);
    if (!guard()) return;
    metadataBackfill = metadata.complete ? "complete" : "running";
    // Billing import completion is independent of the bounded metadata pass.
    backfill = "complete";
    ledger!.apply(stateBatch(backfill)); publish();
  }
  function schedule(): void {
    if (stopped) return;
    clearTimeout(timer);
    // New followers observe the initial owner's completion promptly, read-only.
    const at = monotonicNow();
    const delay = !opened ? Math.max(0, retryOpenAt - at) : pendingRelease ? SNAPSHOT_MS : command.dashboardMode && at < standbyUntil ? standbyUntil - at
      : command.dashboardMode && !lease && nextPassAt > at ? Math.min(SNAPSHOT_MS, nextPassAt - at)
      : !lease ? SNAPSHOT_MS : CYCLE_MS;
    timer = setTimeout(request, delay);
    timer.unref?.();
  }
  function request(): void {
    if (stopped) return;
    if (task) { pending = true; return; }
    task = (async () => {
      do {
        pending = false;
        try { await cycle(); }
        catch (failure) {
          failedFirstOpen(failure);
          if (failure instanceof UsageLeaseError && failure.code === "lease-busy") {
            follow("usage-ingest-lease-busy");
            continue;
          }
          backfill = "failed";
          try { if (guard()) ledger!.apply(stateBatch("failed")); } catch { /* next cycle retries */ }
          error(failure, ledger ? "usage-ingest-failed" : "usage-ledger-unavailable");
        } finally {
          if (dashboardPass) {
            try { await standby(); }
            catch (failure) { error(failure, "usage-ledger-unavailable"); }
          }
        }
      } while (pending && !stopped);
    })().finally(() => { task = undefined; if (pending && !stopped) request(); else schedule(); });
  }
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopped = true; pending = false; controller.abort(); clearTimeout(timer); clearInterval(heartbeat);
    stopping = (async () => {
      try { await task; await stopCounter(); }
      finally {
        const release = lease ?? dashboardLease; lease = dashboardLease = undefined;
        let released = true;
        try { release?.release(); } catch { released = false; /* parent cleanup or TTL */ }
        try { retryRelease(); } catch { /* released connection close failed */ }
        released = released && !pendingRelease;
        const releasing = pendingRelease; pendingRelease = undefined;
        try { releasing?.ledger.close(); } catch { /* forced parent cleanup or expiry */ }
        try { closeLedger(); } catch { /* no native handle survives port close */ }
        port.off("message", onMessage); post({ type: "stopped", released }); port.close();
      }
    })();
    return stopping;
  }
  function onMessage(message: UsageWorkerCommand): void {
    if (message?.type === "stop") { void stop(); return; }
    if (stopped) return;
    if (message?.type === "refresh") request();
    else if (message?.type === "configure") { poll = !command.dashboardMode && message.poll; calibrationMode = message.calibration ?? calibrationMode; poller?.setEnabled(poll); request(); }
  }
  port.on("message", onMessage);
  heartbeat = setInterval(() => {
      try { if (lease && !lease.renew(now)) follow("usage-ingest-lease-lost"); }
      catch (failure) {
        if (failure instanceof UsageLeaseError && failure.code === "lease-busy") follow("usage-ingest-lease-busy");
        else error(failure);
      }
    }, TTL_MS / 3);
  heartbeat.unref?.();
  try { open(); timer = setTimeout(request, 0); timer.unref?.(); }
  catch (failure) { failedFirstOpen(failure); error(failure, "usage-ledger-unavailable"); schedule(); }
}
