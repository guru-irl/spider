export const USAGE_HTTP_DRAIN_MS = 2000;
export const USAGE_PARTICIPANT_STOP_MS = 2000;
export const USAGE_REPLACEMENT_MARGIN_MS = 500;
export const USAGE_REPLACEMENT_GRACE_MS: number = USAGE_HTTP_DRAIN_MS + USAGE_PARTICIPANT_STOP_MS + USAGE_REPLACEMENT_MARGIN_MS;
export const USAGE_LAUNCH_DEADLINE_MS = 5000;
export const USAGE_STARTUP_WINDOW_MS = 5000;
export const USAGE_PROCESS_CHECK_TIMEOUT_MS = 2000;
// Thirty-minute server idle window plus five minutes for older unfenced records.
export const USAGE_LEGACY_FENCE_MS: number = 35 * 60 * 1000;
