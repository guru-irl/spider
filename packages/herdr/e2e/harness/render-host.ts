// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { build } from 'vite';
import { Script, createContext } from 'node:vm';
import { realpathSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AppBoundaryError } from './app.js';
import type { RenderedUi } from './app.js';

export interface RenderHostOptions {
  installedDirectory: string;
  props: unknown;
  api: Readonly<Record<string, (...args: any[]) => unknown>>;
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  dispose?(): void | Promise<void>;
}
export interface RenderHost {
  invalidate(): void;
  uiSnapshot(): Promise<RenderedUi>;
  activate(controlId: string): Promise<void>;
  key(controlId: string, key: 'enter' | 'space'): Promise<void>;
  waitForUi(description: string, predicate: (ui: RenderedUi) => boolean, timeoutMs: number): Promise<RenderedUi>;
  close(): Promise<void>;
}
interface Element {
  id: string | null;
  disabled: boolean;
  attributes: Record<string,unknown>;
  children: (Element | string)[];
  click?: (event: unknown, cx: unknown) => unknown;
  key?: (event: unknown, cx: unknown) => unknown;
}
const styles = new Set([
  'min_w_0', 'min_h_0', 'min_w', 'min_h', 'max_w', 'max_h', 'size', 'size_full', 'w', 'h', 'w_full', 'h_full',
  'w_2', 'h_2', 'h_3', 'w_3', 'h_4', 'w_4', 'p_3', 'gap_2', 'gap_3', 'rounded_lg', 'rounded_full',
  'flex_1', 'flex_none', 'flex_wrap', 'items_center', 'items_start', 'justify_between', 'justify_center',
  'gap', 'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'm', 'mx', 'my', 'bg', 'text_color', 'text_size', 'text_sm', 'text_base',
  'font_family', 'font_weight', 'rounded', 'truncate', 'tooltip', 'overflow_hidden', 'overflow_y_scrollbar', 'overflow_y_scroll',
  'spin', 'line_height', 'cursor_pointer', 'opacity', 'border_0', 'border_color', 'border',
  'fill', 'flex', 'font_bold', 'font_medium', 'font_semibold', 'mr', 'mt', 'rounded_bl', 'self_start', 'text_right', 'whitespace_nowrap', 'mode', 'relative', 'absolute', 'left', 'right', 'top', 'bottom', 'ml', 'mb', 'border_t', 'border_b', 'border_l', 'accessibility_label', 'tab_index',
]);
const herdrNames = ['exec', 'run', 'theme', 'watchFolder', 'panes', 'shared', 'setShared', 'notify', 'nextCommand', 'readTextFile', 'hc', 'machines', 'terminals', 'spaces', 'agents', 'focused', 'props', 'window', 'layout', 'setAgentOrder', 'openOverlay', 'closeOverlay'];
function contained(root: string, target: string): string {
  const physical = realpathSync(target), suffix = relative(root, physical);
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) throw new AppBoundaryError('unowned-mod-import', 'mod import leaves installed directory');
  let p = resolve(target);
  while (p !== root) { if (lstatSync(p).isSymbolicLink()) throw new AppBoundaryError('unowned-mod-import', 'symlink mod import'); p = dirname(p); }
  return physical;
}
export async function createRenderHost(options: RenderHostOptions): Promise<RenderHost> {
  const root = realpathSync(options.installedDirectory);
  if (root !== resolve(options.installedDirectory)) throw new AppBoundaryError('unowned-mod-import', 'symlink installed directory');
  let closed = false, frame = 0, failure: unknown, instance: any;
  let snapshot: RenderedUi = { frame: 0, nodes: [] };
  let controls = new Map<string, Element>();
  const listeners = new Set<() => void>(), timers = new Set<ReturnType<typeof setInterval>>();
  const tasks = new Set<{ cancel(): void }>();
  const taskCompletions = new WeakMap<object, Promise<unknown>>();
  const completeHandler = async (result: unknown) => {
    const handle = await result;
    if (handle !== null && typeof handle === 'object') await taskCompletions.get(handle);
  };
  const elements = new WeakMap<object, Element>();
  const focusHandles = new WeakMap<object, string>();
  let nextFocus = 0;
  const emit = () => { for (const listener of listeners) listener(); };
  const fail = (error: unknown) => { failure = error; emit(); };
  const element = (id: string | null = null): any => {
    const state: Element = { id, disabled: false, attributes: {}, children: [] };
    let proxy: any;
    const add = (child: unknown): void => {
      if (child === null || child === undefined || typeof child === 'boolean') return;
      if (Array.isArray(child)) { child.forEach(add); return; }
      if (typeof child === 'string' || typeof child === 'number') { state.children.push(String(child)); return; }
      const nested = typeof child === 'object' ? elements.get(child) : undefined;
      if (!nested) throw new AppBoundaryError('unsupported-render-node', 'unsupported rendered child');
      state.children.push(nested);
    };
    proxy = new Proxy({}, { get: (_target, key) => {
      if (key === 'then') return undefined;
      if (key === 'id') return (id: string) => { state.id = id; return proxy; };
      if (key === 'disabled') return (disabled: boolean) => { state.disabled = Boolean(disabled); return proxy; };
      if (key === 'child') return (child: unknown) => { add(child); return proxy; };
      if (key === 'children') return (children: unknown[]) => { children.forEach(add); return proxy; };
      if (key === 'on_click') return (click: Element['click']) => { state.click = click; return proxy; };
      if (key === 'on_hover') return (_hover: unknown) => proxy;
      if (key === 'on_key_down') return (handler: Element['key']) => { state.key = handler; return proxy; };
      if (key === 'when') return (condition: unknown, transform: (e: any) => unknown) => { if (condition) transform(proxy); return proxy; };
      // Style closures are registered but not applied as a synthetic pointer state.
      if (['hover', 'active', 'focus'].includes(String(key))) return (_transform: unknown) => proxy;
      if (key === 'track_focus') return (handle: object) => {
        const id = focusHandles.get(handle);
        if (!id) throw new AppBoundaryError('invalid-focus-handle', 'track_focus needs a handle created by this native context');
        state.attributes.track_focus = [id];
        return proxy;
      };
      if (styles.has(String(key))) return (...args: unknown[]) => { state.attributes[String(key)] = args; return proxy; };
      throw new AppBoundaryError('unsupported-widget-api', `unimplemented widget API: ${String(key)}`);
    } });
    elements.set(proxy, state); return proxy;
  };
  const render = (): void => {
    if (closed || !instance) return;
    try {
      const tree = instance.render(cx), state = elements.get(tree);
      if (!state) throw new AppBoundaryError('unsupported-render-node', 'mod render did not return an element');
      const nodes: RenderedUi['nodes'][number][] = [], nextControls = new Map<string, Element>(), ids = new Set<string>();
      const text = (node: Element): string => node.children.map(c => typeof c === 'string' ? c : text(c)).join(' ');
      const walk = (node: Element, parentEnabled: boolean): void => {
        const enabled = parentEnabled && !node.disabled;
        const id = node.id ?? `render-${nodes.length}`;
        if (ids.has(id)) throw new AppBoundaryError('duplicate-control-id', `duplicate control id: ${id}`);
        ids.add(id);
        nodes.push({ id, text: text(node), enabled, bounds: [0, 0, 0, 0], attributes: structuredClone(node.attributes) });
        if (node.id && node.click) nextControls.set(node.id, { ...node, disabled: !enabled });
        for (const child of node.children) if (typeof child !== 'string') walk(child, enabled);
      };
      walk(state, true); controls = nextControls; snapshot = { frame: ++frame, nodes }; emit();
    } catch (error) { fail(error); }
  };
  const cx: any = new Proxy({
    notify: render,
    stop_propagation: () => {}, // activate dispatches to one registered node, never a guessed ancestor.
    focus_handle: () => {
      const handle = { focus() {}, contains_focused: () => false };
      focusHandles.set(handle, `focus-${nextFocus++}`);
      return handle;
    },
    spawn: (work: (cx: unknown) => unknown) => {
      let cancelled = false;
      const task = { cancel: () => { cancelled = true; tasks.delete(task); } }; tasks.add(task);
      const completion = Promise.resolve().then(() => { if (!cancelled && !closed) return work(cx); }).catch(error => { if (!cancelled && !closed) fail(error); }).finally(() => tasks.delete(task));
      taskCompletions.set(task, completion);
      return task;
    },
    timer: { every: (ms: number, work: (cx: unknown) => unknown) => {
      if (!Number.isFinite(ms) || ms < 1) throw new Error('invalid mod timer');
      const timer = setInterval(() => { if (!closed) { try { work(cx); } catch (error) { fail(error); } } }, ms); timer.unref?.(); timers.add(timer);
      return { cancel: () => { clearInterval(timer); timers.delete(timer); } };
    } },
  }, { get: (target, key) => { if (!(key in target)) throw new AppBoundaryError('unsupported-context-api', `unimplemented mod context API: ${String(key)}`); return target[key as keyof typeof target]; } });
  const bridge: Record<string, unknown> = {
    View: class {}, div: () => element(), svg: () => element(), image: () => element(), v_flex: () => element(), h_flex: () => element(),
    Button: { new: (id: string) => element(id) },
  };
  for (const name of herdrNames) bridge[name] = (...args: unknown[]) => {
    if (closed) throw new AppBoundaryError('render-host-closed', 'render host is closed');
    // The layout's props reach a mod only through props(); init gets {} (Herdr 0.1.11).
    if (name === 'props') return options.props;
    const api = options.api[name];
    if (!api) throw new AppBoundaryError('unsupported-herdr-api', `unimplemented Herdr API: ${name}`);
    return api(...args);
  };
  const entry = contained(root, join(root, 'main.js'));
  const bundled = await build({ configFile: false, logLevel: 'silent', build: {
    write: false, minify: false, lib: { entry, formats: ['cjs'], fileName: () => 'render.cjs' },
    rolldownOptions: { output: { exports: 'named' } },
  }, plugins: [{
    name: 'strict-render-host', enforce: 'pre',
    resolveId(source, importer) {
      if (['herdr', 'gpui-kit', 'gpui-base'].includes(source)) return `\0render-api:${source}`;
      if (source.startsWith('\0render-api:') || !importer) return;
      if (!source.startsWith('.')) throw new AppBoundaryError('unsupported-mod-import', `unimplemented mod import: ${source}`);
      return contained(root, resolve(dirname(importer), source));
    },
    load(id) {
      if (!id.startsWith('\0render-api:')) return;
      const name = id.slice('\0render-api:'.length);
      const names = name === 'herdr' ? herdrNames : name === 'gpui-kit' ? ['View', 'div', 'svg', 'image'] : ['Button', 'v_flex', 'h_flex'];
      return names.map(name => `export const ${name} = globalThis.__renderBridge.${name};`).join('\n');
    },
  }] });
  const output = Array.isArray(bundled) ? bundled[0].output : 'output' in bundled ? bundled.output : [];
  let code: string | undefined;
  for (const item of output) if (item.type === 'chunk') code = item.code;
  if (!code) throw new AppBoundaryError('invalid-mod', 'mod bundle is absent');
  const module = { exports: {} as any };
  const context = createContext({ __renderBridge: bridge, module, exports: module.exports, console, Date, Map, Set, Promise, JSON, Error, TextEncoder, TextDecoder, encodeURIComponent, decodeURIComponent, ...(options.storage ? { localStorage: options.storage } : {}) });
  try {
    new Script(code, { filename: join(root, 'main.js') }).runInContext(context, { timeout: 2000 });
    const Mod = module.exports.default;
    if (typeof Mod !== 'function') throw new AppBoundaryError('invalid-mod', 'installed mod has no default View');
    instance = new Mod(); instance.init?.({}, cx); render(); if (failure) throw failure;
  } catch (error) { closed = true; for (const timer of timers) clearInterval(timer); for (const task of tasks) task.cancel(); await options.dispose?.(); throw error; }
  const current = (): RenderedUi => { if (failure) throw failure; if (closed) throw new AppBoundaryError('render-host-closed', 'render host is closed'); return structuredClone(snapshot); };
  return {
    invalidate: render,
    uiSnapshot: async () => current(),
    activate: async id => {
      current(); const control = controls.get(id);
      if (!control) throw new AppBoundaryError('unknown-control', `unknown control: ${id}`);
      if (control.disabled) throw new AppBoundaryError('disabled-control', `disabled control: ${id}`);
      await completeHandler(control.click!({ kind: 'click' }, cx)); if (!closed) { render(); current(); }
    },
    key: async (id, key) => {
      current(); const control = controls.get(id);
      if (!control?.key) throw new AppBoundaryError('unknown-key-control', `no registered key handler: ${id}`);
      if (control.disabled) throw new AppBoundaryError('disabled-control', `disabled control: ${id}`);
      await completeHandler(control.key({ keystroke: { key } }, cx)); if (!closed) { render(); current(); }
    },
    waitForUi: (description, predicate, timeoutMs) => new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const stop = () => { listeners.delete(observe); clearTimeout(timer); };
      const observe = () => { try { const ui = current(); if (predicate(ui)) { stop(); resolve(ui); } } catch (error) { stop(); reject(error); } };
      timer = setTimeout(() => { stop(); reject(new AppBoundaryError('render-deadline', `${description}: last rendered UI ${JSON.stringify(snapshot)}`)); }, timeoutMs);
      listeners.add(observe); observe(); observe();
    }),
    close: async () => {
      if (closed) return;
      instance?.close?.(); closed = true;
      for (const timer of timers) clearInterval(timer); timers.clear();
      for (const task of tasks) task.cancel(); tasks.clear();
      await options.dispose?.(); emit(); listeners.clear();
    },
  };
}
