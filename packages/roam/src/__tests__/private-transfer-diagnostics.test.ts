// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import type { JsonObject } from "@spider/db-core/roam/types";
import { main as roamCli } from "../cli";
import { openJournal } from "../journal";
import { withPrivateTransferDiagnostic } from "../private-transfer-diagnostics";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const parent = dirname(scratchDbPath("private-transfer"));
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "transfer-")); roots.push(root);
  const journal = openJournal(join(root, "roam", "journal.db"));
  journal.begin({ id: "move-fixture", kind: "move", machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: 1, args: {} });
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  return { journal, root };
}

it("does not write private failure evidence for a successful transfer", async () => {
  const { journal } = fixture(), value = { complete: true };
  expect(await withPrivateTransferDiagnostic(journal, "move-fixture", "export", () => value)).toBe(value);
  expect(journal.read("move-fixture")).toEqual([]);
});

it("preserves the original error when private evidence cannot be written", async () => {
  const { journal } = fixture(), error = Object.assign(new Error("fixture-private"), { code: "ENOENT" });
  journal.record = () => { throw new Error("fixture evidence unavailable"); };
  await expect(withPrivateTransferDiagnostic(journal, "move-fixture", "export", () => { throw error; })).rejects.toBe(error);
});

it("does not serialize a thrown external object", async () => {
  const { journal } = fixture(), error = { code: "ENOENT", privatePayload: "fixture-private", toJSON() { throw new Error("must not serialize"); } };
  await expect(withPrivateTransferDiagnostic(journal, "move-fixture", "send", () => { throw error; })).rejects.toBe(error);
  expect(journal.read("move-fixture").map(row => row.result)).toEqual([
    { phase: "send", code: "ENOENT", codeSource: "code" },
  ]);
});

it("observes only private diagnostic fields for the requested operation", async () => {
  const { journal } = fixture();
  journal.record("move-fixture", "move-transfer-diagnostic", { phase: "export", code: "ENOENT", codeSource: "code", privatePayload: "fixture-private" });
  journal.record("move-fixture", "unrelated", { phase: "send", code: "UNRELATED_CODE", codeSource: "code" });
  const invalidRows: JsonObject[] = [
    { phase: "export", code: "unsafe /home/fixture/not-public", codeSource: "code" },
    { phase: "invalid-phase", code: "ENOENT", codeSource: "code" },
    { phase: "export", code: "ENOENT", codeSource: "invalid-source" },
    { phase: "export", code: "ENOENT", codeSource: "code", fingerprint: "fixture-private" },
  ];
  for (const invalid of invalidRows) journal.record("move-fixture", "move-transfer-diagnostic", invalid);
  journal.begin({ id: "other-move", kind: "move", machineId: "00000000-0000-4000-8000-000000000001", expectedEpoch: 1, args: {} });
  journal.record("other-move", "move-transfer-diagnostic", { phase: "send", code: "EACCES", codeSource: "code" });
  let out = "", err = "";
  const exit = await roamCli(["roam", "observe", "transfer", "move-fixture"], {
    out: text => { out += text; }, err: text => { err += text; },
  });
  expect({ exit, err }).toEqual({ exit: 0, err: "" });
  expect(JSON.parse(out)).toEqual({ version: 1, kind: "private-transfer-diagnostics", value: [
    { phase: "export", code: "ENOENT", codeSource: "code" },
  ] });
  for (const text of ["fixture-private", "not-public", "other-move", "EACCES", "UNRELATED_CODE"]) expect(out).not.toContain(text);
});

it("keeps private transfer evidence out of ordinary doctor output", async () => {
  const { journal } = fixture();
  journal.record("move-fixture", "move-transfer-diagnostic", { phase: "export", code: "PRIVATE_CODE_42", codeSource: "code" });
  let out = "", err = "";
  await roamCli(["roam", "doctor", "--json"], { out: text => { out += text; }, err: text => { err += text; } });
  expect(out).not.toBe("");
  expect(out + err).not.toContain("PRIVATE_CODE_42");
  expect(out + err).not.toContain("private-transfer-diagnostics");
});
