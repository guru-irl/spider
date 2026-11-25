import {
  FrameScheduler, projectRow,
  type AgentSnapshot, type AgentStore, type DetailRead, type RunCostFormatter, type RunSource,
} from "@spider/ui";

export interface DetailRefreshOptions {
  source: RunSource;
  store: AgentStore;
  runId: string;
  apply(read: DetailRead): void;
  applyRun(run: AgentSnapshot): void;
  requestRender(): void;
  formatRunCost?: RunCostFormatter;
}

/** Read complete snapshots on invalidation, never from a render or ticker. */
export function startDetailRefresh(opts: DetailRefreshOptions): () => void {
  let disposed = false;
  let selected = opts.store.snapshot().find(run => run.runId === opts.runId);
  let offSource: () => void = () => {};
  let offStore: () => void = () => {};
  const withCost = (run: AgentSnapshot): AgentSnapshot => opts.formatRunCost && run.usageCosts
    ? { ...run, costText: opts.formatRunCost(run.usageCosts) } : run;
  const load = () => {
    if (disposed) return;
    let read: DetailRead;
    try {
      const row = opts.source.getRun(opts.runId);
      const events = opts.source.listEvents?.(opts.runId) ?? [];
      const run = row ? projectRow(row) : undefined;
      if (run && selected) {
        run.activity = selected.activity;
        run.activityTool = selected.activityTool;
        run.recentActivity = selected.recentActivity;
      }
      read = { kind: "loaded", run: run ? withCost(run) : undefined, events };
    } catch { read = { kind: "failed" }; }
    if (disposed) return;
    opts.apply(read);
    if (!disposed) opts.requestRender();
  };
  const scheduler = new FrameScheduler(load, { frameMs: 100 });
  const stop = () => {
    if (disposed) return;
    disposed = true;
    scheduler.dispose(); offSource(); offStore();
  };
  try {
    offSource = opts.source.subscribe(event => {
      if (!disposed && event.runId === opts.runId) scheduler.request();
    });
    offStore = opts.store.onChange(() => {
      if (disposed) return;
      const next = opts.store.snapshot().find(run => run.runId === opts.runId);
      if (next === selected) return;
      selected = next;
      if (next) {
        let formatted: AgentSnapshot;
        try { formatted = withCost(next); }
        catch {
          opts.apply({ kind: "failed" });
          if (!disposed) { opts.requestRender(); scheduler.request(); }
          return;
        }
        opts.applyRun(formatted);
        if (disposed) return;
        opts.requestRender();
      }
      if (!disposed) scheduler.request();
    });
    load();
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
