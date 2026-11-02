// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, test } from 'vitest';
import { runPanelScene } from './acceptance/i.js';
import { describePanelProblems, panelConfigProblem } from '../../assets/mods/spider/data.js';
import type { SessionFeed, CoreId, TerminalId, TerminalAddress } from '../contracts.js';

function feed(id: string): SessionFeed {
  return {
    version: 1, sessionId: id as SessionFeed['sessionId'], generation: 'generation' as SessionFeed['generation'], revision: 1, updatedAt: Date.now(),
    owner: { sessionId: id as SessionFeed['sessionId'], generation: 'generation' as SessionFeed['generation'],
      terminal: { coreId: 'core' as CoreId, terminalId: id as TerminalId, address: id as TerminalAddress, socket: '/fixture/socket', sessionNamespace: 'fixture' },
      cwd: '/fixture', sessionFile: null, name: id },
    placement: null, lifecycle: 'live', status: { native: 'idle', effective: 'idle', message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'No counters' },
    approvals: [], notifications: [], ipc: { address: '/fixture/ipc', capabilityFile: '/fixture/capability' }, errors: [],
  };
}

interface Seen { text: string[]; disabled: string[]; code: string[]; ids: string[]; red: number; calls: unknown[] }
// Every scene reports visible text, disabled controls, inline code, element ids and red marks.
const report = `const walk=(el,f)=>{if(!el||typeof el!=='object')return;f(el);for(const c of el.items||[])walk(c,f);};
  const seen=tree=>{const disabled=[],code=[],ids=[];let red=0;walk(tree,el=>{const id=el.styles?.id?.[0];if(id)ids.push(id);
    if(el.styles?.disabled?.[0]===true)disabled.push(id??'?');if(el.styles?.bg?.[0]==='#ffffff12')code.push(texts(el).join(''));
    if(el.styles?.text_color?.[0]==='#ff6b6b')red++;});return {text:texts(tree),disabled,code,ids,red};};`;
const scene = (body: string, fixture: SessionFeed = feed('planner')) => runPanelScene<Seen>(`${report}const calls=[];${body}`, fixture);
const snapshot = (feeds: string, errors: string) => `api.exec=async(cmd,args)=>{calls.push(args[1]??args[0]);return {code:0,stdout:JSON.stringify({feeds:${feeds},errors:${errors}}),stderr:''};};`;

describe('the panel cannot start', () => {
  test.each([
    ['a relative path', `props.feedRoot='relative';`, 'feedRoot'],
    ['no layout props', `api.props=()=>null;`, 'feedRoot'],
  ])('with %s it shows one whole-panel state with the fix as inline code', async (_name, setup, key) => {
    const output = await scene(`${setup}api.exec=async(...args)=>{calls.push(args);return {code:0,stdout:'{}',stderr:''};};
      initView(panel,cx);if(tasks[0])await tasks[0];console.log(JSON.stringify({...seen(panel.render(cx)),calls}));`);
    const text = output.text.join(' ');
    expect(output.text).toContain("Spider panel can't start");
    expect(text).toContain('/herdr-setup');
    expect(output.code).toContain('/herdr-setup');
    expect(text).toContain(key);
    // Only the failure icon is red; there is nothing else to act on.
    expect(output.red).toBe(1);
    expect(text).not.toMatch(/Sessions|No live sessions|Run doctor|unavailable:|Usage unavailable|·/);
    expect(output.ids).not.toContain('spider-doctor'); expect(output.ids).not.toContain('spider-sessions');
    expect(output.disabled).toEqual([]); expect(output.calls).toEqual([]);
  });
});

describe('runtime problems', () => {
  test('one group at the top, plain sentences, merged duplicates and a +N more overflow', async () => {
    const output = await scene(`${snapshot('files', `[{source:'a',message:'unsafe-feed-path'},{source:'b',message:'unsafe-feed-path'},{source:'c',message:'feed-too-large'},
      {source:'d',message:'EACCES'},{source:'sessions',message:'Snapshot truncated: feed total exceeds reply limit'}]`)}
      initView(panel,cx);await tasks[0];panel.unavailable('Run view','Owner endpoint unavailable',cx);panel.unavailable('Run view','Owner endpoint unavailable',cx);
      const closed=panel.render(cx);const scroll=byId(closed,'spider-scroll');const first=scroll.items.find(Boolean)?.styles?.id?.[0];
      byId(closed,'spider-problems-more').events.on_click({},cx);const open=panel.render(cx);
      console.log(JSON.stringify({closed:{...seen(byId(closed,'spider-problems')),first},open:seen(byId(open,'spider-problems')),all:seen(open)}));`) as unknown as { closed: Seen & { first: string }; open: Seen; all: Seen };
    expect(output.closed.first).toBe('spider-problems');
    expect(output.closed.text).toEqual([
      "Spider skipped 2 session feeds that are links or special files.",
      "Spider skipped a session feed larger than 1 MB.",
      "Spider couldn't read a session feed.",
      '+2 more',
    ]);
    expect(output.closed.red).toBe(3);
    expect(output.open.text).toEqual([
      "Spider skipped 2 session feeds that are links or special files.",
      "Spider skipped a session feed larger than 1 MB.",
      "Spider couldn't read a session feed.",
      'Some older sessions are hidden because their feeds exceed what the panel reads at once.',
      "The run's output didn't open. Its pi session isn't reachable.",
      'Show fewer',
    ]);
    expect(output.all.text.join(' ')).not.toMatch(/unavailable:|unsafe-feed-path|feed-too-large|EACCES|·/);
    // Feeds that were read still list their sessions.
    expect(output.all.text).toContain('planner'); expect(output.all.text).not.toContain('No live sessions');
  });
  test('a doctor timeout gives the command to run as inline code, not a disabled button', async () => {
    const output = await scene(`files.splice(0);api.exec=async(_c,args)=>{if(args[1]==='doctor')throw new Error('Timed out');return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};};
      initView(panel,cx);await tasks[0];byId(panel.render(cx),'spider-doctor').events.on_click({},cx);await drain();console.log(JSON.stringify(seen(byId(panel.render(cx),'spider-problems'))));`);
    expect(output.text.join(' ')).toContain("Doctor didn't finish within 30 seconds. Run it in a shell for the full report.");
    expect(output.code).toEqual(['/fixture/node /fixture/cli.mjs doctor --config /fixture/config.json']);
    expect(output.disabled).toEqual([]); expect(output.text.join(' ')).not.toContain('Timed out');
  });
  test('notification failures and watch failures read as sentences', async () => {
    const output = await scene(`initView(panel,cx);await tasks[0];panel.unavailable('Feed watch','EMFILE',cx);panel.unavailable('Notification action','Owner unavailable',cx);
      panel.unavailable('Run view','Owner endpoint unavailable',cx);console.log(JSON.stringify(seen(byId(panel.render(cx),'spider-problems'))));`);
    expect(output.text).toEqual([
      "Spider can't watch for session changes. It rereads the feeds every 8 seconds instead.",
      "The notice's action didn't run. Its pi session isn't reachable.",
      "The run's output didn't open. Its pi session isn't reachable.",
    ]);
  });
  test('problems survive a feed reload for a minute; a broken watch stays until the watch works', async () => {
    const output = await scene(`let now=Date.now();Date.now=()=>now;initView(panel,cx);await tasks[0];
      panel.unavailable('Run view','Owner endpoint unavailable',cx);panel.watchFailed=true;panel.unavailable('Feed watch','EMFILE',cx);
      await panel.reload(cx);const kept=texts(byId(panel.render(cx),'spider-problems'));
      now+=61000;await panel.reload(cx);const later=texts(byId(panel.render(cx),'spider-problems'));
      panel.watchFailed=false;await panel.reload(cx);console.log(JSON.stringify({kept,later,gone:byId(panel.render(cx),'spider-problems')===undefined}));`) as unknown as { kept: string[]; later: string[]; gone: boolean };
    expect(output.kept).toEqual(["The run's output didn't open. Its pi session isn't reachable.", "Spider can't watch for session changes. It rereads the feeds every 8 seconds instead."]);
    expect(output.later).toEqual(["Spider can't watch for session changes. It rereads the feeds every 8 seconds instead."]);
    expect(output.gone).toBe(true);
  });
  test('a session feed\'s own errors read as sentences inside its row', async () => {
    const fixture = feed('planner'); fixture.errors = [{ source: 'jobs', message: 'Owned job journal is unavailable.' }, { source: 'placement', message: 'Observed owner placement is unavailable.' }];
    const output = await scene(`initView(panel,cx);await tasks[0];panel.expanded.add('planner');console.log(JSON.stringify(seen(byId(panel.render(cx),'session-planner'))));`, fixture);
    expect(output.text).toContain("Spider can't read this session's commands.");
    expect(output.text).toContain("Spider can't tell which space this session is in.");
    expect(output.text.join(' ')).not.toMatch(/unavailable:/);
    expect(output.red).toBe(2);
  });
});

describe('the Sessions list', () => {
  test.each([
    ['the reader fails', `api.exec=async(cmd,args)=>{if(args[1]==='doctor'){calls.push('doctor');return {code:0,stdout:'Doctor report',stderr:''};}return {code:1,stdout:'',stderr:'boom'};};`],
    ['the sessions folder cannot be listed', snapshot('[]', `[{source:'sessions',message:'EACCES'}]`).replace('calls.push(args[1]??args[0]);', "if(args[1]==='doctor'){calls.push('doctor');return {code:0,stdout:'Doctor report',stderr:''};}")],
  ])('says the feeds could not be read when %s, never "No live sessions", and doctor works', async (_name, setup) => {
    const output = await scene(`${setup}initView(panel,cx);await tasks[0];const tree=panel.render(cx);const before=seen(byId(tree,'spider-sessions'));
      byId(tree,'spider-doctor').events.on_click({},cx);await drain();console.log(JSON.stringify({...before,calls,after:texts(panel.render(cx))}));`) as Seen & { after: string[] };
    expect(output.text).toContain("Spider couldn't read the session feeds, so sessions may be missing here.");
    expect(output.text.join(' ')).not.toMatch(/No live sessions|No sessions in this space/);
    expect(output.disabled).toEqual([]); expect(output.calls).toEqual(['doctor']);
    expect(output.after.join(' ')).toContain('Doctor report');
  });
  test('says no feed could be read when every feed was skipped', async () => {
    const output = await scene(`files.splice(0,1,'{broken');initView(panel,cx);await tasks[0];console.log(JSON.stringify(seen(panel.render(cx))));`);
    expect(output.text).toContain("Spider couldn't read any session feed.");
    expect(output.text).toContain("Spider skipped a session feed it couldn't parse.");
    expect(output.text).not.toContain('No live sessions');
  });
  test('says "No live sessions" only after a clean read with no feeds, with an enabled doctor action', async () => {
    const output = await scene(`files.splice(0);initView(panel,cx);await tasks[0];console.log(JSON.stringify(seen(panel.render(cx))));`);
    expect(output.text).toContain('No live sessions'); expect(output.ids).toContain('spider-doctor');
    expect(output.ids).not.toContain('spider-problems'); expect(output.disabled).toEqual([]);
  });
});

describe('problem projections', () => {
  test('cap the visible rows and count the rest', () => {
    const errors = ['Run view', 'Job output', 'View action', 'Notifications', 'Feed watch'].map(source => ({ source, message: 'x' }));
    const problems = describePanelProblems(errors, { limit: 3 });
    expect(problems.rows).toHaveLength(3); expect(problems.more).toBe(2);
    expect(describePanelProblems(errors, { limit: 10 }).more).toBe(0);
  });
  test('name the bad keys in the technical line', () => {
    expect(panelConfigProblem({ feedRoot: '/a', cliPath: 'b', nodePath: '/c', configPath: '/d/../e' })?.detail).toBe('Not absolute paths in the layout props: cliPath, configPath.');
    expect(panelConfigProblem({ feedRoot: '/a', cliPath: '/b', nodePath: '/c', configPath: '/d' })).toBeNull();
  });
});
