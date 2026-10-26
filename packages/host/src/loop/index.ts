// Ported from https://github.com/michael-denyer/pstack-claude,
// plugins/pstack/pi/schedule.ts and plugins/pstack/pi/one-shot.ts at 046341e. MIT licensed.
// Copyright (c) 2026 Lauren Tan
// Copyright (c) 2026 Michael Denyer
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
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
function dynamicPrompt(prompt: string, name: string): string {
  return `${prompt}\n\n[/loop, self-paced] When this iteration is done, call spider schedule with name:${JSON.stringify(name)} and prompt ${JSON.stringify(`/loop ${prompt}`)} and a delaySeconds that fits what you are waiting for (${MIN_DELAY_S} to ${MAX_DELAY_S} seconds) to run it again. Skip the call to end the loop.`;
}
function intervalTiming(value: string, prompt: string): { seconds: number; prompt: string; interval: string } {
  const cmd = parseLoop(`${value} ${prompt}`);
  // Parsing the whole interval field preserves the slash-smuggling check.
  if (cmd.kind === "fixed") {
    assertModelPrompt(cmd.prompt);
    if (!/^\d+[smhd]$/.test(value)) throw new Error("spider loop interval must be a whole number with unit s, m, h or d (at most 24 days).");
    return { seconds: Math.max(MIN_DELAY_S, cmd.seconds), prompt: cmd.prompt, interval: value };
  }
  throw new Error(cmd.kind === "usage" && cmd.reason ? cmd.reason : "spider loop interval must be a whole number with unit s, m, h or d (at most 24 days).");
}

function intervalLabel(trigger: Extract<Trigger, { kind: "interval" }>): string {
  const [unit, seconds] = ([["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const)
    .find(([, seconds]) => trigger.intervalSeconds % seconds === 0)!;
  const amount = Number(trigger.interval.slice(0, -1));
  const clamped = amount === 0 || (trigger.interval.endsWith("s") && amount < MIN_DELAY_S);
  return `every ${trigger.intervalSeconds / seconds}${unit}${clamped ? ` (requested ${trigger.interval})` : ""}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function instant(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15;
}
function nextInterval(trigger: Extract<Trigger, { kind: "interval" }>, now: number): number {
  const period = trigger.intervalSeconds * 1000;
  const next = trigger.anchor + (Math.floor((now - trigger.anchor) / period) + 1) * period;
  if (!instant(next) || next <= now) throw new Error("Cannot advance interval to a future instant.");
  return next;
}
type UnvalidatedZone<T> = T extends Trigger ? Omit<T, "tz"> & { tz: unknown } : never;
type SnapshotCandidate = Omit<TriggerSnapshot, "triggers"> & { triggers: UnvalidatedZone<Trigger>[] };
function parseSnapshot(value: unknown, time: SchedulerTimeMath): SnapshotCandidate {
  const fail = (): never => { throw new Error("Invalid spider triggers snapshot."); };
  if (!record(value) || value.version !== 1 || typeof value.sessionId !== "string" || !Array.isArray(value.triggers) || value.triggers.length > 20) return fail();
  const names = new Set<string>();
  const triggers = value.triggers.map((raw: unknown): UnvalidatedZone<Trigger> => {
    if (!record(raw) || typeof raw.name !== "string" || !NAME.test(raw.name) || names.has(raw.name)
      || typeof raw.prompt !== "string" || !raw.prompt.trim() || (raw.origin !== "model" && raw.origin !== "user")) return fail();
    names.add(raw.name);
    if (raw.origin === "model") assertModelPrompt(raw.prompt);
    const base: Omit<TriggerBase, "tz"> & { tz: unknown } = { name: raw.name, prompt: raw.prompt, origin: raw.origin, tz: raw.tz };
    if (raw.kind === "self-paced") {
      if (raw.nextAt !== null && !instant(raw.nextAt)) return fail();
      return { ...base, kind: "self-paced", nextAt: raw.nextAt };
    }
    if (!instant(raw.nextAt)) return fail();
    const nextAt = raw.nextAt;
    switch (raw.kind) {
      case "once": {
        if (typeof raw.noop !== "boolean" || (raw.reason !== undefined && typeof raw.reason !== "string") || (raw.at !== undefined) === (raw.delaySeconds !== undefined)) return fail();
        let timing: OnceTiming;
        if (raw.at !== undefined) {
          if (typeof raw.at !== "string" || time.parseAt(raw.at, -8.64e15) !== nextAt) return fail();
          timing = { at: raw.at };
        } else {
          if (typeof raw.delaySeconds !== "number" || !Number.isInteger(raw.delaySeconds) || raw.delaySeconds < 60 || raw.delaySeconds > 3600) return fail();
          timing = { delaySeconds: raw.delaySeconds };
        }
        return { ...base, kind: "once", nextAt, ...timing, ...(raw.reason === undefined ? {} : { reason: raw.reason }), noop: raw.noop };
      }
      case "interval": {
        if (typeof raw.interval !== "string" || !/^\d+[smhd]$/.test(raw.interval) || !instant(raw.anchor) || typeof raw.intervalSeconds !== "number") return fail();
        const parsed = parseLoop(`${raw.interval} placeholder`);
        if (parsed.kind !== "fixed" || Math.max(60, parsed.seconds) !== raw.intervalSeconds) return fail();
        return { ...base, kind: "interval", nextAt, anchor: raw.anchor, interval: raw.interval, intervalSeconds: raw.intervalSeconds };
      }
      case "cron":
        if (typeof raw.cron !== "string") return fail();
        time.parseCron(raw.cron);
        return { ...base, kind: "cron", nextAt, cron: raw.cron };
      default: return fail();
    }
  });
  return { version: 1, sessionId: value.sessionId, triggers };
}

export class SessionScheduler {
  private readonly triggers = new Map<string, Trigger>();
  private readonly seals = new Set<string>();
  private timer?: NodeJS.Timeout;
  private ctx?: ExtensionContext;
  private activated = false;
  private gate?: { sentAt: number; started: boolean };
  running = false;

  constructor(private readonly pi: ExtensionAPI, private readonly time: SchedulerTimeMath) {}

  private context(ctx: ExtensionContext): void { if (!this.activated) this.ctx = ctx; }
  start(event: SessionStartEvent, ctx: ExtensionContext): void {
    this.shutdown(); this.activated = true; this.ctx = ctx;
    if (process.env.PI_SUBAGENT_CHILD === "1" || ctx.mode === "print" || ctx.mode === "json" || event.reason === "new" || event.reason === "fork") return;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      let latest: { data?: unknown } | undefined;
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === "spider-triggers"
          && (!record(entry.data) || typeof entry.data.sessionId !== "string" || entry.data.sessionId === sessionId)) latest = entry;
      }
      if (!latest) return;
      const snapshot = parseSnapshot(latest.data, this.time);
      for (const candidate of snapshot.triggers) {
        let tz: string;
        try {
          if (typeof candidate.tz !== "string") throw new Error("Time zone must be a string.");
          tz = candidate.tz;
          this.time.resolveTimeZone(tz);
        } catch (error) {
          ctx.ui.notify(`Cannot restore spider trigger ${JSON.stringify(candidate.name)} from snapshot: invalid time zone ${String(candidate.tz)}. ${String(error)}`, "error");
          continue;
        }
        const trigger: Trigger = { ...candidate, tz };
        if (trigger.kind === "self-paced" && trigger.nextAt === null) continue;
        if (trigger.kind === "interval") trigger.nextAt = nextInterval(trigger, Date.now());
        this.triggers.set(trigger.name, trigger);
      }
      this.arm(true);
    } catch (error) {
      this.triggers.clear(); ctx.ui.notify(`Cannot restore spider triggers snapshot: ${String(error)}`, "error");
    }
  }
  agentStart(): void { this.running = true; if (this.gate) this.gate.started = true; }
  private status(): Result {
    const triggers: TriggerListing[] = [...this.triggers.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(t => ({
      ...t, state: t.nextAt === null ? "waiting-for-rearm" : t.nextAt <= Date.now() ? "due" : "scheduled",
      nextAtUtc: t.nextAt === null ? null : new Date(t.nextAt).toISOString(),
      nextAtLocal: t.nextAt === null ? null : this.time.formatInZone(t.nextAt, t.tz),
    }));
    const text = triggers.map(t => {
      const spec = t.kind === "cron" ? `cron ${JSON.stringify(t.cron)} ${t.tz}` : t.kind === "interval" ? intervalLabel(t) : t.kind;
      const state = t.state === "due" ? "due, waiting for idle" : t.state === "waiting-for-rearm" ? "waiting for re-arm" : `${t.nextAtUtc} UTC (${t.nextAtLocal})`;
      return `${t.name}: ${spec}; ${state}; ${t.origin}; ${t.prompt.replace(/[\r\n]+/g, " ").slice(0, 80)}`;
    }).join("\n") || "No triggers are active.";
    return { text, details: { triggers } };
  }
  private snapshot(ctx: ExtensionContext): void {
    const data: TriggerSnapshot = { version: 1, sessionId: ctx.sessionManager.getSessionId(), triggers: structuredClone([...this.triggers.values()]) };
    this.pi.appendEntry("spider-triggers", data);
  }
  private changed(result: Result, ctx: ExtensionContext, notify = true): Result {
    try { this.snapshot(ctx); return result; }
    catch (error) {
      const warning = `Trigger state changed in memory but could not be saved: ${String(error)}`;
      if (notify) ctx.ui.notify(warning, "warning");
      return { text: `${result.text} Warning: ${warning}`, details: { ...result.details, warning } };
    }
  }
  private put(trigger: Trigger, ctx: ExtensionContext, notify = true): string | undefined {
    if (!this.triggers.has(trigger.name) && this.triggers.size >= 20) throw new Error("A session can hold at most 20 triggers.");
    if (this.running && trigger.kind !== "once") this.seals.add(trigger.name);
    this.triggers.set(trigger.name, trigger);
    const result = this.changed({ text: "", details: {} }, ctx, notify);
    this.reconcile();
    return result.details.warning as string | undefined;
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
      const scheduledAt = due.nextAt!;
      this.gate = { sentAt: now, started: false };
      const errors: string[] = [];
      let canSend = true;
      try { assertPersistentSession(due.kind === "once" ? "schedule" : "loop", ctx); }
      catch (error) { canSend = false; errors.push(String(error)); }
      try {
        if (due.kind === "once") this.triggers.delete(due.name);
        else if (due.kind === "self-paced") due.nextAt = null;
        else if (due.kind === "cron") due.nextAt = this.time.nextCronAt(due.cron, due.tz, now);
        else due.nextAt = nextInterval(due, now);
      } catch (error) { this.triggers.delete(due.name); errors.push(String(error)); }
      if (due.kind !== "interval" || errors.length) {
        try { this.snapshot(ctx); }
        catch (error) { canSend = false; errors.push(`Could not save consumed trigger: ${String(error)}`); }
      }
      if (canSend) {
        try {
          let prompt = due.kind === "self-paced" ? dynamicPrompt(due.prompt, due.name) : due.prompt;
          if (now - scheduledAt > 120_000 && !due.prompt.trimStart().startsWith("/")) prompt += `\n\n[spider schedule] Scheduled for ${this.time.formatInZone(scheduledAt, due.tz)} (${new Date(scheduledAt).toISOString()} UTC). Running late because the session was busy, pi was closed or the machine was asleep.`;
          this.pi.sendUserMessage(prompt, { deliverAs: "followUp", expandPromptTemplates: due.origin === "user" });
        }
        catch (error) { canSend = false; errors.push(String(error)); }
      }
      if (!canSend) this.gate = undefined;
      if (errors.length) ctx.ui.notify(errors.join("; "), "error");
    }
    this.arm();
  }
  settled(): void {
    this.running = false; this.seals.clear();
    if (this.gate?.started) this.gate = undefined;
    this.arm(true);
  }
  shutdown(): void {
    clearTimeout(this.timer); this.timer = undefined; this.triggers.clear(); this.ctx = undefined;
    this.running = false; this.gate = undefined; this.activated = false; this.seals.clear();
  }

  async loop(args: LoopArgs, ctx: ExtensionContext): Promise<Result> {
    assertPersistentSession("loop", ctx); this.context(ctx);
    if (args.prompt !== undefined) assertModelPrompt(args.prompt);
    if (args.at !== undefined) throw new Error("spider loop does not accept at; use spider schedule");
    const name = validName(args.name ?? "loop");
    if (args.stop) {
      const old = this.triggers.get(name);
      if (this.running && old?.kind !== "once") this.seals.add(name);
      const stopped = old !== undefined && old.kind !== "once" && this.triggers.delete(name);
      this.arm();
      const result = { text: stopped ? "Loop stopped." : "No loop was running.", details: { stopped } };
      return stopped ? this.changed(result, ctx) : result;
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
    const warning = this.put(trigger, ctx);
    return { text: (warning ? `Warning: ${warning} ` : "") + (trigger.kind === "self-paced" ? `Self-paced loop started. Re-arm with spider schedule; stop it with spider loop name:${JSON.stringify(name)} stop:true.` : `Loop ${name} scheduled.`), details: { ...this.status().details, ...(warning ? { warning } : {}) } };
  }
  async schedule(args: ScheduleArgs, ctx: ExtensionContext): Promise<Result> {
    assertPersistentSession("schedule", ctx); this.context(ctx);
    const name = validName(args.name ?? "wakeup");
    if (!args.stop && this.seals.has(name)) {
      const message = "A wakeup this run asked for was not scheduled: a loop was ended or replaced during this run. Do not schedule another wakeup in this run.";
      ctx.ui.notify(message, "warning"); throw new Error(message);
    }
    const current = this.triggers.get(name);
    const rearm = current?.kind === "self-paced" && args.prompt?.trim() === `/loop ${current.prompt}` ? current : undefined;
    if (!rearm && args.prompt !== undefined) assertModelPrompt(args.prompt);
    if (args.cron !== undefined) throw new Error("spider schedule does not accept cron; use spider loop");
    if (args.tz !== undefined) throw new Error("spider schedule does not accept tz; use spider loop with cron");
    if (args.stop) {
      const cancelled = this.triggers.get(name)?.kind === "once" && this.triggers.delete(name);
      this.arm(); const result = { text: cancelled ? "Pending wakeup cancelled." : "No named one-shot was pending.", details: { cancelled: !!cancelled } };
      return cancelled ? this.changed(result, ctx) : result;
    }
    if ((args.at !== undefined) === (args.delaySeconds !== undefined) || !args.prompt?.trim() || (args.delaySeconds !== undefined && !Number.isFinite(args.delaySeconds))) throw new Error("spider schedule needs delaySeconds or at, and a prompt, unless stop is true; delaySeconds must be finite");
    const seconds = args.delaySeconds === undefined ? undefined : Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.round(args.delaySeconds)));
    const nextAt = args.at === undefined ? Date.now() + seconds! * 1000 : this.time.parseAt(args.at, Date.now());
    if (rearm) {
      rearm.nextAt = nextAt; this.arm();
      return this.changed({ text: `Wakeup scheduled for ${name}, at ${new Date(nextAt).toISOString()}.`, details: { ...(seconds === undefined ? {} : { delaySeconds: seconds }), fireAt: new Date(nextAt).toISOString(), noop: args.noop === true } }, ctx);
    }
    const trigger: Trigger = {
      name, kind: "once", prompt: args.prompt.trim(), origin: "model", tz: this.time.resolveTimeZone(), nextAt,
      ...(args.at === undefined ? { delaySeconds: seconds! } : { at: args.at }),
      ...(args.reason === undefined ? {} : { reason: args.reason }), noop: args.noop === true,
    };
    const replaced = this.triggers.has(name);
    const warning = this.put(trigger, ctx);
    return { text: `Wakeup scheduled${seconds === undefined ? "" : ` in ${seconds}s`}, at ${new Date(nextAt).toISOString()}.${replaced ? ` It replaced the trigger named ${name}.` : ""}${warning ? ` Warning: ${warning}` : ""}`, details: { ...(seconds === undefined ? {} : { delaySeconds: seconds }), fireAt: new Date(nextAt).toISOString(), noop: args.noop === true, ...(warning ? { warning } : {}) } };
  }
  async command(cmd: LoopCommand, ctx: ExtensionContext, origin: PromptOrigin = "user"): Promise<Result> {
    assertPersistentSession("loop", ctx); this.context(ctx);
    const usage = "Usage: /loop [interval like 5m or 1h] <prompt>, /loop stop [name|all], or /loop to list triggers";
    if (cmd.kind === "list") {
      const status = this.status(); return { text: `${status.text}\n${usage}`, details: status.details };
    }
    if (cmd.kind === "usage") return { text: `${cmd.reason ? `${cmd.reason} ` : ""}${usage}`, details: { usage: true } };
    if (cmd.kind === "stop") {
      const names = cmd.target === "defaults" ? ["loop", "wakeup"] : cmd.target === "all" ? [...this.triggers.keys()] : [validName(cmd.name)];
      let stopped = false;
      for (const name of names) {
        const trigger = this.triggers.get(name);
        if (this.running && (trigger ? trigger.kind !== "once" : cmd.target !== "all" && name !== "wakeup")) this.seals.add(name);
        stopped = this.triggers.delete(name) || stopped;
      }
      this.arm();
      const result = { text: stopped ? "Loop stopped." : "No loop was running.", details: { stopped } };
      return stopped ? this.changed(result, ctx, false) : result;
    }
    if (origin === "model") assertModelPrompt(cmd.prompt);
    const base = { name: "loop", prompt: cmd.prompt, origin, tz: this.time.resolveTimeZone() };
    const warning = this.put(cmd.kind === "fixed" ? { ...base, kind: "interval", interval: cmd.token, intervalSeconds: Math.max(60, cmd.seconds), anchor: Date.now(), nextAt: Date.now() } : { ...base, kind: "self-paced", nextAt: Date.now() }, ctx, false);
    return { text: `Loop started.${warning ? ` Warning: ${warning}` : ""}`, details: { ...this.status().details, ...(warning ? { warning } : {}) } };
  }
}

export function registerLoopSchedule(pi: ExtensionAPI, time: SchedulerTimeMath): SessionScheduler {
  const scheduler = new SessionScheduler(pi, time);
  pi.on("session_start", (event, ctx) => { scheduler.start(event, ctx); });
  pi.on("agent_start", () => { scheduler.agentStart(); });
  pi.on("agent_settled", () => { scheduler.settled(); });
  pi.on("session_shutdown", () => { scheduler.shutdown(); });
  pi.registerCommand("loop", {
    description: "Run external-work checks (CI, deploys, timers): /loop [5m|1h] <prompt>, /loop to list, or /loop stop [name|all]. Not for polling subagents; completion notices arrive automatically.",
    async handler(args, ctx) {
      const result = await scheduler.command(parseLoop(args), ctx);
      ctx.ui.notify(result.text, "info");
    },
  });
  return scheduler;
}
