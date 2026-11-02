// SPDX-License-Identifier: MIT
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScenarioDefinition } from '../harness/scenario.js';
import { storyId } from '../harness/scenario.js';
import { deadline, waitFor } from '../harness/wait.js';
import { identityAlive, identityOf } from '../harness/resources.js';
import { setupFresh, scripts, parent, parentTurns, runChild, text, held, mark, prompt, runRow, viewerAddress, attachViewer, viewerContains, ipc, feed, terminals, childEvent, childTranscript, instructionCount, messageText, saveOwner } from '../fixtures/child-scripts.js';

export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('H-durable'), title: 'A new pi parent re-adopts a real child after its pane closes', tiers: ['headless'],
  // Break caught: stdio EOF or parent shutdown ending the child, losing its result, or duplicating its viewer.
  async run(suite) {
    suite = await setupFresh(suite); const cwd = await suite.project('owner');
    const gates = await scripts(suite, {
      owner: parentTurns(runChild('spawn-durable', 'durable-child', 'before')),
      before: [held('parent-can-close', 'CHILD_SURVIVED_PARENT')],
      steered: [text('DURABLE_STEER_APPLIED')],
    });
    const owner = await parent(suite, cwd, gates); await prompt(owner, mark('owner'));
    const ready = await gates.ready('parent-can-close', deadline(60_000));
    const childIdentity = identityOf(ready.pid); assert.ok(childIdentity);
    const run = await runRow(owner, 'durable-child', row => row.canSteer);
    const address = await viewerAddress(suite, owner, run), input = await attachViewer(suite, address);
    const start = (await owner.pi.events()).find(event => event.type === 'session_start');
    assert.equal(typeof start?.sessionFile, 'string');
    const app = await suite.app();
    const world = await app.ls() as { spaces: { tabs: { terminals: { terminal: string; pane: string }[] }[] }[] };
    const placed = world.spaces.flatMap(space => space.tabs.flatMap(tab => tab.terminals)).find(pane => pane.terminal === owner.pi.terminal); assert.ok(placed);
    const state = JSON.parse(await readFile(join(cwd, '.spider/scratch/sa', run.id.slice(0, 12), 'state.json'), 'utf8'));
    assert.equal(typeof state.herdrTerminal, 'string'); assert.notEqual(state.herdrTerminal, owner.pi.terminal);
    assert.equal((await suite.hc(['get', state.herdrTerminal, '--json'])).exitCode, 0);
    await suite.evidence('process-sessions-before-close.json', await suite.invoke('/bin/ps', ['-o', 'pid,ppid,pgid,sess,tty,command', '-p', [owner.pi.pid, state.supervisorPid, ready.pid].join(',')]));
    if (process.platform === 'darwin') {
      const childStart = await childEvent(suite, ready.pid, 'session_start', () => true);
      assert.equal(typeof start?.hcScopeHash, 'string'); assert.equal(typeof childStart.hcScopeHash, 'string');
      assert.notEqual(childStart.hcScopeHash, start?.hcScopeHash, 'The child must not inherit the closing pane cleanup scope');
      await suite.evidence('process-scopes-before-close.json', { parentScopeHash: start?.hcScopeHash, childScopeHash: childStart.hcScopeHash });
      await suite.evidence('process-kernel-sessions-before-close.json', await suite.invoke('/usr/bin/python3', ['-c', `import os,json;print(json.dumps({pid:os.getsid(pid) for pid in ${JSON.stringify([owner.pi.pid, state.supervisorPid, ready.pid])}}))`]));
      await suite.evidence('process-fds-before-close.json', await suite.invoke('/usr/sbin/lsof', ['-a', '-p', [state.supervisorPid, ready.pid].join(','), '-d', '0,1,2', '-Fn']));
    }
    await app.command('pane.close', { pane: placed.pane });
    await waitFor('original pi exited after pane close', () => identityAlive(owner.pi.identity), alive => !alive, deadline(30_000));
    assert.equal(identityAlive(childIdentity), true, 'The real child must remain alive after its original parent exits');
    await suite.evidence('parent-gone-child-alive.json', { parent: owner.pi.identity, child: childIdentity, childAlive: identityAlive(childIdentity), sessionId: owner.sessionId });
    const resumedPi = await suite.launchPi({ mode: 'interactive', cwd, args: ['--approve', '--session', String(start!.sessionFile)] });
    if (resumedPi.mode !== 'interactive') throw new Error('An interactive replacement parent is required');
    const resumedStart = await resumedPi.waitEvent('session_start', event => event.sessionId === owner.sessionId, deadline(30_000));
    assert.notEqual(resumedStart.pid, owner.pi.pid);
    await (await suite.app()).command('terminal.keep', { terminal: resumedPi.terminal, place: 'right' });
    const resumed = { ...owner, pi: resumedPi };
    await runRow(resumed, 'durable-child', row => row.canSteer);
    const viewers = await waitFor('same viewer re-adopted without duplication', () => terminals(suite), rows => rows.some(t => t.address === address && t.labels['spider.owner-terminal'] === resumedPi.terminal), deadline(30_000));
    assert.equal(viewers.filter(t => t.state === 'live' && t.labels['spider.kind'] === 'subagent-viewer' && t.labels['spider.run'] === run.id).length, 1);
    const instruction = `${mark('steered')} Continue under the resumed parent.`;
    const reply = await ipc(suite, resumed, { op: 'steerRun', runId: run.id, text: instruction });
    assert.equal(reply.ok, true);
    gates.release('parent-can-close');
    await childEvent(suite, ready.pid, 'message_end', event => event.role === 'user' && messageText(event.content) === instruction);
    await resumedPi.waitEvent('message_end', event => event.customType === 'spider.subagent_done', deadline(60_000));
    const finished = await runRow(resumed, 'durable-child', row => row.status === 'done');
    assert.ok(finished.result?.includes('DURABLE_STEER_APPLIED'));
    assert.equal(instructionCount((await childTranscript(suite, ready.pid)).entries, instruction), 1);
    await viewerContains(suite, input, 'DURABLE_STEER_APPLIED');
    assert.equal((await resumedPi.events()).filter(event => event.type === 'message_end' && event.customType === 'spider.subagent_done').length, 1);
    await waitFor('supervisor holder automatically removed after completion', () => suite.hc(['get', state.herdrTerminal, '--json']), value => value.exitCode === 3, deadline(30_000));
    await suite.evidence('resumed-completion.json', { run: finished, events: await resumedPi.events() });
    await saveOwner(suite, resumed); await input.close(); await owner.pi.close(); await resumedPi.close();
  },
}];
