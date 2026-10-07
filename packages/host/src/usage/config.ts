export type UsageConfig = { calibration: "auto" | "off"; footer: boolean; counterPoll: boolean; alertsSessionCredits: number; alertsRunCredits: number };
export const USAGE_DEFAULTS: Readonly<{ "usage.calibration": "auto" | "off"; "usage.footer": boolean; "usage.counter.poll": boolean; "usage.alerts.sessionCredits": number; "usage.alerts.runCredits": number }> = Object.freeze({
  "usage.calibration": "auto", "usage.footer": true, "usage.counter.poll": true,
  "usage.alerts.sessionCredits": 0, "usage.alerts.runCredits": 0,
});
export function isUsageConfigKey(key: string): key is keyof typeof USAGE_DEFAULTS {
  return Object.hasOwn(USAGE_DEFAULTS, key);
}
export function usageConfigError(key: string, value: unknown): string | undefined {
  if (!isUsageConfigKey(key)) return undefined;
  if (key === "usage.calibration") {
    if (value !== "auto" && value !== "off") return `${key} must be auto or off`;
  } else if (typeof USAGE_DEFAULTS[key] === "boolean") {
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
    if (Object.hasOwn(local, key)) errors.push(`${key} is ignored: global scope only (remove with /spider config unset ${key})`);
    if (!Object.hasOwn(global, key)) continue;
    const error = usageConfigError(key, global[key]);
    if (error) errors.push(error);
    else values[key] = global[key];
  }
  return { value: { calibration: values["usage.calibration"] as "auto" | "off", footer: values["usage.footer"] as boolean, counterPoll: values["usage.counter.poll"] as boolean,
    alertsSessionCredits: values["usage.alerts.sessionCredits"] as number, alertsRunCredits: values["usage.alerts.runCredits"] as number }, errors };
}
