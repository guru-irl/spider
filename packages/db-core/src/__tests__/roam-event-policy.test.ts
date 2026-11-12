import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createExportPolicy, EVENT_POLICIES } from "@spider/db-core/roam/event-policy";
import { exportBatch } from "@spider/db-core/roam/export";
import { seedSession } from "@spider/db-core/roam/seed";
import type { JsonObject } from "@spider/db-core/roam/types";
import { A, SESSION, replica } from "./roam-apply-fixture";

function event(type: string, payload: unknown): JsonObject {
  return { uuid: "event-1", run_id: "run-1", session_id: SESSION, ts: 1, type, tool: null, summary: null, payload: JSON.stringify(payload) };
}
const policy = createExportPolicy((path, origin) => ({ machineId: origin, reference: `ref:${path.split("/").at(-1)}` }));
function payload(body: JsonObject): Record<string, unknown> { return JSON.parse(body.payload as string); }

describe("portable run-event history", () => {
  it.each(["child_supervisor", "child_transcript"])("known directory payloads become history references for %s", type => {
    const encoded = policy.encode("run_events", event(type, { version: 1, directory: "/private/secret-dir", endpoint: "secret-endpoint", token: "secret-token" }), A);
    expect(payload(encoded)).toEqual({ version: 1, history: { machineId: A, reference: "ref:secret-dir" } });
    expect(JSON.stringify(encoded)).not.toContain("/private/secret-dir");
    expect(JSON.stringify(encoded)).not.toContain("secret-endpoint");
    expect(JSON.stringify(encoded)).not.toContain("secret-token");
  }, 5000);

  it("chain steps never remain executable", () => {
    const encoded = policy.encode("run_events", event("chain_steps", { remaining: ["first", "second"] }), A);
    expect(payload(encoded)).toMatchObject({ count: 2, history: { machineId: A, reference: "run-event:event-1" } });
    expect(JSON.stringify(encoded)).not.toContain("first");
    expect(JSON.stringify(encoded)).not.toContain("remaining");
  }, 5000);

  it("unknown types and versions remain inert unchanged", () => {
    for (const body of [event("unknown", { version: 1, value: "keep" }), event("child_supervisor", { version: 2, directory: "/future/dir" }), event("chain_steps", { version: 9, remaining: ["future"] })]) {
      expect(policy.encode("run_events", body, A)).toEqual(body);
    }
    expect(EVENT_POLICIES.child_supervisor).toBe("supervisor");
    expect(EVENT_POLICIES.chain_steps).toBe("chain");
  }, 5000);

  it("wire content is cached once", async () => {
    const root = replica("worktree", A);
    seedSession(root.db, SESSION, 1, root.storeKey, 4096);
    root.db.prepare("INSERT INTO run_events(uuid, session_id, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run("event-1", SESSION, 1, "child_supervisor", JSON.stringify({ version: 1, directory: "/private/child" }));
    let calls = 0;
    const changing = createExportPolicy((_path, origin) => ({ machineId: origin, reference: `history-${++calls}` }));
    const first = await exportBatch(root.db, { after: 0, targetBytes: 4096, batchId: "batch" }, changing);
    const firstBytes = readFileSync(first.file, "utf8");
    const second = await exportBatch(root.db, { after: 0, targetBytes: 4096, batchId: "batch" }, changing);
    expect(readFileSync(second.file, "utf8")).toBe(firstBytes);
    expect(calls).toBe(1);
    expect(firstBytes).not.toContain("/private/child");
    expect(firstBytes).toContain("history-1");
  }, 5000);
});
