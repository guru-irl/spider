import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { clearActions } from "../dispatch";
import { LOADED_BUILD } from "../build-id";
import { mountedFixture } from "./herdr-wiring-fixture";

afterEach(() => { clearActions(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("a refused Herdr session records presence without contacting hc or publishing a feed", async () => {
  const f = await mountedFixture("fake", "tui", true, false, true, false, true, false, false, true, undefined, { admitted: () => false, allowMissingFeed: true });
  try {
    expect(f.owner).toBeNull();
    expect(await f.calls()).toEqual([]);
    expect(existsSync(f.feedPath)).toBe(false);
    expect(await f.presence.list()).toEqual([expect.objectContaining({ sessionId: f.h.owner!.sessionId, build: LOADED_BUILD })]);
  } finally { await f.close(); }
}, 5000);

it("a frozen mounted feed does not publish on rename or shutdown", async () => {
  let admitted = true;
  const f = await mountedFixture("fake", "tui", true, false, true, false, true, false, false, true, undefined, { admitted: () => admitted });
  try {
    const before = await readFile(f.feedPath, "utf8");
    admitted = false;
    Reflect.set(f.pi, "getSessionName", () => "renamed");
    await f.emit("session_info_changed");
    expect(await readFile(f.feedPath, "utf8")).toBe(before);
    await f.emit("session_shutdown", { reason: "quit" });
    expect(await readFile(f.feedPath, "utf8")).toBe(before);
  } finally { await f.close(); }
}, 5000);
