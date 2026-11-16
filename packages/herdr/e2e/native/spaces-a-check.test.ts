// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stageSpacesAFiles } from '../fixtures/spaces-a-inputs.js';
import { prepareNativeApp, createNativeAppDriver, verifyNativeAppSources, type AppInvoke } from '../harness/app.js';
import { createFixtureRoot, createFencedDirectories, buildEnvironment } from '../harness/environment.js';
import { openLedger, cleanupLedger, startWatchdog } from '../harness/resources.js';
import { startCores, realHcBinary } from '../harness/hc.js';
import { spawnOwned } from '../harness/processes.js';
import { loadSpacesAFiles, replaySpacesARecipe } from '../../src/__tests__/spaces-a-fixture.js';

for (const [version, sourceBundle] of [['0.1.13', '/Applications/Herdr.app'], ['0.1.16', '/Applications/Herdr.app.new.noindex']] as const) {
  it.runIf(process.env.SPIDER_SPACES_A_NATIVE_CHECK === '1')(`${version}: checks composed native mods without subprocess work`, async () => {
    const root = await createFixtureRoot(), ledger = openLedger(join(dirname(root), '_ledgers'), root);
    const watchdog = startWatchdog(ledger, Date.now() + 120000, join(root, 'watchdog.log'));
    const dirs = await createFencedDirectories(root), bin = join(root, 'bin'), env = buildEnvironment(process.env, dirs, { binDirectory: bin });
    let sequence = 0;
    const invoke: AppInvoke = async (binary, args, input) => {
      const environment = Object.fromEntries(Object.entries(input).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]));
      const command = spawnOwned(ledger, { label: 'native-check-command', command: binary, args, env: environment, cwd: root, stdio: 'pipe' });
      const out: Buffer[] = [], err: Buffer[] = [];
      command.child.stdout!.on('data', data => out.push(data)); command.child.stderr!.on('data', data => err.push(data)); command.child.stdin!.end();
      const exit = await command.exited;
      const result = { exitCode: exit.code ?? 128, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
      writeFileSync(join(root, `check-command-${sequence++}.json`), JSON.stringify({ binary, args, ...result }));
      return result;
    };
    try {
      const cores = await startCores(ledger, root, env, bin);
      const owned = await prepareNativeApp({ root, sourceBundle, sourceCore: join(dirname(realHcBinary()), 'herdr-core'), env: { ...cores.local.env, HC_SOCKET: cores.local.socket }, ledger, invoke });
      const app = createNativeAppDriver({ binary: owned.binary, env: owned.env, invoke, ownPath: path => path });
      await app.command('commands', {});
      const staged = await stageSpacesAFiles(owned.appHome, version);
      const log = join(root, 'check-subprocess.log');
      writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf 'git\\n' >> '${log}'\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
      const agentsPath = join(owned.appHome, 'mods/spider-agents/main.js');
      const composedAgents = readFileSync(agentsPath);
      const baselineBefore = (await cores.records()).length;
      writeFileSync(agentsPath, replaySpacesARecipe(version, loadSpacesAFiles(version)).agents!['main.js']!);
      const baselineResult = await app.check(join(owned.appHome, 'mods/spider-agents'));
      const baselineCalls = (await cores.records()).slice(baselineBefore);
      writeFileSync(agentsPath, composedAgents);
      const checks: any[] = [];
      const before = (await cores.records()).length;
      for (const mod of ['spider-agents', 'spider-spaces', 'spider-pane', 'spider-picker', 'spider-panel', 'spider-menu', ...(version === '0.1.16' ? ['spider-toast'] : [])]) {
        const result = await app.check(join(owned.appHome, 'mods', mod));
        checks.push({ mod, ...result });
      }
      const calls = (await cores.records()).slice(before), processes = existsSync(log) ? readFileSync(log, 'utf8') : '';
      writeFileSync(join(root, 'native-check-results.json'), JSON.stringify({ version, baselineResult, baselineCalls, checks, calls, processes, manifest: staged.manifest }));
      expect(checks.filter(check => check.exitCode !== 0), JSON.stringify(checks.map(check => ({ mod: check.mod, exitCode: check.exitCode, stderr: check.stderr })))).toEqual([]);
      expect(calls).toEqual([]); expect(processes).toBe('');
      expect(() => verifyNativeAppSources(owned)).not.toThrow();
    } finally {
      const proof = await cleanupLedger(ledger.path, 'spaces-native-check'); watchdog.release();
      expect(proof.clean).toBe(true);
      console.info(`Native ${version} check evidence ${root}`);
    }
  });
}
