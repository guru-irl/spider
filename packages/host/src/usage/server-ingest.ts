import type { DashboardIngestState, IngestHandle, IngestOptions } from "./dashboard-contract.js";
import type { UsageRuntimeSnapshot } from "./protocol.js";
import { UsageRuntime } from "./runtime.js";

export type ServerIngestOptions = IngestOptions & {
  /** Read the current reloadable config, never a frozen startup default. */
  getCalibrationMode: () => "auto" | "off";
};

/** The HTTP process holds no ledger; its worker writes only during a pass and never polls. */
export function startUsageServerIngest(options: ServerIngestOptions): IngestHandle {
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let calibrationError: string | null = null;
  const state = (snapshot: UsageRuntimeSnapshot): DashboardIngestState => ({
    role: stopped ? "inactive" : snapshot.ingestRole ?? "inactive",
    lastIngestAt: snapshot.health?.lastIngestAt ?? null,
    backfill: snapshot.backfill,
    ...(snapshot.progress ? { progress: { ...snapshot.progress } } : {}),
    errorCode: calibrationError ?? snapshot.errorCode,
  });
  const runtime = new UsageRuntime({
    bundleUrl: options.bundleUrl, roots: options.roots, child: false, dashboardMode: true,
    onSnapshot: snapshot => options.onSnapshot?.(state(snapshot)),
  });
  let mode: "auto" | "off" = "off";
  const readMode = (): "auto" | "off" => {
    try { const current = options.getCalibrationMode(); calibrationError = null; return current; }
    catch { calibrationError = "usage-calibration-config-failed"; return mode; }
  };
  mode = readMode();
  runtime.start(false, mode);
  const reload = setInterval(() => {
    const current = readMode();
    if (calibrationError) options.onSnapshot?.(state(runtime.snapshot()));
    if (current !== mode) { mode = current; runtime.configure(false, mode); }
  }, 3000);
  reload.unref?.();
  return {
    snapshot: () => state(runtime.snapshot()),
    stop: () => {
      if (stopping) return stopping;
      stopped = true; clearInterval(reload);
      return stopping = runtime.stop();
    },
  };
}
