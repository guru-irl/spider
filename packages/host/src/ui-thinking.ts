import { THINKING_LEVELS, stripThinkingSuffix, supportedThinkingLevels } from "@spider/db-core";
import { createConfigSchema, type ConfigGroup, type ModelThinkingDisplay } from "@spider/ui";
import type { ModelEntry } from "@spider/models";

/** The host owns policy; UI receives only plain schema and presentation data. */
export const UI_CONFIG_SCHEMA: ConfigGroup[] = createConfigSchema(THINKING_LEVELS);
export function modelThinkingDisplay(entries: ModelEntry[], defaults: Record<string, string>): ModelThinkingDisplay {
  return {
    levelsByRef: Object.fromEntries(entries.map(entry => [`${entry.provider}/${entry.id}`,
      supportedThinkingLevels({ reasoning: entry.thinking, thinkingLevelMap: entry.thinkingLevelMap })])),
    baseDefaults: Object.fromEntries(Object.entries(defaults).map(([role, ref]) => [role, stripThinkingSuffix(ref)!])),
  };
}
