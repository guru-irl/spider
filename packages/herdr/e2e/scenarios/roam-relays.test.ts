// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { listV0RelayLinks, submitV0Relay } from '@spider/intercom/broker/roam-relay-client';
import { requestV0Broker } from '@spider/intercom/broker/roam-v0-client';
import { decodeRelayPollReply, encodeRelayPoll, type RelayPoll, type RelayResult, type RelaySubmit } from '@spider/intercom/relay-protocol';
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
  const relay = { machineId: '00000000-0000-4000-8000-000000000001', alias: 'relay-1.invalid' };
  const { sender, target } = fixture;
  const linkId = 'carrier-link';
  const calls: Promise<unknown>[] = [];
  function open(pollId: string, holdMs: RelayPoll['holdMs'], results: readonly RelayResult[] = []) {
    const input = encodeRelayPoll({ holdMs, hello: { type: 'hello', version: 1, relay, toMachineId: sender.machineId, linkId, pollId },
      reach: { type: 'reach', peers: [relay] }, results });
    const started = performance.now();
    let returned = false;
    const reply = suite.cores!.hc(['exec', '--on', 'dest.invalid', '--timeout', '25', '--stdin', '--',
      '/usr/bin/env', `PI_CODING_AGENT_DIR=${sender.agent}`, process.execPath, suite.packed.roamCli,
      '--global-root', sender.root, 'roam', 'agent', '--v0', 'link', '--hold-ms', String(holdMs)],
      'local', { input: input.toString('utf8') }).then(async result => {
      returned = true;
      const callMs = Math.round(performance.now() - started);
      await suite.evidence(`H-relay-poll-${pollId}.json`, { holdMs, callMs, result });
      expect(result.exitCode, result.stdout || result.stderr).toBe(0);
      const reply = decodeRelayPollReply(Buffer.from(result.stdout));
      expect(reply.ready).toEqual({ type: 'ready', version: 1, ok: true, machineId: sender.machineId, linkId, pollId });
      return { callMs, submissions: reply.submissions };
    });
    calls.push(reply);
    void reply.catch(() => {});
    return { reply, returned: () => returned };
  }
  async function startedAfter(prior: number, call: ReturnType<typeof open>): Promise<number> {
    return waitFor('the private broker records the new held call', async () => {
      if (call.returned()) await call.reply;
      expect(call.returned()).toBe(false);
      const links = await listV0RelayLinks(sender.agent);
      return links.find(link => link.linkId === linkId && link.state === 'up')?.lastCallMs ?? -1;
    }, lastCallMs => lastCallMs > prior, deadline(20_000));
  }
  const stop = new AbortController();
  try {
    const emptyCall = open('empty', 20_000);
    const firstStart = await startedAfter(-1, emptyCall);
    const empty = await emptyCall.reply;
    expect(empty.submissions).toEqual([]);

    const origin = await requestV0Broker(sender.agent, { kind: 'lookup', scopeId: null, selector: { by: 'id', value: sender.id } });
    if (origin.kind !== 'matches' || origin.targets.length !== 1) throw new Error('sender is not a live v0 endpoint');
    const message = { id: 'carrier-message', timestamp: Date.now(), text: 'held relay carrier fixture' };
    const submission: RelaySubmit = { type: 'submit', kind: 'send', from: { machineId: sender.machineId, ...origin.targets[0] },
      target: { machineId: target.machineId, selector: { by: 'id', value: target.id } }, message };
    const take = open('handoff', 20_000);
    const handoffStart = await startedAfter(firstStart, take);
    const sent = submitV0Relay(sender.agent, relay.machineId, submission, stop.signal);
    calls.push(sent);
    const handoff = await take.reply;
    expect(handoff.submissions).toEqual([submission]);

    const overlap = open('overlap', 20_000);
    const overlapStart = await startedAfter(handoffStart, overlap);
    const result: RelayResult = { type: 'result', messageId: message.id, attempted: true,
      outcome: { kind: 'socket_delivered', id: message.id } };
    const [quick, outcome] = await Promise.all([open('result', 0, [result]).reply, sent]);
    expect(quick.submissions).toEqual([]);
    expect(outcome).toEqual(result);
    expect(overlap.returned()).toBe(false);
    const final = await overlap.reply;
    expect(final.submissions).toEqual([]);
    const proof = { emptyCallMs: empty.callMs, handoffCallMs: handoff.callMs, handoffId: message.id, resultCallMs: quick.callMs,
      resultBeforeHeldReply: true, finalCallMs: final.callMs, callStartMs: [firstStart, handoffStart, overlapStart] };
    await suite.evidence('H-relay-poll-proof.json', proof);
    console.log(`H-relay-poll calls: ${JSON.stringify(proof)}`);
  } finally {
    stop.abort();
    try { await fixture.close(); } finally { await Promise.allSettled(calls); }
  }
  for (const endpoint of [sender, target]) expect(existsSync(join(endpoint.agent, 'intercom', 'broker.sock'))).toBe(false);
  console.log('H-relay-poll cleanup: all four exec calls settled and both private broker sockets are gone');
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('R19'), title: 'intercom sends through an owned relay', tiers: ['headless'], run: relayDelivery },
  { id: storyId('H-relay-poll'), title: 'buffered exec carries a held intercom relay poll', tiers: ['headless'], run: relayPoll },
];
registerScenarios(scenarios);
