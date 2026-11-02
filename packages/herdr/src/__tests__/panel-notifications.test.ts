// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, test } from 'vitest';
import { createHerdrHarness } from './testutil.js';
import { acceptanceI, runPanelScene } from './acceptance/i.js';
import { parseFeed } from '../../assets/shared/feed.js';
import type { SessionFeed, HerdrNotification } from '../contracts.js';

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
interface QuietPanel { posts: unknown[]; commands: unknown[]; history: unknown; listening: boolean; text: string[] }
async function quietPanel(fixture: SessionFeed, change = '', setup = ''): Promise<QuietPanel> {
  return runPanelScene<QuietPanel>(`
    let now=1000;Date.now=()=>now;
    persisted.set('spider.notifications/spider-test',[['old-event',0]]);
    ${setup}
    initView(panel,cx);await tasks[0];await drain();
    const f=JSON.parse(files[0]);${change}
    files[0]=JSON.stringify(f);await panel.reload(cx);await drain();
    const text=texts(panel.render(cx));panel.close();
    console.log(JSON.stringify({posts:notifications,commands,history:persisted.get('spider.notifications/spider-test'),listening:Boolean(panel.commandTask),text}));`,fixture);
}
function completedFeed(id='owner') {
  const f=crossingFeed(id);
  f.notifications.push(...(['subagent-result','escalation','job-result'] as const).map(kind=>sessionNotice(f,kind,`event:${kind}`,1000)));
  return f;
}

describe('Panel notifications', () => {
  const cases: {name:string;change?:string;setup?:string;fixture?:()=>SessionFeed}[] = [
    {name:'old history is unused even after a week',change:'now+=8*86400000;f.updatedAt=now;'},
    {name:'thousands of results do not create history or toasts',change:"f.notifications=Array.from({length:2200},(_,i)=>({...f.notifications[3],id:'event:'+i,createdAt:1001}));now=1001;f.updatedAt=now;"},
    {name:'resuming at a new terminal never focuses a stale address',change:"f.owner.terminal.address='new-address';"},
    {name:'closing a panel leaves no scheduled toast',change:'panel.close();'},
    {name:'old and current results have no notice commands',change:"now+=8*86400000;f.updatedAt=now;f.notifications.push({...f.notifications[3],id:'new',createdAt:now});"},
    {name:'late history and a new result both stay quiet',setup:"let first=true;api.exec=async()=>({code:0,stdout:JSON.stringify({feeds:first?(first=false,[]):files,errors:[]}),stderr:''});",change:"now=3000;f.updatedAt=now;f.notifications.push({...f.notifications[3],id:'new',createdAt:now});",fixture:()=>completedFeed()},
    {name:'all feed notice kinds stay quiet after a reload',change:'now=1001;f.updatedAt=now;f.notifications=f.notifications.map(n=>({...n,createdAt:now}));'},
    {name:'missing mod identity starts no toast routing',setup:'delete props.modId;'},
    {name:'a second mod copy starts no toast routing',setup:"props.modId='spider-copy';"},
    {name:'an invalid mod identity starts no toast routing',setup:"props.modId='../spider';"},
    {name:'closed owners retain valid feed data but never post',change:"f.lifecycle='closed';"},
    {name:'duplicate results and escalations never post',change:'f.notifications.push(...f.notifications);now=1001;f.updatedAt=now;'},
    {name:'shared budget notices have no action to dispatch',fixture:()=>crossingFeed('owner'),change:'now=1001;f.updatedAt=now;f.notifications[0].createdAt=now;'},
    {name:'repeated reloads do not create per-copy seen history',change:'await panel.reload(cx);await panel.reload(cx);'},
    {name:'a closed owner cannot redirect focus to another session',change:"f.lifecycle='closed';files.push(JSON.stringify({...f,sessionId:'other',lifecycle:'live'}));"},
    {name:'stale and future commits never post',change:'now=11001;f.notifications.forEach(n=>n.createdAt=12000);'},
    {name:'budget periods and crossings stay quiet in any order',fixture:()=>crossingFeed('owner',100000,'projected'),change:'f.notifications.push({...f.notifications[0],id:"budget:0:100",createdAt:4000});now=4000;f.updatedAt=now;'},
  ];
  test.each(cases)('$name', async ({fixture,change,setup}) => {
    const output=await quietPanel((fixture??completedFeed)(),change,setup);
    expect(output.posts).toEqual([]);
    expect(output.commands).toEqual([]);
    expect(output.history).toEqual([['old-event',0]]);
    expect(output.listening).toBe(false);
    expect(output.text.join(' ')).not.toContain("Spider can't post Herdr notices.");
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
});
