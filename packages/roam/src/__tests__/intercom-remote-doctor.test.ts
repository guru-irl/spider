import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli";
import { inspectLocalIntercomDoctor } from "../intercom-doctor";
import { remoteDoctor } from "../remote-observations";
import { parseConfig } from "../config";
import { FEDERATION_NOTICE_ACK_FEATURE, HELPER_EXCHANGE_FEATURE } from "@spider/intercom/protocol";
import { provisionIntercomEnrollment } from "../intercom-enrollment";
import { scenario, cleanupPairScenarios } from "./intercom-pair-fixture";
const B = "00000000-0000-4000-8000-000000000003";
afterEach(cleanupPairScenarios);
it("the remote doctor observes the recorded pair unit and never starts, stops or repairs it", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0);
  const before = readFileSync(join(f.target.globalRoot, "roam", "intercom", "enrollments", "pair-1.json"), "utf8"), calls = f.calls.length;
  const local = f.locals.get(B)!, config = parseConfig(JSON.parse(readFileSync(join(f.target.globalRoot, "roam", "config.json"), "utf8")));
  const inspector = (input: Parameters<typeof inspectLocalIntercomDoctor>[0]) => inspectLocalIntercomDoctor({ ...input, run: local.run,
    resourcePorts: local, features: async () => [HELPER_EXCHANGE_FEATURE, FEDERATION_NOTICE_ACK_FEATURE],
    inspectSsh: async pair => ({ targetMachineId: B, sshUser: "fixture", hostKey: pair.hostKey }), link: async () => ({ status: "live", reason: null }) });
  const transport = { resolve: async () => f.target, exec: async (_peer: unknown, argv: readonly string[]) => {
    let out = "";
    expect(await main(["--global-root", f.target.globalRoot, ...argv], { out: text => { out += text; }, err: () => {} }, { intercomDoctor: inspector } as never)).toBe(0);
    return Buffer.from(out);
  } };
  const report = await remoteDoctor(transport as never, f.target, config);
  expect(f.calls.slice(calls).some(call => call.includes("show spider-pair-pair-1-host.service"))).toBe(true);
  expect(f.calls.slice(calls).some(call => /(?:start|stop|enable|disable|daemon-reload|machine add|machine rm)/.test(call))).toBe(false);
  expect(report.diagnostics.some(row => row.reason.includes("intercom-pair-unit-unavailable"))).toBe(false);
  expect(report.diagnostics.some(row => row.reason.includes("intercom-feature-missing"))).toBe(false);
  expect(readFileSync(join(f.target.globalRoot, "roam", "intercom", "enrollments", "pair-1.json"), "utf8")).toBe(before);
}, 5000);

it("read-only doctor names the queue-to-registry revocation gap without changing either", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0);
  const queue = f.queues.get(B)!; queue.fencePair(f.source.machineId, "edge-1");
  const file = join(f.target.globalRoot, "roam", "intercom", "enrollments", "pair-1.json"), before = readFileSync(file, "utf8");
  const { runLocalDoctor } = await import("../local-diagnostics");
  const report = await runLocalDoctor({ root: f.target.globalRoot });
  expect(report.diagnostics).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringContaining("intercom-revocation-unconfirmed") }));
  expect(readFileSync(file, "utf8")).toBe(before); expect(queue.pairFence(f.source.machineId)).not.toBeNull();
}, 5000);
