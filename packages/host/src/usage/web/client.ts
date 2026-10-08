import { supportedDetailId } from "./detail-id.js";
import type { ApiEnvelope, ApiErrorCode } from "../dashboard-contract.js";
export interface DashboardClient {
  get<T>(path: string, params: URLSearchParams, signal: AbortSignal): Promise<ApiEnvelope<T>>;
}
export class DashboardClientError extends Error {
  constructor(readonly code: ApiErrorCode | "server-unavailable" | "timeout") { super(code); }
}
export function canRetry(error: unknown): boolean {
  return !(error instanceof DashboardClientError && ["unknown-filter-id", "identity-unavailable", "invalid-query", "ledger-changed", "not-found"].includes(error.code));
}
/** Stop automatic refresh independently of the displayed recovery copy. */
export function shouldStopPolling(error: unknown): boolean {
  return !canRetry(error) || (error instanceof DashboardClientError && ["server-unavailable", "unauthorized"].includes(error.code));
}
const paths = new Set(["/api/status", "/api/overview", "/api/sessions", "/api/calibration"]);
function allowed(path: string): boolean {
  if (paths.has(path)) return true;
  if (!path.startsWith("/api/session/")) return false;
  try { return supportedDetailId(decodeURIComponent(path.slice(13))); } catch { return false; }
}
const codes = new Set<ApiErrorCode>(["unknown-filter-id", "identity-unavailable", "invalid-query", "ledger-changed", "not-found", "ledger-unavailable", "unsupported-schema", "busy", "unauthorized", "forbidden", "method-not-allowed", "response-limit", "rate-limited", "internal"]);
export function errorCopy(error: unknown, actions?: { clearFilters?: () => void }): string {
  const code = error instanceof DashboardClientError ? error.code : "internal";
  if (code === "not-found") return "Session not found";
  if (code === "server-unavailable" || code === "unauthorized") return "Run /usage again";
  if (code === "unknown-filter-id") return actions?.clearFilters
    ? "Selected filter is no longer available. Clear filters to continue."
    : "Selected filter is no longer available. Remove the unknown filter from the address to continue.";
  if (code === "identity-unavailable") return "Usage identity unavailable. Remove the ledger's explorer-salt file if it is unusable and wait five seconds, then refresh. Opaque filter bookmarks must be rebuilt.";
  if (code === "invalid-query") return "Invalid usage query or cursor. Refresh to start a new page.";
  if (code === "ledger-changed") return "Usage changed. Refresh to start a new page.";
  if (code === "ledger-unavailable") return "Usage ledger unavailable. Retry after ingestion starts.";
  if (code === "unsupported-schema") return "Usage ledger needs a supported schema. Run /doctor.";
  if (code === "busy" || code === "rate-limited" || code === "timeout") return "Usage is temporarily unavailable. Retry.";
  return "Could not load usage. Retry.";
}
export function createDashboardClient(fetcher: typeof fetch = globalThis.fetch): DashboardClient {
  return { async get<T>(path: string, params: URLSearchParams, signal: AbortSignal): Promise<ApiEnvelope<T>> {
    const query = params.toString();
    if (!allowed(path) || query.length > 8192) throw new DashboardClientError("invalid-query");
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10000);
    try {
      const response = await fetcher(path + (query ? `?${query}` : ""), { method: "GET", credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const body = await response.json();
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!response.ok) throw new DashboardClientError(codes.has(body?.error?.code) ? body.error.code : "internal");
      if (body?.apiVersion !== 1 || typeof body.revision !== "string" || !body.period || !Number.isFinite(body.generatedAt) || !("data" in body)) throw new DashboardClientError("internal");
      return body as ApiEnvelope<T>;
    } catch (error) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (timedOut) throw new DashboardClientError("timeout");
      if (error instanceof DashboardClientError) throw error;
      throw new DashboardClientError("server-unavailable");
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  } };
}
