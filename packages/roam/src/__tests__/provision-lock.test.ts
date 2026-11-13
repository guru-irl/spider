import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as lockModule from "../provision-lock";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("serializes the same peer while allowing a different peer to progress", async () => {
  const create = (lockModule as { createProvisionLock?: (root: string, options: unknown) => <T>(id: string, work: () => Promise<T>) => Promise<T> }).createProvisionLock;
  expect(create).toBeTypeOf("function");
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "provision-lock-")); roots.push(root); mkdirSync(join(root, "roam"), { mode: 0o700 });
  const lock = create!(root, { identity: { pid: process.pid, startIdentity: "fixture" }, probe: async () => ({ kind: "live", startIdentity: "fixture" }) });
  const firstPeer = "11111111-1111-4111-8111-111111111111", secondPeer = "22222222-2222-4222-8222-222222222222";
  const events: string[] = []; let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const first = lock(firstPeer, async () => { events.push("first-start"); started(); await gate; events.push("first-end"); });
  await ready;
  const second = lock(firstPeer, async () => { events.push("second"); });
  await lock(secondPeer, async () => { events.push("other"); });
  expect(events).toEqual(["first-start", "other"]);
  release(); await Promise.all([first, second]);
  expect(events).toEqual(["first-start", "other", "first-end", "second"]);
}, 5000);
