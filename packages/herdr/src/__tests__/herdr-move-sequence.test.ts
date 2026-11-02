// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';

async function engine(): Promise<any> {
  const url = new URL('../../assets/agents/move.js', import.meta.url).href;
  try { return await import(url); } catch { return {}; }
}

type Placement = { space: string; tab: string; pane: string };
function fake(initial: Placement | null) {
  const layout = new Map<string, Placement>([['anchor', { space: 's1', tab: 'target', pane: 'p-target' }]]);
  if (initial) layout.set('moving', initial);
  let focused = initial?.pane ?? 'p-target', tick = 0, pending: (() => void) | null = null;
  const history: string[] = [], changes: (Placement | null)[] = [];
  return {
    layout, history, changes,
    get focused() { return focused; },
    ports: {
      placement: async (address: string) => layout.get(address) ?? null,
      targetPane: async (tab: string) => [...layout.values()].find(p => p.tab === tab)?.pane ?? null,
      now: () => tick,
      sleep: async () => { tick += 100; if (pending) { const commit = pending; pending = null; commit(); } },
      changed: async (placement: Placement | null) => { changes.push(placement); },
      run: async (name: string, args: any) => {
        history.push(name);
        if (name === 'terminal.park') {
          if (!layout.has(args.terminal)) throw new Error('Already parked');
          pending = () => { layout.delete(args.terminal); };
        } else if (name === 'pane.focus') {
          const place = args.pane ? [...layout.values()].find(p => p.pane === args.pane) : layout.get(args.terminal);
          if (!place) throw new Error('No such pane');
          focused = place.pane;
        } else if (name === 'terminal.keep') {
          if (layout.has(args.terminal)) throw new Error('Terminal is not parked yet');
          const anchor = [...layout.values()].find(p => p.pane === focused);
          if (!anchor) throw new Error('No focused pane');
          const placement = args.place === 'tab' ? { space: anchor.space, tab: 'new', pane: 'p-new' } : { space: anchor.space, tab: anchor.tab, pane: 'p-moved' };
          pending = () => { layout.set(args.terminal, placement); };
        } else throw new Error(`Unknown command ${name}`);
      },
    },
  };
}

it('waits for parking and moves a terminal into a chosen tab, then focuses it', async () => {
  const { moveTerminal } = await engine();
  expect(moveTerminal).toBeTypeOf('function');
  const f = fake({ space: 's1', tab: 'source', pane: 'p-source' });
  await moveTerminal('moving', { kind: 'tab', tab: 'target' }, f.ports);
  expect(f.layout.get('moving')).toEqual({ space: 's1', tab: 'target', pane: 'p-moved' });
  expect(f.focused).toBe('p-moved');
  expect(f.history).toEqual(['terminal.park', 'pane.focus', 'terminal.keep', 'pane.focus']);
  expect(f.changes).toEqual([null, { space: 's1', tab: 'target', pane: 'p-moved' }]);
});

it('opens an already parked terminal in a new tab without parking it again', async () => {
  const { moveTerminal } = await engine();
  expect(moveTerminal).toBeTypeOf('function');
  const f = fake(null);
  await moveTerminal('moving', { kind: 'new' }, f.ports);
  expect(f.layout.get('moving')).toEqual({ space: 's1', tab: 'new', pane: 'p-new' });
  expect(f.focused).toBe('p-new');
  expect(f.history).toEqual(['terminal.keep', 'pane.focus']);
  expect(f.changes).toEqual([{ space: 's1', tab: 'new', pane: 'p-new' }]);
});

it('re-adopts a parked parentless terminal by its destination labels', async () => {
  const { moveTerminal } = await engine();
  const f = fake({ space: 's1', tab: 'source', pane: 'p-source' });
  const ports = { ...f.ports, adopt: async (terminal: string, dest: { space: string; tab: string }) => {
    if (f.layout.has(terminal)) throw new Error('Terminal is not parked yet');
    f.history.push('hc.label');
    f.layout.set(terminal, { ...dest, pane: 'p-moved' });
  } };
  await moveTerminal('moving', { kind: 'tab', tab: 'target', space: 's1' }, ports);
  expect(f.layout.get('moving')).toEqual({ space: 's1', tab: 'target', pane: 'p-moved' });
  expect(f.focused).toBe('p-moved');
  expect(f.history).toEqual(['terminal.park', 'hc.label', 'pane.focus']);
});

it('creates a temporary mod tab before parking and removes only that mod pane', async () => {
  const { moveTerminal } = await engine();
  const f = fake({ space: 's1', tab: 'source', pane: 'p-source' });
  const ports = { ...f.ports,
    createTab: async (space: string) => {
      f.history.push('tab.new');
      f.layout.set('placeholder', { space, tab: 'new', pane: 'p-placeholder' });
      return { space, tab: 'new', pane: 'p-placeholder' };
    },
    adopt: async (terminal: string, dest: { space: string; tab: string }) => {
      if (f.layout.has(terminal)) throw new Error('Terminal is not parked yet');
      f.history.push('hc.label'); f.layout.set(terminal, { ...dest, pane: 'p-new' });
    },
    run: async (name: string, args: any) => {
      if (name === 'pane.close') { f.history.push(name); expect(args.pane).toBe('p-placeholder'); f.layout.delete('placeholder'); return; }
      return f.ports.run(name, args);
    },
  };
  await moveTerminal('moving', { kind: 'new', space: 's1' }, ports);
  expect(f.layout.get('moving')).toEqual({ space: 's1', tab: 'new', pane: 'p-new' });
  expect(f.layout.has('placeholder')).toBe(false);
  expect(f.focused).toBe('p-new');
  expect(f.history).toEqual(['tab.new', 'terminal.park', 'hc.label', 'pane.close', 'pane.focus']);
});

it('removes the temporary mod tab when parking is refused', async () => {
  const { moveTerminal } = await engine();
  const f = fake({ space: 's1', tab: 'source', pane: 'p-source' });
  const ports = { ...f.ports,
    createTab: async (space: string) => { f.layout.set('placeholder', { space, tab: 'new', pane: 'p-placeholder' }); return { space, tab: 'new', pane: 'p-placeholder' }; },
    adopt: async () => { throw new Error('Must not adopt'); },
    run: async (name: string, args: any) => {
      if (name === 'terminal.park') return { error: { message: 'Park refused' } };
      if (name === 'pane.close') { expect(args.pane).toBe('p-placeholder'); f.layout.delete('placeholder'); return; }
      return f.ports.run(name, args);
    },
  };
  await expect(moveTerminal('moving', { kind: 'new', space: 's1' }, ports)).rejects.toThrow('Park refused');
  expect(f.layout.has('placeholder')).toBe(false);
  expect(f.layout.get('moving')).toMatchObject({ tab: 'source', pane: 'p-source' });
});

it('restores a parked terminal to its original tab if destination adoption fails', async () => {
  const { moveTerminal } = await engine();
  const f = fake({ space: 's1', tab: 'source', pane: 'p-source' });
  const ports = { ...f.ports, adopt: async (terminal: string, dest: { space: string; tab: string }) => {
    if (dest.tab === 'target') throw new Error('Target unavailable');
    f.layout.set(terminal, { ...dest, pane: 'p-restored' });
  } };
  await expect(moveTerminal('moving', { kind: 'tab', tab: 'target', space: 's1' }, ports)).rejects.toThrow('Target unavailable');
  expect(f.layout.get('moving')).toEqual({ space: 's1', tab: 'source', pane: 'p-restored' });
  expect(f.focused).toBe('p-restored');
  expect(f.changes).toEqual([null, { space: 's1', tab: 'source', pane: 'p-restored' }]);
});
