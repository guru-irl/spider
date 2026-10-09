import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from '@spider/db-core';

/** Measurement labels only. These impose no summary instructions or limits. */
export const SUMMARY_SECTION_NAMES: readonly string[] = ['Goal', 'Constraints & Preferences', 'Done',
  'In Progress', 'Blocked', 'Key Decisions', 'Next Steps', 'Critical Context'];
export const COMPACTION_DEFAULTS: Readonly<Record<string, unknown>> = {
  'compaction.summaryModel': null,
  'compaction.summaryThinking': 'high',
  'compaction.fileListCap': 500,
  'compaction.minSummaryOutputTokens': 64000,
};
export interface CompactionConfig {
  summaryModel: string | null;
  summaryThinking: ThinkingLevel;
  fileListCap: number;
  minSummaryOutputTokens: number;
}
export function compactionConfigError(key: string, value: unknown): string | undefined {
  if (!Object.hasOwn(COMPACTION_DEFAULTS, key)) return undefined;
  switch (key) {
    case 'compaction.summaryModel':
      if (value === null || (typeof value === 'string' && /^[^/\s]+\/\S+$/.test(value))) return undefined;
      return `${key} must be provider/model or null`;
    case 'compaction.summaryThinking':
      return isThinkingLevel(value) ? undefined : `${key} must be one of ${THINKING_LEVELS.join(', ')}`;
    default:
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 &&
        (key !== 'compaction.minSummaryOutputTokens' || value <= Math.floor(Number.MAX_SAFE_INTEGER * 0.8))
        ? undefined : `${key} must be a non-negative safe integer`;
  }
}
/** Snapshot at attempt time. Invalid raw values fall back to defaults, not an enabled summary model. */
export function readCompactionConfig(values: Record<string, unknown>): CompactionConfig {
  const effective = Object.fromEntries(Object.entries(COMPACTION_DEFAULTS).map(([key, fallback]) => {
    const value = values[key];
    return [key, value === undefined || compactionConfigError(key, value) ? fallback : value];
  }));
  return {
    summaryModel: effective['compaction.summaryModel'] as string | null,
    summaryThinking: effective['compaction.summaryThinking'] as ThinkingLevel,
    fileListCap: effective['compaction.fileListCap'] as number,
    minSummaryOutputTokens: effective['compaction.minSummaryOutputTokens'] as number,
  };
}
