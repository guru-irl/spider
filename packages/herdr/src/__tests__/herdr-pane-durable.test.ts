// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import patches from '../../assets/look/patches.json' with { type: 'json' };
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';
import * as sharedFeed from '../../assets/shared/feed.js';

// A real patched mod with a small element recorder, not a second close implementation.
async function paneScene(pane: Record<string, unknown>, labels = {}, command?: string) {
  const clones = {} as HerdrClones;
  for (const name of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) clones[name] = {
    name: `spider-${name}`, clonedFrom: { name, version: '0.1.12' }, files: {
      'main.js': await readFile(join(process.env.SPIDER_HERDR_MOD_FIXTURE!, name, 'main.js'), 'utf8'),
    },
  };
  const result = await applyLookPatches(clones, patches as LookPatchSet);
  const calls: unknown[] = [], overlays: unknown[] = [];
  let dispatch: ((command: string) => void) | undefined;
  const nodes: any[] = [];
  const element = () => {
    const node: any = { click: undefined };
    const proxy: any = new Proxy(node, { get(target, key) {
      if (key in target) return target[key];
      return (...args: any[]) => {
        if (key === 'id') target.id = args[0];
        if (key === 'on_click') target.click = args[0];
        if (key === 'when' && args[0]) args[1](proxy);
        return proxy;
      };
    } });
    nodes.push(node); return proxy;
  };
  const ports = { ...sharedFeed, View: class {}, div: element, svg: element, image: element, h_flex: element,
    panes: () => [pane], props: () => ({ pane: 'p1', terminal: 't1' }),
    terminals: () => [{ address: 't1', labels }], home: () => '/home/fixture', theme: () => ({}),
    run: (name: string, args: unknown) => calls.push({ name, args }),
    openOverlay: (spec: unknown) => overlays.push(spec),
    nextCommand: () => new Promise<string>(resolve => { dispatch = resolve; }),
  };
  const source = result.pane.files['main.js'].replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)?import .*;\s*$/gm, '').replace('export default class ', 'class ');
  const Pane = new Function('ports', `const {${Object.keys(ports).join(',')}}=ports;${source};return Pane;`)(ports);
  const view = new Pane(); view.init({}, { spawn: (fn: Function) => { void fn({ notify() {} }); } }); view.hovered = true; view.render({});
  if (command) { dispatch?.(command); await new Promise(resolve => setImmediate(resolve)); }
  else nodes.find(n => n.id === 'ph-x-p1')!.click({}, { stop_propagation() {} });
  return { calls, overlays };
}

test.each([
  { app: 'pi', program: { key: 'pi', agent: true, name: 'Pi' } },
  { app: null, program: { key: 'pi', agent: true, name: 'Pi' } },
])('the close button asks before closing a pi session (%j)', async fields => {
  const result = await paneScene({ pane: 'p1', terminal: 't1', ...fields });
  expect(result.calls).toEqual([]);
  expect(result.overlays).toEqual([{ mod: 'confirm', kind: 'dialog', width: 420, height: 190, props: {
    title: 'Close this session?', detail: 'This ends the pi session. Its subagents keep running. Resume the same session to reconnect.',
    command: { name: 'pane.close', args: { pane: 'p1' } },
  } }]);
});

test('closing an ordinary shell or mod pane still removes that pane', async () => {
  expect(await paneScene({ pane: 'p1', terminal: 't1', program: { key: 'shell', shell: true } })).toEqual({ calls: [
    { name: 'pane.close', args: { pane: 'p1' } },
  ], overlays: [] });
  expect(await paneScene({ pane: 'p1', terminal: null, mod: 'files' })).toEqual({ calls: [
    { name: 'pane.close', args: { pane: 'p1' } },
  ], overlays: [] });
});

test('a spider session label protects the session before pi reports its program', async () => {
  const result = await paneScene({ pane: 'p1', terminal: 't1', program: { key: 'shell', shell: true } }, { 'spider.session': 'planner', 'spider.kind': 'session' });
  expect(result.calls).toEqual([]);
  expect(result.overlays).toHaveLength(1);
});

test.each([false, true])('the spider-controlled close command asks only in the focused session header (focused=%s)', async focused => {
  const result = await paneScene({ pane: 'p1', terminal: 't1', app: 'pi', focused }, {}, 'close');
  expect(result.calls).toEqual([]);
  expect(result.overlays).toHaveLength(focused ? 1 : 0);
});
