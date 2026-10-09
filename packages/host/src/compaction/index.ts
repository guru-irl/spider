/**
 * Opt-in per-model compaction. Child drafts mirror pi 0.87's unexported
 * recovery cut correction. File operations mirror pi 1.0.1's helpers, with
 * marked-hook checkpoint recovery. Re-run differential fuzz on pi upgrades.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir,
  buildSessionProjection,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  findCutPoint,
  generateSummaryWithUsage,
  sessionEntryToContextMessages,
  SettingsManager,
  VERSION,
  type CompactionEntry,
  type ProjectedSessionEntry,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { SUMMARY_SECTION_NAMES, readCompactionConfig } from './config.js';
import { legacyCompactionPath, legacyCompactionWarning } from './legacy.js';

function warn(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`spider-compaction: ${message.replace(/[\r\n]+/g, " ")}\n`);
}

/** Map of "provider/id" -> compactAtPercent (0 < pct < 100). */
type ThresholdMap = Map<string, number>;

function normalizePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // 0 (or below) disables; >= 100 is meaningless for an early trigger.
  if (value <= 0 || value >= 100) return null;
  return value;
}

// These file helpers are not root-exported by pi. File ops follow pi 1.0.1's
// compaction/utils.ts; extractFileOperations is minimally mirrored too.
// Also merge our marked hook details; pi itself merges only non-hook details,
// and foreign hook details stay excluded.
type SummaryMessages = Parameters<typeof generateSummaryWithUsage>[0];
function createFileOps() {
  return { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
}
function extractFileOpsFromMessage(message: SummaryMessages[number], fileOps: ReturnType<typeof createFileOps>) {
  if (message.role === "toolResult") {
    // Calls made from codemode scripts are recorded on the script's result.
    // Structural typing keeps this port compatible with pi 0.87's older types.
    const nestedCalls = (message as typeof message & {
      nestedCalls?: { calls: Array<{ name: string; arguments?: Record<string, unknown> }> };
    }).nestedCalls;
    for (const call of nestedCalls?.calls ?? []) addFileOp(call.name, call.arguments, fileOps);
    return;
  }
  if (message.role !== "assistant") return;
  if (!("content" in message) || !Array.isArray(message.content)) return;

  for (const block of message.content) {
    if (typeof block !== "object" || block === null) continue;
    if (!("type" in block) || block.type !== "toolCall") continue;
    if (!("arguments" in block) || !("name" in block)) continue;
    addFileOp(block.name, block.arguments as Record<string, unknown> | undefined, fileOps);
  }
}
function addFileOp(toolName: string, args: Record<string, unknown> | undefined, fileOps: ReturnType<typeof createFileOps>) {
  const path = typeof args?.path === "string" ? args.path : undefined;
  if (!path) return;
  switch (toolName) {
    case "read": fileOps.read.add(path); break;
    case "write": fileOps.written.add(path); break;
    case "edit": fileOps.edited.add(path); break;
  }
}
function extractFileOperations(messages: SummaryMessages, previous?: CompactionEntry) {
  const fileOps = createFileOps();
  const details = previous?.details as { readFiles?: string[]; modifiedFiles?: string[]; source?: unknown } | undefined;
  if (previous && details && (!previous.fromHook ||
    (previous.fromHook === true && (details.source === "per-model-compaction" || details.source === "spider-compaction")))) {
    if (Array.isArray(details.readFiles)) for (const file of details.readFiles) fileOps.read.add(file);
    if (Array.isArray(details.modifiedFiles)) for (const file of details.modifiedFiles) fileOps.edited.add(file);
  }
  for (const message of messages) extractFileOpsFromMessage(message, fileOps);
  return fileOps;
}
function computeFileLists(fileOps: ReturnType<typeof createFileOps>) {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    readFiles: [...fileOps.read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}
/** Current-window last touches first, then the latest checkpoint's stored order. */
function computeMainFileLists(
  messages: SummaryMessages,
  preparedFileOps: ReturnType<typeof createFileOps>,
  branchEntries: SessionEntry[],
  fileListCap: number,
) {
  const recent = createFileOps();
  const record = (name: string, args: Record<string, unknown> | undefined) => {
    // One set for both edit and write preserves their interleaved recency.
    addFileOp(name === "write" ? "edit" : name, args, recent);
  };
  for (const message of [...messages].reverse()) {
    if (message.role === "toolResult") {
      const nested = (message as typeof message & {
        nestedCalls?: { calls: Array<{ name: string; arguments?: Record<string, unknown> }> };
      }).nestedCalls;
      for (const call of [...(nested?.calls ?? [])].reverse()) record(call.name, call.arguments);
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of [...message.content].reverse()) {
        if (block.type === "toolCall") record(block.name, block.arguments);
      }
    }
  }
  const previous = branchEntries.findLast((entry) => entry.type === "compaction");
  const details = previous?.type === "compaction"
    ? previous.details as { readFiles?: string[]; modifiedFiles?: string[]; source?: unknown } | undefined
    : undefined;
  const eligible = previous?.type === "compaction" && (!previous.fromHook || (details?.source === "per-model-compaction" || details?.source === "spider-compaction"));
  const earlier = eligible && details && (Array.isArray(details.readFiles) || Array.isArray(details.modifiedFiles))
    ? { readFiles: details.readFiles ?? [], modifiedFiles: details.modifiedFiles ?? [] }
    : computeFileLists(preparedFileOps);
  const modified = new Set([...recent.edited, ...earlier.modifiedFiles]);
  return {
    readFiles: [...new Set([...recent.read, ...earlier.readFiles])]
      .filter((file) => !modified.has(file)).slice(0, fileListCap || undefined),
    modifiedFiles: [...modified].slice(0, fileListCap || undefined),
  };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]) {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

/** Estimates include section headings and whitespace; Progress is only a container. */
function measureMainSummary(summary: string, fileListText: string) {
  const sectionNames = SUMMARY_SECTION_NAMES;
  const summarySectionTokens: Record<string, number> = Object.fromEntries(sectionNames.map((name) => [name, 0]));
  // Only the plugin-owned suffix is excluded from section parsing. Model text is unchanged.
  const modelText = summary.slice(0, summary.length - fileListText.length);
  let section: string | undefined;
  let fence: { marker: string; length: number } | undefined;
  for (const line of modelText.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const content = line.replace(/\r?\n$/, "");
    const delimiter = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length &&
        delimiter[2].trim() === "") fence = undefined;
    } else if (delimiter) {
      fence = { marker: delimiter[1][0], length: delimiter[1].length };
    } else {
      const heading = content.match(/^ {0,3}#{1,3}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
      if (heading) {
        const name = heading[1].replace(/^\*\*(.*?)\*\*$/, "$1").toLowerCase();
        if (name === "progress") section = undefined;
        else {
          const known = sectionNames.find((key) => key.toLowerCase() === name || (key === "Goal" && name === "goals"));
          if (known) section = known;
        }
      }
    }
    if (section) summarySectionTokens[section] += line.length / 4;
  }
  summarySectionTokens["File Lists"] = fileListText.length / 4;
  return { summarySectionTokens, summaryTotalTokens: summary.length / 4 };
}

// findCutPoint is root-exported, but findProjectedCutPoint is not. Mirror only
// its recovery-omission suffix correction, then redo adjacent-metadata inclusion.
function advanceRecoveryCut(entries: ProjectedSessionEntry[], start: number, cutIndex: number, keepRecentTokens: number) {
  let candidate = cutIndex;
  // Undo the exported finder's metadata inclusion to inspect its original candidate.
  while (candidate < entries.length && entries[candidate].sourceEntry.type !== "compaction" &&
    entries[candidate].messages.length === 0) candidate++;
  const suffix = entries.slice(candidate + 1);
  const isIntrinsicallyVisible = (entry: ProjectedSessionEntry) => entry.sourceEntry.type !== "context_edit" &&
    sessionEntryToContextMessages(entry.sourceEntry).length > 0;
  const isOmitted = (entry: ProjectedSessionEntry) => isIntrinsicallyVisible(entry) && entry.messages.length === 0;
  const omittedSuffixIds = new Set(suffix.filter(isOmitted).map((entry) => entry.sourceEntry.id));
  const hasExternalReplacement = suffix.some((entry) => entry.sourceEntry.type === "context_edit" &&
    entry.sourceEntry.replacement !== null && !omittedSuffixIds.has(entry.sourceEntry.targetId));
  if (hasExternalReplacement ||
    !suffix.some((entry) => entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "assistant" && isOmitted(entry)) ||
    !suffix.every((entry) => entry.sourceEntry.type !== "compaction" && (!isIntrinsicallyVisible(entry) || isOmitted(entry))) ||
    !entries[candidate]?.messages.some((message) => message.role !== "system" && message.role !== "toolResult") ||
    // Pi only exceeds the budget on a nonzero-token message, even when K is zero.
    entries.slice(start).reduce((sum, entry) => sum + entry.messages.reduce((tokens, message) => tokens + estimateTokens(message), 0), 0) < Math.max(1, keepRecentTokens)
  ) return cutIndex;
  cutIndex = candidate + 1;
  while (cutIndex > start && entries[cutIndex - 1].sourceEntry.type !== "compaction" &&
    entries[cutIndex - 1].messages.length === 0) cutIndex--;
  return cutIndex;
}

class SummaryAbortedError extends Error {}

/** Both paths summarize the complete history and any split prefix in one call. */
async function summarize(
  ctx: ExtensionContext,
  messages: SummaryMessages,
  model: Parameters<typeof generateSummaryWithUsage>[1],
  reserveTokens: number,
  signal: AbortSignal | undefined,
  customInstructions: string | undefined,
  previousSummary: string | undefined,
  thinking: Parameters<typeof generateSummaryWithUsage>[8],
  retry: Parameters<typeof generateSummaryWithUsage>[11],
  fileOps: ReturnType<typeof createFileOps>,
  fileLists?: ReturnType<typeof computeFileLists>,
) {
  if (signal?.aborted) throw new SummaryAbortedError("compaction aborted");
  const summary = await generateSummaryWithUsage(
    messages, model, reserveTokens, undefined, undefined, signal,
    customInstructions, previousSummary, thinking,
    async (summaryModel, context, options) => {
      // Registry streaming resolves request-time Copilot auth and provider routing.
      const stream = ctx.modelRegistry.streamSimple(summaryModel, context, options);
      const response = await stream.result();
      if (response.stopReason === "aborted") {
        throw new SummaryAbortedError(`summarization ${response.rawStopReason ?? response.stopReason}`);
      }
      if (response.rawStopReason === "refusal") throw new Error("summarization refusal");
      return stream;
    },
    undefined, retry,
  );
  if (signal?.aborted) throw new SummaryAbortedError("compaction aborted");
  if (!summary.text.trim()) throw new Error("summarization returned no text");
  if (!/^#{1,3}\s*\**Goals?\b/im.test(summary.text)) {
    throw new Error("summarization did not return a structured summary");
  }
  const details = { ...(fileLists ?? computeFileLists(fileOps)), source: "spider-compaction" };
  return {
    summary: summary.text + formatFileOperations(details.readFiles, details.modifiedFiles),
    usage: summary.usage,
    details,
  };
}

export interface CompactionDeps {
  readConfig: (cwd: string) => Record<string, unknown>;
  /** Inject a fixture path in tests instead of an environment override. */
  modelsPath?: string;
}

/** Parent and child paths share the single pi summary call. Registration is inert. */
export function registerCompaction(pi: ExtensionAPI, deps: CompactionDeps): void {
  const isChild = process.env.PI_SUBAGENT_CHILD === "1";
  const modelsPath = deps.modelsPath ?? join(getAgentDir(), 'models.json');
  const warnedSkipReasons = new Set<string>();
  let failedSummaryTokens: number | null | undefined;

  function warnSkip(reason: string) {
    if (warnedSkipReasons.has(reason)) return;
    warnedSkipReasons.add(reason);
    warn(reason);
  }


  let cache: { mtimeMs: number; map: ThresholdMap } | null = null;
  let warnedParseError = false;
  let compacting = false;

  let warnedLegacy = false;
  function inactive(ctx: ExtensionContext, values = deps.readConfig(ctx.cwd)): boolean {
    const legacy = legacyCompactionPath(values);
    if (!legacy) return false;
    if (!warnedLegacy) {
      warnedLegacy = true;
      const message = legacyCompactionWarning(legacy);
      if (ctx.hasUI) ctx.ui.notify(message, 'warning');
      else warn(message.replace(/^spider-compaction: /, ''));
    }
    return true;
  }
  pi.on('session_start', (_event, ctx) => { inactive(ctx); });

  function loadThresholds(ctx: ExtensionContext): ThresholdMap {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(modelsPath).mtimeMs;
    } catch {
      // No models.json at all -> nothing configured.
      return new Map();
    }
    if (cache && cache.mtimeMs === mtimeMs) return cache.map;

    const map: ThresholdMap = new Map();
    try {
      const raw = JSON.parse(readFileSync(modelsPath, "utf8")) as {
        providers?: Record<
          string,
          {
            models?: Array<{ id?: unknown; compactAtPercent?: unknown }>;
            modelOverrides?: Record<string, { compactAtPercent?: unknown }>;
          }
        >;
      };

      for (const [providerId, providerCfg] of Object.entries(raw?.providers ?? {})) {
        for (const model of providerCfg?.models ?? []) {
          const pct = normalizePercent(model?.compactAtPercent);
          if (pct !== null && typeof model?.id === "string") {
            map.set(`${providerId}/${model.id}`, pct);
          }
        }
        for (const [modelId, override] of Object.entries(providerCfg?.modelOverrides ?? {})) {
          const pct = normalizePercent(override?.compactAtPercent);
          if (pct !== null) map.set(`${providerId}/${modelId}`, pct);
        }
      }
      warnedParseError = false;
    } catch (error) {
      // Fail closed: empty map -> pi default behavior for every model.
      if (!warnedParseError && (isChild || ctx.hasUI)) {
        warnedParseError = true;
        const message = error instanceof Error ? error.message : String(error);
        if (isChild) warn(`could not parse models.json (${message})`);
        else ctx.ui.notify(`spider-compaction: could not parse models.json (${message})`, "warning");
      }
      cache = { mtimeMs, map: new Map() };
      return cache.map;
    }

    cache = { mtimeMs, map };
    return map;
  }

  if (isChild) {
    if (!VERSION.startsWith("0.87.")) {
      warnSkip(`mirrored pi 0.87 internals; running ${VERSION}, re-run the fuzz`);
    }
    pi.on("turn_end", async (event, ctx) => {
      if (inactive(ctx)) return;
      if (
        compacting ||
        event.outcome !== "completed" ||
        event.toolResults.length === 0 ||
        event.entries.some((entry) => entry.type === "compaction") ||
        ctx.signal?.aborted
      ) return;

      let attemptTokens: number | null | undefined;
      try {
        const model = ctx.model;
        if (!model) return;
        const threshold = loadThresholds(ctx).get(`${model.provider}/${model.id}`);
        if (threshold === undefined) return;
        const usage = ctx.getContextUsage();
        if (!usage || usage.percent === null || usage.percent < threshold) return;

        if (event.entries.some((entry) => entry.type === "context_edit")) {
          warnSkip("pending context edit; skipping this turn");
          return;
        }
        compacting = true;
        const settingsManager = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
        const settings = {
          ...DEFAULT_COMPACTION_SETTINGS,
          ...settingsManager.getCompactionSettings(model),
        };
        if (failedSummaryTokens !== undefined && (
          failedSummaryTokens === null || usage.tokens == null ||
          !(usage.tokens - failedSummaryTokens >= settings.keepRecentTokens)
        )) {
          warnSkip("failed summary back-off; waiting for keepRecentTokens of token growth");
          return;
        }
        // Projection starts with the latest summary, then its firstKeptEntryId
        // range and the new tail. It also applies context edits and converts
        // custom_message and branch_summary entries using pi's own rules.
        const projected = buildSessionProjection(ctx.sessionManager.getBranch()).entries;
        const previous = projected[0]?.sourceEntry;
        const start = previous?.type === "compaction" ? 1 : 0;
        const previousSummary = previous?.type === "compaction" ? previous.summary : undefined;

        // Let the exported cut finder see edited, model-visible messages, not
        // omitted raw content. Preserve IDs and invisible metadata boundaries.
        const cutEntries: SessionEntry[] = projected.map(({ sourceEntry, messages }) => {
          if (sourceEntry.type === "compaction") return { ...sourceEntry, summary: "", systemMessage: undefined };
          if (messages.length > 0) return { ...sourceEntry, type: "message", message: messages[0] };
          return { ...sourceEntry, type: "custom", customType: "per-model-compaction-invisible" };
        });
        const cut = findCutPoint(cutEntries, start, cutEntries.length, settings.keepRecentTokens);
        // Defensive: advancement is unreachable at the current completed-tool-turn gate,
        // but kept for pi parity if that gate changes.
        const firstKeptEntryIndex = advanceRecoveryCut(projected, start, cut.firstKeptEntryIndex, settings.keepRecentTokens);
        const firstKeptEntryId = projected[firstKeptEntryIndex]?.sourceEntry.id;
        // Include the complete history AND any split-turn prefix in one call.
        // System state is checkpointed by pi when it appends the draft.
        const messages = projected.slice(start, firstKeptEntryIndex).flatMap((entry) =>
          entry.sourceEntry.type === "compaction" ? [] : entry.messages.filter((message) => message.role !== "system"),
        );
        if (!firstKeptEntryId || messages.length === 0) {
          warnSkip("nothing to compact");
          return;
        }
        if (messages.reduce((tokens, message) => tokens + estimateTokens(message), 0) < settings.keepRecentTokens) {
          warnSkip("too little to compact");
          return;
        }

        const fileOps = extractFileOperations(messages, previous?.type === "compaction" ? previous : undefined);
        attemptTokens = usage.tokens ?? null;
        const summary = await summarize(
          ctx, messages, model, settings.reserveTokens, ctx.signal,
          undefined, previousSummary, pi.getThinkingLevel(),
          settingsManager.getRetrySettings(), fileOps,
        );
        failedSummaryTokens = undefined;
        return {
          entries: [...event.entries, {
            type: "compaction" as const,
            ...summary,
            firstKeptEntryId,
          }],
        };
      } catch (error) {
        if (attemptTokens !== undefined) failedSummaryTokens = attemptTokens;
        warn(error);
      } finally {
        compacting = false;
      }
    });
    return; // Never pay for agent_end compaction after child work is finished.
  }

  pi.on("session_before_compact", async (event, ctx) => {
    const values = deps.readConfig(ctx.cwd);
    if (inactive(ctx, values)) return;
    const config = readCompactionConfig(values);
    const SUMMARY_MODEL = config.summaryModel;
    if (SUMMARY_MODEL === null) return;
    const SUMMARY_THINKING = config.summaryThinking;
    const SUMMARY_MIN_RESERVE_TOKENS = Math.ceil(config.minSummaryOutputTokens / 0.8);
    // Throwing here does not cancel compaction: pi's extension runner catches
    // handler errors. Return the documented cancellation result on abort instead.
    if (event.signal.aborted) return { cancel: true };
    try {
      const separator = SUMMARY_MODEL.indexOf("/");
      const model = ctx.modelRegistry.find(SUMMARY_MODEL.slice(0, separator), SUMMARY_MODEL.slice(separator + 1));
      if (!model) throw new Error("model not found in registry");
      if (!ctx.modelRegistry.getAvailable().some((available) =>
        available.provider === model.provider && available.id === model.id)) {
        throw new Error("model not available (authentication or provider availability)");
      }
      const { preparation } = event;
      const settingsManager = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
      const summary = await summarize(
        ctx, [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
        model, Math.max(preparation.settings.reserveTokens, SUMMARY_MIN_RESERVE_TOKENS), event.signal,
        event.customInstructions, preparation.previousSummary, SUMMARY_THINKING,
        settingsManager.getRetrySettings(), preparation.fileOps,
        computeMainFileLists(
          [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
          preparation.fileOps, event.branchEntries, config.fileListCap,
        ),
      );
      const measurements = measureMainSummary(
        summary.summary, formatFileOperations(summary.details.readFiles, summary.details.modifiedFiles),
      );
      return {
        compaction: {
          ...summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { ...summary.details, summaryModel: SUMMARY_MODEL, summaryThinking: SUMMARY_THINKING, ...measurements },
        },
      };
    } catch (error) {
      if (event.signal.aborted || error instanceof SummaryAbortedError) return { cancel: true };
      // If the configured summary fails after an earlier hook compaction, pi 0.87's default fallback
      // recomputes file lists from its own preparation and drops our earlier capped
      // lists because it ignores hook file details. Accepted: preserving them needs a pi change.
      const reason = error instanceof Error ? error.message : String(error);
      const message = `spider-compaction: ${SUMMARY_MODEL} summary failed (${reason}); using default compaction`;
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else warn(message.replace(/^spider-compaction: /, ""));
      return;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (inactive(ctx)) return;
    if (compacting) return; // don't stack compactions
    const model = ctx.model;
    if (!model) return;

    const threshold = loadThresholds(ctx).get(`${model.provider}/${model.id}`);
    if (threshold === undefined) return; // unlisted -> leave to pi's built-in compaction

    const usage = ctx.getContextUsage();
    // percent is null right after a compaction (tokens unknown) -> skip.
    if (!usage || usage.percent === null) return;
    if (usage.percent < threshold) return;

    compacting = true;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Auto-compacting ${model.id} at ${usage.percent.toFixed(1)}% (threshold ${threshold}%)`,
        "info",
      );
    }
    ctx.compact({
      onComplete: (result) => {
        compacting = false;
        const details = result.details as { summaryModel?: unknown } | undefined;
        const summarizer = typeof details?.summaryModel === "string" ? details.summaryModel : undefined;
        const label = summarizer ? `summary by ${summarizer.slice(summarizer.indexOf("/") + 1)}` : model.id;
        if (ctx.hasUI) ctx.ui.notify(`Compaction complete (${label})`, "info");
      },
      onError: (error) => {
        compacting = false;
        if (ctx.hasUI) ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
      },
    });
  });
}
