import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { isHandledPrompt, ownRpcChild } from "../rpc-child";

const fixtures: Array<{ child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } }> = [];
afterEach(() => { vi.useRealTimers(); for (const f of fixtures.splice(0)) { f.child.emit("exit", 0); f.child.stdin.destroy(); f.child.stdout.destroy(); f.child.stderr.destroy(); } });
function fixture(promptDisposition?: unknown, start = true) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const commands: any[] = [], events: any[] = [];
  child.stdin.on("data", c => commands.push(JSON.parse(String(c))));
  const rpc = ownRpcChild(child as unknown as ChildProcess, "initial task", e => events.push(e));
  const out = (e: any) => child.stdout.write(JSON.stringify(e) + "\n");
  out({ type: "response", command: "prompt", id: commands[0].id, success: true, ...(promptDisposition === undefined ? {} : { data: { disposition: promptDisposition } }) });
  if (start) out({ type: "agent_start" });
  const reply = (command: any, success = true, disposition?: unknown) => out({ type: "response", command: command.type, id: command.id, success, error: success ? undefined : "fixture rejection", ...(disposition === undefined ? {} : { data: { disposition } }) });
  const f = { child, commands, events, rpc, out, reply }; fixtures.push(f); return f;
}
const queue = (text: string[]) => ({ type: "queue_update", steering: text, followUp: [] });
const user = (text: string, type = "message_start") => ({ type, message: { role: "user", content: [{ type: "text", text }], timestamp: 123 } });

describe("handled prompt marker", () => {
  // Replacing Symbol.for with a module-local Symbol would lose markers across reloads.
  it("recognizes the shared symbol key but rejects a JSON promptHandled field", () => {
    expect(isHandledPrompt({ [Symbol.for("spider.handledPrompt.v1")]: true })).toBe(true);
    expect(isHandledPrompt(JSON.parse('{"promptHandled":true}'))).toBe(false);
  });
});

describe("truthful RPC steering", () => {
  beforeEach(() => vi.useFakeTimers());
  // Ignoring handled would leave stdin open forever because no agent_settled follows.
  it("closes an initial handled prompt without waiting for settlement", async () => {
    const f = fixture("handled", false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.child.stdin.writableEnded).toBe(true);
    expect(f.rpc.failureReason()).toMatch(/consumed by an extension.*handled.*no model run started for the task/i);
    expect(f.events.some(e => e.type === "agent_settled")).toBe(false);
    expect(f.events.some(e => e.type === "spider_usage")).toBe(false);
    expect(f.commands.map(c => c.type)).toEqual(["prompt"]);
    expect(await f.rpc.steer("too late")).toMatchObject({ delivery: "refused", accepted: false });
  });
  it.each(["started", "queued", undefined])("waits for settlement after initial disposition %s", async disposition => {
    const f = fixture(disposition, false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.child.stdin.writableEnded).toBe(false);
    expect(f.rpc.failureReason()).toBeUndefined();
    f.out({ type: "agent_start" }); f.out({ type: "agent_end" });
    expect(f.child.stdin.writableEnded).toBe(false);
    f.out({ type: "agent_settled" });
    expect(f.child.stdin.writableEnded).toBe(true);
    expect(f.events.some(e => e.type === "warning")).toBe(false);
  });
  // A handled response must end tracking immediately, not leave a delivery deadline running.
  it("resolves a handled steer immediately without observed-delivery tracking", async () => {
    const f = fixture(), pending = f.rpc.steer("consumed");
    let ack: any; void pending.then(value => { ack = value; });
    const command = f.commands.at(-1);
    f.reply(command, true, "handled");
    await vi.advanceTimersByTimeAsync(0);
    expect(ack).toMatchObject({ accepted: true, childAccepted: true, delivered: false, queued: false, delivery: "consumed by an extension, not delivered" });
    expect(vi.getTimerCount()).toBe(0);
    expect(f.child.stdin.writableEnded).toBe(false);
    // Duplicated replies and unrelated later entries cannot promote consumed input to delivery.
    f.reply(command, true, "handled"); f.out(queue(["consumed"])); f.out(user("consumed"));
    f.out({ type: "agent_settled" });
    expect(f.events.filter(e => e.type === "steer_delivery")).toHaveLength(1);
    expect(f.events.find(e => e.type === "steer_delivery")).toMatchObject({ delivered: false, delivery: ack.delivery });
  });
  // Downgrading a prior exact-text observation on handled must fail this case.
  it("keeps observed delivery when the handled steer reply arrives", async () => {
    const f = fixture(), pending = f.rpc.steer("already observed"), command = f.commands.at(-1);
    f.out(queue(["already observed"])); f.out(queue([])); f.out(user("already observed"));
    f.reply(command, true, "handled");
    expect(await pending).toMatchObject({ accepted: true, delivered: true, queued: false, delivery: "delivered", observedText: "already observed" });
    expect(f.events.filter(e => e.type === "steer_delivery").map(e => e.delivery)).toEqual(["delivered"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  // Removing the validator's success gate would warn on this rejected reply.
  it("does not warn about an unknown disposition on a failed reply", async () => {
    const f = fixture(), pending = f.rpc.steer("rejected unknown");
    f.reply(f.commands.at(-1), false, "future");
    expect(await pending).toMatchObject({ accepted: false, delivery: "refused", error: "fixture rejection" });
    expect(f.events.filter(e => e.type === "warning")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ends late-reply uncertainty as consumed without creating a new delivery wait", async () => {
    const f = fixture(), pending = f.rpc.steer("slow consumed"), command = f.commands.at(-1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ delivery: "no reply yet, delivery unknown" });
    f.reply(command, true, "handled");
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivered: false, queued: false, delivery: "consumed by an extension, not delivered" });
    expect(vi.getTimerCount()).toBe(0);
    f.out({ type: "agent_settled" });
    expect(f.events.filter(e => e.type === "steer_delivery")).toHaveLength(2);
  });
  it("releases the next steer after a handled reply without tracking the consumed one", async () => {
    const f = fixture(), first = f.rpc.steer("consumed"), second = f.rpc.steer("next");
    f.reply(f.commands.at(-1), true, "handled");
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toMatchObject({ delivery: "consumed by an extension, not delivered" });
    expect(f.commands.at(-1).message).toBe("next");
    f.out(queue(["next"])); f.reply(f.commands.at(-1), true, "queued"); f.out(queue([])); f.out(user("next"));
    expect(await second).toMatchObject({ delivered: true, delivery: "delivered" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["queued", undefined])("requires observed entry for steer disposition %s", async disposition => {
    const f = fixture(), pending = f.rpc.steer("observe me");
    let resolved = false; void pending.then(() => { resolved = true; });
    f.out(queue(["observe me"])); f.reply(f.commands.at(-1), true, disposition);
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    f.out(queue([])); f.out(user("observe me"));
    expect(await pending).toMatchObject({ accepted: true, delivered: true, delivery: "delivered" });
    expect(f.events.some(e => e.type === "warning")).toBe(false);
  });
  it("does not interpret handled on a rejected steer as consumption", async () => {
    const f = fixture(), pending = f.rpc.steer("rejected"); f.reply(f.commands.at(-1), false, "handled");
    expect(await pending).toMatchObject({ accepted: false, delivered: false, delivery: "refused", error: "fixture rejection" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["future", null, 7])("treats unknown prompt disposition %s as legacy with one warning", async disposition => {
    const f = fixture(disposition, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.child.stdin.writableEnded).toBe(false);
    expect(f.rpc.failureReason()).toBeUndefined();
    expect(f.events.filter(e => e.type === "warning")).toHaveLength(1);
    expect(f.events.find(e => e.type === "warning").message).toMatch(/unknown.*disposition.*legacy/i);
    f.out({ type: "agent_start" });
    const pending = f.rpc.steer("legacy fallback");
    f.out(queue(["legacy fallback"])); f.reply(f.commands.at(-1), true, "another future");
    f.out(queue([])); f.out(user("legacy fallback"));
    expect(await pending).toMatchObject({ delivered: true, delivery: "delivered" });
    expect(f.events.filter(e => e.type === "warning")).toHaveLength(1);
    f.out({ type: "agent_settled" });
    expect(f.child.stdin.writableEnded).toBe(true);
  });
  it.each(["future", "started", null, { value: "handled" }])("treats unknown steer disposition %s as legacy", async disposition => {
    const f = fixture(), pending = f.rpc.steer("fallback");
    f.out(queue(["fallback"])); f.reply(f.commands.at(-1), true, disposition);
    let resolved = false; void pending.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    expect(f.events.filter(e => e.type === "warning")).toHaveLength(1);
    f.out(queue([])); f.out(user("fallback"));
    expect(await pending).toMatchObject({ accepted: true, delivered: true, delivery: "delivered" });
  });
  // Treating RPC success as delivery must fail: swallowed input never enters the conversation.
  it("reports swallowed input as accepted but not confirmed at the deadline and settlement", async () => {
    const f = fixture(), ack = f.rpc.steer("SWALLOW marker"); f.reply(f.commands.at(-1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await ack).toMatchObject({ accepted: true, delivered: false, queued: false, delivery: "accepted but not confirmed" });
    f.out({ type: "agent_settled" });
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ steer: "SWALLOW marker", accepted: true, delivered: false, delivery: "accepted but not confirmed", message: expect.stringContaining("accepted but not confirmed") });
    expect(f.child.stdin.writableEnded).toBe(true);
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1).message).not.toMatch(/discarded/i);
  });
  it("does not call queue removal delivery without a user message", async () => {
    const f = fixture(), ack = f.rpc.steer("removed"); f.out(queue(["removed"])); f.reply(f.commands.at(-1));
    f.out(queue([])); f.out({ type: "agent_settled" });
    expect(await ack).toMatchObject({ delivery: "accepted but not confirmed", queued: false });
    expect(f.events.filter(e => e.type === "steer_delivery").some(e => e.delivered)).toBe(false);
  });
  it.each([false, true])("confirms conversation entry before or after RPC acceptance (early=%s)", async early => {
    const f = fixture(), ack = f.rpc.steer("normal"); const command = f.commands.at(-1);
    f.out(queue(["normal"]));
    if (!early) f.reply(command);
    f.out(queue([])); f.out(user("normal")); f.out(user("normal", "message_end"));
    if (early) f.reply(command);
    expect(await ack).toMatchObject({ accepted: true, delivered: true, delivery: "delivered" });
    f.out({ type: "agent_settled" });
    expect(f.commands.some(c => c.type === "clear_queue")).toBe(false);
    expect(f.child.stdin.writableEnded).toBe(true);
    expect(f.events.filter(e => e.type === "steer_delivery" && e.delivered)).toHaveLength(1);
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "delivered" });
  });
  it("correlates transformed queue text and notes the transformation only after conversation entry", async () => {
    const f = fixture(), ack = f.rpc.steer("rewrite this"); f.out(queue(["rewritten instruction"])); f.reply(f.commands.at(-1));
    f.out(queue([])); f.out(user("rewritten instruction")); f.out({ type: "agent_settled" });
    expect(await ack).toMatchObject({ delivery: "delivered", transformed: true });
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "delivered", steer: "rewrite this", observedText: "rewritten instruction", transformed: true, message: expect.stringMatching(/delivered.*transform/i) });
  });
  it("does not attribute an unrelated user message to swallowed input", async () => {
    const f = fixture(), ack = f.rpc.steer("swallowed"); f.reply(f.commands.at(-1));
    f.out(user("unrelated extension message")); f.out({ type: "agent_settled" });
    expect(await ack).toMatchObject({ delivery: "accepted but not confirmed" });
    expect(f.events.some(e => e.type === "steer_delivery" && e.delivered)).toBe(false);
  });
  it("serializes concurrent steers so a transformed second message is not credited to a swallowed first", async () => {
    const f = fixture(), first = f.rpc.steer("swallowed"), second = f.rpc.steer("rewrite");
    expect(f.commands.filter(c => c.type === "steer")).toHaveLength(1);
    f.reply(f.commands.at(-1)); await Promise.resolve();
    const command = f.commands.at(-1); expect(command.message).toBe("rewrite");
    f.out(queue(["transformed"])); f.reply(command); f.out(queue([])); f.out(user("transformed")); f.out({ type: "agent_settled" });
    expect(await first).toMatchObject({ delivery: "accepted but not confirmed" });
    expect(await second).toMatchObject({ delivery: "delivered", transformed: true });
    const delivered = f.events.filter(e => e.type === "steer_delivery" && e.delivered);
    expect(delivered).toHaveLength(1); expect(delivered[0].steer).toBe("rewrite");
  });
  it("one user event confirms only one of two identical queued steers", async () => {
    const f = fixture(), a = f.rpc.steer("same"); f.out(queue(["same"])); f.reply(f.commands.at(-1));
    const b = f.rpc.steer("same"); f.out(queue(["same", "same"])); f.reply(f.commands.at(-1));
    f.out(queue(["same"])); f.out(user("same")); f.out({ type: "agent_settled" });
    expect(await a).toMatchObject({ delivery: "delivered" });
    expect(await b).toMatchObject({ delivery: "accepted but not confirmed" });
    expect(f.events.filter(e => e.type === "steer_delivery" && e.delivered)).toHaveLength(1);
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "accepted but not confirmed" });
  });
  // Reuses the reviewer's P1/P2 queue-window probes. First-addition attribution is a false positive.
  it.each([false, true])("prefers exact text among several additions (oneUpdate=%s)", async oneUpdate => {
    const f = fixture(), ack = f.rpc.steer("exact");
    if (!oneUpdate) f.out(queue(["unrelated"]));
    f.out(queue(["unrelated", "exact"])); f.reply(f.commands.at(-1));
    let resolved = false; void ack.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0); expect(resolved).toBe(false);
    f.out(queue(["exact"])); f.out(user("unrelated"));
    expect(f.events.some(e => e.type === "steer_delivery" && e.delivered)).toBe(false);
    f.out(queue([])); f.out(user("exact"));
    expect(await ack).toMatchObject({ delivery: "delivered", transformed: false });
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "delivered", transformed: false, observedText: "exact" });
  });
  it.each([false, true])("requires a sole addition for transformed delivery (earlyEntry=%s)", async earlyEntry => {
    const f = fixture(), ack = f.rpc.steer("rewritten");
    f.out(queue(["first unrelated"]));
    if (earlyEntry) { f.out(queue([])); f.out(user("first unrelated")); }
    f.out(queue(earlyEntry ? ["second unrelated"] : ["first unrelated", "second unrelated"]));
    f.reply(f.commands.at(-1));
    f.out(queue([])); f.out(user("first unrelated")); f.out(user("second unrelated")); f.out({ type: "agent_settled" });
    expect(await ack).toMatchObject({ delivery: "accepted but not confirmed", queued: false });
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
    f.reply(f.commands.at(-1)); await vi.advanceTimersByTimeAsync(10_000);
    expect(await second).toMatchObject({ accepted: true, delivery: "accepted but not confirmed" });
    f.out(queue([])); f.out(user("slow handler"));
    expect(f.events.filter(e => e.type === "steer_delivery").at(-1)).toMatchObject({ delivery: "delivered", steer: "slow handler" });
    const third = f.rpc.steer("third"); f.reply(f.commands.at(-1)); await vi.advanceTimersByTimeAsync(10_000); expect(await third).toMatchObject({ accepted: true });
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
    const f = fixture(), ack = f.rpc.steer("x"); f.out(queue(["x"])); f.reply(f.commands.at(-1));
    const stop = f.rpc.abort(); f.out(queue([])); f.out(user("x")); f.reply(f.commands.at(-1)); await stop;
    expect(await ack).toMatchObject({ delivery: "accepted but not confirmed", error: "Child was stopped." });
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
    await vi.advanceTimersByTimeAsync(10_000);
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
    const f = fixture(), a = f.rpc.steer("same"); f.out(queue(["same"])); f.reply(f.commands.at(-1));
    const b = f.rpc.steer("same"); f.out(queue(["same", "same"])); f.reply(f.commands.at(-1));
    f.out(queue(["same"])); f.out(user("same")); f.out(queue([])); f.out(user("same"));
    for (const ack of await Promise.all([a, b])) expect(ack).toMatchObject({ delivery: "delivered" });
    expect(f.events.filter(e => e.type === "steer_delivery" && e.delivered)).toHaveLength(2);
  });
  it("matches a later entry only to its own pending steer", async () => {
    const f = fixture(), a = f.rpc.steer("first"); f.out(queue(["first"])); f.reply(f.commands.at(-1));
    const b = f.rpc.steer("second"); f.out(queue(["first", "second"])); f.reply(f.commands.at(-1));
    f.out(queue(["first"])); f.out(user("second"));
    expect(await b).toMatchObject({ delivery: "delivered" });
    f.out({ type: "agent_settled" }); expect(await a).toMatchObject({ delivery: "accepted but not confirmed" });
    expect(f.events.filter(e => e.type === "steer_delivery" && e.delivered).map(e => e.steer)).toEqual(["second"]);
  });

  it("allows a reply just before the full ten-second reply deadline", async () => {
    vi.useFakeTimers(); const f = fixture(), ack = f.rpc.steer("slow but healthy");
    let resolved = false; void ack.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(resolved).toBe(false);
    f.reply(f.commands.at(-1));
    await vi.advanceTimersByTimeAsync(1);
    expect(await ack).toMatchObject({ accepted: true, delivery: "accepted but not confirmed" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("writes a waiter released just before its full ten-second deadline and clears its timer", async () => {
    vi.useFakeTimers(); const f = fixture(), first = f.rpc.steer("first"), command = f.commands.at(-1);
    const second = f.rpc.steer("waiter"); let resolved = false; void second.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(resolved).toBe(false);
    expect(f.commands.filter(c => c.type === "steer")).toHaveLength(1);
    f.reply(command); await Promise.resolve();
    expect(f.commands.at(-1).message).toBe("waiter");
    f.reply(f.commands.at(-1));
    await vi.advanceTimersByTimeAsync(10_000); expect(await first).toMatchObject({ accepted: true });
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
