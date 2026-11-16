import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { observeHubRestoration, signalHubRestoration } from "../hub-restoration";
const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
it("disabled and foreign imports create no restoration marker", () => {
  const fixture = createReplica("global", BOX); fixtures.push(fixture);
  const path = join(fixture.root, "roam", "hub-restored");
  signalHubRestoration(fixture.root, { enabled: false, hubMachineId: HUB }, HUB);
  signalHubRestoration(fixture.root, { enabled: true, hubMachineId: HUB }, BOX);
  expect(existsSync(path)).toBe(false);
});
it("verified hub restoration calls the private subscriber and disposal stops delivery", async () => {
  const fixture = createReplica("global", BOX); fixtures.push(fixture); mkdirSync(join(fixture.root, "roam"));
  let done!: () => void, calls = 0;
  const delivered = new Promise<void>(resolve => { done = resolve; });
  const stop = observeHubRestoration(fixture.root, () => { calls++; done(); }, () => true, 10);
  try { signalHubRestoration(fixture.root, { enabled: true, hubMachineId: HUB }, HUB); await delivered; expect(calls).toBe(1); }
  finally { stop(); }
  signalHubRestoration(fixture.root, { enabled: true, hubMachineId: HUB }, HUB);
  expect(calls).toBe(1);
}, 5000);
