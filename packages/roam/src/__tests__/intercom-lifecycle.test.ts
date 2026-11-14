import { paths } from "@spider/db-core";
import { afterEach, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openIntercomStore } from "../intercom-store";
import { createIntercomBridge } from "../intercom-bridge";

const A = "00000000-0000-4000-8000-000000000001";
const roots: string[] = [], resources: Array<{ stop(): Promise<void> }> = [], stores: Array<{ close(): void }> = [];
afterEach(async () => { for (const resource of resources.splice(0)) await resource.stop(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
class DelayedBroker extends EventEmitter {
  count = 0; private accept!: () => void; private reject!: (error: Error) => void; entered!: () => void;
  enteredPromise = new Promise<void>(resolve => { this.entered = resolve; });
  connect() { this.count++; this.entered(); return new Promise<void>((resolve, reject) => { this.accept = resolve; this.reject = reject; }); }
  finish() { this.accept?.(); }
  enableHelpers() { return Promise.resolve(); }
  publishPresence() {}
  close() { this.reject?.(new Error("closed")); return Promise.resolve(); }
}
function fixture() {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "life-")); roots.push(root);
  const globalRoot = join(root, "global"), agentDir = join(root, "agent"); mkdirSync(globalRoot, { mode: 0o700 }); mkdirSync(agentDir, { mode: 0o700 });
  const clock = { now: () => Date.now(), later: (ms: number, fn: () => void) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
  const store = openIntercomStore({ file: join(globalRoot, "queue", "queue.db"), machineId: A, clock }); stores.push(store);
  const broker = new DelayedBroker(), bridge = createIntercomBridge({ machineId: A, machineAlias: "fixture.invalid", edges: [], store, clock,
    transport: {} as any, localPresence: () => [], authoritativeHome: () => null, broker: broker as any, globalRoot, agentDir });
  resources.push(bridge); return { bridge, broker, globalRoot };
}

it("concurrent starts share readiness and connect only once", async () => {
  const f = fixture(), first = f.bridge.start();
  await f.broker.enteredPromise;
  let secondReady = false;
  const second = f.bridge.start().then(() => { secondReady = true; });
  try {
    await Promise.resolve(); expect(secondReady).toBe(false); expect(f.broker.count).toBe(1);
    f.broker.finish(); await Promise.all([first, second]);
    expect(secondReady).toBe(true);
    expect(existsSync(join(f.globalRoot, "roam", "intercom", "helper.json"))).toBe(true);
  } finally { f.broker.finish(); await first.catch(() => {}); }
}, 5000);

it("stop during registration closes the pending connect and leaves no capability", async () => {
  const f = fixture(), starting = f.bridge.start().catch(error => error);
  await f.broker.enteredPromise;
  const begin = performance.now(); await f.bridge.stop(); await starting;
  expect(performance.now() - begin).toBeLessThan(1000);
  expect(existsSync(join(f.globalRoot, "roam", "intercom", "helper.json"))).toBe(false);
}, 5000);


it("stopping a contending startup does not disturb the current route owner", async () => {
  const f = fixture(), first = f.bridge.start(); await f.broker.enteredPromise; f.broker.finish(); await first;
  const file = join(f.globalRoot, "roam", "intercom", "helper.json"), before = readFileSync(file, "utf8");
  const secondBroker = new DelayedBroker(), clock = { now: () => Date.now(), later: (ms: number, fn: () => void) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
  const otherStore = openIntercomStore({ file: join(f.globalRoot, "other", "queue.db"), machineId: A, clock }); stores.push(otherStore);
  const contender = createIntercomBridge({ machineId: A, machineAlias: "other.invalid", edges: [], store: otherStore, clock, transport: {} as any,
    localPresence: () => [], authoritativeHome: () => null, broker: secondBroker as any, globalRoot: f.globalRoot, agentDir: join(f.globalRoot, "..", "agent") });
  resources.push(contender);
  const starting = contender.start().catch(error => error);
  await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
  const begin = performance.now(); await contender.stop(); await starting;
  expect(performance.now() - begin).toBeLessThan(1000);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(secondBroker.count).toBe(0);
}, 5000);
