import { expect, it } from "vitest";
import { migrate, openDb } from "@spider/db-core";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { scratchDbPath } from "@spider/db-core/testutil";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { runLocalDoctor } from "../local-diagnostics";
import { recordMoveSetupFailure, readMoveSetupDiagnostics } from "../setup-diagnostics";

it("setup snapshots replace previous failures and only their session can clear them", () => {
  const db = openDb(scratchDbPath("setup-snapshot"));
  try {
    migrate(db, "global", { machineId: "00000000-0000-4000-8000-000000000001", globalRoot: dirname(db.raw.name) });
    recordMoveSetupFailure(db, "session-a", { stage: "ownership", causeCode: "EACCES" });
    recordMoveSetupFailure(db, "session-b", { stage: "live-freeze", causeCode: "ENOENT" });
    recordMoveSetupFailure(db, "session-a", null);
    expect(readLocal(db, "move-setup", "admission")).toEqual({ sessionId: "session-b", failure: { stage: "live-freeze", causeCode: "ENOENT" } });
    recordMoveSetupFailure(db, "session-b", null);
    expect(readMoveSetupDiagnostics(db)).toEqual([]);
    writeLocal(db, "move-setup", "admission", { failure: { stage: "private-stage", causeCode: "private-prompt" } });
    expect(JSON.stringify(readMoveSetupDiagnostics(db))).not.toContain("private");
    expect(readMoveSetupDiagnostics(db)[0].reason).toContain("diagnostic unavailable");
  } finally { const file = db.raw.name; db.close(); rmSync(file, { force: true }); }
});

it.each(["preparation", "ownership", "move-bindings", "live-freeze", "socket-publication"])("doctor names the safe %s setup failure with a repair", async stage => {
  const parent = dirname(scratchDbPath("setup-doctor")); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "setup-")), db = openDb(join(root, "spider.db"));
  try {
    migrate(db, "global", { machineId: "00000000-0000-4000-8000-000000000001", globalRoot: root });
    writeLocal(db, "move-setup", "admission", { sessionId: "session-a", failure: { stage, causeCode: "participant-pi-unavailable" } });
    const report = await runLocalDoctor({ root });
    const diagnostic = report.diagnostics.find(row => row.reason.includes(`at ${stage} (participant-pi-unavailable)`));
    expect(diagnostic).toMatchObject({ severity: "warning", repairCommand: "spider roam doctor" });
    expect(diagnostic?.reason).toContain("SPIDER_ROAM_PI");
    expect(diagnostic?.reason).not.toContain(root);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
