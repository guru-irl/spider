import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHostSessionFixture } from "./fixtures/pi-events";
import { registerAdmission, type AdmissionPorts } from "../roam/admission";

const gates: ReturnType<typeof registerAdmission>[] = [];
afterEach(async () => { for (const gate of gates.splice(0)) await gate.close(); vi.unstubAllEnvs(); });

it.each(["preparation", "ownership", "move-bindings", "live-freeze", "socket-publication"])("ordinary work survives a safely diagnosed %s setup failure", async stage => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const host = createHostSessionFixture({ cwd: "/fixture", sessionId: "session-a", sessionFile: "/fixture/session.jsonl" });
  const warnings: string[] = [], diagnostics: unknown[] = [];
  const error = Object.assign(new Error("private prompt /private/path"), { code: "participant-pi-unavailable", setupStage: stage });
  const ports: AdmissionPorts = {
    expectedEpoch: null, lockUntracked: () => true, localMachine: async () => "fixture", knownParticipant: () => false,
    warnOnce: (_id, reason) => warnings.push(reason),
    load: async () => ({ home: null, states: [], origin: null, participating: false, captureSafe: true, unfinishedFreeze: false, initialConflict: false }),
    prepare: async () => { if (stage === "preparation") throw error; },
    lock: async () => { throw error; },
    ...{ setupDiagnostic: (_id: string, failure: unknown) => diagnostics.push(failure) },
  };
  const gate = registerAdmission(host.pi as unknown as ExtensionAPI, ports); gates.push(gate);
  for (const handler of host.hooks.get("session_start") ?? []) await handler({}, host.ctx);
  expect(gate.inspect()).toMatchObject({ kind: "ordinary", setupFailure: { stage, causeCode: "participant-pi-unavailable" } });
  for (const handler of host.hooks.get("input") ?? []) expect(await handler({ text: "keep working" }, host.ctx)).toBeUndefined();
  expect(JSON.stringify({ admission: gate.inspect(), warnings, diagnostics })).not.toMatch(/private|prompt/);
  expect(warnings.join(" ")).toContain(stage);
  expect(diagnostics).toContainEqual({ stage, causeCode: "participant-pi-unavailable" });
});

it.each(["ownership", "move-bindings", "live-freeze", "socket-publication"])("an exact participant stays blocked after a named %s setup failure", async stage => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  vi.stubEnv("SPIDER_HERDR_HANDOFF_FILE", "/fixture/handoff.json");
  const host = createHostSessionFixture({ cwd: "/fixture", sessionId: "session-a", sessionFile: "/fixture/session.jsonl" });
  const ready = vi.fn(async () => {});
  const ports: AdmissionPorts = { expectedEpoch: null, knownParticipant: () => true, localMachine: async () => "fixture", warnOnce: () => {},
    load: async () => ({ home: null, origin: "fixture", states: [{ sessionId: "session-a", epoch: 1, state: "active", moveId: null, freezeSeq: null }],
      participating: true, captureSafe: true, unfinishedFreeze: false, initialConflict: false }),
    lock: async () => { throw Object.assign(new Error("private detail"), { setupStage: stage, code: "participant-pi-unavailable" }); }, ready };
  const gate = registerAdmission(host.pi as unknown as ExtensionAPI, ports); gates.push(gate);
  for (const handler of host.hooks.get("session_start") ?? []) await handler({}, host.ctx);
  expect(gate.inspect()).toMatchObject({ kind: "blocked", setupFailure: { stage, causeCode: "participant-pi-unavailable" } });
  for (const handler of host.hooks.get("input") ?? []) expect(await handler({ text: "keep working" }, host.ctx)).toEqual({ action: "handled" });
  expect(ready).not.toHaveBeenCalled();
  expect(JSON.stringify(gate.inspect())).not.toContain("private");
});

it("unknown errors cannot inject stages or causes into admission", async () => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const host = createHostSessionFixture({ cwd: "/fixture", sessionId: "session-a", sessionFile: "/fixture/session.jsonl" });
  const ports: AdmissionPorts = { expectedEpoch: null, knownParticipant: () => false, localMachine: async () => "fixture", warnOnce: () => {},
    prepare: async () => { throw Object.assign(new Error("private prompt /private/path"), { setupStage: "private-stage", code: "private-code" }); },
    load: async () => ({ home: null, states: [], origin: null, participating: false, captureSafe: true, unfinishedFreeze: false, initialConflict: false }),
    lock: async () => async () => {} };
  const gate = registerAdmission(host.pi as unknown as ExtensionAPI, ports); gates.push(gate);
  for (const handler of host.hooks.get("session_start") ?? []) await handler({}, host.ctx);
  expect(gate.inspect()).toMatchObject({ kind: "ordinary", setupFailure: { stage: "preparation", causeCode: "setup-unavailable" } });
  expect(JSON.stringify(gate.inspect())).not.toContain("private");
});
