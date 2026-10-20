import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Db } from "@spider/db-core";
import { sessionIdFromCtx } from "@spider/subagents";
import { recordIntent, recordResult, correlateResult, isExempt, SPIDER_TOOL_NAME } from "./tracking";
import { guardForegroundSleep } from "./sleep-guard";
import { processToolContent, sanitizeIntentPayload, scrubToolData } from "./safety";
import { autoIndexOutput } from "./autoindex";
import { registerEditWriteOverrides } from "./overrides";

export interface RoutingConfig {
  tracking: boolean;
  secretScrub: boolean;
  injectionScan: boolean;
  autoIndexThreshold: number;
}

export interface RoutingDeps {
  db: Db;
  getSessionId: () => string;
  getCwd: () => string;
  config: RoutingConfig;
  indexLargeOutput?: (text: string, source: string) => void;
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  tracking: true,
  secretScrub: true,
  injectionScan: true,
  autoIndexThreshold: 10_000,
};

const OVERRIDDEN = new Set(["edit", "write"]); // their override already records the after-event

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content.filter((p: any) => p?.type === "text").map((p: any) => p.text ?? "").join("");
}

export function registerRouting(pi: ExtensionAPI, deps: RoutingDeps): void {
  registerEditWriteOverrides(pi as unknown as { registerTool: Function }, deps);

  pi.on("tool_call", (event: any, ctx) => {
    const tool = event?.toolName;
    if (tool === SPIDER_TOOL_NAME) {
      return guardForegroundSleep(event.input, sessionIdFromCtx(ctx) || deps.getSessionId());
    }
    if (!tool || isExempt(tool) || !deps.config.tracking) return;
    recordIntent(deps.db, { sessionId: deps.getSessionId(), tool, payload: sanitizeIntentPayload(event.input),
      toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId });
    return;
  });

  pi.on("tool_result", (event: any) => {
    const tool = event?.toolName;
    if (!tool) return;
    const text = textOf(event.content);
    const safe = processToolContent(text, isExempt(tool) ? { ...deps.config, injectionScan: false } : deps.config);
    const details = scrubToolData(event.details, deps.config.secretScrub);
    const structured = scrubToolData(event.structuredContent, deps.config.secretScrub);
    if (isExempt(tool)) {
      if (safe.changed || details.changed || structured.changed) return { content: [{ type: "text", text: safe.content }], details: details.value, structuredContent: structured.value };
      return;
    }
    // Auto-index the SCRUBBED content (never the raw output) so secrets never enter
    // the recall corpus (content/content_fts/embeddings).
    if (safe.content.length >= deps.config.autoIndexThreshold) {
      autoIndexOutput(deps.db, safe.content, `tool:${tool}`, {
        threshold: deps.config.autoIndexThreshold,
        indexLargeOutput: deps.indexLargeOutput,
      });
    }
    if (deps.config.tracking) {
      const activity = { sessionId: deps.getSessionId(), tool, flagged: safe.flagged,
        toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId };
      if (OVERRIDDEN.has(tool)) correlateResult(deps.db, activity);
      else recordResult(deps.db, activity);
    }
    if (safe.changed || details.changed || structured.changed) return {
      content: safe.changed ? [{ type: "text", text: safe.content }] : event.content,
      details: details.value, structuredContent: structured.value,
    };
    return;
  });
}
