// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { strict as assert } from 'node:assert';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScenarioDefinition } from '../harness/scenario.js';
import { storyId } from '../harness/scenario.js';
import { deadline, waitFor } from '../harness/wait.js';
import { writeScript, readObserved } from '../harness/pi.js';
import { activeChildOwnership, inventoryFiles, stageChildOutput, childOutput } from '../fixtures/child-scripts.js';

// Break caught: a headless child mounting the parent publisher, IPC, viewers or policy writer.
export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S27'), title: 'Children do not overwrite parent resources', tiers: ['ci', 'headless'],
  async run(suite) {
    await stageChildOutput(suite);
    if (suite.options.tier !== 'ci') await activeChildOwnership(suite);
    const herdrRoot = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr');
    const cwd = await suite.project('inactive');
    const config = join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json');
    const settings = JSON.parse(await readFile(config, 'utf8'));
    await writeFile(config, JSON.stringify({ ...settings, 'herdr.enabled': false }));
    await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: {
      parent: [{ steps: [{ tool: { id: 'spawn-inactive', name: 'spider', arguments: {
        action: 'run', agent: 'worker', name: 'inactive-child', task: '[[e2e:child]] Keep this child alive at its gate.',
        model: 'e2e-fixture/scripted', thinking: 'off', context: 'fresh',
      } } }] }, { steps: [{ text: 'parent settled' }] }, { steps: [{ text: 'completion observed' }] }],
      child: [{ steps: [{ gate: 'child-live' }, { text: 'inactive child done' }] }],
    } });
    const gates = await suite.gates();
    const parent = await suite.launchPi({ mode: 'rpc', cwd, args: ['--approve'] });
    assert.equal(parent.mode, 'rpc');
    if (parent.mode !== 'rpc') throw new Error('RPC parent required');
    await parent.waitEvent('session_start', () => true, deadline(30_000));
    const before = (await inventoryFiles(herdrRoot)).filter(n => !n.startsWith('processes/'));
    await parent.prompt('[[e2e:parent]] Start the real child.');
    const spawned = await parent.toolResult('spawn-inactive', deadline(30_000));
    assert.equal(spawned.isError, false, JSON.stringify(spawned));
    const ready = await gates.ready('child-live', deadline(60_000));
    const root = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr');
    const files = await waitFor('real inactive child presence', async () => {
      const names = await readdir(join(root, 'processes')).catch(() => []);
      return Promise.all(names.filter(n => n.endsWith('.json')).map(async n => JSON.parse(await readFile(join(root, 'processes', n), 'utf8'))));
    }, rows => rows.some(row => row.pid === ready.pid), deadline(30_000));
    const presence = files.filter(row => row.pid === ready.pid);
    assert.equal(presence.length, 1);
    assert.equal(presence[0].kind, 'child');
    assert.ok(presence[0].startIdentity);
    assert.equal(presence[0].hcAddress, null);
    const children = await readObserved(suite.pi.observerDir, ready.pid);
    assert.ok(children.some(e => e.type === 'session_start' && e.subagentChild === '1' && e.mode === 'rpc'));
    const top = await readdir(root);
    assert.deepEqual((await inventoryFiles(root)).filter(n => !n.startsWith('processes/')), before);
    // Negative identity control: this actual top-level process must not satisfy the child predicate.
    assert.equal(files.find(row => row.pid === parent.pid)?.kind === 'child', false);
    // Positive ownership control: the parent presence is independently observable too.
    assert.equal(files.filter(row => row.pid === parent.pid).length, 1);
    await suite.evidence('inactive-presence.json', { files, children, spawned, top });
    gates.release('child-live');
    await parent.waitEvent('message_end', e => e.customType === 'spider.subagent_done', deadline(60_000));
    await waitFor('child presence removed after completion', async () => readdir(join(root, 'processes')), names => names.length === 1, deadline(30_000));
    const output = await childOutput(suite, ready.pid);
    assert.ok(output.stdout.includes('inactive child done'), 'The recorder must see genuine child protocol output');
    assert.ok(!output.stdout.includes('\u001b]7501;')); assert.ok(!output.stderr.includes('\u001b]7501;'));
    await suite.evidence('inactive-child-output.json', output);
    // Disabled-feature control: keep the real observer but remove the provider from real child configuration.
    await writeFile(config, JSON.stringify({ ...settings, 'herdr.enabled': false, 'subagents.extensions': [suite.pi.observerPath] }));
    await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: {
      missing: [{ steps: [{ tool: { id: 'spawn-no-provider', name: 'spider', arguments: {
        action: 'run', agent: 'worker', name: 'no-provider-child', task: '[[e2e:child]] This cannot execute without the fixture provider.', model: 'e2e-fixture/scripted', thinking: 'off',
      } } }] }, { steps: [{ text: 'control spawned' }] }, { steps: [{ text: 'control completion observed' }] }],
      child: [{ steps: [{ text: 'FORBIDDEN_PROVIDERLESS_SUCCESS' }] }],
    } });
    const beforeControl = Date.now();
    await parent.prompt('[[e2e:missing]] Start the provider-less control.');
    await parent.waitEvent('message_end', e => e.at >= beforeControl && e.customType === 'spider.subagent_done', deadline(60_000));
    const observed = await readObserved(suite.pi.observerDir);
    const missingStart = observed.find(e => e.type === 'session_start' && e.subagentChild === '1' && e.at >= beforeControl); assert.ok(missingStart);
    const failed = observed.filter(e => e.pid === missingStart.pid && e.type === 'message_end' && e.role === 'assistant');
    assert.ok(failed.some(e => e.stopReason === 'error' && String(e.errorMessage).includes('No API provider registered')));
    assert.ok(!failed.some(e => JSON.stringify(e.content).includes('FORBIDDEN_PROVIDERLESS_SUCCESS')));
    await suite.evidence('providerless-control.json', { missingStart, failed, spawned: await parent.toolResult('spawn-no-provider', deadline(30_000)) });
    await writeFile(config, JSON.stringify({ ...settings, 'herdr.enabled': false }));
    await parent.close();
  },
}];
