import { describe, it, expect, vi } from "vitest";
import { FrameScheduler } from "../agents/coalesce.js";

describe("FrameScheduler", () => {
  it("collapses many requests in one window into a single flush", () => {
    let cb: (() => void) | undefined;
    const schedule = vi.fn((fn: () => void) => { cb = fn; return 1 as unknown as ReturnType<typeof setTimeout>; });
    const cancel = vi.fn();
    const flush = vi.fn();
    const s = new FrameScheduler(flush, { frameMs: 24, schedule, cancel });
    s.request(); s.request(); s.request();
    expect(schedule).toHaveBeenCalledTimes(1);
    cb!();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("schedules a fresh frame after the previous one fired", () => {
    let cb: (() => void) | undefined;
    const schedule = vi.fn((fn: () => void) => { cb = fn; return 1 as unknown as ReturnType<typeof setTimeout>; });
    const s = new FrameScheduler(() => {}, { schedule, cancel: () => {} });
    s.request(); cb!();      // frame 1 fired
    s.request();             // must schedule again
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it("dispose cancels a pending frame", () => {
    const cancel = vi.fn();
    const s = new FrameScheduler(() => {}, { schedule: () => 7 as unknown as ReturnType<typeof setTimeout>, cancel });
    s.request();
    s.dispose();
    expect(cancel).toHaveBeenCalledWith(7);
  });
});
