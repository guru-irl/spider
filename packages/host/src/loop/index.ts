// Ported from https://github.com/michael-denyer/pstack-claude,
// plugins/pstack/pi/schedule.ts and plugins/pstack/pi/one-shot.ts at 046341e. MIT licensed.
// Copyright (c) 2026 Lauren Tan
// Copyright (c) 2026 Michael Denyer
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseLoop, type LoopCommand } from "./parser";

export interface SchedulerTimeMath {
  resolveTimeZone(tz?: string): string;
  parseAt(value: string, nowMs: number): number;
  formatInZone(atMs: number, tz: string): string;
  parseCron(expression: string): unknown;
  nextCronAt(expression: string, tz: string, afterMs: number): number;
}
interface TriggerArgs {
  name?: string; prompt?: string; stop?: boolean;
  interval?: string; cron?: string; tz?: string; at?: string;
  delaySeconds?: number; reason?: string; noop?: boolean;
}
export interface ScheduleArgs extends TriggerArgs {}
export interface LoopArgs extends TriggerArgs {}
export type Result = { text: string; details: Record<string, unknown> };
export type PromptOrigin = "user" | "model";
interface TriggerBase { name: string; prompt: string; origin: PromptOrigin; tz: string }
type OnceTiming = { at: string; delaySeconds?: never } | { delaySeconds: number; at?: never };
export type Trigger = TriggerBase & (
  | ({ kind: "once"; nextAt: number; reason?: string; noop: boolean } & OnceTiming)
  | { kind: "interval"; nextAt: number; anchor: number; interval: string; intervalSeconds: number }
  | { kind: "cron"; nextAt: number; cron: string }
  | { kind: "self-paced"; nextAt: number | null }
);
export interface TriggerSnapshot { version: 1; sessionId: string; triggers: Trigger[] }
export type TriggerListing = Trigger & { state: "scheduled" | "due" | "waiting-for-rearm"; nextAtUtc: string | null; nextAtLocal: string | null };
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const MIN_DELAY_S = 60;
const MAX_DELAY_S = 3600;

function assertModelPrompt(prompt: string): void {
  if (prompt.trimStart().startsWith("/")) throw new Error("Slash commands are user-only; a loop or schedule prompt cannot start with '/'.");
}
function assertPersistentSession(action: string, ctx: ExtensionContext): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") throw new Error(`spider ${action} is unavailable in a one-shot subagent child. The parent owns timers; completion notices arrive on their own.`);
  if (ctx.mode === "print" || ctx.mode === "json") throw new Error(`spider ${action} cannot fire in a ${ctx.mode} run: pi exits when this run ends. Finish the work in this run instead.`);
}
function validName(name: string): string {
  if (!NAME.test(name)) throw new Error("Trigger name must be 1 to 40 characters, start with a letter or digit, and contain only letters, digits, '.', '_' or '-'.");
  return name;
}
function dynamicPrompt(prompt: string): string {
  return `${prompt}\n\n[/loop, self-paced] When this iteration is done, call spider schedule with prompt ${JSON.stringify(`/loop ${prompt}`)} and a delaySeconds that fits what you are waiting for (${MIN_DELAY_S} to ${MAX_DELAY_S} seconds) to run it again. Skip the call to end the loop.`;
}
function intervalTiming(value: string, prompt: string): { seconds: number; prompt: string; interval: string } {
  const cmd = parseLoop(`${value} ${prompt}`);
  // Parsing the whole interval field preserves the slash-smuggling check.
  if (cmd.kind === "fixed") {
    assertModelPrompt(cmd.prompt);
    return { seconds: Math.max(MIN_DELAY_S, cmd.seconds), prompt: cmd.prompt, interval: value };
  }
  throw new Error(cmd.kind === "usage" && cmd.reason ? cmd.reason : "spider loop interval must be a whole number with unit s, m, h or d (at most 24 days).");
}

export class SessionScheduler {
  private readonly triggers = new Map<string, Trigger>();
  private timer?: NodeJS.Timeout;
  private ctx?: ExtensionContext;
  private activated = false;
  private gate?: { sentAt: number; started: boolean };
  running = false;

  constructor(private readonly pi: ExtensionAPI, private readonly time: SchedulerTimeMath) {}

  private context(ctx: ExtensionContext): void { if (!this.activated) this.ctx = ctx; }
  start(ctx: ExtensionContext): void { this.activated = true; this.ctx = ctx; this.arm(); }
  agentStart(): void { this.running = true; if (this.gate) this.gate.started = true; }
  private status(): Result {
    const triggers: TriggerListing[] = [...this.triggers.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(t => ({
      ...t, state: t.nextAt === null ? "waiting-for-rearm" : t.nextAt <= Date.now() ? "due" : "scheduled",
      nextAtUtc: t.nextAt === null ? null : new Date(t.nextAt).toISOString(),
      nextAtLocal: t.nextAt === null ? null : this.time.formatInZone(t.nextAt, t.tz),
    }));
    const text = triggers.map(t => {
      const spec = t.kind === "cron" ? `cron ${JSON.stringify(t.cron)} ${t.tz}` : t.kind === "interval" ? `every ${t.interval}` : t.kind;
      const state = t.state === "due" ? "due, waiting for idle" : t.state === "waiting-for-rearm" ? "waiting for re-arm" : `${t.nextAtUtc} UTC (${t.nextAtLocal})`;
      return `${t.name}: ${spec}; ${state}; ${t.origin}; ${t.prompt.replace(/[\r\n]+/g, " ").slice(0, 80)}`;
    }).join("\n") || "No triggers are active.";
    return { text, details: { triggers } };
  }
  private put(trigger: Trigger): void {
    if (!this.triggers.has(trigger.name) && this.triggers.size >= 20) throw new Error("A session can hold at most 20 triggers.");
    this.triggers.set(trigger.name, trigger);
    this.reconcile();
  }
  private arm(immediate = false): void {
    clearTimeout(this.timer); this.timer = undefined;
    const times = [...this.triggers.values()].flatMap(t => t.nextAt === null ? [] : [t.nextAt]);
    if (!times.length) return;
    const now = Date.now();
    const next = Math.min(...times);
    let delay = next <= now ? 1000 : Math.min(30_000, next - now);
    if (next <= now && this.gate && !this.gate.started && now < this.gate.sentAt + 5000) delay = Math.min(delay, this.gate.sentAt + 5000 - now);
    this.timer = setTimeout(() => { this.timer = undefined; this.reconcile(); }, immediate ? 0 : delay).unref();
  }
  private reconcile(): void {
    const ctx = this.ctx;
    const now = Date.now();
    if (this.gate && !this.gate.started && now - this.gate.sentAt >= 5000 && !this.running && ctx?.isIdle()) this.gate = undefined;
    const due = [...this.triggers.values()].filter(t => t.nextAt !== null && t.nextAt <= now).sort((a, b) => a.nextAt! - b.nextAt! || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
    if (due && ctx?.isIdle() && !this.running && !this.gate) {
      this.gate = { sentAt: now, started: false };
      const errors: string[] = [];
      let canSend = true;
      try { assertPersistentSession(due.kind === "once" ? "schedule" : "loop", ctx); }
      catch (error) { canSend = false; errors.push(String(error)); }
      try {
        if (due.kind === "once") this.triggers.delete(due.name);
        else if (due.kind === "self-paced") due.nextAt = null;
        else if (due.kind === "cron") due.nextAt = this.time.nextCronAt(due.cron, due.tz, now);
        else {
          const period = due.intervalSeconds * 1000;
          const next = due.anchor + (Math.floor((now - due.anchor) / period) + 1) * period;
          if (!Number.isFinite(next) || next <= now) throw new Error("Cannot advance interval to a future instant.");
          due.nextAt = next;
        }
      } catch (error) { this.triggers.delete(due.name); errors.push(String(error)); }
      if (canSend) {
        try { this.pi.sendUserMessage(due.kind === "self-paced" ? dynamicPrompt(due.prompt) : due.prompt, { deliverAs: "followUp", expandPromptTemplates: due.origin === "user" }); }
        catch (error) { canSend = false; errors.push(String(error)); }
      }
      if (!canSend) this.gate = undefined;
      if (errors.length) ctx.ui.notify(errors.join("; "), "error");
    }
    this.arm();
  }
  settled(): void {
    this.running = false;
    if (this.gate?.started) this.gate = undefined;
    this.arm(true);
  }
  shutdown(): void {
    clearTimeout(this.timer); this.timer = undefined; this.triggers.clear(); this.ctx = undefined;
    this.running = false; this.gate = undefined; this.activated = false;
  }

  async loop(args: LoopArgs, ctx: ExtensionContext): Promise<Result> {
    assertPersistentSession("loop", ctx); this.context(ctx);
    if (args.prompt !== undefined) assertModelPrompt(args.prompt);
    if (args.at !== undefined) throw new Error("spider loop does not accept at; use spider schedule");
    const name = validName(args.name ?? "loop");
    if (args.stop) {
      const old = this.triggers.get(name);
      const stopped = old !== undefined && old.kind !== "once" && this.triggers.delete(name);
      this.arm();
      return { text: stopped ? "Loop stopped." : "No loop was running.", details: { stopped } };
    }
    if (args.interval !== undefined && args.cron !== undefined) throw new Error("spider loop accepts only one of interval and cron.");
    if (args.tz !== undefined && args.cron === undefined) throw new Error("spider loop tz requires cron.");
    if (args.prompt === undefined && args.interval === undefined && args.cron === undefined) return this.status();
    if (!args.prompt?.trim()) throw new Error("A prompt is required when spider loop has an interval, cron, or definition.");
    const base = { name, prompt: args.prompt.trim(), origin: "model" as const, tz: this.time.resolveTimeZone(args.tz) };
    let trigger: Trigger;
    if (args.cron !== undefined) trigger = { ...base, kind: "cron", cron: args.cron, nextAt: this.time.nextCronAt(args.cron, base.tz, Date.now()) };
    else if (args.interval !== undefined) {
      const timing = intervalTiming(args.interval, base.prompt);
      trigger = { ...base, prompt: timing.prompt, kind: "interval", interval: args.interval, intervalSeconds: timing.seconds, anchor: Date.now(), nextAt: Date.now() };
    } else trigger = { ...base, kind: "self-paced", nextAt: Date.now() };
    this.put(trigger);
    return { text: trigger.kind === "self-paced" ? "Self-paced loop started. Re-arm with spider schedule; /loop stop ends it." : `Loop ${name} scheduled.`, details: this.status().details };
  }
  async schedule(args: ScheduleArgs, ctx: ExtensionContext): Promise<Result> {
    assertPersistentSession("schedule", ctx); this.context(ctx);
    if (args.prompt !== undefined) assertModelPrompt(args.prompt);
    if (args.cron !== undefined) throw new Error("spider schedule does not accept cron; use spider loop");
    if (args.tz !== undefined) throw new Error("spider schedule does not accept tz; use spider loop with cron");
    const name = validName(args.name ?? "wakeup");
    if (args.stop) {
      const cancelled = this.triggers.get(name)?.kind === "once" && this.triggers.delete(name);
      this.arm(); return { text: cancelled ? "Pending wakeup cancelled." : "No named one-shot was pending.", details: { cancelled: !!cancelled } };
    }
    if ((args.at !== undefined) === (args.delaySeconds !== undefined) || !args.prompt?.trim() || (args.delaySeconds !== undefined && !Number.isFinite(args.delaySeconds))) throw new Error("spider schedule needs delaySeconds or at, and a prompt, unless stop is true; delaySeconds must be finite");
    const seconds = args.delaySeconds === undefined ? undefined : Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.round(args.delaySeconds)));
    const nextAt = args.at === undefined ? Date.now() + seconds! * 1000 : this.time.parseAt(args.at, Date.now());
    const trigger: Trigger = {
      name, kind: "once", prompt: args.prompt.trim(), origin: "model", tz: this.time.resolveTimeZone(), nextAt,
      ...(args.at === undefined ? { delaySeconds: seconds! } : { at: args.at }),
      ...(args.reason === undefined ? {} : { reason: args.reason }), noop: args.noop === true,
    };
    this.put(trigger);
    return { text: `Wakeup scheduled${seconds === undefined ? "" : ` in ${seconds}s`}, at ${new Date(nextAt).toISOString()}. It replaces the trigger named ${name}.`, details: { ...(seconds === undefined ? {} : { delaySeconds: seconds }), fireAt: new Date(nextAt).toISOString(), noop: args.noop === true } };
  }
  async command(cmd: LoopCommand, ctx: ExtensionContext, origin: PromptOrigin = "user"): Promise<Result> {
    assertPersistentSession("loop", ctx); this.context(ctx);
    if (cmd.kind === "usage") return { text: `${cmd.reason ? `${cmd.reason} ` : ""}Usage: /loop [interval like 5m or 1h] <prompt>, or /loop stop`, details: { usage: true } };
    if (cmd.kind === "stop") {
      const stopped = this.triggers.delete("loop") || false;
      const wakeup = this.triggers.delete("wakeup"); this.arm();
      return { text: stopped || wakeup ? "Loop stopped." : "No loop was running.", details: { stopped: stopped || wakeup } };
    }
    if (origin === "model") assertModelPrompt(cmd.prompt);
    const base = { name: "loop", prompt: cmd.prompt, origin, tz: this.time.resolveTimeZone() };
    this.put(cmd.kind === "fixed" ? { ...base, kind: "interval", interval: `${cmd.seconds / 60}m`, intervalSeconds: Math.max(60, cmd.seconds), anchor: Date.now(), nextAt: Date.now() } : { ...base, kind: "self-paced", nextAt: Date.now() });
    return { text: "Loop started.", details: this.status().details };
  }
}

export function registerLoopSchedule(pi: ExtensionAPI, time: SchedulerTimeMath): SessionScheduler {
  const scheduler = new SessionScheduler(pi, time);
  pi.on("session_start", (_event, ctx) => { scheduler.start(ctx); });
  pi.on("agent_start", () => { scheduler.agentStart(); });
  pi.on("agent_settled", () => { scheduler.settled(); });
  pi.on("session_shutdown", () => { scheduler.shutdown(); });
  pi.registerCommand("loop", {
    description: "Run external-work checks (CI, deploys, timers): /loop [5m|1h] <prompt> or /loop stop. Not for polling subagents; completion notices arrive automatically.",
    async handler(args, ctx) { const result = await scheduler.command(parseLoop(args), ctx); ctx.ui.notify(result.text, "info"); },
  });
  return scheduler;
}
