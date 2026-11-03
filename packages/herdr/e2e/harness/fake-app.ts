// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { AppBoundaryError, appId, appObject, parseAppReply, validateAppCommand } from './app.js';
import type { AppDriver, CommandResult } from './app.js';
import type { RenderHost } from './render-host.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CoreRow {
  address: string;
  state: 'live' | 'finished';
  labels: Record<string, string>;
  parent: string | null;
  name: string | null;
  status: unknown;
}
interface Pane { pane: string; terminal: string }
interface Tab { id: string; name: string; active: boolean; settled: boolean; terminals: Pane[] }
interface Space { id: string; name: string; folder: string; machine: string | null; active: boolean; tabs: Tab[] }
export interface FakeAppOptions {
  hc(argv: readonly string[]): Promise<unknown>;
  readLayout?(name: string): Promise<unknown>;
  selectLayout?(name: string): Promise<void>;
  selectTheme?(name: string): Promise<void>;
  record?(name: string, args: Record<string, unknown>, result: unknown): void;
}
export interface FakeAppBoundary {
  command(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  drain(): Promise<void>;
}
function coreObject(value: unknown): Record<string, unknown> {
  try {
    const r = appObject(value);
    if (r.error !== undefined) throw new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
    return r;
  } catch (error) { throw new AppBoundaryError('invalid-core-reply', `invalid core reply: ${String(error)}`); }
}
export function parseCoreRow(value: unknown): CoreRow {
  const r = coreObject(value);
  try {
    appId(r.address);
    if (!['live', 'finished'].includes(String(r.state))) throw new Error('state');
    const labels = appObject(r.labels);
    if (Object.values(labels).some(v => typeof v !== 'string')) throw new Error('labels');
    if (r.parent !== null && typeof r.parent !== 'string') throw new Error('parent');
    return { address: r.address as string, state: r.state as CoreRow['state'], labels: labels as Record<string, string>, parent: r.parent as string | null, name: typeof r.name === 'string' ? r.name : null, status: r.status ?? null };
  } catch { throw new AppBoundaryError('invalid-core-reply', 'invalid core reply: terminal'); }
}
export interface FakeAppDriverOptions {
  boundary: FakeAppBoundary;
  check(installedDirectory: string): Promise<CommandResult>;
  renderHost?: RenderHost;
}
export function createFakeAppDriver(options: FakeAppDriverOptions): AppDriver {
  const host = (): RenderHost => {
    if (!options.renderHost) throw new AppBoundaryError('render-host-not-mounted', 'installed mod render host has not been mounted');
    return options.renderHost;
  };
  return {
    command: (name, args) => options.boundary.command(name, args),
    ls: () => options.boundary.command('ls', {}), status: () => options.boundary.command('status', {}), check: options.check,
    shot: async () => { throw new AppBoundaryError('fake-app-no-pixels', 'fake-app acceptance cannot certify pixels'); },
    uiSnapshot: async () => host().uiSnapshot(), activate: async id => host().activate(id),
    keyToOwnedWindow: async () => { throw new AppBoundaryError('fake-app-no-window', 'fake-app acceptance cannot certify window key routing'); },
  };
}
export interface StagedFakeApp { module: string; binary: string; socket: string }
export async function stageFakeAppDaemon(directory: string, ownPath: (path: string) => string): Promise<StagedFakeApp> {
  const { build } = await import('vite');
  const module = ownPath(join(directory, 'app-daemon.mjs'));
  const binary = ownPath(join(directory, 'herdr-app'));
  const socket = ownPath(join(directory, 'a.s'));
  if (Buffer.byteLength(socket) > 103) throw new AppBoundaryError('app-socket-length', 'app socket exceeds 103 bytes');
  const result = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false,
    lib: { entry: fileURLToPath(new URL('../fixtures/fake-app-daemon.mjs', import.meta.url)), formats: ['es'], fileName: () => 'app-daemon.mjs' },
    rolldownOptions: { external: id => id.startsWith('node:') },
  } });
  const output = Array.isArray(result) ? result[0].output : 'output' in result ? result.output : [];
  let code: string | undefined;
  for (const item of output) if (item.type === 'chunk') code = item.code;
  if (!code) throw new AppBoundaryError('invalid-daemon', 'fake app daemon bundle is absent');
  writeFileSync(module, code, { mode: 0o600 });
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  writeFileSync(binary, `#!/bin/sh\nSPIDER_HERDR_E2E_APP_ROOT=${quote(directory)}; export SPIDER_HERDR_E2E_APP_ROOT\nSPIDER_HERDR_E2E_APP_SOCKET=${quote(socket)}; export SPIDER_HERDR_E2E_APP_SOCKET\nexec ${quote(process.execPath)} ${quote(module)} "$@"\n`, { mode: 0o700 });
  return { module, binary, socket };
}
export function createFakeAppBoundary(options: FakeAppOptions): FakeAppBoundary {
  let next = 0, layout = 'main';
  let activeSpace: string | null = null, activeTab: string | null = null, focus: string | null = null;
  const spaces: Space[] = [], errors: string[] = [];
  const modPanes = new Map<string, { pane: string; mod: string }[]>();
  const selections = new Map<string, { tab: string | null; focus: string | null }>();
  let layoutTree: unknown;
  let queue: Promise<void> = Promise.resolve();
  const fresh = (prefix: string, on: string | null = null): string => `${on ? `${on}/` : ''}${prefix}${++next}`;
  const tabOf = (id: string) => spaces.flatMap(s => s.tabs).find(t => t.id === id);
  const spaceOf = (id: string) => spaces.find(s => s.id === id || s.tabs.some(t => t.id === id));
  const paneOf = (terminal: string) => spaces.flatMap(s => s.tabs).flatMap(t => t.terminals).find(p => p.terminal === terminal);
  const get = async (address: string): Promise<CoreRow> => {
    const r = coreObject(await options.hc(['get', address, '--json']));
    if (r.address !== address) throw new AppBoundaryError('wrong-id', 'wrong terminal in core reply');
    return parseCoreRow(r);
  };
  const inventory = async (): Promise<CoreRow[]> => {
    const r = coreObject(await options.hc(['ls', '--all', '--json']));
    if (!Array.isArray(r.terminals)) throw new AppBoundaryError('invalid-core-reply', 'invalid core reply: inventory');
    const addresses = r.terminals.map(value => appId(coreObject(value).address));
    return Promise.all(addresses.map(address => get(address)));
  };
  const cleanEmpty = (): void => {
    for (const s of spaces) s.tabs = s.tabs.filter(t => t.terminals.length || modPanes.get(t.id)?.length);
    for (const id of modPanes.keys()) if (!tabOf(id)) modPanes.delete(id);
    for (let i = spaces.length - 1; i >= 0; i--) if (!spaces[i].tabs.length) spaces.splice(i, 1);
    for (const id of selections.keys()) if (!spaces.some(s => s.id === id)) selections.delete(id);
    if (!spaces.some(s => s.id === activeSpace)) activeSpace = spaces[0]?.id ?? null;
    if (!activeTab || !tabOf(activeTab)) activeTab = spaces.find(s => s.id === activeSpace)?.tabs[0]?.id ?? null;
    if (!spaces.flatMap(s => s.tabs).flatMap(t => t.terminals).some(p => p.pane === focus) && ![...modPanes.values()].flat().some(p => p.pane === focus)) focus = tabOf(activeTab ?? '')?.terminals[0]?.pane ?? modPanes.get(activeTab ?? '')?.[0]?.pane ?? null;
  };
  const adopt = (rows: CoreRow[]): void => {
    // Native adoption targets only observed label IDs, preserving the selected pane.
    for (const row of rows) {
      if (row.state !== 'live' || row.address.includes('/') || paneOf(row.address)) continue;
      const s = spaces.find(s => s.id === row.labels['herdr.space']);
      const t = s?.tabs.find(t => t.id === row.labels['herdr.tab']);
      if (s && t) t.terminals.push({ pane: fresh('p'), terminal: row.address });
    }
  };
  const world = async (): Promise<Record<string, unknown>> => {
    const rows = await inventory(); adopt(rows);
    return { spaces: spaces.map(s => ({ ...s, active: s.id === activeSpace, tabs: s.tabs.map(t => ({ ...t, name: t.name || String(s.tabs.indexOf(t) + 1), active: t.id === activeTab, terminals: t.terminals.map(p => {
      const r = rows.find(r => r.address === p.terminal);
      return { ...p, status: r?.status ?? null, name: r?.name ?? null, app: null, sub_agents: rows.filter(r => r.state === 'live' && r.parent === p.terminal).map(r => r.address).sort() };
    }) })) })), recent: [] };
  };
  const node = (id: string, raw: unknown = layoutTree): Record<string, unknown> | undefined => {
    if (!raw || typeof raw !== 'object') return;
    if (Array.isArray(raw)) { for (const v of raw) { const found = node(id, v); if (found) return found; } return; }
    const r = raw as Record<string, unknown>; if (r.id === id) return r;
    for (const v of Object.values(r)) { const found = node(id, v); if (found) return found; }
  };
  const launch = async (s: Space, t: Tab, folder: string, argv: unknown): Promise<string> => {
    const a = ['run', '--json', '--bg', '--no-notify', '--outlive-parent', '--keep', '--no-parent'];
    if (s.machine) a.push('--on', s.machine);
    if (folder) a.push('--cwd', folder);
    a.push('--label', `herdr.space=${s.id.split('/').at(-1)}`, '--label', `herdr.tab=${t.id.split('/').at(-1)}`);
    if (argv) a.push('--', ...(argv as string[]));
    const r = coreObject(await options.hc(a));
    try { return appId(r.address); } catch { throw new AppBoundaryError('invalid-core-reply', 'invalid core reply: missing launched address'); }
  };
  type Dispatch = { reply: Record<string, unknown>; settled?: Promise<void> };
  const dispatch = async (name: string, args: Record<string, unknown>): Promise<Dispatch> => {
    if (activeSpace) selections.set(activeSpace, { tab: activeTab, focus });
    if (name === 'space.select') {
      // window.rs selects an observed ID first, otherwise a one-based position.
      const s = typeof args.id === 'string' ? spaces.find(s => s.id === args.id) : spaces[(args.index as number) - 1];
      if (!s) throw new AppBoundaryError('unknown-id', 'no such space');
      const prior = selections.get(s.id), tab = s.tabs.find(t => t.id === prior?.tab) ?? s.tabs[0];
      activeSpace = s.id; activeTab = tab?.id ?? null;
      focus = tab?.terminals.find(p => p.pane === prior?.focus)?.pane ?? tab?.terminals[0]?.pane ?? modPanes.get(tab?.id ?? '')?.[0]?.pane ?? null;
      return { reply: { ok: true } };
    }
    if (name === 'ls') return { reply: await world() };
    if (name === 'status') return { reply: { layout, space: activeSpace, tab: activeTab, focused_pane: focus, agent: spaces.flatMap(s => s.tabs).flatMap(t => t.terminals).find(p => p.pane === focus)?.terminal ?? null, floats: [], overlays: [], errors: [...errors], zoom: 1, font_size: 14, ui_font_size: 14 } };
    if (name === 'space.new' || name === 'tab.new') {
      if (args.task) throw new AppBoundaryError('unsupported-capability', 'native task paste is forbidden in the fixture');
      if (args.mod && (name !== 'tab.new' || typeof args.mod !== 'string')) throw new AppBoundaryError('unsupported-capability', 'invalid mod tab');
      const machine = typeof args.machine === 'string' && args.machine ? args.machine : null;
      const s: Space | undefined = name === 'space.new'
        ? { id: fresh('sp', machine), name: String(args.name ?? '').trim(), folder: String(args.folder ?? ''), machine, active: false, tabs: [] }
        : spaces.find(s => s.id === (args.space ?? activeSpace));
      if (!s) throw new AppBoundaryError('unknown-id', 'no space for tab');
      const t: Tab = { id: fresh('tb', s.machine), name: String(name === 'space.new' ? args.tab ?? '' : args.name ?? '').trim(), active: true, settled: false, terminals: [] };
      if (typeof args.mod === 'string') {
        const pane = fresh('p', s.machine); modPanes.set(t.id, [{ pane, mod: args.mod }]); s.tabs.push(t);
        activeSpace = s.id; activeTab = t.id; focus = pane;
        return { reply: { space: s.id, tab: t.id, pane } };
      }
      const address = await launch(s, t, String(args.folder ?? s.folder), args.argv);
      t.terminals.push({ pane: fresh('p', s.machine), terminal: address }); s.tabs.push(t);
      if (name === 'space.new') spaces.push(s);
      activeSpace = s.id; activeTab = t.id; focus = t.terminals[0].pane;
      return { reply: { space: s.id, tab: t.id, terminal: address } };
    }
    if (name === 'tab.rename' || name === 'tab.close') {
      const t = tabOf(String(args.id ?? activeTab));
      if (!t) throw new AppBoundaryError('unknown-id', 'no tab with requested id');
      if (name === 'tab.rename') {
        if (typeof args.name !== 'string') throw new AppBoundaryError('missing-argument', 'tab.rename needs name');
        t.name = args.name.trim();
      } else {
        const s = spaceOf(t.id)!;
        if (s.tabs.length === 1 && args.confirmed !== true) throw new AppBoundaryError('confirmation-required', 'last tab close needs confirmed: true');
        for (const p of t.terminals) { await get(p.terminal); coreObject(await options.hc(['kill', p.terminal, '--json'])); }
        s.tabs = s.tabs.filter(v => v !== t); modPanes.delete(t.id); cleanEmpty();
      }
      return { reply: { ok: true } };
    }
    if (name === 'pane.close') {
      const id = String(args.pane ?? focus);
      for (const [tab, panes] of modPanes) {
        if (panes.some(pane => pane.pane === id)) {
          modPanes.set(tab, panes.filter(pane => pane.pane !== id)); cleanEmpty();
          return { reply: { ok: true } };
        }
      }
      const p = spaces.flatMap(s => s.tabs).flatMap(t => t.terminals).find(p => p.pane === (args.pane ?? focus));
      if (!p) throw new AppBoundaryError('unknown-id', 'no such pane');
      const tab = spaces.flatMap(s => s.tabs).find(tab => tab.terminals.includes(p))!;
      if (tab.terminals.length === 1) return dispatch('tab.close', { id: tab.id });
      await get(p.terminal);
      coreObject(await options.hc(['keep', p.terminal, '--off', '--json']));
      coreObject(await options.hc(['kill', p.terminal, '--json']));
      for (const tab of spaces.flatMap(s => s.tabs)) tab.terminals = tab.terminals.filter(other => other !== p);
      cleanEmpty();
      return { reply: { ok: true } };
    }
    if (name === 'terminal.peek') {
      await get(String(args.terminal));
      if (!paneOf(String(args.terminal))) throw new AppBoundaryError('unsupported-capability', 'unplaced terminal peek requires a native overlay');
      return dispatch('pane.focus', { terminal: args.terminal });
    }
    if (name === 'pane.focus') {
      const modTab = typeof args.pane === 'string' ? [...modPanes].find(([, panes]) => panes.some(pane => pane.pane === args.pane))?.[0] : undefined;
      if (modTab) { activeSpace = spaceOf(modTab)!.id; activeTab = modTab; focus = String(args.pane); return { reply: { ok: true } }; }
      const p = spaces.flatMap(s => s.tabs).flatMap(t => t.terminals).find(p => args.pane ? p.pane === args.pane : p.terminal === args.terminal);
      if (!p) throw new AppBoundaryError('unknown-id', 'no such pane');
      const s = spaces.find(s => s.tabs.some(t => t.terminals.includes(p)))!;
      activeSpace = s.id; activeTab = s.tabs.find(t => t.terminals.includes(p))!.id; focus = p.pane;
      return { reply: { ok: true } };
    }
    if (name === 'terminal.park' || name === 'terminal.keep') {
      const address = String(args.terminal), row = await get(address);
      const existing = paneOf(address);
      if (name === 'terminal.keep' && existing) { focus = existing.pane; return { reply: { pane: existing.pane } }; }
      const s = spaces.find(s => s.id === activeSpace);
      if (name === 'terminal.keep' && (!s || row.state !== 'live')) throw new AppBoundaryError('unknown-id', 'no running terminal or space to keep it in');
      if (name === 'terminal.keep' && (address.includes('/') ? address.split('/')[0] : null) !== s!.machine) throw new AppBoundaryError('wrong-machine', 'terminal pane must stay on its own machine');
      const t = ['right', 'down'].includes(String(args.place)) ? tabOf(activeTab ?? '') : undefined;
      const newTab = name === 'terminal.keep' ? { id: t?.id ?? fresh('tb', s!.machine), name: row.name ?? address, active: true, settled: false, terminals: [] } as Tab : undefined;
      const pane = name === 'terminal.keep' ? fresh('p', s!.machine) : undefined;
      const settled = (async () => {
        try {
          coreObject(await options.hc(['label', address, `herdr.space=${name === 'terminal.keep' ? s!.id.split('/').at(-1) : ''}`, `herdr.tab=${newTab?.id.split('/').at(-1) ?? ''}`, '--json']));
          coreObject(await options.hc(['keep', address, ...(name === 'terminal.park' ? ['--off'] : []), '--json']));
          if (name === 'terminal.park') {
            for (const tab of spaces.flatMap(s => s.tabs)) tab.terminals = tab.terminals.filter(p => p.terminal !== address);
            cleanEmpty();
          } else {
            const target = t ?? newTab!; target.terminals.push({ pane: pane!, terminal: address });
            if (!t) s!.tabs.push(target); activeTab = target.id; focus = pane!;
          }
        } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      })();
      return { reply: name === 'terminal.park' ? { pending: true, terminal: address } : { pending: true, terminal: address, pane: pane!, tab: newTab!.id }, settled };
    }
    if (name === 'layout.switch') {
      if (!options.readLayout || typeof args.name !== 'string') throw new AppBoundaryError('unsupported-capability', 'fixture needs a real layout file');
      layoutTree = await options.readLayout(args.name); layout = args.name;
      // App 0.1.11 load_layout publishes this exact name after loading, even on re-selection.
      if (options.selectLayout) await options.selectLayout(layout);
    } else if (name === 'layout.show' || name === 'layout.hide') {
      const n = node(String(args.id)); if (!n) throw new AppBoundaryError('unknown-id', 'no layout node'); n.hidden = name === 'layout.hide';
    } else if (name === 'layout.select') {
      const n = node(String(args.stack)); if (!n || !node(String(args.child), n)) throw new AppBoundaryError('unknown-id', 'no stack with requested child'); n.active = args.child;
    } else if (name === 'app.theme') {
      if (!options.selectTheme) throw new AppBoundaryError('unsupported-capability', 'fixture needs a real installed theme'); await options.selectTheme(String(args.name));
    } else throw new AppBoundaryError('unknown-command', `unimplemented command ${name}`);
    return { reply: { ok: true } };
  };
  return {
    command: (name, args) => {
      const result = queue.then(async () => {
        validateAppCommand(name, args);
        const out = await dispatch(name, args);
        const reply = parseAppReply(name, args, out.reply); options.record?.(name, args, reply);
        return { ...out, reply };
      });
      queue = result.then(out => out.settled).then(() => {}, () => {});
      return result.then(out => out.reply);
    },
    drain: () => queue,
  };
}
