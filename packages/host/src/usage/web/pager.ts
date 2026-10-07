import type { Period } from "../dashboard-contract.js";
import { action, element, liveMessage } from "./dom.js";
import { canRetry, DashboardClientError, errorCopy } from "./client.js";

export interface AnalysisPager {
  readonly region: HTMLElement;
  readonly content: HTMLElement;
  request(params: URLSearchParams): Period | undefined;
  accept(period: Period, next: string | null, clearFailed?: boolean): void;
  reset(): void;
  recover(error: unknown): boolean;
  busy(announce: boolean, clearStatus?: boolean, preserveFocus?: boolean): void;
  notice(message: string, announce: boolean): void;
  complete(at: number, announce: boolean): void;
  fail(error: unknown, announce: boolean): void;
  cancel(error?: unknown): void;
}

/** Task 11-only keyset pager for one paged list per endpoint. Multi-list endpoints
 * use one pager per list; mountAnalysis owns their joint request/recovery protocol.
 * Explorer and Detail keep their independently reviewed paging.
 * Keep region/content mounted; replace only content.
 * request writes the cursor and returns its server-pinned period (if any).
 * A paged lane pins the joint request, including summary and compatible page-1
 * lanes. Retry may therefore show data from an older period under the current
 * rolling-period header. Incompatible pinned lanes keep their evidence unchanged.
 * accept commits response period/next cursor; clearFailed=false preserves another
 * lane's failed Retry target and its pin. reset clears content for a fresh page 1.
 * recover invalid/stale cursor errors before retrying a request, never that cursor.
 * busy/complete/fail own announcements, Retry policy and focus. Refresh uses request
 * without reset. onLoad is called only for enabled user actions, never while busy.
 */
export function createPager(document: Document, options: { title: string; param: string; clearFilters?: () => void; onLoad(): void }): AnalysisPager {
  const region = element(document, "section"), heading = element(document, "h2", options.title);
  heading.setAttribute("tabindex", "-1");
  const content = element(document, "div", undefined, "overview-evidence"), status = liveMessage(document);
  const stamp = element(document, "p", "", "muted numeric"), controls = element(document, "div", undefined, "view-actions");
  let cursor: string | undefined, pinned: Period | undefined, nextCursor: string | null = null;
  const previous: (string | undefined)[] = [];
  let loading = false, recoveryNotice = false, retryable = false, preserveFocus = false;
  type Position = { cursor: string | undefined; pinned?: Period; previous: (string | undefined)[] };
  let committed: Position = { cursor: undefined, previous: [] }, failed: Position | undefined;
  const position = (): Position => ({ cursor, pinned: pinned ? { ...pinned } : undefined, previous: [...previous] });
  function restore(value: Position): void { cursor = value.cursor; pinned = value.pinned; previous.splice(0, previous.length, ...value.previous); }
  const back = action(document, "Previous page", () => {
    if (loading || !previous.length) return;
    cursor = previous.pop(); options.onLoad();
  });
  const forward = action(document, "Next page", () => {
    if (loading || !nextCursor) return;
    previous.push(cursor); cursor = nextCursor; options.onLoad();
  });
  const retry = action(document, "Retry", () => {
    if (loading || retry.hidden) return;
    if (failed) restore(failed);
    options.onLoad();
  });
  const clearFilters = action(document, "Clear filters", () => { if (!loading && !clearFilters.hidden) options.clearFilters?.(); });
  clearFilters.hidden = true;
  retry.hidden = true;
  controls.setAttribute("role", "group"); controls.setAttribute("aria-label", `${options.title} pages`);
  controls.append(back, forward, retry, clearFilters); region.append(heading, content, status, stamp, controls);
  function updateControls(): void {
    // aria-disabled preserves a focused button in the tab order during a load.
    back.setAttribute("aria-disabled", String(loading || !previous.length));
    forward.setAttribute("aria-disabled", String(loading || !nextCursor));
    for (const button of [back, forward]) button.setAttribute("aria-busy", String(loading));
    content.setAttribute("aria-busy", String(loading));
  }
  function reset(): void { cursor = undefined; pinned = undefined; nextCursor = null; previous.length = 0; committed = position(); failed = undefined; retryable = false; content.replaceChildren(); updateControls(); }
  updateControls();
  return {
    region, content,
    request(params: URLSearchParams): Period | undefined {
      if (cursor) { params.set(options.param, cursor); return pinned; }
      return undefined;
    },
    accept(period: Period, next: string | null, clearFailed = true): void { pinned = { ...period }; nextCursor = next; committed = position(); if (clearFailed) { failed = undefined; retryable = false; } },
    reset,
    recover(error: unknown): boolean {
      if (!cursor || !(error instanceof DashboardClientError) || !["invalid-query", "ledger-changed"].includes(error.code)) return false;
      reset(); recoveryNotice = true;
      return true;
    },
    notice(message: string, announce: boolean): void {
      recoveryNotice = true;
      if (announce) status.textContent = message;
    },
    busy(announce: boolean, clearStatus = false, retainFocus = false): void {
      loading = true; preserveFocus = retainFocus;
      if (!preserveFocus && (document.activeElement === retry || document.activeElement === clearFilters)) heading.focus();
      if (!preserveFocus || document.activeElement !== clearFilters) clearFilters.hidden = true;
      if (!preserveFocus || document.activeElement !== retry) retry.hidden = true;
      if (clearStatus) status.textContent = "";
      if (announce && !recoveryNotice) status.textContent = "Loading usage";
      updateControls();
    },
    complete(at: number, announce: boolean): void {
      loading = false; stamp.textContent = `${recoveryNotice && !announce ? "Page link no longer valid. Showing page 1. " : ""}Updated ${new Date(at).toISOString()}`;
      if (announce && !recoveryNotice) status.textContent = "Usage updated.";
      recoveryNotice = false;
      if (!failed || !retryable) { if (document.activeElement === retry) heading.focus(); retry.hidden = true; }
      else retry.hidden = false;
      updateControls();
    },
    fail(error: unknown, announce: boolean): void {
      failed = position(); restore(committed);
      loading = false;
      if (announce) status.textContent = errorCopy(error, options);
      else { status.textContent = ""; stamp.textContent = errorCopy(error, options); }
      clearFilters.hidden = !(error instanceof DashboardClientError && error.code === "unknown-filter-id" && options.clearFilters);
      retryable = canRetry(error); retry.hidden = !retryable;
      recoveryNotice = false; updateControls();
    },
    cancel(error?: unknown): void {
      restore(committed); loading = false; status.textContent = ""; retry.hidden = !failed || !retryable;
      if (error !== undefined) stamp.textContent = retry.hidden ? errorCopy(error, options).replace(/ Retry\.$/, "") : errorCopy(error, options);
      updateControls();
    },
  };
}
