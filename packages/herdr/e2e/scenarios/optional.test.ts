// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import { readObserved, type InteractiveDriver, type RpcDriver } from '../harness/pi.js';
import { identityAlive, identityOf } from '../harness/resources.js';
import { deadline, waitFor } from '../harness/wait.js';
import { marker } from '../fixtures/scripted-provider.js';
import { configureHerdr, installScripts } from '../fixtures/session-scripts.js';
import { quitPi } from '../fixtures/lifecycle-driver.js';

function herdrUi(records: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return records.filter(row => row.type === 'extension_ui_request' && /herdr/i.test(JSON.stringify(row)));
}
function assertSilent(records: readonly Record<string, unknown>[], stderr: string): void {
  expect(herdrUi(records), 'unexpected Herdr UI when there is no config or Herdr is disabled').toEqual([]);
  expect(stderr, 'unexpected Herdr diagnostic').not.toMatch(/herdr (?:disabled|off|unavailable)/i);
}

export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S49'), title: 'Herdr remains optional', tiers: ['headless', 'ci'],
  async run(suite) {
    const project = await suite.project('optional');
    const bin = join(suite.root, 'bin');
    const sentinel = join(suite.root, 'ssh-invocations');
    const ssh = join(bin, 'ssh');
    await writeFile(ssh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sentinel}'\nprintf 'sentinel-ok\\n'\n`);
    await chmod(ssh, 0o700);
    const forbiddenCalls = join(suite.root, 'inactive-external-calls');
    const app = join(bin, 'herdr-app');
    await writeFile(app, `#!/bin/sh\nprintf 'app %s\\n' "$*" >> '${forbiddenCalls}'\nexit 97\n`);
    await chmod(app, 0o700);
    if (!suite.cores) {
      const hc = join(bin, 'hc');
      await writeFile(hc, `#!/bin/sh\nprintf 'hc %s\\n' "$*" >> '${forbiddenCalls}'\nexit 97\n`);
      await chmod(hc, 0o700);
    }
    const control = await suite.invoke(app, ['negative-control']);
    expect(control.exitCode).toBe(97);
    expect(await readFile(forbiddenCalls, 'utf8')).toContain('app negative-control');
    await writeFile(forbiddenCalls, '');
    const localCode = "printf 'ordinary-ok\\n'; ssh target.invalid 'one argument'";
    const remoteEffect = join(suite.root, 'forbidden-effect');
    await installScripts(suite, {
      local: [{ steps: [{ tool: { id: 'local', name: 'spider', arguments: { action: 'exec', language: 'shell', code: localCode } } }] }, { steps: [{ text: 'local complete' }] }],
      remote: [{ steps: [{ tool: { id: 'remote', name: 'spider', arguments: { action: 'exec', language: 'shell', on: 'dest.invalid', code: `printf unexpected > '${remoteEffect}'` } } }] }, { steps: [{ text: 'remote refused' }] }],
      spawn: [{ steps: [{ tool: { id: 'spawn', name: 'spider', arguments: { action: 'run', agent: 'worker', name: 'fixture-child', model: 'e2e-fixture/scripted', task: `${marker('child')} exercise local and remote execution` } } }] }, { steps: [{ text: 'child started' }] }, { steps: [{ text: 'child result received' }] }],
      'repo-config': [
        { steps: [{ tool: { id: 'repo-enabled', name: 'spider', arguments: { action: 'control', command: 'config', op: 'get', key: 'herdr.enabled' } } }] },
        { steps: [{ tool: { id: 'repo-path', name: 'spider', arguments: { action: 'control', command: 'config', op: 'get', key: 'herdr.config' } } }] },
        { steps: [{ tool: { id: 'repo-enabled-again', name: 'spider', arguments: { action: 'control', command: 'config', op: 'get', key: 'herdr.enabled' } } }] },
        { steps: [{ tool: { id: 'repo-path-again', name: 'spider', arguments: { action: 'control', command: 'config', op: 'get', key: 'herdr.config' } } }] },
        { steps: [{ text: 'repository config checked' }] },
      ],
      child: [
        { steps: [{ tool: { id: 'child-local', name: 'spider', arguments: { action: 'exec', language: 'shell', code: localCode } } }] },
        { steps: [{ tool: { id: 'child-remote', name: 'spider', arguments: { action: 'exec', language: 'shell', on: 'dest.invalid', code: `printf unexpected > '${remoteEffect}'` } } }] },
        { steps: [{ gate: 'child-held' }, { text: 'child complete' }] },
      ],
    });
    // Negative control: an actual footer-shaped diagnostic must fail the silence assertion.
    expect(() => assertSilent([{ type: 'extension_ui_request', method: 'setStatus', statusText: 'Herdr off' }], '')).toThrow();
    const gates = await suite.gates();
    const cases: { name: string; enabled: boolean | 'auto' | undefined; config: boolean; dead: boolean; notice: 'none' | 'warning' | 'error' }[] = [
      { name: 'false', enabled: false, config: true, dead: true, notice: 'none' },
      { name: 'unset', enabled: undefined, config: false, dead: false, notice: 'none' },
      { name: 'auto', enabled: 'auto', config: false, dead: false, notice: 'none' },
      { name: 'outside', enabled: 'auto', config: true, dead: false, notice: 'warning' },
      { name: 'dead', enabled: 'auto', config: true, dead: true, notice: 'warning' },
      { name: 'explicit', enabled: true, config: true, dead: true, notice: 'error' },
    ];
    const failures: string[] = [];
    for (const test of cases) {
      await configureHerdr(suite, test.enabled, test.config);
      const before = suite.cores ? (await suite.cores.records()).length : 0;
      const extraEnv: Record<string, string> = test.dead ? { HC_SESSION: 'l', HC_TERMINAL_ID: 'fixture-terminal', HC_TERMINAL_SOCKET: join(suite.root, 'dead.sock'), HC_SOCKET: join(suite.root, 'dead.sock') } : {};
      const pi = await suite.launchPi({ mode: 'rpc', cwd: project, label: `optional-${test.name}`, extraEnv }) as RpcDriver;
      let held = false;
      try {
        await pi.waitEvent('session_start', () => true, deadline(60_000));
        await pi.prompt(`${marker('local')} run a local command`, deadline(90_000));
        const local = await pi.toolResult('local', deadline(10_000));
        expect(local.isError, JSON.stringify(local)).toBe(false);
        expect(JSON.stringify(local.result)).toContain('ordinary-ok');
        expect(JSON.stringify(local.result)).toContain('sentinel-ok');
        await pi.prompt(`${marker('remote')} refuse the remote command`, deadline(90_000));
        const remote = await pi.toolResult('remote', deadline(10_000));
        expect(remote.isError, JSON.stringify(remote)).toBe(true);
        expect(JSON.stringify(remote.result)).toMatch(/herdr-(disabled|unavailable)/i);
        expect(existsSync(remoteEffect)).toBe(false);
        await pi.prompt(`${marker('spawn')} start the child`, deadline(90_000));
        expect((await pi.toolResult('spawn', deadline(10_000))).isError).toBe(false);
        const child = await gates.ready('child-held', deadline(90_000)); held = true;
        const identity = identityOf(child.pid);
        const childEvents = await readObserved(suite.pi.observerDir, child.pid);
        expect(childEvents.find(e => e.type === 'session_start')).toMatchObject({ subagentChild: '1', mode: 'rpc' });
        const childLocal = childEvents.find(e => e.type === 'tool_execution_end' && e.toolCallId === 'child-local');
        const childRemote = childEvents.find(e => e.type === 'tool_execution_end' && e.toolCallId === 'child-remote');
        expect(childLocal).toMatchObject({ isError: false });
        expect(JSON.stringify(childLocal?.result)).toContain('sentinel-ok');
        expect(childRemote).toMatchObject({ isError: true });
        expect(JSON.stringify(childRemote?.result)).toMatch(/herdr-(disabled|unavailable)/i);
        expect(existsSync(remoteEffect)).toBe(false);
        const herdr = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr');
        await waitFor('parent and child presence', async () => (await readdir(join(herdr, 'processes')).catch(() => [])).length, n => n === 2, deadline(20_000));
        for (const name of ['sessions', 'ipc', 'ssh']) expect(existsSync(join(herdr, name)), name).toBe(false);
        if (suite.cores) expect((await suite.cores.records()).slice(before)).toEqual([]);
        expect(await readFile(forbiddenCalls, 'utf8'), 'no hc or app launch while inactive').toBe('');
        expect((await readFile(sentinel, 'utf8')).trim().split('\n').slice(-2)).toEqual(['target.invalid one argument', 'target.invalid one argument']);
        await suite.evidence(`optional-${test.name}-child.json`, childEvents);
        const completionAt = Date.now();
        gates.release('child-held'); held = false;
        await waitFor('child completion', () => identityAlive(identity), alive => !alive, deadline(30_000));
        await pi.waitEvent('message_end', e => e.at >= completionAt && e.customType === 'spider.subagent_done', deadline(30_000));
        await pi.waitEvent('agent_settled', e => e.at >= completionAt, deadline(30_000));
        expect((await pi.events()).filter(e => e.at >= completionAt && e.type === 'message_end' && e.role === 'assistant').every(e => e.stopReason !== 'error')).toBe(true);
        const stderr = await readFile(join(suite.root, 'logs', `optional-${test.name}.err`), 'utf8');
        const records = pi.records();
        if (test.notice === 'none') assertSilent(records, stderr);
        else {
          const ui = herdrUi(records);
          expect(ui.filter(row => row.method === 'setStatus' && row.statusText), 'no persistent Herdr footer').toEqual([]);
          const notices = ui.filter(row => row.method === 'notify');
          expect(notices, 'one Herdr notice per session').toHaveLength(1);
          if (test.notice === 'error') expect(notices[0].notifyType).toBe('error');
        }
      } catch (error) { failures.push(`${test.name}: ${String((error as Error).stack ?? error)}`); }
      finally {
        if (held) gates.abort('child-held');
        await suite.evidence(`optional-${test.name}-events.json`, await pi.events());
        await suite.evidence(`optional-${test.name}-rpc.json`, pi.records());
        await suite.evidence(`optional-${test.name}-stderr.txt`, await readFile(join(suite.root, 'logs', `optional-${test.name}.err`), 'utf8'));
        await pi.close();
      }
    }
    await configureHerdr(suite, false, false);
    await mkdir(join(project, '.spider'), { recursive: true });
    await writeFile(join(project, '.spider', 'config.json'), JSON.stringify({ 'herdr.enabled': true, 'herdr.config': join(suite.root, 'herdr.json') }));
    const repoPi = await suite.launchPi({ mode: 'rpc', cwd: project, label: 'optional-repo' }) as RpcDriver;
    try {
      await repoPi.waitEvent('session_start', () => true, deadline(60_000));
      await repoPi.prompt(`${marker('repo-config')} inspect effective config`, deadline(90_000));
      const enabled = await repoPi.toolResult('repo-enabled', deadline(10_000));
      const path = await repoPi.toolResult('repo-path', deadline(10_000));
      expect((enabled.result as { details?: unknown }).details).toMatchObject({ key: 'herdr.enabled', value: false, source: 'global' });
      expect((path.result as { details?: unknown }).details).toMatchObject({ key: 'herdr.config', value: '', source: 'default' });
      const enabledAgain = await repoPi.toolResult('repo-enabled-again', deadline(10_000));
      const pathAgain = await repoPi.toolResult('repo-path-again', deadline(10_000));
      expect((enabledAgain.result as { details?: unknown }).details).toMatchObject({ key: 'herdr.enabled', value: false, source: 'global' });
      expect((pathAgain.result as { details?: unknown }).details).toMatchObject({ key: 'herdr.config', value: '', source: 'default' });
      const warnings = repoPi.records().filter(row => row.type === 'extension_ui_request' && row.method === 'notify' && /herdr/i.test(String(row.message)) && /ignor|global/i.test(String(row.message)));
      expect(warnings, 'one warning per ignored key, with no repeats after later reads').toHaveLength(2);
      for (const key of ['herdr.config', 'herdr.enabled']) expect(warnings.filter(row => String(row.message).includes(key)), key).toHaveLength(1);
    } catch (error) { failures.push(`repository config: ${String((error as Error).stack ?? error)}`); }
    finally {
      await suite.evidence('optional-repo-events.json', await repoPi.events());
      await suite.evidence('optional-repo-rpc.json', repoPi.records());
      await repoPi.close();
    }
    if (suite.options.tier !== 'ci') {
      const originalLauncher = suite.pi.launcher;
      const variants: { name: string; enabled: boolean | 'auto' | undefined; config: boolean; wrapper: string; silent: boolean }[] = [
        { name: 'false-tui', enabled: false, config: true, wrapper: 'normal', silent: true },
        { name: 'outside-tui', enabled: undefined, config: false, wrapper: 'outside', silent: true },
        { name: 'dead-tui', enabled: 'auto', config: true, wrapper: 'dead', silent: false },
      ];
      for (const test of variants) {
        const cwd = await suite.project(test.name);
        await configureHerdr(suite, test.enabled, test.config);
        const wrapper = suite.ownPath(join(bin, `pi-${test.name}`));
        const scrub = test.wrapper === 'outside' ? 'unset HC_SESSION HC_SOCKET HC_TERMINAL_ID HC_TERMINAL_SOCKET HC_SCOPE\n'
          : test.wrapper === 'dead' ? `HC_SOCKET='${join(suite.root, 'dead.sock')}'; HC_TERMINAL_SOCKET="$HC_SOCKET"; export HC_SOCKET HC_TERMINAL_SOCKET\n` : '';
        await writeFile(wrapper, `#!/bin/sh\n${scrub}exec '${originalLauncher}' "$@"\n`); await chmod(wrapper, 0o700);
        suite.pi.launcher = wrapper;
        const pi = await suite.launchPi({ mode: 'interactive', cwd, extraEnv: { PI_PROGRAM_STATUS: '1' } }) as InteractiveDriver;
        suite.pi.launcher = originalLauncher;
        try {
          const start = await pi.waitEvent('session_start', () => true, deadline(60_000));
          expect(start.mode).toBe('tui');
          if (test.wrapper === 'outside') expect(start.hcTerminal).toBeNull();
          else expect(start.hcTerminal).toBe(pi.terminal);
          const localAt = Date.now(); await pi.prompt(`${marker('local')} ordinary local work`);
          await pi.waitEvent('agent_settled', event => event.at >= localAt, deadline(90_000));
          const local = await pi.toolResult('local', deadline(10_000));
          expect(local.isError).toBe(false); expect(JSON.stringify(local.result)).toContain('sentinel-ok');
          const remoteAt = Date.now(); await pi.prompt(`${marker('remote')} refuse remote execution`);
          await pi.waitEvent('agent_settled', event => event.at >= remoteAt, deadline(90_000));
          const remote = await pi.toolResult('remote', deadline(10_000));
          expect(remote.isError).toBe(true); expect(JSON.stringify(remote.result)).toMatch(/herdr-(disabled|unavailable)/i);
          expect(existsSync(remoteEffect)).toBe(false);
          const calls = (await suite.cores!.records()).filter(record => record.ppid === pi.pid);
          expect(calls, 'no spider-side hc calls while inactive').toEqual([]);
          const herdr = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr');
          for (const name of ['sessions', 'ipc', 'ssh']) expect(existsSync(join(herdr, name)), name).toBe(false);
          const raw = (await pi.rawOutput()).toString('utf8');
          if (test.silent) expect(raw).not.toMatch(/Herdr off|Herdr disabled/i);
          else expect(raw, 'no persistent Herdr-off footer').not.toMatch(/Herdr off:/i);
          await quitPi(pi);
        } catch (error) { failures.push(`${test.name}: ${String((error as Error).stack ?? error)}`); }
        finally {
          suite.pi.launcher = originalLauncher;
          await suite.evidence(`optional-${test.name}-events.json`, await pi.events());
          await suite.evidence(`optional-${test.name}.raw`, await pi.rawOutput());
          await pi.close();
        }
      }
    }
    if (failures.length) throw new Error(failures.join('\n\n'));
  },
}];
