// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, test } from 'vitest';
import { createHerdrHarness } from './testutil.js';
import { acceptanceI, runPanelScene } from './acceptance/i.js';
import { parseFeed } from '../../assets/shared/feed.js';
import type { SessionFeed, HerdrNotification } from '../contracts.js';
import { selectPanelNotifications, createNotificationTracker, dispatchPanelNotification, createPanelNotifications, type NativePanelNotice } from '../../assets/mods/spider/notifications.js';

// Complete canonical external feed fixtures; no live database is opened.
function crossingFeed(id: string, period = 0, threshold = '80'): SessionFeed {
  const f = parseFeed(JSON.stringify({
    version: 1, sessionId: id, generation: 'generation', revision: 1, updatedAt: 1000,
    owner: { sessionId: id, generation: 'generation', terminal: { coreId: 'core', terminalId: id, address: id, socket: '/fixture/socket', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: id },
    placement: null, lifecycle: 'live', status: { native: 'idle', effective: 'idle', message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: 80, budget: 100, projected: 110, remaining: 20, periodStart: period, periodEnd: period+100000, updatedAt: 1000, unavailableReason: null },
    approvals: [], notifications: [{ id: `budget:${period}:${threshold}`, kind: 'budget', createdAt: 1000, scope: 'shared', sessionId: null, ownerAddress: null,
      title: 'Budget warning', body: 'Shared credit pace', action: { kind: 'open-usage', scope: 'shared' } }],
    ipc: { address: `/fixture/${id}.sock`, capabilityFile: `/fixture/${id}.cap` }, errors: [],
  }));
  if (!f) throw new Error('Invalid canonical feed fixture');
  return f;
}

function sessionNotice(feed: SessionFeed, kind: Exclude<HerdrNotification['kind'], 'budget'>, id: string, createdAt: number): HerdrNotification {
  return {id,kind,createdAt,scope:'session',sessionId:feed.sessionId,ownerAddress:feed.owner.terminal.address,title:kind,body:'Committed event',
    action:{kind:'focus-owner',sessionId:feed.sessionId,address:feed.owner.terminal.address}};
}

describe('Panel notifications', () => {
  test('seen history expires session IDs but retains budget IDs beyond one billing month', () => {
    const now = 40 * 86400000;
    let persisted: unknown = [['event:old', 0], ['budget:0:80', 0]];
    const tracker = createNotificationTracker({ read: () => persisted, write: ids => { persisted = ids; }, notify: () => {} });
    tracker.update([], now);
    expect(persisted).toEqual([['budget:0:80', 0]]);
  });
  test('persisted seen history is capped even when more than two thousand notices arrive', () => {
    let persisted: unknown = [];
    const f = crossingFeed('owner');
    f.notifications = Array.from({ length: 2200 }, (_, i) => sessionNotice(f, 'job-result', `event:${i}`, 1000));
    const tracker = createNotificationTracker({ read: () => persisted, write: ids => { persisted = ids; }, notify: () => {} });
    tracker.update([f], 1000);
    expect((persisted as unknown[]).length).toBeLessThanOrEqual(2048);
  });
  test('a resumed owner at a different terminal cannot focus the recorded stale address', async () => {
    const f = crossingFeed('owner'), notice = sessionNotice(f, 'job-result', 'event:one', 1000);
    f.owner.terminal.address = 'new-address' as SessionFeed['owner']['terminal']['address'];
    const focused: string[] = [];
    expect(await dispatchPanelNotification(notice, [f], { ping: async () => true, openUsage: async () => {}, focus: async address => { focused.push(address); } }, 1000)).toEqual({ ok: false, reason: 'Owner unavailable' });
    expect(focused).toEqual([]);
  });
  test('closing during a shared endpoint ping neither posts nor marks the notice seen', async () => {
    const f = crossingFeed('owner'), posts: NativePanelNotice[] = [], tasks: Promise<void>[] = [];
    let persisted: unknown = [], release!: (value: boolean) => void;
    const ping = new Promise<boolean>(resolve => { release = resolve; });
    const panel = createPanelNotifications('copy', { read: () => persisted, write: (_key, ids) => { persisted = ids; }, clock: () => 1000, feeds: () => [f],
      schedule: work => { tasks.push(work()); }, post: n => posts.push(n), ping: () => ping, openUsage: async () => {}, focus: async () => {} });
    panel.update([f], 1000); panel.close(); release(true); await Promise.all(tasks);
    expect(posts).toEqual([]);
    expect(persisted).toEqual([]);
  });
  test('the command notice map expires old actions while keeping a current action usable', async () => {
    let now = 1000;
    const f = crossingFeed('owner'); f.notifications = [sessionNotice(f, 'job-result', 'event:old', now)];
    const tasks: Promise<void>[] = [];
    const panel = createPanelNotifications('copy', { read: () => [], write: () => {}, clock: () => now, feeds: () => [f],
      schedule: work => { tasks.push(work()); }, post: () => {}, ping: async () => true, openUsage: async () => {}, focus: async () => {} });
    panel.update([f], now); await Promise.all(tasks);
    expect(await panel.command('notice-event%3Aold')).toEqual({ ok: true });
    now += 8 * 86400000; f.updatedAt = now; f.notifications = [sessionNotice(f, 'job-result', 'event:new', now)];
    panel.update([f], now); await Promise.all(tasks);
    expect(await panel.command('notice-event%3Aold')).toEqual({ ok: false, reason: 'Unknown notification' });
    expect(await panel.command('notice-event%3Anew')).toEqual({ ok: true });
  });
  test('a feed discovered after an empty startup snapshot does not replay its old history', () => {
    let persisted: unknown;const delivered: string[]=[];
    const tracker=createNotificationTracker({read:()=>persisted,write:ids=>{persisted=ids;},notify:n=>{delivered.push(n.id);}});
    tracker.update([],2000);
    const late=crossingFeed('late');late.updatedAt=2500;
    tracker.update([late],2500);expect(delivered).toEqual([]);
    late.notifications.push({...late.notifications[0],id:'budget:0:100',createdAt:3000});late.updatedAt=3000;
    tracker.update([late],3000);expect(delivered).toEqual(['budget:0:100']);
    expect(persisted).toEqual([['budget:0:80',2500],['budget:0:100',3000]]);
  });
  test('installed mod persists new shared notices and routes their clicks through packaged IPC', async () => {
    const output=await runPanelScene<{posts:NativePanelNotice[];requests:{op:string;view?:string}[];commands:unknown[];seen:[string, number][]}>(`
      const f=JSON.parse(files[0]);f.updatedAt=Date.now();f.notifications[0].createdAt=f.updatedAt-1;files[0]=JSON.stringify(f);
      let deliver;api.nextCommand=()=>new Promise(resolve=>{deliver=resolve;});const requests=[];let usageOpened;const completion=new Promise(resolve=>{usageOpened=resolve;});
      api.exec=async(command,args)=>{if(args[1]==='ipc'){const request=JSON.parse(args[5]);requests.push(request);if(request.op==='openView')usageOpened();return {code:0,stdout:JSON.stringify(request.op==='ping'?{ok:true,op:'ping',status:{native:'idle',effective:'idle'}}:{ok:true,op:'openView'}),stderr:''};}return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};};
      initView(panel,cx);await tasks[0];f.notifications.push({...f.notifications[0],id:'budget:0:100',createdAt:Date.now()});f.updatedAt=Date.now();files[0]=JSON.stringify(f);
      await panel.reload(cx);await drain();
      if(notifications.length){deliver('notice-budget%3A0%3A100');await completion;}
      console.log(JSON.stringify({posts:notifications,requests,commands,seen:persisted.get('spider.notifications/spider-test')}));`,crossingFeed('owner'));
    expect(output.posts).toMatchObject([{action:{name:'spider-test.notice-budget%3A0%3A100'}}]);
    expect(output.requests.map(request=>[request.op,request.view])).toEqual([['ping',undefined],['ping',undefined],['openView','usage']]);
    expect(output.commands).toEqual([]);expect(output.seen).toEqual([['budget:0:80',expect.any(Number)],['budget:0:100',expect.any(Number)]]);
  });
  test('installed mod with no modId reports unavailable notifications without persisting or routing', async () => {
    const output=await runPanelScene<{text:string[];writes:unknown[];routed:boolean}>(`delete props.modId;const writes=[];api.setShared=(...args)=>writes.push(args);
      initView(panel,cx);await tasks[0];console.log(JSON.stringify({text:texts(panel.render(cx)),writes,routed:Boolean(panel.commandTask)}));`,crossingFeed('owner'));
    expect(output.text.join(' ')).toContain("Spider can't post Herdr notices.");expect(output.writes).toEqual([]);expect(output.routed).toBe(false);
  });
  test('shared fake panel acceptance cleans every owned resource', async () => {
    const h=await createHerdrHarness('fake');
    try {await h.start();await acceptanceI(h);} finally {await h.close();}
    expect(await h.remainingOwnedResources()).toEqual([]);
  });
  test.skipIf(process.env.SPIDER_HERDR_E2E !== '1')('isolated hc panel acceptance requires SPIDER_HERDR_E2E=1 and opens no app', async () => {
    const h=await createHerdrHarness('hc');
    try {await h.start();await acceptanceI(h);} finally {await h.close();}
    expect(await h.remainingOwnedResources()).toEqual([]);
  });
  test.skipIf(process.env.SPIDER_HERDR_APP_TESTS !== '1' || process.env.SPIDER_HERDR_APP_E2E !== '1' || process.env.SPIDER_HERDR_E2E !== '1')('fenced app panel rendering requires SPIDER_HERDR_APP_TESTS=1 and composed dependencies', async () => {
    const h=await createHerdrHarness('app');
    try {await h.start();await acceptanceI(h);} finally {await h.close();}
  });
  test('native shared toasts route by validated mod copy and disable an unverified endpoint', async () => {
    const f=crossingFeed('owner'), feeds=[f], persisted=new Map<string,unknown>(), posts: NativePanelNotice[]=[], pending: Promise<void>[]=[], focused: string[]=[], opened: string[]=[];
    let live=true;
    const panel=createPanelNotifications('spider-copy',{read:key=>persisted.get(key),write:(key,ids)=>persisted.set(key,ids),feeds:()=>feeds,clock:()=>2000,
      schedule:work=>{pending.push(work());},post:n=>posts.push(n),ping:async()=>live,openUsage:async feed=>{opened.push(feed.sessionId);},focus:async address=>{focused.push(address);}});
    panel.update(feeds,1000);
    f.notifications.push({...f.notifications[0],id:'budget:0:100',createdAt:2000});f.updatedAt=2000;
    panel.update(feeds,2000);await Promise.all(pending);
    expect(posts).toMatchObject([{action:{name:'spider-copy.notice-budget%3A0%3A100'}}]);
    expect(await panel.command('notice-budget%3A0%3A100')).toEqual({ok:true});expect(opened).toEqual(['owner']);expect(focused).toEqual([]);
    live=false;f.notifications.push({...f.notifications[0],id:'budget:0:projected',createdAt:2000});panel.update(feeds,2000);await Promise.all(pending);
    expect(posts[1].action).toBeUndefined();expect(posts[1].body).toContain('Action unavailable');
    expect(persisted.get('spider.notifications/spider-copy')).toEqual([['budget:0:80',1000],['budget:0:100',2000],['budget:0:projected',2000]]);
  });
  test('invalid mod identity starts no persistence or notification routing', () => {
    const called:string[]=[],ports={read:()=>{called.push('read');return null;},write:()=>{called.push('write');},feeds:()=>[],clock:()=>1000,schedule:()=>{called.push('schedule');},post:()=>{called.push('post');},ping:async()=>false,openUsage:async()=>{},focus:async()=>{}};
    for(const id of [undefined,'','../spider','spider.notice'])expect(()=>createPanelNotifications(id,ports)).toThrow('modId');
    expect(called).toEqual([]);
  });
  test('selection preserves the canonical notification wire shape even when an owner closes', () => {
    const closed=crossingFeed('closed');closed.lifecycle='closed';
    const selected=selectPanelNotifications([closed],new Set(),1000);
    expect(parseFeed(JSON.stringify({...closed,notifications:selected}))).not.toBeNull();
  });
  test('deduplicated result and escalation clicks focus only their recorded owner', async () => {
    const owner=crossingFeed('owner'), other=crossingFeed('other');
    owner.notifications=(['subagent-result','escalation','job-result'] as const).map(kind=>sessionNotice(owner,kind,`event:${kind}`,1000));
    owner.notifications.push(owner.notifications[0]);
    const focused:string[]=[], selected=selectPanelNotifications([owner,other],new Set(['budget:0:80']),1000);
    expect(selected.map(n=>n.id)).toEqual(['event:escalation','event:job-result','event:subagent-result']);
    for(const n of selected)expect(await dispatchPanelNotification(n,[owner,other],{focus:async address=>{focused.push(address);},ping:async()=>false,openUsage:async()=>{throw new Error('Not usage');}},1000)).toEqual({ok:true});
    expect(focused).toEqual(['owner','owner','owner']);
  });
  test('shared usage actions verify a live endpoint and never focus a pane', async () => {
    const a=crossingFeed('a'), b=crossingFeed('b'), opened: string[]=[], focused: string[]=[], pinged: string[]=[];
    const ports={ping:async (f: SessionFeed)=>{pinged.push(f.sessionId);return f.sessionId==='b';},openUsage:async (f: SessionFeed)=>{opened.push(f.sessionId);},focus:async (address:string)=>{focused.push(address);}};
    const selected=selectPanelNotifications([a,b],new Set(),1000);
    expect(await dispatchPanelNotification(selected[0],[a,b],ports,1000)).toEqual({ok:true});
    expect(pinged).toEqual(['a','b']);expect(opened).toEqual(['b']);expect(focused).toEqual([]);
  });
  test('shared usage failures do not fall back to pane focus', async () => {
    const a=crossingFeed('a'), focused: string[]=[];
    const selected=selectPanelNotifications([a],new Set(),1000);
    const result=await dispatchPanelNotification(selected[0],[a],{ping:async()=>true,openUsage:async()=>{throw new Error('View unavailable');},focus:async address=>{focused.push(address);}},1000);
    expect(result).toEqual({ok:false,reason:'View unavailable'});expect(focused).toEqual([]);
  });
  test('seeds startup history and persists duplicate run events across reload per mod copy', () => {
    const persisted = new Map<string, unknown>(), delivered: string[]=[];
    const tracker = (key: string) => createNotificationTracker({read:()=>persisted.get(key),write:ids=>persisted.set(key,ids),notify:n=>{delivered.push(n.id);}});
    const first = tracker('copy-a'), initial=crossingFeed('initial');
    first.update([initial],1000);expect(delivered).toEqual([]);
    const result=sessionNotice(initial,'subagent-result','run:done',2000);
    initial.notifications.push(result,result);initial.updatedAt=2000;
    first.update([initial],2000);expect(delivered).toEqual(['run:done']);
    tracker('copy-a').update([initial],2000);expect(delivered).toEqual(['run:done']);
    tracker('copy-b').update([initial],2000);expect(delivered).toEqual(['run:done']);
    expect(persisted.get('copy-a')).toEqual([['budget:0:80',1000],['run:done',2000]]);
    expect(persisted.get('copy-b')).toEqual([['budget:0:80',2000],['run:done',2000]]);
  });
  test('a shared warning cannot dispatch when no live endpoint exists', async () => {
    const closed = crossingFeed('closed'); closed.lifecycle='closed';
    const disconnected = crossingFeed('disconnected'); disconnected.updatedAt=1;
    const selected=selectPanelNotifications([closed,disconnected],new Set(),11002);
    expect(selected).toHaveLength(1);expect(selected[0].ownerAddress).toBeNull();
    const calls: string[]=[];
    const result=await dispatchPanelNotification(selected[0],[closed,disconnected],{ping:async()=>{calls.push('ping');return true;},openUsage:async()=>{calls.push('usage');},focus:async()=>{calls.push('focus');}},11002);
    expect(result.ok).toBe(false);expect(calls).toEqual([]);
  });
  test('a closed result owner never redirects focus to a different session', async () => {
    const closed=crossingFeed('closed');closed.lifecycle='closed';
    closed.notifications=[sessionNotice(closed,'subagent-result','run:result',1000)];
    const selected=selectPanelNotifications([closed,crossingFeed('live')],new Set(['budget:0:80']),1000);
    expect(selected).toMatchObject([{id:'run:result',sessionId:'closed',ownerAddress:'closed'}]);
    const calls: string[]=[];
    expect((await dispatchPanelNotification(selected[0],[closed,crossingFeed('live')],{ping:async()=>true,openUsage:async()=>{calls.push('usage');},focus:async()=>{calls.push('focus');}},1000)).ok).toBe(false);
    expect(calls).toEqual([]);
  });
  test('null budget never manufactures a budget warning', () => {
    const f = crossingFeed('unknown'); f.pace.budget=null;
    expect(selectPanelNotifications([f], new Set(), 1000)).toEqual([]);
  });
  test('null projection does not emit a projection warning', () => {
    const f = crossingFeed('unknown', 0, 'projected'); f.pace.projected=null;
    expect(selectPanelNotifications([f], new Set(), 1000)).toEqual([]);
  });
  test('stale publishers and future committed times do not create new completion notices', () => {
    const f = crossingFeed('stale'), future = crossingFeed('future', 0, '100');future.notifications[0].createdAt=12000;future.updatedAt=11001;
    expect(selectPanelNotifications([f,future], new Set(), 11001)).toEqual([]);
  });
  test('orders 80 percent, 100 percent, projection and a new billing period by committed time', () => {
    const feeds = [crossingFeed('new', 100000), crossingFeed('projection', 0, 'projected'), crossingFeed('full', 0, '100'), crossingFeed('initial')];
    feeds.forEach((f, i) => { f.notifications[0].createdAt = 4000-i*1000; f.updatedAt=4000; });
    expect(selectPanelNotifications(feeds, new Set(), 4000).map(n=>n.id)).toEqual(['budget:0:80','budget:0:100','budget:0:projected','budget:100000:80']);
  });
  test('a repeated shared budget crossing opens usage without pane focus', () => {
    const feeds = [crossingFeed('s1'), crossingFeed('s2')];
    const selected = selectPanelNotifications(feeds, new Set(), 1000);
    expect(selected.map(n => n.id)).toEqual(['budget:0:80']);
    expect(selectPanelNotifications(feeds, new Set(['budget:0:80']), 1000)).toEqual([]);
    expect(selected[0].action).toEqual({ kind: 'open-usage', scope: 'shared' });
    expect(selected[0].ownerAddress).toBeNull();
  });
});
