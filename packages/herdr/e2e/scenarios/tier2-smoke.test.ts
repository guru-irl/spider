// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { registerScenarios, storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { RemoteSuite } from '../harness/remote.js';
import { defaultCoreSocket } from '../harness/environment.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { marker } from '../fixtures/scripted-provider.js';
import { writeScript, type InteractiveDriver } from '../harness/pi.js';
import { deadline, waitFor } from '../harness/wait.js';

export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('H-tier2-smoke'), title: 'real Linux SSH route in isolated namespaces', tiers: ['remote'],
  async run(fixture) {
    const suite = fixture as RemoteSuite;
    expect(suite.cores!.local.socket).not.toBe(defaultCoreSocket());
    expect(suite.cores!.local.coreId).not.toBe(suite.cores!.dest.coreId);
    expect(suite.remote.metadata.socket).not.toBe(suite.remote.metadata.defaultCore.socket);
    const route = await suite.hc(['exec', '--on', suite.cores!.machine, '--json', '--', 'perl', '-e', 'alarm shift; exec @ARGV', '20', '/bin/sh', '-c', 'uname -s']);
    await suite.evidence('route.json', route);
    expect(route.exitCode).toBe(0);
    expect(Buffer.from((route.json as { stdout: string }).stdout, 'base64').toString()).toBe('Linux\n');
    const wrong = await suite.hc(['exec', '--on', 'unknown.invalid', '--json', '--', '/bin/sh', '-c', 'exit 0']);
    await suite.evidence('unknown-machine-control.json', wrong);
    expect(wrong.exitCode).not.toBe(0);
    const stdinPath = suite.remote.metadata.root + '/stdin-marker.txt';
    const stdinWrite = await suite.cores!.hc(['file', 'write', '--json', stdinPath], 'dest', { input: 'destination-input\n', cwd: suite.remote.metadata.root });
    expect(stdinWrite.exitCode).toBe(0);
    expect((stdinWrite.json as { bytes: number }).bytes).toBe(18);
    expect((await suite.remote.exec(`cat '${stdinPath}'`)).stdout).toBe('destination-input\n');
    const app = await suite.app();
    const remote = suite.remote.metadata;
    const runtimeBytes = await readFile(suite.packed.remoteRuntime);
    const runtimePath = `${remote.root}/spider-remote-runtime-${createHash('sha256').update(runtimeBytes).digest('hex').slice(0, 16)}.mjs`;
    const nodeWrapper = remote.nodePath;
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    const config = {
      enabled: true, app: { binary: suite.appConnection!.binary, home: suite.directories.HERDR_APP_HOME },
      core: { binary: suite.cores!.wrapper, config: join(suite.directories.XDG_CONFIG_HOME, 'herdr-core/config.toml') },
      agentDirectory: suite.directories.PI_CODING_AGENT_DIR, globalRoot: suite.directories.SPIDER_GLOBAL_ROOT,
      shellRc: join(suite.root, 'shellrc'), spaces: [], machines: [{ name: suite.cores!.machine,
        aliases: [], nodePath: nodeWrapper, runtime: { cwd: remote.root, directory: `${remote.root}/runtime`,
          commands: { shell: ['perl', '-e', 'alarm shift; exec @ARGV', '60', '/bin/sh'] } } }],
    };
    await mkdir(join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr'), { recursive: true });
    await writeFile(join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/config.json'), JSON.stringify(config));
    const globalConfig = join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json');
    await writeFile(globalConfig, JSON.stringify({ ...JSON.parse(await readFile(globalConfig, 'utf8')), 'herdr.enabled': true }));
    const payload = "printf 'remote-effect\\n' > remote-effect.txt; printf 'remote-out\\n'; printf 'remote-err\\n' >&2; exit 23";
    await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: {
      missing: [{ steps: [{ tool: { id: 'missing-runtime', name: 'spider', arguments: { action: 'exec', language: 'shell', on: suite.cores!.machine, code: payload } } }] }, { steps: [{ text: 'refusal observed' }] }],
      remote: [{ steps: [{ tool: { id: 'remote-exec', name: 'spider', arguments: { action: 'exec', language: 'shell', on: suite.cores!.machine, code: payload } } }] }, { steps: [{ text: 'remote complete' }] }],
      local: [{ steps: [{ tool: { id: 'local-exec', name: 'spider', arguments: { action: 'exec', language: 'shell', code: "printf 'local-effect\\n' > local-effect.txt; printf 'local-out\\n'" } } }] }, { steps: [{ text: 'local complete' }] }],
    } });
    const project = await suite.project('smoke');
    const pi = await suite.launchPi({ mode: 'interactive', cwd: project }) as InteractiveDriver;
    try {
      const start = await pi.waitEvent('session_start', () => true, deadline(90_000));
      expect(start).toMatchObject({ mode: 'tui', hcTerminal: pi.terminal });
      await suite.evidence('pi-terminal.json', start);
      await pi.key('ready');
      await waitFor('owned editor accepts broker input', () => pi.draft(), text => text === 'ready', deadline(20_000));
      await pi.key('\u0015');
      await waitFor('owned editor cleared', () => pi.draft(), text => text === '', deadline(20_000));
      const before = await app.ls();
      await pi.prompt(`${marker('missing')} run the selected remote command`);
      const refused = await pi.toolResult('missing-runtime', deadline(60_000));
      await suite.evidence('missing-runtime-control.json', refused);
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.result)).toMatch(/runtime-not-installed|runtime.*missing|runtime.*not installed/i);
      expect((await suite.remote.exec(`test ! -e ${quote(remote.root + '/remote-effect.txt')}`)).exitCode).toBe(0);
      // This smoke stages the shipped artifact only. Full setup and first-install acceptance remain S05.
      const upload = await suite.cores!.hc(['file', 'write', '--on', suite.cores!.machine, '--json', runtimePath], 'local', { input: runtimeBytes.toString() });
      expect(upload.exitCode).toBe(0);
      const install = await suite.remote.exec(`${quote(nodeWrapper)} ${quote(runtimePath)} --install ${quote(remote.root + '/runtime')}`);
      const probe = await suite.remote.exec(`${quote(nodeWrapper)} ${quote(runtimePath)} --probe ${quote(remote.root + '/runtime')}`);
      await suite.evidence('runtime-staging.json', { upload, install, probe });
      expect(install.exitCode).toBe(0); expect(probe.exitCode).toBe(0);
      await pi.prompt(`${marker('remote')} run the selected remote command`);
      const completed = await pi.toolResult('remote-exec', deadline(90_000));
      await suite.evidence('remote-tool-result.json', completed);
      const result = (completed.result as { details: { stdout: string; stderr: string; exitCode: number; remote: { machine: string; jobId: string; address: string }; backgroundLogs: { stdout: string; stderr: string } } }).details;
      expect(result).toMatchObject({ stdout: 'remote-out\n', stderr: 'remote-err\n', exitCode: 23, remote: { machine: suite.cores!.machine } });
      expect(result.remote.jobId).toBeTruthy(); expect(result.remote.address).toMatch(/^dest\.invalid\//);
      expect((await suite.remote.exec(`cat ${quote(remote.root + '/remote-effect.txt')}`)).stdout).toBe('remote-effect\n');
      expect(existsSync(join(project, 'remote-effect.txt'))).toBe(false);
      expect(await readFile(result.backgroundLogs.stdout, 'utf8')).toBe('remote-out\n');
      expect(await readFile(result.backgroundLogs.stderr, 'utf8')).toBe('remote-err\n');
      await suite.keepEvidence(result.backgroundLogs.stdout, 'payload.stdout'); await suite.keepEvidence(result.backgroundLogs.stderr, 'payload.stderr');
      await pi.prompt(`${marker('local')} run locally without on`);
      const local = await pi.toolResult('local-exec', deadline(60_000));
      await suite.evidence('local-tool-control.json', local);
      expect((local.result as { details: unknown }).details).toMatchObject({ stdout: 'local-out\n', stderr: '', exitCode: 0 });
      expect(await readFile(join(project, 'local-effect.txt'), 'utf8')).toBe('local-effect\n');
      expect((await suite.remote.exec(`test ! -e ${quote(remote.root + '/local-effect.txt')}`)).exitCode).toBe(0);
      expect(await app.ls()).toEqual(before);
    } finally { await pi.close(); }
  },
}];
registerScenarios(scenarios);
