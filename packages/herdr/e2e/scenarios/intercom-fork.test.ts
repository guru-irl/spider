import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile, copyFile, realpath, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { expect } from 'vitest';
import { buildFixture } from '../../../../scripts/test-bundle.js';
import { buildPiArgs } from '../../../subagents/src/pi-args.js';
import { applyIntercomSwitchover, filesystemSwitchoverPorts } from '../../../../scripts/intercom-switchover.mjs';
import { registerScenarios, storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import { readObserved, type RpcDriver } from '../harness/pi.js';
import { deadline, waitFor } from '../harness/wait.js';
import { identityOf } from '../harness/resources.js';
import { scripts, tool, runChild, parentTurns, held, text, mark, childEvent, childTranscript } from '../fixtures/child-scripts.js';

function extensionArgs(args: string[]): string[] {
  return args.flatMap((arg, i) => arg === '--no-extensions' ? [arg] : arg === '--extension' ? [arg, args[i + 1]] : []);
}
function withoutExclusions(args: string[]): string[] {
  return args.filter((arg, i) => arg !== '--exclude-tools' && args[i - 1] !== '--exclude-tools');
}
async function adoption(suite: Suite): Promise<void> {
  const unwrapped = suite.ownPath(join(suite.root, 'unwrapped'));
  await mkdir(unwrapped);
  // The unguarded local factory is a fork-derived fixture, not an installed
  // upstream package. Its protocol and state match the recorded 0.13.0 source.
  await buildFixture({ stdin: { contents: "export {default} from '@spider/intercom/local';", resolveDir: resolve('.') },
    outfile: join(unwrapped, 'index.mjs'), external: ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'] });
  await writeFile(join(unwrapped, 'package.json'), JSON.stringify({ name: 'pi-intercom', type: 'module', pi: { extensions: ['./index.mjs'] } }));
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
    'unwrapped-ready': [{ steps: [{ tool: { id: 'unwrapped-roster', name: 'intercom', arguments: { action: 'list' } } }] }, text('unwrapped ready')],
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
      packages: [...base.packages, ...(scope === 'project' ? [] : [{ source: unwrapped }])], extensions: [probe] }));
    await writeFile(projectSettings, JSON.stringify({ packages: scope === 'user' ? [] : [unwrapped] }));
    const owner = await suite.launchPi({ mode: 'rpc', cwd, args: ['--name', `owner-${scope}`], extraEnv: { PI_SUBAGENT_PI_BINARY: childLauncher } }) as RpcDriver;
    let peer: RpcDriver | undefined;
    try {
      await owner.prompt(mark('spawn'));
      const ready = await gates.ready('old-initial', deadline(60_000));
      const spawn = await owner.toolResult('spawn-old', deadline(30_000));
      const oldRun = (spawn.result as { details: { run: { id: string; pid: number } } }).details.run;
      peer = await suite.launchPi({ mode: 'rpc', cwd, args: ['--name', `peer-${scope}`], extraEnv: { PI_INTERCOM_STABLE_ID: `unwrapped-peer-${scope}` } }) as RpcDriver;
      await peer.prompt(mark('unwrapped-ready'));
      expect((await peer.toolResult('unwrapped-roster', deadline(30_000))).isError).toBe(false);
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
      const unwrappedBytes = await readFile(join(unwrapped, 'index.mjs'));
      const activeFile = join(cwd, 'active-release.json');
      await writeFile(activeFile, JSON.stringify(suite.packed.root));
      const switchover = await applyIntercomSwitchover({ operationId: `fork-${scope}`, release: suite.packed.root,
        settingsFiles: [globalSettings, projectSettings], legacyRoots: [unwrapped], journalFile: join(cwd, 'switch.json') }, filesystemSwitchoverPorts(activeFile));
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
      scriptFile.scripts.peer = parentTurns(tool('peer-reconnect', { action: 'message', to: `owner-${scope}`, message: 'R14 unwrapped reconnect' }));
      await writeFile(suite.pi.scriptPath, JSON.stringify(scriptFile));
      peer = await suite.launchPi({ mode: 'rpc', cwd, args: ['--name', `peer-${scope}`, '--extension', join(unwrapped, 'index.mjs')],
        extraEnv: { PI_INTERCOM_STABLE_ID: `unwrapped-peer-${scope}` } }) as RpcDriver;
      await peer.prompt(mark('peer'));
      expect((await peer.toolResult('peer-reconnect', deadline(30_000))).result).toMatchObject({ details: { delivered: true, delivery: 'broker-accepted' } });
      await owner.waitEvent('message_end', e => e.customType === 'intercom_message' && JSON.stringify(e.content).includes('R14 unwrapped reconnect'), deadline(30_000));
      expect((await owner.events()).filter(e => e.type === 'message_end' && e.customType === 'intercom_message' && JSON.stringify(e.content).includes('R14 unwrapped reconnect'))).toHaveLength(1);
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
        expect(starts[0].argv.join(' ')).not.toContain(unwrapped);
        expect(starts[0].argv).toContain('--no-extensions');
        expect(starts[0].argv.slice(2)).toEqual(launches.find(launch => launch.runId === starts[0].runId).filtered);
      }
      expect(await readFile(join(unwrapped, 'index.mjs'))).toEqual(unwrappedBytes);
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

async function installedRollingReload(suite: Suite): Promise<void> {
  const baseInput = process.env.SPIDER_HERDR_E2E_R14_BASE!;
  const upstreamInput = process.env.SPIDER_HERDR_E2E_R14_UPSTREAM!;
  expect(isAbsolute(baseInput) && isAbsolute(upstreamInput)).toBe(true);
  const base = await realpath(baseInput), upstream = await realpath(upstreamInput);
  const scratch = await realpath(resolve('.spider/scratch'));
  expect(base.startsWith(scratch + '/')).toBe(true);
  const baseBytes = await readFile(base);
  expect(baseBytes.subarray(0, 100).toString()).toMatch(/^\/\/ SPIDER_BUILD_ID=2327c021@/);
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const origin = await readFile(resolve('packages/intercom/ORIGIN.md'), 'utf8');
  const section = origin.split('## Installed npm payload\n')[1]?.split('\n## Public source inputs')[0] ?? '';
  const recorded = [...section.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map(match => [match[1], match[2]]);
  expect(recorded.length).toBeGreaterThan(20);
  const inputs = recorded.map(([file]) => file);
  expect(inputs.every(file => !isAbsolute(file) && !file.split('/').includes('..'))).toBe(true);
  const installedHashes = Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(upstream, file)))])));
  expect(JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8')).version).toBe('0.13.0');
  expect(installedHashes).toEqual(Object.fromEntries(recorded));
  const baseRelease = suite.ownPath(join(suite.root, 'base'));
  await mkdir(join(baseRelease, 'dist'), { recursive: true });
  const baseBundle = join(baseRelease, 'dist/extension.js');
  await copyFile(base, baseBundle);
  const supervisor = join(dirname(base), 'herdr/subagent-supervisor.mjs');
  await mkdir(join(baseRelease, 'dist/herdr'));
  await copyFile(supervisor, join(baseRelease, 'dist/herdr/subagent-supervisor.mjs'));
  const cwd = await suite.project('rolling');
  const agent = suite.directories.PI_CODING_AGENT_DIR;
  const settings = join(agent, 'settings.json');
  const originalSettings = JSON.parse(await readFile(settings, 'utf8'));
  await writeFile(settings, JSON.stringify({ ...originalSettings, packages: [...originalSettings.packages, 'npm:pi-intercom'] }));
  const packageDir = join(agent, 'npm/node_modules');
  await mkdir(packageDir, { recursive: true });
  await symlink(upstream, join(packageDir, 'pi-intercom'), 'dir');
  const probe = suite.ownPath(join(suite.root, 'child-probe.mjs'));
  const probeLog = suite.ownPath(join(suite.root, 'child-probe.jsonl'));
  await writeFile(probe, `import {appendFileSync} from 'node:fs';
export default function(pi) { pi.on('session_start',()=>appendFileSync(${JSON.stringify(probeLog)},JSON.stringify({pid:process.pid,argv:process.argv,tools:pi.getAllTools().map(t=>t.name)})+'\\n')); }
`);
  const configFile = join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  await writeFile(configFile, JSON.stringify({ ...config, 'subagents.childMode': 'rpc', 'subagents.extensions': [...config['subagents.extensions'], probe] }));
  const gates = await scripts(suite, {
    'upstream-ready': [{ steps: [{ tool: { id: 'upstream-roster', name: 'intercom', arguments: { action: 'list' } } }] }, ...parentTurns(text('upstream ready'))],
    'fork-ready': [{ steps: [{ tool: { id: 'fork-roster', name: 'intercom', arguments: { action: 'list' } } }] }, ...parentTurns(text('fork ready'))],
    'fork-send': parentTurns(tool('fork-to-upstream', { action: 'message', to: 'upstream-013', message: 'R14 fork to installed' })),
    'upstream-send': [{ steps: [{ tool: { id: 'upstream-to-fork', name: 'intercom', arguments: { action: 'send', to: 'fork-peer', message: 'R14 installed to fork' } } }] }, ...parentTurns(text('sent'))],
    'before-owner': parentTurns(runChild('before-spawn', 'before-child', 'before-child')),
    'before-owner-steer': parentTurns(tool('before-owner-steer', { action: 'message', to: 'before-child', message: 'R14 before owner steer' })),
    'before-child': [held('before-initial', 'working before switch'), held('before-final', 'before result'), text('before completed')],
    'legacy-owner': parentTurns(runChild('legacy-spawn', 'legacy-child', 'legacy-child')),
    'legacy-steer': parentTurns(tool('legacy-owner-steer', { action: 'message', to: 'legacy-child', message: 'R14 owner steer' })),
    'legacy-child': [held('legacy-initial', 'working'), held('legacy-final', 'legacy result'), text('legacy completed')],
  });
  const commonArgs = ['--no-extensions', '--extension', suite.pi.providerPath, '--extension', suite.pi.observerPath];
  const upstreamClient = await suite.launchPi({ mode: 'rpc', cwd, label: 'installed-upstream',
    args: [...commonArgs, '--extension', join(upstream, 'index.ts'), '--name', 'upstream-013'],
    extraEnv: { PI_INTERCOM_STABLE_ID: 'upstream-013' } }) as RpcDriver;
  let owner: RpcDriver | undefined, fork: RpcDriver | undefined, brokerTracked = false;
  const pidFile = join(agent, 'intercom/broker.pid');
  const trackBroker = async () => {
    const brokerPid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(Number.isInteger(brokerPid) && brokerPid > 0).toBe(true);
    const brokerCommand = execFileSync('ps', ['-p', String(brokerPid), '-o', 'command='], { encoding: 'utf8' });
    expect(brokerCommand).toContain(join(upstream, 'broker/broker.ts'));
    suite.ledger.update(ledger => { ledger.processes.push({ ...identityOf(brokerPid), label: 'fixture-intercom-broker', group: false }); });
    brokerTracked = true;
    return { brokerPid, brokerCommand };
  };
  try {
    await waitFor('installed client creates its fixture broker', () => readFile(pidFile, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error;
    }), value => /^\d+$/.test(value.trim()), deadline(30_000));
    const { brokerPid, brokerCommand } = await trackBroker();
    await upstreamClient.prompt(mark('upstream-ready'));
    expect((await upstreamClient.toolResult('upstream-roster', deadline(30_000))).isError).toBe(false);
    owner = await suite.launchPi({ mode: 'rpc', cwd, label: 'base-owner',
      args: [...commonArgs, '--extension', baseBundle, '--extension', join(upstream, 'index.ts'), '--name', 'legacy-owner'],
      extraEnv: { PI_INTERCOM_STABLE_ID: 'legacy-owner' } }) as RpcDriver;
    await owner.waitEvent('session_start', () => true, deadline(30_000));
    await owner.prompt(mark('before-owner'));
    const beforeSpawn = await owner.toolResult('before-spawn', deadline(30_000));
    const beforeRun = (beforeSpawn.result as { details: { run: { id: string; status: string; intercom_session: string | null } } }).details.run;
    expect(beforeRun.status, JSON.stringify(beforeSpawn.result)).toBe('running');
    expect(beforeRun.intercom_session).toBe(`before-child-${beforeRun.id.slice(0, 8)}`);
    const beforeReady = await gates.ready('before-initial', deadline(60_000));
    const beforeProbe = (await readFile(probeLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(row => row.pid === beforeReady.pid);
    expect(beforeProbe).toBeDefined();
    const beforeExtension = beforeProbe.argv.find((arg: string) => arg.endsWith('/pi-intercom/index.ts'));
    expect(beforeExtension).toBeTypeOf('string');
    expect(await realpath(beforeExtension)).toBe(await realpath(join(upstream, 'index.ts')));
    const active = join(cwd, 'active-release.json');
    await writeFile(active, JSON.stringify(baseRelease));
    const switchover = await applyIntercomSwitchover({ operationId: 'rolling-installed', release: suite.packed.root,
      settingsFiles: [settings], legacyRoots: [upstream], journalFile: join(cwd, 'switch.json') }, filesystemSwitchoverPorts(active));
    expect(switchover.status).toBe('migration-pending');
    expect(JSON.parse(await readFile(settings, 'utf8')).packages).not.toContain('npm:pi-intercom');
    fork = await suite.launchPi({ mode: 'rpc', cwd, label: 'fork-peer',
      args: [...commonArgs, '--extension', suite.packed.extension, '--name', 'fork-peer'],
      extraEnv: { PI_INTERCOM_STABLE_ID: 'fork-peer' } }) as RpcDriver;
    await fork.prompt(mark('fork-ready'));
    const roster = await fork.toolResult('fork-roster', deadline(30_000));
    expect(roster.isError).toBe(false);
    expect(JSON.stringify(roster.result)).toContain('upstream-013');
    await fork.prompt(mark('fork-send'));
    expect((await fork.toolResult('fork-to-upstream', deadline(30_000))).result).toMatchObject({ details: { delivered: true } });
    const receivedUpstream = await upstreamClient.waitEvent('message_end', e => e.customType === 'intercom_message' && JSON.stringify(e.content).includes('R14 fork to installed'), deadline(30_000));
    await upstreamClient.prompt(mark('upstream-send'));
    expect((await upstreamClient.toolResult('upstream-to-fork', deadline(30_000))).result).toMatchObject({ details: { delivered: true } });
    const receivedFork = await fork.waitEvent('message_end', e => e.customType === 'intercom_message' && JSON.stringify(e.content).includes('R14 installed to fork'), deadline(30_000));
    expect(Number((await readFile(pidFile, 'utf8')).trim())).toBe(brokerPid);
    const beforeScript = JSON.parse(await readFile(suite.pi.scriptPath, 'utf8'));
    beforeScript.scripts['before-peer'] = parentTurns(tool('before-peer-steer', { action: 'message', to: beforeRun.id, message: 'R14 pre-migration peer steer' }));
    await writeFile(suite.pi.scriptPath, JSON.stringify(beforeScript));
    await fork.prompt(mark('before-peer'));
    const beforePeer = await fork.toolResult('before-peer-steer', deadline(30_000));
    expect(beforePeer.isError).toBe(false);
    expect(beforePeer.result).toMatchObject({ details: { accepted: true, delivered: false, delivery: 'broker-accepted', recipientAcknowledged: false } });
    gates.release('before-initial');
    const beforeReceived = await childEvent(suite, beforeReady.pid, 'message_end', e => e.customType === 'intercom_message' && JSON.stringify(e.content).includes('R14 pre-migration peer steer'), deadline(30_000));
    await gates.ready('before-final', deadline(60_000));
    const beforeTranscript = await childTranscript(suite, beforeReady.pid);
    expect(beforeTranscript.entries.filter(entry => entry.type === 'custom_message' && JSON.stringify(entry).includes('R14 pre-migration peer steer'))).toHaveLength(1);
    const beforeSteering = owner.prompt(mark('before-owner-steer'));
    await waitFor('base owner begins steering its pre-migration child', () => owner!.events(), events => events.some(e => e.type === 'tool_execution_start' && e.toolCallId === 'before-owner-steer'), deadline(30_000));
    gates.release('before-final');
    await beforeSteering;
    const beforeOwner = await owner.toolResult('before-owner-steer', deadline(30_000));
    expect(beforeOwner.result).toMatchObject({ details: { delivered: true, delivery: 'delivered' } });
    const beforeFinalTranscript = await childTranscript(suite, beforeReady.pid);
    expect(beforeFinalTranscript.entries.filter(entry => entry.type === 'message' && JSON.stringify(entry).includes('R14 before owner steer'))).toHaveLength(1);
    await owner.waitEvent('message_end', e => e.customType === 'spider.subagent_done' && JSON.stringify(e.content).includes('before completed'), deadline(60_000));
    await owner.prompt(mark('legacy-owner'));
    const spawn = await owner.toolResult('legacy-spawn', deadline(30_000));
    const run = (spawn.result as { details: { run: { id: string; status: string; intercom_session: string | null } } }).details.run;
    expect(run.status, JSON.stringify(spawn.result)).toBe('running');
    expect(run.intercom_session).toBeNull();
    const ready = await gates.ready('legacy-initial', deadline(60_000));
    const childProbe = (await readFile(probeLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(row => row.pid === ready.pid);
    expect(childProbe).toBeDefined();
    expect(childProbe.argv).toContain(baseBundle);
    expect(childProbe.argv.join(' ')).not.toContain(upstream);
    expect(childProbe.tools).not.toContain('intercom');
    const script = JSON.parse(await readFile(suite.pi.scriptPath, 'utf8'));
    script.scripts['fork-refuse'] = parentTurns(tool('legacy-peer-steer', { action: 'message', to: run.id, message: 'R14 forbidden peer steer' }));
    await writeFile(suite.pi.scriptPath, JSON.stringify(script));
    await fork.prompt(mark('fork-refuse'));
    const refused = await fork.toolResult('legacy-peer-steer', deadline(30_000));
    expect(refused.isError).toBe(true);
    expect(refused.result).toMatchObject({ details: { accepted: false, delivered: false, delivery: 'refused' } });
    expect(JSON.stringify(refused.result)).toMatch(/owned by session.*steer it from there/i);
    const steering = owner.prompt(mark('legacy-steer'));
    await waitFor('base owner begins steering its running child', () => owner!.events(), events => events.some(e => e.type === 'tool_execution_start' && e.toolCallId === 'legacy-owner-steer'), deadline(30_000));
    gates.release('legacy-initial');
    await steering;
    const delivered = await owner.toolResult('legacy-owner-steer', deadline(30_000));
    expect(delivered.result).toMatchObject({ details: { delivered: true, delivery: 'delivered' } });
    await gates.ready('legacy-final', deadline(60_000));
    const transcript = await childTranscript(suite, ready.pid);
    expect(transcript.entries.filter(entry => entry.type === 'message' && JSON.stringify(entry).includes('R14 owner steer'))).toHaveLength(1);
    expect(transcript.raw).not.toContain('R14 forbidden peer steer');
    gates.release('legacy-final');
    await owner.waitEvent('message_end', e => e.customType === 'spider.subagent_done' && JSON.stringify(e.content).includes('legacy result'), deadline(60_000));
    const afterHashes = Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(upstream, file)))])));
    expect(afterHashes).toEqual(installedHashes);
    expect(Number((await readFile(pidFile, 'utf8')).trim())).toBe(brokerPid);
    expect(() => process.kill(brokerPid, 0)).not.toThrow();
    await suite.evidence('R14-installed-upstream.json', { base: { sha256: digest(baseBytes), build: '2327c021' }, installed: { version: '0.13.0', hashes: installedHashes },
      brokerPid, brokerCommand, switchover, receivedUpstream, receivedFork,
      before: { run: beforeRun, childProbe: beforeProbe, peer: beforePeer, received: beforeReceived, owner: beforeOwner },
      after: { run, childProbe, peer: refused, owner: delivered } });
  } finally {
    await fork?.close(); await owner?.close(); await upstreamClient.close();
    if (!brokerTracked) {
      const remaining = await readFile(pidFile, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error;
      });
      if (/^\d+$/.test(remaining.trim())) await trackBroker();
    }
  }
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('R14'), title: 'RPC child steered across switchover with an unwrapped fork fixture', tiers: ['headless'], run: adoption },
  { id: storyId('R14local'), title: 'rolling reload with the installed upstream client', tiers: ['headless'],
    notExercised: env => env.SPIDER_HERDR_E2E_R14_BASE && env.SPIDER_HERDR_E2E_R14_UPSTREAM ? undefined : 'Set both R14 fixture environment variables', run: installedRollingReload },
];
registerScenarios(scenarios);
