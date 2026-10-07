export const DEFAULT_VERIFY_TIMEOUT_MS: number;
export const DEFAULT_CLI_TIMEOUT_MS: number;
export const BROWSER_TEST_TIMEOUT_MS: number;
export type CapturePage = {
  readonly pid: number;
  readonly blockedRequests: number;
  evaluate(expression: string): Promise<unknown>;
  /** Real keyboard input, not DOM focus simulation. */
  pressKey(key: "Tab"): Promise<void>;
  /** Real pointer input at viewport CSS coordinates. */
  click(x: number, y: number): Promise<void>;
  /** A basename under out, never a caller-selected path. */
  screenshot(name: string, fullPage?: boolean): Promise<string>;
};
export type DashboardRoute = {
  /** UTF-8 text, intact binary bytes, or already base64-encoded bytes. */
  body: string | Buffer | Uint8Array | { base64: string };
  /** Match this pathname even when the client adds a query. Exact matching is the default. */
  ignoreSearch?: boolean;
  contentType?: string;
  status?: number;
  headers?: { name: string; value: string }[];
};
export type CaptureOptions = {
  html: string;
  /** Optional offline responses served at https://dashboard.invalid/.
   * Invalid or absent bodies reject before launch with invalid-route-body. */
  routes?: Record<string, DashboardRoute>;
  /** CSS-pixel capture dimensions, default 1440 by 1000. */
  viewport?: { width: number; height: number };
  /** Capture the full CSS layout via DevTools, keeping the viewport unchanged. Default false. */
  fullPage?: boolean;
  out?: string;
  /** Caller-owned scratch, independent of screenshot output. */
  scratchDir?: string;
  browser?: string;
  /** Bounds each CDP command, in milliseconds. */
  timeoutMs?: number;
  /** Browser startup budget, independent of each command (default 20 seconds). */
  startupTimeoutMs?: number;
  /** Opt-in process SIGINT/SIGTERM listeners. Default false in the library,
   * true in the CLI. Cleanup finishes before rejection with exitCode 130/143.
   * The library never calls process.exit or changes process.exitCode. */
  installSignalHandlers?: boolean;
  /** Bounds the overall verification callback, independently of commands. */
  verifyTimeoutMs?: number;
  verify?: (page: CapturePage) => Promise<void>;
  /** Verify live page state after capture, before closing the browser. Uses verifyTimeoutMs. */
  verifyAfterCapture?: (page: CapturePage) => Promise<void>;
};
export function screenshotSkipReason(env?: NodeJS.ProcessEnv): string | null;
export function captureDashboard(options: CaptureOptions): Promise<string>;
/** Recover only process groups whose ps command line carries a private profile. */
export function closeOwnedBrowserProfiles(root: string): void;
