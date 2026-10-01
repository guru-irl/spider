import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ownRpcChild, MAX_BUFFERED_BYTES, MAX_BUFFERED_EVENTS, MAX_BUFFERED_PERSISTED } from "../rpc-child";

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}
const emit = (child: any, event: Record<string, unknown>) => child.stdout.write(JSON.stringify(event) + "\n");
const tick = () => new Promise(r => setTimeout(r, 5));

describe("ownRpcChild event rebinding (reload survival)", () => {
  it("buffers events while unbound and replays them in order to the next sink", async () => {
    const child = fakeChild();
    const first: string[] = []; const second: string[] = [];
    const rpc = ownRpcChild(child, "go", e => first.push(e.type));
    emit(child, { type: "agent_start" });
    await tick();
    expect(first).toContain("agent_start");
    rpc.unbindEvents();
    emit(child, { type: "queue_update", steering: [], followUp: [] });
    emit(child, { type: "warning", message: "while detached" });
    await tick();
    expect(first).not.toContain("warning");
    rpc.bindEvents(e => second.push(e.type));
    expect(second).toEqual(["queue_update", "warning"]);
    emit(child, { type: "agent_settled" });
    await tick();
    expect(second).toEqual(["queue_update", "warning", "agent_settled"]);
    expect(first).not.toContain("agent_settled");
  });

  it("keeps protocol handling (steer state, extension UI cancel) running while unbound", async () => {
    const child = fakeChild();
    const writes: string[] = [];
    child.stdin.on("data", (d: Buffer) => writes.push(String(d)));
    const rpc = ownRpcChild(child, "go", () => {});
    rpc.unbindEvents();
    emit(child, { type: "extension_ui_request", id: "u1", method: "confirm" });
    await tick();
    expect(writes.join("")).toContain('"extension_ui_response"');
  });

  it("does not buffer streaming partial updates while unbound", async () => {
    const child = fakeChild();
    const got: Array<Record<string, any>> = [];
    const rpc = ownRpcChild(child, "go", () => {});
    rpc.unbindEvents();
    for (let i = 0; i < 300; i++) emit(child, { type: "message_update", message: { content: "x".repeat(200) }, n: i });
    for (let i = 0; i < 300; i++) emit(child, { type: "tool_execution_update", partialResult: "y".repeat(200), n: i });
    emit(child, { type: "message_end", message: { content: "full" } });
    await tick(); await tick();
    rpc.bindEvents(e => got.push(e));
    expect(got.filter(e => e.type === "message_update" || e.type === "tool_execution_update")).toEqual([]);
    expect(got.map(e => e.type)).toEqual(["message_end"]);
  });

  it("streaming deltas never evict a persisted event, and order is preserved", async () => {
    const child = fakeChild();
    const got: Array<Record<string, any>> = [];
    const rpc = ownRpcChild(child, "go", () => {});
    rpc.unbindEvents();
    emit(child, { type: "steer_delivery", requestId: "x", delivered: false, message: "important" });
    for (let i = 0; i < 600; i++) emit(child, { type: "message_update", message: { content: "x".repeat(100) }, n: i });
    emit(child, { type: "warning", message: "later warning" });
    await tick(); await tick();
    rpc.bindEvents(e => got.push(e));
    expect(got.map(e => e.type)).toEqual(["steer_delivery", "warning"]);
  });

  it("non-persisted events are bounded by count and evicted oldest-first without touching persisted ones", async () => {
    const child = fakeChild();
    const got: Array<Record<string, any>> = [];
    const rpc = ownRpcChild(child, "go", () => {});
    rpc.unbindEvents();
    emit(child, { type: "queue_update", steering: [], followUp: [], n: -1 });
    for (let i = 0; i < 700; i++) emit(child, { type: "tool_execution_end", n: i });
    await tick(); await tick();
    rpc.bindEvents(e => got.push(e));
    expect(got.some(e => e.type === "queue_update")).toBe(true);
    const tools = got.filter(e => e.type === "tool_execution_end");
    expect(tools.length).toBeLessThanOrEqual(MAX_BUFFERED_EVENTS);
    expect(tools[tools.length - 1].n).toBe(699);
  });

  it("bounds the buffer by bytes, not only by count", async () => {
    const child = fakeChild();
    const got: Array<Record<string, any>> = [];
    const rpc = ownRpcChild(child, "go", () => {});
    rpc.unbindEvents();
    const big = "z".repeat(64 * 1024);
    for (let i = 0; i < 100; i++) emit(child, { type: "tool_execution_end", n: i, big });
    await tick(); await tick();
    rpc.bindEvents(e => got.push(e));
    const kept = got.filter(e => e.type === "tool_execution_end");
    expect(kept.length * 64 * 1024).toBeLessThanOrEqual(MAX_BUFFERED_BYTES + 64 * 1024);
    expect(kept[kept.length - 1].n).toBe(99);
  });

  it("overflowing the persisted queue is reported truthfully, with a flag the run can finalize on", async () => {
    const child = fakeChild();
    const got: Array<Record<string, any>> = [];
    const rpc = ownRpcChild(child, "go", () => {});
    rpc.unbindEvents();
    for (let i = 0; i < MAX_BUFFERED_PERSISTED + 50; i++) emit(child, { type: "queue_update", steering: [], followUp: [], n: i });
    await tick(); await tick(); await tick();
    rpc.bindEvents(e => got.push(e));
    const loss = got.find(e => e.type === "warning" && e.eventsLost > 0);
    expect(loss).toBeDefined();
    expect(loss!.eventsLost).toBe(50);
    expect(loss!.message).toMatch(/lost during reload/i);
    expect(got[got.length - 1].n).toBe(MAX_BUFFERED_PERSISTED + 49);
  });

  it("a plain gap loses nothing and reports no loss", async () => {
    const child = fakeChild();
    const got: Array<Record<string, any>> = [];
    const rpc = ownRpcChild(child, "go", () => {});
    rpc.unbindEvents();
    emit(child, { type: "warning", message: "w" });
    await tick();
    rpc.bindEvents(e => got.push(e));
    expect(got.some(e => e.eventsLost)).toBe(false);
  });
});
