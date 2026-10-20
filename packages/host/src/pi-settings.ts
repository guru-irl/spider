import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { safeError } from "@spider/organism";

const boolean = (value: unknown, fallback: boolean): string => value === undefined ? String(fallback) : typeof value === "boolean" ? String(value) : "invalid";
const integer = (value: unknown, fallback: number): string => value === undefined ? String(fallback)
  : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "invalid";
const number = (value: unknown, fallback: number): string => value === undefined ? String(fallback)
  : typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : "invalid";
const choice = (value: unknown, fallback: string, allowed: string[]): string => value === undefined ? fallback
  : typeof value === "string" && allowed.includes(value) ? value : "invalid";

/** getSettings returns a copy; never modify it or print arbitrary keys or values. */
export function piSettingsDoctorLines(pi: Pick<ExtensionAPI, "getSettings">, model?: string): string[] {
  try {
    const settings = pi.getSettings();
    const compaction = settings.compaction;
    const override = model ? compaction?.modelOverrides?.[model] : undefined;
    return [
      `- pi compaction: enabled=${boolean(compaction?.enabled, true)} reserveTokens=${integer(override?.reserveTokens ?? compaction?.reserveTokens, 16384)} keepRecentTokens=${integer(override?.keepRecentTokens ?? compaction?.keepRecentTokens, 20000)}`,
      `- pi cache warming: ${choice(settings.cacheWarming, "streaming", ["off", "streaming", "idle"])}`,
      `- pi codemode: mode=${choice(settings.codemode?.mode, "on", ["on", "only"])} inlineBudget=${number(settings.codemode?.inlineBudget, 3000)} (settings, not active tools)`,
      `- pi TUI mode: ${choice(settings.tuiMode, "fullscreen", ["regular", "fullscreen"])}`,
      `- pi install telemetry: ${boolean(settings.enableInstallTelemetry, true)}`,
    ];
  } catch (error) {
    return [`- pi settings unavailable: ${safeError(error)}`];
  }
}
