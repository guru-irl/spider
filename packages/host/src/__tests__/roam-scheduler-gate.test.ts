import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionScheduler } from "../loop/index";
import { createTimeMath } from "../loop/time-math";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it("keeps a due wakeup intact until admission returns", async () => {
  vi.useFakeTimers(); vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  let admitted = true;
  const sendUserMessage = vi.fn(), appendEntry = vi.fn();
  const pi = { sendUserMessage, appendEntry } as unknown as ExtensionAPI;
  const ctx = { mode: "tui", isIdle: () => true, ui: { notify() {} }, sessionManager: { getSessionId: () => "session-1" } } as unknown as ExtensionContext;
  const scheduler = new SessionScheduler(pi, createTimeMath(), () => admitted);
  await scheduler.schedule({ delaySeconds: 60, prompt: "check" }, ctx);
  const saved = appendEntry.mock.calls.length;
  admitted = false;
  vi.advanceTimersByTime(60_000);
  expect(sendUserMessage).not.toHaveBeenCalled();
  expect(appendEntry).toHaveBeenCalledTimes(saved);
  expect(scheduler.listTriggers()).toEqual([expect.objectContaining({ state: "due", prompt: "check" })]);
  admitted = true;
  vi.advanceTimersByTime(1000);
  expect(sendUserMessage).toHaveBeenCalledOnce();
  expect(scheduler.listTriggers()).toEqual([]);
  scheduler.shutdown();
}, 5000);
