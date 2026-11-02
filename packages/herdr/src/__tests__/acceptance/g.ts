// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { access, chmod, mkdir, open, readFile, writeFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import type { HerdrHarness } from '../testutil.js';
import type { CoreIdentity, HerdrConfig, Owner, SessionId, TerminalAddress, TerminalIdentity } from '../../contracts.js';
import { HERDR_LABELS } from '../../contracts.js';
import { object, text } from '../../client/parse.js';
import { invokeCli } from '../../client/cli-transport.js';
import { createAppClient } from '../../client/app.js';
import { createTerminalRegistry } from '../../sessions/registry.js';
import { createProcessPresence } from '../../sessions/presence.js';
import { createSessionLeases, type ProcessInventoryPorts } from '../../sessions/lease.js';
import { buildResumeBlock, shellQuote } from '../../sessions/resume.js';
import { setupSpaces, type LayoutSnapshot, type SpaceSetupPorts } from '../../spaces/setup.js';
import type { LaunchedSession } from '../../spaces/cutover.js';
import { processStartTime } from '../../../../subagents/src/process-identity.js';
async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { try { await access(path); return; } catch { await delay(25); } }
  throw new Error(`Test-owned fixture did not acknowledge ${path}`);
}
function inventory(root: string): ProcessInventoryPorts {
  const presence = createProcessPresence(root), leases = createSessionLeases(root);
  return { presence, leases, processes: async () => (await presence.list()).map(r => ({ pid: r.pid, startIdentity: r.startIdentity, classification: 'pi' as const })), probe: async pid => {
    const startIdentity = processStartTime(pid); if (startIdentity !== null) return { kind: 'live', startIdentity };
    try { process.kill(pid, 0); return { kind: 'unknown' }; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? { kind: 'absent' } : { kind: 'unknown' }; }
  } };
}
interface Fixture { directory: string; state: string; cli: string; config: string; exit: Awaited<ReturnType<typeof open>> }
async function fixture(h: HerdrHarness, suffix = 'g'): Promise<Fixture> {
  const directory = join(h.root, suffix); await mkdir(directory, { recursive: true }); const state = join(h.directories.global, 'herdr'); const config = join(directory, 'fixture.json');
  const exitPath = join(directory, 'exit.fifo'); execFileSync('mkfifo', [exitPath]); const exit = await open(exitPath, constants.O_RDWR | constants.O_NONBLOCK);
  await writeFile(config, JSON.stringify({ directory, state, root: h.root, hcBinary: h.hcBinary, namespace: h.namespace, socket: h.localSocket, owner: h.owner, exitPath }));
  const source = join(directory, 'fixture-cli.ts');
  const modulePath = (name: string) => JSON.stringify(fileURLToPath(new URL(`../../${name}.ts`, import.meta.url)));
  const processModule = JSON.stringify(fileURLToPath(new URL('../../../../subagents/src/process-identity.ts', import.meta.url)));
  await writeFile(source, `
import {readFile, writeFile, appendFile, open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createTerminalRegistry} from ${modulePath('sessions/registry')};
import {createProcessPresence} from ${modulePath('sessions/presence')};
import {createSessionLeases} from ${modulePath('sessions/lease')};
import {launchSession} from ${modulePath('sessions/launcher')};
import {offerResume,resumeOfferShell} from ${modulePath('sessions/resume')};
import {createHcClient} from ${modulePath('client/hc')};
import {processStartTime} from ${processModule};
const a=process.argv.slice(2); const flag=k=>a[a.indexOf(k)+1]; const c=JSON.parse(await readFile(${JSON.stringify(config)},'utf8'));
const presence=createProcessPresence(c.state), leases=createSessionLeases(c.state), registry=createTerminalRegistry(c.state);
const probe=async pid=>{const startIdentity=processStartTime(pid); if(startIdentity)return {kind:'live',startIdentity}; try {process.kill(pid,0); return {kind:'unknown'};}catch(e){return {kind:e.code==='ESRCH'?'absent':'unknown'};}};
const processInventory={presence,leases,probe,processes:async()=> (await presence.list()).map(r=>({pid:r.pid,startIdentity:r.startIdentity,classification:'pi'}))};
if(a[0]==='pi-stub') {
 const argv=a.slice(1); const file=argv[argv.indexOf('--session')+1]; const startIdentity=processStartTime(process.pid);
 const header=JSON.parse((await readFile(file,'utf8')).split('\\n')[0]);
 const record={pid:process.pid,startIdentity,sessionFile:file,sessionName:c.owner.name,sessionId:header.id,kind:'top-level',mode:'tui',hcAddress:process.env.HC_TERMINAL_ID};
 await presence.record(record); const writer=await open(file,'a');
 await writer.write(JSON.stringify({type:'custom',customType:'fixture-writer',data:{pid:process.pid}})+'\\n');
 await appendFile(c.directory+'/launches.jsonl',JSON.stringify({pid:process.pid,startIdentity,cwd:process.cwd(),argv:['pi',...argv],sessionId:header.id})+'\\n');
 await writeFile(c.directory+'/started-'+header.id, 'ready');
 const control=await open(c.exitPath,'r'); await control.read(Buffer.alloc(64),0,64,null); await control.close();
 await writer.close(); await presence.remove(record);
} else {
 const proof=JSON.parse(await readFile(c.directory+'/proof.json','utf8'));
 const hc=createHcClient({binary:c.hcBinary,env:process.env,isolationProof:{checkout:process.env.SPIDER_TEST_FIXTURE_CHECKOUT,sessionNamespace:c.namespace,coreIds:[c.owner.terminal.coreId],sockets:[c.socket]}});
 const terminal=await hc.caller(process.env);
 if(a[0]==='resume-offer') {
  const offer=await offerResume(terminal,{registry,processInventory,coreStartedAt:async()=>proof.startedAt});
  if(offer)process.stdout.write(resumeOfferShell(offer,{nodePath:process.execPath,cliPath:process.argv[1],configPath:${JSON.stringify(config)},hookPath:${JSON.stringify(fileURLToPath(new URL('../../../assets/shell/resume.sh', import.meta.url)))}}));
 } else if(a[0]==='resume') {
  const file=flag('--file'), sessionId=flag('--session-id'), cwd=flag('--cwd'); const prior=await registry.get(terminal);
  let child; let childExit;
  const result=await launchSession({sessionFile:file,sessionId,cwd,environment:prior?.environment??{agentDirectory:process.env.PI_CODING_AGENT_DIR,extensionArguments:[]}}, {
   leases,processInventory,processIdentity:{pid:process.pid,startIdentity:processStartTime(process.pid)},env:process.env,
   spawnPi:async request=> { child=spawn(process.execPath,[process.argv[1],'pi-stub',...request.argv.slice(1)],{cwd:request.cwd,env:request.env,stdio:'inherit'}); childExit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)}); const deadline=Date.now()+15000; while(Date.now()<deadline){try{await readFile(c.directory+'/started-'+sessionId);break;}catch{await delay(10)}} const startIdentity=processStartTime(child.pid);if(!startIdentity)throw Error('fixture child unavailable');return {pid:child.pid,startIdentity};},
   publishMapping:async result=>registry.record({owner:{...c.owner,terminal,sessionId:result.sessionId,sessionFile:result.sessionFile,cwd:result.cwd,name:prior?.owner.name??c.owner.name},recordedAt:Date.now(),coreStartedAt:proof.startedAt,environment:prior?.environment??{agentDirectory:process.env.PI_CODING_AGENT_DIR,extensionArguments:[]}})
  });
  try {await childExit;} finally {await leases.release(result.sessionFile,result.token);}
 } else throw Error('Unknown fixture operation');
}
`);
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@spider/db-core': fileURLToPath(new URL('../../../../db-core/src/command-env.ts', import.meta.url)) } }, build: { ssr: source, outDir: directory, emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'fixture-cli.mjs' } } } });
  return { directory, state, cli: join(directory, 'fixture-cli.mjs'), config, exit };
}
export async function acceptanceResume(h: HerdrHarness): Promise<void> {
  assert(h.owner); const f = await fixture(h); const terminal = h.owner.terminal; const file = join(f.directory, 'session.jsonl');
  const preservedTerminals = (await h.inventory()).filter(r => r.kind === 'terminal' && r.id !== `local:${terminal.address}`).map(r => r.id).sort();
  const owner: Owner = { ...h.owner, sessionFile: file, name: 'Resume fixture', cwd: h.root };
  const registry = createTerminalRegistry(f.state); const recordedAt = Date.now();
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: owner.sessionId, cwd: owner.cwd }) + '\n' + JSON.stringify({ type: 'session_info', name: owner.name }) + '\n');
  await writeFile(f.config, JSON.stringify({ ...JSON.parse(await readFile(f.config, 'utf8')), owner }));
  await registry.record({ owner, recordedAt, coreStartedAt: recordedAt - 1, environment: { agentDirectory: h.directories.agent, extensionArguments: [] } });
  const triggerPath = join(f.directory, 'shell.fifo'); execFileSync('mkfifo', [triggerPath]); const trigger = await open(triggerPath, constants.O_RDWR | constants.O_NONBLOCK);
  const script = join(f.directory, 'restored-shell.sh'); const ready = join(f.directory, 'shell-ready'); const returned = join(f.directory, 'shell-returned'); const stopped = join(f.directory, 'shell-stopped');
  const hook = buildResumeBlock({ nodePath: h.nodeBinary, cliPath: f.cli, configPath: f.config, hookPath: fileURLToPath(new URL('../../../assets/shell/resume.sh', import.meta.url)) });
  await writeFile(script, `while read -r action < ${shellQuote(triggerPath)}; do\ncase "$action" in\noffer)\n${hook}\nprintf ready > ${shellQuote(ready)}\n;;\nresume) spider_resume; printf returned > ${shellQuote(returned)} ;;\nstop) printf stopped > ${shellQuote(stopped)}; exit 0 ;;\nesac\ndone\n`);
  const shell = ['/bin/bash', '--noprofile', '--norc', '-i', script];
  // Fence recovery before loss: no user rc or default shell startup file is read.
  await writeFile(join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml'), `notes = false\nshell = ${JSON.stringify(shell)}\n`);
  let fakeShell: ReturnType<typeof spawn> | null = null; let fakeStart: string | null = null;
  try {
    const before = object(await h.cli(['server', 'status', '--json']));
    const original = object(await h.cli(['get', terminal.address, '--json']));
    const originalStart = typeof original.pid === 'number' ? processStartTime(original.pid) : null;
    if (h.mode === 'fake') await h.scenario({ steps: [{ argvPrefix: ['keep'], reply: {} }] });
    await h.cli(['keep', terminal.address, '--json']);
    if (h.mode === 'fake') await h.scenario({ steps: [{ argvPrefix: ['server', 'restart'], reply: {} }] });
    h.localEnv.HOME = h.root;
    await h.cli(['server', 'restart', '--json']);
    const after = object(await h.cli(['server', 'status', '--json']));
    if (h.mode !== 'fake') assert.notEqual(after.pid, before.pid, 'A real restart must have a different test-owned core PID');
    const startedAt = Date.now(); assert(startedAt > recordedAt); await writeFile(join(f.directory, 'proof.json'), JSON.stringify({ startedAt, pid: after.pid }));
    if (h.mode === 'fake') {
      const log = await open(join(f.directory, 'shell.log'), 'a');
      fakeShell = spawn(shell[0], shell.slice(1), { cwd: owner.cwd, env: { ...h.localEnv, HOME: h.root }, detached: true, stdio: ['ignore', log.fd, log.fd] }); await log.close();
      assert(fakeShell.pid); fakeStart = processStartTime(fakeShell.pid);
      await h.emitCore({ type: 'restarted', seq: 100, terminal: terminal.address, data: { address: terminal.address, state: 'live', parent: null, labels: original.labels ?? {}, argv: shell, cwd: owner.cwd, pid: fakeShell.pid, status: null, exit_code: null, reason: null, signal: null, finished_ms: null } });
    }
    if (h.mode !== 'fake') {
      assert.equal(original.cwd, h.root); assert.deepEqual(original.argv, [h.nodeBinary, '-e', 'setInterval(()=>{},1000)']);
      assert.equal(typeof original.pid, 'number'); assert(originalStart);
      if (processStartTime(original.pid as number) === originalStart) process.kill(original.pid as number, 'SIGKILL');
      const deadline = Date.now() + 15000; let restored = object(await h.cli(['get', terminal.address, '--json']));
      while (JSON.stringify(restored.argv) === JSON.stringify(original.argv) && Date.now() < deadline) { await delay(25); restored = object(await h.cli(['get', terminal.address, '--json'])); }
      assert.deepEqual(restored.argv, shell, 'The recovery shell must be the fenced test-owned command');
    }
    await trigger.write('offer\n');
    try { await waitForFile(ready); } catch (error) { throw new Error(String(error) + ': ' + JSON.stringify(await h.cli(['get', terminal.address, '--json'])) + '\n' + await h.hc.read(terminal.address, { lines: 100 })); }
    const output = h.mode === 'fake' ? await readFile(join(f.directory, 'shell.log'), 'utf8') : await h.hc.read(terminal.address, { lines: 100 });
    assert(output.includes('spider_resume'), output); assert.equal((await registry.list()).length, 1);
    await assert.rejects(access(join(f.directory, 'launches.jsonl'))); // Declining launched nothing.
    await trigger.write('resume\n'); await waitForFile(join(f.directory, `started-${owner.sessionId}`));
    const deadline = Date.now() + 15000; while ((await registry.get(terminal))?.recordedAt === recordedAt && Date.now() < deadline) await delay(10);
    const rows = (await readFile(join(f.directory, 'launches.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 1); assert.equal(rows[0].cwd, owner.cwd); assert.deepEqual(rows[0].argv, ['pi', '--session', file]);
    const resumed = await registry.get(terminal); assert.equal(resumed?.owner.sessionFile, file); assert.equal(resumed?.owner.name, owner.name); assert.equal(resumed?.owner.terminal.terminalId, terminal.terminalId); assert.equal((await registry.list()).filter(r => r.owner.sessionFile === file).length, 1);
    const all = object(await h.cli(['ls', '--all', '--json'])); const terminals = (all.terminals as { address: string }[]).filter(t => t.address === terminal.address); assert.equal(terminals.length, 1); assert.equal(terminals[0].address, terminal.address);
    await f.exit.write('exit\n'); await waitForFile(returned); assert.equal((await createProcessPresence(f.state).list()).length, 0);
    assert.equal((await h.hc.get(terminal.address)).state, 'live', 'Exiting resumed pi must leave the reused shell live');
  } finally {
    const ending = h.mode === 'fake' ? null : await h.cli(['get', terminal.address, '--json']).then(object).catch(() => null);
    await trigger.write('stop\n').catch(() => {}); await f.exit.write('exit\n').catch(() => {});
    if (ending && JSON.stringify(ending.argv) === JSON.stringify(shell)) {
      await waitForFile(stopped); // The native kept shell may retain its reported PID across payload exit.
    }
    await trigger.close(); await f.exit.close();
    if (fakeShell?.pid && processStartTime(fakeShell.pid) === fakeStart) { try { process.kill(-fakeShell.pid, 'SIGTERM'); } catch {} await new Promise<void>(resolve => { if (fakeShell!.exitCode !== null || fakeShell!.signalCode !== null) resolve(); else fakeShell!.once('close', () => resolve()); }); }
    // The stop action belongs to this fixture, not to the resume flow.
    if ((await h.hc.get(terminal.address)).state === 'live') await h.cli(['kill', terminal.address, '--json']);
    await h.cli(['rm', terminal.address, '--json']);
  }
  assert.deepEqual((await h.inventory()).filter(r => r.kind === 'terminal').map(r => r.id).sort(), preservedTerminals, 'Resume fixture cleanup must leave no terminal behind and preserve unrelated terminals');
}
export async function acceptanceSpaces(h: HerdrHarness): Promise<void> {
  assert(h.owner); const f = await fixture(h, 'gs'); const file = join(f.directory, 'closed.jsonl'); const id = 'closed-fixture' as SessionId;
  const owner: Owner = { ...h.owner, sessionId: id, sessionFile: file, cwd: h.root, name: 'Closed fixture' };
  await writeFile(f.config, JSON.stringify({ ...JSON.parse(await readFile(f.config, 'utf8')), owner }));
  await writeFile(join(f.directory, 'proof.json'), JSON.stringify({ startedAt: Date.now() }));
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id, cwd: h.root }) + '\n' + JSON.stringify({ type: 'session_info', name: owner.name }) + '\n');
  const config: HerdrConfig = { enabled: true, app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(f.directory, 'rc'), spaces: [{ name: 'Cutover fixture', sessions: [{ file }] }], machines: [], limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] } };
  let launches = 0; const registry = createTerminalRegistry(f.state); const processInventory = inventory(f.state);
  const appEnvironment = { ...h.localEnv, HERDR_APP_HOME: h.directories.app, HERDR_FAKE_ROOT: h.directories.local };
  let appBinary = h.appBinary;
  if (h.mode === 'hc') {
    appBinary = join(f.directory, 'fake-app');
    await writeFile(appBinary, '#!/bin/sh\nexec ' + shellQuote(h.nodeBinary) + ' ' + shellQuote(fileURLToPath(new URL('../fake-app.mjs', import.meta.url))) + ' "$@"\n');
    await chmod(appBinary, 0o700); await writeFile(join(h.directories.local, 'app.json'), JSON.stringify({ spaces: [{ id: 'existing-fixture-space', name: 'Existing fixture', tabs: [{ id: 'existing-fixture-tab', name: 'Closed fixture', terminals: [{ terminal: h.owner.terminal.address, pane: 'existing-fixture-pane' }] }] }] })); await writeFile(join(h.directories.local, 'core.json'), JSON.stringify({ terminals: [] }));
  }
  const appClient = h.mode === 'hc' ? createAppClient({ binary: appBinary, env: appEnvironment }) : h.app;
  async function layoutSnapshot(): Promise<LayoutSnapshot> {
    const raw = object(await invokeCli(appBinary, ['ls'], appEnvironment));
    assert(Array.isArray(raw.spaces)); const mappings = await registry.list();
    return { spaces: raw.spaces.map(value => {
      const space = object(value); assert(Array.isArray(space.tabs));
      return { id: text(space.id) as import('../../contracts.js').SpaceId, name: text(space.name), tabs: space.tabs.map(value => {
        const tab = object(value); assert(Array.isArray(tab.terminals)); const address = tab.terminals.length ? text(object(tab.terminals[0]).terminal) as TerminalAddress : null;
        return { id: text(tab.id) as import('../../contracts.js').TabId, name: text(tab.name), terminal: address, ownerSessionId: mappings.find(m => m.owner.terminal.address === address)?.owner.sessionId ?? null };
      }) };
    }) };
  }
  const fakeApp = { ...appClient, command: async (name: string, args: Readonly<Record<string, unknown>>) => {
    if (name === 'space.select' || name === 'tab.rename') return appClient.command(name, args);
    // Emulate only the unavailable external app's allocation. The actual leased CLI and writer run inside hc.
    assert.equal(name, 'tab.new'); assert.equal(args.folder, h.root); assert.deepEqual((args.argv as string[]).slice(0, 7), [h.nodeBinary, '-e', 'process.env.PI_CODING_AGENT_DIR=process.argv[1].slice("PI_CODING_AGENT_DIR=".length);process.argv.splice(1,2);import(require("node:url").pathToFileURL(process.argv[1]).href)', `PI_CODING_AGENT_DIR=${config.agentDirectory}`, h.nodeBinary, f.cli, 'resume']); launches++;
    const space = args.space as import('../../contracts.js').SpaceId, tab = 'acceptance-tab' as import('../../contracts.js').TabId;
    const handle = await h.hc.run({ argv: args.argv as string[], cwd: h.root, labels: { [HERDR_LABELS.session]: id, [HERDR_LABELS.space]: space, [HERDR_LABELS.tab]: tab }, parent: null, outliveParent: true, background: true, noNotify: true });
    assert.notEqual(handle.address, h.owner!.terminal.address, 'Cutover must allocate a fresh terminal ID');
    const doc = object(await invokeCli(appBinary, ['ls'], appEnvironment)); assert(Array.isArray(doc.spaces));
    const updated = { ...doc, spaces: doc.spaces.map(value => { const previous = object(value); assert(Array.isArray(previous.tabs)); return previous.id === space ? { ...previous, tabs: [...previous.tabs, { id: tab, name: 'Closed fixture', terminals: [{ terminal: handle.address, pane: 'acceptance-pane' }] }] } : previous; }) };
    await h.scenario({ appSteps: [{ argvPrefix: ['do', 'tab.new'], reply: { space, tab, terminal: handle.address }, writes: { [join(h.directories.local, 'app.json')]: JSON.stringify(updated) } }] });
    return appClient.command(name, args);
  } };
  const ports: SpaceSetupPorts = {
    processInventory, registry, listSessionFiles: async () => [file], journalRoot: join(f.directory, 'journal'), coreIdentity: () => h.hc.identity(), clock: Date.now,
    waitForChange: async () => { throw new Error('A closed fixture must not wait'); }, reportLive: () => {}, reportBlocked: message => { throw new Error(message); }, notesDisabled: async () => (await readFile(config.core.config, 'utf8')).includes('notes = false'),
    layoutSnapshot, launcher: { nodePath: h.nodeBinary, cliPath: f.cli, configPath: f.config }, app: h.mode === 'app' ? h.app : fakeApp,
    verifyOwner: async (target, placement) => {
      const terminal: TerminalIdentity = { ...(await h.hc.identity()), terminalId: placement.terminal as unknown as TerminalIdentity['terminalId'], address: placement.terminal };
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const mapping = await registry.get(terminal); const lease = await processInventory.leases.get(target.file);
        if (mapping && lease) return { sessionId: mapping.owner.sessionId, sessionFile: mapping.owner.sessionFile!, cwd: mapping.owner.cwd, pid: lease.pid, startIdentity: lease.startIdentity };
        await delay(20);
      }
      throw new Error('The test-owned tab did not publish its actual owner mapping: ' + await h.hc.read(placement.terminal, { lines: 100 }));
    },
  };
  const before = await layoutSnapshot(); const originalSpace = before.spaces.find(space => space.tabs.some(tab => tab.terminal === h.owner!.terminal.address)); assert(originalSpace);
  config.spaces[0].name = originalSpace.name;
  await registry.record({ owner, recordedAt: Date.now(), coreStartedAt: Date.now() - 1, environment: { agentDirectory: h.directories.agent, extensionArguments: [] } });
  const originalViews: { address: string; detail: ReturnType<typeof object>; startIdentity: string | null }[] = [];
  const native = object(await h.cli(['ls', '--all', '--json'])); assert(Array.isArray(native.terminals));
  for (const value of native.terminals) {
    const address = text(object(value).address); if (address.includes('/')) continue;
    const detail = object(await h.cli(['get', address, '--json']));
    const startIdentity = h.mode !== 'fake' && typeof detail.pid === 'number' ? processStartTime(detail.pid) : null;
    if (h.mode !== 'fake') { assert.equal(typeof detail.pid, 'number'); assert(startIdentity); }
    originalViews.push({ address, detail, startIdentity });
  }
  async function originalsUnchanged(): Promise<void> {
    const now = await layoutSnapshot();
    for (const space of before.spaces) {
      const current = now.spaces.find(s => s.id === space.id); assert(current); assert.equal(current.name, space.name);
      for (const tab of space.tabs) { const same: LayoutSnapshot['spaces'][number]['tabs'][number] | undefined = current.tabs.find(t => t.id === tab.id); assert(same); assert.equal(same.name, tab.name); assert.equal(same.terminal, tab.terminal); }
    }
    for (const original of originalViews) {
      const detail = object(await h.cli(['get', original.address, '--json'])); assert.deepEqual(detail.argv, original.detail.argv); assert.equal(detail.cwd, original.detail.cwd); assert.equal(detail.parent, original.detail.parent);
      if (h.mode !== 'fake') { assert.equal(detail.pid, original.detail.pid); assert.equal(processStartTime(detail.pid as number), original.startIdentity); }
    }
  }
  try {
    await assert.rejects(setupSpaces(config, ports), error => object(error).code === 'space-name-conflict');
    await assert.rejects(access(join(f.directory, 'journal/spaces.json'))); assert.equal(launches, 0); await originalsUnchanged();
    const result = await setupSpaces(config, ports, { adoptExistingSpaces: [originalSpace.name] }); assert.equal(result.launched.length, 1); assert.equal(result.launched[0].sessionId, id); assert.equal(result.launched[0].cwd, h.root); assert.equal(result.tabs[0].space, originalSpace.id);
    const journal = join(f.directory, 'journal/spaces.json'); const first = await readFile(journal, 'utf8'); const written = await stat(journal, { bigint: true });
    await setupSpaces(config, ports, { adoptExistingSpaces: [originalSpace.name] }); await setupSpaces(config, ports);
    const unchanged = await stat(journal, { bigint: true }); assert.deepEqual([unchanged.ino, unchanged.mtimeNs], [written.ino, written.mtimeNs]); assert.equal(await readFile(journal, 'utf8'), first);
    if (h.mode !== 'app') assert.equal(launches, 1);
    await originalsUnchanged(); const snapshot = await layoutSnapshot(); assert.equal(snapshot.spaces.find(s => s.id === originalSpace.id)!.tabs.length, originalSpace.tabs.length + 1);
    const rows = (await readFile(join(f.directory, 'launches.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); assert.equal(rows.length, 1); assert.deepEqual(rows[0].argv, ['pi', '--session', file]);
    await f.exit.write('exit\n');
    const deadline = Date.now() + 15000; while ((await processInventory.presence.list()).length && Date.now() < deadline) await delay(20);
    assert.equal((await processInventory.presence.list()).length, 0);
  } finally { await f.exit.write('exit\n').catch(() => {}); await f.exit.close(); }
}
export async function acceptanceG(h: HerdrHarness): Promise<void> { await acceptanceResume(h); await acceptanceSpaces(h); }
