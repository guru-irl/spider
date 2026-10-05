import { randomUUID } from "node:crypto";
import type { CounterSnapshot, UsageLedger } from "./ledger.js";
import { readCopilotOAuthToken } from "./credential.js";
import { acquireUsageLease, inspectUsageLease, UsageLeaseError, type Lease, type UsageNotice } from "./lease.js";

export type { CounterSnapshot } from "./ledger.js";
export type CounterState = {
  availability: "disabled" | "unavailable" | "available" | "stale";
  role: "inactive" | "owner" | "follower";
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextPollAt: number | null;
  snapshotAgeMs: number | null;
  errorCode: string | null;
  notice: UsageNotice | null;
  latest: CounterSnapshot | null;
};
export type CounterPollerOptions = {
  authPath: string;
  ledger: UsageLedger;
  isChild: boolean;
  /** Ingest followers refresh shared snapshots without acquiring a counter lease. */
  readOnly?: boolean;
  enabled: boolean;
  now: () => number;
  fetch: typeof globalThis.fetch;
};

const POLL_MS = 600000;
const TTL_MS = 120000;
const RENEW_MS = TTL_MS / 3;
const BUSY_RETRY_MS = 3000;
// Honor shared cadence with grace, but never let failed saves extend freshness forever.
const STALE_MS = 2 * POLL_MS + 120000;
const HARD_STALE_MS = 3 * POLL_MS + 120000;
/** Shared Task 5 freshness rule, including disabled-poll reconciliation. */
export function counterSnapshotIsFresh(snapshot: CounterSnapshot | null | undefined, at: number, nextDueAt: number | null): boolean {
  return !!snapshot && at >= snapshot.ts && at - snapshot.ts <= HARD_STALE_MS
    && at <= Math.max(snapshot.ts + STALE_MS, (nextDueAt ?? 0) + 120000);
}
const RELEASE_MS = 2000;
const DEADLINE_MS = 15000;
const STOP_MS = 1000;
const LEASE_NAME = "counter";
const ENDPOINT = "https://api.github.com/copilot_internal/user";
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
class PayloadLimitError extends Error {}

/** Bound recursion, nodes and UTF-8 bytes before cloning or storing raw JSON. */
function sanitized(value: unknown, secrets: readonly string[] = []): unknown {
  let nodes = 0, bytes = 0;
  const count = (size: number) => {
    bytes += size;
    if (bytes > 1048576) throw new PayloadLimitError();
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 32 || ++nodes > 10000) throw new PayloadLimitError();
    count(8);
    if (typeof item === "string") {
      count(Buffer.byteLength(item));
      return secrets.some(secret => item.includes(secret)) ? "[redacted]" : item;
    }
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (object(item)) {
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(item)) {
        count(Buffer.byteLength(key));
        if (/^(authorization|proxyauthorization|headers|auth|credentials?|access|refresh|.*token|.*secret|password|apikey|cookie|setcookie)$/i.test(key.replace(/[-_]/g, ""))) continue;
        result[key] = visit(item[key], depth + 1);
      }
      return result;
    }
    return item;
  };
  return visit(value, 0);
}

function parsed(body: unknown, at: number): CounterSnapshot | undefined {
  if (!object(body) || !object(body.quota_snapshots) || !object(body.quota_snapshots.premium_interactions)) return undefined;
  const quota = body.quota_snapshots.premium_interactions;
  if (!nonnegative(quota.credits_used) || quota.token_based_billing === false) return undefined;
  return {
    ts: at, creditsUsed: quota.credits_used,
    ...(typeof body.login === "string" ? { accountLogin: body.login } : {}),
    ...(nonnegative(quota.entitlement) ? { entitlement: quota.entitlement } : {}),
    ...(nonnegative(quota.remaining) ? { remaining: quota.remaining } : {}),
    ...(typeof body.quota_reset_date === "string" ? { resetDate: body.quota_reset_date } : {}),
    raw: body,
  };
}
export function parseCounterResponse(body: unknown, at: number): CounterSnapshot | undefined {
  try { return parsed(sanitized(body), at); } catch { return undefined; }
}

/** Bound fetching and decoding even if an injected transport ignores abort. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("aborted"));
    if (signal.aborted) { abort(); void operation.catch(() => {}); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}

export class CounterPoller {
  private readonly owner = randomUUID();
  private enabled: boolean;
  private started = false;
  private epoch = 0;
  private lease: Lease | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private task: Promise<void> | undefined;
  private leaseBusy = false;
  private busyBackoffMs = 1000;
  private pendingError: string | undefined;
  private pendingSave: { lease: Lease; epoch: number; snapshot: CounterSnapshot } | undefined;
  private current: CounterState;

  constructor(private readonly options: CounterPollerOptions) {
    this.enabled = options.enabled;
    this.current = {
      availability: options.isChild || !options.enabled ? "disabled" : "unavailable", role: "inactive",
      lastAttemptAt: null, lastSuccessAt: null, nextPollAt: null, snapshotAgeMs: null, errorCode: null, notice: null, latest: null,
    };
  }
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.enabled && !this.options.isChild) this.tick();
  }
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.cancel();
    else if (this.started && !this.options.isChild) this.tick();
  }
  state(): CounterState {
    if (this.started && this.enabled && !this.options.isChild) {
      try {
        this.cached();
        if (!this.options.readOnly) this.options.ledger.leases.reconcileNotice(LEASE_NAME, this.options.now);
        const info = inspectUsageLease(this.options.ledger, LEASE_NAME, this.options.now(), this.owner);
        this.current.nextPollAt = info.nextDueAt;
        this.healthy(info);
      } catch (error) { this.fail(error instanceof UsageLeaseError ? error.code : "lease-storage"); }
    }
    const at = this.options.now();
    const age = this.current.latest ? at - this.current.latest.ts : null;
    const result = { ...this.current, snapshotAgeMs: age };
    if (result.availability !== "disabled" && age !== null) {
      if (age < 0) {
        if (this.current.notice?.code !== "clock-skew") this.current.notice = { code: "clock-skew", at };
        result.notice = this.current.notice; result.availability = "stale";
      } else if (!counterSnapshotIsFresh(result.latest, at, result.nextPollAt)) {
        result.availability = "stale";
      }
    }
    return structuredClone(result);
  }
  async stop(): Promise<void> {
    this.started = false;
    this.cancel(false);
    const lease = this.lease;
    const release = lease ? this.releaseWithRetry(lease) : Promise.resolve();
    if (!this.task) { await release; return; }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.all([release, Promise.race([this.task.catch(() => {}), new Promise<void>(resolve => {
        deadline = setTimeout(() => { this.current.errorCode = "stop-timeout"; resolve(); }, STOP_MS);
      })]).finally(() => { if (deadline) clearTimeout(deadline); })]);
    } finally { if (deadline) clearTimeout(deadline); }
  }
  private release(lease: Lease): boolean {
    try {
      lease.release();
      if (this.lease === lease) this.lease = undefined;
      if (this.current.errorCode === "release-failed") this.current.errorCode = null;
      return true;
    } catch { this.current.errorCode = "release-failed"; return false; }
  }
  private async releaseWithRetry(lease: Lease): Promise<void> {
    const deadline = performance.now() + RELEASE_MS;
    while (!this.release(lease)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return;
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, remaining)));
      if (performance.now() >= deadline) return;
    }
  }
  private cancel(release = true): void {
    this.epoch++;
    this.pendingSave = undefined; this.pendingError = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.leaseBusy = false;
    this.current.availability = "disabled"; this.current.role = "inactive";
    this.current.nextPollAt = null; this.current.errorCode = null; this.current.notice = null;
    if (release && this.lease) this.release(this.lease);
  }
  private fail(code: string): void {
    if (code === "lease-busy") {
      this.leaseBusy = true;
      this.current.notice = { code, at: this.options.now() };
      // A blocked renewal/save is not a failed poll while ownership and data
      // are still valid. Never overwrite a genuine poll failure with BUSY.
      if (this.lease && this.current.latest && this.lease.expiresAt > this.options.now()) return;
    }
    // A failed snapshot save remains a failure until a save actually commits.
    if (code !== "lease-lost" && (this.current.errorCode === "save-failed" || this.pendingError === "save-failed")) code = "save-failed";
    this.current.availability = "unavailable"; this.current.errorCode = code;
    if (code === "lease-lost") {
      this.current.role = "follower"; this.lease = undefined; this.pendingSave = undefined; this.pendingError = undefined;
      this.epoch++; this.controller?.abort();
      return;
    }
    if (this.lease && code !== "lease-busy" && code !== "lease-storage") {
      this.pendingError = code;
      try { if (this.lease.recordError(this.options.now, code)) this.pendingError = undefined; }
      catch (error) {
        // Storage contention must not erase the actual poll result.
        if (error instanceof UsageLeaseError && error.code === "lease-busy") {
          this.leaseBusy = true; this.current.notice = { code: "lease-busy", at: this.options.now() };
        }
      }
    }
  }
  private cached(): void {
    this.current.latest = this.options.ledger.latestCounter() ?? null;
    this.current.lastSuccessAt = this.current.latest?.ts ?? null;
  }
  private healthy(info: ReturnType<typeof inspectUsageLease>): void {
    this.current.errorCode = this.pendingError ?? info.lastErrorCode;
    if (this.leaseBusy && !this.current.latest && !this.current.errorCode) this.current.errorCode = "lease-busy";
    this.current.availability = this.current.errorCode ? "unavailable" : "available";
    if (!this.leaseBusy) this.current.notice = info.notice;
  }
  private saved(snapshot: CounterSnapshot): void {
    this.pendingSave = undefined; this.pendingError = undefined;
    this.current.latest = snapshot; this.current.lastSuccessAt = snapshot.ts;
    this.current.availability = "available"; this.current.errorCode = null;
  }
  private tick(retryStarted?: number): void {
    if (!this.started || !this.enabled || this.options.isChild) return;
    const at = this.options.now();
    const retryFrom = retryStarted ?? performance.now();
    let busy = false;
    try {
      if (this.lease && !this.lease.renew(this.options.now)) {
        // At expiry, reacquire atomically if nobody succeeded us. This is normal
        // after sleep, not a failure; preserve the cached snapshot and cadence.
        this.epoch++; this.controller?.abort(); this.pendingSave = undefined;
        this.lease = undefined; this.current.role = "follower";
      }
      if (!this.options.readOnly) this.lease ??= acquireUsageLease(this.options.ledger, LEASE_NAME, this.owner, this.options.now, TTL_MS);
      this.leaseBusy = false;
      if (!this.lease) {
        this.pendingError = undefined;
        const info = inspectUsageLease(this.options.ledger, LEASE_NAME, at, this.owner);
        this.current.role = "follower"; this.current.nextPollAt = info.nextDueAt;
        this.cached(); this.healthy(info);
      } else {
        this.current.role = "owner";
        this.cached();
        const lease = this.lease;
        if (this.pendingError && lease.recordError(this.options.now, this.pendingError)) this.pendingError = undefined;
        this.healthy(inspectUsageLease(this.options.ledger, LEASE_NAME, at, this.owner));
        if (this.pendingSave) {
          const pending = this.pendingSave;
          if (pending.lease !== lease || pending.epoch !== this.epoch) this.pendingSave = undefined;
          else {
            try {
              if (lease.saveIfCurrent(this.options.now, pending.snapshot)) this.saved(pending.snapshot);
              else this.fail("lease-lost");
            } catch (error) {
              if (error instanceof UsageLeaseError && error.code === "lease-busy") this.fail("lease-busy");
              this.fail("save-failed");
              throw error;
            }
          }
        }
        if (this.lease === lease) {
          const claimed = !this.task && lease.claimPoll(this.options.now, POLL_MS);
          this.current.nextPollAt = lease.nextPollAt();
          this.healthy(inspectUsageLease(this.options.ledger, LEASE_NAME, at, this.owner));
          if (claimed) {
            const epoch = this.epoch;
            const task = this.poll(lease, epoch, at).catch(error => {
              if (epoch === this.epoch) this.fail(error instanceof UsageLeaseError ? error.code : "internal");
            });
            this.task = task;
            void task.then(() => { if (this.task === task) this.task = undefined; });
          }
        }
      }
    } catch (error) {
      busy = error instanceof UsageLeaseError && error.code === "lease-busy";
      this.fail(error instanceof UsageLeaseError ? error.code : "lease-storage");
    }
    if (!busy) this.busyBackoffMs = 1000;
    const fastRetry = busy && this.current.role !== "follower";
    if (fastRetry && performance.now() - retryFrom < BUSY_RETRY_MS) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.tick(retryFrom), 75 + Math.floor(Math.random() * 75));
      this.timer.unref?.(); return;
    }
    const due = this.current.nextPollAt;
    // Owners recover promptly at first, then reduce event-loop share in long storms.
    // Followers only contend on their normal tick, never on the owner's fast loop.
    const delay = fastRetry ? this.busyBackoffMs : busy ? RENEW_MS
      : due !== null && due > at ? Math.min(RENEW_MS, due - at) : RENEW_MS;
    if (fastRetry) this.busyBackoffMs = Math.min(RENEW_MS, this.busyBackoffMs * 2);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay); this.timer.unref?.();
  }
  private async poll(lease: Lease, epoch: number, at: number): Promise<void> {
    this.current.lastAttemptAt = at;
    const token = readCopilotOAuthToken(this.options.authPath);
    if (!token) { this.fail("missing-auth"); return; }
    const controller = new AbortController(); this.controller = controller;
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, DEADLINE_MS); deadline.unref?.();
    const authorized = () => this.started && this.enabled && epoch === this.epoch && !controller.signal.aborted && lease.isCurrent(this.options.now);
    try {
      let response: Response;
      try {
        response = await abortable(this.options.fetch(ENDPOINT, {
          method: "GET", redirect: "error", signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`, Accept: "application/json",
            "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0",
            "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat",
          },
        }), controller.signal);
      } catch { if (epoch === this.epoch) this.fail(timedOut ? "timeout" : "network"); return; }
      if (!authorized()) {
        void response.body?.cancel().catch(() => {});
        if (epoch === this.epoch) this.fail("lease-lost"); return;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const code = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? `http-${response.status}` : "http-error";
        this.fail(code); return;
      }
      let body: unknown;
      try { body = await abortable(response.json(), controller.signal); }
      catch { if (epoch === this.epoch) this.fail(timedOut ? "timeout" : "malformed-json"); return; }
      if (!authorized()) { if (epoch === this.epoch) this.fail("lease-lost"); return; }
      const snapshot = parsed(sanitized(body, [token]), this.options.now());
      if (!snapshot) { this.fail("missing-counter"); return; }
      if (!authorized()) { if (epoch === this.epoch) this.fail("lease-lost"); return; }
      try {
        if (!lease.saveIfCurrent(this.options.now, snapshot)) { if (epoch === this.epoch) this.fail("lease-lost"); return; }
      } catch (error) {
        if (epoch === this.epoch) {
          if (error instanceof UsageLeaseError && error.code === "lease-busy") {
            this.pendingSave = { lease, epoch, snapshot }; this.fail("lease-busy");
          }
          this.fail("save-failed");
        }
        return;
      }
      this.saved(snapshot);
    } catch (error) {
      if (epoch === this.epoch) this.fail(error instanceof PayloadLimitError ? "payload-limit" : error instanceof UsageLeaseError ? error.code : "internal");
    } finally {
      clearTimeout(deadline);
      if (epoch !== this.epoch || !this.started || !this.enabled) this.release(lease);
      if (this.controller === controller) this.controller = undefined;
    }
  }
}
