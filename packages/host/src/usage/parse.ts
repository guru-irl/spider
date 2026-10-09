import { createHash } from "node:crypto";
import { priceCall, priceReportedCost, summaryModelRef } from "./price.js";
import type { Actor, PriceResult, UsageTokens } from "./types.js";

export type RunAttribution = {
  id: string;
  sessionId: string;
  parentRunId: string | null;
  agent: string;
  role: string | null;
  name: string | null;
  model: string | null;
  thinking: string | null;
  phase: string | null;
  startedAt: number | null;
};

export type SourceInfo = {
  path: string;
  project: string | null;
  repo: string | null;
  run: RunAttribution | null;
};

export type ParsedCall = {
  id: string;
  ts: number;
  sourceFile: string;
  entryId: string;
  project: string | null;
  repo: string | null;
  sessionId: string | null;
  runId: string | null;
  actor: Actor;
  role: string | null;
  agent: string | null;
  /** Report note label may be name ?? agent; prefer registry names when enriching. */
  runName: string | null;
  phase: string | null;
  parentRunId: string | null;
  auxPurpose: string | null;
  provider: string | null;
  /** Original billing attribution, distinct from inferred summary provider state. */
  rawProvider?: string | null;
  model: string | null;
  /** Only the usage-bearing record's request model, never inherited display state. */
  requestedModel: string | null;
  /** Inferred tree/run selection for display only, not billing or requested-model grouping. */
  displayModel?: string | null;
  thinking: string | null;
  api: string | null;
  usage: UsageTokens;
  price: PriceResult;
  piCost: number | null;
  latencyMs: number | null;
  aggregate: boolean;
};

export type ParsedSource = {
  sessionId: string | null;
  parentSession: string | null;
  calls: readonly ParsedCall[];
  /** Skipped malformed lines only, including duplicate-entry; no retained-call warnings. */
  errors: readonly { byteOffset: number; code: string }[];
  /** Non-skipping diagnostics: invalid-tree is emitted once per cycle node. */
  warnings?: readonly { byteOffset: number; code: string }[];
};

type ObjectValue = Record<string, unknown>;
type Node = { entry: ObjectValue; entryId: string; parentId: string | null; byteOffset: number };
type DisplayState = { model: string | null; thinking: string | null; provider: string | null; invalidTree: boolean };

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function tokens(value: ObjectValue): UsageTokens | undefined {
  const { input, output, cacheRead, cacheWrite } = value;
  if (!nonnegative(input) || !nonnegative(output) || !nonnegative(cacheRead) || !nonnegative(cacheWrite)) return undefined;
  const result: UsageTokens = { input, output, cacheRead, cacheWrite };
  for (const key of ["reasoning", "cacheWrite1h", "totalTokens"] as const) {
    if (value[key] === undefined) continue;
    if (!nonnegative(value[key])) return undefined;
    result[key] = value[key];
  }
  if (result.cacheWrite1h !== undefined && result.cacheWrite1h > cacheWrite) return undefined;
  return result;
}

function timestamp(entry: ObjectValue, message: ObjectValue): number | undefined {
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (Number.isFinite(at)) return at;
  // Message timestamps in pi are epoch milliseconds, not date strings.
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    && Math.abs(message.timestamp) <= 8.64e15) return message.timestamp;
  return undefined;
}

/** Pure normalization. Nothing outside the supplied source and entry tree is consulted. */
export function parseTranscript(lines: readonly { byteOffset: number; json: unknown }[], source: SourceInfo,
  options: { sessionProviders?: readonly string[] } = {}): ParsedSource {
  let sessionId: string | null = null;
  let parentSession: string | null = null;
  const calls: ParsedCall[] = [];
  const errors: { byteOffset: number; code: string }[] = [];
  const warnings: { byteOffset: number; code: string }[] = [];
  const nodes: Node[] = [];
  const byId = new Map<string, Node>();
  let previousId: string | null = null;

  for (const line of lines) {
    const entry = object(line.json);
    if (!entry || !text(entry.type)) {
      errors.push({ byteOffset: line.byteOffset, code: "invalid-entry" });
      continue;
    }
    if (entry.type === "session") {
      sessionId = text(entry.id);
      parentSession = text(entry.parentSession);
      continue;
    }
    const entryId = text(entry.id) ?? `offset:${line.byteOffset}`;
    if (byId.has(entryId)) {
      // Keep the first node so duplicate records cannot overwrite ancestry or
      // emit colliding call IDs that a downstream ledger silently discards.
      errors.push({ byteOffset: line.byteOffset, code: "duplicate-entry" });
      continue;
    }
    // Old files predate parent links. Only missing links use linear display state;
    // an explicit root or a missing referenced ancestor must not use the latest branch.
    const parentId = entry.parentId === undefined ? previousId : text(entry.parentId);
    const node = { entry, entryId, parentId, byteOffset: line.byteOffset };
    nodes.push(node);
    byId.set(entryId, node);
    previousId = entryId;
  }

  const runModel = text(source.run?.model);
  const initial: DisplayState = { model: runModel?.includes("/") ? runModel.slice(runModel.indexOf("/") + 1) : runModel,
    thinking: source.run?.thinking ?? null, provider: null, invalidTree: false };
  const states = new Map<Node, DisplayState>();
  function displayState(node: Node): DisplayState {
    const trail: Node[] = [];
    const visited = new Set<Node>();
    let cursor: Node | undefined = node;
    let state = initial;
    while (cursor) {
      const cached = states.get(cursor);
      if (cached) { state = cached; break; }
      if (visited.has(cursor)) {
        // A corrupt cycle is not evidence of a selected model or effort level.
        const invalid: DisplayState = { model: null, thinking: null, provider: null, invalidTree: true };
        // Only the cycle itself is corrupt, not each descendant billed call.
        // Memoization ensures each cycle node is diagnosed exactly once.
        for (const item of trail.slice(trail.indexOf(cursor))) {
          warnings.push({ byteOffset: item.byteOffset, code: "invalid-tree" });
        }
        for (const item of trail) states.set(item, invalid);
        return invalid;
      }
      visited.add(cursor);
      trail.push(cursor);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    // Iterative memoization avoids stack growth and repeated full ancestor walks.
    for (let index = trail.length - 1; index >= 0; index--) {
      const item = trail[index];
      if (!state.invalidTree && item.entry.type === "model_change") state = { ...state, model: text(item.entry.modelId), provider: text(item.entry.provider) };
      if (!state.invalidTree && item.entry.type === "thinking_level_change") state = { ...state, thinking: text(item.entry.thinkingLevel) };
      states.set(item, state);
    }
    return state;
  }

  // Also diagnose cycles with no usage-bearing descendants.
  for (const node of nodes) displayState(node);

  const reportedCosts = new Map<ParsedCall, ObjectValue | undefined>();
  for (const node of nodes) {
    const { entry, entryId, byteOffset } = node;
    let record = entry;
    let actor: Actor = source.run ? "subagent" : "parent";
    let aggregate = false;
    let auxPurpose: string | null = null;
    let reportedRun = false;
    if (entry.type === "message") {
      const message = object(entry.message);
      if (!message || !text(message.role)) {
        errors.push({ byteOffset, code: "invalid-entry" });
        continue;
      }
      if (message.role !== "assistant" && message.role !== "toolResult") continue;
      record = message;
      if (message.role === "toolResult") {
        if (message.usage == null) continue;
        // Optional explicit summary provenance is safe; surrounding model changes
        // and tool details/content are never billing evidence.
        const summary = object(message.usage)?.source;
        actor = summary === "compaction" || summary === "branch_summary" ? "compaction" : "aux";
        // Tool fallback may sum multiple aux/subagent calls and overlap child
        // transcripts or run reports. These tokens are not automatically additive.
        aggregate = true;
        auxPurpose = `tool:${text(message.toolName) ?? "unknown"}`;
      }
    } else if (entry.type === "usage") {
      const kind = text(entry.kind);
      if (kind === "spider-aux") { actor = "aux"; auxPurpose = text(entry.note); }
      else if (kind === "cache_warm") actor = "warmer";
      else if (kind === "subagent") { actor = "subagent"; aggregate = true; reportedRun = true; }
      else auxPurpose = kind;
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      if (entry.usage == null) continue;
      actor = "compaction";
      aggregate = true;
    } else continue;

    const rawUsage = object(record.usage);
    const usage = rawUsage && tokens(rawUsage);
    if (!usage) {
      errors.push({ byteOffset, code: "invalid-usage" });
      continue;
    }
    const ts = timestamp(entry, record);
    if (ts === undefined) {
      errors.push({ byteOffset, code: "invalid-timestamp" });
      continue;
    }
    const state = displayState(node);
    // Preserve response aliases verbatim. priceCall alone normalizes supported aliases.
    // Display/request context cannot fill in a missing billing model or provider.
    const plugin = actor === "compaction" && (entry.type === "compaction" || entry.type === "branch_summary")
      ? summaryModelRef(object(entry.details)?.summaryModel) : undefined;
    const rawProvider = plugin?.provider ?? text(record.provider);
    const provider = rawProvider ?? (actor === "compaction" ? state.provider : null);
    const model = plugin?.id ?? text(record.responseModel) ?? text(record.model);
    const requestedModel = plugin?.id ?? text(record.model);
    const report = reportedRun ? text(entry.note)?.match(/^([\s\S]*?)\s*\(([A-Za-z0-9][A-Za-z0-9_-]*)\)\s*$/) : undefined;
    const cost = object(rawUsage.cost)?.total;
    const latency = record.latencyMs ?? entry.latencyMs;
    const call: ParsedCall = {
      id: createHash("sha256").update(JSON.stringify([source.path, entryId])).digest("hex"),
      ts, sourceFile: source.path, entryId, project: source.project, repo: source.repo,
      // Registry run sessionId identifies the owning parent session, while the
      // ParsedSource header retains the child transcript's own session identity.
      sessionId: text(source.run?.sessionId) ?? sessionId,
      runId: reportedRun ? report?.[2] ?? null : source.run?.id ?? null,
      actor, role: reportedRun ? null : source.run?.role ?? null,
      agent: reportedRun ? null : source.run?.agent ?? null,
      runName: reportedRun ? text(report?.[1]) : source.run?.name ?? null,
      phase: reportedRun ? null : source.run?.phase ?? null,
      parentRunId: reportedRun ? source.run?.id ?? null : source.run?.parentRunId ?? null,
      auxPurpose, provider, rawProvider, model, requestedModel, displayModel: reportedRun ? null : state.model,
      thinking: reportedRun ? null : text(record.providerThinkingLevel) ?? state.thinking, api: text(record.api), usage,
      price: actor === "compaction" && !plugin ? priceReportedCost(provider, object(rawUsage.cost))
        : priceCall({ provider, id: model }, usage, ts, { aggregate: plugin ? false : aggregate }),
      piCost: nonnegative(cost) ? cost : null,
      latencyMs: nonnegative(latency) ? latency : null, aggregate,
    };
    calls.push(call);
    if (actor === "compaction" && !plugin && provider === null) reportedCosts.set(call, object(rawUsage.cost));
  }
  // Unknown state may use only unanimous recorded call attribution, never an
  // inferred summary's own provider. Include persisted evidence for append scans.
  const providers = new Set([...options.sessionProviders ?? [], ...calls.flatMap(call => call.rawProvider ? [call.rawProvider] : [])]);
  if (providers.size === 1 && providers.has("github-copilot")) {
    for (const [call, cost] of reportedCosts) {
      call.provider = "github-copilot";
      call.price = priceReportedCost(call.provider, cost);
    }
  }
  return { sessionId, parentSession, calls, errors, warnings };
}
