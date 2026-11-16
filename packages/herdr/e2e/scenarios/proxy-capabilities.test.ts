// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { registerScenarios, type ScenarioDefinition, type StoryId } from '../harness/scenario.js';
import { HarnessError } from '../harness/environment.js';
import { prepareNativeApp, launchNativeApp, createNativeAppDriver, frontmostApp, verifyNativeAppSources } from '../harness/app.js';
import { realHcBinary, selectedHcBinary, verifyHcBinaryPin } from '../harness/hc.js';

function proveBinaryPins() {
  const previous = process.env.SPIDER_HERDR_E2E_HC;
  vi.stubEnv('SPIDER_HERDR_E2E_HC', undefined);
  try { expect(() => selectedHcBinary()).toThrow('explicit'); }
  finally { vi.stubEnv('SPIDER_HERDR_E2E_HC', previous); }
  // An unlisted version and a changed binary must refuse before launch.
  expect(() => verifyHcBinaryPin('0.1.17', 'a4aff19a5af4beea754db8e41f854ce541e5f059d14c39cb402f7b615a2f0ec7')).toThrow('unlisted');

  expect(() => verifyHcBinaryPin('0.1.18', '0'.repeat(64))).toThrow('digest');
  expect(verifyHcBinaryPin('0.1.18', 'a4aff19a5af4beea754db8e41f854ce541e5f059d14c39cb402f7b615a2f0ec7')).toBe('0.1.18');
}

export const scenarios: readonly ScenarioDefinition[] = [{
  id: 'H-proxy-binary-pins' as StoryId, title: 'Unlisted CLI and binary digest mismatch refuse', tiers: ['ci'],
  async run() { proveBinaryPins(); },
}, {
  id: 'B00' as StoryId, title: 'Isolated remote proxy capability prerequisite', tiers: ['app'],
  async run(suite) {
    proveBinaryPins();
    const sourceBundle = process.env.SPIDER_HERDR_PROXY_APP_SOURCE;
    if (!sourceBundle) throw new HarnessError('missing-prerequisite', 'An explicit read-only app source is required for the isolated proxy proof');
    if (!suite.cores) throw new HarnessError('missing-prerequisite', 'Two owned cores are required');
    const program = fileURLToPath(new URL('../fixtures/proxy-reporting-program.mjs', import.meta.url));
    const proof = await suite.invoke(process.execPath, [program, '--prove', JSON.stringify({
      binary: realHcBinary(), local: suite.cores.local, remote: suite.cores.dest,
      machine: suite.cores.machine, root: suite.root,
    })], suite.env);
    await suite.evidence('proxy-proof-process.json', proof);
    expect(proof.exitCode, proof.stderr).toBe(0);
    const transport = JSON.parse(proof.stdout);
    await suite.evidence('proxy-transport.json', transport);
    expect(transport.coreIdAddressing).toBe(true);
    expect(transport.reusedAlias).toBe(true);
    expect(transport.tty.gated).toBe(true);
    expect(transport.tty.rawDiscard).toBe(true);
    expect(transport.tty.flush).toBe(true);
    expect(transport.tty.resetBeforeAttach).toBe(true);
    expect(transport.tty.resetBeforeStatus).toBe(true);
    expect(transport.tty.resetBeforeRetarget).toBe(true);
    expect(transport.tty.resetOnExit).toBe(true);
    expect(transport.detach.classifier).toBe('stream-loss');
    expect(['0.1.16', '0.1.18']).toContain(transport.minimumHcVersion);
    expect(transport.observeDoesNotType).toBe(true);
    expect(transport.nativeCoreFacts.map((item: { state: string }) => item.state)).toEqual(['working', 'blocked', 'error', 'done']);
    const invoke = (binary: string, argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>) => suite.invoke(binary, argv, Object.fromEntries(Object.entries(env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])));
    const owned = await prepareNativeApp({ root: suite.root, sourceBundle,
      sourceCore: join(dirname(realHcBinary()), 'herdr-core'), ledger: suite.ledger, invoke,
      env: { ...suite.cores.local.env, HERDR_APP_HOME: join(suite.root, 'app-home'), HC_SOCKET: suite.cores.local.socket },
    });
    suite.appConnection = { binary: owned.binary, env: owned.env };
    const launch = await launchNativeApp(owned, { invoke, ledger: suite.ledger });
    await suite.evidence('proxy-native-launch.json', launch);
    const close = suite.close.bind(suite);
    suite.close = async options => {
      verifyNativeAppSources(owned);
      expect(await frontmostApp(invoke, owned.env)).toBe(launch.before);
      const result = await close(options);
      verifyNativeAppSources(owned);
      expect(await frontmostApp(invoke, owned.env)).toBe(launch.before);
      return result;
    };
    const app = createNativeAppDriver({ binary: owned.binary, env: owned.env, invoke, ownPath: suite.ownPath });
    const commands = await app.command('commands', {});
    const commandDigest = createHash('sha256').update(JSON.stringify(commands)).digest('hex');
    await writeFile(join(suite.root, 'proxy-commands.json'), JSON.stringify(commands, null, 2), { mode: 0o600 });
    const lock = await invoke('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], suite.env);
    const screenLocked = /CGSSessionScreenIsLocked\"=Yes/.test(lock.stdout);
    await suite.evidence('proxy-screen-state.json', { screenLocked });
    if (!screenLocked) throw new HarnessError('missing-prerequisite', 'Rendered native facts and focus-safe conversion must be measured on an unlocked display');
    const stop = await suite.invoke(process.execPath, [program, '--prove', JSON.stringify({
      binary: realHcBinary(), local: suite.cores.local, remote: suite.cores.dest,
      machine: suite.cores.machine, root: suite.root, stopProof: true,
    })], suite.env);
    await suite.evidence('proxy-core-stop-process.json', stop);
    expect(stop.exitCode, stop.stderr).toBe(0);
    const coreStops = JSON.parse(stop.stdout);
    expect(coreStops).toHaveProperty('remoteCoreStop.exitCode');
    expect(coreStops).toHaveProperty('localCoreStop.exitCode');
    const receipt = {
      version: 1, appVersion: owned.release, appSourceDigest: owned.sourceBundleHash,
      commandDigest, hcVersion: transport.minimumHcVersion,
      hcBinaryDigest: createHash('sha256').update(await readFile(realHcBinary())).digest('hex'),
      minimumProvedHcVersion: '0.1.16', transport, coreStops,
      support: { transport: 'proved', nativeRendering: 'pending, screen locked', boxCore017: 'not proved' },
      nativeFacts: { state: 'pending, screen locked', panes: 'pending, screen locked', agents: 'pending, screen locked',
        closeConfirmation: 'pending, screen locked', fallback: ['target-facts-headers', 'agent-projection', 'spider-close-confirmation'] },
      noFocusConversion: { supported: false, state: 'pending, screen locked', fallback: 'defer-until-focus' },
      deferredPlaceholder: { state: 'pending, screen locked' },
    };
    await suite.evidence('proxy-capability-receipt.json', receipt);
    expect(owned.release === '0.1.13' || owned.release === '0.1.16').toBe(true);
    expect(receipt.appSourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.commandDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.noFocusConversion.supported).toBe(false);
    expect(receipt.nativeFacts.fallback).toContain('target-facts-headers');
    const synthetic = JSON.parse(await readFile(new URL('../../src/__tests__/fixtures/pane-proxy-capabilities.json', import.meta.url), 'utf8'));
    expect(synthetic.minimumHcVersion).toBe(receipt.minimumProvedHcVersion);
    expect(synthetic.versions).toHaveProperty(owned.release);
  },
}];
registerScenarios(scenarios);
