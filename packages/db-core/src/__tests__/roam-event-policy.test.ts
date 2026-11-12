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

  it.each(["completion_delivered", "spider_usage_reported"])("exports %s as inert history", type => {
    const body = event(type, { marker: true });
    expect(EVENT_POLICIES[type]).toBe("inert");
    expect(policy.encode("run_events", body, A)).toEqual(body);
  }, 5000);

  it("keeps unknown event types inert while redacting unknown versions of sensitive types", () => {
    const unknown = event("unknown", { version: 1, value: "keep" });
    expect(policy.encode("run_events", unknown, A)).toEqual(unknown);
    for (const type of ["child_supervisor", "child_transcript", "chain_steps"]) {
      const body = event(type, { version: 9, directory: "/private/future", endpoint: "private-endpoint", token: "private-token", remaining: ["private-step"] });
      const encoded = policy.encode("run_events", body, A);
      expect(payload(encoded)).toEqual({ version: 9, history: null });
      for (const secret of ["/private/future", "private-endpoint", "private-token", "private-step"]) expect(JSON.stringify(encoded)).not.toContain(secret);
    }
    expect(EVENT_POLICIES.child_supervisor).toBe("supervisor");
    expect(EVENT_POLICIES.chain_steps).toBe("chain");
  }, 5000);

  it.each(["child_supervisor", "child_transcript", "chain_steps"])("redacts malformed and versionless %s payloads", type => {
    for (const input of [
      event(type, { directory: "/private/path", token: "private-token", remaining: "private-step" }),
      event(type, ["/private/path", "private-token"]),
      { ...event(type, null), payload: '{"directory":"/private/path","token":"private-token"' },
      { ...event(type, null), payload: { directory: "/private/path", token: "private-token" } },
      event(type, { version: "/private/path", token: "private-token" }),
    ]) {
      const encoded = policy.encode("run_events", input, A);
      expect(payload(encoded)).toEqual({ history: null });
      expect(JSON.stringify(encoded)).not.toContain("/private/path");
      expect(JSON.stringify(encoded)).not.toContain("private-token");
      expect(JSON.stringify(encoded)).not.toContain("private-step");
    }
  }, 5000);

  it.each(["child_supervisor", "child_transcript", "chain_steps"])("does not export extra event fields for %s", type => {
    const body = { ...event(type, { version: 8, token: "payload-token" }), tool: "tool-token", summary: "/private/summary", unexpected: "extra-token" };
    const encoded = policy.encode("run_events", body, A);
    expect(encoded.tool).toBeNull(); expect(encoded.summary).toBeNull();
    expect(encoded).not.toHaveProperty("unexpected");
    for (const secret of ["payload-token", "tool-token", "/private/summary", "extra-token"]) expect(JSON.stringify(encoded)).not.toContain(secret);
  }, 5000);

  it("does not export fields outside a resolved history-reference allowlist", () => {
    const extra = createExportPolicy((_path, origin) => ({ machineId: origin, reference: "safe-ref", token: "private-token", directory: "/private/path" }));
    const encoded = extra.encode("run_events", event("child_supervisor", { version: 1, directory: "/private/path" }), A);
    expect(payload(encoded)).toEqual({ version: 1, history: { machineId: A, reference: "safe-ref" } });
    expect(JSON.stringify(encoded)).not.toContain("private-token");
    expect(JSON.stringify(encoded)).not.toContain("/private/path");
  }, 5000);

  it("writes no sensitive future event fields to the exported wire batch", async () => {
    const root = replica("worktree", A);
    seedSession(root.db, SESSION, 1, root.storeKey, 4096);
    root.db.prepare("INSERT INTO run_events(uuid, session_id, ts, type, payload) VALUES (?, ?, ?, ?, ?)")
      .run("future-event", SESSION, 1, "child_transcript", JSON.stringify({ version: 7, directory: "/private/future", token: "private-token" }));
    const artifact = await exportBatch(root.db, { after: 0, targetBytes: 4096, batchId: "future-wire" }, policy);
    const bytes = readFileSync(artifact.file, "utf8");
    expect(bytes).not.toContain("/private/future"); expect(bytes).not.toContain("private-token");
    const record = bytes.trimEnd().split("\n").slice(1).map(line => JSON.parse(line)).find(item => item.rowKey === "future-event");
    expect(JSON.parse(record.body.payload)).toEqual({ version: 7, history: null });
    const again = await exportBatch(root.db, { after: 0, targetBytes: 4096, batchId: "future-wire" }, policy);
    expect(readFileSync(again.file, "utf8")).toBe(bytes);
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
