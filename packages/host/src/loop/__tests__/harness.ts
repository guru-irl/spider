import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLoopSchedule, type SessionScheduler } from "../index";

interface Harness {
  runtime: SessionScheduler;
  ctx: ExtensionContext;
  messages: { prompt: unknown; options: unknown }[];
  notifications: { text: string; level?: string }[];
  prompts(): unknown[];
  setIdle(value: boolean): void;
  emit(name: string, event?: unknown): Promise<void>;
  slash(args: string): Promise<void>;
}

export function setup(): Harness {
  let idle = true;
  const messages: { prompt: unknown; options: unknown }[] = [];
  const notifications: { text: string; level?: string }[] = [];
  const hooks = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const pi = {
    sendUserMessage(prompt: unknown, options: unknown) { messages.push({ prompt, options }); },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand(name: string, def: { handler(args: string, ctx: ExtensionContext): Promise<void> }) { commands.set(name, def); },
  };
  const ctx = {
    mode: "tui",
    isIdle: () => idle,
    ui: { notify: (text: string, level?: string) => { notifications.push({ text, level }); } },
  } as ExtensionContext;
  const runtime = registerLoopSchedule(pi as unknown as ExtensionAPI);
  return {
    runtime, ctx, messages, notifications,
    prompts: () => messages.map(message => message.prompt),
    setIdle: (value: boolean) => { idle = value; },
    emit: async (name: string, event: unknown = {}) => {
      for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
    },
    slash: (args: string) => commands.get("loop")!.handler(args, ctx),
  };
}
