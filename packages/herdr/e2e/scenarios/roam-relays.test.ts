// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { listV0RelayLinks, submitV0Relay, type RelayLinkView } from '@spider/intercom/broker/roam-relay-client';
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
interface PhysicalEntry { type?: string; customType?: string; details?: { message?: { id?: string; v0RelayAsk?: true; content?: { text?: string } } } }
const firstText = 'first relay delivery';
const stoppedText = 'relay stopped, this must not arrive';
const restartedText = 'fresh relay delivery after restart';
const preferredText = 'use the first configured relay when both are up';
const switchedText = 'use the backup after the first relay stops';
const noReachText = 'the open link cannot reach the target, this must not arrive';
const recoveredText = 'use the first configured relay again after recovery';
const questionText = 'can the backup relay carry the answer?';
const answerText = 'yes, through the backup relay';

function sendTurn(id: string, to: string, message: string): ScriptTurn[] {
  return parentTurns({ steps: [{ tool: { id, name: 'intercom', arguments: { action: 'send', to, message } } }] });
}

async function send(pi: RpcDriver, marker: string): Promise<{ event: object; result: ToolResult }> {
  const settled = await pi.prompt(mark(marker));
  expect(settled.type).toBe('agent_settled');
  return toolResult(pi, marker);
}

async function toolResult(pi: RpcDriver, marker: string): Promise<{ event: object; result: ToolResult }> {
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
  const fixture = await relayFixture(suite, { secondRelay: true });
  const entries = async (): Promise<PhysicalEntry[]> => (await readFile(fixture.target.file, 'utf8')).split('\n').slice(0, -1)
    .filter(Boolean).map(line => JSON.parse(line) as PhysicalEntry)
    .filter(entry => entry.type === 'custom_message' && entry.customType === 'intercom_message');
  const receivedWithId = async (id: string): Promise<PhysicalEntry[]> => (await entries()).filter(entry => entry.details?.message?.id === id);
  const receivedWithText = async (text: string): Promise<PhysicalEntry[]> => (await entries()).filter(entry => entry.details?.message?.content?.text === text);
  const primaryAlias = 'relay-1.invalid', backupAlias = 'relay-2.invalid';
  const links = () => listV0RelayLinks(fixture.sender.agent);
  async function waitForBackup(reachesTarget: boolean, after?: RelayLinkView): Promise<RelayLinkView> {
    const matching = (link: RelayLinkView) => link.relay.alias === backupAlias && link.state === 'up' &&
      link.reach.some(peer => peer.machineId === fixture.target.machineId) === reachesTarget &&
      (!after || link.linkId === after.linkId && (link.lastCallMs ?? 0) > (after.lastCallMs ?? 0));
    const observed = await waitFor(reachesTarget ? 'backup advertises target reach' : 'next backup poll withdraws target reach', links,
      views => views.some(matching), deadline(40_000));
    return observed.find(matching)!;
  }
  async function sendThrough(marker: string, alias: string): Promise<string> {
    const { event, result } = await send(fixture.sender.pi, marker);
    await suite.evidence(`R19-${marker}-send.json`, { event, result });
    expect(result.details).toMatchObject({ delivered: true, path: `relay ${alias}`, messageId: expect.any(String) });
    const id = String(result.details.messageId);
    const receipts = await waitFor(`${marker} is physically recorded`, () => receivedWithId(id), found => found.length > 0, deadline(30_000));
    expect(receipts).toHaveLength(1);
    return id;
  }
  const scripts: Record<string, ScriptTurn[]> = {
    'relay-first': sendTurn('relay-first', fixture.target.id, firstText),
    'relay-stopped': sendTurn('relay-stopped', fixture.target.id, stoppedText),
    'relay-restarted': sendTurn('relay-restarted', fixture.target.id, restartedText),
    'preferred': sendTurn('preferred', fixture.target.id, preferredText),
    'switched': sendTurn('switched', fixture.target.id, switchedText),
    'no-reach': sendTurn('no-reach', fixture.target.id, noReachText),
    'recovered': sendTurn('recovered', fixture.target.id, recoveredText),
    'relay-ask': parentTurns({ steps: [{ tool: { id: 'relay-ask', name: 'intercom', arguments: {
      action: 'ask', to: fixture.target.id, message: questionText,
    } } }] }),
  };
  try {
    await writeScript(suite.pi.scriptPath, { story: suite.story, scripts });
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

    await fixture.startRelay(1);
    await waitForBackup(true);
    const both = await links();
    for (const alias of ['relay-1.invalid', 'relay-2.invalid']) {
      expect(both).toContainEqual(expect.objectContaining({ relay: expect.objectContaining({ alias }), state: 'up',
        reach: expect.arrayContaining([expect.objectContaining({ machineId: fixture.target.machineId })]) }));
    }
    await suite.evidence('R19-both-links-up.json', both);
    const preferredId = await sendThrough('preferred', 'relay-1.invalid');

    await fixture.stopRelay(0);
    await fixture.waitForDown();
    const switchedId = await sendThrough('switched', 'relay-2.invalid');
    const beforeCut = await waitForBackup(true);
    const withoutTarget = await fixture.withoutBackupTargetRoute(async () => {
      const observed = await waitForBackup(false, beforeCut);
      await suite.evidence('R19-live-link-without-target.json', { previous: beforeCut, current: observed });
      const { event, result: noReach } = await send(fixture.sender.pi, 'no-reach');
      await suite.evidence('R19-no-reach-send.json', { event, noReach, received: await receivedWithText(noReachText) });
      expect(noReach.content[0].text.split('\n')[0]).toBe('target.invalid is not reachable through any relay right now. Nothing was queued.');
      expect(noReach.details).toMatchObject({ code: 'relay-unreachable', relaySkips: [
        { relay: 'relay-1.invalid', reason: 'down' }, { relay: 'relay-2.invalid', reason: 'cannot reach the target' },
      ] });
      expect(await receivedWithText(noReachText)).toHaveLength(0);
      return observed;
    });
    await suite.evidence('R19-target-reach-restored.json', await waitForBackup(true, withoutTarget));
    await fixture.startRelay(0);
    const recoveredId = await sendThrough('recovered', 'relay-1.invalid');

    const ids = [firstId, restartedId, preferredId, switchedId, recoveredId];
    expect(new Set(ids).size).toBe(ids.length);
    const receipts = await Promise.all(ids.map(receivedWithId));
    for (const entries of receipts) expect(entries).toHaveLength(1);
    const stoppedReceipts = await receivedWithText(stoppedText), noReachReceipts = await receivedWithText(noReachText);
    expect(stoppedReceipts).toHaveLength(0);
    expect(noReachReceipts).toHaveLength(0);
    await suite.evidence('R19-failover-receipts.json', { ids, receipts, stoppedReceipts, noReachReceipts });
    console.log(`R19 ordered paths: relay-1.invalid, relay-2.invalid, relay-1.invalid; physical receipts: ${receipts.map(group => group.length).join(', ')}; refused receipts: ${stoppedReceipts.length}, ${noReachReceipts.length}`);

    const firstLink = async () => (await links()).find(view => view.relay.alias === primaryAlias);
    const beforeAsk = await firstLink();
    expect(beforeAsk).toMatchObject({ state: 'up' });
    const targetIdle = async () => {
      const state = (await fixture.target.pi.rpc({ type: 'get_state' })).data as { isStreaming?: boolean };
      return state.isStreaming === false;
    };
    await waitFor('target idle before the question', targetIdle, Boolean, deadline(30_000));
    const askResults = async () => (await fixture.sender.pi.events())
      .filter(event => event.type === 'tool_execution_end' && event.toolCallId === 'relay-ask');
    const askTurn = fixture.sender.pi.prompt(mark('relay-ask'));
    void askTurn.catch(() => {});
    const physical = await waitFor('one physical question before stopping the relay', async () => {
      const early = await askResults();
      if (early.length) throw new Error(`ask settled before receiving a question: ${JSON.stringify(early)}`);
      return receivedWithText(questionText);
    }, found => found.length > 0, deadline(30_000));
    expect(physical).toHaveLength(1);
    const askId = physical[0].details?.message?.id;
    expect(typeof askId).toBe('string');
    expect(physical[0].details?.message).toMatchObject({ v0RelayAsk: true });
    const confirmed = await waitFor('hold-0 confirms the question on the first link', firstLink,
      view => view?.messagesCarried === beforeAsk!.messagesCarried + 1, deadline(30_000));
    await fixture.stopRelay(0);
    const stoppedBeforeReply = await fixture.waitForDown();
    const askSettledBeforeReply = (await askResults()).length !== 0;
    expect(askSettledBeforeReply).toBe(false);
    expect(await receivedWithId(askId!)).toHaveLength(1);

    await waitFor('target idle before the scripted reply', targetIdle, Boolean, deadline(30_000));
    scripts['relay-answer'] = parentTurns({ steps: [{ tool: { id: 'relay-answer', name: 'intercom', arguments: {
      action: 'reply', replyTo: askId!, message: answerText,
    } } }] });
    await writeScript(suite.pi.scriptPath, { story: suite.story, scripts });
    const { result: replyLeg } = await send(fixture.target.pi, 'relay-answer');
    expect(replyLeg.details).toMatchObject({ delivered: true, replyTo: askId, path: 'relay relay-2.invalid' });
    expect((await askTurn).type).toBe('agent_settled');
    const { result: askResult } = await toolResult(fixture.sender.pi, 'relay-ask');
    expect(askResult.details).toMatchObject({ delivery: 'replied', messageId: askId, replyId: replyLeg.details.messageId });
    expect(askResult.content[0].text).toContain(answerText);
    const [completed, physicalQuestions] = await Promise.all([askResults(), receivedWithId(askId!)]);
    expect(completed).toHaveLength(1);
    expect(physicalQuestions).toHaveLength(1);
    expect(await receivedWithText(questionText)).toHaveLength(1);
    await suite.evidence('R19-ask-and-backup-reply.json', { beforeAsk, confirmed, stoppedBeforeReply, askSettledBeforeReply,
      physicalQuestions, replyLeg, askResult, completed });
    console.log(`R19 ask: ${physicalQuestions.length} physical question; hold-0 count +1; pending after relay stop; reply via relay-2.invalid; ${completed.length} completed ask`);
  } finally {
    try { await suite.keepEvidence(fixture.target.file, 'R19-target.jsonl'); }
    finally { await fixture.close(); }
  }
  for (const endpoint of [fixture.sender, fixture.target]) expect(existsSync(join(endpoint.agent, 'intercom', 'broker.sock'))).toBe(false);
  console.log('R19 cleanup: both private broker sockets are gone');
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
    expect(empty.callMs).toBeGreaterThanOrEqual(20_000);
    expect(empty.callMs).toBeLessThan(30_000);

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
    expect(handoff.callMs).toBeLessThan(20_000);

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
  { id: storyId('R19'), title: 'intercom sends through ordered owned relays', tiers: ['headless'], run: relayDelivery },
  { id: storyId('H-relay-poll'), title: 'buffered exec carries a held intercom relay poll', tiers: ['headless'], run: relayPoll },
];
registerScenarios(scenarios);
