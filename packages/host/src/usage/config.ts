export type UsageConfig = { footer: boolean; counterPoll: boolean; alertsSessionCredits: number; alertsRunCredits: number };
export const USAGE_DEFAULTS: Readonly<{ "usage.footer": boolean; "usage.counterPoll": boolean; "usage.alertsSessionCredits": number; "usage.alertsRunCredits": number }> = Object.freeze({
  "usage.footer": true, "usage.counterPoll": true,
  "usage.alertsSessionCredits": 0, "usage.alertsRunCredits": 0,
});
export function isUsageConfigKey(key: string): key is keyof typeof USAGE_DEFAULTS {
  return Object.hasOwn(USAGE_DEFAULTS, key);
}
export function usageConfigError(key: string, value: unknown): string | undefined {
  if (!isUsageConfigKey(key)) return undefined;
  if (typeof USAGE_DEFAULTS[key] === "boolean") {
    if (typeof value !== "boolean") return `${key} must be a boolean`;
  } else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return `${key} must be a finite nonnegative number`;
  }
  return undefined;
}
export function readUsageConfig(global: Record<string, unknown>, local: Record<string, unknown>): { value: UsageConfig; errors: readonly string[] } {
  const values: Record<string, unknown> = { ...USAGE_DEFAULTS };
  const errors: string[] = [];
  for (const key of Object.keys(USAGE_DEFAULTS)) {
    if (Object.hasOwn(local, key)) errors.push(`${key} is ignored: global scope only`);
    if (!Object.hasOwn(global, key)) continue;
    const error = usageConfigError(key, global[key]);
    if (error) errors.push(error);
    else values[key] = global[key];
  }
  return { value: { footer: values["usage.footer"] as boolean, counterPoll: values["usage.counterPoll"] as boolean,
    alertsSessionCredits: values["usage.alertsSessionCredits"] as number, alertsRunCredits: values["usage.alertsRunCredits"] as number }, errors };
}
