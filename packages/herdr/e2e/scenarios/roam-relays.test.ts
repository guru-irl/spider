// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { expect } from 'vitest';
import { mark, parentTurns } from '../fixtures/child-scripts.js';
import { relayFixture } from '../fixtures/roam-relays.js';
import type { ScriptTurn } from '../fixtures/scripted-provider.js';
import type { RpcDriver } from '../harness/pi.js';
import { writeScript } from '../harness/pi.js';
import { registerScenarios, storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import { deadline, waitFor } from '../harness/wait.js';

interface ToolResult { content: { text: string }[]; details: Record<string, unknown> }
interface PhysicalEntry { type?: string; customType?: string; details?: { message?: { id?: string; content?: { text?: string } } } }
const firstText = 'first relay delivery';
const stoppedText = 'relay stopped, this must not arrive';
const restartedText = 'fresh relay delivery after restart';

function sendTurn(id: string, to: string, message: string): ScriptTurn[] {
  return parentTurns({ steps: [{ tool: { id, name: 'intercom', arguments: { action: 'send', to, message } } }] });
}

async function send(pi: RpcDriver, marker: string): Promise<{ event: object; result: ToolResult }> {
  const settled = await pi.prompt(mark(marker));
  expect(settled.type).toBe('agent_settled');
  const event = await pi.toolResult(marker, deadline(30_000));
  expect(event.type).toBe('tool_execution_end');
  expect(event.toolCallId).toBe(marker);
  const result = event.result as ToolResult;
  if (!result || typeof result.details !== 'object' || result.details === null || !Array.isArray(result.content) || typeof result.content[0]?.text !== 'string') {
    throw new Error(`intercom tool returned no result: ${JSON.stringify(event)}`);
  }
  return { event, result };
}

async function relayDelivery(suite: Suite): Promise<void> {
  const fixture = await relayFixture(suite);
  const entries = async (): Promise<PhysicalEntry[]> => (await readFile(fixture.target.file, 'utf8')).split('\n').slice(0, -1)
    .filter(Boolean).map(line => JSON.parse(line) as PhysicalEntry)
    .filter(entry => entry.type === 'custom_message' && entry.customType === 'intercom_message');
  const receivedWithId = async (id: string): Promise<PhysicalEntry[]> => (await entries()).filter(entry => entry.details?.message?.id === id);
  const receivedWithText = async (text: string): Promise<PhysicalEntry[]> => (await entries()).filter(entry => entry.details?.message?.content?.text === text);
  try {
    await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: {
      'relay-first': sendTurn('relay-first', fixture.target.id, firstText),
      'relay-stopped': sendTurn('relay-stopped', fixture.target.id, stoppedText),
      'relay-restarted': sendTurn('relay-restarted', fixture.target.id, restartedText),
    } });
    await fixture.startRelay(0);
    expect(fixture.relayStart).toBeDefined();
    await suite.evidence('R19-before-send.json', { ...fixture.controls, relayStart: fixture.relayStart,
      senderSession: fixture.sender.id, targetSession: fixture.target.id });

    const first = await send(fixture.sender.pi, 'relay-first');
    const sent = first.result;
    await suite.evidence('R19-first-send.json', { controls: fixture.controls, relayStart: fixture.relayStart, event: first.event, sent });
    expect(sent.details).toMatchObject({ delivered: true, path: 'relay relay-1.invalid' });
    expect(sent.content[0].text).toContain('relay-1.invalid');
    expect(typeof sent.details.messageId).toBe('string');
    const firstId = String(sent.details.messageId);
    const firstEntries = await waitFor('first relayed message is physically recorded', () => receivedWithId(firstId),
      found => found.length > 0, deadline(30_000));
    expect(firstEntries).toHaveLength(1);

    await fixture.stopRelay(0);
    await fixture.waitForDown();
    const stoppedCall = await send(fixture.sender.pi, 'relay-stopped');
    const stopped = stoppedCall.result;
    await suite.evidence('R19-stopped-send.json', { event: stoppedCall.event, stopped, received: await receivedWithText(stoppedText) });
    expect(stopped.content[0].text.split('\n')[0]).toBe('No relay is reachable. Nothing was queued.');
    expect(await receivedWithText(stoppedText)).toHaveLength(0);

    await fixture.startRelay(0);
    expect(fixture.relayStart?.kind).toBe('up');
    const restartedCall = await send(fixture.sender.pi, 'relay-restarted');
    const restarted = restartedCall.result;
    await suite.evidence('R19-restarted-send.json', { event: restartedCall.event, restarted });
    expect(restarted.details).toMatchObject({ delivered: true, path: 'relay relay-1.invalid' });
    expect(restarted.content[0].text).toContain('relay-1.invalid');
    expect(typeof restarted.details.messageId).toBe('string');
    const restartedId = String(restarted.details.messageId);
    expect(restartedId).not.toBe(firstId);
    const restartedEntries = await waitFor('restarted relay message is physically recorded', () => receivedWithId(restartedId),
      found => found.length > 0, deadline(30_000));
    expect(restartedEntries).toHaveLength(1);
    expect(await receivedWithId(firstId)).toHaveLength(1);
    expect(await receivedWithText(stoppedText)).toHaveLength(0);
    await suite.evidence('R19-physical-receipts.json', { firstEntries, restartedEntries, stopped: await receivedWithText(stoppedText) });
  } finally {
    try { await suite.keepEvidence(fixture.target.file, 'R19-target.jsonl'); }
    finally { await fixture.close(); }
  }
}

async function relayPoll(suite: Suite): Promise<void> {
  const fixture = await relayFixture(suite);
  try {
    const relay = { machineId: '00000000-0000-4000-8000-000000000001', alias: 'relay-1.invalid' };
    const hello = { type: 'hello', version: 1, relay, toMachineId: fixture.sender.machineId, linkId: 'carrier-link', pollId: 'empty' };
    const reach = { type: 'reach', peers: [relay] };
    const started = performance.now();
    const first = await suite.cores!.hc(['exec', '--on', 'dest.invalid', '--timeout', '25', '--stdin', '--',
      '/usr/bin/env', `PI_CODING_AGENT_DIR=${fixture.sender.agent}`, process.execPath, suite.packed.roamCli,
      '--global-root', fixture.sender.root, 'roam', 'agent', '--v0', 'link', '--hold-ms', '20000'],
      'local', { input: `${JSON.stringify(hello)}\n${JSON.stringify(reach)}\n` });
    await suite.evidence('H-relay-poll-empty.json', { callMs: Math.round(performance.now() - started), first });
    expect(first.json, first.stdout || first.stderr).toEqual({ type: 'ready', version: 1, ok: true,
      machineId: fixture.sender.machineId, linkId: hello.linkId, pollId: 'empty' });
    expect(first.exitCode, first.stderr).toBe(0);
  } finally { await fixture.close(); }
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('R19'), title: 'intercom sends through an owned relay', tiers: ['headless'], run: relayDelivery },
  { id: storyId('H-relay-poll'), title: 'buffered exec carries a held intercom relay poll', tiers: ['headless'], run: relayPoll },
];
registerScenarios(scenarios);
