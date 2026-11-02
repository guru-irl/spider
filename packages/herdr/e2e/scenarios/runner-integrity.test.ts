import { randomUUID } from 'node:crypto';
import type { Suite } from '../harness/suite.js';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import { expect } from 'vitest';
import { createSuite } from '../harness/suite.js';
import { validateAppCommand, parseAppReply } from '../harness/app.js';
import { parseRenderedUi } from '../native/capabilities.js';
import { runArtifactControls, runComposedControls } from '../controls/behavioral.js';
// @ts-ignore Runtime-tested JavaScript runner boundary.
import { discoverScenarios } from '../../../../scripts/herdr-e2e.mjs';
import { proveKilledRunner } from '../controls/killed-run.js';

async function proveFakeServerRejectsUnknown(suite: Suite): Promise<void> {
  const app = await suite.app();
  const baseline = await app.ls();
  const socket = suite.ownPath(suite.appConnection!.env.SPIDER_HERDR_E2E_APP_SOCKET!);
  const requestId = randomUUID();
  // Real stdlib socket client, bypassing the AppDriver's validator deliberately.
  const code = `import {connect} from 'node:net';
const socket=connect(${JSON.stringify(socket)});
socket.setTimeout(5000,()=>{console.error('owned fake reply deadline');process.exit(2)});
socket.on('error',error=>{console.error(error.message);process.exitCode=1});
socket.on('connect',()=>socket.write(${JSON.stringify(JSON.stringify({ requestId, name: 'pretend.success', args: {} }) + '\n')}));
socket.on('data',bytes=>process.stdout.write(bytes));`;
  const result = await suite.invoke(process.execPath, ['--input-type=module', '-e', code]);
  expect(result.exitCode, result.stderr).toBe(0);
  const reply = JSON.parse(result.stdout) as { requestId: string; result: Record<string, unknown> };
  expect(reply.requestId).toBe(requestId);
  expect(reply.result.error).toMatch(/unknown command/);
  expect(Object.keys(reply.result)).toEqual(['error']);
  await suite.evidence('actual-fake-unknown-command.json', { baseline, requestId, reply, exitCode: result.exitCode, scope: 'actual supervised fake daemon rejects a raw unknown request; no native app' });
}

export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S55'), title: 'Killed runners collect owned daemons and next-run reconciliation recovers lost watchdogs', tiers: ['headless', 'ci'],
  async run(suite) { await proveKilledRunner(suite); },
}, {
  id: storyId('S56'), title: 'Fresh packed controls catch broken artifacts and strict adapters refuse malformed input', tiers: ['headless', 'ci'],
  async run(suite) {
    const roots: string[] = [];
    for (const round of ['first', 'fresh-again']) {
      const fresh = await createSuite({ tier: 'ci', story: suite.story });
      try {
        roots.push(fresh.root);
        const results = await runArtifactControls(fresh);
        await suite.evidence(`artifact-${round}.json`, { root: fresh.root, evidenceDirectory: fresh.evidenceDirectory, cleanupProofPath: fresh.cleanupProofPath, results });
      } finally { await fresh.close(); }
    }
    expect(new Set(roots).size, 'artifact controls must use two independent fresh roots').toBe(2);
    expect(() => validateAppCommand('pretend.success', {})).toThrow(/unknown command/);
    expect(() => parseAppReply('ls', {}, {})).toThrow(/invalid app reply/);
    expect(() => parseAppReply('terminal.park', { terminal: 'owned' }, { pending: true, terminal: 'foreign' })).toThrow(/wrong terminal/);
    expect(() => parseRenderedUi({ frame: 1, nodes: [{ id: 'bad', text: 'bad', enabled: true, bounds: [0, 0, 0, 0] }] })).toThrow(/bounds/);
    await suite.evidence('strict-adapter-controls.json', { result: 'caught', controls: ['unknown-app-command-adapter', 'malformed-native-world', 'wrong-native-id', 'invalid-rendered-bounds'], scope: 'adapter boundary; no native event or window' });
    if (suite.options.tier === 'headless') {
      await proveFakeServerRejectsUnknown(suite);
      // @ts-ignore Vite loader discovers the same definitions as the central runner.
      const modules = import.meta.glob('./*.test.ts') as Record<string, () => Promise<Record<string, unknown>>>;
      await runComposedControls(suite, await discoverScenarios(modules));
    } else await suite.evidence('active-controls-not-exercised.json', { controls: ['wrong-transcript-path', 'duplicated-notice', 'main-pane-mutation'], reason: 'CI artifact subset has no hc or app; headless composed stories are required separately' });
  },
}];
