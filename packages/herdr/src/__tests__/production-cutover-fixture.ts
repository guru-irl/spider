// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, writeFile, readFile, chmod, access, copyFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import { createHerdrHarness } from './isolated.js';
import { createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { readJournal, saveJournal } from '../setup/backup.js';
import { rollbackHerdr } from '../setup/installer.js';
import { createTerminalRegistry, writePrivateJson } from '../sessions/registry.js';
import { readCutoverRecovery, setupSpaces } from '../spaces/setup.js';
import { shellQuote } from '../sessions/resume.js';
import type { SetupRequest } from '../setup/installer.js';

export async function until(read: () => Promise<boolean>, timeout = 15000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await read()) return; await delay(25); }
  throw new Error('Isolated fixture did not reach the required state');
}
export async function fixture(mode: 'fake' | 'hc', terminalShell = false): Promise<{
    h: import("./isolated.js").HerdrHarness;
    root: string;
    cli: string;
    request: SetupRequest;
    file: string;
    control: string;
    run: (args: string[], more?: NodeJS.ProcessEnv) => {
        child: import("child_process").ChildProcessByStdio<null, import("stream").Readable, import("stream").Readable>;
        result: Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
            stdout: string;
            stderr: string;
        }>;
    };
    runInTerminal: (args: string[]) => Promise<{
        result: Promise<any>;
        cancel: () => Promise<void>;
    }>;
    shellArgv: string[];
    startTerminalShell: (kept?: import("../contracts.js").Owner | null) => Promise<void>;
    stopOwners: () => Promise<void>;
}> {
  const h = await createHerdrHarness(mode), root = h.root, bin = join(root, 'bin'); await mkdir(bin);
  execFileSync('git', ['init', '-q', root]);
  const configPath = join(root, 'config.json'), control = join(root, 'control.json'), source = join(root, 'entry.ts');
  const module = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
  await writeFile(control, '{}');
  // The generated entry uses the real composition. Only the external app and pi are substituted.
  await writeFile(source, `
import {readFile,writeFile,appendFile,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createProductionHerdrCliPorts,coreStartedAt,createProcessInventory} from ${module('../../../host/src/herdr/ports.ts')};
import {runHerdrCli} from ${module('../setup/cli.ts')};
import {setupHerdr,rollbackHerdr} from ${module('../setup/installer.ts')};
import {setupSpaces} from ${module('../spaces/setup.ts')};
import {createHcClient} from ${module('../client/hc.ts')};
import {registerHerdrSessions} from ${module('../sessions/register.ts')};
import {createTerminalRegistry,writePrivateJson} from ${module('../sessions/registry.ts')};
import {publishSessionFeed} from ${module('../feed/publisher.ts')};
import {processStartTime} from ${module('../../../subagents/src/process-identity.ts')};
const a=process.argv.slice(2), c=JSON.parse(await readFile(${JSON.stringify(configPath)},'utf8'));
const controlPath=${JSON.stringify(control)}, root=c.globalRoot+'/herdr';
const settings=async()=>JSON.parse(await readFile(controlPath,'utf8'));
if(a[0]==='terminal-shell') {
  // File requests avoid typing into terminals. CLI children inherit a real hc terminal ancestry.
  const {spawn}=await import('node:child_process'), {openSync,closeSync}=await import('node:fs');
  const {readdir,rename}=await import('node:fs/promises');
  const directory=${JSON.stringify(join(root, 'shell-requests'))};
  process.env.PATH=${JSON.stringify(bin)}+':'+process.env.PATH;
  if(a[1])process.env.HC_TERMINAL_ID=a[1];
  await writeFile(directory+'/ready','ready');
  for(;;) {
    for(const file of (await readdir(directory)).filter(file=>file.endsWith('.json'))) {
      const path=directory+'/'+file, request=JSON.parse(await readFile(path,'utf8'));
      await rename(path,path+'.running');
      const out=openSync(request.output,'w'), err=openSync(request.error,'w');
      const child=spawn(${JSON.stringify(h.nodeBinary)},[${JSON.stringify(join(root, 'cli.mjs'))},...request.argv],{cwd:${JSON.stringify(root)},env:process.env,stdio:['ignore',out,err]});
      closeSync(out);closeSync(err);
      const outcome=new Promise(resolve=>{child.once('error',error=>resolve({code:1,error:String(error)}));child.once('close',(code,signal)=>resolve({code,signal}));});
      await writeFile(request.done,JSON.stringify(await outcome));
    }
    await delay(25);
  }
} else if(a[0]==='pi-stub') {
  const options=await settings(); if(options.earlyExit)process.exit(23);
  await delay(options.activationDelay??250);
  const file=a[a.indexOf('--session')+1], header=JSON.parse((await readFile(file,'utf8')).split('\\n')[0]);
  const hc=createHcClient({binary:c.core.binary,env:process.env}), terminal=await hc.caller(process.env);
  const owner={sessionId:header.id,generation:'authoritative',terminal,cwd:process.cwd(),sessionFile:file,name:'Selected'};
  const identity={pid:process.pid,startIdentity:processStartTime(process.pid)};
  const inventory=createProcessInventory(root), handlers=new Map();
  const registration=registerHerdrSessions({on:(name,handler)=>{handlers.set(name,handler);return()=>{};}},{...inventory,registry:createTerminalRegistry(root),processIdentity:identity,launchEnvironment:{agentDirectory:c.agentDirectory,extensionArguments:[]},coreStartedAt:()=>Date.now()-1,env:process.env,owner:()=>owner,currentSession:()=>({...identity,sessionFile:file,sessionName:owner.name,kind:'top-level',hcAddress:terminal.address})});
  await handlers.get('session_start')({}, {mode:'tui',hasUI:true,sessionManager:{getSessionId:()=>header.id}});
  const feed={version:1,sessionId:header.id,generation:owner.generation,revision:1,updatedAt:Date.now(),owner,placement:null,lifecycle:'live',status:{native:null,effective:null,message:null},runs:{rows:[],total:0,truncated:false},todos:{rows:[],total:0,truncated:false},triggers:[],pace:{scope:'session',used:null,budget:null,projected:null,remaining:null,periodStart:null,periodEnd:null,updatedAt:null,unavailableReason:'fixture'},approvals:[],notifications:[],ipc:null,errors:[]};
  const publish=async()=>{feed.updatedAt=Date.now();await publishSessionFeed(root,feed);}; await publish();
  const timer=setInterval(()=>{void publish();},1000);
  await appendFile(${JSON.stringify(join(root, 'launches.jsonl'))},JSON.stringify({...identity,sessionFile:file,sessionId:header.id,cwd:process.cwd()})+'\\n');
  await writeFile(${JSON.stringify(join(root, 'ready'))},'ready');
  while(!(await settings()).exit)await delay(25);
  clearInterval(timer); await registration.dispose(); await hc.dispose();
} else if(a[0]==='app') {
  const docPath=${JSON.stringify(join(root, 'layout.json'))}, doc=JSON.parse(await readFile(docPath,'utf8'));
  const command=a[2], flag=k=>a[a.indexOf('--'+k)+1];
  if(a[1]==='ls'){console.log(JSON.stringify(doc));process.exit(0);}
  const hc=createHcClient({binary:c.core.binary,env:process.env}); let reply={};
  if(command==='space.new'||command==='tab.new') {
    let space=command==='space.new'?{id:randomUUID(),name:flag('name'),tabs:[]}:doc.spaces.find(s=>s.id===flag('space'));
    if(command==='space.new')doc.spaces.push(space);
    const id=randomUUID(), argv=JSON.parse(flag('argv'));
    const handle=await hc.run({argv,cwd:flag('folder'),parent:null,outliveParent:true,background:true,noNotify:true,labels:{'herdr.space':space.id,'herdr.tab':id}});
    space.tabs.push({id,name:command==='space.new'?flag('tab'):flag('name'),terminals:[{terminal:handle.address,pane:randomUUID()}]});reply={space:space.id,tab:id,terminal:handle.address};
  } else if(command==='tab.rename') {for(const s of doc.spaces)for(const t of s.tabs)if(t.id===flag('id'))t.name=flag('name');}
  else if(command==='tab.close') {for(const s of doc.spaces){for(const t of s.tabs)if(t.id===flag('id')){await hc.kill(t.terminals[0].terminal).catch(()=>{});await hc.rm(t.terminals[0].terminal);}s.tabs=s.tabs.filter(t=>t.id!==flag('id'));}}
  else if(!['space.select','layout.switch','app.theme'].includes(command))throw Error('Unexpected app command '+command);
  await writeFile(docPath,JSON.stringify(doc)); await hc.dispose();
  if((await settings()).lostReply && ['space.new','tab.new'].includes(command)){const v=await settings();delete v.lostReply;await writePrivateJson(controlPath,v);process.kill(process.ppid,'SIGKILL');await delay(50);process.exit(1);}
  console.log(JSON.stringify(reply));
} else {
  const ports=createProductionHerdrCliPorts(${JSON.stringify(root)},process.env);
  try {
    const request=await ports.request(${JSON.stringify(configPath)});
    if(a[0]==='spaces') {const result=await setupSpaces(c,ports.spacePorts(request));console.log(JSON.stringify(result));}
    else if(a[0]==='setup-cutover') {
      const parts=await ports.setupParts(request);
      // Installation plans are not under test; real settings/notes, transaction, preflight and cutover remain.
      await setupHerdr(request,{...parts,stageLook:async()=>[],installFiles:async()=>[],generateTemplates:async()=>[],installResume:async()=>[],ensureRuntime:async()=>[],verify:async()=>({checks:[],failures:[],warnings:[]})});
    } else process.exitCode=await runHerdrCli(a,ports);
  } finally {await ports.dispose();}
}
`);
  // Faults kill the real CLI after its durable journal write, without changing the shipped implementation.
  const fault = `
    if (process.env.CUTOVER_FAULT_FILE) {
      const fs = await import('node:fs/promises'); const file = process.env.CUTOVER_FAULT_FILE;
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (value.kind === __KIND__) { value.seen = (value.seen ?? 0) + 1; await fs.writeFile(file, JSON.stringify(value)); if (value.seen === value.at) { value.kind = 'spent'; await fs.writeFile(file, JSON.stringify(value)); process.kill(process.pid, 'SIGKILL'); } }
    }`;
  await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.spiderHerdrRuntimeEntry': 'false' }, ssr: { noExternal: true }, plugins: [{ name: 'journal-faults', transform(code, id) {
    if (id.endsWith('/host/src/herdr/ports.ts')) {
      const site = "const child = spawn(spawnRequest.argv[0], spawnRequest.argv.slice(1),";
      if (!code.includes(site)) throw new Error('Session launcher site not found');
      const guard = `if (spawnRequest.argv[0] !== 'pi' || spawnRequest.env.PATH?.split(':')[0] !== ${JSON.stringify(bin)} || spawnRequest.env.PI_CODING_AGENT_DIR !== ${JSON.stringify(h.directories.agent)}) throw new Error('Unexpected session launcher'); `;
      return code.replace(site, guard + site);
    }
    if (id.endsWith('/sessions/registry.ts')) return code.replace('await rename(temporary, path);', `await rename(temporary, path); if(path.endsWith('/spaces.json')) {${fault.replace('__KIND__', "'spaces'")}}`);
    if (id.endsWith('/setup/backup.ts')) {
      const site = /await atomicWrite\(path, bytes, (?:0o600|384), current.hash\);/;
      if (!site.test(code)) throw new Error('Installer journal fault site not found');
      return code.replace(site, match => match + fault.replace('__KIND__', "'installer'"));
    }
  } }], build: { ssr: source, outDir: root, emptyOutDir: false, rollupOptions: { external: id => id.startsWith('node:') || ['@earendil-works/', 'better-sqlite3', 'sqlite-vec', 'onnxruntime-', 'fastembed', '@huggingface/', '@xenova/', 'turndown', 'typebox'].some(prefix => id.startsWith(prefix)), output: { entryFileNames: 'cli.mjs' } } } });
  const cli = join(root, 'cli.mjs'), app = join(bin, 'app');
  await mkdir(join(root, 'dist/herdr'), { recursive: true }); await copyFile(cli, join(root, 'dist/herdr/cli.mjs'));
  for (const [name, command] of [['pi', 'pi-stub'], ['app', 'app']] as const) { await writeFile(join(bin, name), `#!/bin/sh\nexec ${shellQuote(h.nodeBinary)} ${shellQuote(cli)} ${command} "$@"\n`); await chmod(join(bin, name), 0o700); }
  await writeFile(join(bin, 'ps'), '#!/bin/sh\nif [ "$1" = -U ]; then exit 0; fi\nexec /bin/ps "$@"\n'); await chmod(join(bin, 'ps'), 0o700);
  h.localEnv.PATH = bin + ':' + h.localEnv.PATH; h.remoteEnv.PATH = bin + ':' + h.remoteEnv.PATH;
  const file = join(root, 'selected.jsonl'); await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 'selected', cwd: root }) + '\n' + JSON.stringify({ type: 'session_info', name: 'Selected' }) + '\n');
  await mkdir(join(h.directories.agent, 'sessions')); await writeFile(join(root, 'layout.json'), '{"spaces":[]}');
  await mkdir(join(root, 'packages/herdr/assets/look'), { recursive: true }); await writeFile(join(root, 'packages/herdr/assets/look/patches.json'), '{}');
  const config = { enabled: true, app: { binary: app, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(root, 'rc'), spaces: [{ name: 'Selected space', sessions: [{ file }] }], machines: [], limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] } };
  await writeFile(configPath, JSON.stringify(config));
  const request: SetupRequest = { config, configPath, packageRoot: root, journalRoot: join(config.globalRoot, 'herdr/setup') };
  h.localEnv.SPIDER_GLOBAL_ROOT = config.globalRoot;
  await h.start();
  const shellRequests = join(root, 'shell-requests'); await mkdir(shellRequests);
  const shellArgv = [h.nodeBinary, cli, 'terminal-shell'];
  const startTerminalShell = async (kept?: typeof h.owner) => {
    await import('node:fs/promises').then(fs => fs.rm(join(shellRequests, 'ready'), { force: true }));
    const handle = await h.hc.run({ argv: [...shellArgv, ...(kept ? [kept.terminal.address] : [])], cwd: root, labels: {}, background: true, outliveParent: true, noNotify: true });
    const identity = { ...await h.hc.identity(), address: handle.address, terminalId: handle.address as never };
    if (kept) {
      // The fake has no keeper. Model its restarted terminal with the new shell's real PID.
      const next = await h.cli(['get', handle.address, '--json']) as Record<string, unknown>;
      await h.emitCore({ type: 'restarted', terminal: kept.terminal.address, data: { ...next, address: kept.terminal.address } });
      await until(async () => (await h.cli(['get', kept.terminal.address, '--json']) as { pid?: number }).pid === next.pid);
    } else h.owner = { ...h.owner!, terminal: identity };
    await until(async () => existsSync(join(shellRequests, 'ready')));
  };
  if (terminalShell) await startTerminalShell();
  const runInTerminal = async (args: string[]) => {
    const id = randomUUID(), output = join(shellRequests, id + '.out'), error = join(shellRequests, id + '.err'), done = join(shellRequests, id + '.done');
    await writePrivateJson(join(shellRequests, id + '.json'), { argv: args, output, error, done });
    const result = (async () => {
      for (;;) {
        if (existsSync(done)) return { ...JSON.parse(await readFile(done, 'utf8')), stdout: await readFile(output, 'utf8'), stderr: await readFile(error, 'utf8') };
        if (!existsSync(root)) return { code: null, signal: 'SIGHUP', stdout: '', stderr: 'Fixture closed' };
        await delay(25);
      }
    })();
    return { result, cancel: () => h.hc.kill(h.owner!.terminal.address) };
  };
  const env = { ...h.localEnv }; delete env.HC_TERMINAL_ID; delete env.HC_TERMINAL_SOCKET;
  const run = (args: string[], more: NodeJS.ProcessEnv = {}) => {
    const child = spawn(h.nodeBinary, [cli, ...args], { cwd: root, env: { ...env, ...more }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
    return { child, result };
  };
  const stopOwners = async () => { await writePrivateJson(control, { exit: true }); await until(async () => !(await readFile(join(root, 'launches.jsonl'), 'utf8').catch(() => '')).trim() || (await Promise.all((await readCutoverRecovery(join(config.globalRoot, 'herdr/spaces'))).createdTabs.map(async tab => (await h.hc.get(tab.terminal)).state))).every(state => state === 'finished')); };
  return { h, root, cli, request, file, control, run, runInTerminal, shellArgv, startTerminalShell, stopOwners };
}
export const realCoreAvailable: boolean = existsSync(process.env.SPIDER_HERDR_HC_BINARY ?? join(homedir(), '.local/bin/hc'));

export function registerJournalCrashTests(test: ReturnType<typeof it.skipIf>, mode: 'fake' | 'hc', selected: readonly string[]): void {
  for (const kind of ['spaces', 'installer']) for (let at = 1; at <= (kind === 'spaces' ? 4 : 5); at++) {
    if (!selected.includes(`${kind}:${at}`)) continue;
    test(`cutover recovers a crash after ${kind} journal step ${at} (${mode})`, async () => {
      const f = await fixture(mode);
      try {
        const fault = join(f.root, 'fault.json'); await writeFile(fault, JSON.stringify({ kind, at }));
        const first = await f.run(['setup-cutover'], { CUTOVER_FAULT_FILE: fault }).result;
        expect(first.signal, first.stderr).toBe('SIGKILL'); expect(JSON.parse(await readFile(fault, 'utf8')).kind).toBe('spent');
        const retry = await f.run(['setup-cutover'], { CUTOVER_FAULT_FILE: fault }).result; expect(retry.code, retry.stderr).toBe(0);
        expect((await readCutoverRecovery(join(f.request.config.globalRoot, 'herdr/spaces'))).createdTabs).toHaveLength(1);
        expect((await readFile(join(f.root, 'launches.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
        await f.stopOwners();
        const rollback = await f.run(['rollback', '--config', f.request.configPath]).result; expect(rollback.code, rollback.stderr).toBe(0);
        expect((await readCutoverRecovery(join(f.request.config.globalRoot, 'herdr/spaces'))).entries).toEqual([]);
      } finally { await f.h.close(); }
      expect(await f.h.remainingOwnedResources()).toEqual([]);
    }, 60000);
  }
}
