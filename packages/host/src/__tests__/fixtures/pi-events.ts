import { EventEmitter } from 'node:events';
import type { IntercomBrokerPort } from '@spider/intercom';
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
export const hostUnitPorts: { intercomBroker: IntercomBrokerPort } = { intercomBroker: async (_connect: () => Promise<void>): Promise<void> => {} };
