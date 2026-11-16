import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface InteractiveReloadActivity {
  busy(): boolean;
  commandActive(): boolean;
  ordinaryCommandActive?(): boolean;
  overlayActive(): boolean;
}

/** Wrap the contexts Spider receives, including the session context used by shortcut overlays. */
export function trackReloadActivity<T extends ExtensionAPI>(api: T): InteractiveReloadActivity & { pi: T } {
  let commands = 0, moveCommands = 0;
  let overlays = 0;
  const contexts = new WeakMap<object, object>();
  const context = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const cached = contexts.get(value);
    if (cached) return cached;
    const wrapped = new Proxy(value, {
      get(target, key) {
        const field = Reflect.get(target, key, target);
        if (key !== "ui" || !field || typeof field !== "object") return field;
        return new Proxy(field, {
          get(ui, name) {
            const method = Reflect.get(ui, name, ui);
            if (name !== "custom" || typeof method !== "function") return method;
            return async (...args: unknown[]) => {
              overlays++;
              try { return await method.apply(ui, args); }
              finally { overlays = Math.max(0, overlays - 1); }
            };
          },
        });
      },
    });
    contexts.set(value, wrapped);
    return wrapped;
  };
  const pi = new Proxy(api, {
    get(target, key) {
      const method = Reflect.get(target, key, target);
      if (typeof method !== "function") return method;
      if (key === "on") return (name: string, handler: (...args: any[]) => unknown) => {
        if (name !== "session_start") return method.call(target, name, handler);
        return method.call(target, name, (event: unknown, ctx: unknown) => handler(event, context(ctx)));
      };
      if (key === "registerCommand" || key === "registerShortcut") return (name: string, definition: { handler: (...args: any[]) => unknown }) => {
        if (key === "registerCommand" && name === "spider-reload") return method.call(target, name, definition);
        return method.call(target, name, {
          ...definition,
          handler: (...args: unknown[]) => {
            const contextIndex = key === "registerCommand" ? 1 : 0;
            args[contextIndex] = context(args[contextIndex]);
            commands++; if (key === "registerCommand" && name === "move") moveCommands++;
            let asynchronous = false;
            const release = () => { commands = Math.max(0, commands - 1); if (key === "registerCommand" && name === "move") moveCommands = Math.max(0, moveCommands - 1); };
            try {
              const result = definition.handler(...args);
              if (result && typeof (result as PromiseLike<unknown>).then === "function") {
                asynchronous = true;
                return Promise.resolve(result).finally(release);
              }
              return result;
            } finally { if (!asynchronous) release(); }
          },
        });
      };
      return method.bind(target);
    },
  });
  return { pi, busy: () => commands > 0 || overlays > 0, commandActive: () => commands > 0, ordinaryCommandActive: () => commands > moveCommands, overlayActive: () => overlays > 0 };
}
