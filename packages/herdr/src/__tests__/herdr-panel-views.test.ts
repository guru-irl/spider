// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, test } from 'vitest';
import type { SessionFeed, CoreId, TerminalId, TerminalAddress, SpaceId, RunSummary, ApprovalSummary } from '../contracts.js';
import { runPanelScene } from './acceptance/i.js';
import { projectNotifications, visibleNotifications, pruneDismissed, projectMemoryReview, projectSessionView, projectSpacePanel, notificationText } from '../../assets/mods/spider/data.js';

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
function feed(id: string, patch: Partial<SessionFeed> = {}): SessionFeed {
  return {
    version: 1, sessionId: id as SessionFeed['sessionId'], generation: 'g' as SessionFeed['generation'], revision: 1, updatedAt: NOW - 1000,
    owner: { sessionId: id as SessionFeed['sessionId'], generation: 'g' as SessionFeed['generation'],
      terminal: { coreId: 'core' as CoreId, terminalId: id as TerminalId, address: id as TerminalAddress, socket: '/fixture/socket', sessionNamespace: 'fixture' },
      cwd: '/fixture', sessionFile: null, name: id },
    placement: { spaceId: 'space-3' as SpaceId, spaceName: 'three', spaceOrder: 0, tabId: null },
    lifecycle: 'live', status: { native: 'idle', effective: 'idle', message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'No counters' },
    approvals: [], notifications: [], ipc: { address: '/fixture/ipc', capabilityFile: '/fixture/capability' }, errors: [], ...patch,
  };
}
const run = (id: string, owner: string, patch: Partial<RunSummary> = {}): RunSummary => ({ id, ownerSessionId: owner, name: id, status: 'running', childMode: 'rpc', canSteer: true, startedAt: NOW - 60000, finishedAt: null, viewer: null, result: null, ...patch } as RunSummary);
const approval = (uuid: string, patch: Partial<ApprovalSummary> = {}): ApprovalSummary => ({ uuid, scope: 'global', repoKey: null, ownerSessionId: null, category: 'insight', preview: `text ${uuid}`, ...patch } as ApprovalSummary);
const blocked = { native: 'blocked', effective: 'blocked', message: 'Approve?' } as const;
const failedStatus = { native: 'error', effective: 'error', message: 'boom' } as const;
const overPace = { scope: 'shared', used: 90, budget: 100, projected: 180, remaining: 10, periodStart: NOW - 86400000, periodEnd: NOW + 29 * 86400000, updatedAt: NOW, unavailableReason: null } as SessionFeed['pace'];

describe('notifications list only what the user acts on', () => {
  test('waiting, failed sessions and memories; never failed runs, failed commands, machines or budget pace', () => {
    const job = { id: 'job-result:j1', kind: 'job-result', scope: 'session', sessionId: 'planner', ownerAddress: 'planner', createdAt: NOW - 60000, title: 'Job j1', body: 'Exit 1',
      action: { kind: 'focus-owner', sessionId: 'planner', address: 'planner' },
      job: { id: 'j1', runId: null, commandPreview: 'make', machine: 'alpha.invalid', address: 'alpha.invalid/t1', exitCode: 1, signal: null, finishedAt: NOW - 60000 } } as SessionFeed['notifications'][number];
    const items = projectNotifications([
      feed('planner', { status: blocked, pace: overPace, notifications: [job], approvals: [approval('a')],
        runs: { rows: [run('reviewer', 'planner', { status: 'failed', finishedAt: NOW - 60000 })], total: 1, truncated: false } }),
      feed('tester', { status: failedStatus }),
    ], NOW);
    expect(items.map(item => [item.kind, notificationText(item), item.action])).toEqual([
      ['waiting', 'planner is waiting', 'Focus'], ['failed', 'tester failed', 'Focus'], ['memory', '1 memory to review', 'Review']]);
  });
  test('a closed or stale session never asks for attention', () => {
    const items = projectNotifications([feed('planner', { status: blocked, lifecycle: 'closed' }), feed('tester', { status: failedStatus, updatedAt: NOW - 60000 })], NOW);
    expect(items).toEqual([]);
  });
  test('memories are counted once across feeds by scope, repo and uuid', () => {
    const items = projectNotifications([feed('planner', { approvals: [approval('a'), approval('b')] }), feed('tester', { approvals: [approval('a')] })], NOW);
    expect(items.map(notificationText)).toEqual(['2 memories to review']);
  });
});

describe('dismissal', () => {
  const feeds = (status: SessionFeed['status'], approvals: ApprovalSummary[]) => [feed('planner', { status, approvals })];
  test('dismissing hides one occurrence; the others stay', () => {
    const items = projectNotifications([...feeds(blocked, [approval('a')]), feed('tester', { status: failedStatus })], NOW);
    const waiting = items.find(item => item.kind === 'waiting')!;
    const shown = visibleNotifications(items, new Set(waiting.tokens));
    expect(shown.map(notificationText)).toEqual(['tester failed', '1 memory to review']);
  });
  test('a dismissed session returns when it becomes blocked again', () => {
    const first = projectNotifications(feeds(blocked, []), NOW);
    let dismissed = new Set(first[0]!.tokens);
    expect(visibleNotifications(first, dismissed)).toEqual([]);
    // It stops waiting: the dismissal has nothing left to hide and is dropped.
    dismissed = pruneDismissed(dismissed, projectNotifications(feeds({ native: 'working', effective: 'working', message: null }, []), NOW));
    expect([...dismissed]).toEqual([]);
    expect(visibleNotifications(projectNotifications(feeds(blocked, []), NOW), dismissed).map(notificationText)).toEqual(['planner is waiting']);
  });
  test('dismissed memories return when a new approval arrives, and the count includes every pending one', () => {
    const first = projectNotifications(feeds(blocked, [approval('a'), approval('b')]), NOW);
    const memory = first.find(item => item.kind === 'memory')!;
    const dismissed = new Set(memory.tokens);
    expect(visibleNotifications(projectNotifications(feeds(blocked, [approval('a')]), NOW), dismissed).map(item => item.kind)).toEqual(['waiting']);
    const next = visibleNotifications(projectNotifications(feeds(blocked, [approval('a'), approval('b'), approval('c')]), NOW), dismissed);
    expect(next.map(notificationText)).toEqual(['planner is waiting', '3 memories to review']);
  });
  test('pruning keeps only tokens that still exist and stays bounded', () => {
    const items = projectNotifications(feeds(blocked, [approval('a')]), NOW);
    const kept = pruneDismissed(new Set(['waiting:gone', ...items.flatMap(item => item.tokens)]), items);
    expect([...kept].sort()).toEqual(items.flatMap(item => item.tokens).sort());
    const many = Array.from({ length: 700 }, (_, i) => approval(`m${i}`));
    const all = projectNotifications(feeds(blocked, many), NOW);
    expect(pruneDismissed(new Set(all.flatMap(item => item.tokens)), all).size).toBeLessThanOrEqual(512);
  });
  test('the space panel counts only shown items', () => {
    const items = projectNotifications(feeds(blocked, [approval('a')]), NOW);
    const model = projectSpacePanel(feeds(blocked, [approval('a')]), null, NOW, { dismissed: new Set(items[0]!.tokens) });
    expect(model.notifications.map(notificationText)).toEqual(['1 memory to review']);
  });
});

describe('toasts', () => {
  test('no feed notice kind posts a toast', async () => {
    const base = { scope: 'session', sessionId: 'planner', ownerAddress: 'planner', createdAt: NOW - 1000, title: 't', body: 'b', action: { kind: 'focus-owner', sessionId: 'planner', address: 'planner' } };
    const notices = [
      { ...base, id: 'subagent-result:r1', kind: 'subagent-result' },
      { ...base, id: 'escalation:r1:x', kind: 'escalation' },
      { id: 'budget:1:80', kind: 'budget', scope: 'shared', sessionId: null, ownerAddress: null, createdAt: NOW - 1000, title: 'Account usage', body: 'b', action: { kind: 'open-usage', scope: 'shared' } },
      { ...base, id: 'job-result:j1', kind: 'job-result', job: { id: 'j1', runId: null, commandPreview: 'make', machine: 'alpha.invalid', address: 'alpha.invalid/t1', exitCode: 1, signal: null, finishedAt: NOW - 1000 } },
    ] as SessionFeed['notifications'];
    const output = await runPanelScene<{ posts: unknown[] }>(`Date.now=()=>${NOW};const f=JSON.parse(files[0]),notices=f.notifications;f.notifications=[];files[0]=JSON.stringify(f);initView(panel,cx);await tasks[0];f.notifications=notices.map(n=>({...n,createdAt:${NOW}+1}));f.updatedAt=${NOW}+1;Date.now=()=>${NOW}+1;files[0]=JSON.stringify(f);await panel.reload(cx);await drain();console.log(JSON.stringify({posts:notifications}));`, feed('planner', { notifications: notices, pace: overPace }));
    expect(output.posts).toEqual([]);
  });
});

describe('memory review projection', () => {
  test('one card per pending approval across feeds, with the scope label', () => {
    const repo = approval('r', { scope: 'repo', repoKey: '/fixture/alpha/.git' as never, ownerSessionId: 'planner' as never, category: 'convention' });
    const rows = projectMemoryReview([feed('planner', { approvals: [approval('g'), repo] }), feed('tester', { approvals: [approval('g')] })]);
    expect(rows.map(row => [row.uuid, row.category, row.scopeLabel])).toEqual([['r', 'convention', 'alpha'], ['g', 'insight', 'Global']]);
  });
});

describe('session view projection', () => {
  test('open todos, the done count, runs newest first, and credits', () => {
    const s = feed('planner', {
      todos: { rows: [{ seq: 1, sessionId: 'planner' as never, text: 'first', done: false }, { seq: 2, sessionId: 'planner' as never, text: 'second', done: true }, { seq: 3, sessionId: 'planner' as never, text: 'third', done: false }], total: 3, truncated: false },
      runs: { rows: [run('old', 'planner', { status: 'done', startedAt: NOW - 3 * 3600000, finishedAt: NOW - 2 * 3600000 }), run('new', 'planner', { status: 'running', startedAt: NOW - 120000 }), run('bad', 'planner', { status: 'failed', startedAt: NOW - 3600000, finishedAt: NOW - 1800000 })], total: 3, truncated: false },
      monthCost: { credits: 1234, label: '1,234' },
    });
    const view = projectSessionView(s, NOW);
    expect(view.name).toBe('planner');
    expect(view.todos.map(todo => todo.text)).toEqual(['first', 'third']);
    expect(view.done).toBe(1);
    expect(view.runs.map(r => [r.id, r.status, r.when])).toEqual([['new', 'running', '2m ago'], ['bad', 'failed', '1h ago'], ['old', 'done', '3h ago']]);
    expect(view.usage).toEqual([{ label: 'Credits this month', value: '1,234' }]);
  });
  test('missing usage gets an explicit label', () => {
    expect(projectSessionView(feed('planner'), NOW).usage).toEqual([{ label: 'Credits this month', value: 'Unavailable' }]);
  });
});

// A live, waiting session with one global memory to review, and an exec that answers the CLI.
const LIVE = `const a=JSON.parse(files[0]);a.updatedAt=Date.now();a.status={native:'blocked',effective:'blocked',message:'Approve?'};
  a.approvals=[{uuid:'u1',scope:'global',repoKey:null,ownerSessionId:null,category:'insight',preview:'Short preview'},
    {uuid:'u2',scope:'repo',repoKey:'/fixture/alpha/.git',ownerSessionId:a.sessionId,category:'convention',preview:'Repo preview'}];
  files[0]=JSON.stringify(a);const execs=[];const decisions={};
  const pending=()=>({ok:true,op:'pending',unavailable:[],items:a.approvals.filter(x=>!decisions[x.uuid]).map(x=>({scope:x.scope,repoKey:x.repoKey,uuid:x.uuid,category:x.category,content:'Full text of '+x.uuid+' that is longer than the preview.',createdAt:1}))});
  api.exec=async(cmd,args)=>{execs.push(args);
    if(args[0]==='-e')return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};
    if(args[1]==='memory'&&args[2]==='pending')return {code:0,stdout:JSON.stringify(pending())+'\\n',stderr:''};
    if(args[1]==='memory'){const uuid=args[args.indexOf('--uuid')+1];if(uuid==='u2')return {code:1,stdout:JSON.stringify({ok:false,code:'not-pending',message:'This memory is no longer waiting for review.'})+'\\n',stderr:''};
      decisions[uuid]=args[2];a.approvals=a.approvals.filter(x=>x.uuid!==uuid);files[0]=JSON.stringify(a);return {code:0,stdout:JSON.stringify({ok:true,op:args[2],uuid})+'\\n',stderr:''};}
    if(args[1]==='ipc'){const request=JSON.parse(args[5]);return {code:0,stdout:JSON.stringify({ok:true,op:request.op,viewer:'alpha.invalid/t9'})+'\\n',stderr:''};}
    throw new Error('unexpected exec '+JSON.stringify(args));};`;

describe('panel cards', () => {
  test('each notification is a bordered card with its own dismiss control', async () => {
    const output = await runPanelScene<Record<string, unknown>>(`${LIVE}
      initView(panel,cx);await tasks[0];await drain();let tree=panel.render(cx);
      const card=byId(tree,'card-waiting:planner'),x=byId(tree,'dismiss-waiting:planner'),list=byId(tree,'spider-notifications');
      const before={card:[card.styles.border?.[0],card.styles.border_color?.[0],card.styles.rounded?.[0]],gap:list.styles.gap?.[0],tip:x.styles.tooltip?.[0],tab:x.styles.tab_index?.[0],hover:'hover' in x.styles,
        bell:texts(byId(tree,'spider-bell-count'))};
      x.events.on_click({},cx);tree=panel.render(cx);
      const afterClick={list:texts(byId(tree,'spider-notifications')),bell:texts(byId(tree,'spider-bell-count')),commands:[...commands],stored:persisted.get('spider.dismissed/spider-test')};
      byId(tree,'dismiss-memory').events.on_key_down({keystroke:{key:'enter'}},cx);tree=panel.render(cx);
      console.log(JSON.stringify({before,afterClick,afterKey:{list:byId(tree,'spider-notifications')??null,bell:byId(tree,'spider-bell-count')??null,execs:execs.filter(e=>e[0]!=='-e')}}));`, feed('planner'));
    expect(output.before).toEqual({ card: [1, '#38383a', 8], gap: 6, tip: 'Dismiss', tab: 0, hover: true, bell: ['2'] });
    // The click hides that card only, does not focus the session, and is saved for a reload.
    expect(output.afterClick).toEqual({ list: ['2 memories to review'], bell: ['1'], commands: [], stored: ['waiting:planner'] });
    expect(output.afterKey).toEqual({ list: null, bell: null, execs: [] });
  });
  test('dismissals survive a reload and lapse when the state they hid goes away', async () => {
    const output = await runPanelScene<Record<string, unknown>>(`${LIVE}persisted.set('spider.dismissed/spider-test',['waiting:planner','waiting:gone']);
      initView(panel,cx);await tasks[0];await drain();const shown=()=>{const list=byId(panel.render(cx),'spider-notifications');return list?texts(list):[];};
      const reloaded=shown();
      a.status={native:'working',effective:'working',message:null};a.updatedAt=Date.now();files[0]=JSON.stringify(a);await panel.reload(cx);
      const working={shown:shown(),stored:persisted.get('spider.dismissed/spider-test')};
      a.status={native:'blocked',effective:'blocked',message:null};a.updatedAt=Date.now();files[0]=JSON.stringify(a);await panel.reload(cx);
      console.log(JSON.stringify({reloaded,working,again:shown()}));`, feed('planner'));
    expect(output.reloaded).toEqual(['2 memories to review']);
    expect(output.working).toEqual({ shown: ['2 memories to review'], stored: [] });
    expect(output.again).toEqual(['!', 'planner', 'is waiting', '2 memories to review']);
  });
});

describe('memories view', () => {
  test('clicking the memories card lists full text with approve and reject, and decides without pi', async () => {
    const output = await runPanelScene<Record<string, unknown>>(`${LIVE}
      initView(panel,cx);await tasks[0];await drain();let tree=panel.render(cx);
      byId(tree,'need-memory').events.on_click({},cx);await drain();tree=panel.render(cx);
      const view=byId(tree,'spider-memories');
      const first={title:texts(byId(view,'memories-header')),back:Boolean(byId(view,'memories-back')?.events.on_click),
        cards:['u1','u2'].map(u=>texts(byId(view,'memory-'+u))),wrap:'whitespace_normal' in byId(view,'memory-text-u1').styles,
        list:execs.filter(e=>e[0]!=='-e')};
      byId(view,'approve-u1').events.on_click({},cx);await drain();byId(panel.render(cx),'reject-u2').events.on_click({},cx);await drain();
      tree=panel.render(cx);const after={cards:[byId(tree,'memory-u1')??null,texts(byId(tree,'memory-error-u2'))],decisions:execs.filter(e=>e[1]==='memory'&&e[2]!=='pending')};
      byId(tree,'memories-back').events.on_click({},cx);tree=panel.render(cx);
      console.log(JSON.stringify({first,after,home:Boolean(byId(tree,'spider-sessions')),pi:execs.some(e=>e[1]==='ipc')}));`, feed('planner'));
    expect(output.first).toEqual({
      title: ['Memories to review'], back: true, wrap: true,
      cards: [['insight', 'Global', 'Full text of u1 that is longer than the preview.', 'Approve', 'Reject'], ['convention', 'alpha', 'Full text of u2 that is longer than the preview.', 'Approve', 'Reject']],
      list: [['/fixture/cli.mjs', 'memory', 'pending', '--repo', '/fixture/alpha/.git']],
    });
    expect(output.after).toEqual({ cards: [null, ['This memory is no longer waiting for review.']],
      decisions: [['/fixture/cli.mjs', 'memory', 'approve', '--scope', 'global', '--uuid', 'u1'], ['/fixture/cli.mjs', 'memory', 'reject', '--scope', 'repo', '--repo', '/fixture/alpha/.git', '--uuid', 'u2']] });
    expect(output.home).toBe(true);
    expect(output.pi).toBe(false);
  });
  test('an empty list says so', async () => {
    const output = await runPanelScene<string[]>(`${LIVE}a.approvals=[{uuid:'u1',scope:'global',repoKey:null,ownerSessionId:null,category:'insight',preview:'p'}];files[0]=JSON.stringify(a);
      initView(panel,cx);await tasks[0];await drain();byId(panel.render(cx),'need-memory').events.on_click({},cx);await drain();
      byId(panel.render(cx),'approve-u1').events.on_click({},cx);await drain();console.log(JSON.stringify(texts(byId(panel.render(cx),'spider-memories'))));`, feed('planner'));
    expect(output).toEqual(['Memories to review', 'Nothing to review']);
  });
});

describe('session view', () => {
  test('a session row opens its todos, runs and usage in the panel; a run opens its output pane', async () => {
    const output = await runPanelScene<Record<string, unknown>>(`${LIVE}a.status={native:'working',effective:'working',message:null};a.approvals=[];a.monthCost={credits:12,label:'12'};
      a.todos={rows:[1,2,3,4,5,6,7].map(n=>({seq:n,sessionId:a.sessionId,text:'todo '+n,done:n===7})),total:7,truncated:false};
      a.runs={rows:[{id:'r1',ownerSessionId:a.sessionId,name:'reviewer',status:'failed',childMode:'print',canSteer:false,startedAt:Date.now()-7200000,finishedAt:Date.now()-3600000,viewer:null,result:null},
        {id:'r2',ownerSessionId:a.sessionId,name:'worker',status:'running',childMode:'rpc',canSteer:true,startedAt:Date.now()-60000,finishedAt:null,viewer:null,result:null}],total:2,truncated:false};
      files[0]=JSON.stringify(a);initView(panel,cx);await tasks[0];await drain();let tree=panel.render(cx);
      byId(tree,'session-head-'+a.sessionId).events.on_click({},cx);tree=panel.render(cx);
      byId(tree,'more-todos-'+a.sessionId).events.on_click({},cx);tree=panel.render(cx);
      const view=byId(tree,'spider-session-view');
      const shown={header:texts(byId(view,'session-view-header')),todos:texts(byId(view,'session-view-todos')),runs:texts(byId(view,'session-view-runs')),
        usage:texts(byId(view,'session-view-usage')),scroll:'overflow_y_scrollbar' in byId(tree,'spider-scroll').styles};
      byId(view,'session-run-r1').events.on_click({},cx);await drain();
      const opened={commands:[...commands],ipc:execs.filter(e=>e[1]==='ipc').map(e=>JSON.parse(e[5]).op)};
      byId(panel.render(cx),'session-back').events.on_click({},cx);
      console.log(JSON.stringify({shown,opened,home:Boolean(byId(panel.render(cx),'spider-sessions'))}));`, feed('planner'));
    expect(output.shown).toEqual({
      header: ['planner'], scroll: true,
      todos: ['Todos', 'todo 1', 'todo 2', 'todo 3', 'todo 4', 'todo 5', 'todo 6', '1 done'],
      runs: ['Runs', 'worker', '1m ago', 'reviewer', '2h ago'],
      usage: ['Usage', 'Credits this month', '12'],
    });
    expect(output.opened).toEqual({ commands: [{ name: 'pane.focus', args: { terminal: 'alpha.invalid/t9' } }], ipc: ['openRun'] });
    expect(output.home).toBe(true);
  });
});

test('the panel never asks pi to open a view in its own terminal', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../assets/mods/spider/main.js', import.meta.url), 'utf8');
  expect(source).not.toMatch(/openView|openSharedMemory/);
});
