type Timer = ReturnType<typeof setTimeout>;
interface Opts {
  frameMs?: number;
  schedule?: (fn: () => void, ms: number) => Timer;
  cancel?: (t: Timer) => void;
}

export class FrameScheduler {
  private frameMs: number;
  private schedule: (fn: () => void, ms: number) => Timer;
  private cancel: (t: Timer) => void;
  private pending: Timer | null = null;

  constructor(private flush: () => void, opts: Opts = {}) {
    this.frameMs = opts.frameMs ?? 24;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((t) => clearTimeout(t));
  }

  request(): void {
    if (this.pending !== null) return; // already a frame in flight → coalesce
    this.pending = this.schedule(() => {
      this.pending = null;
      this.flush();
    }, this.frameMs);
    // Best-effort: don't hold the event loop open for a UI frame.
    (this.pending as unknown as { unref?: () => void }).unref?.();
  }

  dispose(): void {
    if (this.pending !== null) { this.cancel(this.pending); this.pending = null; }
  }
}
