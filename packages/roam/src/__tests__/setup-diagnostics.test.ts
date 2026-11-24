import { expect, it, vi } from "vitest";
import { migrate, openDb } from "@spider/db-core";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { scratchDbPath } from "@spider/db-core/testutil";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { runLocalDoctor } from "../local-diagnostics";
import { recordMoveSetupFailure, readMoveSetupDiagnostics } from "../setup-diagnostics";

it("setup snapshots replace previous failures and only their session can clear them", () => {
  const db = openDb(scratchDbPath("setup-snapshot"));
  const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  try {
    migrate(db, "global", { machineId: "00000000-0000-4000-8000-000000000001", globalRoot: dirname(db.raw.name) });
    recordMoveSetupFailure(db, "session-a", { stage: "ownership", causeCode: "EACCES" });
    recordMoveSetupFailure(db, "session-b", { stage: "live-freeze", causeCode: "ENOENT" });
    recordMoveSetupFailure(db, "session-a", null);
    expect(readLocal(db, "move-setup", "admission")).toEqual({ sessionId: "session-b", failure: { stage: "live-freeze", causeCode: "ENOENT" }, firstAt: 1_700_000_000_000, lastAt: 1_700_000_000_000 });
    recordMoveSetupFailure(db, "session-b", null);
    expect(readMoveSetupDiagnostics(db)).toEqual([]);
    writeLocal(db, "move-setup", "admission", { failure: { stage: "private-stage", causeCode: "private-prompt" } });
    expect(JSON.stringify(readMoveSetupDiagnostics(db))).not.toContain("private");
    expect(readMoveSetupDiagnostics(db)[0].reason).toContain("diagnostic unavailable");
  } finally { now.mockRestore(); const file = db.raw.name; db.close(); rmSync(file, { force: true }); }
});

it("starts a new occurrence window when the retained failure changes", () => {
  const db = openDb(scratchDbPath("setup-occurrences"));
  const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  try {
    migrate(db, "global", { machineId: "00000000-0000-4000-8000-000000000001", globalRoot: dirname(db.raw.name) });
    recordMoveSetupFailure(db, "session-a", { stage: "preparation", causeCode: "participant-cwd-unavailable" });
    now.mockReturnValue(1_700_000_030_000);
    recordMoveSetupFailure(db, "session-a", { stage: "preparation", causeCode: "participant-header-mismatch" });
    expect(readLocal(db, "move-setup", "admission")).toEqual({ sessionId: "session-a", failure: { stage: "preparation", causeCode: "participant-header-mismatch" }, firstAt: 1_700_000_030_000, lastAt: 1_700_000_030_000 });
  } finally { now.mockRestore(); const file = db.raw.name; db.close(); rmSync(file, { force: true }); }
});

it("does not retain an unsafe session identifier or display invalid timestamps", () => {
  const db = openDb(scratchDbPath("setup-unsafe"));
  try {
    migrate(db, "global", { machineId: "00000000-0000-4000-8000-000000000001", globalRoot: dirname(db.raw.name) });
    recordMoveSetupFailure(db, "/home/fixture/private", { stage: "preparation", causeCode: "participant-cwd-unavailable" });
    expect(JSON.stringify(readLocal(db, "move-setup", "admission"))).not.toContain("private");
    expect(readMoveSetupDiagnostics(db)[0].reason).toContain("<session>");
    writeLocal(db, "move-setup", "admission", { sessionId: "session-a", failure: { stage: "preparation", causeCode: "participant-cwd-unavailable" }, firstAt: "private-content", lastAt: 1 });
    expect(readMoveSetupDiagnostics(db)[0].reason).toContain("diagnostic unavailable");
    expect(JSON.stringify(readMoveSetupDiagnostics(db))).not.toContain("private");
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
