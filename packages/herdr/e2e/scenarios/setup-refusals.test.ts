// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareInstallInputs, fingerprintInstallation, createNamedSession } from '../fixtures/install-inputs.js';
import { createSuite } from '../harness/suite.js';
import { HarnessError } from '../harness/environment.js';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import { remoteInstallOptions } from '../fixtures/remote-install-inputs.js';
import { destinationRoot, destinationPath } from '../harness/destination.js';
import { writeDestination, shellQuote } from '../fixtures/payloads/index.js';
import type { RemoteSuite } from '../harness/remote.js';

const cases = [
  ['ambiguous', /session-selector-ambiguous/], ['duplicate-file', /session-selector-duplicate/],
  ['missing-anchor', /patch-anchor|patch.*missing|anchor/i], ['repeated-anchor', /patch-anchor|patch.*ambiguous|anchor/i],
  ['keys', /key-binding-conflict/], ['symlink', /destination-symlink/],
  ['old-node', /remote-node-unavailable/], ['missing-node', /remote-node-unavailable/],
] as const;
export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S07'), title: 'Unsafe plain-shell setup refuses without changing owned targets', tiers: ['headless', 'remote', 'app'],
  async run(original) {
    if (original.options.tier === 'app') throw new HarnessError('P2-native-install-slot', 'native first installation must run in the opt-in app window batch');
    const failures: unknown[] = [];
    for (const [label, diagnostic] of cases) {
      const raw = await createSuite({ ...original.options, story: storyId(`H-setup-refusal-${label}`) });
      try {
        const { suite, config, app } = await prepareInstallInputs(raw, await remoteInstallOptions(raw));
        if (label === 'ambiguous' || label === 'duplicate-file') {
          const cwd = await suite.project('refusal');
          const one = await createNamedSession(suite, 'Duplicate', cwd, 'duplicate-one');
          const two = await createNamedSession(suite, 'Duplicate', cwd, 'duplicate-two');
          assert.notEqual(one.sessionId, two.sessionId);
          config.spaces = [{ name: 'Group', sessions: label === 'ambiguous' ? [{ name: 'Duplicate' }] : [{ file: one.file }, { file: one.file }] }];
        }
        if (label === 'missing-anchor' || label === 'repeated-anchor') {
          const main = join(config.app.home, 'mods/agents/main.js'); const source = await readFile(main);
          await writeFile(main, label === 'missing-anchor' ? 'export default function() {}\n' : Buffer.concat([source, source]));
        }
        if (label === 'keys') {
          const fragment = JSON.parse(await readFile(join(suite.packed.root, 'packages/herdr/assets/keys.json'), 'utf8'));
          await writeFile(join(config.app.home, 'keys.json'), JSON.stringify({ terminal: { [Object.keys(fragment.terminal)[0]]: 'unowned-action' }, other: { fixture: 'unchanged' } }));
        }
        let linkedTarget: string | undefined;
        if (label === 'symlink') {
          linkedTarget = suite.ownPath(join(suite.root, 'rc-target')); await writeFile(linkedTarget, 'fixture rc stays unchanged\n');
          await symlink(linkedTarget, config.shellRc);
        }
        if (label === 'old-node' || label === 'missing-node') {
          const node = destinationPath(suite, join(destinationRoot(suite), label));
          if (label === 'old-node') {
            if (suite.options.tier === 'remote') {
              await writeDestination(suite, suite.cores!.machine, node, '#!/bin/sh\nprintf "v18.0.0\\n"\n');
              assert.equal((await (suite as RemoteSuite).remote.exec(`chmod 700 ${shellQuote(node)}`)).exitCode, 0);
            } else await writeFile(node, '#!/bin/sh\nprintf "v18.0.0\\n"\n', { mode: 0o700 });
          }
          config.machines = config.machines.map(m => ({ ...m, nodePath: node }));
        }
        const path = suite.ownPath(join(suite.root, 'refusal.json')); await writeFile(path, JSON.stringify(config), { mode: 0o600 });
        // A symlink is deliberately unsafe input. Compare all other targets and its referent separately.
        const comparedConfig = label === 'symlink' ? { ...config, shellRc: join(suite.root, 'absent-rc') } : config;
        const before = await fingerprintInstallation(suite, comparedConfig); const world = await app.ls(); const status = await app.status();
        const calls = (await suite.cores!.records()).length;
        const result = await suite.invoke(process.execPath, [suite.packed.cli, 'setup', '--config', path], suite.env);
        const after = await fingerprintInstallation(suite, comparedConfig);
        await suite.evidence('refusal.json', { label, result, before, after });
        assert.notEqual(result.exitCode, 0, `${label} unexpectedly succeeded`); assert.match(result.stderr, diagnostic);
        assert.deepEqual(after, before, `${label} changed files or backups`);
        if (linkedTarget) assert.equal(await readFile(linkedTarget, 'utf8'), 'fixture rc stays unchanged\n');
        assert.deepEqual(await app.ls(), world); assert.deepEqual(await app.status(), status);
        const launches = (await suite.cores!.records()).slice(calls).filter(c => c.argv[0] === 'run');
        assert.ok(launches.every(c => c.argv.includes('spider.kind=setup-probe')), `${label} launched a selected-session payload`);
        assert.equal(launches.filter(c => !c.argv.includes('--no-notify')).length, 0);
        await original.evidence(`refusal-${label}.json`, { status: 'passed', evidence: suite.evidenceDirectory });
      } catch (error) {
        if (error instanceof HarnessError) throw error;
        failures.push(error); await raw.evidence('failure.json', { error: String(error), stack: (error as Error).stack });
        await original.evidence(`refusal-${label}.json`, { status: 'failed', error: String(error), evidence: raw.evidenceDirectory });
      } finally { await raw.close(); }
    }
    if (failures.length) throw new AggregateError(failures, 'unsafe setup subcases failed');
  },
}];
