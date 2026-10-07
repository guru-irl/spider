/** Code-only dashboard failure diagnostics. Never accept arbitrary exception text. */
export const usageServerCrashCodes: ReadonlySet<string> = new Set([
  "usage-server-crashed", "usage-server-startup-invalid", "usage-server-not-ready", "usage-server-spawn-failed",
  "usage-server-close-failed", "usage-server-unsupported-runtime", "usage-server-unsupported-platform",
  "usage-server-busy", "usage-server-build-invalid",
]);
