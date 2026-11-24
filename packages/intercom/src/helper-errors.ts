/**
 * Helper exchange error codes. This module has no imports, so plain Node children that strip
 * types (for example the roaming artifact processes) can load it without the TypeScript loader.
 */
export const HELPER_EXCHANGE_ERRORS: readonly string[] = ["machine-not-enrolled", "machine-mismatch", "stale-generation", "invalid-request",
  "invalid-presence", "invalid-refusal", "invalid-receipt", "invalid-reply", "peer-version-mismatch", "unsupported-broker", "helper-unauthorized",
  "cli-aborted", "bridge-unavailable", "exchange-too-large", "endpoint-exited", "peer-revoked", "peer-consent-required", "intercom-requires-hub",
  "intercom-transition-unsupported", "intercom-transition-conflict", "intercom-topology-invalid"];
export const isHelperExchangeError = (value: unknown): value is string => typeof value === "string" && HELPER_EXCHANGE_ERRORS.includes(value);
