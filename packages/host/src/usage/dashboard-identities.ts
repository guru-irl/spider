import { DIMENSION_COLUMNS } from "./dimension-values.js";
import { createHmac, randomBytes } from "node:crypto";
import { constants, openSync, closeSync, readFileSync, writeFileSync, linkSync, unlinkSync, fstatSync, fchmodSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { sep, posix, win32 } from "node:path";
import { DashboardQueryError, type Dimension, type DashboardQueryContext, type Period, type Filter } from "./dashboard-contract.js";

export const opaqueId = (value: unknown): value is string => typeof value === "string" && /^v1_[A-Za-z0-9_-]{43}$/.test(value);
export const supportedDetailId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const detailDimension = (field: Dimension) => field === "session" || field === "run";
export const identityColumns: Readonly<Record<Dimension, string>> = DIMENSION_COLUMNS;
function normalizedHome(): string {
  let home = homedir();
  try { home = realpathSync(home); } catch { /* A missing home still has a safe lexical boundary. */ }
  return home.replace(/[\\/]+$/, "");
}
function pathLabel(value: string, home: string): string {
  const compare = process.platform === "win32" ? value.toLowerCase() : value;
  const base = process.platform === "win32" ? home.toLowerCase() : home;
  if (compare === base || compare.startsWith(base + sep)) return "~" + value.slice(home.length);
  return "…/" + value.split(/[\\/]+/).filter(Boolean).slice(-2).join("/");
}
/** Presentation only. Never use labels as filesystem inputs or query identities. */
export function dashboardLabel(field: Dimension, value: string | null, home: string = normalizedHome()): string | null {
  if (value === null) return null;
  if (detailDimension(field)) return supportedDetailId(value) ? value : "unsupported id";
  const hasHome = home !== "" && !/^(?:[\\/]+|[A-Za-z]:[\\/]*)$/.test(home);
  const normalizedLabel = (path: string): string => {
    if (path === "~") path = hasHome ? home : "";
    if (path.startsWith("~/")) path = hasHome ? home + path.slice(1) : path.slice(2);
    const windows = /^[A-Za-z]:|^\\\\|^\/\//.test(path), syntax = windows ? win32 : posix;
    const normalized = syntax.normalize(path), base = syntax.normalize(home);
    const compare = windows ? normalized.toLowerCase() : normalized;
    const homeCompare = windows ? base.toLowerCase() : base;
    if (hasHome && syntax.isAbsolute(normalized) && (compare === homeCompare || compare.startsWith(homeCompare.replace(/[\\/]+$/, "") + syntax.sep))) {
      return "~/" + normalized.slice(base.replace(/[\\/]+$/, "").length).replace(/^[\\/]+/, "").replaceAll("\\", "/");
    }
    // Only real segments survive relative/upward paths, even after normalization.
    const segments = normalized.replace(/^[A-Za-z]:/, "").split(/[\\/]+/).filter(part => part && part !== "." && part !== "..");
    return pathLabel(segments.join("/"), "/");
  };
  // Path-valued dimensions may contain whitespace in any segment.
  if ((field === "project" || field === "repo") && /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/]|\\\\)/.test(value)) {
    return [...normalizedLabel(value)].slice(0, 160).join("");
  }
  // Keep the file: prefix intact, and include common embedded-path delimiters.
  value = value.replace(/(^|file:|[\s=\[\]`,'"(])((?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/]|~\/)[^\s\]`,'")<>]*)/g,
    (_match, before: string, path: string) => before + normalizedLabel(path));
  return [...value].slice(0, 160).join("");
}
const initialized = new WeakMap<DashboardQueryContext["db"], { key: (field: Dimension, value: string | null) => string | null;
  revision?: string; lookups: Map<string, Map<string, string>> }>();
const identityFailures = new WeakMap<DashboardQueryContext["db"], number>();
const unavailable = (): never => { throw new DashboardQueryError("identity-unavailable"); };
const ignoreCleanup = (cleanup: () => void) => { try { cleanup(); } catch { /* Never mask the original failure. */ } };
function readSalt(file: string): Buffer {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number | undefined;
  try {
    try { fd = openSync(file, flags); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = file + "." + randomBytes(12).toString("hex");
      let output: number | undefined;
      try {
        output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        // Explicitly restore owner bits even under a restrictive umask.
        fchmodSync(output, 0o600);
        writeFileSync(output, randomBytes(32));
        closeSync(output); output = undefined;
        try { linkSync(temporary, file); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure; }
      } finally {
        if (output !== undefined) ignoreCleanup(() => closeSync(output!));
        ignoreCleanup(() => unlinkSync(temporary));
      }
      fd = openSync(file, flags);
    }
    let info = fstatSync(fd);
    // Exclusive publication briefly leaves the creator's temporary name linked.
    // Reopen a few times, sleeping between checks, then still require nlink=1.
    // Never turn a persistent hardlink into an accepted salt or spin the CPU.
    const deadline = performance.now() + 100;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (info.isFile() && info.nlink === 2 && performance.now() < deadline) {
      closeSync(fd); fd = undefined;
      Atomics.wait(wait, 0, 0, Math.min(10, Math.max(0, deadline - performance.now())));
      fd = openSync(file, flags); info = fstatSync(fd);
    }
    if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid()) ||
      (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) || info.size !== 32) unavailable();
    const salt = readFileSync(fd);
    if (salt.length !== 32) unavailable();
    return salt;
  } catch { return unavailable(); }
  finally { if (fd !== undefined) ignoreCleanup(() => closeSync(fd!)); }
}
/** Task 6 owns the shared per-ledger identity helper used by all dashboard views.
 * Publish a complete 0600 salt by exclusive hard link, never replace unsafe salts.
 * SQL must invoke explorer_id only AFTER grouping. The memo hashes each distinct
 * field/value once per connection, not once per counted row or pivot tuple.
 */
export function initializeIds(ctx: DashboardQueryContext): void {
  if (initialized.has(ctx.db)) return;
  const file = ctx.db.raw.name + ".explorer-salt";
  if ((identityFailures.get(ctx.db) ?? 0) > Date.now()) unavailable();
  let salt: Buffer;
  try { salt = readSalt(file); }
  catch (error) { identityFailures.set(ctx.db, Date.now() + 5000); throw error; }
  identityFailures.delete(ctx.db);
  const memo = new Map<string, string>();
  const key = (field: Dimension, value: string | null): string | null => {
    if (value === null) return null;
    if (detailDimension(field)) return supportedDetailId(value) ? value : null;
    const input = JSON.stringify([field, value]);
    let id = memo.get(input);
    if (!id) { id = "v1_" + createHmac("sha256", salt).update(input).digest("base64url"); memo.set(input, id); }
    return id;
  };
  const home = normalizedHome();
  ctx.db.raw.function("explorer_id", { deterministic: true }, key);
  ctx.db.raw.function("explorer_label", { deterministic: true }, (field: Dimension, value: string | null) => dashboardLabel(field, value, home));
  ctx.db.raw.function("explorer_fold", { deterministic: true }, (value: string | null) => value === null ? null : value.toLowerCase());
  ctx.db.raw.function("explorer_detail_key", { deterministic: true }, (value: string | null) => value === null ? null : supportedDetailId(value) ? value : "");
  initialized.set(ctx.db, { key, lookups: new Map() });
}
export function dashboardKey(ctx: DashboardQueryContext, field: Dimension, value: string | null): string | null {
  initializeIds(ctx); return initialized.get(ctx.db)!.key(field, value);
}
/** Resolve explicit ids, never guess from their shape. A range-indexed DISTINCT
 * cache is scoped to the snapshot revision and period. Uncounted stored values
 * may resolve but still cannot bypass counted selection. No all-time calls scan.
 */
/** Typeahead alone batches dictionary misses, keeping its request cap at two SELECTs. */
export function primeFilterIds(ctx: DashboardQueryContext, filters: readonly Filter[], period: Period): void {
  const fields = [...new Set(filters.filter(filter => filter.kind === "id" && filter.value !== null && !detailDimension(filter.field)).map(filter => filter.field))];
  if (!fields.length) return;
  initializeIds(ctx);
  const state = initialized.get(ctx.db)!;
  if (state.revision !== ctx.revision) { state.lookups.clear(); state.revision = ctx.revision; }
  const missing = fields.filter(field => !state.lookups.has(JSON.stringify([field, period.start, period.end])));
  if (!missing.length) return;
  const sql = missing.map(field => {
    const column = field === "day" ? "strftime('%Y-%m-%d', c.ts / 1000, 'unixepoch')" : `c.${identityColumns[field]}`;
    return `SELECT DISTINCT '${field}' AS field, ${column} AS value FROM calls c INDEXED BY calls_period_read WHERE c.ts >= ? AND c.ts < ? AND ${column} IS NOT NULL`;
  }).join(" UNION ALL ");
  const rows = ctx.db.prepare(sql).all(...missing.flatMap(() => [period.start, period.end])) as { field: Dimension; value: string }[];
  for (const field of missing) {
    const lookup = new Map(rows.filter(row => row.field === field).map(row => [state.key(field, row.value)!, row.value]));
    if (state.lookups.size >= 32) state.lookups.delete(state.lookups.keys().next().value!);
    state.lookups.set(JSON.stringify([field, period.start, period.end]), lookup);
  }
}
export function resolveFilterId(ctx: DashboardQueryContext, field: Dimension, id: string, period: Period): string {
  if (detailDimension(field)) {
    if (!supportedDetailId(id)) throw new DashboardQueryError("unknown-filter-id");
    return id;
  }
  initializeIds(ctx);
  const state = initialized.get(ctx.db)!;
  if (state.revision !== ctx.revision) { state.lookups.clear(); state.revision = ctx.revision; }
  const cacheKey = JSON.stringify([field, period.start, period.end]);
  let lookup = state.lookups.get(cacheKey);
  if (!lookup) {
    const column = field === "day" ? "strftime('%Y-%m-%d', c.ts / 1000, 'unixepoch')" : `c.${identityColumns[field]}`;
    const rows = ctx.db.prepare(`SELECT DISTINCT ${column} AS value FROM calls c INDEXED BY calls_period_read WHERE c.ts >= ? AND c.ts < ? AND ${column} IS NOT NULL`)
      .all(period.start, period.end) as { value: string }[];
    lookup = new Map(rows.map(row => [state.key(field, row.value)!, row.value]));
    // Bound retained windows, without ever falling back to a per-row HMAC predicate.
    if (state.lookups.size >= 32) state.lookups.delete(state.lookups.keys().next().value!);
    state.lookups.set(cacheKey, lookup);
  }
  const value = lookup.get(id);
  if (value === undefined) throw new DashboardQueryError("unknown-filter-id");
  return value;
}
