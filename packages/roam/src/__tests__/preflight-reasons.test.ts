import { afterEach, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSync } from "../sync";
import { safeControlOutcome } from "../commands";
import { AgentResponseError } from "../peer-errors";
import { moveSession } from "../move";
import type { MovePorts } from "../contracts";
import { network, BOX, HUB } from "./sync-fixture";

const fixtures: ReturnType<typeof network>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function fixture() { const f = network(); fixtures.push(f); return f; }

it.each(["store-inventory-incomplete", "unknown"])("sync retains a safe %s reason from a reachable agent", async reason => {
  const f = fixture(), remote = f.remotes.get(BOX)!;
  if (reason === "store-inventory-incomplete") {
    const common = join(remote.global.root, "deleted", ".git");
    mkdirSync(join(common, "spider"), { recursive: true });
    writeFileSync(join(common, "spider", "repo.db"), "not sqlite");
    remote.global.db.prepare("UPDATE projects SET git_common_dir=?").run(common);
  } else f.replyHook((_peer, operation, bytes) => operation.kind === "stores"
    ? Buffer.from(JSON.stringify({ operationId: operation.id, code: 1, reason: "private free text", value: null })) : bytes);
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores });
  const results = await sync.sync(BOX); sync.stop();
  const output = safeControlOutcome({ code: 1, reason: "Synchronization needs attention", operationId: "sync-a", home: null, epoch: null, repairCommand: null, value: { outcomes: results } });
  expect(output.value).toMatchObject({ outcomes: [{ code: 1, reason: reason === "unknown" ? "peer-stores-refused" : reason }] });
  expect(JSON.stringify(output)).not.toContain("private free text");
  expect(JSON.stringify(output)).not.toContain("control-failed");
});

it.each([true, false])("move retains a coded preflight blocker without copying error text (coded: %s)", async coded => {
  const f = fixture();
  const unavailable = async (): Promise<never> => { throw new Error("must not run"); };
  const ports = { config: f.config, globalDb: f.global.db, journal: f.journal,
    async check() { throw coded ? new AgentResponseError("store-inventory-incomplete") : new Error("private free text"); },
    intercom: { address: { sessionId: "session-a", scopeId: null }, destinationEndpoint: unavailable,
      ports: { close: unavailable, drain: unavailable, inspect: unavailable, checkGeneration: unavailable, abort: unavailable, ready: unavailable } },
  } as unknown as MovePorts;
  const result = await moveSession({ sessionId: "session-a", destinationMachine: BOX,
    operation: { id: "move-a", kind: "move", machineId: HUB, expectedEpoch: null, args: { sessionId: "session-a", destinationMachine: BOX } } }, ports);
  expect(safeControlOutcome(result)).toMatchObject({ code: 1, reason: "move-preflight-refused", refusal: {
    blockers: [coded ? "store-inventory-incomplete" : "preflight-check-unavailable"],
  } });
  expect(JSON.stringify(result)).not.toContain("private free text");
  expect(f.journal.read("move-a").some(row => row.result.action === "freeze")).toBe(false);
});
