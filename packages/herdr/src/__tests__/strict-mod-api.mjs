// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';

export const modApi = JSON.parse(readFileSync(new URL('./fixtures/mod-api.json', import.meta.url), 'utf8'));
const prototypes = new Map();
function element(type = 'gpui-kit.NativeElement') {
  if (!prototypes.has(type)) {
    const prototype = Object.create(null);
    for (const method of modApi.elements[type]) {
      prototype[method] = function (...args) {
        if (method === 'child') this.items.push(args[0]);
        else if (method === 'children') this.items.push(...args[0]);
        else if (method === 'when') return args[0] ? args[1](this) : this;
        else if (method === 'map') return args[0](this);
        else if (['bg', 'text_color', 'border_color'].includes(method) && (typeof args[0] !== 'string' || !args[0].startsWith('#'))) {
          throw new Error(`${method} requires a hex color`);
        } else if (['hover', 'active', 'focus'].includes(method)) args[0](element(type));
        if (method.startsWith('on_')) this.events[method] = args[0];
        if (method === 'on_mouse_down' || method === 'on_mouse_up') {
          this.mouseEvents ??= {};
          this.mouseEvents[`${method}:${args[0]}`] = args[1];
        }
        this.styles[method] = args;
        return this;
      };
    }
    prototypes.set(type, prototype);
  }
  const result = Object.create(prototypes.get(type));
  result.items = []; result.events = {}; result.styles = {}; result.attrs = result.styles;
  return result;
}

export function createUiModules() {
  const modules = {};
  const adapters = {
    View: class {}, div: () => element(), svg: () => element(), image: () => element(),
    v_flex: () => element(), h_flex: () => element(), Button: { new: id => element().id(id) },
    Scrollbar: { vertical: () => element(), horizontal: () => element(), new: () => element() },
  };
  for (const [module, names] of Object.entries(modApi.modules)) {
    if (!module.startsWith('gpui')) continue;
    modules[module] = Object.fromEntries(names.map(name => [name, adapters[name] ?? (() => {
      throw new Error(`Unimplemented test API: ${module}.${name}`);
    })]));
  }
  return modules;
}

/**
 * Herdr 0.1.11 calls a mod's `init` with an empty object. Layout props reach a
 * mod only through herdr's `props()` (herdr.d.ts, `export function props()`).
 */
export const initArgument = () => ({});

/** Starts a view the way the app does. */
export function initView(view, cx) { view.init(initArgument(), cx); return view; }

/**
 * Refuses an `init` call that passes props, so a test cannot hand the mod
 * something the real app never does.
 */
export function strictInit(view) {
  const init = view.init;
  view.init = function (first, cx) {
    if (first === null || typeof first !== 'object' || Object.keys(first).length) {
      throw new Error('Herdr passes {} to init; layout props come only from props()');
    }
    return init.call(this, first, cx);
  };
  return view;
}

export function createHostModule(ports) {
  return Object.fromEntries(modApi.modules.herdr.map(name => [name, (...args) => {
    if (typeof ports[name] !== 'function') throw new Error(`Unimplemented test API: herdr.${name}`);
    return ports[name](...args);
  }]));
}
