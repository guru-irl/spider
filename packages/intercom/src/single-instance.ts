import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import localIntercom, { type IntercomBrokerPort } from './local.js';
import { INTERCOM_EXTENSION_REGISTRY_READY_EVENT } from './extension-api.js';

export const INTERCOM_CONFLICT_MESSAGE = 'Another intercom extension is loaded. Remove its package or extension entry and run /reload.';
const instances = new WeakMap<object, { foreign: boolean; duplicate: boolean; conflict: boolean; started: boolean }>();
const forkSignal = Symbol('spider-intercom');

export function intercomConflict(pi: Pick<ExtensionAPI, 'events'>): 'intercom-extension-conflict' | undefined {
  return instances.get(pi.events)?.conflict ? 'intercom-extension-conflict' : undefined;
}

export function registerIntercomOnce(pi: ExtensionAPI, brokerPort?: IntercomBrokerPort): void {
  if (instances.has(pi.events)) return;
  const state = { foreign: false, duplicate: false, conflict: false, started: false };
  instances.set(pi.events, state);
  const stopProbe = pi.events.on(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, payload => {
    if (payload && typeof payload === 'object' && forkSignal in payload) state.duplicate = true;
    else state.foreign = true;
  });
  pi.on('session_shutdown', () => { stopProbe(); instances.delete(pi.events); });
  pi.on('session_start', async (event, ctx) => {
    if (process.env.PI_SUBAGENT_CHILD === '1' && ctx.mode !== 'rpc') return;
    if (state.started || state.conflict || (state.duplicate && !state.foreign)) return;
    if (state.foreign || pi.getAllTools().some(tool => tool.name === 'intercom')) {
      state.conflict = true;
      ctx.ui.notify(INTERCOM_CONFLICT_MESSAGE, 'error');
      if (process.env.PI_SUBAGENT_CHILD === '1') {
        // Pi continues after event-handler errors. Block input and exit explicitly.
        pi.on('input', () => ({ action: 'handled' }));
        pi.on('before_agent_start', (_event, context) => { context.abort(); });
        ctx.shutdown();
      }
      return;
    }
    state.started = true;
    // The current session_start dispatch is already in progress. Capture the
    // original startup handler and invoke it once with the bound context.
    const starts: Array<(event: any, ctx: any) => unknown> = [];
    const proxy = new Proxy(pi, { get(target, key, receiver) {
      if (key === 'on') return (name: string, handler: any) => {
        if (name === 'session_start') starts.push(handler);
        else target.on(name as any, handler);
      };
      if (key === 'events') return { ...target.events,
        on: target.events.on.bind(target.events),
        emit(name: string, payload: unknown) {
          target.events.emit(name, name === INTERCOM_EXTENSION_REGISTRY_READY_EVENT
            ? { ...(payload as object), [forkSignal]: true } : payload);
        } };
      return Reflect.get(target, key, receiver);
    } });
    localIntercom(proxy, brokerPort);
    for (const start of starts) await start(event, ctx);
  });
}
