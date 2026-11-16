import { expect, it, vi } from "vitest";
import { createProducerDrain } from "../producers.js";

it("waits for every already-started producer, even when one fails", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const first = { pause: vi.fn(async () => { throw new Error("usage failed"); }), resume: vi.fn() };
  const second = { pause: vi.fn(() => pending), resume: vi.fn() };
  const third = { pause: vi.fn(async () => {}), resume: vi.fn() };
  const barrier = createProducerDrain({ usage: first, embeddings: second, organism: third, others: [] });
  let settled = false;
  const draining = barrier.drain().finally(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  expect(first.pause).toHaveBeenCalledOnce(); expect(second.pause).toHaveBeenCalledOnce();
  release(); await expect(draining).rejects.toThrow(/usage failed/);
});

it("stops every partially restarted producer if resume fails", async () => {
  const first = { pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) };
  const second = { pause: vi.fn(async () => {}), resume: vi.fn(async () => { throw new Error("resume failed"); }) };
  const third = { pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) };
  const barrier = createProducerDrain({ usage: first, embeddings: second, organism: third, others: [] });
  await barrier.drain();
  await expect(barrier.resume()).rejects.toThrow(/resume failed/);
  expect(first.pause).toHaveBeenCalledTimes(2);
  expect(second.pause).toHaveBeenCalledTimes(2);
  expect(third.pause).toHaveBeenCalledTimes(2);
});
