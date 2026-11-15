import { expect, it } from "vitest";
import type { ProcessProbe } from "@spider/herdr/sessions/lease";
import * as diagnostics from "../local-diagnostics";

type Probe = (pid: number, usage: boolean, options?: { platform?: NodeJS.Platform; ps?: (pid: number, timeoutMs: number) => Promise<string> }) => Promise<ProcessProbe>;
const probe = (diagnostics as typeof diagnostics & { probeLocal?: Probe }).probeLocal;

it("retries a delayed macOS process identity asynchronously within a bounded deadline", async () => {
  expect(probe).toBeTypeOf("function");
  const timeouts: number[] = []; let eventLoopTurn = false;
  const pending = probe!(process.pid, false, { platform: "darwin", async ps(pid, timeoutMs) {
    expect(pid).toBe(process.pid); timeouts.push(timeoutMs);
    if (timeouts.length === 1) throw Object.assign(new Error("loaded"), { code: "ETIMEDOUT" });
    return await new Promise(resolve => setImmediate(() => { eventLoopTurn = true; resolve("Mon Jan  1 00:00:00 2024"); }));
  } });
  expect(await pending).toEqual({ kind: "live", startIdentity: "posix:Mon Jan  1 00:00:00 2024" });
  expect(eventLoopTurn).toBe(true); expect(timeouts).toHaveLength(2);
  expect(timeouts.every(value => value > 1000 && value <= 2000)).toBe(true);
}, 5000);

it("fails closed after bounded identity retries and preserves the usage identity format", async () => {
  expect(probe).toBeTypeOf("function"); let attempts = 0;
  const unknown = await probe!(process.pid, false, { platform: "darwin", async ps() { attempts++; throw new Error("unavailable"); } });
  expect(unknown).toEqual({ kind: "unknown" }); expect(attempts).toBe(2);
  const usage = await probe!(process.pid, true, { platform: "darwin", async ps() { return "Mon Jan  1 00:00:00 2024"; } });
  expect(usage).toEqual({ kind: "live", startIdentity: "ps-utc:Mon Jan  1 00:00:00 2024" });
}, 5000);
