import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseTranscript, type ParsedCall, type ParsedSource, type SourceInfo as ParserSource } from "./parse.js";
import { UsageJsonLine } from "./jsonl-projection.js";
import { SessionMetadataCapture, forgetSessionMetadata } from "./session-metadata.js";
import { normalizeRunStatus } from "./ledger.js";
import type { Discovery, SourceInfo } from "./discovery.js";
import type {
  CallRow, CoverageEdge, ImportBatch, ImportState, LedgerHealth, RunMeta,
  UsageLedger, SourceContext, PendingReport, SessionMeta,
} from "./ledger.js";

export type IngestOptions = {
  /** Full discovery is retained for attribution; only these sources are scanned. */
  sourcePaths?: readonly string[];
  maxBytes?: number;
  /** Batched workers publish diagnostics once, not once per slice. */
  skipHealth?: boolean;
  /** Shared discovery facts and DB-only auxiliary events run once per cycle. */
  skipShared?: boolean;
  commitGuard?: () => boolean;
  /** Notify a worker only after a fenced batch committed new calls. */
  onCallsAdded?: () => void;
};
const CHUNK = 64 * 1024;
const PREFIX = 4096;
// These are direct UsageSinkFactory purposes, not arbitrary pi UsageEntry kinds.
const AUX_PURPOSES = new Set(["memory-review", "skill-review", "learner", "skill-curate"]);
type Line = {
  byteOffset: number;
  json: unknown;
};
type Scan = {
  parsed: ParsedSource;
  lines: Line[];
  resume: number;
  reset: boolean;
  header: Record<string, unknown> | undefined;
  state: ImportState;
  context: SourceContext;
  partial: boolean;
  session: SessionMeta | null;
};
type Report = {
  runId: string;
  owner: string | null;
  path: string;
  ts: number;
};
type Memory = {
  reports: Report[];
  edges: CoverageEdge[];
  contexts: Map<string, string>;
};
const headerCache = new WeakMap<UsageLedger, Map<string, { stamp: string; header: Record<string, unknown> | null }>>();
const retained = new WeakMap<UsageLedger, Memory>();
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const errorCode = (error: unknown): string => text((error as {
  code?: unknown;
})?.code) ?? "source-read-error";
function parserSource(source: SourceInfo): ParserSource {
  return {
    ...source, run: source.run ? { ...source.run, sessionId: source.run.sessionId ?? "", agent: source.run.agent ?? "" } : null
  };
}

function cheap(entry: unknown): unknown {
  const record = object(entry);
  if (!text(record.type))
    return undefined;
  if (["session", "model_change", "thinking_level_change"].includes(String(record.type)))
    return record;
  // Retain identity, ancestry and role, never old usage or message content.
  return { type: "metadata", id: record.id, parentId: record.parentId, role: object(record.message).role };
}

function compact(entry: unknown): unknown {
  const record = object(entry);
  const pick = (input: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(k => k in input).map(k => [k, input[k]]));
  const result = pick(record, [
    "type", "id", "parentId", "timestamp", "cwd", "parentSession", "modelId",
    "thinkingLevel", "kind", "note", "usage", "provider", "model", "responseModel", "latencyMs", "api"
  ]);
  if (record.type === "message")
    result.message = pick(object(record.message), [
      "role", "timestamp",
      "provider", "model", "responseModel", "providerThinkingLevel", "responseId", "usage", "latencyMs", "api", "toolName"
    ]);
  return result;
}

function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function checkpoint(file: Awaited<ReturnType<typeof open>>, start: number, length: number) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, start);
  if (bytesRead !== length)
    throw Object.assign(new Error("short checkpoint"), { code: "source-changed" });
  return digest(buffer);
}

/** Only bounded checkpoints inspect committed bytes. The body starts at the cursor.
 * Prefix detects replacement; a bounded end checkpoint also detects truncation/regrowth
 * beyond an unchanged header, without hashing or parsing historical transcript bodies.
 */
async function readTranscript(
  source: SourceInfo, previous: ImportState | undefined,
  context: SourceContext | undefined, signal: AbortSignal, ledger: UsageLedger, maxBytes: number, sessions: ReadonlyMap<string, SessionMeta>,
): Promise<Scan | undefined> {
  const before = await stat(source.path);
  if (!before.isFile())
    throw Object.assign(new Error("not a file"), { code: "not-file" });
  const inode = `${before.dev}:${before.ino}`;
  if (previous && context && previous.inode === inode && previous.size === before.size
    && previous.mtimeMs === before.mtimeMs && previous.offset === before.size)
    return undefined;
  const file = await open(source.path, "r");
  try {
    let reset = !!previous && (previous.inode !== inode || before.size < previous.size || !context);
    if (previous && !reset) {
      const prefix = await checkpoint(file, 0, Math.min(PREFIX, previous.offset));
      const tail = await checkpoint(file, Math.max(0, previous.offset - PREFIX), Math.min(PREFIX, previous.offset));
      reset = prefix !== previous.prefixHash || tail !== context!.tailHash;
    }
    const resume = reset ? 0 : previous?.offset ?? 0;
    const oldId = context?.header?.id;
    const saved = reset || typeof oldId !== "string" ? null : sessions.get(oldId) ?? null;
    let capture: SessionMetadataCapture | undefined;
    const metadataCheckpoint = ledger.getMetadataCheckpoint(source.path);
    const coversPrefix = resume === 0 || !!metadataCheckpoint && metadataCheckpoint.generation === previous?.generation && metadataCheckpoint.offset >= resume;
    try { capture = new SessionMetadataCapture(source, saved, reset ? null : context?.header ?? null, { firstUserSeen: !coversPrefix }); } catch { /* optional metadata never blocks billing */ }
    const lines: Line[] = [];
    let readOffset = resume, committed = resume;
    let line = new UsageJsonLine(), metadataLine = new UsageJsonLine(true);
    let lineBytes = 0;
    const chunk = Buffer.alloc(CHUNK);
    while (readOffset < before.size && committed - resume < maxBytes) {
      if (signal.aborted)
        return undefined;
      const { bytesRead } = await file.read(chunk, 0, Math.min(CHUNK, before.size - readOffset), readOffset);
      if (!bytesRead)
        throw Object.assign(new Error("short read"), { code: "source-changed" });
      const data = chunk.subarray(0, bytesRead);
      readOffset += bytesRead;
      let start = 0, end: number;
      while ((end = data.indexOf(10, start)) !== -1) {
        const part = data.subarray(start, end + 1);
        line.write(part); metadataLine.write(part); lineBytes += part.length;
        const projected = line.finish();
        try { capture?.consume(metadataLine.finish(), committed); } catch { /* optional metadata never blocks billing */ }
        lines.push({ byteOffset: committed, json: projected === undefined ? undefined : compact(projected) });
        committed += lineBytes;
        start = end + 1;
        line = new UsageJsonLine(); metadataLine = new UsageJsonLine(true); lineBytes = 0;
        if (committed - resume >= maxBytes) break;
      }
      if (committed - resume >= maxBytes) break;
      if (start < data.length) {
        const part = data.subarray(start);
        line.write(part); metadataLine.write(part); lineBytes += part.length;
      }
    }
    const prefixHash = await checkpoint(file, 0, Math.min(PREFIX, committed));
    const tailHash = await checkpoint(file, Math.max(0, committed - PREFIX), Math.min(PREFIX, committed));
    const after = await file.stat(), named = await stat(source.path);
    // Appends after the snapshot are deliberately left for the next pass.
    if (after.size < before.size || named.ino !== before.ino || named.dev !== before.dev
      || after.size === before.size && after.mtimeMs !== before.mtimeMs) {
      throw Object.assign(new Error("source replaced while reading"), { code: "source-changed" });
    }
    const roots = lines.flatMap(l => {
      const entry = object(l.json);
      return [text(entry.id) ?? `offset:${l.byteOffset}`, ...(text(entry.parentId) ? [String(entry.parentId)] : [])];
    });
    const prefix = reset ? [] : ledger.getSourceContext(source.path, roots)?.entries ?? [];
    const seedHeader = !reset && context?.header ? [{ byteOffset: -1, json: context.header }] : [];
    const parsed = parseTranscript([...seedHeader, ...prefix, ...lines], parserSource(source));
    const header = lines.map(l => object(l.json)).find(e => e.type === "session") ?? (reset ? undefined : context?.header ?? undefined);
    const entries = lines.filter(l => text(object(l.json).type)).map(l => ({ ...l, json: cheap(l.json) }));
    let session: SessionMeta | null = null;
    try { capture?.activity(parsed.calls.map(call => call.ts)); session = await capture?.finish() ?? null; } catch { /* optional metadata never blocks billing */ }
    return {
      parsed, lines, resume, reset, header, session, partial: lineBytes > 0 || committed < before.size,
      context: { header: header ?? null, entries, tailHash },
      state: {
        path: source.path, inode, size: before.size, mtimeMs: before.mtimeMs, offset: committed,
        parseErrors: (reset ? 0 : previous?.parseErrors ?? 0) + parsed.errors.filter(e => e.byteOffset >= resume).length,
        generation: (previous?.generation ?? 0) + (reset ? 1 : 0), prefixHash
      }
    };
  }
  finally {
    await file.close();
  }
}

function row(call: ParsedCall, generation: number, copied = false, responseId: string | null = null): CallRow {
  const report = call.actor === "subagent" && call.aggregate && call.runId !== null;
  return {
    ...call, sourceGeneration: generation, counted: true, originKey: null, copied, responseId,
    sourceKind: report ? "report" : "transcript"
  };
}

/** Use persisted raw reports as proof provenance, not the selected/counting view.
 * This allows a worker restart, missing file, and generation invalidation to compose.
 */
function historical(ledger: UsageLedger): Memory {
  const memory = retained.get(ledger);
  return { ...ledger.getProof(), contexts: new Map(memory?.contexts) };
}

function reconcileProof(discovery: Discovery, memory: Memory, reports: Report[], runs: readonly RunMeta[], contexts: Map<string, string>) {
  const edges = new Map<string, CoverageEdge>();
  const key = (r: string, n: string) => JSON.stringify([r, n]);
  const pairs = new Map<string, {
    reportRunId: string;
    includedRunId: string;
  }>();
  const add = (r: string, n: string) => {
    if (r !== n)
      pairs.set(key(r, n), { reportRunId: r, includedRunId: n });
  };
  for (const edge of memory.edges)
    add(edge.reportRunId, edge.includedRunId);
  for (const run of runs)
    if (run.parentRunId)
      add(run.parentRunId, run.id);
  for (const report of reports)
    if (report.owner)
      add(report.owner, report.runId);
  const lookup = new Map(runs.map(r => [r.id, r]));
  const reportTime = new Map<string, number>();
  for (const report of reports)
    reportTime.set(report.runId, Math.min(reportTime.get(report.runId) ?? Infinity, report.ts));
  const states = new Map((discovery.runStates ?? []).map(s => [JSON.stringify([s.dbPath, s.id]), s]));
  const events = new Map<string, NonNullable<Discovery["runEvents"]>[number][]>();
  for (const event of discovery.runEvents ?? []) {
    const k = JSON.stringify([event.dbPath, event.runId]), list = events.get(k) ?? [];
    list.push(event);
    events.set(k, list);
  }
  const priorEdges = new Map(memory.edges.map(e => [key(e.reportRunId, e.includedRunId), e]));
  const transcriptPairs = new Set(reports.filter(r => r.owner).map(r => key(r.owner!, r.runId)));
  const unavailablePaths = new Set(discovery.errors.map(e => e.path));
  for (const [k, pair] of pairs) {
    let evidence: CoverageEdge["evidence"] = "unknown";
    const previous = priorEdges.get(k);
    const confirmingDb = lookup.get(pair.includedRunId)?.dbPath;
    const unavailable = confirmingDb && unavailablePaths.has(confirmingDb);
    if (previous?.evidence === "runs-db" && unavailable)
      evidence = "runs-db";
    if (transcriptPairs.has(k))
      evidence = "transcript";
    else if (evidence !== "runs-db") {
      const parent = lookup.get(pair.reportRunId), child = lookup.get(pair.includedRunId);
      const context = contexts.get(pair.reportRunId), time = reportTime.get(pair.reportRunId);
      const childKey = JSON.stringify([child?.dbPath, child?.id]), parentKey = JSON.stringify([parent?.dbPath, parent?.id]);
      const state = states.get(childKey), parentState = states.get(parentKey), childEvents = events.get(childKey) ?? [];
      const markers = childEvents.filter(e => e.type === "spider_usage_reported");
      const usage = childEvents.filter(e => e.type === "spider_usage");
      if (parent && child && parent.dbPath === child.dbPath && context && child.sessionId === context && time !== undefined
        && child.endedAt !== null && state && ["done", "failed", "cancelled"].includes(state.status ?? "")
        && state.childMode === "rpc" && parentState?.childMode === "rpc" && markers.length === 1 && usage.length > 0
        && markers[0].sessionId === context && child.endedAt <= markers[0].ts && markers[0].ts < time
        && usage.every(e => e.sessionId === context && e.ts <= markers[0].ts))
        evidence = "runs-db";
      else if (!context && priorEdges.get(k)?.evidence === "runs-db"
        && child && child.endedAt !== null && markers.length === 1 && time !== undefined && markers[0].ts < time
        && state && ["done", "failed", "cancelled"].includes(state.status ?? "")) {
        // File loss alone cannot disprove historical inclusion. A withdrawn marker can.
        evidence = "runs-db";
      }
    }
    edges.set(k, { ...pair, evidence });
  }
  // Every historical pair remains present. The evidence upsert itself withdraws
  // stale proof by replacing it with unknown; a removal list would be redundant.
  return { edges: [...edges.values()] };
}

/** Never throws into pi. Nothing is committed after cancellation or a failed apply.
 * All report model groups, generation resets, proof changes and cursors share one batch.
 */
export function ingestOnce(ledger: UsageLedger, discovery: Discovery, at: number, signal: AbortSignal, options: IngestOptions & { skipHealth: true }): Promise<undefined>;
export function ingestOnce(ledger: UsageLedger, discovery: Discovery, at: number, signal: AbortSignal, options?: IngestOptions & { skipHealth?: false }): Promise<LedgerHealth>;
export function ingestOnce(ledger: UsageLedger, discovery: Discovery, at: number, signal: AbortSignal, options?: IngestOptions): Promise<LedgerHealth | undefined>;
export async function ingestOnce(ledger: UsageLedger, discovery: Discovery, at: number, signal: AbortSignal, options: IngestOptions = {}): Promise<LedgerHealth | undefined> {
  const health = () => options.skipHealth ? undefined : ledger.health();
  if (signal.aborted)
    return health();
  const savedRuns = new Map(ledger.getRuns().map(r => [JSON.stringify([r.dbPath, r.id]), r]));
  const savedErrors = new Map(ledger.getSourceErrors().map(e => [e.path, e]));
  const sharedErrors = options.skipShared ? [] : discovery.errors.filter(e => JSON.stringify(savedErrors.get(e.path)) !== JSON.stringify(e));
  const runStates = new Map((discovery.runStates ?? []).map(state => [JSON.stringify([state.dbPath, state.id]), state.status]));
  const discoveredRuns = discovery.runs.map(run => ({ ...run,
    status: normalizeRunStatus(runStates.has(JSON.stringify([run.dbPath, run.id])) ? runStates.get(JSON.stringify([run.dbPath, run.id])) : run.status) }));
  const batch: ImportBatch = {
    calls: [], runs: options.skipShared ? [] : discoveredRuns.filter(r => JSON.stringify(savedRuns.get(JSON.stringify([r.dbPath, r.id]))) !== JSON.stringify(r)),  states: [], resetSources: [], sourceErrors: sharedErrors,
    detailedRunIds: [], restoreAggregateRunIds: [], at, commitGuard: options.commitGuard
  };
  const calls: CallRow[] = [], states: ImportState[] = [], resets: {
    path: string;
    generation: number;
  }[] = [];
  const errors = [...sharedErrors];
  const sessions: SessionMeta[] = [];
  const savedSessions = new Map(ledger.getSessions().map(session => [session.id, session]));
  try {
    const memory = historical(ledger);
    const contexts = new Map(memory.contexts);
    const byPath = new Map(discovery.sources.map(s => [resolve(s.path), s]));
    const sourceContexts: {
      path: string;
      context: SourceContext;
    }[] = [];
    const headers = new Map(ledger.getSourceHeaders().map(s => [s.path, s.header]));
    const persistedContexts = new Set(headers.keys());
    const pending = new Map(ledger.getPendingReports().map(p => [JSON.stringify([p.path, p.runId]), p]));
    const released = new Set<string>();
    for (const item of ledger.getIncompleteReports()) {
      const k = JSON.stringify([item.path, item.runId]);
      released.add(k);
      if (!pending.has(k)) pending.set(k, {
        ...item, generation: ledger.getImportState(item.path)?.generation ?? 0,
        firstSeen: at, calls: [], partial: (ledger.getImportState(item.path)?.offset ?? 0) < (ledger.getImportState(item.path)?.size ?? 0)
      });
    }
    const complete: { path: string; runId: string }[] = [];
    const removePending: {
      path: string;
      runId: string;
    }[] = [];
    const incomplete: {
      path: string;
      runId: string;
    }[] = [];
    const expectedGroups = new Map<string, Set<string>>();
    const markers = new Map<string, number>();
    const runKey = (db: string, id: string) => JSON.stringify([db, id]);
    const runsByKey = new Map(discovery.runs.map(r => [runKey(r.dbPath, r.id), r]));
    const runsById = new Map(discovery.runs.map(r => [r.id, r]));
    const terminalRunIds = new Set((discovery.runStates ?? []).filter(r => ["done", "failed", "cancelled"].includes(r.status ?? "")).map(r => r.id));
    for (const event of discovery.runEvents ?? [])
      if (event.type === "spider_usage_reported") {
        const k = runKey(event.dbPath, event.runId);
        markers.set(k, Math.min(markers.get(k) ?? Infinity, event.ts));
      }
    for (const event of discovery.runEvents ?? []) {
      if (event.type !== "spider_usage" || event.ts > (markers.get(runKey(event.dbPath, event.runId)) ?? Infinity))
        continue;
      let payload: Record<string, unknown>;
      try {
        payload = object(JSON.parse(event.payload ?? ""));
      }
      catch {
        continue;
      }
      if (!text(payload.provider) || !text(payload.model))
        continue;
      const group = expectedGroups.get(event.runId) ?? new Set<string>();
      group.add(JSON.stringify([payload.provider, payload.model]));
      expectedGroups.set(event.runId, group);
    }
    // Small headers suffice for fork origin traversal. No scan/body survives its source.
    function origin(source: SourceInfo, ts: number): SourceInfo | undefined {
      let current: SourceInfo | undefined = source;
      const visited = new Set<string>();
      while (current) {
        if (visited.has(current.path))
          return undefined;
        visited.add(current.path);
        const header = headers.get(current.path), time = Date.parse(text(header?.timestamp) ?? "");
        if (!text(header?.parentSession) || !Number.isFinite(time) || ts >= time)
          return current;
        current = byPath.get(resolve(String(header!.parentSession)));
      }
      return undefined;
    }
    const cache = headerCache.get(ledger) ?? new Map(); headerCache.set(ledger, cache);
    // Preload only missing headers so a later-listed ancestor can own an earlier fork.
    // Full source parsing below persists them for all subsequent passes.
    for (const source of discovery.sources)
      if (!headers.has(source.path)) {
        let stamp: string;
        try { const info = statSync(source.path); stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`; }
        catch { continue; }
        const cached = cache.get(source.path);
        if (cached?.stamp === stamp) { headers.set(source.path, cached.header); continue; }
        const f = await open(source.path, "r").catch(() => undefined);
        if (!f)
          continue;
        try {
          const buffer = Buffer.alloc(PREFIX), result = await f.read(buffer, 0, PREFIX, 0);
          const end = buffer.subarray(0, result.bytesRead).indexOf(10);
          if (end >= 0) {
            const h = object(JSON.parse(buffer.subarray(0, end).toString()));
            headers.set(source.path, h.type === "session" ? h : null);
          }
        }
        catch { /* malformed headers are diagnosed in the scan */ }
        finally {
          await f.close();
          cache.set(source.path, { stamp, header: headers.get(source.path) ?? null });
        }
      }
    // Stat-skipped sources still supply attribution on a worker restart or a
    // metadata-only cycle. These local contexts survive only a fenced commit.
    for (const source of discovery.sources) {
      const id = text(headers.get(source.path)?.id);
      if (source.run && id) contexts.set(source.run.id, id);
    }
    const tailGroups = new Set<string>();
    const scannedPaths = new Set<string>();
    const selectedPaths = options.sourcePaths ? new Set(options.sourcePaths) : undefined;
    for (const source of discovery.sources) {
      if (selectedPaths && !selectedPaths.has(source.path)) continue;
      if (signal.aborted)
        return health();
      try {
        const previous = ledger.getImportState(source.path);
        // Do not deserialize historical ancestry at all on a no-change pass.
        const info = await stat(source.path);
        if (previous && persistedContexts.has(source.path) && previous.inode === `${info.dev}:${info.ino}` && previous.size === info.size
          && previous.mtimeMs === info.mtimeMs && previous.offset === info.size) {
          const header = headers.get(source.path);
          if (source.run && text(header?.id))
            contexts.set(source.run.id, String(header!.id));
          continue;
        }
        const scan = await readTranscript(source, previous, ledger.getSourceContext(source.path, []), signal, ledger, Math.max(1, options.maxBytes ?? Infinity), savedSessions);
        if (!scan)
          continue;
        states.push(scan.state);
        if (scan.session) { sessions.push(scan.session); savedSessions.set(scan.session.id, scan.session); }
        if (scan.lines.length || !scan.partial) scannedPaths.add(source.path);
        sourceContexts.push({ path: source.path, context: scan.context });
        headers.set(source.path, scan.header ?? null);
        if (scan.reset) {
          resets.push({ path: source.path, generation: scan.state.generation });
          if (source.run)
            contexts.delete(source.run.id);
          for (const [k, p] of pending)
            if (p.path === source.path) { pending.delete(k); released.delete(k); }
        }
        if (source.run && scan.parsed.sessionId)
          contexts.set(source.run.id, scan.parsed.sessionId);
        const headerTime = Date.parse(text(scan.header?.timestamp) ?? "");
        const inherited = !!scan.parsed.parentSession && Number.isFinite(headerTime);
        const entries = new Map(scan.lines.map(l => [text(object(l.json).id) ?? `offset:${l.byteOffset}`, object(l.json)]));
        const last = object(scan.lines.at(-1)?.json);
        for (const call of scan.parsed.calls) {
          const entry = entries.get(call.entryId), message = object(entry?.message);
          const copied = inherited && call.ts < headerTime;
          const item = row(call, scan.state.generation, copied, text(message.responseId));
          if (item.sourceKind !== "report") {
            const owning = copied ? origin(source, call.ts)?.run : source.run;
            item.agent = owning?.agent ?? null;
            if (copied) {
              item.runId = owning?.id ?? null;
              item.parentRunId = owning?.parentRunId ?? null;
              item.role = owning?.role ?? null;
              item.runName = owning?.name ?? null;
              item.phase = owning?.phase ?? null;
              if (owning?.sessionId)
                item.sessionId = owning.sessionId;
            }
            calls.push(item);
          }
          else if (copied || !item.runId) {
            item.parentRunId = null;
            calls.push(item);
          }
          else {
            const k = JSON.stringify([source.path, item.runId]);
            const group = pending.get(k) ?? {
              path: source.path, runId: item.runId, generation: scan.state.generation, firstSeen: at, calls: [], partial: false
            };
            if (!group.calls.some(c => c.entryId === item.entryId))
              group.calls.push(item);
            group.partial = false;
            pending.set(k, group);
            if (scan.partial && last.id === item.entryId)
              tailGroups.add(k);
          }
        }
      }
      catch (error) {
        errors.push({ path: source.path, code: errorCode(error) });
      }
    }
    // reportRunUsage writes all model parts back-to-back only at run end. This
    // hold covers a partly written group, not a still-running child's future usage.
    // Terminal runs release the available parts with a reversible undercount flag;
    // unknown/nonterminal snapshots hold for at most five minutes. No cursor fence.
    const pendingUpdates: PendingReport[] = [];
    const resetting = new Set(resets.map(s => s.path));
    for (const [k, group] of pending) {
      const importedModels = resetting.has(group.path) ? [] : ledger.getReportModels(group.path, group.runId);
      const models = new Set([...importedModels, ...group.calls].map(c => JSON.stringify([c.provider, c.requestedModel])));
      const expected = expectedGroups.get(group.runId);
      const missing = !!expected && [...expected].some(m => !models.has(m));
      const partial = tailGroups.has(k) || !scannedPaths.has(group.path) && group.partial === true;
      group.partial = partial;
      // A backward clock step must not extend the hold by the size of the step.
      group.firstSeen = Math.min(group.firstSeen, at);
      const run = runsById.get(group.runId);
      const terminal = run?.endedAt != null || terminalRunIds.has(group.runId);
      if (!missing && !partial || terminal || released.has(k) || at - group.firstSeen >= 5 * 60 * 1000) {
        calls.push(...group.calls);
        removePending.push({ path: group.path, runId: group.runId });
        if (missing || partial)
          incomplete.push({ path: group.path, runId: group.runId });
        else
          complete.push({ path: group.path, runId: group.runId });
      }
      else {
        if (partial)
          group.partial = true;
        pendingUpdates.push(group);
      }
    }
    // DB facts are immutable. Event identities include payloads so a recreated DB
    // can reuse numeric ids without deleting or colliding with its predecessor.
    if (!options.skipShared) {
    const auxByDb = new Map<string, {
      event: NonNullable<Discovery["runEvents"]>[number];
      payload: Record<string, unknown>;
    }[]>();
    const unknown = new Map<string, {
      path: string;
      purpose: string;
      count: number;
    }>();
    const transcriptPurposes = new Set(["compaction", "branch_summary", "subagent", "spider-subagent", "cache_warm"]);
    for (const event of discovery.runEvents ?? []) {
      if (event.type !== "spider_usage")
        continue;
      let payload: Record<string, unknown>;
      try {
        payload = object(JSON.parse(event.payload ?? ""));
      }
      catch {
        continue;
      }
      const purpose = text(payload.purpose);
      if (!purpose || transcriptPurposes.has(purpose))
        continue;
      if (!AUX_PURPOSES.has(purpose)) {
        const k = JSON.stringify([event.dbPath, purpose]), diagnostic = unknown.get(k) ?? { path: event.dbPath, purpose, count: 0 };
        diagnostic.count++;
        unknown.set(k, diagnostic);
        continue;
      }
      const list = auxByDb.get(event.dbPath) ?? [];
      list.push({ event, payload });
      auxByDb.set(event.dbPath, list);
    }
    for (const d of unknown.values())
      errors.push({ path: `${d.path}#unknown-aux:${d.purpose}`, code: `unknown-aux-purpose:${d.purpose}:${d.count}` });
    const unavailable = new Set(discovery.errors.map(e => e.path));
    for (const dbPath of discovery.runDbs ?? [])
      if (!auxByDb.has(dbPath) && !unavailable.has(dbPath)
        && ledger.getImportState(`${dbPath}#spider-aux`))
        auxByDb.set(dbPath, []);
    for (const [dbPath, items] of auxByDb) {
      const path = `${dbPath}#spider-aux`, previous = ledger.getImportState(path);
      const saved = ledger.getSourceContext(path);
      const known = new Set((saved?.entries ?? []).map(e => String(object(e.json).id)));
      const entries: SourceContext["entries"] = [];
      const ordered = items.sort((a, b) => a.event.id - b.event.id);
      const hash = createHash("sha256");
      let size = 0, parseErrors = previous?.parseErrors ?? 0;
      for (const { event, payload } of ordered) {
        const bytes = Buffer.from(JSON.stringify(event) + "\n");
        hash.update(bytes);
        size += bytes.length;
        const id = `event:${event.id}:${digest(bytes)}`;
        if (known.has(id))
          continue;
        const run = runsByKey.get(runKey(dbPath, event.runId));
        if (!run) {
          parseErrors++;
          continue;
        }
        const parsed = parseTranscript([
          {
            byteOffset: 0, json: {
              type: "usage", id,
              timestamp: Number.isFinite(event.ts) && Math.abs(event.ts) <= 8.64e15 ? new Date(event.ts).toISOString() : "invalid",
              kind: "spider-aux", note: payload.purpose, provider: payload.provider, model: payload.model,
              responseModel: payload.responseModel, usage: payload.usage
            }
          }
        ], parserSource({ path, project: run.project, repo: run.repo, run }));
        parseErrors += parsed.errors.length;
        for (const call of parsed.calls)
          calls.push({ ...row(call, 0), sourceKind: "run-db-aux", agent: run.agent });
        entries.push({ byteOffset: (saved?.entries.at(-1)?.byteOffset ?? -1) + 1 + entries.length, json: { id } });
        known.add(id);
      }
      const prefixHash = hash.digest("hex");
      const inode = discovery.runDbIdentities?.[dbPath] ?? dbPath;
      const snapshotSize = typeof saved?.header?.snapshotSize === "number" ? saved.header.snapshotSize : previous?.size;
      const recreated = !!previous && (previous.inode !== inode || size < snapshotSize!
        || size === snapshotSize && prefixHash !== previous.prefixHash);
      if (previous && previous.inode === inode && snapshotSize === size && previous.prefixHash === prefixHash && entries.length === 0)
        continue;
      if (recreated)
        errors.push({ path, code: "runs-db-recreated:facts-retained" });
      const offset = Math.max(size, previous?.offset ?? 0);
      states.push({ path, inode, size: offset, offset, mtimeMs: at, parseErrors, generation: 0, prefixHash });
      sourceContexts.push({ path, context: { header: { snapshotSize: size }, entries, tailHash: "" } });
    }
    }
    const resetPaths = new Set(resets.map(s => s.path));
    const reports = memory.reports.filter(r => !resetPaths.has(r.path));
    for (const call of calls)
      if (call.sourceKind === "report" && !call.copied && call.runId)
        reports.push({ runId: call.runId, owner: call.parentRunId, path: call.sourceFile, ts: call.ts });
    const knownRuns = savedRuns;
    for (const run of discovery.runs)
      knownRuns.set(JSON.stringify([run.dbPath, run.id]), run);
    const proof = reconcileProof(discovery, memory, reports, [...knownRuns.values()], contexts);
    if (signal.aborted)
      return health();
    try {
      const committed = ledger.apply({
        ...batch, calls, states, sessions, resetSources: resets, sourceErrors: errors,
        coverageEdges: proof.edges, sourceContexts, pendingReports: pendingUpdates,
        removePendingReports: removePending, incompleteReports: incomplete, completeReports: complete
      });
      if (!committed) return health();
      if (calls.length) options.onCallsAdded?.();
    }
    catch (error) {
      // No replay/toggle of fallback facts, and no cursor advance. Record diagnostics
      // separately if the store is available; a stale competing scan is not corruption.
      if (!String(error).includes("Stale ")) {
        try {
          ledger.apply({ ...batch, runs: [], sourceErrors: [...errors, ...states.map(s => ({ path: s.path, code: errorCode(error) }))] });
        }
        catch { /* next pass retries */ }
      }
      return health();
    }
    for (const reset of resets) forgetSessionMetadata(reset.path);
    retained.set(ledger, { reports, edges: proof.edges, contexts });
  }
  catch (error) {
    if (!signal.aborted) {
      try {
        ledger.apply({
          ...batch, calls: [], runs: [], sourceErrors: [{ path: discovery.ledgerFile ?? "usage-ingest", code: errorCode(error) }]
        });
      }
      catch { /* diagnostics must not escape into pi */ }
    }
  }
  return health();
}
