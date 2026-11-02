// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import type { SessionFeed, HerdrNotification } from '../../contracts.js';
import type { HerdrHarness } from '../testutil.js';
import { parseFeed } from '../../../assets/shared/feed.js';
import { projectSpiderPanel } from '../../../assets/mods/spider/data.js';
import { checkSpiderPanel } from '../panel-app-check.mjs';

export async function acceptanceI(h: HerdrHarness): Promise<void> {
  assert(h.owner, 'The shared harness must be started');
  const owner = h.owner;
  assert.equal(h.localEnv.SPIDER_GLOBAL_ROOT, h.directories.global);
  assert(h.localSocket.startsWith(h.root + '/'));
  assert(h.remoteSocket.startsWith(h.root + '/'));
  assert.notEqual(h.localCoreId, h.remoteCoreId);
  assert.equal((await h.hc.identity()).coreId, h.localCoreId);
  // The harness owns any opt-in app. This scenario only runs a separate headless native check.
  if (h.mode === 'app') assert.equal(process.env.SPIDER_HERDR_APP_TESTS, '1', 'App render checks require the user opt-in');
  const now = Date.now();
  const feed: SessionFeed = {
    version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: now, owner,
    placement: null, lifecycle: 'live', status: {native:'idle',effective:'idle',message:null},
    runs: {rows:[],total:0,truncated:false}, todos: {rows:[],total:0,truncated:false}, triggers: [],
    pace: {scope:'shared',used:80,budget:100,projected:110,remaining:20,periodStart:0,periodEnd:100000,updatedAt:now,unavailableReason:null},
    approvals: [{uuid:'shared-approval',scope:'global',repoKey:null,ownerSessionId:null,category:'insight',preview:'Review this'}],
    notifications: [], ipc: {address:join(h.directories.global,'endpoint.sock'),capabilityFile:join(h.directories.global,'capability')}, errors: [],
  };
  const directory = join(h.directories.global, 'herdr', 'sessions', feed.sessionId);
  await mkdir(directory, {recursive:true,mode:0o700});
  const file = join(directory, 'session.json');
  async function publish(): Promise<void> {
    await writeFile(file + '.new', JSON.stringify(feed), {mode:0o600});
    await rename(file + '.new', file);
  }
  async function current(): Promise<SessionFeed> {
    const decoded = parseFeed(await readFile(file, 'utf8'));
    assert(decoded, 'The actual feed file must pass the shared decoder');
    return decoded;
  }
  await publish();
  let decoded = await current();
  assert.deepEqual(projectSpiderPanel([decoded, decoded]).sharedApprovals.map(a=>[a.uuid,a.ownerSessionId]), [['shared-approval',null]]);
  feed.revision++;feed.todos={rows:[{seq:1,sessionId:feed.sessionId,text:'Changed todo',done:false}],total:7,truncated:true};
  await publish();decoded=await current();
  assert.equal(projectSpiderPanel([decoded]).sessions[0].feed.todos.rows[0].text, 'Changed todo');
  assert.equal(projectSpiderPanel([decoded]).sessions[0].feed.todos.total, 7);
  const document = await runPanelScene<{text:string[];facts:string[];view:string;session:string[];requests:{descriptor:{sessionId:string;generation:string};request:{op:string;view?:string}}[]}>(`
    props.feedRoot=${JSON.stringify(join(h.directories.global,'herdr'))};props.nodePath=process.execPath;
    props.cliPath=${JSON.stringify(join(h.directories.global,'cli.mjs'))};props.configPath=${JSON.stringify(join(h.directories.global,'config.json'))};
    const requests=[];const {execFile}=await import('node:child_process');
    api.exec=(command,args)=>args[1]==='ipc'?(requests.push({descriptor:JSON.parse(args[3]),request:JSON.parse(args[5])}),Promise.resolve({code:0,stdout:JSON.stringify(JSON.parse(args[5]).op==='ping'?{ok:true,op:'ping',status:{native:'idle',effective:'idle'}}:{ok:true,op:'openView'}),stderr:''}))
      :new Promise((resolve,reject)=>execFile(command,args,{maxBuffer:8*1024*1024,env:{...process.env,TMPDIR:path.dirname(m.identifier)}},(error,stdout,stderr)=>error?reject(error):resolve({code:0,stdout,stderr})));
    initView(panel,cx);await tasks[0];panel.expanded.add(${JSON.stringify(feed.sessionId)});
    const tree=panel.render(cx);byId(tree,${JSON.stringify(`view-${feed.sessionId}-todos`)}).events.on_click({},cx);await drain();
    console.log(JSON.stringify({text:texts(tree),facts:byId(tree,${JSON.stringify(`facts-${feed.sessionId}`)}).items.map(f=>f.styles.tooltip[0]),view:panel.view.kind,session:texts(panel.render(cx)),requests}));`,decoded);
  assert(document.text.includes('Changed todo'));
  assert(document.facts.includes('1 open todo'));
  if (h.mode === 'app') {
    const checked = await checkSpiderPanel({ appBinary: h.appBinary, appHome: join(h.root, 'panel-check-home'), feed: decoded });
    assert(checked.stdout.includes('Changed todo'), 'The actual app must materialize the changed todo row');
    assert(checked.stdout.includes(`view-${feed.sessionId}-todos`), 'The actual app must materialize the action button');
    console.info(checked.stderr.trim());
  }
  // Todos, runs and usage open inside the panel; nothing is asked of the pi session.
  assert.equal(document.view, 'session');
  assert(document.session.includes('Changed todo'));
  assert.deepEqual(document.requests, []);

  const budget: HerdrNotification = {id:'budget:0:80',kind:'budget',scope:'shared',sessionId:null,ownerAddress:null,createdAt:now,
    title:'Budget warning',body:'Shared credit pace',action:{kind:'open-usage',scope:'shared'}};
  feed.notifications=[budget];await publish();decoded=await current();
  const result: HerdrNotification={id:'result:one',kind:'job-result',scope:'session',sessionId:feed.sessionId,ownerAddress:feed.owner.terminal.address,createdAt:now+1,
    title:'Result',body:'Completed run',action:{kind:'focus-owner',sessionId:feed.sessionId,address:feed.owner.terminal.address}};
  feed.notifications.push(result,result);feed.updatedAt=now+1;feed.revision++;await publish();decoded=await current();
  const quiet = await runPanelScene<{posts:unknown[];commands:unknown[];history:boolean}>(`
    initView(panel,cx);await tasks[0];await panel.reload(cx);await drain();
    console.log(JSON.stringify({posts:notifications,commands,history:persisted.has('spider.notifications/spider-test')}));`,decoded);
  assert.deepEqual(quiet.posts,[]); assert.deepEqual(quiet.commands,[]); assert.equal(quiet.history,false);
  feed.lifecycle='closed';await publish();decoded=await current();
  const closed = await runPanelScene<{posts:unknown[];commands:unknown[]}>(`
    initView(panel,cx);await tasks[0];await drain();console.log(JSON.stringify({posts:notifications,commands}));`,decoded);
  assert.deepEqual(closed.posts,[]); assert.deepEqual(closed.commands,[]);
  assert(!(await h.calls()).some(call=>call.argv[0]==='send'), 'No terminal input is ever sent');
}

export async function runPanelScene<T = string[]>(body: string, fixture: SessionFeed, transform: (source: string) => string = source => source): Promise<T> {
  const scratch = resolve('.spider/scratch/h'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'scene-'));
  try {
    const mod = join(root, 'mod'); await mkdir(join(mod, 'shared'), { recursive: true });
    for (const name of ['main.js', 'data.js']) {
      const source = await readFile(new URL(`../../../assets/mods/spider/${name}`, import.meta.url), 'utf8');
      await writeFile(join(mod, name), name === 'main.js' ? transform(source) : source);
    }
    await writeFile(join(mod, 'shared/feed.js'), await readFile(new URL('../../../assets/shared/feed.js', import.meta.url), 'utf8'));
    const script = `import vm from 'node:vm'; import fs from 'node:fs/promises'; import path from 'node:path';
      import { createUiModules, createHostModule, initView, strictInit } from ${JSON.stringify(new URL('../strict-mod-api.mjs', import.meta.url).href)};
      const ui = createUiModules();
      const context = vm.createContext({ console, Date, Set, Map, JSON, Promise, Error, fetch: async (url, options) => {
        if (api.nativeReader) return globalThis.fetch(url, options);
        if (String(url).endsWith('/close')) return {ok:true,json:async()=>({ok:true})};
        const script = "const fs=require('node:fs'),path=require('node:path');const root=path.join(process.argv[1],'sessions');const ids=fs.readdirSync(root);console.log(JSON.stringify({feeds:ids.map(id=>fs.readFileSync(path.join(root,id,'session.json'),'utf8')),errors:[]}));";
        const reply = await api.exec(props.nodePath, ['-e', script, props.feedRoot]);
        if (reply.code !== 0) throw new Error('Feed read failed');
        const legacy = JSON.parse(reply.stdout);
        if (!Array.isArray(legacy.feeds) || !legacy.feeds.every(text=>typeof text==='string') || !Array.isArray(legacy.errors)) throw new Error('Invalid feed snapshot');
        const entries=[],changes=[],errors=[...legacy.errors];
        const codec=cache.get(path.join(modRoot,'shared/feed.js')).namespace;
        for(const [index,text] of legacy.feeds.entries()) {
          const feed=codec.parseFeed(text);
          if(!feed){errors.push({source:legacy.sources?.[index]??'session feed',message:'Unavailable: invalid feed'});continue;}
          const entry={source:feed.sessionId,stamp:String(index),updatedAt:feed.updatedAt};entries.push(entry);changes.push({...entry,feed});
        }
        return {ok:true,json:async()=>({version:1,entries,changes,errors})};
      } });
      const tasks = [], timers = [], commands = [], notifications = [], persisted = new Map();
      const props = { feedRoot: '/fixture/feeds', cliPath: '/fixture/cli.mjs', nodePath: '/fixture/node', configPath: '/fixture/config.json', modId: 'spider-test' };
      const files = [${JSON.stringify(JSON.stringify(fixture))}];
      const api = { props: () => props, theme: () => ({foreground: '#fff', dim: '#aaa', background: '#161618', hover: '#242426', selected: '#2a2a2c'}),
        exec: async () => ({code: 0, stdout: JSON.stringify({feeds: files, errors: []}), stderr: ''}),
        panes: () => [], spaces: () => globalThis.sceneSpaces ?? [], readTextFile: async () => null, watchFolder: async () => new Promise(() => {}), run: (name,args) => { commands.push({name,args}); },
        shared: k => persisted.get(k), setShared: (k,v) => persisted.set(k,v), notify: n => notifications.push(n), nextCommand: async () => new Promise(() => {}) };
      const cx = {spawn: f => {const p=f(cx);p.cancel=()=>{};tasks.push(p);return p;},notify:()=>{},focus_handle:()=>({focus(){}}),timer:{every:(n,f)=>{const timer={n,f,cancelled:false,cancel(){this.cancelled=true;}};timers.push(timer);return timer;}}};
      const fake = (id,values)=>new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context,identifier:id});
      const modRoot=${JSON.stringify(mod)},cache=new Map();
      // UI scenes fake only the transport; the reader's own tests use its real CLI.
      const readerHost={...api,exec:(command,args)=>!api.nativeReader&&args[0]?.endsWith('/feed-reader.mjs')?Promise.resolve({code:0,stdout:JSON.stringify({version:1,port:34567,token:'0'.repeat(64),pid:1}),stderr:''}):api.exec(command,args)};
      const moduleLoads=new Map();
      function load(file){if(!moduleLoads.has(file))moduleLoads.set(file,fs.readFile(file,'utf8').then(text=>{const m=new vm.SourceTextModule(text,{context,identifier:file});cache.set(file,m);return m;}));return moduleLoads.get(file);}
      const m=await load(${JSON.stringify(mod + '/main.js')});
      await m.link((s,m)=>s==='herdr'?fake(s,createHostModule(new Proxy(readerHost,{get(target,key){return key==='exec'?target.exec:api[key];}}))):ui[s]?fake(s,ui[s]):load(path.resolve(path.dirname(m.identifier),s)));
      await m.evaluate();const panel=strictInit(new m.namespace.default());
      async function drain(){await Promise.all(tasks.filter(p=>p!==panel.watchTask&&p!==panel.commandTask));}
      function texts(el){return typeof el==='string'?[el]:el?.items?el.items.flatMap(texts):[];}
      function byId(el,id){if(el?.styles?.id?.[0]===id)return el;for(const child of el?.items||[]){const found=byId(child,id);if(found)return found;}}
      ${body}
    `;
    const scriptPath = join(root, 'scene.mjs'); await writeFile(scriptPath, script);
    const result = await promisify(execFile)(process.execPath, ['--experimental-vm-modules', scriptPath], { env: { ...process.env, TMPDIR: root }, timeout: 10000 });
    return JSON.parse(result.stdout);
  } finally { await rm(root, { recursive: true, force: true }); }
}
