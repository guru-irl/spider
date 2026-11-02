// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, test } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { checkSpiderPanel } from './panel-app-check.mjs';
import { runPanelScene } from './acceptance/i.js';
import type { SessionFeed, CoreId, TerminalId, TerminalAddress, SpaceId } from '../contracts.js';
import { projectSpiderPanel, panelSessionState } from '../../assets/mods/spider/data.js';

function feed(id: string): SessionFeed {
  return {
    version: 1, sessionId: id as SessionFeed['sessionId'], generation: 'generation' as SessionFeed['generation'], revision: 1, updatedAt: 1000,
    owner: { sessionId: id as SessionFeed['sessionId'], generation: 'generation' as SessionFeed['generation'],
      terminal: { coreId: 'core' as CoreId, terminalId: id as TerminalId, address: id as TerminalAddress, socket: '/fixture/socket', sessionNamespace: 'fixture' },
      cwd: '/fixture', sessionFile: null, name: id },
    placement: null, lifecycle: 'live', status: { native: 'idle', effective: 'idle', message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'No counters' },
    approvals: [{ uuid: 'approval', scope: 'global', repoKey: null, ownerSessionId: null, category: 'insight', preview: 'Review this' }],
    notifications: [], ipc: { address: '/fixture/ipc', capabilityFile: '/fixture/capability' }, errors: [],
  };
}

const scene = <T = string[]>(body: string) => runPanelScene<T>(body, feed('fixture'));

const fileScene = (setup: string) => scene<{ids: string[]; errors: {message: string}[]}>(`props.nodePath=process.execPath; props.feedRoot=path.join(path.dirname(m.identifier),'feeds');
  await fs.mkdir(path.join(props.feedRoot,'sessions','fixture'),{recursive:true});
  const file=path.join(props.feedRoot,'sessions','fixture','session.json'); ${setup}
  const {execFile}=await import('node:child_process'); api.exec=(cmd,args)=>new Promise((resolve,reject)=>execFile(cmd,args,{maxBuffer:8*1024*1024,env:{...process.env,TMPDIR:path.dirname(m.identifier)}},(error,stdout,stderr)=>error?reject(error):resolve({code:0,stdout,stderr})));
  initView(panel,cx);await tasks[0];console.log(JSON.stringify({ids:panel.feeds.map(f=>f.sessionId),errors:panel.errors}));`);

describe('Spider panel', () => {
  test('native check is headless and fences its app, state, config and temporary homes', async () => {
    const scratch = resolve('.spider/scratch'); await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, 'panel-check-'));
    try {
      const binary = join(root, 'check-only.mjs'), appHome = join(root, 'app');
      await writeFile(binary, `#!${process.execPath}\nimport fs from 'node:fs';\nconst argv=process.argv.slice(2);if(argv[0]!=='check')throw new Error('Only headless check allowed');\nconsole.log(JSON.stringify({argv,home:process.env.HERDR_APP_HOME,state:process.env.XDG_STATE_HOME,config:process.env.XDG_CONFIG_HOME,tmp:process.env.TMPDIR,settings:JSON.parse(fs.readFileSync(process.env.HERDR_APP_HOME+'/settings.json','utf8'))}));console.error('check passed');`, { mode: 0o700 });
      const result = await checkSpiderPanel({ appBinary: binary, appHome, feed: feed('fixture') });
      const observed = JSON.parse(result.stdout);
      expect(observed.argv).toEqual(['check', join(appHome, 'probe'), '--print-spec']);
      expect(observed.home).toBe(appHome); expect(observed.settings.core).toBe('/usr/bin/false');
      for (const path of [observed.state, observed.config, observed.tmp]) expect(path.startsWith(appHome + '/')).toBe(true);
      expect(result.stderr).toContain('check passed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('native check rejects a symlinked test root before creating an app home', async () => {
    const scratch = resolve('.spider/scratch'); await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, 'panel-fence-'));
    try {
      const workspace = join(root, 'workspace'), target = join(root, 'target');
      await mkdir(join(workspace, '.spider'), { recursive: true }); await mkdir(target);
      await symlink(target, join(workspace, '.spider/scratch'));
      const source = `import {checkSpiderPanel} from ${JSON.stringify(new URL('./panel-app-check.mjs', import.meta.url).href)};
        try {await checkSpiderPanel({appBinary:'/fixture/app',appHome:${JSON.stringify(join(workspace, '.spider/scratch/app'))},feed:${JSON.stringify(feed('fixture'))}});}catch(error){console.log(error.message);}`;
      const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { cwd: workspace, env: { ...process.env, TMPDIR: root } });
      expect(result.stdout).toContain('fenced');
      expect(await stat(join(target, 'app')).then(() => true, () => false)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('native check refuses an app home outside project test data', async () => {
    await expect(checkSpiderPanel({ appBinary: '/fixture/app', appHome: '/fixture/not-test-data', feed: feed('fixture') })).rejects.toThrow('fenced');
  });
  test('rejects Button imported from the wrong UI module', async () => {
    await expect(runPanelScene(`console.log(JSON.stringify([]));`, feed('fixture'), source =>
      source.replace(/import \{[^}]*\} from 'gpui-kit';/, "import { View, div, svg, Button } from 'gpui-kit';")
        .replace(/import \{[^}]*\} from 'gpui-base';/, "import { v_flex, h_flex } from 'gpui-base';"))).rejects.toThrow('Button');
  });
  test('rejects nonexistent element methods', async () => {
    await expect(scene(`panel.button('invalid','Invalid',true,()=>{}).label('Invalid');console.log(JSON.stringify([]));`)).rejects.toThrow('label');
  });
  test('rejects non-hex background colors', async () => {
    await expect(scene(`panel.button('invalid','Invalid',true,()=>{}).bg('transparent');console.log(JSON.stringify([]));`)).rejects.toThrow();
  });
  test('live runs are a session fact, not a run list (the sidebar shows runs)', async () => {
    const output=await scene<{text: string[]; facts: string[]}>(`const f=JSON.parse(files[0]);f.runs={rows:[
      {id:'print',ownerSessionId:'fixture',name:'Print child',status:'running',childMode:'print',canSteer:false,startedAt:1,finishedAt:null,viewer:null,result:null},
      {id:'rpc',ownerSessionId:'fixture',name:'RPC child',status:'running',childMode:'rpc',canSteer:true,startedAt:1,finishedAt:null,viewer:null,result:null}],total:2,truncated:false};
      files[0]=JSON.stringify(f);initView(panel,cx);await tasks[0];panel.expanded.add('fixture');const tree=panel.render(cx);
      console.log(JSON.stringify({text:texts(tree),facts:byId(tree,'facts-fixture').items.map(f=>f.styles.tooltip[0])}));`);
    expect(output.facts).toContain('2 live subagents');
    expect(output.text.join(' ')).not.toMatch(/Print child|RPC child|Can steer|Read-only|\/fixture/);
  });
  test('shows only the shown space\'s sessions, without naming the space, and follows a space switch', async () => {
    const output=await scene<{first: string[]; second: string[]; mono: string[]}>(`const a=JSON.parse(files[0]),b=JSON.parse(files[0]);a.updatedAt=b.updatedAt=Date.now();
      b.sessionId=b.owner.sessionId='other';b.owner.name='other';b.owner.terminal.address='other';
      a.placement={spaceId:'space-a',spaceName:'alpha',spaceOrder:0,tabId:null};b.placement={spaceId:'space-b',spaceName:'beta',spaceOrder:1,tabId:null};
      files.splice(0,1,JSON.stringify(a),JSON.stringify(b));globalThis.sceneSpaces=[{id:'space-a',name:'alpha',active:true},{id:'space-b',name:'beta',active:false}];
      initView(panel,cx);await tasks[0];const first=texts(panel.render(cx));
      globalThis.sceneSpaces=[{id:'space-a',name:'alpha',active:false},{id:'space-b',name:'beta · rfc',active:true}];const tree=panel.render(cx);
      console.log(JSON.stringify({first,second:texts(tree),mono:[byId(tree,'spider-space')===undefined?'none':'line',byId(tree,'session-head-other').items[1].styles.font_family[0]]}));`);
    expect(output.first).toContain('fixture'); expect(output.first).not.toContain('other');
    expect(output.second).toContain('other'); expect(output.second).not.toContain('fixture');
    // No space line: neither the space's name nor "this space" appears.
    for (const text of [output.first, output.second]) expect(text.join(' ')).not.toMatch(/alpha|beta|[Tt]his space|All spaces/);
    expect(output.second).toContain('Sessions'); expect(output.second.join(' ')).not.toMatch(/Space \d|Unplaced/);
    expect(output.mono).toEqual(['none', 'JetBrains Mono']);
  });
  test('close cancels the mod-owned clock timer as well as watch and commands', async () => {
    const output = await scene(`const canceled=[];cx.timer.every=(n,f)=>{timers.push({n,f});return {cancel:()=>canceled.push('timer')};};
      initView(panel,cx);await tasks[0];panel.close();console.log(JSON.stringify(canceled));`);
    expect(output).toEqual(['timer']);
  });
  test('watch bursts coalesce into at most one reload per second without another timer', async () => {
    const output = await scene<{ reads: number[]; timers: number[] }>(`let now=10000;Date.now=()=>now;let reads=0;const samples=[],release=[];let registered;
      api.exec=async()=>{reads++;return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};};
      api.watchFolder=()=>{registered?.();return new Promise(resolve=>release.push(resolve));};
      initView(panel,cx);await tasks[0];samples.push(reads);
      for(let i=0;i<3;i++){const ready=new Promise(resolve=>registered=resolve);release.shift()([]);await ready;}samples.push(reads);
      now+=1001;timers[0].f(cx);await drain();samples.push(reads);
      console.log(JSON.stringify({reads:samples,timers:timers.map(t=>t.n)}));`);
    expect(output.reads).toEqual([2,2,3]); expect(output.timers).toEqual([2000]);
  });
  test('overlapping snapshot requests retain exactly one trailing reload and never overlap Node processes', async () => {
    const output = await scene<{ reads: number[]; maxActive: number }>(`let now=10000;Date.now=()=>now;let reads=0,active=0,maxActive=0,release;const samples=[];
      api.exec=async()=>{reads++;active++;maxActive=Math.max(maxActive,active);try{return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};}finally{active--;}};
      initView(panel,cx);await tasks[0];samples.push(reads);
      api.exec=async()=>{reads++;active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>release=resolve);active--;return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};};
      const loading=panel.reload(cx);await Promise.resolve();samples.push(reads);
      await Promise.all([panel.reload(cx),panel.reload(cx),panel.reload(cx)]);now+=1001;timers[0].f(cx);await Promise.resolve();samples.push(reads);
      release();await loading;
      api.exec=async()=>{reads++;active++;maxActive=Math.max(maxActive,active);active--;return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};};
      timers[0].f(cx);await drain();samples.push(reads);now+=2000;timers[0].f(cx);await drain();samples.push(reads);
      console.log(JSON.stringify({reads:samples,maxActive}));`);
    expect(output.reads).toEqual([2, 3, 3, 4, 4]); expect(output.maxActive).toBe(1);
  });
  test('a watch reload just before the clock tick cannot trigger a duplicate timer read', async () => {
    const output = await scene<number[]>(`let now=10000;Date.now=()=>now;let reads=0;const samples=[],release=[];let registered;
      api.exec=async()=>{reads++;return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};};
      api.watchFolder=()=>{registered?.();return new Promise(resolve=>release.push(resolve));};
      async function change(){const ready=new Promise(resolve=>registered=resolve);release.shift()([]);await ready;await Promise.resolve();await Promise.resolve();}
      initView(panel,cx);await tasks[0];await change();now+=1000;await change();samples.push(reads);
      now+=1;timers[0].f(cx);await drain();samples.push(reads);console.log(JSON.stringify(samples));`);
    expect(output).toEqual([3,3]);
  });
  test('close cancels only the mod-owned folder watch and notification listener', async () => {
    const output=await scene(`const canceled=[];cx.spawn=f=>{const p=f(cx);p.cancel=()=>canceled.push(p===panel.watchTask?'watch':p===panel.commandTask?'commands':'other');tasks.push(p);return p;};initView(panel,cx);await tasks[0];panel.close();console.log(JSON.stringify(canceled));`);
    expect(output).toEqual(['watch','commands']);
  });
  test('packaged view actions carry only canonical paths and owner generation', async () => {
    const output=await scene<{calls:string[][];commands:unknown[]}>(`const f=JSON.parse(files[0]);f.updatedAt=Date.now();files[0]=JSON.stringify(f);const calls=[];
      api.exec=async(cmd,args)=>{if(args[1]==='ipc'){calls.push([cmd,...args]);const request=JSON.parse(args[5]);return {code:0,stdout:JSON.stringify(request.op==='ping'?{ok:true,op:'ping',status:{native:'idle',effective:'idle'}}:{ok:true,op:request.op}),stderr:''};}return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};};
      initView(panel,cx);await tasks[0];panel.expanded.add('fixture');byId(panel.render(cx),'view-fixture-todos').events.on_click({},cx);await drain();console.log(JSON.stringify({calls,commands}));`);
    expect(output.calls.map(argv=>[argv[0],argv[1],argv[2],argv[3],JSON.parse(argv[4]),argv[5],JSON.parse(argv[6])])).toEqual([
      ['/fixture/node','/fixture/cli.mjs','ipc','--descriptor',{version:1,sessionId:'fixture',generation:'generation',address:'/fixture/ipc',capabilityFile:'/fixture/capability'},'--request',{op:'ping',generation:'generation'}],
      ['/fixture/node','/fixture/cli.mjs','ipc','--descriptor',{version:1,sessionId:'fixture',generation:'generation',address:'/fixture/ipc',capabilityFile:'/fixture/capability'},'--request',{op:'openView',view:'todos',generation:'generation'}],
    ]);
    expect(output.commands).toEqual([]);
  });
  test('a working session shows no status spinner in the panel (the sidebar shows status), with no extra refresh timers', async () => {
    const output=await scene<{spinner: boolean; timers: number[]}>(`const f=JSON.parse(files[0]);f.updatedAt=Date.now();f.status.effective='working';files[0]=JSON.stringify(f);initView(panel,cx);await tasks[0];
      const spins=el=>Boolean(el?.styles?.spin)||(el?.items||[]).some(spins);
      console.log(JSON.stringify({spinner:spins(panel.render(cx)),timers:timers.map(t=>t.n)}));`);
    expect(output.spinner).toBe(false);expect(output.timers).toEqual([2000]);
  });
  test('doctor timeouts explain the command limit and the full-report alternative', async () => {
    const output = await scene(`files.splice(0);api.exec=async(_command,args)=>{if(args[1]==='doctor')throw new Error('Timed out');return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};};
      initView(panel,cx);await tasks[0];byId(panel.render(cx),'spider-doctor').events.on_click({},cx);await drain();console.log(JSON.stringify(texts(panel.render(cx))));`);
    expect(output.join(' ')).toContain('30 seconds'); expect(output.join(' ')).toContain('/fixture/node /fixture/cli.mjs doctor --config /fixture/config.json');
  });
  test('missing feeds offer doctor through the configured CLI without pane focus', async () => {
    const output=await scene<{calls: string[][]; commands: unknown[]; text: string[]}>(`files.splice(0);const calls=[];
      api.exec=async(cmd,args)=>{if(args[1]==='doctor'){calls.push([cmd,...args]);return {code:0,stdout:'Doctor report',stderr:''};}return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};};
      initView(panel,cx);await tasks[0];const button=byId(panel.render(cx),'spider-doctor');if(button)button.events.on_click({},cx);await drain();console.log(JSON.stringify({calls,commands,text:texts(panel.render(cx))}));`);
    expect(output.calls).toEqual([['/fixture/node','/fixture/cli.mjs','doctor','--config','/fixture/config.json']]);
    expect(output.commands).toEqual([]);expect(output.text.join(' ')).toContain('Doctor report');
  });
  test('a slim pace bar pinned to the bottom, with dashboard details on hover, and no This month section', async () => {
    const output=await scene<{text: string[]; last: string | null; used: string; projection: boolean; closed: boolean; open: string[]; over: string[]}>(`const f=JSON.parse(files[0]);const now=Date.now();
      f.pace={scope:'shared',used:1284,budget:5000,projected:null,remaining:3716,periodStart:now-86400000,periodEnd:now+86400000,updatedAt:now-4*60000,unavailableReason:null,
        labels:{month:'NOV 2026',usedCompact:'1.3k',used:'1,284',projected:'unavailable',budget:'5,000',remaining:'3,716',updatedAt:'Sun 15 NOV 17:26'}};files[0]=JSON.stringify(f);
      initView(panel,cx);await tasks[0];const tree=panel.render(cx);
      const root=tree.items, bar=byId(tree,'spider-pace');bar.events.on_hover(true,cx);const open=panel.render(cx);
      f.pace.used=5600;f.pace.projected=9000;f.pace.labels={...f.pace.labels,projected:'9,000'};files[0]=JSON.stringify(f);await panel.reload(cx);
      console.log(JSON.stringify({text:texts(tree),last:root.at(-1)?.styles?.id?.[0]??null,used:byId(tree,'pace-used').styles.w[0]+'|'+byId(tree,'pace-now').styles.left[0],projection:Boolean(byId(tree,'pace-projection')),
        closed:byId(tree,'pace-popover')===undefined,open:texts(byId(open,'pace-popover')),over:texts(panel.render(cx))}));`);
    // The bar is the root's last child, outside the scrolling list, so it stays visible.
    expect(output.last).toBe('spider-pace'); expect(output.used).toBe('25.68%|25.68%'); expect(output.projection).toBe(false);
    expect(output.text).toEqual(expect.arrayContaining(['NOV', '1.3k'])); expect(output.text.join(' ')).not.toMatch(/This month|All spaces|\d{4}-\d\d-\d\dT/);
    expect(output.closed).toBe(true);
    expect(output.open).toEqual(['NOV 2026', 'Used', '1,284', 'Projected month end', 'unavailable', 'Budget', '5,000', 'Remaining', '3,716', 'On pace for the budget', 'Updated Sun 15 NOV 17:26 (4m ago)']);
    expect(output.over).toEqual(expect.arrayContaining(['Over budget pace', 'projected 9,000 of 5,000']));
  });
  test('shared repository approval actions use a matching endpoint without inventing ownership', async () => {
    const output=await scene<{opened: string[][]; commands: unknown[]}>(`const a=JSON.parse(files[0]),b=JSON.parse(files[0]);a.updatedAt=b.updatedAt=Date.now();b.sessionId=b.owner.sessionId='other';b.owner.terminal.address='other';
      a.approvals=[{uuid:'approval',scope:'repo',repoKey:'repo-a',ownerSessionId:null,category:'insight',preview:'First'}];b.approvals=[{uuid:'approval',scope:'repo',repoKey:'repo-b',ownerSessionId:null,category:'insight',preview:'Second'}];files.splice(0,1,JSON.stringify(a),JSON.stringify(b));
      a.approvals=[];files.splice(0,1,JSON.stringify(a),JSON.stringify(b));
      const opened=[];panel.actions={ping:async()=>true,openView:async(feed,view)=>opened.push([feed.sessionId,view])};initView(panel,cx);await tasks[0];
      const button=byId(panel.render(cx),'need-memory');if(button)button.events.on_click({},cx);await drain();console.log(JSON.stringify({opened,commands}));`);
    expect(output.opened).toEqual([['other','memory']]);expect(output.commands).toEqual([]);
  });
  test('failed-run Output reuses displayed viewers and focuses returned saved-view IDs', async () => {
    const output=await scene<{opened: string[][]; commands: unknown[]}>(`const f=JSON.parse(files[0]);f.updatedAt=Date.now();f.runs={total:2,truncated:false,rows:[
      {id:'live-run',ownerSessionId:'fixture',name:'Live',status:'failed',childMode:'rpc',canSteer:false,startedAt:1,finishedAt:Date.now()-1000,viewer:'displayed',result:'exit 1'},
      {id:'saved-run',ownerSessionId:'fixture',name:'Saved',status:'failed',childMode:'print',canSteer:false,startedAt:1,finishedAt:Date.now()-2000,viewer:'parked',result:'Failed'}]};
      files[0]=JSON.stringify(f);api.panes=()=>[{pane:'viewer-pane',terminal:'displayed'}];const opened=[];
      panel.actions={ping:async()=>true,openRun:async(feed,id)=>{opened.push([feed.sessionId,id]);return 'returned-viewer';},openView:async()=>{}};
      initView(panel,cx);await tasks[0];panel.expanded.add('fixture');const tree=panel.render(cx);
      for(const id of ['need-run:live-run','need-run:saved-run']){const button=byId(tree,id);if(button)button.events.on_click({},cx);}await drain();
      console.log(JSON.stringify({opened,commands}));`);
    expect(output.opened).toEqual([['fixture','saved-run']]);
    expect(output.commands).toEqual([{name:'pane.focus',args:{terminal:'displayed'}},{name:'pane.focus',args:{terminal:'returned-viewer'}}]);
  });
  test('view action failures stay visible and never focus or type into a terminal', async () => {
    const output=await scene<{opened: string[][]; commands: unknown[]; text: string[]}>(`const f=JSON.parse(files[0]);f.updatedAt=Date.now();files[0]=JSON.stringify(f);const opened=[];
      panel.actions={ping:async feed=>feed.sessionId==='fixture',openView:async(feed,view)=>{opened.push([feed.sessionId,view]);throw new Error('View unavailable');}};
      initView(panel,cx);await tasks[0];panel.expanded.add('fixture');const button=byId(panel.render(cx),'view-fixture-todos');if(button)button.events.on_click({},cx);await drain();
      console.log(JSON.stringify({opened,commands,text:texts(panel.render(cx))}));`);
    expect(output.opened).toEqual([['fixture','todos']]); expect(output.commands).toEqual([]);expect(output.text.join(' ')).toContain("The view didn't open in pi.");
  });
  test('session focus targets the recorded terminal and stale rows cannot redirect it', async () => {
    const output=await scene(`const f=JSON.parse(files[0]);f.updatedAt=Date.now();files[0]=JSON.stringify(f);initView(panel,cx);await tasks[0];
      const tree=panel.render(cx);const focus=byId(tree,'focus-fixture');if(focus)focus.events.on_click({},cx);
      f.updatedAt=1;files[0]=JSON.stringify(f);await panel.reload(cx);const stale=byId(panel.render(cx),'focus-fixture');if(stale)stale.events.on_click({},cx);
      console.log(JSON.stringify(commands));`);
    expect(output).toEqual([{name:'pane.focus',args:{terminal:'fixture'}}]);
  });
  test('no Spider/Machines switch; close affects layout only, preserving terminal focus', async () => {
    const output=await scene<{commands: unknown[]; tabs: boolean[]; text: string[]}>(`initView(panel,cx);await tasks[0];const tree=panel.render(cx);byId(tree,'panel-close').events.on_click({},cx);
      console.log(JSON.stringify({commands,tabs:['panel-spider','panel-machines'].map(id=>byId(tree,id)!==undefined),text:texts(tree)}));`);
    expect(output.commands).toEqual([{name:'layout.hide',args:{id:'panel'}}]);
    expect(output.tabs).toEqual([false, false]); expect(output.text).not.toContain('Machines');
  });
  test('reloads after registering the feed-only watch so startup changes are not lost', async () => {
    const output=await scene<{watched: string[]; text: string[]; timers: number[]}>(`const watched=[]; api.watchFolder=async root=>{watched.push(root);const f=JSON.parse(files[0]);f.owner.name='Changed';files[0]=JSON.stringify(f);return new Promise(()=>{});};
      initView(panel,cx);await tasks[0];console.log(JSON.stringify({watched,text:texts(panel.render(cx)),timers:timers.map(t=>t.n)}));`);
    expect(output.watched).toEqual(['/fixture/feeds/sessions']); expect(output.text.join(' ')).toContain('Changed');
    expect(output.timers).toEqual([2000]);
  });
  test('reads its layout props from herdr props(), the only place the real app supplies them', async () => {
    const output=await scene<{called: string[]; ids: string[]; text: string[]}>(`const called=[];api.exec=async (cmd,args)=>{called.push(cmd,args[2]);return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};};
      initView(panel,cx);await tasks[0];console.log(JSON.stringify({called,ids:panel.feeds.map(f=>f.sessionId),text:texts(panel.render(cx))}));`);
    expect(output.called.slice(0, 2)).toEqual(['/fixture/node', '/fixture/feeds']);
    expect(output.ids).toEqual(['fixture']);
    expect(output.text.join(' ')).not.toMatch(/Configuration|can't start|must be absolute/);
  });
  test('invalid layout paths disable loading instead of inheriting an application environment', async () => {
    const output=await scene<{called: unknown[]; text: string[]}>(`props.feedRoot='relative';const called=[];api.exec=async (...args)=>{called.push(args);return {code:0,stdout:JSON.stringify({feeds:files,errors:[]}),stderr:''};};
      initView(panel,cx);if(tasks[0])await tasks[0];console.log(JSON.stringify({called,text:texts(panel.render(cx))}));`);
    expect(output.called).toEqual([]); expect(output.text.join(' ')).toContain('/herdr-setup');
  });
  test('refuses a symlinked session file without reading its target', async () => {
    const output=await fileScene(`await fs.writeFile(file+'.target',files[0]);await fs.symlink(file+'.target',file);`);
    expect(output.ids).toEqual([]); expect(output.errors).toMatchObject([{message:'unsafe-feed-path'}]);
  });
  test.each([
    `await fs.mkdir(file);`,
    `const {execFile:mkfifo}=await import('node:child_process');const {promisify}=await import('node:util');await promisify(mkfifo)('/usr/bin/mkfifo',[file]);`,
    `await fs.writeFile(file,files[0]);await fs.symlink(props.feedRoot,props.feedRoot+'-link');props.feedRoot+='-link';`,
    `const target=path.join(props.feedRoot,'outside-fixture');await fs.rename(path.dirname(file),target);await fs.writeFile(path.join(target,'session.json'),files[0]);await fs.symlink(target,path.dirname(file));`,
    `await fs.writeFile(file,files[0]);const sessions=path.dirname(path.dirname(file));await fs.rename(sessions,sessions+'-target');await fs.symlink(sessions+'-target',sessions);`,
  ])('refuses directories, FIFOs and symlinked roots or ancestors without hanging: case %#', async setup => {
    const output = await fileScene(setup);
    expect(output.ids).toEqual([]); expect(output.errors).toMatchObject([{ message: 'unsafe-feed-path' }]);
  });
  test('accepts an exactly one-MiB feed', async () => {
    const output = await fileScene(`await fs.writeFile(file,files[0]+' '.repeat(1024*1024-Buffer.byteLength(files[0])));`);
    expect(output.ids).toEqual(['fixture']); expect(output.errors).toEqual([]);
  });
  test('invalid feed errors identify the session directory', async () => {
    const output = await fileScene(`await fs.writeFile(file,'{broken');`);
    expect(output.ids).toEqual([]); expect(output.errors).toMatchObject([{ source: 'fixture', message: 'Unavailable: invalid feed' }]);
  });
  test('refuses a feed over one MiB before returning its contents', async () => {
    const output=await fileScene(`await fs.writeFile(file,files[0]+' '.repeat(1024*1024));`);
    expect(output.ids).toEqual([]); expect(output.errors).toMatchObject([{message:'feed-too-large'}]);
  });
  test('returns every live feed when newer stale feeds alone exhaust the reply budget', async () => {
    const output = await fileScene(`await fs.rm(path.dirname(file),{recursive:true});
      const base=JSON.parse(files[0]), now=Date.now();
      for(let i=0;i<8;i++) {const f=structuredClone(base);f.sessionId=f.owner.sessionId='a-stale-'+i;f.updatedAt=1;f.lifecycle='closed';f.padding='x'.repeat(900000);
        const dir=path.join(props.feedRoot,'sessions',f.sessionId);await fs.mkdir(dir,{recursive:true});const target=path.join(dir,'session.json');await fs.writeFile(target,JSON.stringify(f));await fs.utimes(target,new Date(now),new Date(now+i));}
      for(let i=0;i<2;i++) {const f=structuredClone(base);f.sessionId=f.owner.sessionId='z-live-'+i;f.updatedAt=now;
        const dir=path.join(props.feedRoot,'sessions',f.sessionId);await fs.mkdir(dir,{recursive:true});const target=path.join(dir,'session.json');await fs.writeFile(target,JSON.stringify(f));await fs.utimes(target,new Date(now-60000),new Date(now-60000+i));}`);
    expect(output.ids.slice(0,2)).toEqual(['z-live-1','z-live-0']);
    expect(output.ids).toContain('z-live-0'); expect(output.ids).toContain('z-live-1');
    expect(output.errors).toMatchObject([{message:expect.stringContaining('truncated')}]);
  });
  test('loads only validated feed-root files without SPIDER_GLOBAL_ROOT', async () => {
    const output = await scene<{ids: string[]; text: string[]}>(`delete process.env.SPIDER_GLOBAL_ROOT; props.nodePath=process.execPath;
      props.feedRoot=path.join(path.dirname(m.identifier),'feeds'); await fs.mkdir(path.join(props.feedRoot,'sessions','fixture'),{recursive:true});
      await fs.writeFile(path.join(props.feedRoot,'sessions','fixture','session.json'),files[0]);
      const {execFile}=await import('node:child_process'); api.exec=(cmd,args)=>args.length?new Promise((resolve,reject)=>execFile(cmd,args,{maxBuffer:8*1024*1024,env:{...process.env,TMPDIR:path.dirname(m.identifier)}},(error,stdout,stderr)=>error?reject(error):resolve({code:0,stdout,stderr}))):Promise.resolve({code:0,stdout:'{"feeds":[],"errors":[]}',stderr:''});
      initView(panel,cx);await tasks[0];console.log(JSON.stringify({ids:panel.feeds.map(f=>f.sessionId),text:texts(panel.render(cx))}));`);
    expect(output.ids).toEqual(['fixture']); expect(output.text.join(' ')).toContain('fixture');
  });
  test('missing usage says so, draws no bar, and shared memories need review', async () => {
    const output = await scene(`const f = JSON.parse(files[0]); f.runs.total=14; f.runs.truncated=true; f.todos.total=9; f.todos.truncated=true;
      files[0]=JSON.stringify(f); initView(panel,cx); await tasks[0]; panel.expanded.add('fixture'); console.log(JSON.stringify(texts(panel.render(cx))));`);
    const text = output.join(' ');
    expect(output).toContain('Usage unavailable'); expect(text).not.toContain('0 credits');
    expect(text).not.toMatch(/14 runs|9 todos|Showing/);
    expect(output.filter(text => /memor|shared|Review/.test(text))).toEqual(['1 memory to review']);
    // The reason sits in the bar's tooltip; no track is drawn.
    const bar = await scene<{tip: unknown; track: boolean}>(`initView(panel,cx);await tasks[0];const tree=panel.render(cx);
      console.log(JSON.stringify({tip:byId(tree,'spider-pace').items[0].styles.tooltip[0],track:byId(tree,'pace-track')!==undefined}));`);
    expect(bar).toEqual({ tip: 'No counters', track: false });
  });
  test('rejects malformed and unknown feed versions with a timestamped unavailable source', async () => {
    const output = await scene(`files.splice(0, files.length, '{broken', JSON.stringify({...JSON.parse(files[0]),version:2}));
      initView(panel,cx); await tasks[0]; console.log(JSON.stringify(texts(panel.render(cx))));`);
    expect(output.join(' ')).toContain("Spider skipped 2 session feeds it couldn't parse.");
    expect(output.join(' ')).toContain("Spider couldn't read any session feed.");
    expect(output.join(' ')).not.toContain('fixture · idle');
  });
  test('stale sessions are disconnected, not newly completed, and closed stays closed', () => {
    const live = feed('live'), closed = feed('closed'); closed.lifecycle = 'closed';
    expect(panelSessionState(live, 11000)).toBe('live');
    expect(panelSessionState(live, 11001)).toBe('disconnected');
    expect(panelSessionState(closed, 11001)).toBe('closed');
  });
  test('groups observed spaces in visual order and leaves unknown placement unplaced', () => {
    const a = feed('a'), b = feed('b'), c = feed('c'), d = feed('d');
    a.placement = { spaceId: 'space-a' as SpaceId, spaceName: 'First', spaceOrder: 0, tabId: null };
    b.placement = { spaceId: 'space-b' as SpaceId, spaceName: 'Second', spaceOrder: 1, tabId: null };
    d.placement = { spaceId: 'space-d' as SpaceId, spaceName: null, spaceOrder: null, tabId: null };
    const panel = projectSpiderPanel([c, d, b, a]);
    expect(panel.sessions.map(s => s.id)).toEqual(['a', 'b', 'd', 'c']);
    expect(panel.spaces.map(s => [s.id, s.name, s.sessionIds])).toEqual([
      ['space-a', 'First', ['a']], ['space-b', 'Second', ['b']], ['space-d', null, ['d']], [null, null, ['c']],
    ]);
  });
  test('deduplicates shared approvals without inventing an owner', () => {
    const first = feed('s1');
    first.approvals.push({ uuid: 'owned', scope: 'repo', repoKey: 'repo-a' as never, ownerSessionId: first.sessionId, category: 'insight', preview: 'Only s1' });
    const rows = projectSpiderPanel([first, feed('s2')]);
    expect(rows.sharedApprovals).toMatchObject([{ uuid: 'approval', ownerSessionId: null }]);
    expect(rows.sharedApprovals).toHaveLength(1);
    expect(rows.sessions.map(s => s.id)).toEqual(['s1', 's2']);
    expect(rows.sessions[0].feed.approvals).toContainEqual(first.approvals[1]);
    expect(rows.sharedApprovals.some(a => a.uuid === 'owned')).toBe(false);
  });
  test('session-owned and shared memories are one notification without previews', async () => {
    const output = await scene<{ session: string[]; all: string[] }>(`const f=JSON.parse(files[0]);
      f.approvals.push({uuid:'owned',scope:'repo',repoKey:'repo-a',ownerSessionId:'fixture',category:'insight',preview:'Only this session'});
      files[0]=JSON.stringify(f);initView(panel,cx);await tasks[0];panel.expanded.add('fixture');const tree=panel.render(cx);
      console.log(JSON.stringify({session:texts(byId(tree,'session-fixture')),all:texts(tree)}));`);
    expect(output.all.filter(text => /memor|from|shared/.test(text))).toEqual(['2 memories to review']);
    expect(output.all.join(' ')).not.toContain('Needs you');
    expect(output.all.join(' ')).not.toMatch(/Only this session|Review this|Shared approvals/);
    expect(output.session.join(' ')).not.toContain('memor');
  });
});
