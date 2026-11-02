// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import { installPromptObserver, installInPiSetupCommand } from '../fixtures/install-inputs.js';
import type { Suite } from '../harness/suite.js';
import { identityAlive } from '../harness/resources.js';
import { waitFor, deadline } from '../harness/wait.js';

async function launchObserver(suite: Suite): Promise<{ log: string; nodeOptions: string }> {
  const path = suite.ownPath(join(suite.root, 'setup-launch-observer.mjs')), log = suite.ownPath(join(suite.root, 'setup-launches.jsonl'));
  const source = `import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
const record = row => appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid, ...row})+'\\n', {mode:0o600});
record({kind:'node-start', argv:process.argv});
for (const name of ['spawn','spawnSync','execFile','execFileSync','exec','execSync']) {
  const original=cp[name];
  const observe=args=>record({kind:'child-process', command:args[0], args:Array.isArray(args[1])?args[1]:[]});
  const wrapped=function(...args) { observe(args); return Reflect.apply(original,this,args); };
  if (original[promisify.custom]) Object.defineProperty(wrapped,promisify.custom,{value:function(...args){observe(args);return Reflect.apply(original[promisify.custom],this,args);}});
  cp[name]=wrapped;
}
syncBuiltinESMExports();
`;
  await writeFile(path, source, { mode: 0o600 });
  return { log, nodeOptions: `${suite.pi.env.NODE_OPTIONS ?? suite.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(path).href}`.trim() };
}
function setupLaunch(row: { command?: string; args?: unknown[]; argv?: unknown[] }, cli: string) {
  const args = row.argv ?? row.args ?? [];
  return args.some((value, index) => value === cli && args[index + 1] === 'setup');
}
function guidance(source: string) {
  const managed = /<!-- spider:start -->[\s\S]*?<!-- spider:end -->/.exec(source)?.[0];
  assert.ok(managed, 'managed guidance is absent'); assert.ok(managed.length <= 8500, `managed guidance length ${managed.length}`);
  assert.match(managed, /HC_TERMINAL_ID/); assert.match(managed, /\bon\b/); assert.match(managed, /jobs/i); assert.match(managed, /message/i);
  assert.match(managed, /never[^\n]*hc send|(?:do not|don't)[^\n]*hc send/i);
  return managed;
}
const scripts = { scripts: { guidance: [{ steps: [{ text: 'Guidance fixture turn.' }] }] } };
export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('S04'), title: 'HC and non-HC sessions retain the same effective managed guidance', tiers: ['headless', 'ci'], script: scripts,
    async run(suite) {
      const log = await installPromptObserver(suite); const project = await suite.project('guidance');
      const first = await suite.launchPi({ mode: suite.cores ? 'interactive' : 'rpc', cwd: project });
      const firstStart = await first.waitEvent('session_start', () => true, deadline(30_000));
      if (suite.cores) { assert.equal(firstStart.mode, 'tui'); assert.ok(firstStart.hcTerminal, 'HC guidance case has no real terminal identity'); }
      else { assert.equal(firstStart.mode, 'rpc'); assert.equal(firstStart.hcTerminal, null); }
      assert.equal(suite.pi.env.PI_CODING_AGENT_DIR, suite.directories.PI_CODING_AGENT_DIR);
      const path = suite.ownPath(join(suite.directories.PI_CODING_AGENT_DIR, 'AGENTS.md'));
      const initial = guidance(await readFile(path, 'utf8'));
      const hcSection = initial.slice(initial.indexOf('## Herdr terminals'));
      assert.ok(hcSection.length <= 1000, `HC guidance adds ${hcSection.length} characters`);
      assert.throws(() => guidance(initial.replace(/HC_TERMINAL_ID/g, 'DISABLED')), /HC_TERMINAL_ID/);
      if (first.mode === 'interactive' || first.mode === 'rpc') await first.prompt('[[e2e:guidance]]');
      await first.waitEvent('agent_settled', () => true, deadline(30_000));
      const effective = await waitFor('effective prompt includes managed HC guidance', async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)), events => events.some(e => e.type === 'effective-prompt'), deadline(15_000));
      await suite.evidence('effective-guidance.json', effective);
      assert.ok(effective.some(e => e.type === 'effective-prompt' && e.pid === first.pid && e.systemPrompt?.includes(initial)), 'next real turn omitted the managed HC guidance');
      await first.close();
      const second = await suite.launchPi({ mode: 'rpc', cwd: project });
      assert.ok(second.mode === 'rpc', 'non-HC guidance needs the real RPC driver');
      const secondStart = await second.waitEvent('session_start', () => true, deadline(30_000));
      assert.equal(secondStart.mode, 'rpc'); assert.equal(secondStart.hcTerminal, null);
      assert.equal(guidance(await readFile(path, 'utf8')), initial);
      await second.prompt('[[e2e:guidance]]'); await second.waitEvent('agent_settled', () => true, deadline(30_000));
      const next = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      await suite.evidence('non-hc-effective-guidance.json', next);
      assert.ok(next.some(e => e.type === 'effective-prompt' && e.pid === second.pid && e.systemPrompt?.includes(initial)), 'non-HC turn omitted the managed guidance');
      await second.close();
      await suite.keepEvidence(path, 'AGENTS.md');
    },
  },
  { id: storyId('S14'), title: 'The real setup command prints a quoted shell hint and refuses installation inside pi', tiers: ['headless', 'ci'], script: { scripts: { 'hint-baseline': [{ steps: [{ text: 'Baseline fixture conversation.' }] }] } },
    async run(suite) {
      const project = await suite.project('setup hint'); const config = suite.ownPath(join(suite.root, 'config with spaces.json'));
      await writeFile(config, '{}', { mode: 0o600 });
      const before = await readFile(config); const launches = await launchObserver(suite);
      const calibration = await suite.invoke(process.execPath, [suite.packed.cli, 'setup', '--config', config], { ...suite.env, NODE_OPTIONS: launches.nodeOptions });
      assert.notEqual(calibration.exitCode, 0, 'invalid config is only the actual setup-launch calibration');
      const readLaunches = async () => (await readFile(launches.log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.ok((await readLaunches()).some(row => setupLaunch(row, suite.packed.cli)), 'observer missed a real setup process');
      const offset = (await readLaunches()).length;
      const pi = await suite.launchPi({ mode: suite.cores ? 'interactive' : 'rpc', cwd: project, extraEnv: { NODE_OPTIONS: launches.nodeOptions } });
      if (pi.mode !== 'rpc' && pi.mode !== 'interactive') throw new Error('real prompt driver required');
      const start = await pi.waitEvent('session_start', () => true, deadline(30_000));
      await pi.prompt('[[e2e:hint-baseline]]'); await pi.waitEvent('agent_settled', () => true, deadline(30_000));
      assert.equal(typeof start.sessionFile, 'string');
      const initialDraft = pi.mode === 'interactive' ? await pi.draft() : null;
      await pi.prompt(`/herdr-setup ${config}`);
      const entries = await waitFor('real setup hint is durably saved', async () => (await readFile(String(start.sessionFile), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)), entries => entries.some(e => e.type === 'custom_message' && e.customType === 'spider.command'), deadline(20_000));
      const hint = entries.find(e => e.type === 'custom_message' && e.customType === 'spider.command');
      const text = typeof hint.content === 'string' ? hint.content : JSON.stringify(hint.content);
      assert.ok(text.includes(`'${suite.packed.cli}' setup --config '${config}'`), text);
      assert.match(text, /plain shell/); assert.match(text, /Close selected sessions/);
      assert.throws(() => assert.ok(text.includes("'wrong-config.json'")), assert.AssertionError);
      if (pi.mode === 'interactive') assert.equal(await pi.draft(), initialDraft);
      assert.equal((await pi.events()).filter(e => e.type === 'session_shutdown').length, 0);
      assert.deepEqual(await readFile(config), before);
      assert.equal((await pi.events()).find(e => e.type === 'session_start')?.sessionId, start.sessionId);
      const observedLaunches = (await readLaunches()).slice(offset);
      assert.equal(observedLaunches.filter(row => setupLaunch(row, suite.packed.cli)).length, 0, 'the real hint command launched setup');
      assert.ok(identityAlive(pi.identity), 'the hint command ended the actual pi process');
      await suite.evidence('setup-hint-processes.json', observedLaunches);
      await suite.evidence('setup-hint.json', hint);
      await pi.close();
      await installInPiSetupCommand(suite, config);
      const inside = await suite.launchPi({ mode: 'rpc', cwd: project, label: 'inside-pi' });
      if (inside.mode !== 'rpc') throw new Error('RPC command driver required');
      await inside.waitEvent('session_start', () => true, deadline(30_000));
      await assert.rejects(inside.rpc({ type: 'prompt', message: '/fixture-in-pi-setup' }), /rpc-exited.*"code":1/);
      const refusalPath = join(suite.root, 'logs/inside-pi.err');
      const refusal = await readFile(refusalPath, 'utf8');
      await suite.keepEvidence(refusalPath, 'inside-pi-refusal.txt');
      assert.match(refusal, /setup-requires-plain-shell/); await inside.close();
      assert.deepEqual(await readFile(config), before);
    },
  },
];
