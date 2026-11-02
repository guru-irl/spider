// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, test } from 'vitest';
import type { SessionFeed, CoreId, TerminalId, TerminalAddress, SpaceId, RunSummary } from '../contracts.js';
import { runPanelScene } from './acceptance/i.js';
import { selectedSpace, projectPace, projectNotifications, projectSessionFacts, projectSpacePanel, relativeAge, formatCredits, notificationText } from '../../assets/mods/spider/data.js';

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
function feed(id: string, space: string | null = 'space-3', patch: Partial<SessionFeed> = {}): SessionFeed {
  return {
    version: 1, sessionId: id as SessionFeed['sessionId'], generation: 'g' as SessionFeed['generation'], revision: 1, updatedAt: NOW - 1000,
    owner: { sessionId: id as SessionFeed['sessionId'], generation: 'g' as SessionFeed['generation'],
      terminal: { coreId: 'core' as CoreId, terminalId: id as TerminalId, address: id as TerminalAddress, socket: '/fixture/socket', sessionNamespace: 'fixture' },
      cwd: '/fixture', sessionFile: null, name: id },
    placement: space ? { spaceId: space as SpaceId, spaceName: space, spaceOrder: 0, tabId: null } : null,
    lifecycle: 'live', status: { native: 'idle', effective: 'idle', message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'No counters' },
    approvals: [], notifications: [], ipc: { address: '/fixture/ipc', capabilityFile: '/fixture/capability' }, errors: [], ...patch,
  };
}
const run = (id: string, owner: string, patch: Partial<RunSummary> = {}): RunSummary => ({ id, ownerSessionId: owner, name: id, status: 'running', childMode: 'rpc', canSteer: true, startedAt: NOW - 60000, finishedAt: null, viewer: null, result: null, ...patch } as RunSummary);
const pace = (patch: Partial<SessionFeed['pace']>): SessionFeed['pace'] => ({ scope: 'shared', used: 1284, budget: 5000, projected: 3950, remaining: 3716, periodStart: NOW - 10 * 86400000, periodEnd: NOW + 20 * 86400000, updatedAt: NOW - 4 * 60000, unavailableReason: null, ...patch });

describe('selected space', () => {
  test('is the active Herdr space, and nothing when the app reports none', () => {
    expect(selectedSpace([{ id: 's1', name: 'docs', active: false }, { id: 's3', name: 'spider · tools', active: true }])).toEqual({ id: 's3', name: 'spider · tools' });
    expect(selectedSpace([])).toBeNull();
    expect(selectedSpace(null)).toBeNull();
  });
});

describe('space panel projection', () => {
  test('lists only the selected space\'s sessions and their needs-you items', () => {
    const here = feed('planner', 'space-3', { status: { native: 'blocked', effective: 'blocked', message: 'Approve push to origin?' } });
    const other = feed('elsewhere', 'space-1', { status: { native: 'blocked', effective: 'blocked', message: 'Other space' } });
    const model = projectSpacePanel([here, other], { id: 'space-3', name: 'spider · tools' }, NOW);
    expect(model.space).toEqual({ id: 'space-3', name: 'spider · tools' });
    expect(model.sessions.map(s => s.id)).toEqual(['planner']);
    expect(model.notifications.map(notificationText)).toEqual(['planner is waiting']);
    expect(model.notifications[0]).toMatchObject({ kind: 'waiting', action: 'Focus', sessionId: 'planner',
      parts: [{ type: 'agent', icon: 'session', text: 'planner' }, { type: 'text', text: 'is waiting' }] });
  });
  test('without a selected space shows every session under an all-spaces context', () => {
    const model = projectSpacePanel([feed('a', 'space-1'), feed('b', null)], null, NOW);
    expect(model.space).toBeNull();
    expect(model.sessions.map(s => s.id)).toEqual(['a', 'b']);
  });
  test('memories count only this space\'s sessions plus unattributed shared ones', () => {
    const mine = feed('mine', 'space-3', { approvals: [
      { uuid: 'm1', scope: 'repo', repoKey: 'r' as never, ownerSessionId: 'mine' as never, category: 'insight', preview: 'Mine' },
      { uuid: 'g1', scope: 'global', repoKey: null, ownerSessionId: null, category: 'insight', preview: 'Shared' }] });
    const theirs = feed('theirs', 'space-1', { approvals: [
      { uuid: 'm2', scope: 'repo', repoKey: 'r' as never, ownerSessionId: 'theirs' as never, category: 'insight', preview: 'Theirs' },
      { uuid: 'g1', scope: 'global', repoKey: null, ownerSessionId: null, category: 'insight', preview: 'Shared' }] });
    const items = projectSpacePanel([mine, theirs], { id: 'space-3', name: 'three' }, NOW).notifications;
    expect(items).toEqual([expect.objectContaining({ kind: 'memory', action: 'Review',
      parts: [{ type: 'text', text: '2 memories to review' }] })]);
    expect(projectSpacePanel([theirs], { id: 'space-3', name: 'three' }, NOW).notifications).toEqual([]);
  });
});

describe('needs you', () => {
  test('waiting and failed sessions, one action each; failed runs and over-pace budget are not listed', () => {
    const failed = run('yarn-build', 'planner', { status: 'failed', finishedAt: NOW - 3 * 60000, result: 'exit 1\nmore' });
    const old = run('old-fail', 'planner', { status: 'failed', finishedAt: NOW - 30 * 3600000 });
    const s = feed('planner', 'space-3', { runs: { rows: [failed, old, run('ok', 'planner', { status: 'done', finishedAt: NOW })], total: 3, truncated: false }, pace: pace({ projected: 6200 }) });
    const errored = feed('crashed', 'space-3', { status: { native: 'error', effective: 'error', message: null } });
    const items = projectNotifications([s, errored], NOW);
    expect(items.map(i => [i.kind, notificationText(i), i.action])).toEqual([
      ['failed', 'crashed failed', 'Focus'],
    ]);
    expect(items[0]).toMatchObject({ sessionId: 'crashed' });
  });
  test('a disconnected or closed session is not reported as waiting', () => {
    const stale = feed('stale', 'space-3', { updatedAt: NOW - 60000, status: { native: 'blocked', effective: 'blocked', message: null } });
    expect(projectNotifications([stale], NOW)).toEqual([]);
  });
});

describe('pace', () => {
  test('fractions, a today mark, relative freshness and the newest reading win', () => {
    const p = projectPace([feed('a', null, { pace: pace({ updatedAt: NOW - 3600000, used: 1 }) }), feed('b', null, { pace: pace({}) })], NOW);
    expect(p).toMatchObject({ state: 'ok', used: 1284, projected: 3950, budget: 5000, usedFraction: 1284 / 5000, projectedFraction: 3950 / 5000, updated: '4m ago', over: false });
    expect(p.state === 'ok' && p.todayFraction).toBeCloseTo(1 / 3);
  });
  test('over pace when the projection passes the budget, and fractions stay inside the track', () => {
    const p = projectPace([feed('a', null, { pace: pace({ used: 5600, projected: 9000 }) })], NOW);
    expect(p).toMatchObject({ state: 'ok', over: true, usedFraction: 1, projectedFraction: 1 });
  });
  test('missing data is unavailable, never a made-up bar', () => {
    expect(projectPace([feed('a')], NOW)).toEqual({ state: 'unavailable', reason: 'No counters' });
    // No budget: no scale, so no proportional fill, but the used amount still shows.
    expect(projectPace([feed('a', null, { pace: pace({ budget: null }) })], NOW)).toMatchObject({ state: 'unscaled', used: 1284, updated: '4m ago' });
    expect(projectPace([], NOW)).toEqual({ state: 'unavailable', reason: 'No usage data' });
    expect(projectPace([feed('a', null, { pace: pace({ projected: null }) })], NOW)).toMatchObject({ state: 'ok', projected: null, projectedFraction: null });
  });
});

describe('session facts', () => {
  test('live runs, open todos (five shown, then a count) and next trigger times', () => {
    const todos = Array.from({ length: 8 }, (_, i) => ({ seq: i, sessionId: 's' as never, text: `todo ${i}`, done: i === 7 }));
    const nextAt = new Date(NOW); nextAt.setHours(1, 30, 0, 0); nextAt.setDate(nextAt.getDate() + 1);
    const s = feed('s', 'space-3', { status: { native: 'working', effective: 'working', message: null },
      runs: { rows: [run('a', 's'), run('b', 's', { status: 'queued' }), run('c', 's', { status: 'done', finishedAt: NOW })], total: 3, truncated: false },
      todos: { rows: todos, total: 8, truncated: false },
      triggers: [{ name: 'ci-watch', kind: 'loop', nextAt: nextAt.getTime(), tz: null, state: 'armed', prompt: 'x' }, { name: 'idle', kind: 'schedule', nextAt: null, tz: null, state: 'stopped', prompt: 'y' }] });
    const facts = projectSessionFacts(s, NOW);
    expect(facts).toMatchObject({ id: 's', name: 's', state: 'working', live: 2, openTodos: 7, facts: [{ kind: 'live', count: 2, label: '2 live subagents' }, { kind: 'todos', count: 7, label: '7 open todos' }], moreTodos: 2 });
    expect(facts.todos.map(t => t.text)).toEqual(['todo 0', 'todo 1', 'todo 2', 'todo 3', 'todo 4']);
    expect(facts.triggers).toEqual([{ name: 'ci-watch', next: nextAt.getTime() - NOW < 86400000 ? 'next 01:30' : expect.stringMatching(/^next /) }, { name: 'idle', next: 'not scheduled' }]);
    expect(projectSessionFacts(feed('one', 'space-3', { todos: { rows: [todos[0]], total: 1, truncated: false } }), NOW).facts).toEqual([{ kind: 'todos', count: 1, label: '1 open todo' }]);
    expect(projectSessionFacts(feed('gone', 'space-3', { updatedAt: NOW - 60000 }), NOW).state).toBe('disconnected');
  });
});

describe('formatting', () => {
  test('credits use thousands separators and ages are relative', () => {
    expect(formatCredits(1284)).toBe('1,284'); expect(formatCredits(1234567.6)).toBe('1,234,568'); expect(formatCredits(12)).toBe('12');
    expect(relativeAge(20000)).toBe('just now'); expect(relativeAge(4 * 60000)).toBe('4m ago');
    expect(relativeAge(3 * 3600000)).toBe('3h ago'); expect(relativeAge(2 * 86400000)).toBe('2d ago');
  });
});

describe('panel demarcations (rendered by the strict mod API)', () => {
  test('a bell with the count instead of a title, a hairline above sessions, fainter lines between rows, and a rail along an expanded session', async () => {
    const two = feed('second', 'space-3');
    const output = await runPanelScene<{ bell: unknown[]; sessions: unknown[]; rows: unknown[]; rail: unknown; header: unknown[]; text: string[] }>(`const a=JSON.parse(files[0]);a.updatedAt=Date.now();
      a.status={native:'blocked',effective:'blocked',message:'Approve?'};a.todos={rows:[{seq:1,sessionId:a.sessionId,text:'Ship it',done:false}],total:1,truncated:false};
      const b=${JSON.stringify(two)};b.updatedAt=Date.now();files.splice(0,1,JSON.stringify(a),JSON.stringify(b));
      initView(panel,cx);await tasks[0];panel.expanded.add(a.sessionId);const tree=panel.render(cx);
      const style=(el,k)=>el?.styles?.[k]?.[0]??null;
      const bell=byId(tree,'spider-bell');const sessions=byId(tree,'spider-sessions');
      const second=byId(tree,'session-second');const rail=byId(tree,'session-'+a.sessionId).items[1];const header=sessions.items[0];
      console.log(JSON.stringify({bell:[bell.items[0].items?.length??0,texts(bell)],sessions:[style(sessions,'border_t'),style(sessions,'border_color'),style(sessions,'pt')],
        rows:[style(second,'border_t'),style(second,'border_color')],rail:[style(rail,'border_l'),style(rail,'border_color'),texts(rail)],
        header:['font_medium' in header.styles,texts(header)],text:texts(tree)}));`, feed('first', 'space-3'));
    expect(output.bell).toEqual([0, ['1']]);
    expect(output.text).not.toContain('Needs you');
    expect(output.sessions).toEqual([1, '#2f2f32', 12]);
    expect(output.rows).toEqual([1, '#232325']);
    expect(output.rail).toEqual([1.5, '#3a3a3d', expect.arrayContaining(['Ship it', 'All todos, runs and usage'])]);
    expect(output.header).toEqual([true, ['Sessions', 'Credits']]);
  });
  test('every session row shows its month cost as the dashboard formats it, right-aligned in monospace', async () => {
    const output = await runPanelScene<{ cost: unknown[]; missing: string[] }>(`const a=JSON.parse(files[0]);a.updatedAt=Date.now();a.monthCost={credits:1284.36,label:'1.3k'};
      const b=JSON.parse(files[0]);b.updatedAt=Date.now();b.sessionId=b.owner.sessionId='older';b.owner.name='older';delete b.monthCost;
      files.splice(0,1,JSON.stringify(a),JSON.stringify(b));initView(panel,cx);await tasks[0];const tree=panel.render(cx);
      const c=byId(tree,'cost-first');console.log(JSON.stringify({cost:[texts(c),c.styles.font_family[0],'text_right' in c.styles,c.styles.w[0]],missing:texts(byId(tree,'cost-older'))}));`, feed('first', 'space-3'));
    expect(output.cost).toEqual([['1.3k'], 'JetBrains Mono', true, 48]);
    expect(output.missing).toEqual(['\u2013']);
  });
  test('a failed command gets no card; a waiting card renders its agent as a slim pill', async () => {
    const output = await runPanelScene<{ job: boolean; pill: unknown[]; text: string[] }>(`const a=JSON.parse(files[0]);a.updatedAt=Date.now();a.status={native:'blocked',effective:'blocked',message:null};
      files[0]=JSON.stringify(a);props.labelContract={version:1,labels:{job:'spider.job',kind:'spider.kind',session:'spider.session',run:'spider.run',machine:'spider.machine',displayName:'spider.display-name'},kinds:{exec:'exec',execFile:'exec-file',batch:'batch'}};
      a.notifications=[{id:'job-result:j1',kind:'job-result',scope:'session',sessionId:a.sessionId,ownerAddress:a.owner.terminal.address,createdAt:Date.now()-60000,title:'Job j1',body:'Exit 1',action:{kind:'focus-owner',sessionId:a.sessionId,address:a.owner.terminal.address},job:{id:'j1',runId:null,commandPreview:'make test build',machine:'build.invalid',address:'build.invalid/t9',exitCode:1,signal:null,finishedAt:Date.now()-60000}}];files[0]=JSON.stringify(a);api.terminals=()=>[];
      initView(panel,cx);await tasks[0];const tree=panel.render(cx);const row=byId(tree,'need-waiting:first');const p=byId(row,'pill-waiting:first-0');
      console.log(JSON.stringify({job:Boolean(byId(tree,'need-job:j1')),pill:[texts(p),p.items.length,p.styles.rounded[0],p.styles.bg[0],p.styles.font_family[0]],text:texts(byId(tree,'spider-notifications'))}));`, feed('first', 'space-3'));
    expect(output.job).toBe(false);
    // Agent: icon plus name in a slim pill.
    expect(output.pill).toEqual([['first'], 2, 999, '#ffffff0d', 'JetBrains Mono']);
    expect(output.text).toEqual(['!', 'first', 'is waiting']);
  });
});
