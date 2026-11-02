// SPDX-License-Identifier: MIT
import { expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import shippedPatches from '../../assets/look/patches.json' with { type: 'json' };
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';
import * as children from '../../assets/agents/children.js';
import * as sharedFeed from '../../assets/shared/feed.js';
import { HerdrLabelContract } from '../contracts.js';
import type { SessionFeed } from '../contracts.js';
import { runPanelScene } from './acceptance/i.js';

export const panelFeed = (id = 'planner'): SessionFeed => ({
  version: 1, sessionId: id as never, generation: 'generation' as never, revision: 1, updatedAt: Date.now(),
  owner: { sessionId: id as never, generation: 'generation' as never,
    terminal: { coreId: 'core' as never, terminalId: 't1' as never, address: 't1' as never, socket: '/fixture/core.sock', sessionNamespace: 'fixture' },
    cwd: '/fixture', sessionFile: null, name: id },
  placement: null, lifecycle: 'live', status: { native: 'blocked', effective: 'blocked', message: 'Approve?' },
  runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
  pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'No counters' },
  approvals: [], notifications: [], ipc: { address: '/fixture/ipc', capabilityFile: '/fixture/capability' }, errors: [],
});

test('an unplaced session and its waiting item stay visible in each active space', async () => {
  const result = await runPanelScene<{ sessions: string[][]; waiting: string[][] }>(`
    const a=JSON.parse(files[0]);a.updatedAt=Date.now();files[0]=JSON.stringify(a);
    const b=JSON.parse(files[0]);b.sessionId=b.owner.sessionId='reviewer';b.owner.name='reviewer';
    b.placement={spaceId:'other',spaceName:'other',spaceOrder:0,tabId:null};files.push(JSON.stringify(b));
    let active='one';api.spaces=()=>[{id:active,active:true}];initView(panel,cx);await tasks[0];
    const sessions=[],waiting=[];
    for(const space of ['one','two']) {active=space;const tree=panel.render(cx);
      sessions.push(texts(byId(tree,'spider-sessions')));waiting.push(texts(byId(tree,'spider-notifications')));}
    panel.close();console.log(JSON.stringify({sessions,waiting}));`, panelFeed());
  expect(result.sessions).toEqual([['Sessions', 'Credits', 'planner', '\u2013'], ['Sessions', 'Credits', 'planner', '\u2013']]);
  expect(result.waiting).toEqual([['!', 'planner', 'is waiting'], ['!', 'planner', 'is waiting']]);
});


test('a failed panel watch polls at a bounded cadence, re-arms and resumes event-driven updates', async () => {
  const result = await runPanelScene<{ reloads: number[]; watches: string[]; waiting: string[]; state: string }>(`
    let now=100000;Date.now=()=>now;const reloads=[],watches=[];let wake;
    api.watchFolder=path=>{watches.push(path);if(watches.length<3)return Promise.reject(new Error('watch unavailable'));return new Promise(resolve=>{wake=resolve;});};
    api.exec=async()=>{reloads.push(now);return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};};
    const heartbeat=()=>{const a=JSON.parse(files[0]);a.updatedAt=now;files[0]=JSON.stringify(a);};heartbeat();
    initView(panel,cx);await tasks[0];await drain();
    for(let i=0;i<8;i++){now+=2000;heartbeat();timers[0].f(cx);await drain();}
    now+=2000;heartbeat();wake?.();for(let i=0;i<30;i++)await Promise.resolve();
    timers[0].f(cx);await drain();const tree=panel.render(cx);
    const head=byId(tree,'session-head-planner');const state=head.items[1].styles.tooltip[0];
    panel.close();console.log(JSON.stringify({reloads,watches,waiting:texts(byId(tree,'spider-notifications')),state}));`, panelFeed());
  expect(result.reloads).toEqual([100000, 100000, 108000, 116000, 118000]);
  expect(result.watches).toEqual(Array(4).fill('/fixture/feeds/sessions'));
  expect(result.waiting).toEqual(['!', 'planner', 'is waiting']);
  expect(result.state).toBe('planner');
});


test.skipIf(!process.env.SPIDER_HERDR_MOD_FIXTURE)('the production sidebar re-arms a failed watch after its bounded fallback and receives later events', async () => {
  const clones = {} as HerdrClones;
  for (const name of ['agents', 'spaces', 'pane', 'tabs'] as const) clones[name] = { name: `spider-${name}`, clonedFrom: { name, version: '0.1.11' }, files: {
    'main.js': await readFile(join(process.env.SPIDER_HERDR_MOD_FIXTURE!, name, 'main.js'), 'utf8'),
    'mod.json': await readFile(join(process.env.SPIDER_HERDR_MOD_FIXTURE!, name, 'mod.json'), 'utf8'),
  } };
  const patched = await applyLookPatches(clones, shippedPatches as LookPatchSet);
  let now = 10000, revision = 1, wake: (() => void) | undefined;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const listings: number[] = [], watched: string[] = [], timers: { ms: number; tick(cx: unknown): void }[] = [];
  const ports = { ...children, ...sharedFeed, View: class {},
    props: () => ({ labelContract: HerdrLabelContract, feedRoot: '/fixture/feeds', nodePath: '/fixture/node' }),
    readTextFile: async () => JSON.stringify({ ...panelFeed(), revision }),
    exec: async () => { listings.push(now); return { code: 0, stdout: '["planner"]' }; },
    watchFolder: (path: string) => { watched.push(path); return watched.length === 1 ? Promise.reject(new Error('ENOENT')) : new Promise<void>(resolve => { wake = resolve; }); },
    localStorage: { getItem: () => null, setItem() {} },
  };
  const code = patched.agents.files['main.js'].replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)?import .*;\s*$/gm, '').replace('export default class ', 'class ').replaceAll('export function ', 'function ');
  const name = /class (\w+) extends View/.exec(code)![1];
  const Agents = new Function('ports', `const { ${Object.keys(ports).join(', ')} } = ports; ${code}; return ${name};`)(ports);
  const cx: any = { notify() {}, spawn: (fn: (cx: any) => Promise<unknown>) => fn(cx), timer: { every: (ms: number, tick: (cx: unknown) => void) => timers.push({ ms, tick }) } };
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  try {
    const view = new Agents(); view.init({}, cx); await settle();
    for (let i = 0; i < 6; i++) { now += 5000; revision++; timers.filter(t => t.ms === 5000).forEach(t => t.tick(cx)); await settle(); }
    now += 5000; revision++; wake?.(); await settle(); timers.filter(t => t.ms === 5000).forEach(t => t.tick(cx)); await settle();
    expect(listings).toEqual([10000, 40000, 45000]);
    expect(watched).toEqual(Array(3).fill('/fixture/feeds/sessions'));
    expect(view.spiderFeeds[0].revision).toBe(8);
    expect(view.spiderFeedError).toBeNull();
  } finally { clock.mockRestore(); }
});


test('short reconnects raise no machine problem; a disconnected state must persist for ten seconds', async () => {
  const result = await runPanelScene<{ rows: string[][]; configReads: number }>(`
    let now=100000,state='connecting',configReads=0;Date.now=()=>now;
    props.machines=[{name:'build.invalid'}];api.readTextFile=async()=>{configReads++;return JSON.stringify({machines:props.machines});};
    api.hc=async()=>({code:0,stdout:JSON.stringify({machines:[{name:'build.invalid',state}]}),stderr:''});
    const a=JSON.parse(files[0]);a.updatedAt=now;a.status={native:'idle',effective:'idle',message:null};files[0]=JSON.stringify(a);
    initView(panel,cx);await tasks[0];const rows=[];
    for(const [at,next] of [[0,'connecting'],[4000,'connected'],[6000,'disconnected'],[10000,'disconnected'],[16000,'disconnected'],[20000,'connected']]){
      now=100000+at;state=next;await panel.refreshMachines(cx);rows.push(texts(byId(panel.render(cx),'spider-notifications')));}
    panel.close();console.log(JSON.stringify({rows,configReads}));`, panelFeed());
  expect(result.rows).toEqual([[], [], [], [], ['!', 'build.invalid', 'disconnected'], []]);
  expect(result.configReads).toBe(0);
});

test('hidden panels and inactive stack children never poll machines; the visible panel uses installed machine props', async () => {
  const result = await runPanelScene<{ calls: number[]; configReads: number }>(`
    let now=100000,hidden=true,active='other',configReads=0;Date.now=()=>now;const calls=[];
    props.machines=[{name:'build.invalid'}];api.readTextFile=async()=>{configReads++;return JSON.stringify({machines:props.machines});};
    api.hc=async()=>{calls.push(now);return {code:0,stdout:JSON.stringify({machines:[{name:'build.invalid',state:'connected'}]}),stderr:''};};
    api.layout=()=>({children:[{id:'panel',hidden,children:[{type:'stack',active,children:[{id:'other',content:{mod:'files'}},{id:'spider',content:{mod:props.modId}}]}]}]});
    const a=JSON.parse(files[0]);a.updatedAt=now;files[0]=JSON.stringify(a);initView(panel,cx);await tasks[0];
    for(let i=1;i<=30;i++){now=100000+i*2000;if(i===11)hidden=false;if(i===16)active='spider';if(i===26)hidden=true;timers[0].f(cx);await drain();}
    panel.close();console.log(JSON.stringify({calls,configReads}));`, panelFeed());
  expect(result.calls).toEqual([140000, 150000]);
  expect(result.configReads).toBe(0);
});
