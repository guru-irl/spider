// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { buildEnvironment, checkoutRoot, createFencedDirectories, createFixtureRoot } from '../environment.js';
import { openLedger, cleanupLedger, type LedgerHandle } from '../resources.js';
import { stagePackedBuild } from '../pack.js';
import { preparePi, launchPi, createGateServer, writeScript, type PiEnvironment, type RpcDriver, type OneShotDriver } from '../pi.js';
import { jsonLines } from '../processes.js';
import { createSuite } from '../suite.js';
import { storyId } from '../scenario.js';
import type { InteractiveDriver } from '../pi.js';
import { deadline, waitFor } from '../wait.js';
import { readObserved } from '../pi.js';
import { marker, type ScriptFile } from '../../fixtures/scripted-provider.js';

const STORY = 'H-pi';
const script: ScriptFile = { story: STORY, scripts: {
  hello: [{ steps: [{ text: 'scripted hello' }] }],
  exec: [
    { steps: [{ tool: { id: 'call-exec-1', name: 'spider', arguments: { action: 'exec', language: 'shell', code: "printf 'local-out\\n'; printf 'local-err\\n' >&2; exit 0" } } }] },
    { steps: [{ text: 'exec done' }] },
  ],
  gated: [{ steps: [{ gate: 'g1' }, { text: 'released text' }] }],
  boom: [{ steps: [{ error: 'scripted provider failure' }] }],
} };

let root: string, ledger: LedgerHandle, pi: PiEnvironment; const ledgers: string[] = [];
beforeAll(async () => {
  root = await createFixtureRoot();
  const dir = join(root, '..', '_test-ledgers', root.split('/').at(-1)!); mkdirSync(dir, { recursive: true }); ledgers.push(dir);
  ledger = openLedger(dir, root);
  const env = buildEnvironment(process.env, await createFencedDirectories(root), { binDirectory: join(root, 'bin') });
  pi = await preparePi(root, env, stagePackedBuild(), STORY, script);
  mkdirSync(join(root, 'proj'));
  spawnSync('git', ['init', '-q', join(root, 'proj')]);
});
afterAll(async () => {
  const proof = await cleanupLedger(ledger.path, 'pi.test');
  expect(proof.clean, JSON.stringify(proof.survivors)).toBe(true);
  rmSync(root, { recursive: true, force: true }); for (const d of ledgers) rmSync(d, { recursive: true, force: true });
});

describe('real pi mode selection', () => {
  it('RPC launches report ctx.mode rpc and settle a scripted turn', async () => {
    const driver = await launchPi(pi, ledger, { mode: 'rpc', cwd: join(root, 'proj') }) as RpcDriver;
    try {
      const start = await driver.waitEvent('session_start', () => true, deadline(60_000));
      expect(start).toMatchObject({ mode: 'rpc', model: 'e2e-fixture/scripted', hcTerminal: null });
      await driver.prompt(`${marker('hello')} say hello`);
      const reply = await driver.waitEvent('message_end', e => e.role === 'assistant', deadline(5_000));
      expect(reply).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'scripted hello' }] });
    } finally { await driver.close(); }
  });

  it('print and json launches report their own modes; interactive refuses without an hc terminal', async () => {
    for (const mode of ['print', 'json'] as const) {
      const driver = await launchPi(pi, ledger, { mode, cwd: join(root, 'proj'), prompt: `${marker('hello')} hi` }) as OneShotDriver;
      expect(await driver.exited).toEqual({ code: 0, signal: null });
      expect((await driver.waitEvent('session_start', () => true, deadline(5_000))).mode).toBe(mode);
    }
    await expect(launchPi(pi, ledger, { mode: 'interactive', cwd: join(root, 'proj') })).rejects.toThrow(/interactive-needs-terminal/);
  });
});

describe('scripted provider', () => {
  it('pi executes a scripted spider exec call through the packed extension and returns the real local result', async () => {
    const driver = await launchPi(pi, ledger, { mode: 'rpc', cwd: join(root, 'proj') }) as RpcDriver;
    try {
      await driver.prompt(`${marker('exec')} run it`, deadline(90_000));
      const result = await driver.toolResult('call-exec-1', deadline(5_000));
      expect(result.toolName).toBe('spider'); expect(result.isError).toBe(false);
      const text = JSON.stringify(result.result);
      expect(text).toContain('local-out'); expect(text).toContain('local-err');
      const final = await driver.waitEvent('message_end', e => e.role === 'assistant' && e.stopReason === 'stop', deadline(5_000));
      expect(final.content).toEqual([{ type: 'text', text: 'exec done' }]);
    } finally { await driver.close(); }
  });

  it('reports unknown markers, scripted errors and exhausted scripts as provider errors, never success text', async () => {
    const driver = await launchPi(pi, ledger, { mode: 'rpc', cwd: join(root, 'proj') }) as RpcDriver;
    try {
      for (const [prompt, pattern] of [[`${marker('nope')} x`, /unknown marker nope/], [`${marker('boom')} x`, /scripted provider failure/], ['no marker here', /script boom exhausted after 1 turns/]] as const) {
        const before = Date.now();
        await driver.prompt(prompt, deadline(60_000));
        const end = await driver.waitEvent('message_end', e => e.role === 'assistant' && e.at >= before, deadline(5_000));
        expect(end.stopReason).toBe('error'); expect(String(end.errorMessage)).toMatch(pattern);
      }
    } finally { await driver.close(); }
    const fresh = await launchPi(pi, ledger, { mode: 'json', cwd: join(root, 'proj'), prompt: 'no marker here' }) as OneShotDriver;
    await fresh.exited;
    const end = await fresh.waitEvent('message_end', e => e.role === 'assistant', deadline(5_000));
    expect(end.stopReason).toBe('error'); expect(String(end.errorMessage)).toMatch(/no \[\[e2e:<marker>\]\] in the conversation/);
  });

  it('a gate waits for its release; closing the control connection aborts the request; duplicate releases fail', async () => {
    const gates = await createGateServer(pi.gateSocket, STORY);
    const driver = await launchPi(pi, ledger, { mode: 'rpc', cwd: join(root, 'proj') }) as RpcDriver;
    try {
      await driver.waitEvent('session_start', () => true, deadline(60_000));
      let before = Date.now();
      await driver.rpc({ type: 'prompt', message: `${marker('gated')} wait` });
      const ready = await gates.ready('g1', deadline(30_000));
      expect(ready).toMatchObject({ story: STORY, gate: 'g1', marker: 'gated', pid: driver.pid });
      expect((await driver.events()).some(e => e.type === 'message_end' && e.role === 'assistant' && e.at >= before)).toBe(false);
      gates.release('g1');
      expect(() => gates.release('g1')).toThrow(/gate-already-released/);
      const released = await driver.waitEvent('message_end', e => e.role === 'assistant' && e.at >= before, deadline(10_000));
      expect(released).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'released text' }] });
      await driver.waitEvent('agent_settled', e => e.at >= before, deadline(10_000));

      before = Date.now();
      await driver.rpc({ type: 'prompt', message: `${marker('gated')} again` });
      await gates.ready('g1', deadline(30_000));
      gates.abort('g1');
      const aborted = await driver.waitEvent('message_end', e => e.role === 'assistant' && e.at >= before, deadline(10_000));
      expect(aborted.stopReason).toBe('error'); expect(String(aborted.errorMessage)).toMatch(/gate-aborted/);
      await driver.waitEvent('agent_settled', e => e.at >= before, deadline(10_000));

      before = Date.now();
      await driver.rpc({ type: 'prompt', message: `${marker('gated')} malformed` });
      await gates.ready('g1', deadline(30_000));
      gates.sendRaw('g1', '{not json\n');
      const malformed = await driver.waitEvent('message_end', e => e.role === 'assistant' && e.at >= before, deadline(10_000));
      expect(malformed.stopReason).toBe('error'); expect(String(malformed.errorMessage)).toMatch(/gate-malformed/);
      expect(() => gates.release('missing')).toThrow(/gate-not-ready/);
    } finally { await driver.close(); await gates.close(); }
  });

  it('a gate refuses a release for another story', async () => {
    await writeScript(pi.scriptPath, { ...script, story: 'H-other' });
    const gates = await createGateServer(pi.gateSocket, STORY);
    const driver = await launchPi(pi, ledger, { mode: 'rpc', cwd: join(root, 'proj') }) as RpcDriver;
    try {
      const before = Date.now();
      await driver.rpc({ type: 'prompt', message: `${marker('gated')} wrong story` });
      const end = await driver.waitEvent('message_end', e => e.role === 'assistant' && e.at >= before, deadline(60_000));
      expect(end.stopReason).toBe('error'); expect(String(end.errorMessage)).toMatch(/gate-aborted/);
      expect(gates.errors()).toEqual(['ready from story H-other']);
    } finally { await driver.close(); await gates.close(); await writeScript(pi.scriptPath, script); }
  });
});

describe('stream framing and source guard', () => {
  it('the fenced models.json alone exposes the synthetic model, without loading any extension', () => {
    const bare = join(root, 'agent-catalog-only'); mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, 'models.json'), readFileSync(join(pi.env.PI_CODING_AGENT_DIR, 'models.json')));
    const listed = spawnSync(pi.launcher, ['--list-models', 'e2e-fixture'], { env: { ...pi.env, PI_CODING_AGENT_DIR: bare }, encoding: 'utf8', timeout: 60_000 });
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toMatch(/e2e-fixture\s+scripted\s+200K/);
  });
  it('strict JSONL keeps Unicode separators inside records and reports malformed records', () => {
    const records: unknown[] = [], bad: string[] = [];
    const feed = jsonLines(r => records.push(r), l => bad.push(l));
    feed(Buffer.from('{"a":"x\u2028y"}\n{"b":'));
    feed(Buffer.from('1}\r\nnot json\n[1]\n'));
    expect(records).toEqual([{ a: 'x\u2028y' }, { b: 1 }]);
    expect(bad).toEqual(['not json', '[1]']);
  });

  it('the pi launcher refuses a runtime import of workspace source', () => {
    const entry = join(root, 'fake-cli.mjs');
    writeFileSync(entry, `await import(${JSON.stringify(join(checkoutRoot(), 'packages/herdr/src/config.ts'))});\n`);
    const result = spawnSync(pi.launcher, [], { env: { ...pi.env }, encoding: 'utf8' });
    expect(result.status).not.toBe(97);
    const guarded = spawnSync(process.execPath, [join(checkoutRoot(), 'packages/herdr/e2e/fixtures/pi-launch.mjs')], { env: { ...pi.env, SPIDER_E2E_PI_CLI: entry, SPIDER_E2E_SOURCE_GUARD: join(checkoutRoot(), 'packages') }, encoding: 'utf8' });
    expect(guarded.status).not.toBe(0);
    expect(guarded.stderr).toMatch(/e2e-source-import-refused: file:.*\/packages\/herdr\/src\/config\.ts/);
  });
});

describe('real spider child', () => {
  it('spider run starts a real child pi through the launcher that uses the fixture provider and executes its own scripted tool call', async () => {
    await writeScript(pi.scriptPath, { story: STORY, scripts: {
      ...script.scripts,
      parent: [
        { steps: [{ tool: { id: 'call-run-1', name: 'spider', arguments: { action: 'run', agent: 'worker', name: 'fixture-child', model: 'e2e-fixture/scripted', task: `${marker('child')} do the child work` } } }] },
        { steps: [{ text: 'parent waiting' }] }, { steps: [{ text: 'parent noted' }] }, { steps: [{ text: 'parent noted again' }] },
      ],
      child: [
        { steps: [{ tool: { id: 'call-child-exec', name: 'spider', arguments: { action: 'exec', language: 'shell', code: "printf 'child-out\\n'" } } }] },
        { steps: [{ text: 'child done' }] },
      ],
    } });
    const driver = await launchPi(pi, ledger, { mode: 'rpc', cwd: join(root, 'proj') }) as RpcDriver;
    try {
      await driver.prompt(`${marker('parent')} start a child`, deadline(90_000));
      const run = await driver.toolResult('call-run-1', deadline(5_000));
      expect(run.isError, JSON.stringify(run.result)).toBe(false);
      const all = await waitFor('child session_start', () => readObserved(pi.observerDir), list => list.some(e => e.type === 'session_start' && e.subagentChild === '1'), deadline(120_000), { reconcileMs: 250 });
      const childStart = all.find(e => e.type === 'session_start' && e.subagentChild === '1')!;
      expect(childStart.pid).not.toBe(driver.pid);
      expect(childStart.model).toBe('e2e-fixture/scripted');
      const childEvents = await waitFor('child final text', () => readObserved(pi.observerDir, childStart.pid), list => list.some(e => e.type === 'message_end' && e.role === 'assistant' && e.stopReason === 'stop'), deadline(120_000), { reconcileMs: 250 });
      const exec = childEvents.find(e => e.type === 'tool_execution_end' && e.toolCallId === 'call-child-exec')!;
      expect(exec.isError).toBe(false);
      expect(JSON.stringify(exec.result)).toContain('child-out');
      expect(childEvents.find(e => e.type === 'message_end' && e.role === 'assistant' && e.stopReason === 'stop')!.content).toEqual([{ type: 'text', text: 'child done' }]);
    } finally { await driver.close(); await writeScript(pi.scriptPath, script); }
  }, 300_000);

  it('control: with the provider removed from subagents.extensions the child fails with no stream for the fixture api', async () => {
    const configPath = join(pi.env.SPIDER_GLOBAL_ROOT, 'config.json');
    const original = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(original), 'subagents.extensions': [pi.observerPath] }));
    await writeScript(pi.scriptPath, { story: STORY, scripts: { ...script.scripts,
      parent: [{ steps: [{ tool: { id: 'call-run-2', name: 'spider', arguments: { action: 'run', agent: 'worker', name: 'fixture-child-2', model: 'e2e-fixture/scripted', task: `${marker('child')} control` } } }] }, { steps: [{ text: 'a' }] }, { steps: [{ text: 'b' }] }, { steps: [{ text: 'c' }] }],
      child: [{ steps: [{ text: 'child done' }] }] } });
    const driver = await launchPi(pi, ledger, { mode: 'rpc', cwd: join(root, 'proj') }) as RpcDriver;
    try {
      const before = Date.now();
      await driver.prompt(`${marker('parent')} start a child`, deadline(90_000));
      const run = await driver.toolResult('call-run-2', deadline(5_000));
      expect(run.isError).toBe(false);
      const all = await waitFor('parent receives the child completion', () => readObserved(pi.observerDir), l => l.some(e => e.pid === driver.pid && e.customType === 'spider.subagent_done' && e.at > before), deadline(150_000), { reconcileMs: 500 });
      const child = all.find(e => e.type === 'session_start' && e.subagentChild === '1' && e.at >= before)!;
      const childEnds = all.filter(e => e.pid === child.pid && e.type === 'message_end' && e.role === 'assistant');
      expect(childEnds).toEqual([expect.objectContaining({ stopReason: 'error', errorMessage: 'No API provider registered for api: e2e-fixture-api' })]);
    } finally { await driver.close(); writeFileSync(configPath, original); await writeScript(pi.scriptPath, script); }
  }, 300_000);
});

describe('interactive pi in a real hc terminal', () => {
  it('runs in TUI mode with a real hc terminal id, honours extraEnv, and takes broker input; a pipe-only launch is the failing control', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-tui'), script: { story: 'H-tui', scripts: { hello: [{ steps: [{ text: 'tui hello' }] }] } } });
    try {
      const cwd = await suite.project('tui');
      const tui = await suite.launchPi({ mode: 'interactive', cwd, extraEnv: { SPIDER_E2E_PROBE: 'interactive-env' } }) as InteractiveDriver;
      const start = await tui.waitEvent('session_start', () => true, deadline(90_000));
      expect(start).toMatchObject({ mode: 'tui', hasUI: true, stdinTTY: true, hcTerminal: tui.terminal, probe: 'interactive-env' });
      const got = await suite.hc(['get', tui.terminal, '--json']);
      expect(got.exitCode, got.stderr).toBe(0);
      expect(JSON.stringify(got.json)).toContain(tui.terminal);
      await tui.key('dra\u00e9ft');
      await expect.poll(() => tui.draft(), { timeout: 20_000 }).toBe('dra\u00e9ft');
      await tui.key('\u0015');
      await expect.poll(() => tui.draft(), { timeout: 20_000 }).toBe('');
      const before = Date.now();
      await tui.prompt(`${marker('hello')} from the keyboard`);
      const reply = await tui.waitEvent('message_end', e => e.role === 'assistant' && e.at >= before, deadline(60_000));
      expect(reply.content).toEqual([{ type: 'text', text: 'tui hello' }]);
      await suite.evidence('tui-raw.log', await tui.rawOutput());
      await tui.close();

      // Control: the same launcher with only pipes and no mode flag must not be TUI.
      const piped = spawnSync(suite.pi.launcher, [`${marker('hello')} piped`], { cwd, env: { ...suite.env, SPIDER_E2E_PROBE: 'piped' }, input: '', encoding: 'utf8', timeout: 120_000 });
      expect(piped.status, piped.stderr).toBe(0);
      const all = await (await import('../pi.js')).readObserved(suite.pi.observerDir);
      const control = all.find(e => e.type === 'session_start' && e.probe === 'piped');
      expect(control).toMatchObject({ mode: 'print', hasUI: false, stdinTTY: false });
    } finally { await suite.close(); }
  }, 300_000);
});
