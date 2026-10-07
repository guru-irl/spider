import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { DashboardQueryError, type ApiErrorCode, type DashboardStatus, type HttpOptions } from "./dashboard-contract.js";
import { COPILOT_RATE_VERSIONS } from "./rates.js";
import { parsePage, parseSlice, validateParams } from "./dashboard-selection.js";
import { equalCredential, hasMintBearer, hasSafeBrowserMetadata, isBrowserMint, parseUsageTarget, usageSecurityHeaders, validateTransport } from "./server-security.js";

import { USAGE_HTTP_DRAIN_MS } from "./server-lifecycle.js";

const errors = {
  unauthorized: [401, "Unauthorized"], forbidden: [403, "Forbidden"], "invalid-query": [400, "Invalid query"],
  "ledger-changed": [409, "Ledger changed"], "ledger-unavailable": [503, "Ledger unavailable"],
  "identity-unavailable": [503, "Dashboard identity unavailable"], "unknown-filter-id": [400, "Unknown filter id"],
  "unsupported-schema": [503, "Unsupported schema"], busy: [503, "Busy"], internal: [500, "Internal error"],
  "rate-limited": [429, "Rate limited"], "response-limit": [413, "Response limit"],
  "method-not-allowed": [405, "Method not allowed"], "not-found": [404, "Not found"],
} as const satisfies Record<ApiErrorCode, readonly [number, string]>;
function fail(res: ServerResponse, code: keyof typeof errors, path?: string): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (code === "method-not-allowed") {
    res.setHeader("Allow", path === "/bootstrap" || path === "/local/bootstrap-nonce" ? "GET" : "GET, HEAD");
  }
  const body = JSON.stringify({ apiVersion: 1, error: { code: code satisfies ApiErrorCode, message: errors[code][1] } });
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.writeHead(errors[code][0]);
  res.end(res.req.method === "HEAD" ? undefined : body);
}

// Preflight the frozen foundational routes before even reading the snapshot revision.
// Query handlers retain their endpoint-specific validation and cursor generation checks.
const routeParams: Record<string, readonly string[]> = {
  "/api/status": [], "/api/overview": ["start", "end", "filters", "cursor"],
  "/api/context": ["start", "end", "filters"], "/api/source-errors": ["limit", "cursor"],
};
const responseCaps: Record<string, number> = {
  "/api/status": 8, "/api/source-errors": 64, "/api/overview": 512, "/api/explorer": 256, "/api/filter-values": 64,
  "/api/detail": 512, "/api/detail-links": 64, "/api/context": 8, "/api/cache": 256, "/api/reconciliation": 256, "/api/rates": 512,
};
function send(res: ServerResponse, body: string, maximum: number): boolean {
  if (Buffer.byteLength(body) > maximum) { res.setHeader("Content-Type", "application/json; charset=utf-8"); fail(res, "response-limit"); return false; }
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(res.req.method === "HEAD" ? undefined : body);
  return true;
}

/**
 * The launcher owns a fresh 32-byte HttpOptions.secret and its private lockfile.
 * Nonces and independent cookies exist only in this server instance. Cookies last
 * until browser/session, idle expiry or server shutdown. A port-qualified name prevents
 * collisions, not exposure to another service on the same loopback hostname.
 */
export async function startUsageHttpServer(options: HttpOptions): Promise<{ pid: number; port: number; close(): Promise<void> }> {
  const now = options.now ?? Date.now;
  // A random instance secret binds lookups even if options.instanceId and clocks are reused.
  const instanceKey = randomBytes(32);
  const hash = (value: string) => createHmac("sha256", instanceKey).update(value).digest("hex");
  let port = 0;
  let reader = options.reader;
  let lastOpenAt = -Infinity;
  let unavailableCode: keyof typeof errors = "ledger-unavailable";
  const fallbackStatus = (): DashboardStatus => {
    const state = options.ingestStatus?.();
    const last = state?.lastIngestAt;
    const lastIngestAt = typeof last === "number" && Number.isSafeInteger(last) && last >= 0 ? last : null;
    const allowedCodes = ["usage-ingest-failed", "usage-ingest-lease-lost", "usage-ingest-lease-busy", "usage-ledger-unavailable"];
    return { serverBuild: options.serverBuild, schemaVersion: 0, rateVersions: COPILOT_RATE_VERSIONS.map(rate => rate.id),
      calls: 0, sources: 0, parseErrors: 0, sourceErrors: 0,
      ingest: { role: state?.role ?? "inactive", backfill: state?.backfill ?? "pending", lastIngestAt,
        errorCode: state?.errorCode ? allowedCodes.includes(state.errorCode) ? state.errorCode : "usage-ingest-failed" : null,
        ageMs: lastIngestAt === null ? null : Math.max(0, now() - lastIngestAt),
        stale: lastIngestAt === null || now() < lastIngestAt || now() - lastIngestAt > 120_000 },
      counter: { ts: null, creditsUsed: null, entitlement: null, remaining: null, resetDate: null, ageMs: null,
        availability: "unavailable", nextPollAt: null } };
  };
  const statusEnvelope = () => {
    const timestamp = now();
    const date = new Date(timestamp);
    return { apiVersion: 1, revision: `${options.instanceId}:unavailable`, generatedAt: timestamp,
      period: { start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), end: timestamp }, data: reader?.status() ?? fallbackStatus() };
  };
  const nonces = new Map<string, { value: string; issuedAt: number }>();
  const sessions = new Map<string, { value: string; lastUsedAt: number }>();
  let authenticatedRequests: number[] = [];
  let unauthenticatedRequests: number[] = [];
  let crossSiteRequests: number[] = [];
  const securityHeaders = usageSecurityHeaders(options.html);
  const idleMs = options.idleMs ?? 1_800_000;
  const sweepCredentials = () => {
    const timestamp = now();
    for (const [key, record] of nonces) if (timestamp < record.issuedAt || timestamp >= record.issuedAt + 60_000) nonces.delete(key);
    for (const [key, record] of sessions) if (timestamp < record.lastUsedAt || timestamp >= record.lastUsedAt + idleMs) sessions.delete(key);
  };
  const sweepTimer = setInterval(sweepCredentials, 1000);
  sweepTimer.unref();
  const requireSession = (req: IncomingMessage) => {
    sweepCredentials();
    const cookies = req.headers.cookie?.split(";").map(value => value.trim()).filter(value => value.startsWith(`spider_usage_${port}=`)) ?? [];
    const credential = cookies.length === 1 ? cookies[0]!.slice(`spider_usage_${port}=`.length) : undefined;
    const session = credential ? sessions.get(hash(credential)) : undefined;
    return session && equalCredential(credential, session.value) ? session : undefined;
  };
  let deadline = now() + idleMs;
  let idleTimer: ReturnType<typeof setTimeout>;
  let closePromise: Promise<void> | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (now() >= deadline) void close().catch(() => {});
      else armIdle();
    }, Math.max(1, deadline - now()));
    idleTimer.unref();
  };
  const activity = () => { deadline = now() + idleMs; armIdle(); };
  const server = createServer({ headersTimeout: 5000, requestTimeout: 10_000, keepAliveTimeout: 2000,
    connectionsCheckingInterval: 1000, maxHeaderSize: 16_384 }, (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);
    const target = parseUsageTarget(req.url);
    const credentialRoute = target?.pathname === "/bootstrap" || target?.pathname === "/local/bootstrap-nonce";
    const session = credentialRoute ? undefined : requireSession(req);
    // A live nonce is a credential. Check its instance-local record without sweeping either store.
    const bootstrapValue = target?.pathname === "/bootstrap" ? target.searchParams.get("nonce") : undefined;
    const bootstrapRecord = bootstrapValue ? nonces.get(hash(bootstrapValue)) : undefined;
    const liveBootstrap = bootstrapRecord && equalCredential(bootstrapValue!, bootstrapRecord.value) &&
      now() >= bootstrapRecord.issuedAt && now() < bootstrapRecord.issuedAt + 60_000;
    // Rejected browser traffic has its own bounded window, never owner admission.
    if (!hasSafeBrowserMetadata(req, port, target?.pathname ?? "")) {
      crossSiteRequests = crossSiteRequests.filter(timestamp => timestamp > now() - 60_000);
      if (crossSiteRequests.length >= 120) { fail(res, "rate-limited"); return; }
      crossSiteRequests.push(now());
    } else if (!session && !liveBootstrap && !(target?.pathname === "/local/bootstrap-nonce" && hasMintBearer(req, options.secret))) {
      unauthenticatedRequests = unauthenticatedRequests.filter(timestamp => timestamp > now() - 60_000);
      if (unauthenticatedRequests.length >= 120) { fail(res, "rate-limited"); return; }
      unauthenticatedRequests.push(now());
    }
    if (!target) { fail(res, "invalid-query"); return; }
    if (!validateTransport(req, port, target.pathname)) { fail(res, "forbidden"); return; }
    // Authenticate all non-credential paths, including unknown paths, before method/query disclosure.
    if (!credentialRoute && !session) { fail(res, "unauthorized"); return; }
    if (req.method !== "GET" && req.method !== "HEAD") { fail(res, "method-not-allowed", target.pathname); return; }
    try {
      if (Buffer.byteLength(target.search.slice(1)) > 8192) throw new DashboardQueryError("invalid-query");
      const keys = [...target.searchParams.keys()];
      validateParams(target.searchParams, keys);
    } catch { fail(res, "invalid-query"); return; }
    if ((target.pathname === "/local/bootstrap-nonce" || target.pathname === "/bootstrap") && req.method === "HEAD") {
      fail(res, "method-not-allowed", target.pathname); return;
    }
    if (target.pathname === "/local/bootstrap-nonce") {
      if (isBrowserMint(req)) { fail(res, "forbidden"); return; }
      if (!hasMintBearer(req, options.secret)) { fail(res, "unauthorized"); return; }
      if (target.search) { fail(res, "invalid-query"); return; }
      sweepCredentials();
      if (nonces.size >= 64) { fail(res, "rate-limited"); return; }
      const timestamp = now();
      const date = new Date(timestamp);
      const nonce = randomBytes(32).toString("base64url");
      nonces.set(hash(nonce), { value: nonce, issuedAt: timestamp });
      send(res, JSON.stringify({ apiVersion: 1, revision: `${options.instanceId}:bootstrap`, generatedAt: timestamp,
        period: { start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), end: timestamp }, data: { nonce } }), 8192); return;
    }
    if (target.pathname === "/bootstrap") {
      const query = target.searchParams;
      if ([...query.keys()].length !== 1 || !query.get("nonce") || !query.has("nonce")) { fail(res, "invalid-query"); return; }
      sweepCredentials();
      const value = query.get("nonce")!;
      const record = nonces.get(hash(value));
      if (!record || !equalCredential(value, record.value) || now() < record.issuedAt || now() >= record.issuedAt + 60_000) {
        if (record) nonces.delete(hash(value));
        fail(res, "unauthorized"); return;
      }
      nonces.delete(hash(value)); // Synchronous consumption happens before any response or await.
      const existing = requireSession(req);
      if (existing) {
        existing.lastUsedAt = now();
      } else {
        if (sessions.size >= 32) {
          let oldest: string | undefined;
          let oldestAt = Infinity;
          for (const [key, record] of sessions) {
            if (record.lastUsedAt < oldestAt) { oldest = key; oldestAt = record.lastUsedAt; }
          }
          if (oldest !== undefined) sessions.delete(oldest);
        }
        const session = randomBytes(32).toString("base64url");
        sessions.set(hash(session), { value: session, lastUsedAt: now() });
        res.setHeader("Set-Cookie", `spider_usage_${port}=${session}; HttpOnly; SameSite=Strict; Path=/`);
      }
      res.setHeader("Content-Length", 0);
      res.writeHead(303, { Location: "/" });
      res.end(); activity(); return;
    }
    // Backup for the early shared cookie gate; every data route still requires a session.
    if (!session) { fail(res, "unauthorized"); return; }
    authenticatedRequests = authenticatedRequests.filter(timestamp => timestamp > now() - 60_000);
    if (authenticatedRequests.length >= 600) { fail(res, "rate-limited"); return; }
    authenticatedRequests.push(now());
    session.lastUsedAt = now();
    if (target.pathname === "/") {
      if (target.search) { fail(res, "invalid-query"); return; }
      res.setHeader("Content-Type", "text/html; charset=utf-8"); if (send(res, options.html, 512 * 1024)) activity(); return;
    }
    const route = options.routes.find(route => route.path === target.pathname);
    if (route) {
      try {
        const allowed = routeParams[target.pathname];
        if (allowed) validateParams(target.searchParams, allowed);
        if (target.searchParams.has("limit") || target.searchParams.has("cursor")) parsePage(target.searchParams);
        if (target.searchParams.has("start") || target.searchParams.has("end") || target.searchParams.has("filters")) {
          const sliceParams = new URLSearchParams();
          for (const key of ["start", "end", "filters"]) if (target.searchParams.has(key)) sliceParams.set(key, target.searchParams.get(key)!);
          if (route.resolvePeriod) route.resolvePeriod(target.searchParams, now());
          else parseSlice(sliceParams, now());
        }
        if (target.pathname === "/api/status") validateParams(target.searchParams, []);
        if (!reader && options.retryOpenReader && now() - lastOpenAt >= 5000) {
          lastOpenAt = now();
          try { reader = options.retryOpenReader(); unavailableCode = "ledger-unavailable"; }
          catch (error) { unavailableCode = error instanceof DashboardQueryError ? error.code : "internal"; }
        }
        if (!reader) {
          if (target.pathname === "/api/status") send(res, JSON.stringify(statusEnvelope()), 8192);
          else fail(res, unavailableCode);
          return;
        }
        const envelope = reader.snapshot(ctx => {
          const timestamp = ctx.now();
          const date = new Date(timestamp);
          return { apiVersion: 1, revision: ctx.revision, generatedAt: timestamp,
            period: route.resolvePeriod?.(target.searchParams, timestamp) ?? { start: target.searchParams.has("start") ? Number(target.searchParams.get("start")) : Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
              end: target.searchParams.has("end") ? Number(target.searchParams.get("end")) : timestamp },
            data: route.handle(ctx, target.searchParams) };
        });
        if (send(res, JSON.stringify(envelope), (responseCaps[target.pathname] ?? 1024) * 1024) && target.pathname !== "/api/status") activity();
        return;
      } catch (error) {
        const code = error instanceof DashboardQueryError && Object.hasOwn(errors, error.code) ? error.code as keyof typeof errors : "internal";
        if (target.pathname === "/api/status" && code === "ledger-unavailable") {
          try { send(res, JSON.stringify(statusEnvelope()), 8192); } catch { fail(res, "internal"); }
        } else fail(res, code);
        return;
      }
    }
    fail(res, "not-found");
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(10_000, socket => socket.destroy());
  server.on("connect", (_req, socket) => {
    const body = JSON.stringify({ apiVersion: 1, error: { code: "invalid-query", message: "Invalid query" } });
    const headers = Object.entries(securityHeaders).map(([name, value]) => `${name}: ${value}`).join("\r\n");
    socket.end(`HTTP/1.1 400 Bad Request\r\n${headers}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  });
  server.on("clientError", (error, socket) => {
    if (!socket.writable || (error as NodeJS.ErrnoException).code === "ERR_HTTP_REQUEST_TIMEOUT" ||
      !(error as Error & { rawPacket?: Buffer }).rawPacket?.length) { socket.destroy(); return; }
    const body = JSON.stringify({ apiVersion: 1, error: { code: "invalid-query", message: "Invalid query" } });
    const headers = Object.entries(securityHeaders).map(([name, value]) => `${name}: ${value}`).join("\r\n");
    const head = (error as Error & { rawPacket?: Buffer }).rawPacket?.subarray(0, 5).toString() === "HEAD ";
    socket.end(`HTTP/1.1 400 Bad Request\r\n${headers}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${head ? "" : body}`);
  });
  const close = (): Promise<void> => closePromise ??= (async () => {
    clearTimeout(idleTimer);
    clearInterval(sweepTimer);
    await new Promise<void>((resolve, reject) => {
      const force = setTimeout(() => server.closeAllConnections(), USAGE_HTTP_DRAIN_MS);
      force.unref();
      server.close(error => { clearTimeout(force); if (error) reject(error); else resolve(); });
      server.closeIdleConnections();
    });
    try { await options.onClose?.(); } finally { reader?.close(); nonces.clear(); sessions.clear(); }
  })();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  port = (server.address() as import("node:net").AddressInfo).port;
  armIdle();
  return { pid: process.pid, port, close };
}
