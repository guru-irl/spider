// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, test } from 'vitest';
import type { SessionFeed, CoreId, TerminalId, TerminalAddress, SpaceId, RunSummary } from '../contracts.js';
import { runPanelScene } from './acceptance/i.js';
import { projectFailedCommands, projectMachineProblems, projectNotifications, projectPace, projectSessionFacts, notificationText } from '../../assets/mods/spider/data.js';

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
const job = (patch: Record<string, unknown> = {}) => ({ id: 'job-result:job-1', kind: 'job-result', scope: 'session', sessionId: 'planner', ownerAddress: 'planner', createdAt: NOW - 120000,
  title: 'Job job-1', body: 'Exit 1', action: { kind: 'focus-owner', sessionId: 'planner', address: 'planner' },
  job: { id: 'job-1', runId: null, commandPreview: 'make-test-build', machine: 'build.invalid', address: 'build.invalid/t9', exitCode: 1, signal: null, finishedAt: NOW - 120000, ...patch },
}) as SessionFeed['notifications'][number];
// Records each svg's path so a test can tell icons apart.
const tagIcons = (source: string) => source.replace("import { View, div, svg } from 'gpui-kit';", "import { View, div, svg as kitSvg } from 'gpui-kit';\nconst svg = path => Object.assign(kitSvg(path), { path });");
const LABELS = "props.labelContract={version:1,labels:{job:'spider.job',kind:'spider.kind',session:'spider.session',run:'spider.run',machine:'spider.machine',displayName:'spider.display-name'},kinds:{exec:'exec',execFile:'exec-file',batch:'batch'}};";

describe('notification wording', () => {
  test('a waiting session shows only that it is waiting, never the question', () => {
    const waiting = feed('planner', { status: { native: 'blocked', effective: 'blocked', message: 'Approve push to origin?' } });
    const [item] = projectNotifications([waiting], projectPace([], NOW), NOW);
    expect(item!.parts).toEqual([{ type: 'agent', icon: 'session', text: 'planner' }, { type: 'text', text: 'is waiting' }]);
    expect(notificationText(item!)).toBe('planner is waiting');
  });
  test('a failed command reads [agent] `command` failed on [machine], without the exit code', () => {
    const [item] = projectFailedCommands([feed('planner', { notifications: [job({ commandPreview: 'make test build' })] })], NOW);
    expect(item!.parts).toEqual([{ type: 'agent', icon: 'session', text: 'planner' }, { type: 'command', text: 'make test build' }, { type: 'text', text: 'failed' },
      { type: 'text', text: 'on' }, { type: 'machine', text: 'build.invalid' }]);
  });
  test('memories read just the count; failed runs and sessions carry no detail', () => {
    const shared = { uuid: 'g', scope: 'global' as const, repoKey: null, ownerSessionId: null, category: 'insight', preview: 'p' };
    const owned = { uuid: 'm', scope: 'repo' as const, repoKey: 'r' as never, ownerSessionId: 'planner' as never, category: 'insight', preview: 'q' };
    const items = projectNotifications([
      feed('planner', { approvals: [shared, owned], runs: { rows: [run('reviewer', 'planner', { status: 'failed', finishedAt: NOW - 60000, result: 'exit 1' })], total: 1, truncated: false } }),
      feed('tester', { status: { native: 'error', effective: 'error', message: 'boom' } }),
    ], projectPace([], NOW), NOW);
    expect(items.map(notificationText)).toEqual(['tester failed', 'reviewer failed', '2 memories to review']);
  });
  test('a machine problem names its real state', () => {
    const items = projectMachineProblems([{ name: 'a.invalid' }, { name: 'b.invalid' }, { name: 'c.invalid' }, { name: 'd.invalid' }],
      [{ name: 'a.invalid', state: 'disconnected' }, { name: 'b.invalid', state: 'stopped' }, { name: 'c.invalid', state: 'needs_auth' }]);
    expect(items.map(notificationText)).toEqual(['a.invalid disconnected', 'b.invalid stopped', 'c.invalid needs auth', 'd.invalid unreachable']);
  });
});

describe('session facts', () => {
  test('live subagents and open todos are icon and count pairs, not words', () => {
    const s = feed('planner', { runs: { rows: [run('a', 'planner'), run('b', 'planner', { status: 'done', finishedAt: NOW })], total: 2, truncated: false },
      todos: { rows: [{ seq: 1, sessionId: 'planner' as never, text: 'x', done: false }, { seq: 2, sessionId: 'planner' as never, text: 'y', done: false }], total: 2, truncated: false } });
    expect(projectSessionFacts(s, NOW).facts).toEqual([{ kind: 'live', count: 1, label: '1 live subagent' }, { kind: 'todos', count: 2, label: '2 open todos' }]);
  });
});

describe('panel rendering', () => {
  test('rows have no action buttons and no separators; commands look like inline code; pills are slim', async () => {
    const output = await runPanelScene<{ text: string[]; code: unknown[]; pill: unknown[]; buttons: number; lines: boolean[] }>(`const a=JSON.parse(files[0]);a.updatedAt=Date.now();
      a.status={native:'blocked',effective:'blocked',message:'Approve push to origin?'};
      a.approvals=[{uuid:'g',scope:'global',repoKey:null,ownerSessionId:null,category:'insight',preview:'p'}];
      files[0]=JSON.stringify(a);${LABELS}
      a.notifications=[{id:'job-result:j1',kind:'job-result',scope:'session',sessionId:a.sessionId,ownerAddress:a.owner.terminal.address,createdAt:Date.now()-60000,title:'Job j1',body:'Exit 2',action:{kind:'focus-owner',sessionId:a.sessionId,address:a.owner.terminal.address},job:{id:'j1',runId:null,commandPreview:'make test build',machine:'build.invalid',address:'build.invalid/t9',exitCode:2,signal:null,finishedAt:Date.now()-60000}}];files[0]=JSON.stringify(a);api.terminals=()=>[];
      initView(panel,cx);await tasks[0];const tree=panel.render(cx);const list=byId(tree,'spider-notifications');
      const row=byId(tree,'need-job:j1');const code=byId(row,'pill-job:j1-1');const pill=byId(row,'pill-job:j1-0');
      let buttons=0;(function walk(el){if(el?.styles?.id&&/^need-(focus|output|review|usage)/.test(el.styles.id[0]))buttons++;(el?.items||[]).forEach(walk);})(list);
      console.log(JSON.stringify({text:texts(list),buttons,lines:list.items.map(r=>'border_t' in r.styles),code:[code.items.length,code.styles.rounded?.[0],code.styles.font_family?.[0],code.styles.bg?.[0],'border' in code.styles],
        pill:[pill.styles.h?.[0],pill.styles.text_size?.[0],pill.styles.bg?.[0],'border' in pill.styles]}));`, feed('planner'), tagIcons);
    expect(output.text).toEqual(['!', 'planner', 'is waiting', 'planner', 'make test build', 'failed', 'on', 'build.invalid', '1 memory to review']);
    expect(output.text.join(' ')).not.toMatch(/\u00b7|Approve push|exit 2|Focus|Output|Review/);
    expect(output.buttons).toBe(0);
    // Rows are separated by space and their hover fill, not by rules.
    expect(output.lines).toEqual([false, false, false]);
    // Inline code: text only, monospace, a subtle fill and a small radius; no border, no pill.
    expect(output.code).toEqual([1, 4, 'JetBrains Mono', '#ffffff12', false]);
    expect(output.pill).toEqual([16, 10.5, '#ffffff0d', false]);
  });
  test('the whole row runs its action from a click or the keyboard, with a hover fill', async () => {
    const output = await runPanelScene<{ commands: { name: string; args: unknown }[]; hover: boolean[]; tab: unknown[]; quiet: boolean }>(`const a=JSON.parse(files[0]);a.updatedAt=Date.now();
      a.status={native:'blocked',effective:'blocked',message:'Approve?'};files[0]=JSON.stringify(a);${LABELS}
      api.panes=()=>[{terminal:'build.invalid/t9'}];
      a.notifications=[{id:'job-result:j1',kind:'job-result',scope:'session',sessionId:a.sessionId,ownerAddress:a.owner.terminal.address,createdAt:Date.now()-60000,title:'Job j1',body:'Exit 1',action:{kind:'focus-owner',sessionId:a.sessionId,address:a.owner.terminal.address},job:{id:'j1',runId:null,commandPreview:'make-test-build',machine:'build.invalid',address:'build.invalid/t9',exitCode:1,signal:null,finishedAt:Date.now()-60000}}];files[0]=JSON.stringify(a);api.terminals=()=>[];
      api.readTextFile=async()=>JSON.stringify({machines:[{name:'gone.invalid'}]});api.hc=async()=>({code:0,stdout:JSON.stringify({machines:[]}),stderr:''});
      initView(panel,cx);await tasks[0];await drain();const after=Date.now()+10000;Date.now=()=>after;a.updatedAt=after;files[0]=JSON.stringify(a);await panel.reload(cx);await panel.refreshMachines(cx);const tree=panel.render(cx);
      const waiting=byId(tree,'need-waiting:'+a.sessionId), failed=byId(tree,'need-job:j1'), machine=byId(tree,'need-machine:gone.invalid');
      waiting.events.on_click({},cx);failed.events.on_key_down({keystroke:{key:'enter'}},cx);failed.events.on_key_down({keystroke:{key:'a'}},cx);
      console.log(JSON.stringify({commands,hover:[waiting,failed].map(r=>'hover' in r.styles&&'cursor_pointer' in r.styles),tab:[waiting.styles.tab_index?.[0],failed.styles.tab_index?.[0]],
        quiet:!machine.events.on_click&&!('cursor_pointer' in machine.styles)}));`, feed('planner'));
    expect(output.commands).toEqual([{ name: 'pane.focus', args: { terminal: 'planner' } }, { name: 'pane.focus', args: { terminal: 'build.invalid/t9' } }]);
    expect(output.hover).toEqual([true, true]);
    expect(output.tab).toEqual([0, 0]);
    // A machine problem has no action, so its row is not clickable.
    expect(output.quiet).toBe(true);
  });
  test('session rows lead with the kind icon instead of a status glyph, keep credits and the chevron, and show facts as icons', async () => {
    const output = await runPanelScene<{ lead: unknown[]; tail: string[]; facts: unknown[]; text: string[] }>(`const a=JSON.parse(files[0]);a.updatedAt=Date.now();
      a.status={native:'working',effective:'working',message:null};a.monthCost={credits:12,label:'12'};
      a.runs={rows:[{id:'r1',ownerSessionId:a.sessionId,name:'reviewer',status:'running',childMode:'rpc',canSteer:true,startedAt:Date.now(),finishedAt:null,viewer:null,result:null}],total:1,truncated:false};
      a.todos={rows:[{seq:1,sessionId:a.sessionId,text:'x',done:false},{seq:2,sessionId:a.sessionId,text:'y',done:false}],total:2,truncated:false};
      files[0]=JSON.stringify(a);initView(panel,cx);await tasks[0];const tree=panel.render(cx);const head=byId(tree,'session-head-'+a.sessionId);
      const icons=el=>el?.path?[el.path]:(el?.items||[]).flatMap(icons);
      const facts=byId(head,'facts-'+a.sessionId);
      console.log(JSON.stringify({lead:[icons(head.items[0]),'spin' in head.items[0].styles],tail:head.items.slice(2).flatMap(icons),
        facts:facts.items.map(f=>[icons(f),texts(f),f.styles.tooltip?.[0]]),text:texts(head)}));`, feed('planner'), tagIcons);
    expect(output.lead).toEqual([['mods/workspace-chrome/terminal.svg'], false]);
    // Right side: the fact icons, then the chevron; no terminal icon there.
    expect(output.tail).toEqual(['mods/spider-agents/bot.svg', 'mods/workspace-chrome/square.svg', 'mods/workspace-chrome/chevron-right.svg']);
    expect(output.facts).toEqual([[['mods/spider-agents/bot.svg'], ['1'], '1 live subagent'], [['mods/workspace-chrome/square.svg'], ['2'], '2 open todos']]);
    expect(output.text).toEqual(['planner', '1', '2', '12']);
  });
});
