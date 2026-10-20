// Ported from https://github.com/michael-denyer/pstack-claude,
// plugins/pstack/pi/schedule.ts and plugins/pstack/pi/one-shot.ts at 046341e. MIT licensed.
// Copyright (c) 2026 Lauren Tan
// Copyright (c) 2026 Michael Denyer
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseLoop, type LoopCommand } from "./parser";

export interface ScheduleArgs {
  delaySeconds?: number;
  prompt?: string;
  reason?: string;
  noop?: boolean;
  stop?: boolean;
}
export interface LoopArgs { interval?: string; prompt?: string; stop?: boolean }

const MIN_DELAY_S = 60;
const MAX_DELAY_S = 3600;
const IDLE_RETRY_MS = 1000;
type Result = { text: string; details: Record<string, unknown> };
interface LoopState { mode: "fixed" | "self-paced"; intervalSeconds: number | null; nextFireAt: string | null; prompt: string }
interface WakeupState { delaySeconds: number; fireAt: string; prompt: string; reason?: string; noop: boolean }

// Print and json runs exit once the agent settles. A spider child is a
// one-shot process too, even when its transport is RPC.
function assertPersistentSession(action: string, ctx: ExtensionContext): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") {
    throw new Error(`spider ${action} is unavailable in a one-shot subagent child. The parent owns timers; completion notices arrive on their own.`);
  }
  if (ctx.mode === "print" || ctx.mode === "json") {
    throw new Error(`spider ${action} cannot fire in a ${ctx.mode} run: pi exits when this run ends. Finish the work in this run instead.`);
  }
}

function dynamicPrompt(prompt: string): string {
  return (
    `${prompt}\n\n` +
    `[/loop, self-paced] When this iteration is done, call spider schedule with prompt ${JSON.stringify(`/loop ${prompt}`)} ` +
    `and a delaySeconds that fits what you are waiting for (${MIN_DELAY_S} to ${MAX_DELAY_S} seconds) to run it again. ` +
    `Skip the call to end the loop.`
  );
}

// One pending wakeup, one fixed-interval loop, and one live self-paced loop per
// session. A fire delivers the prompt as a follow-up user message, which runs at
// once when the agent is idle.
export class SessionScheduler {
  private wakeup?: NodeJS.Timeout;
  private loopTimer?: NodeJS.Timeout;
  private wakeupState?: WakeupState;
  // A self-paced loop has no timer of its own while its iteration runs, so
  // this is what /loop stop finds then.
  private loopState?: LoopState;
  // Set by a /loop command that ends or replaces the loop while a run is in
  // flight, until that run settles. A spider schedule call names no loop, so
  // nothing tells that run's re-arm of the old loop from any other wakeup. It
  // is refused them all, or the loop the user just ended would come back.
  sealed = false;
  // A run is in flight: set by agent_start, cleared by agent_settled. Not
  // ctx.isIdle(), which is also false during a manual compaction.
  running = false;

  constructor(private readonly pi: ExtensionAPI) {}

  private fire(prompt: string): void {
    this.pi.sendUserMessage(prompt, { deliverAs: "followUp", expandPromptTemplates: true });
  }

  private scheduleWakeup(seconds: number, prompt: string, ctx: ExtensionContext, args?: ScheduleArgs): void {
    this.cancelWakeup();
    this.wakeupState = {
      delaySeconds: seconds, fireAt: new Date(Date.now() + seconds * 1000).toISOString(), prompt,
      ...(args?.reason === undefined ? {} : { reason: args.reason }), noop: args?.noop === true,
    };
    const deliver = () => {
      // Pi rejects prompts during manual compaction. Keep the wakeup pending
      // until idle, including while a run or compaction is still finishing.
      if (!ctx.isIdle()) {
        this.wakeup = setTimeout(deliver, IDLE_RETRY_MS).unref();
        return;
      }
      this.wakeup = undefined;
      this.wakeupState = undefined;
      this.fire(prompt);
    };
    this.wakeup = setTimeout(deliver, seconds * 1000).unref();
  }

  private cancelWakeup(): boolean {
    const had = this.wakeup !== undefined;
    clearTimeout(this.wakeup);
    this.wakeup = undefined;
    this.wakeupState = undefined;
    return had;
  }

  private startLoop(seconds: number, prompt: string, ctx: ExtensionContext): void {
    const state: LoopState = {
      mode: "fixed", intervalSeconds: seconds,
      nextFireAt: new Date(Date.now() + seconds * 1000).toISOString(), prompt,
    };
    this.loopState = state;
    // A tick that lands mid-run is dropped, so a slow iteration cannot pile up a backlog.
    this.loopTimer = setInterval(() => {
      state.nextFireAt = new Date(Date.now() + seconds * 1000).toISOString();
      if (ctx.isIdle()) this.fire(prompt);
    }, seconds * 1000).unref();
  }

  // Ends the loop and the pending wakeup. midRun says a run is in flight,
  // which seals the wakeup slot against it.
  stopAll(midRun = false): boolean {
    const wakeup = this.cancelWakeup();
    const had = this.loopState !== undefined;
    clearInterval(this.loopTimer);
    this.loopTimer = undefined;
    this.loopState = undefined;
    if (midRun) this.sealed = true;
    return had || wakeup;
  }

  private status(): Result {
    const loop = this.loopState ? { ...this.loopState } : null;
    const wakeup = this.wakeupState ? { ...this.wakeupState } : null;
    const lines = [loop
      ? `Loop: ${loop.mode === "fixed" ? `every ${loop.intervalSeconds}s; next tick ${loop.nextFireAt}` : "self-paced; next iteration awaits spider schedule"}. Prompt: ${loop.prompt}`
      : "No loop is active."];
    lines.push(wakeup
      ? `Wakeup: ${wakeup.fireAt}${Date.parse(wakeup.fireAt) <= Date.now() ? " (waiting for idle)" : ""}. Prompt: ${wakeup.prompt}`
      : "No wakeup is pending.");
    return { text: lines.join("\n"), details: { loop, wakeup } };
  }

  async loop(args: LoopArgs, ctx: ExtensionContext): Promise<Result> {
    assertPersistentSession("loop", ctx);
    if (args.stop) return this.command({ kind: "stop" }, ctx);
    if (!args.prompt?.trim()) return this.status();
    if (args.interval !== undefined) {
      const cmd = parseLoop(`${args.interval} ${args.prompt}`);
      if (cmd.kind !== "fixed") {
        throw new Error(cmd.kind === "usage" && cmd.reason ? cmd.reason : "spider loop interval must be a whole number with unit s, m, h or d (at most 24 days).");
      }
      return this.command(cmd, ctx);
    }
    return this.command({ kind: "dynamic", prompt: args.prompt.trim() }, ctx);
  }

  async command(cmd: LoopCommand, ctx: ExtensionContext): Promise<Result> {
    assertPersistentSession("loop", ctx);
    if (cmd.kind === "usage") {
      return { text: `${cmd.reason ? `${cmd.reason} ` : ""}Usage: /loop [interval like 5m or 1h] <prompt>, or /loop stop`, details: { usage: true } };
    }
    if (cmd.kind === "stop") {
      const stopped = this.stopAll(this.running);
      return { text: stopped ? "Loop stopped." : "No loop was running.", details: { stopped } };
    }
    // Also true during a manual compaction, which no run is behind: the first
    // prompt then waits for idle, but only a run in flight seals the slot.
    const midRun = !ctx.isIdle();
    this.stopAll(this.running);
    let prompt: string;
    let text: string;
    if (cmd.kind === "fixed") {
      const seconds = Math.max(MIN_DELAY_S, cmd.seconds);
      this.startLoop(seconds, cmd.prompt, ctx);
      prompt = cmd.prompt;
      text = `Looping every ${seconds}s. /loop stop ends it.`;
    } else {
      this.loopState = { mode: "self-paced", intervalSeconds: null, nextFireAt: null, prompt: cmd.prompt };
      prompt = dynamicPrompt(cmd.prompt);
      text = "Self-paced loop started. Re-arm with spider schedule; /loop stop ends it.";
    }
    // The slot is sealed against the run in flight, so the loop's first
    // prompt takes the slot and runs once that run has settled. Its own
    // re-arm then comes from a later run and is not refused.
    if (midRun) {
      this.scheduleWakeup(0, prompt, ctx);
      text += " The loop starts once the session is idle.";
    } else {
      this.fire(prompt);
    }
    return { text, details: this.status().details };
  }

  async schedule(args: ScheduleArgs, ctx: ExtensionContext): Promise<Result> {
    assertPersistentSession("schedule", ctx);
    if (args.stop) {
      // What is pending in a sealed slot is a loop start the user asked for, not this run's.
      const cancelled = !this.sealed && this.cancelWakeup();
      return { text: cancelled ? "Pending wakeup cancelled." : "No wakeup was pending.", details: { cancelled } };
    }
    if (typeof args.delaySeconds !== "number" || !Number.isFinite(args.delaySeconds) || !args.prompt?.trim()) {
      throw new Error("spider schedule needs finite delaySeconds and prompt unless stop is true.");
    }
    if (this.sealed) {
      ctx.ui.notify("A wakeup this run asked for was not scheduled: /loop ended or replaced the loop while it ran.", "warning");
      return {
        text: "Not scheduled: the user ended or replaced the loop with a /loop command or spider loop during this run. Do not schedule another wakeup in this run.",
        details: { refused: true },
      };
    }
    const seconds = Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.round(args.delaySeconds)));
    this.scheduleWakeup(seconds, args.prompt, ctx, args);
    const fireAt = this.wakeupState!.fireAt;
    const clamped = seconds !== args.delaySeconds ? ` (clamped from ${args.delaySeconds})` : "";
    return {
      text: `Wakeup scheduled in ${seconds}s${clamped}, at ${fireAt}. It replaces any earlier pending wakeup.`,
      details: { delaySeconds: seconds, fireAt, noop: args.noop === true },
    };
  }
}

export function registerLoopSchedule(pi: ExtensionAPI): SessionScheduler {
  const scheduler = new SessionScheduler(pi);
  pi.on("agent_start", () => { scheduler.running = true; });
  pi.on("agent_settled", () => { scheduler.running = false; scheduler.sealed = false; });
  pi.on("session_shutdown", () => { scheduler.stopAll(); scheduler.running = false; scheduler.sealed = false; });
  pi.registerCommand("loop", {
    description: "Run external-work checks (CI, deploys, timers): /loop [5m|1h] <prompt> or /loop stop. Not for polling subagents; completion notices arrive automatically.",
    async handler(args, ctx) {
      const result = await scheduler.command(parseLoop(args), ctx);
      ctx.ui.notify(result.text, "info");
    },
  });
  return scheduler;
}
