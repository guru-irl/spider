// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import { runSetup, readInstalled } from '../harness/setup.js';
import { prepareInstallInputs, brokenPackedCopy, firstRemoteScripts } from '../fixtures/install-inputs.js';
import { readObserved } from '../harness/pi.js';
import { waitFor, deadline } from '../harness/wait.js';
import type { RemoteResult } from '../../src/contracts.js';
import type { ObservedEvent } from '../harness/pi.js';
import type { Suite } from '../harness/suite.js';
import { remoteInstallOptions } from '../fixtures/remote-install-inputs.js';
import { readDestination } from '../fixtures/payloads/index.js';

function assertRemoteResult(event: ObservedEvent, stdout: string, stderr: string, exitCode: number) {
  assert.ok(event.result && typeof event.result === 'object' && 'details' in event.result, 'real tool event omitted execution details');
  const details = (event.result as { details: RemoteResult }).details;
  assert.ok(details && typeof details === 'object', 'real execution details are not an object');
  assert.equal(details.stdout, stdout); assert.equal(details.stderr, stderr);
  assert.equal(details.exitCode, exitCode); assert.equal(details.outcome, 'exited');
  assert.ok(details.remote, 'execution returned no real remote job');
  assert.equal(details.remote.machine, 'dest.invalid'); assert.ok(details.remote.jobId); assert.ok(details.remote.address);
  assert.equal(event.isError, true);
}
async function absent(path: string) {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  assert.equal(info, null, `fresh installation unexpectedly contains ${path}`);
}
async function assertNoInstalled(suite: Suite) {
  for (const name of ['agents', 'spaces', 'pane', 'tabs', 'panel', 'machines']) await absent(join(suite.directories.HERDR_APP_HOME, 'mods', `spider-${name}`));
  await absent(join(suite.directories.HERDR_APP_HOME, 'layouts/spider-glass.json'));
  if (suite.options.tier !== 'remote') await absent(join(suite.root, 'r'));
}
export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S05'), title: 'Fresh plain-shell installation supports first parent and child remote work', tiers: ['headless', 'remote', 'app'], script: firstRemoteScripts,
  async run(original) {
    const { suite, config, app } = await prepareInstallInputs(original, await remoteInstallOptions(original));
    await assertNoInstalled(suite); await suite.evidence('fresh-paths.json', { installedModsAbsent: true, runtimeAbsent: true });
    for (const kind of ['runtime', 'helper'] as const) {
      const bad = await brokenPackedCopy(suite, kind);
      const result = await runSetup({ ...suite, packed: bad }, config);
      await suite.evidence(`control-missing-${kind}.json`, result);
      assert.notEqual(result.exitCode, 0, `missing ${kind} must fail real setup`);
      assert.match(result.stderr, /ENOENT|missing|not found/);
      await assertNoInstalled(suite);
    }
    const result = await runSetup(suite, config); await suite.evidence('setup.json', result);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const installed = await readInstalled(suite);
    assert.deepEqual(Object.keys(installed.mods).sort(), ['spider-agents', 'spider-pane', 'spider-panel', 'spider-spaces', 'spider-tabs']);
    await absent(join(config.app.home, 'mods/spider-machines'));
    for (const [name, path] of Object.entries(installed.mods)) {
      const check = await app.check(suite.ownPath(path)); await suite.evidence(`check-${name}.json`, check);
      assert.equal(check.exitCode, 0, `${name}: ${check.stderr}`);
    }
    const status = await app.status() as { layout: string };
    await suite.evidence('selected-app-status.json', status); assert.equal(status.layout, 'spider-glass');
    assert.equal(JSON.parse(await readFile(join(config.app.home, 'settings.json'), 'utf8')).theme, 'spider-glass');
    const keys = JSON.parse(await readFile(join(config.app.home, 'keys.json'), 'utf8'));
    for (const letter of ['a', 'o', 'u', 'm', 'k']) assert.equal(keys.terminal[`cmd-shift-${letter}`], `send:\u001b[${letter.charCodeAt(0)};6u`, `wrong merged shortcut for ${letter}`);
    assert.equal(JSON.parse(await readFile(join(config.agentDirectory, 'settings.json'), 'utf8')).theme, 'dracula-plus-glass');
    const rc = await readFile(config.shellRc, 'utf8'); assert.equal(rc.split('# spider:resume:start').length - 1, 1);
    assert.equal(installed.templates.length, 3);
    for (const path of installed.templates) {
      const source = await readFile(path, 'utf8'); assert.match(source, /^---\n/);
      const body = source.slice(source.indexOf('\n---', 4) + 4); assert.equal(body.trim(), '');
    }
    const fontDirectory = join(config.app.home, 'fonts');
    const fonts = (await readdir(fontDirectory)).filter(name => /\.(ttf|otf|ttc)$/i.test(name));
    assert.ok(fonts.length >= 2, 'installed font files are missing');
    for (const font of fonts) {
      const bytes = await readFile(join(fontDirectory, font)); assert.ok(bytes.length >= 4, 'font file is empty');
      assert.ok(bytes.readUInt32BE(0) === 0x00010000 || ['OTTO', 'ttcf'].includes(bytes.subarray(0, 4).toString('ascii')), `${font} has no usable sfnt header`);
    }
    assert.equal(installed.runtimes.length, 1);
    const runtime = await suite.hc(['file', 'read', '--on', 'dest.invalid', installed.runtimes[0].path, '--json']);
    await suite.evidence('runtime-read.json', runtime); assert.equal(runtime.exitCode, 0, runtime.stderr);
    // Independent on-disk digest plus destination bootstrap observable, not a manually supplied runtime.
    const runtimeBytes = suite.options.tier === 'remote'
      ? Buffer.from((await readDestination(suite, suite.cores!.machine, installed.runtimes[0].path))!)
      : await readFile(installed.runtimes[0].path);
    const digest = createHash('sha256').update(runtimeBytes).digest('hex');
    assert.equal(digest, suite.packed.digests['dist/herdr/remote-runtime.mjs']);
    assert.ok(installed.runtimes[0].path.endsWith(`spider-remote-runtime-${digest.slice(0, 16)}.mjs`));
    const project = await suite.project('first');
    const parent = await suite.launchPi({ mode: 'interactive', cwd: project });
    await parent.waitEvent('session_start', event => event.mode === 'tui', deadline(30_000));
    if (parent.mode !== 'interactive') throw new Error('parent must be interactive');
    await parent.prompt('[[e2e:first-parent]] Work inline, no extra subagents.');
    const parentResult = await parent.toolResult('first-parent-exec', deadline(60_000));
    await suite.evidence('first-parent-result.json', parentResult);
    assertRemoteResult(parentResult, 'first-parent-out\n', 'first-parent-err\n', 23);
    const childEvents = await waitFor('first real child remote result', () => readObserved(suite.pi.observerDir), events => events.some(e => e.toolCallId === 'first-child-exec' && e.type === 'tool_execution_end'), deadline(90_000));
    const childResult = childEvents.find(e => e.toolCallId === 'first-child-exec' && e.type === 'tool_execution_end')!;
    await suite.evidence('first-child-result.json', childResult);
    assert.notEqual(childResult.pid, parent.pid); assertRemoteResult(childResult, 'first-child-out\n', 'first-child-err\n', 29);
    await parent.close();
  },
}];
