import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { ownRpcChild } from "../rpc-child";
import { adoptShared, parkSession, registerShared, resetSharedRegistryForTests } from "../child-registry";
import { resolve } from "node:path";

const fixtures: Array<{ child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } }> = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.child.emit("exit", 0);
    f.child.stdin.destroy(); f.child.stdout.destroy(); f.child.stderr.destroy();
  }
  resetSharedRegistryForTests(); vi.useRealTimers();
});
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const commands: any[] = []; const events: any[] = [];
  child.stdin.on("data", chunk => commands.push(JSON.parse(String(chunk))));
  const rpc = ownRpcChild(child as unknown as ChildProcess, "task", e => events.push(e));
  const out = (e: any) => child.stdout.write(JSON.stringify(e) + "\n");
  const response = (type: string) => out({ type: "response", command: type, id: commands.find(c => c.type === type)?.id, success: true });
  const f = { child, rpc, out, response, commands, events }; fixtures.push(f); return f;
}
it("waits beyond ten seconds for prompt preflight without closing stdin", async () => {
  vi.useFakeTimers(); const f = fixture();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.child.stdin.writableEnded).toBe(false);
  f.response("prompt"); f.out({ type: "agent_start" }); f.out({ type: "agent_settled" });
  await Promise.resolve();
  expect(f.child.stdin.writableEnded).toBe(true);
  expect(f.commands.filter(c => c.type === "prompt")).toHaveLength(1);
});
it("does not keep the process alive with the steer send timer", () => {
  vi.useRealTimers(); const f = fixture(); f.response("prompt");
  const timers = vi.spyOn(globalThis, "setTimeout");
  try {
    void f.rpc.steer("correction");
    const timer = timers.mock.results.at(-1)?.value as ReturnType<typeof setTimeout>;
    expect(timer.hasRef()).toBe(false);
  } finally { timers.mockRestore(); }
});
it("reports a child exit before prompt acceptance with the stderr tail", async () => {
  const f = fixture(); f.child.stderr.write("startup diagnostic: no provider auth\n");
  f.child.emit("exit", 3); await Promise.resolve();
  expect(f.events.some(e => /before.*prompt|prompt.*before/i.test(e.message ?? "") && /no provider auth/.test(e.message ?? ""))).toBe(true);
});
it("records non-delivery at settlement without retracting pi's acceptance or hanging", async () => {
  const f = fixture(); f.response("prompt"); f.out({ type: "agent_start" });
  const ack = f.rpc.steer("late correction");
  f.out({ type: "queue_update", steering: ["late correction"], followUp: [] }); f.response("steer");
  f.out({ type: "agent_settled" });
  expect(await ack).toMatchObject({ accepted: true });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "steer_delivery", delivered: false, message: expect.stringMatching(/accepted but not confirmed.*settle/i) }));
  expect(f.commands.some(c => c.type === "clear_queue")).toBe(true);
  expect(f.child.stdin.writableEnded).toBe(true);
});
it("keeps the send deadline during a long tool call and records later delivery", async () => {
  vi.useFakeTimers(); const f = fixture(); f.response("prompt"); f.out({ type: "agent_start" });
  f.out({ type: "tool_execution_start", toolCallId: "long" });
  const ack = f.rpc.steer("correction");
  f.out({ type: "queue_update", steering: ["correction"], followUp: [] }); f.response("steer");
  let accepted: any; void ack.then(value => { accepted = value; }); await vi.advanceTimersByTimeAsync(0);
  expect(accepted).toBeUndefined();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await ack).toMatchObject({ accepted: true, delivery: "accepted but not confirmed", queued: true });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(110_000);
  expect(f.child.stdin.writableEnded).toBe(false);
  f.out({ type: "tool_execution_end", toolCallId: "long" });
  f.out({ type: "queue_update", steering: [], followUp: [] });
  f.out({ type: "message_start", message: { role: "user", content: "correction" } });
  f.out({ type: "agent_settled" });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "steer_delivery", delivered: true }));
  expect(f.events.filter(e => e.type === "steer_delivery").at(-1)?.delivered).toBe(true);
  expect(f.child.stdin.writableEnded).toBe(true);
});
it("finalizes an unanswered steer at settlement without awaiting or crediting a late reply", async () => {
  const f = fixture(); f.response("prompt"); f.out({ type: "agent_start" });
  const ack = f.rpc.steer("too late"); f.out({ type: "agent_settled" }); f.response("steer");
  expect(await ack).toMatchObject({ accepted: false, delivery: "no reply yet, delivery unknown", error: expect.stringMatching(/settled before the child replied/i) });
  expect(f.child.stdin.writableEnded).toBe(true);
  expect(f.events.filter(e => e.type === "steer_delivery").map(e => e.delivery)).toEqual(["no reply yet, delivery unknown"]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "steer_delivery", delivered: false }));
});
it("does not accept a steer that pi rejects", async () => {
  const f = fixture(); f.response("prompt");
  const ack = f.rpc.steer("reject me");
  f.out({ type: "response", id: f.commands.find(c => c.type === "steer").id, success: false, error: "fixture rejection" });
  expect(await ack).toMatchObject({ accepted: false, delivery: "refused", error: "fixture rejection" });
});
it("does not accept a steer pi never answers", async () => {
  vi.useFakeTimers(); const f = fixture(); f.response("prompt");
  const ack = f.rpc.steer("unanswered");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await ack).toMatchObject({ accepted: false, delivery: "no reply yet, delivery unknown" });
});
it.each([
  ["settle", "Run settled; accepted, delivery not confirmed. Remaining queue was discarded."],
  ["exit", "Child process has exited."],
  ["abort", "Child was stopped."],
  ["pipe", "Child RPC pipe failed."],
])("resolves an accepted delivery wait exactly once on %s", async (cause, error) => {
  vi.useFakeTimers(); const f = fixture(); f.response("prompt"); f.out({ type: "agent_start" });
  const results: any[] = [];
  const ack = f.rpc.steer("pending correction"); void ack.then(value => results.push(value));
  f.out({ type: "queue_update", steering: ["pending correction"], followUp: [] }); f.response("steer");
  await vi.advanceTimersByTimeAsync(2_000); expect(results).toEqual([]);
  if (cause === "settle") f.out({ type: "agent_settled" });
  else if (cause === "exit") f.child.emit("exit", 1);
  else if (cause === "pipe") f.child.stdin.emit("error", new Error("fixture pipe failure"));
  else { const stop = f.rpc.abort(); f.response("abort"); await stop; }
  expect(await ack).toMatchObject({ accepted: true, delivered: false, delivery: "accepted but not confirmed", error });
  expect(vi.getTimerCount()).toBe(0);
  f.child.emit("exit", 1); f.out({ type: "message_start", message: { role: "user", content: "pending correction" } });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(results).toHaveLength(1);
  expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivered: false, steer: "pending correction", message: expect.stringContaining(error) });
});
it("waits for message_start two seconds after acknowledgement and queue removal", async () => {
  vi.useFakeTimers(); const f = fixture(); f.response("prompt");
  const results: any[] = [];
  const ack = f.rpc.steer("correction"); void ack.then(value => results.push(value));
  f.out({ type: "queue_update", steering: ["correction"], followUp: [] });
  f.response("steer");
  f.out({ type: "queue_update", steering: [], followUp: [] });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(results).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(results).toEqual([]);
  f.out({ type: "message_start", message: { role: "user", content: "correction" } });
  expect(await ack).toMatchObject({ accepted: true, delivered: true, delivery: "delivered", queued: false });
  expect(results).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
});
it("returns the queued state at the send deadline but retains late delivery evidence", async () => {
  vi.useFakeTimers(); const f = fixture(); f.response("prompt");
  const results: any[] = [];
  const ack = f.rpc.steer("correction"); void ack.then(value => results.push(value));
  f.out({ type: "queue_update", steering: ["correction"], followUp: [] }); f.response("steer");
  await vi.advanceTimersByTimeAsync(9_999); expect(results).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(await ack).toMatchObject({ accepted: true, delivered: false, delivery: "accepted but not confirmed", queued: true });
  expect(vi.getTimerCount()).toBe(0);
  f.out({ type: "queue_update", steering: [], followUp: [] });
  f.out({ type: "message_start", message: { role: "user", content: "correction" } });
  f.out({ type: "agent_settled" }); await vi.advanceTimersByTimeAsync(20_000);
  expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivered: true, delivery: "delivered" });
  expect(results).toHaveLength(1); expect(results[0].delivered).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("emits acceptance once across the deadline and delivery once on later entry", async () => {
  vi.useFakeTimers(); const f = fixture(); f.response("prompt");
  const ack = f.rpc.steer("correction"), command = f.commands.at(-1);
  f.out({ type: "queue_update", steering: ["correction"], followUp: [] }); f.response("steer");
  expect(f.events.filter(e => e.type === "steer_delivery").map(e => e.delivery)).toEqual(["accepted but not confirmed"]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await ack).toMatchObject({ delivery: "accepted but not confirmed", queued: true });
  expect(f.events.filter(e => e.type === "steer_delivery").map(e => e.delivery)).toEqual(["accepted but not confirmed"]);
  f.out({ type: "queue_update", steering: [], followUp: [] });
  f.out({ type: "message_start", message: { role: "user", content: "correction" } });
  f.out({ type: "message_start", message: { role: "user", content: "correction" } });
  expect(f.events.filter(e => e.type === "steer_delivery").map(e => [e.requestId, e.delivery])).toEqual([
    [command.id, "accepted but not confirmed"], [command.id, "delivered"],
  ]);
});
it("a nine-second acknowledgement leaves only one second to observe delivery", async () => {
  vi.useFakeTimers(); const f = fixture(); f.response("prompt");
  let result: any; const ack = f.rpc.steer("slow acceptance"); void ack.then(value => { result = value; });
  f.out({ type: "queue_update", steering: ["slow acceptance"], followUp: [] });
  await vi.advanceTimersByTimeAsync(9_000); f.response("steer");
  await vi.advanceTimersByTimeAsync(999); expect(result).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(await ack).toMatchObject({ accepted: true, queued: true, delivery: "accepted but not confirmed" });
  expect(vi.getTimerCount()).toBe(0);
});
it("returns delivery observed before acknowledgement only when the acknowledgement arrives", async () => {
  vi.useFakeTimers(); const f = fixture(); f.response("prompt");
  let result: any; const ack = f.rpc.steer("early entry"); void ack.then(value => { result = value; });
  f.out({ type: "queue_update", steering: ["early entry"], followUp: [] });
  f.out({ type: "message_start", message: { role: "user", content: "early entry" } });
  await vi.advanceTimersByTimeAsync(2_000); expect(result).toBeUndefined();
  f.response("steer"); expect(await ack).toMatchObject({ delivered: true, delivery: "delivered" });
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["second", "same"])("releases the acceptance window while two delivery waits coexist (%s)", async secondText => {
  vi.useFakeTimers(); const f = fixture(); f.response("prompt");
  const results: any[] = [];
  const first = f.rpc.steer("same"), second = f.rpc.steer(secondText);
  void first.then(value => results.push(value)); void second.then(value => results.push(value));
  expect(f.commands.filter(c => c.type === "steer")).toHaveLength(1);
  f.out({ type: "queue_update", steering: ["same"], followUp: [] }); f.response("steer");
  expect(f.commands.filter(c => c.type === "steer").map(c => c.message)).toEqual(["same", secondText]);
  f.out({ type: "queue_update", steering: ["same", secondText], followUp: [] });
  f.out({ type: "response", id: f.commands.at(-1).id, success: true });
  await vi.advanceTimersByTimeAsync(2_000); expect(results).toEqual([]);
  f.out({ type: "queue_update", steering: [secondText], followUp: [] });
  f.out({ type: "message_start", message: { role: "user", content: "same" } });
  expect(await first).toMatchObject({ delivered: true, delivery: "delivered" });
  expect(results).toHaveLength(1); expect(vi.getTimerCount()).toBe(1);
  expect(f.events.filter(e => e.type === "steer_delivery" && e.delivered)).toHaveLength(1);
  f.out({ type: "queue_update", steering: [], followUp: [] });
  f.out({ type: "message_start", message: { role: "user", content: secondText } });
  expect(await second).toMatchObject({ delivered: true, delivery: "delivered" });
  expect(results).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
});
it("does not credit an unrelated queue addition after acknowledgement as a transformed steer", async () => {
  vi.useFakeTimers(); const f = fixture(); f.response("prompt");
  const ack = f.rpc.steer("swallowed"); f.response("steer");
  f.out({ type: "queue_update", steering: ["unrelated"], followUp: [] });
  f.out({ type: "message_start", message: { role: "user", content: "unrelated" } });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await ack).toMatchObject({ delivered: false, queued: false, delivery: "accepted but not confirmed" });
  expect(f.events.some(e => e.type === "steer_delivery" && e.delivered)).toBe(false);
});
it.each(["resend", "concurrent"])("attributes identical-text delivery to the queued steer, not the swallowed one (%s)", async mode => {
  vi.useFakeTimers(); const f = fixture(); f.response("prompt");
  const first = f.rpc.steer("fix X"), firstCommand = f.commands.at(-1);
  let second: ReturnType<typeof f.rpc.steer>;
  if (mode === "concurrent") second = f.rpc.steer("fix X");
  f.out({ type: "response", id: firstCommand.id, success: true });
  if (mode === "resend") {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await first).toMatchObject({ delivery: "accepted but not confirmed", queued: false, requestId: firstCommand.id });
    second = f.rpc.steer("fix X");
  }
  const secondCommand = f.commands.at(-1);
  expect(secondCommand.id).not.toBe(firstCommand.id);
  f.out({ type: "queue_update", steering: ["fix X"], followUp: [] });
  f.out({ type: "response", id: secondCommand.id, success: true });
  f.out({ type: "queue_update", steering: [], followUp: [] });
  f.out({ type: "message_start", message: { role: "user", content: "fix X" } });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await second!).toMatchObject({ delivery: "delivered", delivered: true, requestId: secondCommand.id });
  expect(await first).toMatchObject({ delivery: "accepted but not confirmed", queued: false, requestId: firstCommand.id });
  expect(f.events.filter(e => e.type === "steer_delivery" && e.delivered)).toEqual([
    expect.objectContaining({ requestId: secondCommand.id, steer: "fix X", delivery: "delivered" }),
  ]);
});
it.each([true, false])("an old-instance delivery wait survives registry parking and adoption (gap delivery=%s)", async gapDelivery => {
  vi.useFakeTimers(); const f = fixture(); f.response("prompt");
  let result: any; const ack = f.rpc.steer("before reload"); void ack.then(value => { result = value; });
  f.out({ type: "queue_update", steering: ["before reload"], followUp: [] }); f.response("steer");
  await vi.advanceTimersByTimeAsync(2_000); expect(result).toBeUndefined();
  registerShared({ runId: "reload-wait", sessionId: "reload-owner", mode: "rpc", survivable: true,
    dbPath: resolve("unused-fixture.db"),
    handle: { ...f.rpc, wait: () => new Promise(() => {}), kill() {} } });
  parkSession("reload-owner", { onExpire() {} });
  const oldCount = f.events.length, replay: any[] = [];
  if (gapDelivery) f.out({ type: "message_start", message: { role: "user", content: "before reload" } });
  else await vi.advanceTimersByTimeAsync(8_000);
  expect(await ack).toMatchObject({ delivery: gapDelivery ? "delivered" : "accepted but not confirmed", queued: !gapDelivery });
  expect(f.events).toHaveLength(oldCount);
  expect(adoptShared("reload-owner", entry => entry.handle.bindEvents!(e => replay.push(e))).adopted).toEqual(["reload-wait"]);
  if (!gapDelivery) {
    expect(replay.filter(e => e.type === "steer_delivery")).toEqual([]);
    f.out({ type: "queue_update", steering: [], followUp: [] });
    f.out({ type: "message_start", message: { role: "user", content: "before reload" } });
  }
  expect(replay.filter(e => e.type === "steer_delivery")).toEqual([
    expect.objectContaining({ delivery: "delivered", steer: "before reload" }),
  ]);
  expect(vi.getTimerCount()).toBe(0);
});
it("reports prompt rejection as the failure rather than losing the child reason", async () => {
  const f = fixture();
  f.out({ type: "response", command: "prompt", id: f.commands[0].id, success: false, error: "No API key for test provider" });
  await Promise.resolve();
  expect(f.events.some(e => e.type === "warning" && /No API key/.test(e.message))).toBe(true);
  expect(f.child.stdin.writableEnded).toBe(true);
});

it.each(["stdout", "stderr"] as const)("drains and reports a %s stream error without crashing the parent", async stream => {
  const f = fixture(); f.response("prompt");
  expect(() => f.child[stream].emit("error", new Error("fixture stream failure"))).not.toThrow();
  expect(f.events.some(e => e.type === "warning" && /fixture stream failure/.test(e.message))).toBe(true);
  f.out({ type: "agent_settled" });
});
