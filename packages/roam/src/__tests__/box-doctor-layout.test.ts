import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { runLocalDoctor } from "../local-diagnostics";
import * as readiness from "../intercom-readiness";

const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const f of fixtures.splice(0)) f.close(); });

it("inspects the active custom-prefix SDK and destination agent directory", async () => {
  const machineId = "00000000-0000-4000-8000-000000000002", f = createReplica("global", machineId); fixtures.push(f);
  mkdirSync(join(f.root, "roam"), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "box", machineId,
    hubMachineId: "00000000-0000-4000-8000-000000000001", coreUnit: "fixture.service" }), { mode: 0o600 });
  const prefix = join(f.root, "prefix"), release = join(prefix, "spider-releases", "a".repeat(64), "node_modules", "@guru-irl", "spider"), agentDir = join(f.root, "agent");
  writeFileSync(join(f.root, "roam", "active-release.json"), JSON.stringify(release), { mode: 0o600 });
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const observed: unknown[] = [];
  vi.spyOn(readiness, "inspectIntercomReadiness").mockImplementation(async input => {
    observed.push(input);
    return { intercomUnique: true, legacyDrained: true, federation: true,
      intercomEvidence: { settings: "settings-unique", legacy: "legacy-drained-private-agent", federation: "federation-v1", otherExtensions: [] } };
  });
  const report = await runLocalDoctor({ root: f.root, inspectIntercomDoctor: true });
  expect(observed).toEqual([{ agentDir, release, sdk: join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"), cwd: expect.any(String) }]);
  expect(report.diagnostics.some(row => row.reason.startsWith("intercom-readiness-unavailable"))).toBe(false);
  writeFileSync(join(f.root, "roam", "active-release.json"), JSON.stringify(join(f.root, "unknown-layout")), { mode: 0o600 });
  const invalid = await runLocalDoctor({ root: f.root, inspectIntercomDoctor: true });
  expect(invalid.diagnostics.some(row => row.reason.startsWith("intercom-readiness-unavailable"))).toBe(true);
  expect(observed).toHaveLength(1);
}, 5000);
