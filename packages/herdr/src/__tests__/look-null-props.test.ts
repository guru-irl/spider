// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyLookPatches } from '../look/patches.js';
import patchSet from '../../assets/look/patches.json' with { type: 'json' };
import { createUiModules, createHostModule, initView } from './strict-mod-api.mjs';
import type { HerdrClones, LookPatchSet } from '../look/patches.js';

const present = Boolean(process.env.SPIDER_HERDR_MOD_FIXTURE);
const url = (text: string) => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
async function source(mod: 'agents' | 'spaces') {
  const clones = {} as HerdrClones;
  for (const name of ['agents', 'spaces', 'pane', 'tabs'] as const) {
    const root = join(process.env.SPIDER_HERDR_MOD_FIXTURE!, name);
    clones[name] = { name: `glass-${name}`, clonedFrom: { name, version: '0.1.11' }, files: { 'main.js': await readFile(join(root, 'main.js'), 'utf8'), 'mod.json': await readFile(join(root, 'mod.json'), 'utf8') } };
  }
  return (await applyLookPatches(clones, patchSet as LookPatchSet))[mod].files['main.js'];
}
function texts(value: any): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value?.items) ? value.items.flatMap(texts) : [];
}
async function load(mod: 'agents' | 'spaces', supplied: null | undefined | Record<string, unknown>) {
  const tasks: Promise<unknown>[] = [], calls: unknown[] = [];
  const palette = { chrome: '#161618', foreground: '#ffffff', muted: '#aaaaaa', dim: '#888888', hover: '#ffffff14', background: '#161618', popover: '#161618f0', border: '#222222', unknown: '#aaaaaa' };
  const ports = {
    props: () => supplied, agents: () => [], terminals: () => [], panes: () => [], spaces: () => [], machines: () => [], focused: () => null,
    shared: () => null, setShared: () => {}, setAgentOrder: () => {}, theme: () => palette, window: () => ({}), layout: () => ({ id: 'sidebar', size: { px: 268 } }),
    hc: async () => ({ code: 0, stdout: '{"machines":[]}', stderr: '' }),
    exec: async (...args: unknown[]) => { calls.push(args); throw new Error('Unexpected external execution'); },
    readTextFile: async () => { throw new Error('Unexpected file read'); }, watchFolder: async () => { throw new Error('Unexpected watcher'); },
    run: () => { throw new Error('Unexpected native action'); }, openOverlay: () => {}, closeOverlay: () => {},
  };
  const key = `look-null-props-${mod}-${Math.random()}`;
  const modules: Record<string, Record<string, unknown>> = { ...createUiModules(), herdr: createHostModule(ports) };
  (globalThis as Record<string, unknown>)[key] = modules;
  let code = await source(mod);
  for (const [name, exports] of Object.entries(modules)) {
    const module = `const h=globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}]; export const {${Object.keys(exports).join(',')}}=h;`;
    code = code.replace(new RegExp(`from ["']${name}["']`, 'g'), `from '${url(module)}'`);
  }
  code = code.replace('"./spider-children.js"', JSON.stringify(new URL('../../assets/agents/children.js', import.meta.url).href))
    .replace('"./shared/feed.js"', JSON.stringify(new URL('../../assets/shared/feed.js', import.meta.url).href));
  code = 'const localStorage = { getItem: () => null, setItem: () => {} };\n' + code;
  const cx: any = { notify() {}, timer: { every() {} }, spawn(fn: (cx: any) => unknown) { tasks.push(Promise.resolve().then(() => fn(cx))); } };
  try {
    const module = await import(url(code)); const view = new module.default();
    initView(view, cx); await Promise.all(tasks);
    return { text: texts(view.render(cx)), calls };
  } finally { delete (globalThis as Record<string, unknown>)[key]; }
}

test.skipIf(!present).each([null, undefined, {}])('standalone agents props %j render a clear unconfigured state without external work', async props => {
  const rendered = await load('agents', props);
  expect(rendered.text).toContain('Agents unavailable');
  expect(rendered.text).toContain('Open a configured workspace or run doctor.');
  expect(rendered.calls).toEqual([]);
});
test.skipIf(!present)('filter popup props without a root contract still render the selector', async () => {
  const rendered = await load('agents', { modId: 'glass-agents', filterMenu: 'machine', filterOptions: { machines: [], agents: [] } });
  expect(rendered.text).toContain('All machines');
  expect(rendered.text).not.toContain('Agents unavailable');
});
test.skipIf(!present)('native sort popup props without a root contract still render sorting choices', async () => {
  const rendered = await load('agents', { sortMenu: true });
  expect(rendered.text).toContain('Priority');
  expect(rendered.text).not.toContain('Agents unavailable');
});

test.skipIf(!present).each([null, undefined, {}])('standalone spaces props %j render a clear empty workspace', async props => {
  const rendered = await load('spaces', props);
  expect(rendered.text).toContain('Spaces');
  expect(rendered.text).not.toContain('SPACES');
  expect(rendered.text).toContain('No spaces yet');
  expect(rendered.calls).toEqual([]);
});
