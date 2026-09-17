import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Db } from "@spider/db-core";
import { recordIntent, recordResult, isExempt } from "./tracking";
import { processToolContent, sanitizeIntentPayload } from "./safety";
import { autoIndexOutput } from "./autoindex";
import { registerEditWriteOverrides } from "./overrides";
import { consumeToolCallError } from "../result";

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

  pi.on("tool_call", (event: any) => {
    const tool = event?.toolName;
    if (!tool || isExempt(tool) || !deps.config.tracking) return;
    recordIntent(deps.db, { sessionId: deps.getSessionId(), tool, payload: sanitizeIntentPayload(event.input) });
    return; // never block
  });

  pi.on("tool_result", (event: any) => {
    const tool = event?.toolName;
    // Mechanism (B) (pi-tool-error-contract-report.md §2b/§3): a genuinely failed
    // spider action already computed a correct isError (exec/exec_file/batch/kill/
    // message; see extension.ts's execute()), which extension.ts marked against this
    // exact toolCallId. A-M1: the SAME mechanism now ALSO covers overrides.ts's edit/
    // write validation failures (routing/overrides.ts) — so this is no longer gated to
    // `tool === SPIDER_TOOL_NAME`; any tool whose toolCallId was marked gets flagged,
    // regardless of which tool it was. Consume the mark FIRST, before the isExempt
    // early-return below, so the flag actually reaches pi. One-shot
    // (consumeToolCallError deletes on read): does not fire again for the same call,
    // and never fires at all for the ordinary (unmarked) case, which keeps falling
    // through to the unchanged isExempt branch immediately below.
    if (consumeToolCallError(event?.toolCallId)) {
      return { isError: true, content: event.content, details: event.details };
    }
    if (!tool || isExempt(tool)) return;
    const text = textOf(event.content);
    const safe = processToolContent(text, deps.config);
    // Auto-index the SCRUBBED content (never the raw output) so secrets never enter
    // the recall corpus (content/content_fts/embeddings).
    if (safe.content.length >= deps.config.autoIndexThreshold) {
      autoIndexOutput(deps.db, safe.content, `tool:${tool}`, {
        threshold: deps.config.autoIndexThreshold,
        indexLargeOutput: deps.indexLargeOutput,
      });
    }
    if (!OVERRIDDEN.has(tool) && deps.config.tracking) {
      recordResult(deps.db, { sessionId: deps.getSessionId(), tool, flagged: safe.flagged });
    }
    if (safe.changed) return { content: [{ type: "text", text: safe.content }] };
    return;
  });
}
