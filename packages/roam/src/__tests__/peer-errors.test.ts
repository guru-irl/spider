import { afterEach, expect, it } from "vitest";
import { createReplica } from "@spider/db-core/testutil";
import { join } from "node:path";
import { handleAgentOperation } from "../agent";
import { agentFailureCode } from "../peer-errors";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import { openJournal } from "../journal";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
it.each(["capture", "generic"])("classifies the actual %s agent refusal without losing its safe code", async mode => {
  const machineId = "00000000-0000-4000-8000-000000000002", f = createReplica("global", machineId); fixtures.push(f);
  const ports = { config: { machineId, hubMachineId: "00000000-0000-4000-8000-000000000001", enabled: true, role: "box" as const, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() },
    root: join(f.root, "staging"), journal: openJournal(join(f.root, "journal.db")), openStore(): never { throw new Error(mode === "capture" ? "Roaming capture is unsafe: fixture" : "private detail"); } };
  const result = await handleAgentOperation({ id: "refused", machineId, expectedEpoch: null, kind: "enable-capture", args: { storeKey: "global" } }, ports);
  expect(result.code).toBe(1);
  expect(agentFailureCode(result.reason)).toBe(mode === "capture" ? "capture-unsafe" : "agent-operation-failed");
  expect(JSON.stringify(result)).not.toContain("private detail");
});
