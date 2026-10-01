/** Ordered pi 0.87 thinking levels, including coding-agent's off switch. */
const ORDERED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const THINKING_LEVELS: typeof ORDERED_THINKING_LEVELS = Object.freeze(ORDERED_THINKING_LEVELS);
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export interface ThinkingModel {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}
export interface ThinkingResolution {
  requested?: ThinkingLevel;
  /** Undefined means the model or the child's default thinking is not known. */
  effective?: ThinkingLevel;
  supported?: ThinkingLevel[];
  /** Explicit provider mapping, when different from the chosen pi level. */
  providerValue?: string;
  notice?: string;
}
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}
export function thinkingFromModel(model: string | undefined): ThinkingLevel | undefined {
  const suffix = model?.slice(model.lastIndexOf(":") + 1);
  return model?.includes(":") && isThinkingLevel(suffix) ? suffix : undefined;
}
export function stripThinkingSuffix(model: string | undefined): string | undefined {
  return thinkingFromModel(model) ? model!.slice(0, model!.lastIndexOf(":")) : model;
}
export function supportedThinkingLevels(model: ThinkingModel): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter(level => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}
/** Mirrors pi-ai getSupportedThinkingLevels/clampThinkingLevel: prefer upward
 * across a hole, then downward. Undefined extended levels are unsupported. */
export function resolveThinking(model: ThinkingModel | undefined, requested?: string): ThinkingResolution {
  if (requested !== undefined && !isThinkingLevel(requested)) throw Error(`invalid thinking level '${requested}' (valid: ${THINKING_LEVELS.join(", ")})`);
  if (!model) return { requested, effective: undefined, notice: requested ? `thinking unverified: unknown model, requested ${requested}; cannot verify the level used` : undefined };
  const supported = supportedThinkingLevels(model);
  if (!model.reasoning) return { requested, effective: "off", supported, notice: requested && requested !== "off" ? `thinking is off for this model (reasoning: false); requested ${requested}` : undefined };
  if (!requested) return { supported };
  const index = THINKING_LEVELS.indexOf(requested);
  const effective = supported.includes(requested) ? requested
    : THINKING_LEVELS.slice(index).find(level => supported.includes(level))
      ?? [...THINKING_LEVELS.slice(0, index)].reverse().find(level => supported.includes(level)) ?? "off";
  let notice: string | undefined;
  if (effective !== requested) {
    const highest = supported.at(-1) ?? "off";
    notice = THINKING_LEVELS.indexOf(effective) < index
      ? `thinking capped: requested ${requested}, model supports up to ${highest}; using ${effective}`
      : `thinking adjusted: requested ${requested} is unsupported; using ${effective} (pi chooses the next supported higher level)`;
  }
  const mapped = model.thinkingLevelMap?.[effective];
  const providerValue = typeof mapped === "string" && mapped !== effective ? mapped : undefined;
  if (providerValue && notice) notice += ` (provider value: ${providerValue})`;
  return { requested, effective, supported, ...(providerValue ? { providerValue } : {}), notice };
}
