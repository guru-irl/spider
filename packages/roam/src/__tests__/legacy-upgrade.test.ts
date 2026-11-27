import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrate, openDb } from "@spider/db-core";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../cli";
import { openJournal } from "../journal";

const roots: string[] = [];
const hub = "11111111-1111-4111-8111-111111111111";
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "upgrade-"));
  roots.push(root);
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId: hub,
    hubMachineId: hub, coreUnit: "herdr-core.service" }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: hub }), { mode: 0o600 });
  const db = openDb(join(root, "spider.db"));
  try { migrate(db, "global", { machineId: hub, globalRoot: root }); } finally { db.close(); }
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  return { root, journal: openJournal(join(root, "roam", "journal.db")) };
}

it("disabled doctor reports the unfinished legacy move and source cleanup by operation ID", async () => {
  const f = fixture();
  f.journal.begin({ id: "legacy-move-1", machineId: hub, expectedEpoch: 1, kind: "move", args: { sessionId: "session-1" } });
  f.journal.record("legacy-move-1", "move-source-cleanup-pending", { sessionId: "session-1", sourceMachine: hub,
    sourceCleanup: { status: "pending", reason: "move-cleanup-pending", blockers: [] } });
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  const report = JSON.parse(io.out.mock.calls.at(-1)![0]);
  expect(report.value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*legacy-move-1/) }),
  ]));
});
