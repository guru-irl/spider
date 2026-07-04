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
 * Tolerant parse of an aux-model reply into typed candidates. Accepts a fenced
 * ```json block or bare JSON. Unknown/invalid entries are dropped (never throw).
 * "Nothing to save." → emptyResult().
 */
export function parseCandidates(raw: string): DigestResult {
  const text = typeof raw === "string" ? raw : "";
  if (/nothing to save\.?/i.test(text.trim())) return emptyResult();

  // Extract the FIRST ```json fenced block if present, else use the raw string.
  const fence = /```json\s*\n?([\s\S]*?)```/i.exec(text);
  const jsonText = fence ? fence[1] : text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return emptyResult();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyResult();

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
