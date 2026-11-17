import { EventEmitter } from 'node:events';
import type { IntercomBrokerPort } from '@spider/intercom';
import type { ExtensionAPI, SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';
export interface PiEventsFixture { on<T>(name: string, handler: (value: T) => void): () => void; emit(name: string, value?: unknown): void }
export function createPiEvents(): PiEventsFixture {
  const bus = new EventEmitter();
  return { on<T>(name: string, handler: (value: T) => void): () => void { bus.on(name, handler); return () => { bus.off(name, handler); }; },
    emit(name: string, value?: unknown): void { bus.emit(name, value); } };
}
export function withPiEvents<T extends object>(pi: T): T & { events: ReturnType<typeof createPiEvents> } {
  const api = pi as T & { events?: ReturnType<typeof createPiEvents>; registerTool?: (tool: any) => void;
    getAllTools?: () => any[]; getActiveTools?: () => string[]; getSessionName?: () => string | undefined;
    registerCommand?: (...args: any[]) => void; registerShortcut?: (...args: any[]) => void; registerMessageRenderer?: (...args: any[]) => void };
  api.events ??= createPiEvents();
  if (!api.getAllTools) {
    const tools: any[] = [], register = api.registerTool?.bind(pi);
    api.registerTool = tool => { tools.push(tool); register?.(tool); };
    api.getAllTools = () => tools;
  }
  api.getActiveTools ??= () => api.getAllTools!().map(tool => tool.name);
  api.getSessionName ??= () => undefined;
  api.registerCommand ??= () => {};
  api.registerShortcut ??= () => {};
  api.registerMessageRenderer ??= () => {};
  return api as T & { events: ReturnType<typeof createPiEvents> };
}
type HostFixtureHook = (event: any, ctx: any) => unknown;
type HostFixtureEntry = Record<string, unknown> & { id: string };
type HostFixtureMessage = { customType: string } & Partial<Parameters<ExtensionAPI['sendMessage']>[0]>;
interface HostFixtureContext {
  cwd: string; mode: string; hasUI: boolean; isIdle(): boolean; model: { id: string };
  ui: { notify(message: string): void; setStatus(): void }; abort(): void;
  sessionManager: { getSessionId(): string; getSessionFile(): string | null; getSessionName(): string | null;
    getEntries(): (HostFixtureEntry | SessionEntry)[]; getBranch(): never[]; getLeafId(): null };
}
interface HostFixturePi {
  events: PiEventsFixture;
  on(name: string, handler: HostFixtureHook): () => void;
  registerTool(): void; registerCommand(): void; registerShortcut(): void; registerMessageRenderer(): void; registerEntryRenderer(): void;
  getSessionName(): string | undefined; sendMessage(message: HostFixtureMessage): void;
  sendUserMessage(): void; appendEntry(): void;
}
interface HostSessionFixture { pi: HostFixturePi; ctx: HostFixtureContext; hooks: Map<string, HostFixtureHook[]>; sent: any[]; setPersistMessages(value: boolean): void }
export function createHostSessionFixture(options: {
  cwd: string; sessionId: string; sessionFile?: string | null; hasUI?: boolean; sessionName?: string;
  notify?: (message: string) => void; abort?: () => void; sessionManager?: SessionManager;
}): HostSessionFixture {
  const hooks = new Map<string, HostFixtureHook[]>(), sent: any[] = [];
  const entries: HostFixtureEntry[] = [];
  let persist = true;
  const ctx: HostFixtureContext = { cwd: options.cwd, mode: 'tui', hasUI: options.hasUI ?? true, isIdle: () => true,
    model: { id: 'fixture' }, ui: { notify: options.notify ?? (() => {}), setStatus() {} }, abort: options.abort ?? (() => {}),
    sessionManager: { getSessionId: () => options.sessionManager?.getSessionId() ?? options.sessionId,
      getSessionFile: (): string | null => (options.sessionManager ? options.sessionManager.getSessionFile() : options.sessionFile) ?? null,
      getSessionName: () => options.sessionName ?? null, getEntries: () => options.sessionManager?.getEntries() ?? entries, getBranch: () => [], getLeafId: () => null } };
  const pi = withPiEvents({
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      hooks.set(name, [...hooks.get(name) ?? [], handler]);
      return () => { hooks.set(name, (hooks.get(name) ?? []).filter(existing => existing !== handler)); };
    },
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
    getSessionName: () => options.sessionName,
    sendMessage(message: HostFixtureMessage) {
      sent.push(message);
      if (persist) {
        if (options.sessionManager) options.sessionManager.appendCustomMessageEntry(message.customType, message.content ?? '', message.display ?? true, message.details);
        else entries.push({ ...message, type: 'custom_message', id: `physical-entry-${entries.length + 1}` });
      }
      if (message.customType === 'intercom_message') queueMicrotask(() => {
        for (const handler of hooks.get('message_end') ?? []) handler({}, ctx);
      });
    },
    sendUserMessage() {}, appendEntry() {},
  });
  return { pi, ctx, hooks, sent, setPersistMessages(value: boolean) { persist = value; } };
}
export const hostUnitPorts: { intercomBroker: IntercomBrokerPort } = { intercomBroker: async (_connect: () => Promise<void>): Promise<void> => {} };
