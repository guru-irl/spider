import { afterEach, expect, it, vi } from "vitest";
import { main } from "../cli";
import { provisionIntercomEnrollment } from "../intercom-enrollment";
import * as helper from "../intercom-helper";
import * as localOps from "../intercom-local-ops";
import * as hub from "../production-hub";
import * as hc from "@spider/herdr/client/hc";
import { parseHerdrConfig } from "@spider/herdr/config";
import { scenario, cleanupPairScenarios } from "./intercom-pair-fixture";
const A = "00000000-0000-4000-8000-000000000002", B = "00000000-0000-4000-8000-000000000003";
afterEach(() => { vi.restoreAllMocks(); cleanupPairScenarios(); });
it("the public source revoke CLI does not treat a dropped pair route as a management route", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0);
  vi.spyOn(hub, "loadHerdrConfig").mockReturnValue(parseHerdrConfig({ mode: "core-only", enabled: false, core: { binary: "/fixture/hc", config: "/fixture/core.toml" },
    agentDirectory: f.locals.get(A)!.home, globalRoot: f.source.globalRoot, shellRc: "/fixture/rc", spaces: [], machines: [],
    limits: { auxiliaryPanes: 4, completedRows: 20, completedHours: 24 }, retention: { foregroundDays: 30 }, admin: { wrappers: [] } }));
  vi.spyOn(hc, "invokeCli").mockResolvedValue({ version: "0.1.16", core: { id: "core-a" } });
  vi.spyOn(helper, "requestHelperRevoke").mockImplementation(async (_root, value) => {
    const input = value as { machineId: string; peer: string; edgeEpoch: string; fenceId?: string };
    expect(input).toMatchObject({ machineId: A, peer: B, edgeEpoch: "edge-1" });
    const { fence } = f.queues.get(A)!.fencePair(input.peer, input.edgeEpoch, input.fenceId);
    return { machineId: input.machineId, peer: input.peer, edgeEpoch: input.edgeEpoch, fenceId: fence.fenceId, exchanges: "closed", inFlight: 0 };
  });
  const cleanup = localOps.runLocalPairCleanup;
  vi.spyOn(localOps, "runLocalPairCleanup").mockImplementation((value, ports) => cleanup(value, ports.machineId === A ? f.locals.get(A)! : ports));
  let err = "";
  expect(await main(["--global-root", f.source.globalRoot, "roam", "intercom", "revoke", "pair-1"], { out: () => {}, err: text => { err += text; } }, { intercomOptions: { transport: f.transport } })).toBe(3);
  expect(err).toContain("intercom-revocation-unconfirmed");
  expect(f.calls.some(call => call.includes("stop spider-pair-pair-1-host.service"))).toBe(true);
  expect(f.calls.some(call => call.includes("machine rm spider-pair-pair-1"))).toBe(false);
}, 5000);
