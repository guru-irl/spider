import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { ownRpcChild } from "../rpc-child";

afterEach(() => vi.useRealTimers());
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const commands: any[] = []; const events: any[] = [];
  child.stdin.on("data", chunk => commands.push(JSON.parse(String(chunk))));
  const rpc = ownRpcChild(child as unknown as ChildProcess, "task", e => events.push(e));
  const out = (e: any) => child.stdout.write(JSON.stringify(e) + "\n");
  const response = (type: string) => out({ type: "response", command: type, id: commands.find(c => c.type === type)?.id, success: true });
  return { child, rpc, out, response, commands, events };
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
  expect(f.events).toContainEqual(expect.objectContaining({ type: "steer_delivery", delivered: false, message: expect.stringMatching(/not delivered.*settle/i) }));
  expect(f.commands.some(c => c.type === "clear_queue")).toBe(true);
  expect(f.child.stdin.writableEnded).toBe(true);
});
it("accepts steering during a long tool call and clears the acceptance deadline", async () => {
  vi.useFakeTimers(); const f = fixture(); f.response("prompt"); f.out({ type: "agent_start" });
  f.out({ type: "tool_execution_start", toolCallId: "long" });
  const ack = f.rpc.steer("correction");
  f.out({ type: "queue_update", steering: ["correction"], followUp: [] }); f.response("steer");
  // Success is returned at acceptance, not after the tool eventually finishes.
  let accepted: any; void ack.then(value => { accepted = value; }); await vi.advanceTimersByTimeAsync(0);
  expect(accepted).toEqual({ accepted: true });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.child.stdin.writableEnded).toBe(false);
  f.out({ type: "tool_execution_end", toolCallId: "long" });
  f.out({ type: "queue_update", steering: [], followUp: [] });
  f.out({ type: "agent_settled" });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "steer_delivery", delivered: true }));
  expect(f.events.some(e => e.type === "steer_delivery" && e.delivered === false)).toBe(false);
  expect(f.child.stdin.writableEnded).toBe(true);
});
it("refuses a steer accepted only after settlement", async () => {
  const f = fixture(); f.response("prompt"); f.out({ type: "agent_start" });
  const ack = f.rpc.steer("too late"); f.out({ type: "agent_settled" }); f.response("steer");
  expect(await ack).toMatchObject({ accepted: false, childAccepted: true, error: expect.stringMatching(/finished|settled/i) });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "steer_delivery", delivered: false }));
});
it("does not accept a steer that pi rejects", async () => {
  const f = fixture(); f.response("prompt");
  const ack = f.rpc.steer("reject me");
  f.out({ type: "response", id: f.commands.find(c => c.type === "steer").id, success: false, error: "fixture rejection" });
  expect(await ack).toEqual({ accepted: false, error: "fixture rejection" });
});
it("does not accept a steer pi never answers", async () => {
  vi.useFakeTimers(); const f = fixture(); f.response("prompt");
  const ack = f.rpc.steer("unanswered");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await ack).toMatchObject({ accepted: false, error: expect.stringMatching(/unconfirmed/i) });
});
it.each(["exit", "abort", "pipe"])("records non-delivery for an accepted pending steer on %s", async cause => {
  const f = fixture(); f.response("prompt"); f.out({ type: "agent_start" });
  const ack = f.rpc.steer("pending correction"); f.response("steer"); expect(await ack).toEqual({ accepted: true });
  if (cause === "exit") f.child.emit("exit", 1);
  else if (cause === "pipe") f.child.stdin.emit("error", new Error("fixture pipe failure"));
  else { const stop = f.rpc.abort(); f.response("abort"); await stop; }
  expect(f.events.filter(e => e.type === "steer_delivery")).toEqual([expect.objectContaining({ delivered: false, steer: "pending correction", message: expect.stringMatching(/not delivered/i) })]);
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
