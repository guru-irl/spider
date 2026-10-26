import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { vi, type Mock } from "vitest";
import { registerLoopSchedule, type SchedulerTimeMath, type SessionScheduler, type TriggerSnapshot } from "../index";

export interface FakeTime extends SchedulerTimeMath { zone: string; occurrences: Map<string, number[]> }

export function fakeTime(): FakeTime {
  const occurrences = new Map<string, number[]>();
  const time: FakeTime = {
    zone: "Test/Zone",
    occurrences,
    resolveTimeZone(tz?: string) {
      if (tz === "Bad/Zone") throw new Error("Invalid time zone");
      return tz ?? time.zone;
    },
    formatInZone: (at: number, tz: string) => new Date(at).toISOString().replace("T", " ").replace("Z", "") + " " + tz,
    parseAt(value: string, now: number) {
      const at = Date.parse(value);
      if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(at) || at <= now) throw new Error("at must have an offset and be strictly future");
      return at;
    },
    parseCron(expression: string) {
      if (["invalid", "60 * * * *"].includes(expression) || expression.split(/\s+/).length !== 5) throw new Error("Invalid cron syntax");
      return { parsed: expression };
    },
    nextCronAt(expression: string, _tz: string, after: number) {
      time.parseCron(expression);
      const at = occurrences.get(expression)?.find(at => at > after);
      if (at === undefined) throw new Error("No cron occurrence within five years");
      return at;
    },
  } satisfies SchedulerTimeMath & { zone: string; occurrences: Map<string, number[]> };
  return time;
}

export interface Harness {
  runtime: SessionScheduler;
  ctx: ExtensionContext;
  messages: { prompt: unknown; options: unknown }[];
  notifications: { text: string; level?: string }[];
  entries: SessionEntry[];
  appendEntry: Mock<(customType: string, data?: unknown) => void>;
  getEntries(): SessionEntry[];
  getSessionId(): string;
  branch(id: string | null): void;
  snapshots(): TriggerSnapshot[];
  restart(reason: SessionStartEvent["reason"], start?: { mode?: ExtensionContext["mode"]; child?: boolean }): Promise<Harness>;
  prompts(): unknown[];
  setIdle(value: boolean): void;
  emit(name: string, event?: unknown): Promise<void>;
  settleDelivery(): Promise<void>;
  slash(args: string): Promise<void>;
}

export function setup(time: SchedulerTimeMath = fakeTime(), saved?: { sessionId: string; entries: SessionEntry[]; leafId: string | null }): Harness {
  let idle = true;
  let leafId = saved?.leafId ?? null;
  const sessionId = saved?.sessionId ?? "test-session";
  const entries: SessionEntry[] = structuredClone(saved?.entries ?? []);
  const messages: { prompt: unknown; options: unknown }[] = [];
  const notifications: { text: string; level?: string }[] = [];
  const hooks = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const appendEntry = vi.fn((customType: string, data?: unknown) => {
    const entry: SessionEntry = { type: "custom", customType, data: structuredClone(data), id: `entry-${entries.length}`, parentId: leafId, timestamp: new Date().toISOString() };
    entries.push(entry);
    leafId = entry.id;
  });
  const pi = {
    appendEntry,
    sendUserMessage(prompt: unknown, options: unknown) { messages.push({ prompt, options }); },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand(name: string, def: { handler(args: string, ctx: ExtensionContext): Promise<void> }) { commands.set(name, def); },
  };
  const ctx = {
    mode: "tui",
    isIdle: () => idle,
    sessionManager: { getEntries: () => structuredClone(entries), getSessionId: () => sessionId },
    ui: { notify: (text: string, level?: string) => { notifications.push({ text, level }); } },
  } as ExtensionContext;
  const runtime = registerLoopSchedule(pi as unknown as ExtensionAPI, time);
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
  };
  return {
    runtime, ctx, messages, notifications, entries, appendEntry,
    getEntries: () => structuredClone(entries), getSessionId: () => sessionId,
    branch: id => { leafId = id; },
    snapshots: () => structuredClone(entries.filter(e => e.type === "custom" && e.customType === "spider-triggers").map(e => e.type === "custom" ? e.data as TriggerSnapshot : undefined) as TriggerSnapshot[]),
    async restart(reason, start) {
      await emit("session_shutdown", { reason });
      const h = setup(time, { sessionId, entries, leafId });
      h.ctx.mode = start?.mode ?? "tui";
      vi.stubEnv("PI_SUBAGENT_CHILD", start?.child ? "1" : "0");
      await h.emit("session_start", { reason });
      return h;
    },
    prompts: () => messages.map(message => message.prompt),
    setIdle: value => { idle = value; }, emit,
    settleDelivery: async () => { await emit("agent_start"); await emit("agent_settled"); await vi.advanceTimersByTimeAsync(0); },
    slash: args => commands.get("loop")!.handler(args, ctx),
  };
}
