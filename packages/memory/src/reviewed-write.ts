import { sanitizeQuery, STOPWORDS, type Db } from "@spider/db-core";
import type { AddMemoryInput, MemoryCategory, MemoryScope } from "./types";
import { firstThreatMessage } from "./scanner";
import { shouldCapture } from "./guardrails";
import { isDuplicate, getMemory, searchMemoryFts } from "./store";
import { forgetMemory, stageWrite, type StageResult } from "./staging";
import { assertWithinCap, DEFAULT_MEMORY_CHAR_CAP, memoryCharLength, MemoryOverflowError } from "./overflow";
import { tableFor } from "./internal";

export type ReviewerDbs = { repo: Db; global: Db };
export interface ReviewEntry { uuid: string; scope: MemoryScope; category: MemoryCategory; content: string }
export interface ReviewCandidate {
  content: string; category: MemoryCategory; scope: MemoryScope; justification: string;
  /** Resolved active same-scope UUIDs the caller intends to replace. */
  supersedes?: string[];
}
export type Verdict =
  | { verdict: "new"; reason: string }
  | { verdict: "already_present"; existing_uuid: string; reason: string }
  | { verdict: "supersedes"; supersedes: string[]; reason: string }
  | { verdict: "wrong_scope"; scope: MemoryScope; reason: string }
  | { verdict: "not_durable"; reason: string };
export interface ReviewedResult extends StageResult {
  verdict?: Verdict["verdict"];
  scope: MemoryScope;
  requestedScope: MemoryScope;
  archived?: string[];
  pendingSupersedes?: string[];
  reviewSkipped?: string;
  timeoutNote?: string;
  message: string;
}
export interface ReviewOptions {
  /** Active same-scope UUIDs or unique prefixes to replace on a foreground write. */
  supersedes?: string[];
  reviewer?: (candidate: ReviewCandidate, context: ReviewEntry[], signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  skipReason?: string;
  contextLimit?: number;
  onReviewError?: (error: string, raw: unknown) => void;
  /** No repository exists for this cwd, so a global entry cannot be redirected into a repo. */
  repoAvailable?: boolean;
}

/** Repo has FTS5; global_memory has no FTS table, so use sanitized tokens with LIKE there. */
export function reviewerContext(dbs: ReviewerDbs, query: string, limit = 12): ReviewEntry[] {
  if (limit <= 0) return [];
  const repo = searchMemoryFts(dbs.repo, "repo", query, { limit })
    .map(({ uuid, category, content }) => ({ uuid, category, content, scope: "repo" as const }));
  const tokens = [...sanitizeQuery(query, "OR").matchAll(/"([^"]+)"/g)]
    .map(m => m[1]).filter(t => t.length >= 3 && !STOPWORDS.has(t.toLowerCase())).slice(0, 24);
  if (!tokens.length) return repo;
  const conditions = tokens.map(() => "content LIKE ? ESCAPE '\\'").join(" OR ");
  const patterns = tokens.map(t => `%${t.replace(/[\\%_]/g, "\\$&")}%`);
  const score = tokens.map(() => "(CASE WHEN content LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)").join(" + ");
  const global = dbs.global.prepare(`SELECT uuid, category, content FROM global_memory WHERE status = 'active' AND (${conditions}) ORDER BY (${score}) DESC, created_at DESC LIMIT ?`)
    .all(...patterns, ...patterns, limit) as { uuid: string; category: MemoryCategory; content: string }[];
  return [...repo, ...global.map(e => ({ ...e, scope: "global" as const }))];
}

/** Invalid fields, extra fields, or UUIDs outside the supplied active context fail open. */
export function parseVerdict(raw: unknown, context: ReviewEntry[], requestedScope: MemoryScope): Verdict {
  let data: unknown = raw;
  if (typeof raw === "string") {
    const fenced = /^\s*```(?:json)?\r?\n([\s\S]*?)\r?\n```\s*$/.exec(raw);
    try { data = JSON.parse(fenced ? fenced[1] : raw); } catch { throw Error("invalid reviewer JSON"); }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw Error("invalid reviewer JSON shape");
  const v = data as Record<string, unknown>;
  const verdict = v.verdict;
  if (typeof v.reason !== "string" || !v.reason.trim()) throw Error("invalid reviewer reason");
  const fields: Record<string, string[]> = {
    new: ["verdict", "reason"], already_present: ["verdict", "reason", "existing_uuid"],
    supersedes: ["verdict", "reason", "supersedes"], wrong_scope: ["verdict", "reason", "scope"],
    not_durable: ["verdict", "reason"],
  };
  if (typeof verdict !== "string" || !Object.hasOwn(fields, verdict)) throw Error("invalid reviewer verdict fields");
  const required = fields[verdict];
  const redundantScope = verdict !== "wrong_scope" && Object.hasOwn(v, "scope");
  if (redundantScope && v.scope !== null && v.scope !== requestedScope) throw Error("invalid reviewer scope");
  const keys = Object.keys(v).filter(key => !(redundantScope && key === "scope") &&
    (required.includes(key) || v[key] !== null || !["scope", "supersedes", "existing_uuid"].includes(key)));
  if (keys.length !== required.length || required.some(key => !Object.hasOwn(v, key))) throw Error("invalid reviewer verdict fields");
  const known = (uuid: unknown) => typeof uuid === "string" && context.some(e => e.uuid === uuid);
  if (verdict === "already_present") {
    if (!known(v.existing_uuid)) throw Error("unknown existing uuid in reviewer verdict");
    return { verdict, reason: v.reason as string, existing_uuid: v.existing_uuid as string };
  }
  if (verdict === "supersedes") {
    if (!Array.isArray(v.supersedes) || v.supersedes.length === 0 || new Set(v.supersedes).size !== v.supersedes.length || !v.supersedes.every(known)) {
      throw Error("unknown or invalid uuid in supersedes list");
    }
    return { verdict, reason: v.reason as string, supersedes: v.supersedes as string[] };
  }
  if (verdict === "wrong_scope") {
    if (v.scope !== (requestedScope === "repo" ? "global" : "repo")) throw Error("invalid reviewer scope");
    return { verdict, reason: v.reason as string, scope: v.scope as MemoryScope };
  }
  return { verdict: verdict as "new" | "not_durable", reason: v.reason as string };
}

const MEMORY_CATEGORIES: readonly MemoryCategory[] = ["preference", "convention", "tool-quirk", "failure", "correction", "insight"];
const DEFAULT_TIMEOUT_MS = 45000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;
class RejectedSupersession extends Error {
  constructor(readonly saved: StageResult) { super(saved.reason ?? "insert rejected"); }
}

/** Resolve literal prefixes within the write scope, including inactive rows for clear errors. */
function explicitTargets(dbs: ReviewerDbs, scope: MemoryScope, refs: unknown): string[] {
  if (refs === undefined) return [];
  if (!Array.isArray(refs) || !refs.every(ref => typeof ref === "string" && ref.trim())) {
    throw Error("supersedes must be a list of nonblank memory UUIDs or unique UUID prefixes");
  }
  const otherScope = scope === "repo" ? "global" : "repo";
  const matches = (s: MemoryScope, ref: string) => dbs[s].prepare(
    `SELECT uuid, status FROM ${tableFor(s)} WHERE substr(uuid, 1, length(?)) = ?`,
  ).all(ref, ref) as { uuid: string; status: string }[];
  return [...new Set(refs.map(rawRef => {
    const ref = rawRef.toLowerCase();
    const entries = matches(scope, ref);
    // A full UUID takes precedence over longer prefix matches.
    const exact = entries.find(e => e.uuid === ref);
    const found = exact ? [exact] : entries;
    if (found.length > 1) throw Error(`supersedes: ambiguous UUID prefix '${ref}' in ${scope} scope: ${found.map(e => `${e.uuid} (${e.status})`).join(", ")}`);
    if (!found.length) {
      if (matches(otherScope, ref).length) throw Error(`supersedes: entry '${ref}' is in ${otherScope} scope, not ${scope} scope`);
      throw Error(`supersedes: unknown memory UUID or prefix '${ref}' in ${scope} scope`);
    }
    if (found[0].status !== "active") throw Error(`supersedes: entry '${found[0].uuid}' is not active in ${scope} scope`);
    return found[0].uuid;
  }))];
}

/** Precheck before any model call; leave stageWrite's synchronous organism API unchanged. */
export async function reviewedWrite(
  dbs: ReviewerDbs, requestedScope: MemoryScope, input: AddMemoryInput, justification: string,
  opts: ReviewOptions = {},
): Promise<ReviewedResult> {
  const timeoutValid = opts.timeoutMs === undefined ||
    (typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && Number.isInteger(opts.timeoutMs) && opts.timeoutMs >= MIN_TIMEOUT_MS && opts.timeoutMs <= MAX_TIMEOUT_MS);
  const ms = timeoutValid ? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const timeoutNote = timeoutValid ? undefined : `invalid reviewer timeout; using ${DEFAULT_TIMEOUT_MS} ms`;
  const rejected = (reason: string): ReviewedResult => ({ status: "rejected", reason, scope: requestedScope, requestedScope, timeoutNote, message: `not stored: ${reason}` });
  if (!MEMORY_CATEGORIES.includes(input.category)) return rejected(`invalid memory category: expected ${MEMORY_CATEGORIES.join(", ")}`);
  if (typeof justification !== "string" || !justification.trim()) {
    return rejected("justification required: say why the fact is durable after this task, how it helps other agents, and why the chosen scope is right (global in every repo, otherwise repo)");
  }
  const threat = firstThreatMessage(input.content, "strict") ?? firstThreatMessage(justification, "strict");
  if (threat) return rejected(threat);
  if (input.source === "auto" || input.source === "import") {
    const guard = shouldCapture(input.category, input.content);
    if (!guard.capture) return rejected(guard.reason ?? "guardrail rejected");
  }
  if (opts.supersedes !== undefined && (!Array.isArray(opts.supersedes) || opts.supersedes.length > 0) && (input.source === "auto" || input.source === "import")) {
    return rejected("explicit supersedes is not supported for staged writes; use a foreground remember with supersedes or forget explicitly");
  }
  let explicit: string[];
  try { explicit = explicitTargets(dbs, requestedScope, opts.supersedes); }
  catch (error) { return rejected(error instanceof Error ? error.message : String(error)); }
  if (isDuplicate(dbs[requestedScope], requestedScope, input.category, input.content, input.source)) return rejected("duplicate");

  const label = (saved: StageResult) => saved.status === "staged" ? `staged for approval as ${saved.uuid}` : `stored as ${saved.uuid}`;
  const store = (
    scope: MemoryScope, message: (saved: StageResult) => string, more: Partial<ReviewedResult> = {},
    reviewerTargets: string[] = [], related: string[] = [],
  ): ReviewedResult => {
    if (explicit.length && scope !== requestedScope) {
      return rejected(`supersedes targets are in ${requestedScope} scope; reviewer redirected to ${scope} scope, nothing written`);
    }
    const targets = [...new Set([...explicit, ...reviewerTargets])];
    const staged = input.source === "auto" || input.source === "import";
    const replacement = targets.length > 0 || more.verdict === "supersedes";
    let saved: StageResult;
    const archived: string[] = [];
    try {
      if (replacement) {
        // Lock before reading current target status/size, then archive and insert together.
        saved = dbs[scope].raw.transaction(() => {
          if (!staged) {
            for (const uuid of targets) {
              if (getMemory(dbs[scope], scope, uuid)?.status !== "active") throw Error(`supersedes: entry '${uuid}' is not active in ${scope} scope`);
            }
            assertWithinCap(dbs[scope], scope, memoryCharLength(input.content), DEFAULT_MEMORY_CHAR_CAP, undefined, targets);
            for (const uuid of targets) {
              if (forgetMemory(dbs[scope], scope, uuid)?.status !== "archived") throw Error(`archive failed: ${uuid}`);
              archived.push(uuid);
            }
          }
          const result = stageWrite(dbs[scope], scope, { ...input, justification });
          if (result.status === "rejected") throw new RejectedSupersession(result);
          if (result.status !== "active" && archived.length) throw Error("staged supersession cannot archive active entries");
          return result;
        }).immediate();
      } else {
        saved = stageWrite(dbs[scope], scope, { ...input, justification });
      }
    } catch (error) {
      if (replacement) {
        if (error instanceof RejectedSupersession) return rejected(error.saved.reason ?? "insert rejected");
        const reason = (error instanceof Error ? error.message : String(error)).replace(/^not stored:\s*/i, "");
        return { ...rejected(`supersession failed, nothing written: ${reason}`), archived: [] };
      }
      if (scope !== requestedScope && error instanceof MemoryOverflowError) {
        error.message = error.message.replace(/^Not stored: /, `Not stored: redirected from ${requestedScope} to ${scope}; `);
      }
      throw error;
    }
    const pendingSupersedes = saved.status === "staged" && targets.length ? targets : undefined;
    const action = pendingSupersedes
      ? `; related entries, not archived: ${pendingSupersedes.join(", ")}; approval does not archive them; use foreground remember with supersedes or forget explicitly`
      : archived.length ? `; archived ${archived.join(", ")} (superseded)` : "";
    return { ...saved, scope, requestedScope, timeoutNote, ...more,
      ...(replacement ? { archived, pendingSupersedes } : {}),
      message: saved.status === "rejected"
        ? (scope !== requestedScope && saved.reason === "duplicate"
          ? `not stored: redirected to ${scope}, which already has it (duplicate)` : `not stored: ${saved.reason}`)
        : `${message(saved)}${action}${related.length ? `; ${related.join("; ")}` : ""}`,
      reason: saved.status === "rejected" ? saved.reason : more.reason,
    };
  };
  const skip = (reason: string) => store(requestedScope, saved => saved.status === "staged"
    ? `${label(saved)} (review skipped: ${reason})`
    : `stored as requested (review skipped: ${reason}); uuid: ${saved.uuid}`, { reviewSkipped: reason });
  if (!opts.reviewer) return skip(opts.skipReason ?? "reviewer disabled");
  // Return before creating any rejectable promise, including for the already-aborted case.
  if (opts.signal?.aborted) return skip("aborted");
  const candidate: ReviewCandidate = { content: input.content, category: input.category, scope: requestedScope, justification,
    ...(explicit.length ? { supersedes: [...explicit] } : {}),
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const controller = new AbortController();
  let rawReply: unknown;
  let outcome: { verdict: Verdict; context: ReviewEntry[] };
  try {
    const context = reviewerContext(dbs, input.content, opts.contextLimit);
    const abort = new Promise<never>((_, reject) => {
      onAbort = () => { reject(Error("aborted")); controller.abort(); };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(Error(`timeout after ${ms} ms`)); controller.abort(); }, ms);
    });
    const raw = await Promise.race([opts.reviewer(candidate, context, controller.signal), timeout, abort]);
    rawReply = raw;
    outcome = { verdict: parseVerdict(raw, context, requestedScope), context };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try { opts.onReviewError?.(reason, rawReply); } catch { /* Diagnostics must not change the write policy. */ }
    return skip(reason);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
  }
  const { verdict, context } = outcome;
  const cited = verdict.verdict === "already_present" ? [verdict.existing_uuid] : verdict.verdict === "supersedes" ? verdict.supersedes : [];
  for (const uuid of cited) {
    const entry = context.find(e => e.uuid === uuid)!;
    if (getMemory(dbs[entry.scope], entry.scope, uuid)?.status !== "active") return skip(`cited entry no longer active: ${uuid}`);
  }
  switch (verdict.verdict) {
    case "not_durable":
      return { status: "rejected", verdict: "not_durable", reason: verdict.reason, scope: requestedScope, requestedScope,
        timeoutNote, message: `not stored: not durable enough for memory, keep it in the conversation (${verdict.reason})` };
    case "already_present": {
      const scope = context.find(e => e.uuid === verdict.existing_uuid)!.scope;
      return { status: "rejected", verdict: "already_present", uuid: verdict.existing_uuid, reason: verdict.reason,
        scope, requestedScope, timeoutNote, message: `not stored: already present in ${scope} as ${verdict.existing_uuid} (${verdict.reason})` };
    }
    case "wrong_scope":
      if (verdict.scope === "repo" && opts.repoAvailable === false) return skip("no git repository for repo scope");
      return store(verdict.scope, saved => `${label(saved)} in ${verdict.scope} instead of ${requestedScope} (${verdict.reason})`,
        { verdict: "wrong_scope", reason: verdict.reason });
    case "supersedes": {
      const same = verdict.supersedes.filter(uuid => context.find(e => e.uuid === uuid)!.scope === requestedScope);
      const related = verdict.supersedes.filter(uuid => !same.includes(uuid))
        .map(uuid => { const scope = context.find(e => e.uuid === uuid)!.scope; return `related entry in ${scope} scope, not archived: ${uuid}`; });
      return store(requestedScope, saved => `${label(saved)} (${verdict.reason})`,
        { verdict: "supersedes", reason: verdict.reason }, same, related);
    }
    case "new": return store(requestedScope, saved => `${label(saved)} (reviewer: new; ${verdict.reason})`, { verdict: "new", reason: verdict.reason });
  }
}
