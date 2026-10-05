import { priceCall } from "./price.js";
import type { UsageTokens } from "./types.js";

export type FooterTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  piCost: number;
  aic: number;
  unpricedEntries: number;
  aggregateEntries: number;
  estimated: boolean;
  latestCacheHitRate: number | null;
};

function emptyTotals(): FooterTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, piCost: 0, aic: 0,
    unpricedEntries: 0, aggregateEntries: 0, estimated: false, latestCacheHitRate: null };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Callers supply all entries on reset and only the newly persisted suffix on append. */
export class FooterAccumulator {
  private totals = emptyTotals();

  reset(entries: readonly unknown[]): void {
    this.totals = emptyTotals();
    this.append(entries);
  }

  append(entries: readonly unknown[]): void {
    for (const value of entries) {
      const entry = record(value);
      if (!entry) continue;
      const message = entry.type === "message" ? record(entry.message) : undefined;
      const assistant = message?.role === "assistant";
      const summary = entry.type === "compaction" || entry.type === "branch_summary";
      const source = entry.type === "usage" || summary ? entry
        : assistant || message?.role === "toolResult" ? message : undefined;
      const raw = record(source?.usage);
      if (!raw) continue;
      const usage = raw as unknown as UsageTokens;
      // The four buckets already include reasoning and one-hour cache writes.
      this.totals.input += tokenCount(usage.input);
      this.totals.output += tokenCount(usage.output);
      this.totals.cacheRead += tokenCount(usage.cacheRead);
      this.totals.cacheWrite += tokenCount(usage.cacheWrite);
      const cost = record(raw.cost)?.total;
      if (typeof cost === "number" && Number.isFinite(cost)) this.totals.piCost += cost;
      if (assistant) {
        const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
        this.totals.latestCacheHitRate = Number.isFinite(prompt) && prompt > 0
          && [usage.input, usage.cacheRead, usage.cacheWrite].every(value => Number.isFinite(value) && value >= 0)
          ? usage.cacheRead / prompt * 100 : null;
      }

      const aggregate = entry.type === "usage" && entry.kind === "subagent";
      if (aggregate) this.totals.aggregateEntries++;
      // Tools and summaries have no public billing-model attribution. Never borrow
      // a nearby model_change or the currently selected model for their pricing.
      const attributed = assistant || entry.type === "usage";
      const provider = attributed ? text(source?.provider) : null;
      const model = attributed ? text(assistant ? source?.responseModel ?? source?.model : source?.model) : null;
      const entryTime = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      const at = Number.isFinite(entryTime) ? entryTime
        : typeof message?.timestamp === "number" ? message.timestamp : NaN;
      const price = priceCall({ provider, id: model }, usage, at, { aggregate });
      if (price.status === "priced") {
        this.totals.aic += price.aic;
        this.totals.estimated ||= price.confidence === "estimated";
      } else {
        this.totals.unpricedEntries++;
      }
      this.totals.estimated ||= aggregate;
    }
  }

  snapshot(): FooterTotals {
    return { ...this.totals };
  }
}
