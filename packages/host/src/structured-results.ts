import { Type } from "typebox";
import type { SpiderArgs } from "./dispatch";
import { toToolResult, type ToolResult } from "./result";
import { processToolContent, scrubToolData, type SafetyConfig } from "./routing/safety";

const ADAPTER_ACTIONS = ["search", "recall", "exec"] as const;
export const STRUCTURED_TOOL_NAMES: ReadonlySet<string> = new Set(ADAPTER_ACTIONS.map(action => `spider_${action}`));

const MAX_BYTES = 10_000;
const hitSchema = Type.Object({
  id: Type.String(), kind: Type.Union([Type.Literal("memory"), Type.Literal("content"), Type.Literal("session"), Type.Literal("todo")]),
  source: Type.String(), title: Type.String(), snippet: Type.String(),
}, { additionalProperties: false });
const hitOutput = Type.Object({
  outcome: Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("unavailable")]),
  hits: Type.Array(hitSchema), truncated: Type.Boolean(),
}, { additionalProperties: false });
const execOutput = Type.Object({
  outcome: Type.Union(["exited", "signal", "spawn-error", "aborted", "timeout", "unknown", "error", "unavailable"].map(value => Type.Literal(value))),
  exitCode: Type.Union([Type.Integer(), Type.Null()]), output: Type.String(), truncated: Type.Boolean(),
}, { additionalProperties: false });

export interface AdapterTool {
  name: string;
  description: string;
  parameters: unknown;
  outputSchema?: unknown;
  exposure?: "codemode";
  execute(id: string, args: SpiderArgs, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown>;
}
interface Hit { id: string; kind: "memory" | "content" | "session" | "todo"; source: string; title: string; snippet: string }
const execOutcomes = new Set(["exited", "signal", "spawn-error", "aborted", "timeout", "unknown"]);
const kinds = new Set(["memory", "content", "session", "todo"]);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function hitsFor(action: "search" | "recall", details: unknown, args: SpiderArgs, config: SafetyConfig): Hit[] | undefined {
  if (!Array.isArray(details)) return undefined;
  const hits: Hit[] = [];
  for (const row of details) {
    if (!row || typeof row !== "object") return undefined;
    const id = action === "search" ? row.id : row.uuid;
    const kind = action === "search" ? row.kind : "memory";
    if (typeof id !== "string" || !kinds.has(kind)) return undefined;
    const source = action === "search" ? row.source ?? `${kind}:${id}` : row.link ?? `memory:${args.scope === "global" ? "global" : "repo"}:${id}`;
    const title = action === "search" ? row.title : row.category;
    const snippet = action === "search" ? row.snippet : row.content;
    if (typeof source !== "string" || typeof title !== "string" || typeof snippet !== "string") return undefined;
    hits.push({ id, kind, source, title, snippet: processToolContent(snippet, config).content });
  }
  return hits;
}

/** Keep valid JSON and complete Unicode code points inside the same 10 KB exec budget. */
function boundExec(value: { outcome: string; exitCode: number | null; output: string; truncated: boolean }) {
  if (bytes(value) <= MAX_BYTES) return value;
  const chars = Array.from(value.output);
  value.truncated = true;
  let low = 0, high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes({ ...value, output: chars.slice(0, mid).join("") }) <= MAX_BYTES) low = mid;
    else high = mid - 1;
  }
  return { ...value, output: chars.slice(0, low).join("") };
}

function structuredResult(action: "search" | "recall" | "exec", raw: ToolResult, args: SpiderArgs, config: SafetyConfig) {
  const text = processToolContent(raw.content.map(block => block.text).join(""), config).content;
  const details = scrubToolData(raw.details, config.secretScrub).value;
  const result = { ...raw, content: [{ type: "text" as const, text }], details };
  if (action !== "exec") {
    const hits = raw.isError ? [] : hitsFor(action, details, args, config);
    const value = { outcome: raw.isError ? "error" : hits ? "ok" : "unavailable", hits: hits ?? [], truncated: false };
    while (bytes(value) > MAX_BYTES && value.hits.length) { value.hits.pop(); value.truncated = true; }
    return { ...result, isError: raw.isError || hits === undefined, structuredContent: value };
  }
  const data = details as Record<string, unknown> | null;
  const valid = data && execOutcomes.has(String(data.outcome)) &&
    (data.exitCode === null || Number.isSafeInteger(data.exitCode));
  const value = boundExec({
    outcome: valid ? String(data.outcome) : raw.isError ? "error" : "unavailable",
    exitCode: valid ? data.exitCode as number | null : null,
    output: text,
    truncated: text.includes("[output truncated at 10KB"),
  });
  return { ...result, isError: raw.isError || !valid, structuredContent: value };
}

/** No alternate services, active declarations or changes to the interactive spider tool. */
export function registerStructuredTools(
  pi: { registerTool(tool: AdapterTool): void }, spider: AdapterTool,
  safety: (args: SpiderArgs, ctx: unknown) => SafetyConfig,
): void {
  const properties = (spider.parameters as { properties: Record<string, unknown> }).properties;
  for (const action of ADAPTER_ACTIONS) {
    const keys = action === "search" ? ["query", "limit", "kinds", "cwd"]
      : action === "recall" ? ["query", "category", "scope", "limit", "cwd"]
      : ["language", "code", "timeout", "background", "cwd"];
    pi.registerTool({
      name: `spider_${action}`, exposure: "codemode",
      description: `Run spider ${action} with a bounded typed result. Inspect outcome before using the result.`,
      parameters: { type: "object", properties: Object.fromEntries(keys.map(key => [key, properties[key]])), ...(action === "exec" ? { required: ["language", "code"] } : {}) },
      outputSchema: action === "exec" ? execOutput : hitOutput,
      async execute(id, input, signal, onUpdate, ctx) {
        const args = { ...input, action };
        const config = safety(args, ctx);
        let result: ToolResult;
        try { result = await spider.execute(id, args, signal, onUpdate, ctx) as ToolResult; }
        catch (error) { result = toToolResult({ error: error instanceof Error ? error.message || "Tool failed (no message)" : String(error) || "Tool failed (no message)" }); }
        return structuredResult(action, result, args, config);
      },
    });
  }
}
