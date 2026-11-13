import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import { buildFixture } from '../../../../scripts/test-bundle.js';
import { buildPiArgs } from '../../../subagents/src/pi-args.js';
import { applyIntercomSwitchover, filesystemSwitchoverPorts } from '../../../../scripts/intercom-switchover.mjs';
import { registerScenarios, storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import { readObserved, type RpcDriver } from '../harness/pi.js';
import { deadline, waitFor } from '../harness/wait.js';
import { scripts, tool, runChild, parentTurns, held, text, mark, childEvent, childTranscript } from '../fixtures/child-scripts.js';

function extensionArgs(args: string[]): string[] {
  return args.flatMap((arg, i) => arg === '--no-extensions' ? [arg] : arg === '--extension' ? [arg, args[i + 1]] : []);
}
function withoutExclusions(args: string[]): string[] {
  return args.filter((arg, i) => arg !== '--exclude-tools' && args[i - 1] !== '--exclude-tools');
}
async function adoption(suite: Suite): Promise<void> {
  const legacy = suite.ownPath(join(suite.root, 'legacy'));
  await mkdir(legacy);
  // The unguarded local factory is the audited 0.13.0 implementation. Its
  // protocol and state code are byte-equivalent after TypeScript transpilation.
  await buildFixture({ stdin: { contents: "export {default} from '@spider/intercom/local';", resolveDir: resolve('.') },
    outfile: join(legacy, 'index.mjs'), external: ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'] });
  await writeFile(join(legacy, 'package.json'), JSON.stringify({ name: 'pi-intercom', type: 'module', pi: { extensions: ['./index.mjs'] } }));
  const probe = suite.ownPath(join(suite.root, 'fork-probe.mjs'));
  const probeLog = suite.ownPath(join(suite.root, 'fork-probe.jsonl'));
  await writeFile(probe, `import {appendFileSync} from 'node:fs';
export default function(pi) {
  pi.on('session_start', (_event, ctx) => appendFileSync(${JSON.stringify(probeLog)}, JSON.stringify({pid:process.pid,session:ctx.sessionManager.getSessionId(),runId:process.env.PI_SUBAGENT_RUN_ID,argv:process.argv,tools:pi.getAllTools().map(t=>t.name)})+'\\n'));
  pi.registerCommand('reload', {description:'Fixture rolling reload',handler:async (_args,ctx)=>{await ctx.reload();}});
  pi.registerTool({name:'fixture-contact',label:'Fixture contact',description:'Activate the existing supervisor tool for this acceptance call',parameters:{type:'object',properties:{}},
    async execute(_id,_args,signal,_update,ctx) {const active=pi.getActiveTools();pi.setActiveTools([...active,'contact_supervisor']);try{const answer=await ctx.executeTool('contact_supervisor',{reason:'progress_update',message:'R14 supervisor contact'},{signal});if(answer.isError)throw new Error(JSON.stringify(answer.result));return answer.result;}finally{pi.setActiveTools(active);}}});
}`);
  // Production children retain these exclusions. The offline fixture enables
  // their existing tools only for scripted acceptance calls and registry probes.
  const childLauncher = suite.ownPath(join(suite.root, 'child-pi'));
  const childArgsLog = suite.ownPath(join(suite.root, 'child-args.jsonl'));
  await writeFile(childLauncher, `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);const filtered=[];for(let i=0;i<args.length;i++){if(args[i]==='--exclude-tools'){const names=args[++i].split(',').filter(name=>!['intercom','contact_supervisor'].includes(name));if(names.length)filtered.push('--exclude-tools',names.join(','));}else filtered.push(args[i]);}
if(args.includes('--mode'))appendFileSync(${JSON.stringify(childArgsLog)},JSON.stringify({runId:process.env.PI_SUBAGENT_RUN_ID,original:args,filtered})+'\\n');
process.execve(${JSON.stringify(suite.pi.launcher)},[${JSON.stringify(suite.pi.launcher)},...filtered],process.env);
`, { mode: 0o700 });
  const globalSettings = join(suite.directories.PI_CODING_AGENT_DIR, 'settings.json');
  const base = JSON.parse(await readFile(globalSettings, 'utf8'));
  const spiderConfig = join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json');
  const config = JSON.parse(await readFile(spiderConfig, 'utf8'));
  await writeFile(spiderConfig, JSON.stringify({ ...config, 'subagents.childMode': 'rpc', 'subagents.extensions': [...config['subagents.extensions'], probe] }));
  const gates = await scripts(suite, {
    'legacy-ready': [{ steps: [{ tool: { id: 'legacy-roster', name: 'intercom', arguments: { action: 'list' } } }] }, text('legacy ready')],
    spawn: parentTurns(runChild('spawn-old', 'old-child', 'old-child')),
    before: parentTurns(tool('steer-before', { action: 'message', to: 'old-child', message: 'R14 before switch' })),
    after: parentTurns(tool('steer-after', { action: 'message', to: 'old-child', message: 'R14 after switch' })),
    fresh: parentTurns(runChild('spawn-new', 'new-child', 'new-child')),
    peer: parentTurns(tool('peer-steer', { action: 'message', to: 'new-child', message: 'R14 cross-session broker steer' })),
    'old-child': [held('old-initial', 'working before switch'), held('old-after-first', 'working after first steer'), held('old-final', 'R14 old result')],
    'new-child': [{ steps: [{ tool: { id: 'supervisor-contact', name: 'fixture-contact', arguments: {} } }] }, held('new-final', 'R14 new result'), text('R14 new steered result')],
  });
  const evidence: object[] = [];
  for (const scope of ['user', 'project', 'both']) {
    const cwd = await suite.project(`fork-${scope}`);
    await mkdir(join(cwd, '.pi'));
    const projectSettings = join(cwd, '.pi/settings.json');
    await writeFile(globalSettings, JSON.stringify({ ...base, defaultProjectTrust: 'always',
      packages: [...base.packages, ...(scope === 'project' ? [] : [{ source: legacy }])], extensions: [probe] }));
    await writeFile(projectSettings, JSON.stringify({ packages: scope === 'user' ? [] : [legacy] }));
    const owner = await suite.launchPi({ mode: 'rpc', cwd, args: ['--name', `owner-${scope}`], extraEnv: { PI_SUBAGENT_PI_BINARY: childLauncher } }) as RpcDriver;
    let peer: RpcDriver | undefined;
    try {
      await owner.prompt(mark('spawn'));
      const ready = await gates.ready('old-initial', deadline(60_000));
      const spawn = await owner.toolResult('spawn-old', deadline(30_000));
      const oldRun = (spawn.result as { details: { run: { id: string; pid: number } } }).details.run;
      peer = await suite.launchPi({ mode: 'rpc', cwd, args: ['--name', `peer-${scope}`], extraEnv: { PI_INTERCOM_STABLE_ID: `legacy-peer-${scope}` } }) as RpcDriver;
      await peer.prompt(mark('legacy-ready'));
      expect((await peer.toolResult('legacy-roster', deadline(30_000))).isError).toBe(false);
      const oldPid = ready.pid;
      const initialProbes = (await readFile(probeLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(initialProbes.find(row => row.pid === oldPid)?.runId).toBe(oldRun.id);
      const before = owner.prompt(mark('before'));
      await waitFor('owned steer reaches the child queue', () => owner.events(), events => events.some(e => e.type === 'tool_execution_start' && e.toolCallId === 'steer-before'), deadline(30_000));
      gates.release('old-initial');
      await gates.ready('old-after-first', deadline(60_000));
      await before;
      expect((await owner.toolResult('steer-before', deadline(30_000))).result).toMatchObject({ details: { delivered: true, delivery: 'delivered' } });
      const brokerPidFile = join(suite.directories.PI_CODING_AGENT_DIR, 'intercom/broker.pid');
      const brokerPid = Number((await readFile(brokerPidFile, 'utf8')).trim());
      const legacyBytes = await readFile(join(legacy, 'index.mjs'));
      const activeFile = join(cwd, 'active-release.json');
      await writeFile(activeFile, JSON.stringify(suite.packed.root));
      const switchover = await applyIntercomSwitchover({ operationId: `fork-${scope}`, release: suite.packed.root,
        settingsFiles: [globalSettings, projectSettings], legacyRoots: [legacy], journalFile: join(cwd, 'switch.json') }, filesystemSwitchoverPorts(activeFile));
      expect(switchover.status).toBe('migration-pending');
      await owner.prompt('/reload');
      const after = owner.prompt(mark('after'));
      await waitFor('post-reload owned steer starts', () => owner.events(), events => events.some(e => e.type === 'tool_execution_start' && e.toolCallId === 'steer-after'), deadline(30_000));
      gates.release('old-after-first');
      await gates.ready('old-final', deadline(60_000));
      await after;
      expect((await owner.toolResult('steer-after', deadline(30_000))).result).toMatchObject({ details: { delivered: true, delivery: 'delivered' } });
      const transcript = await childTranscript(suite, oldPid);
      for (const message of ['R14 before switch', 'R14 after switch']) expect(transcript.entries.filter(entry => JSON.stringify(entry).includes(message) && entry.type === 'message')).toHaveLength(1);
      await owner.prompt(mark('fresh'));
      const newReady = await gates.ready('new-final', deadline(60_000));
      const contact = await childEvent(suite, newReady.pid, 'tool_execution_end', e => e.toolCallId === 'supervisor-contact');
      expect(contact.isError).toBe(false);
      await owner.waitEvent('message_end', e => e.customType === 'intercom_message' && JSON.stringify(e.content).includes('R14 supervisor contact'), deadline(30_000));
      const newSpawn = await owner.toolResult('spawn-new', deadline(30_000));
      const newRun = (newSpawn.result as { details: { run: { id: string } } }).details.run;
      const scriptFile = JSON.parse(await readFile(suite.pi.scriptPath, 'utf8'));
      scriptFile.scripts.peer = parentTurns(tool('peer-steer', { action: 'message', to: `spider-${newRun.id}`, message: 'R14 cross-session broker steer' }));
      await writeFile(suite.pi.scriptPath, JSON.stringify(scriptFile));
      await peer.prompt(mark('peer'));
      const peerSteer = await peer.toolResult('peer-steer', deadline(30_000));
      expect(peerSteer.result).toMatchObject({ details: { delivered: true, delivery: 'broker-accepted', recipientAcknowledged: false } });
      expect((await peer.events()).filter(e => e.type === 'tool_execution_end' && e.toolCallId === 'peer-steer')).toHaveLength(1);
      expect((await childTranscript(suite, newReady.pid)).entries.filter(entry => entry.type === 'custom_message' && JSON.stringify(entry).includes('R14 cross-session broker steer'))).toHaveLength(0);
      expect((await owner.events()).filter(e => e.type === 'message_end' && e.customType === 'intercom_message' && JSON.stringify(e.content).includes('R14 supervisor contact'))).toHaveLength(1);
      await peer.close();
      scriptFile.scripts.peer = parentTurns(tool('peer-reconnect', { action: 'message', to: `owner-${scope}`, message: 'R14 legacy reconnect' }));
      await writeFile(suite.pi.scriptPath, JSON.stringify(scriptFile));
      peer = await suite.launchPi({ mode: 'rpc', cwd, args: ['--name', `peer-${scope}`, '--extension', join(legacy, 'index.mjs')],
        extraEnv: { PI_INTERCOM_STABLE_ID: `legacy-peer-${scope}` } }) as RpcDriver;
      await peer.prompt(mark('peer'));
      expect((await peer.toolResult('peer-reconnect', deadline(30_000))).result).toMatchObject({ details: { delivered: true, delivery: 'broker-accepted' } });
      await owner.waitEvent('message_end', e => e.customType === 'intercom_message' && JSON.stringify(e.content).includes('R14 legacy reconnect'), deadline(30_000));
      expect((await owner.events()).filter(e => e.type === 'message_end' && e.customType === 'intercom_message' && JSON.stringify(e.content).includes('R14 legacy reconnect'))).toHaveLength(1);
      gates.release('new-final'); gates.release('old-final');
      await childEvent(suite, newReady.pid, 'message_end', e => e.customType === 'intercom_message' && JSON.stringify(e.content).includes('R14 cross-session broker steer'));
      const steeredTranscript = await waitFor('broker steer is persisted in the child conversation', () => childTranscript(suite, newReady.pid),
        transcript => transcript.entries.some(entry => entry.type === 'custom_message' && JSON.stringify(entry).includes('R14 cross-session broker steer')), deadline(30_000));
      expect(steeredTranscript.entries.filter(entry => entry.type === 'custom_message' && JSON.stringify(entry).includes('R14 cross-session broker steer'))).toHaveLength(1);
      await owner.waitEvent('message_end', e => e.customType === 'spider.subagent_done' && JSON.stringify(e.content).includes('R14 old result'), deadline(60_000));
      expect((await owner.events()).filter(e => e.type === 'message_end' && e.customType === 'spider.subagent_done' && JSON.stringify(e.content).includes('R14 old result'))).toHaveLength(1);
      const probes = (await readFile(probeLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const expectedExtensions = extensionArgs(buildPiArgs({ baseArgs: [], task: '', rpc: true, sessionEnabled: false,
        inheritProjectContext: true, inheritSkills: true, extensions: [suite.packed.extension],
        subagentOnlyExtensions: [...config['subagents.extensions'], probe] }).args);
      const launches = (await readFile(childArgsLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      for (const launch of launches) {
        expect(launch.filtered).toEqual(withoutExclusions(launch.original));
        expect(extensionArgs(launch.filtered)).toEqual(expectedExtensions);
        expect(extensionArgs(launch.original)).toEqual(expectedExtensions);
      }
      for (const pid of [oldPid, newReady.pid]) {
        const starts = probes.filter(row => row.pid === pid);
        expect(starts).toHaveLength(1);
        expect(starts[0].tools.filter((name: string) => name === 'intercom')).toHaveLength(1);
        expect(starts[0].argv.join(' ')).not.toContain(legacy);
        expect(starts[0].argv).toContain('--no-extensions');
        expect(starts[0].argv.slice(2)).toEqual(launches.find(launch => launch.runId === starts[0].runId).filtered);
      }
      expect(await readFile(join(legacy, 'index.mjs'))).toEqual(legacyBytes);
      expect(Number((await readFile(brokerPidFile, 'utf8')).trim())).toBe(brokerPid);
      expect(() => process.kill(brokerPid, 0)).not.toThrow();
      evidence.push({ scope, oldRun, oldPid, newPid: newReady.pid, switchover, probes, launches, brokerPid });
    } finally { await peer?.close(); await owner.close(); }
  }
  const unexpected = suite.ownPath(join(suite.root, 'unexpected-copy.mjs'));
  await buildFixture({ stdin: { contents: "export {default} from '@spider/intercom/local';", resolveDir: resolve('.') },
    outfile: unexpected, external: ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'] });
  const forwarded = [...config['subagents.extensions'], probe, unexpected];
  await writeFile(spiderConfig, JSON.stringify({ ...config, 'subagents.childMode': 'rpc', 'subagents.extensions': forwarded }));
  const fixtureScripts = JSON.parse(await readFile(suite.pi.scriptPath, 'utf8'));
  fixtureScripts.scripts.unexpected = parentTurns(runChild('unexpected-spawn', 'unexpected-child', 'unexpected-child'));
  fixtureScripts.scripts['unexpected-child'] = [held('unexpected-ready', 'must not run')];
  await writeFile(suite.pi.scriptPath, JSON.stringify(fixtureScripts));
  const isolated = await suite.launchPi({ mode: 'rpc', cwd: await suite.project('unexpected-copy'),
    extraEnv: { PI_SUBAGENT_PI_BINARY: childLauncher } }) as RpcDriver;
  try {
    await isolated.prompt(mark('unexpected'));
    const failed = await isolated.waitEvent('message_end', e => e.customType === 'spider.subagent_done' && JSON.stringify(e.content).includes('unexpected-child'), deadline(60_000));
    expect(JSON.stringify(failed.content)).toContain('failed');
    expect(JSON.stringify(failed.content)).toContain('No result was finalized');
    const launched = (await readFile(childArgsLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1);
    const rejectedProbes = (await readFile(probeLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const rejectedPid = rejectedProbes.find(row => row.runId === launched.runId)?.pid;
    expect(rejectedPid).toBeTypeOf('number');
    expect((await readObserved(suite.pi.observerDir, rejectedPid)).filter(event => ['message_end', 'tool_execution_start', 'agent_start'].includes(event.type))).toEqual([]);
    expect(launched.filtered).toEqual(withoutExclusions(launched.original));
    expect(extensionArgs(launched.filtered)).toEqual(extensionArgs(buildPiArgs({ baseArgs: [], task: '', rpc: true, sessionEnabled: false,
      inheritProjectContext: true, inheritSkills: true, extensions: [suite.packed.extension], subagentOnlyExtensions: forwarded }).args));
    evidence.push({ unexpectedChild: 'failed before any task or model entry', failed });
  } finally { await isolated.close(); }
  await suite.evidence('R14-fork-adoption.json', { boundary: 'packed spider and real offline RPC sessions', evidence });
}

export const scenarios: readonly ScenarioDefinition[] = [{ id: storyId('R14'),
  title: 'RPC child steered across switchover loads only fork', tiers: ['headless'], run: adoption }];
registerScenarios(scenarios);
