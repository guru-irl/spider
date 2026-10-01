import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { ownRpcChild } from "../rpc-child";

const fixtures: Array<{ child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } }> = [];
afterEach(() => { vi.useRealTimers(); for (const f of fixtures.splice(0)) { f.child.emit("exit", 0); f.child.stdin.destroy(); f.child.stdout.destroy(); f.child.stderr.destroy(); } });
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const commands: any[] = [], events: any[] = [];
  child.stdin.on("data", c => commands.push(JSON.parse(String(c))));
  const rpc = ownRpcChild(child as unknown as ChildProcess, "initial task", e => events.push(e));
  const out = (e: any) => child.stdout.write(JSON.stringify(e) + "\n");
  out({ type: "response", id: commands[0].id, success: true }); out({ type: "agent_start" });
  const reply = (command: any, success = true) => out({ type: "response", command: command.type, id: command.id, success, error: success ? undefined : "fixture rejection" });
  const f = { child, commands, events, rpc, out, reply }; fixtures.push(f); return f;
}
const queue = (text: string[]) => ({ type: "queue_update", steering: text, followUp: [] });
const user = (text: string, type = "message_start") => ({ type, message: { role: "user", content: [{ type: "text", text }], timestamp: 123 } });

describe("truthful RPC steering", () => {
  // Treating RPC success as delivery must fail: swallowed input never enters the conversation.
  it("reports swallowed input as accepted but not confirmed at acceptance and settlement", async () => {
    const f = fixture(), ack = f.rpc.steer("SWALLOW marker"); f.reply(f.commands.at(-1));
    expect(await ack).toMatchObject({ accepted: true, delivered: false, queued: false, delivery: "accepted but not confirmed" });
    f.out({ type: "agent_settled" });
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ steer: "SWALLOW marker", accepted: true, delivered: false, delivery: "accepted but not confirmed", message: expect.stringContaining("accepted but not confirmed") });
    expect(f.child.stdin.writableEnded).toBe(true);
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1).message).not.toMatch(/discarded/i);
  });
  it("does not call queue removal delivery without a user message", async () => {
    const f = fixture(), ack = f.rpc.steer("removed"); f.out(queue(["removed"])); f.reply(f.commands.at(-1)); await ack;
    f.out(queue([])); f.out({ type: "agent_settled" });
    expect(f.events.filter(e => e.type === "steer_delivery").some(e => e.delivered)).toBe(false);
  });
  it.each([false, true])("confirms conversation entry before or after RPC acceptance (early=%s)", async early => {
    const f = fixture(), ack = f.rpc.steer("normal"); const command = f.commands.at(-1);
    f.out(queue(["normal"]));
    if (!early) { f.reply(command); expect(await ack).toMatchObject({ delivery: "accepted but not confirmed", queued: true }); }
    f.out(queue([])); f.out(user("normal")); f.out(user("normal", "message_end"));
    if (early) { f.reply(command); expect(await ack).toMatchObject({ accepted: true, delivered: true, delivery: "delivered" }); }
    f.out({ type: "agent_settled" });
    expect(f.events.filter(e => e.type === "steer_delivery" && e.delivered)).toHaveLength(1);
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "delivered" });
  });
  it("correlates transformed queue text and notes the transformation only after conversation entry", async () => {
    const f = fixture(), ack = f.rpc.steer("rewrite this"); f.out(queue(["rewritten instruction"])); f.reply(f.commands.at(-1)); await ack;
    f.out(queue([])); f.out(user("rewritten instruction")); f.out({ type: "agent_settled" });
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "delivered", steer: "rewrite this", observedText: "rewritten instruction", transformed: true, message: expect.stringMatching(/delivered.*transform/i) });
  });
  it("does not attribute an unrelated user message to swallowed input", async () => {
    const f = fixture(), ack = f.rpc.steer("swallowed"); f.reply(f.commands.at(-1)); await ack;
    f.out(user("unrelated extension message")); f.out({ type: "agent_settled" });
    expect(f.events.some(e => e.type === "steer_delivery" && e.delivered)).toBe(false);
  });
  it("serializes concurrent steers so a transformed second message is not credited to a swallowed first", async () => {
    const f = fixture(), first = f.rpc.steer("swallowed"), second = f.rpc.steer("rewrite");
    expect(f.commands.filter(c => c.type === "steer")).toHaveLength(1);
    f.reply(f.commands.at(-1)); await first; await Promise.resolve();
    const command = f.commands.at(-1); expect(command.message).toBe("rewrite");
    f.out(queue(["transformed"])); f.reply(command); await second; f.out(queue([])); f.out(user("transformed")); f.out({ type: "agent_settled" });
    const delivered = f.events.filter(e => e.type === "steer_delivery" && e.delivered);
    expect(delivered).toHaveLength(1); expect(delivered[0].steer).toBe("rewrite");
  });
  it("one user event confirms only one of two identical queued steers", async () => {
    const f = fixture(), a = f.rpc.steer("same"); f.out(queue(["same"])); f.reply(f.commands.at(-1)); await a;
    const b = f.rpc.steer("same"); f.out(queue(["same", "same"])); f.reply(f.commands.at(-1)); await b;
    f.out(queue(["same"])); f.out(user("same")); f.out({ type: "agent_settled" });
    expect(f.events.filter(e => e.type === "steer_delivery" && e.delivered)).toHaveLength(1);
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "accepted but not confirmed" });
  });
  // Reuses the reviewer's P1/P2 queue-window probes. First-addition attribution is a false positive.
  it.each([false, true])("prefers exact text among several additions (oneUpdate=%s)", async oneUpdate => {
    const f = fixture(), ack = f.rpc.steer("exact");
    if (!oneUpdate) f.out(queue(["unrelated"]));
    f.out(queue(["unrelated", "exact"])); f.reply(f.commands.at(-1));
    expect(await ack).toMatchObject({ delivery: "accepted but not confirmed", queued: true });
    f.out(queue(["exact"])); f.out(user("unrelated"));
    expect(f.events.some(e => e.type === "steer_delivery" && e.delivered)).toBe(false);
    f.out(queue([])); f.out(user("exact"));
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "delivered", transformed: false, observedText: "exact" });
  });
  it.each([false, true])("requires a sole addition for transformed delivery (earlyEntry=%s)", async earlyEntry => {
    const f = fixture(), ack = f.rpc.steer("rewritten");
    f.out(queue(["first unrelated"]));
    if (earlyEntry) { f.out(queue([])); f.out(user("first unrelated")); }
    f.out(queue(earlyEntry ? ["second unrelated"] : ["first unrelated", "second unrelated"]));
    f.reply(f.commands.at(-1));
    expect(await ack).toMatchObject({ delivery: "accepted but not confirmed", queued: false });
    f.out(queue([])); f.out(user("first unrelated")); f.out(user("second unrelated")); f.out({ type: "agent_settled" });
    expect(f.events.some(e => e.type === "steer_delivery" && e.delivered)).toBe(false);
  });
  // Review P3: a timeout is uncertainty, and must retain the original correlation window.
  it("tracks a late reply and conversation entry after reporting no reply yet", async () => {
    vi.useFakeTimers(); const f = fixture();
    const first = f.rpc.steer("slow handler");
    const command = f.commands.at(-1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await first).toMatchObject({ accepted: false, delivery: "no reply yet, delivery unknown" });
    expect(f.commands.filter(c => c.type === "steer")).toHaveLength(1);
    const second = f.rpc.steer("second");
    f.out(queue(["slow handler"])); f.reply(command);
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "accepted but not confirmed" });
    await Promise.resolve();
    expect(f.commands.at(-1).message).toBe("second");
    f.reply(f.commands.at(-1)); expect(await second).toMatchObject({ accepted: true, delivery: "accepted but not confirmed" });
    f.out(queue([])); f.out(user("slow handler"));
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "delivered", steer: "slow handler" });
    const third = f.rpc.steer("third"); f.reply(f.commands.at(-1)); expect(await third).toMatchObject({ accepted: true });
  });
  it("can observe delivery after timeout before a late reply", async () => {
    vi.useFakeTimers(); const f = fixture(), ack = f.rpc.steer("slow"); const command = f.commands.at(-1);
    await vi.advanceTimersByTimeAsync(10000); await ack;
    f.out(queue(["slow"])); f.out(queue([])); f.out(user("slow"));
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "delivered" });
    f.reply(command);
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "delivered" });
  });
  // Review P4: proof survives exit/abort/timeout before the acceptance reply.
  it.each(["exit", "abort", "timeout", "settle"])("preserves observed entry before reply on %s", async cause => {
    vi.useFakeTimers(); const f = fixture(), ack = f.rpc.steer("fast");
    f.out(queue(["fast"])); f.out(queue([])); f.out(user("fast"));
    if (cause === "exit") f.child.emit("exit", 0);
    else if (cause === "timeout") await vi.advanceTimersByTimeAsync(10000);
    else if (cause === "settle") { f.out({ type: "agent_settled" }); expect(f.child.stdin.writableEnded).toBe(true); }
    else { const stop = f.rpc.abort(); f.reply(f.commands.at(-1)); await stop; }
    expect(await ack).toMatchObject({ delivery: "delivered", delivered: true });
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "delivered" });
  });
  // Review P5 / mutant M10: entries read after stopping are not evidence.
  it("ignores conversation-entry events after abort begins", async () => {
    const f = fixture(), ack = f.rpc.steer("x"); f.out(queue(["x"])); f.reply(f.commands.at(-1)); await ack;
    const stop = f.rpc.abort(); f.out(queue([])); f.out(user("x")); f.reply(f.commands.at(-1)); await stop;
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "accepted but not confirmed" });
    expect(f.events.some(e => e.type === "steer_delivery" && e.delivered)).toBe(false);
  });
  it("distinguishes a written unanswered steer from callers never written on exit", async () => {
    vi.useFakeTimers();
    const f = fixture(), steers = [f.rpc.steer("a"), f.rpc.steer("b"), f.rpc.steer("c")];
    const results: any[] = []; void Promise.all(steers).then(acks => results.push(...acks));
    f.child.emit("exit", 1);
    await Promise.resolve(); await Promise.resolve();
    // No clock advance: the waiter deadline must not be the exit cleanup.
    expect(results).toHaveLength(3);
    expect(results.slice(1).every(ack => /not sent.*exited/i.test(ack.error))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(results.map(ack => ack.delivery)).toEqual(["no reply yet, delivery unknown", "refused", "refused"]);
    expect(f.commands.filter(c => c.type === "steer")).toHaveLength(1);
  });
  it.each(["/command", "/skill:test", "  /template"])('refuses command-like text "%s" without writing it to pi', async text => {
    const f = fixture();
    expect(await f.rpc.steer(text)).toMatchObject({ accepted: false, delivery: "refused", error: expect.stringMatching(/expanded by the child as a skill or prompt template/i) });
    expect(f.commands.filter(c => c.type === "steer")).toHaveLength(0);
  });
  // Round-2 W1/W2: an input handler can outlive both its deadline and the agent.
  it("finalizes unanswered written steers and refuses waiters when the run settles", async () => {
    vi.useFakeTimers(); const f = fixture();
    const first = f.rpc.steer("hung handler");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await first).toMatchObject({ delivery: "no reply yet, delivery unknown" });
    const second = f.rpc.steer("correction");
    f.out({ type: "agent_end" }); f.out({ type: "agent_settled" });
    expect(f.child.stdin.writableEnded).toBe(true);
    expect(await second).toMatchObject({ delivery: "refused", error: expect.stringMatching(/settled/i) });
    expect(f.events.filter(e => e.type === "steer_delivery").findLast(e => e.steer === "hung handler"))
      .toMatchObject({ delivery: "no reply yet, delivery unknown", message: expect.stringMatching(/settled before the child replied/i) });
    expect(f.commands.map(c => c.type)).toEqual(["prompt", "steer", "clear_queue"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds every waiter behind an unanswered steer without writing it, then recovers on a late reply", async () => {
    vi.useFakeTimers(); const f = fixture();
    const first = f.rpc.steer("hung handler"), command = f.commands.at(-1);
    await vi.advanceTimersByTimeAsync(10_000); await first;
    const second = f.rpc.steer("correction"), third = f.rpc.steer("another correction");
    let replies = 0; void second.then(() => replies++); void third.then(() => replies++);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(replies).toBe(2);
    for (const ack of await Promise.all([second, third])) expect(ack).toMatchObject({ delivery: "refused", error: expect.stringMatching(/not sent/i) });
    expect(f.commands.filter(c => c.type === "steer")).toHaveLength(1);
    f.reply(command); const recovered = f.rpc.steer("after reply"); f.reply(f.commands.at(-1));
    expect(await recovered).toMatchObject({ accepted: true });
    expect(vi.getTimerCount()).toBe(0);
  });
  // Round-2 A5/A5b: without a reply, a lone differing entry is not proof of a rewrite.
  it.each(["exit", "abort", "settle"])("does not promote an unrelated entry before reply on %s", async cause => {
    vi.useFakeTimers(); const f = fixture(), ack = f.rpc.steer("original");
    f.out(queue(["injected by handler"])); f.out(queue([])); f.out(user("injected by handler"));
    if (cause === "exit") { await vi.advanceTimersByTimeAsync(10_000); await ack; f.child.emit("exit", 1); }
    else if (cause === "settle") { f.out({ type: "agent_settled" }); expect(f.child.stdin.writableEnded).toBe(true); }
    else { const stop = f.rpc.abort(1); f.reply(f.commands.at(-1)); await stop; }
    expect(await ack).toMatchObject({ delivered: false, delivery: "no reply yet, delivery unknown" });
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "no reply yet, delivery unknown" });
    expect(f.events.some(e => e.type === "steer_delivery" && e.delivered)).toBe(false);
  });
  it("does not move observed exact delivery backwards on a late failure reply", async () => {
    const f = fixture(), ack = f.rpc.steer("exact");
    f.out(queue(["exact"])); f.out(queue([])); f.out(user("exact")); f.reply(f.commands.at(-1), false);
    expect(await ack).toMatchObject({ delivered: true, delivery: "delivered" });
    expect(f.events.filter(e => e.type === "steer_delivery").map(e => e.delivery)).toEqual(["delivered"]);
  });
  // Round-2 A8/A9 controls: multiset additions and entry matching across pending steers.
  it("confirms both identical steers when both enter the conversation", async () => {
    const f = fixture(), a = f.rpc.steer("same"); f.out(queue(["same"])); f.reply(f.commands.at(-1)); await a;
    const b = f.rpc.steer("same"); f.out(queue(["same", "same"])); f.reply(f.commands.at(-1)); await b;
    f.out(queue(["same"])); f.out(user("same")); f.out(queue([])); f.out(user("same"));
    expect(f.events.filter(e => e.type === "steer_delivery" && e.delivered)).toHaveLength(2);
  });
  it("matches a later entry only to its own pending steer", async () => {
    const f = fixture(), a = f.rpc.steer("first"); f.out(queue(["first"])); f.reply(f.commands.at(-1)); await a;
    const b = f.rpc.steer("second"); f.out(queue(["first", "second"])); f.reply(f.commands.at(-1)); await b;
    f.out(queue(["first"])); f.out(user("second"));
    expect(f.events.filter(e => e.type === "steer_delivery" && e.delivered).map(e => e.steer)).toEqual(["second"]);
  });

  it("allows a reply just before the full ten-second reply deadline", async () => {
    vi.useFakeTimers(); const f = fixture(), ack = f.rpc.steer("slow but healthy");
    let resolved = false; void ack.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(resolved).toBe(false);
    f.reply(f.commands.at(-1));
    expect(await ack).toMatchObject({ accepted: true, delivery: "accepted but not confirmed" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("writes a waiter released just before its full ten-second deadline and clears its timer", async () => {
    vi.useFakeTimers(); const f = fixture(), first = f.rpc.steer("first"), command = f.commands.at(-1);
    const second = f.rpc.steer("waiter"); let resolved = false; void second.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(resolved).toBe(false);
    expect(f.commands.filter(c => c.type === "steer")).toHaveLength(1);
    f.reply(command); await first; await Promise.resolve();
    expect(f.commands.at(-1).message).toBe("waiter");
    f.reply(f.commands.at(-1));
    expect(await second).toMatchObject({ accepted: true, delivery: "accepted but not confirmed" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears an unanswered reply timer immediately at settlement", async () => {
    vi.useFakeTimers(); const f = fixture(), ack = f.rpc.steer("unanswered");
    expect(vi.getTimerCount()).toBe(1);
    f.out({ type: "agent_settled" });
    expect(await ack).toMatchObject({ delivery: "no reply yet, delivery unknown", error: expect.stringMatching(/settled/i) });
    expect(vi.getTimerCount()).toBe(0);
  });

});
