import type { MemoryCategory } from "@spider/memory";
import type { AuxRuntime, DigestMsg } from "@spider/memory";
import { resolveAuxRuntime, digestHistory } from "@spider/memory";
import type { DigestModel, DigestResult, MemoryCandidate, SkillCandidate, TodoCandidate } from "./types.js";
import { emptyResult } from "./types.js";

// The frozen memory taxonomy. A memory candidate is kept only when its
// `category` is EXACTLY one of these values.
const TAXONOMY: readonly MemoryCategory[] = Object.freeze([
  "preference", "convention", "tool-quirk", "failure", "correction", "insight",
]);

/** Defensive non-empty string read. */
function nonEmptyStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

function readField(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  return (obj as Record<string, unknown>)[key];
}

/**
 * Extract a balanced `{...}` JSON substring starting at the first `{`,
 * tolerating leading/trailing prose around it. Tracks string/escape state so
 * braces inside string values don't break the balance count. Returns
 * `undefined` when no balanced object is found. This never evaluates code —
 * it only locates a substring that is subsequently passed to `JSON.parse`.
 */
function extractBalancedJson(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** `JSON.parse` a candidate substring; only a plain object result is kept. */
function tryParseObject(s: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locate and strictly `JSON.parse` the candidate object embedded in a raw
 * model reply. Tolerates (in order): a fenced code block with or without a
 * `json` language tag (case-insensitive), bare JSON with no fence, and prose
 * wrapped before/after the JSON (preamble and/or trailing commentary). Never
 * evaluates code — every branch is a plain `JSON.parse` over an extracted
 * substring. Returns `undefined` when no valid JSON object can be found.
 */
function extractJsonCandidate(text: string): Record<string, unknown> | undefined {
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text);
  if (fence) {
    const inner = fence[1].trim();
    const direct = tryParseObject(inner);
    if (direct !== undefined) return direct;
    const bal = extractBalancedJson(inner);
    if (bal !== undefined) {
      const v = tryParseObject(bal);
      if (v !== undefined) return v;
    }
  }
  const direct = tryParseObject(text.trim());
  if (direct !== undefined) return direct;
  const bal = extractBalancedJson(text);
  if (bal !== undefined) {
    const v = tryParseObject(bal);
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * Tolerant parse of an aux-model reply into typed candidates. Accepts a fenced
 * ```json (or bare ```) block, bare JSON, or JSON wrapped in prose.
 * Unknown/invalid entries are dropped (never throw). An exact, trimmed,
 * case-insensitive "Nothing to save." is a valid empty response.
 *
 * `opts.strict` (default `false`, preserving prior tolerant public behavior):
 * when `true`, a reply that is wholly malformed/non-JSON (and is not the
 * literal empty-response phrase) throws a short, safe error instead of
 * silently returning `emptyResult()` — so production callers can distinguish
 * "the model said nothing" from "the model's reply could not be parsed at
 * all". The error message never echoes the raw reply (never a raw response
 * dump) and no code is ever evaluated — only `JSON.parse` over extracted text.
 */
export function parseCandidates(raw: string, opts?: { strict?: boolean }): DigestResult {
  const strict = opts?.strict ?? false;
  const text = typeof raw === "string" ? raw : "";
  // Anchored to the WHOLE trimmed reply — a reply that merely quotes or
  // discusses the phrase while going on to emit real JSON must NOT match.
  if (/^nothing to save\.?$/i.test(text.trim())) return emptyResult();

  const parsed = extractJsonCandidate(text);
  if (parsed === undefined) {
    if (strict) throw new Error("organism: aux-model reply was not valid JSON");
    return emptyResult();
  }

  const result = emptyResult();

  const rawMemory = readField(parsed, "memory");
  if (Array.isArray(rawMemory)) {
    for (const entry of rawMemory) {
      const category = readField(entry, "category");
      const content = nonEmptyStr(readField(entry, "content"));
      if (typeof category !== "string" || !TAXONOMY.includes(category as MemoryCategory)) continue;
      if (content === undefined) continue;
      const cand: MemoryCandidate = { category: category as MemoryCategory, content };
      const link = readField(entry, "link");
      if (typeof link === "string" || link === null) cand.link = link as string | null;
      const confidence = readField(entry, "confidence");
      if (typeof confidence === "number") cand.confidence = confidence;
      result.memory.push(cand);
    }
  }

  const rawTodos = readField(parsed, "todos");
  if (Array.isArray(rawTodos)) {
    for (const entry of rawTodos) {
      const text0 = nonEmptyStr(readField(entry, "text"));
      if (text0 === undefined) continue;
      const cand: TodoCandidate = { text: text0 };
      result.todos.push(cand);
    }
  }

  const rawSkills = readField(parsed, "skills");
  if (Array.isArray(rawSkills)) {
    for (const entry of rawSkills) {
      const name = nonEmptyStr(readField(entry, "name"));
      const body = nonEmptyStr(readField(entry, "body"));
      if (name === undefined || body === undefined) continue;
      const cand: SkillCandidate = { name, body };
      const category = nonEmptyStr(readField(entry, "category"));
      if (category !== undefined) cand.category = category;
      const related = readField(entry, "related");
      if (Array.isArray(related)) cand.related = related.filter((r): r is string => typeof r === "string");
      result.skills.push(cand);
    }
  }

  const summary = nonEmptyStr(readField(parsed, "summary"));
  if (summary !== undefined) result.summary = summary;
  const selfName = nonEmptyStr(readField(parsed, "selfName"));
  if (selfName !== undefined) result.selfName = selfName;

  return result;
}

/** The single injected seam that performs the actual aux-model completion. */
export type AuxCall = (rt: AuxRuntime, system: string, messages: DigestMsg[]) => Promise<string>;

/**
 * Build a DigestModel from ctx using Phase 1 resolveAuxRuntime. Replays a
 * compact digest (digestHistory) to the routed aux model via the injected
 * `call` seam (never hits the network here — Task 14 binds the real one).
 */
export function createDigestModel(ctx: { auxModel?: string; cfg: unknown; parentModel: string; call: AuxCall }): DigestModel {
  const rt = resolveAuxRuntime(ctx.cfg, ctx.parentModel);
  return { complete: (system, msgs) => ctx.call(rt, system, digestHistory(msgs)) };
}
