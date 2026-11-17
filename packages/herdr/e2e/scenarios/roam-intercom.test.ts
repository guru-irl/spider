// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { openDbReadOnly } from '@spider/db-core';
import { requestHubControl } from '../../../roam/src/control-socket.js';
import type { IntercomEdgeState } from '../../../roam/src/intercom-contracts.js';
import { registerScenarios, storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import { writeScript, type InteractiveDriver, type ObservedEvent, type RpcDriver } from '../harness/pi.js';
import { deadline, waitFor } from '../harness/wait.js';
import { advanceIntercomClock, dropNextReply, intercomNetwork, launchMachinePi, pauseFederation, resumeFederation, saveIntercomEvidence, setLinkFault, syncOrigins, type Machine } from '../fixtures/roam-intercom.js';
import { enrollPair, preparePair, type PairFixture } from '../fixtures/roam-pair.js';
import { runHc } from '../harness/hc.js';
import { identityOf } from '../harness/resources.js';
import type { ScriptFile } from '../fixtures/scripted-provider.js';
import { held, mark, parentTurns, scripts, text } from '../fixtures/child-scripts.js';
import { adoption } from './intercom-fork.test.js';

const intercom = (id: string, args: Record<string, string>) => ({ steps: [{ tool: { id, name: 'intercom', arguments: args } }] });
const result = (event: ObservedEvent) => event.result as { content: { text?: string }[]; details: Record<string, unknown> };
const received = (event: ObservedEvent, body: string) => event.type === 'message_end' && event.customType === 'intercom_message' && JSON.stringify(event.content).includes(body);

export async function coldCliStartup(invoke: Suite['invoke'], entry: string, env: Readonly<Record<string, string>>): Promise<number> {
  const started = Date.now();
  const result = await invoke(process.execPath, [entry, '--help'], env);
  const durationMs = Date.now() - started;
  if (result.exitCode !== 0 || !result.stdout.startsWith('Usage: spider ')) throw new Error('cold-cli-help-unavailable');
  return durationMs;
}

async function call(session: InteractiveDriver, marker: string, id = marker): Promise<ObservedEvent> {
  await session.prompt(mark(marker));
  return session.toolResult(id, deadline(30_000));
}

async function actions(suite: Suite): Promise<void> {
  const unrelated = suite.ownPath(join(suite.root, 'unrelated'));
  const roots = ['agent', 'global', 'home'].map(name => join(unrelated, name));
  for (const [index, root] of roots.entries()) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'sentinel.json'), JSON.stringify({ fixture: `unrelated-${index}` }), { mode: 0o600 });
  }
  const fingerprint = async () => {
    const rows: { path: string; kind: string; mode: number; mtimeMs: number; sha256?: string }[] = [];
    const visit = async (path: string): Promise<void> => {
      const info = await lstat(path);
      if (info.isDirectory()) {
        rows.push({ path, kind: 'directory', mode: info.mode, mtimeMs: info.mtimeMs });
        for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
      } else if (info.isFile()) {
        rows.push({ path, kind: 'file', mode: info.mode, mtimeMs: info.mtimeMs, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
      } else throw new Error('unexpected unrelated fixture entry');
    };
    for (const root of roots) await visit(root);
    return rows;
  };
  const unrelatedBefore = await fingerprint();
  const terminal = await suite.hc(['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--cwd', unrelated, '--', '/bin/sleep', '600']);
  const address = (terminal.json as { address?: string } | null)?.address;
  if (terminal.exitCode !== 0 || !address) throw new Error('unrelated fixture terminal did not start');
  suite.ledger.update(ledger => { ledger.terminals.push({ side: 'local', address }); });
  const terminalBefore = await suite.hc(['get', address, '--json']);
  expect(terminalBefore.json).toMatchObject({ state: 'live' });
  const values: ScriptFile['scripts'] = { ready: parentTurns(text('ready')) };
  const gates = await scripts(suite, values);
  const network = await intercomNetwork(suite);
  const sessions: InteractiveDriver[] = [], ids: string[] = [];
  try {
    await pauseFederation(network);
    // Both boxes use the same name; the fourth session uses a different scope.
    for (const [i, machine, name, scope] of [[0, 0, 'coordinator', ''], [1, 1, 'helper', ''], [2, 2, 'helper', ''], [3, 2, 'hidden-helper', 'private-scope']] as const) {
      const cwd = await suite.project(`intercom-${i}`);
      const session = await launchMachinePi(suite, network.machines[machine], cwd, name, scope ? { PI_INTERCOM_SCOPE_ID: scope } : {}, undefined,
        i === 1 ? ['--extension', join(process.cwd(), 'packages/herdr/e2e/fixtures/roam-abort.mjs')] : []);
      sessions.push(session);
      const start = await session.waitEvent('session_start', () => true, deadline(30_000));
      ids.push(String(start.sessionId));
      const before = Date.now();
      await session.prompt(mark('ready'));
      await session.waitEvent('agent_settled', event => event.at >= before, deadline(30_000));
    }
    await syncOrigins(suite, network);
    await resumeFederation(network);
    await waitFor('all in-scope packaged sessions appear on every machine',
      () => Promise.all(network.machines.map(machine => machine.probe.listSessions())),
      lists => lists.every(list => ids.slice(0, 3).every(id => list.some(session => session.id === id)) && !list.some(session => session.id === ids[3])), deadline(60_000));
    Object.assign(values, {
      roster: parentTurns(intercom('roster', { action: 'list' })),
      cwd: parentTurns(intercom('cwd', { action: 'list-cwd' })),
      status: parentTurns(intercom('status', { action: 'status' })),
      ambiguous: parentTurns(intercom('ambiguous', { action: 'send', to: 'helper', message: 'ambiguous must not arrive' })),
      hidden: parentTurns(intercom('hidden', { action: 'send', to: ids[3], message: 'private scope must not arrive' })),
      send: parentTurns(intercom('send', { action: 'send', to: 'box-1.invalid/helper', message: 'synthetic intercom message' })),
      'ask-name': parentTurns(intercom('ask-name', { action: 'ask', to: 'box-1.invalid/helper', message: 'question by name' })),
      pending: parentTurns(intercom('pending', { action: 'pending' })),
      'reply-name': parentTurns(intercom('reply-name', { action: 'reply', message: 'answer by name' })),
      'ask-id': parentTurns(intercom('ask-id', { action: 'ask', to: ids[2], message: 'question by id' })),
      'reply-id': parentTurns(intercom('reply-id', { action: 'reply', message: 'answer by id' })),
    });
    await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: values });
    const roster = await call(sessions[0], 'roster');
    expect(roster.isError).toBe(false);
    expect(JSON.stringify(roster.result)).toContain('box-1.invalid/helper');
    expect(JSON.stringify(roster.result)).toContain('box-2.invalid/helper');
    expect(JSON.stringify(roster.result)).not.toContain('hidden-helper');
    const cwd = await call(sessions[0], 'cwd');
    expect(JSON.stringify(cwd.result)).toContain('No other sessions in this directory');
    const status = await call(sessions[0], 'status');
    expect(JSON.stringify(status.result)).toContain('Connected: Yes');
    const ambiguous = await call(sessions[0], 'ambiguous');
    expect(result(ambiguous).details.error).toBe(true);
    expect(JSON.stringify(ambiguous.result)).toMatch(/multiple|ambiguous/i);
    const hidden = await call(sessions[0], 'hidden');
    expect(hidden.isError).toBe(true);
    expect(result(hidden).details).toMatchObject({ delivered: false, outcomeKnown: true });
    const sent = await call(sessions[0], 'send');
    expect(result(sent).details).toMatchObject({ delivered: true, outcomeKnown: true });
    await sessions[1].waitEvent('message_end', event => received(event, 'synthetic intercom message'), deadline(60_000));
    expect((await sessions[1].events()).filter(event => received(event, 'synthetic intercom message'))).toHaveLength(1);
    for (const other of [sessions[2], sessions[3]]) {
      expect((await other.events()).some(event => received(event, 'ambiguous must not arrive') || received(event, 'private scope must not arrive'))).toBe(false);
    }
    const messageId = String(result(sent).details.messageId);
    values.cancel = parentTurns(intercom('cancel', { action: 'cancel', messageId }));
    await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: values });
    const cancelled = await call(sessions[0], 'cancel');
    expect(result(cancelled).details.messageId).toBe(messageId);

    await sessions[0].prompt(mark('ask-name'));
    const question1 = await sessions[1].waitEvent('message_end', event => received(event, 'question by name'), deadline(60_000));
    await sessions[1].waitEvent('agent_settled', event => event.at >= question1.at, deadline(30_000));
    const pending = await call(sessions[1], 'pending');
    expect(JSON.stringify(pending.result)).toContain('question by name');
    const reply1 = await call(sessions[1], 'reply-name');
    expect(result(reply1).details.delivered).toBe(true);
    const answer1 = await sessions[0].toolResult('ask-name', deadline(30_000));
    expect(JSON.stringify(answer1.result)).toContain('answer by name');
    expect(result(answer1).details.error).not.toBe(true);

    await sessions[0].prompt(mark('ask-id'));
    const question2 = await sessions[2].waitEvent('message_end', event => received(event, 'question by id'), deadline(60_000));
    await sessions[2].waitEvent('agent_settled', event => event.at >= question2.at, deadline(30_000));
    const reply2 = await call(sessions[2], 'reply-id');
    expect(result(reply2).details.delivered).toBe(true);
    const answer2 = await sessions[0].toolResult('ask-id', deadline(30_000));
    expect(JSON.stringify(answer2.result)).toContain('answer by id');
    expect(result(answer2).details.error).not.toBe(true);

    const localCwd = await suite.project('local-offline');
    const local = await launchMachinePi(suite, network.machines[0], localCwd, 'local-offline'); sessions.push(local);
    const localId = String((await local.waitEvent('session_start', () => true, deadline(30_000))).sessionId);
    await waitFor('local mailbox target registered', () => network.machines[0].probe.listSessions(),
      list => list.some(session => session.id === localId), deadline(30_000));
    await local.close();
    await waitFor('local mailbox target disconnected', () => network.machines[0].probe.listSessions(),
      list => !list.some(session => session.id === localId), deadline(30_000));
    values.localReplay = parentTurns(intercom('localReplay', { action: 'send', to: localId, message: 'local offline replay' }));
    await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: values });
    const queuedLocal = await call(sessions[0], 'localReplay');
    expect(result(queuedLocal).details).toMatchObject({ delivered: true, delivery: 'queued' });
    const resumedLocal = await launchMachinePi(suite, network.machines[0], localCwd, 'local-offline', {}, localId); sessions.push(resumedLocal);
    const replay = await resumedLocal.waitEvent('message_end', event => received(event, 'local offline replay'), deadline(60_000));
    expect((await resumedLocal.events()).filter(event => received(event, 'local offline replay'))).toHaveLength(1);
    expect(JSON.stringify(replay)).toContain(String(result(queuedLocal).details.messageId));

    values.busy = [held('busy-steer', 'receiver finishes held work')];
    values.steerReload = parentTurns(intercom('steerReload', { action: 'send', to: 'box-1.invalid/helper', message: 'busy steer across reload' }));
    values.afterUnknown = parentTurns(intercom('afterUnknown', { action: 'send', to: 'box-1.invalid/helper', message: 'later message advances past unknown' }));
    await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: values });
    await sessions[1].prompt(mark('busy'));
    await gates.ready('busy-steer', deadline(30_000));
    const steer = await call(sessions[0], 'steerReload'), steerId = String(result(steer).details.messageId);
    expect(result(steer).details.delivered).toBe(true);
    const transcript = join(network.machines[1].sessions, `${ids[1]}.jsonl`);
    const pendingFile = await waitFor('busy steer is pending in the physical receiver session', () => readFile(transcript, 'utf8'),
      entries => entries.split('\n').some(line => line.includes('intercom_pending') && line.includes(steerId)), deadline(30_000));
    const pendingSteer = pendingFile.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(entry => entry.type === 'custom' && entry.customType === 'intercom_pending' && entry.data?.messageId === steerId);
    expect(pendingSteer.data.owner.activationEpoch).toBe(pendingSteer.data.activationEpoch);
    expect((await sessions[1].events()).some(event => received(event, 'busy steer across reload'))).toBe(false);
    const retained = copy(network.machines[0], steerId);
    expect(retained?.state).not.toBe('injected');
    expect(retained?.payload_json).toContain('busy steer across reload');
    const abortAt = Date.now();
    await sessions[1].prompt('/fixture-abort');
    await sessions[1].waitEvent('agent_settled', event => event.at >= abortAt, deadline(30_000));
    const unknown = await waitFor('accepted queued steer remains unknown after abort', () => copy(network.machines[0], steerId),
      item => item?.state === 'unknown' && item.unknown_outcome === 1, deadline(60_000));
    expect((await sessions[1].events()).some(event => received(event, 'busy steer across reload'))).toBe(false);
    const afterUnknown = await call(sessions[0], 'afterUnknown'), laterId = String(result(afterUnknown).details.messageId);
    expect(result(afterUnknown).details.delivered).toBe(true);
    const later = await sessions[1].waitEvent('message_end', event => received(event, 'later message advances past unknown'), deadline(60_000));
    await sessions[1].waitEvent('agent_settled', event => event.at >= later.at, deadline(30_000));
    await waitFor('later pair message is injected while the first remains unknown', () => copy(network.machines[0], laterId),
      item => item?.state === 'injected', deadline(30_000));
    expect(copy(network.machines[0], steerId)).toMatchObject({ state: 'unknown', unknown_outcome: 1 });
    expect(JSON.parse(unknown!.endpoint_json).activationEpoch).toBe(pendingSteer.data.activationEpoch);
    await sessions[1].prompt('/reload');
    await waitFor('receiver reload starts before its queued message drains', () => sessions[1].events(),
      events => events.filter(event => event.type === 'session_start').length >= 2, deadline(30_000));
    expect(copy(network.machines[0], steerId)).toMatchObject({ state: 'unknown', unknown_outcome: 1 });
    expect(JSON.parse(copy(network.machines[0], steerId)!.endpoint_json).activationEpoch).toBe(pendingSteer.data.activationEpoch);
    expect((await sessions[1].events()).some(event => received(event, 'busy steer across reload'))).toBe(false);
    const beforeExclusion = (await readFile(transcript, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(beforeExclusion.filter(entry => entry.type === 'custom_message' && entry.details?.message?.id === steerId)).toHaveLength(0);
    const oldReceiver = sessions[1];
    await oldReceiver.close(); // Excludes the old process and its Pi queue; reload alone did not.
    const resumedReceiver = await launchMachinePi(suite, network.machines[1], oldReceiver.cwd, 'helper', {}, ids[1]);
    sessions[1] = resumedReceiver;
    const reloadedSteer = await resumedReceiver.waitEvent('message_end', event => received(event, 'busy steer across reload'), deadline(60_000));
    expect(JSON.stringify(reloadedSteer)).toContain(steerId);
    expect((await resumedReceiver.events()).filter(event => received(event, 'busy steer across reload'))).toHaveLength(1);
    const settledSteer = await waitFor('source retires the reloaded steer only after physical injection', () => copy(network.machines[0], steerId),
      item => item?.state === 'injected' && item.payload_json === null, deadline(60_000));
    const exclusion = JSON.parse(settledSteer!.reconciliation_json!);
    expect(exclusion).toMatchObject({ messageId: steerId, status: 'not_injected', evidence: { kind: 'absence', sessionId: ids[1],
      activationEpoch: pendingSteer.data.activationEpoch, excludedGeneration: pendingSteer.data.activationEpoch, complete: true } });
    const entries = (await readFile(transcript, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const physical = entries.filter(entry => entry.type === 'custom_message' && entry.details?.message?.id === steerId);
    expect(physical).toHaveLength(1);
    expect(physical[0].details.intercom.activationEpoch).not.toBe(pendingSteer.data.activationEpoch);
    expect(JSON.parse(settledSteer!.endpoint_json).activationEpoch).toBe(physical[0].details.intercom.activationEpoch);
    expect(JSON.parse(settledSteer!.receipt_json!)).toMatchObject({ messageId: steerId, status: 'injected', evidence: { kind: 'entry', entryId: physical[0].id, sessionId: ids[1] } });

    const rpcReceiver = await suite.launchPi({ mode: 'rpc', cwd: await suite.project('rpc-reload-queue'),
      args: ['--name', 'rpc-queue', '--extension', join(process.cwd(), 'packages/herdr/e2e/fixtures/roam-abort.mjs')],
      extraEnv: network.machines[0].env }) as RpcDriver;
    let retainedQueue: object;
    try {
      const start = await rpcReceiver.waitEvent('session_start', () => true, deadline(30_000));
      const rpcId = String(start.sessionId), rpcFile = String(start.sessionFile);
      values.rpcStatus = parentTurns(intercom('rpcStatus', { action: 'status' }));
      await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: values });
      await rpcReceiver.prompt(mark('rpcStatus'));
      const rpcStatus = await rpcReceiver.toolResult('rpcStatus', deadline(30_000));
      expect(JSON.stringify(rpcStatus.result)).toContain('Connected: Yes');
      await waitFor('RPC receiver is visible to the real local broker', () => network.machines[0].probe.listSessions(),
        list => list.some(session => session.id === rpcId), deadline(30_000));
      values.rpcBusy = [held('rpc-busy', 'RPC receiver finishes held work')];
      await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: values });
      await rpcReceiver.rpc({ type: 'prompt', message: mark('rpcBusy') });
      await gates.ready('rpc-busy', deadline(30_000));
      const rpcMessageId = randomUUID(), receipts: { messageId: string; status: string; evidence?: unknown }[] = [];
      const offReceipt = network.machines[0].probe.onMessageReceipt((_from, receipt) => { if (receipt.messageId === rpcMessageId) receipts.push(receipt); });
      const rpcSend = await network.machines[0].probe.send(rpcId, { messageId: rpcMessageId, text: 'retained Pi queue after reload' });
      expect(rpcSend.delivered).toBe(true);
      await waitFor('RPC receiver accepted its queued steer', () => readFile(rpcFile, 'utf8'),
        file => file.split('\n').some(line => line.includes('intercom_pending') && line.includes(rpcMessageId)), deadline(30_000));
      await rpcReceiver.rpc({ type: 'abort' });
      await waitFor('RPC queued steer is unknown after abort', () => receipts,
        rows => rows.some(receipt => receipt.status === 'unknown'), deadline(30_000));
      await rpcReceiver.prompt('/fixture-reload');
      expect(receipts.some(receipt => receipt.status === 'not_injected')).toBe(false);
      const beforeDrain = (await readFile(rpcFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      expect(beforeDrain.filter(entry => entry.type === 'custom_message' && entry.details?.message?.id === rpcMessageId)).toHaveLength(0);
      await rpcReceiver.rpc({ type: 'prompt', message: mark('ready') });
      const drained = await rpcReceiver.waitEvent('message_end', event => received(event, 'retained Pi queue after reload'), deadline(60_000));
      expect(JSON.stringify(drained)).toContain(rpcMessageId);
      await waitFor('original Pi queue produces physical consumption proof', () => receipts,
        rows => rows.some(receipt => receipt.status === 'injected'), deadline(30_000));
      const afterDrain = (await readFile(rpcFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      const entriesForId = afterDrain.filter(entry => entry.type === 'custom_message' && entry.details?.message?.id === rpcMessageId);
      expect(entriesForId).toHaveLength(1);
      expect(receipts.some(receipt => receipt.status === 'not_injected')).toBe(false);
      expect(receipts.find(receipt => receipt.status === 'injected')).toMatchObject({ messageId: rpcMessageId, status: 'injected',
        evidence: { kind: 'entry', sessionId: rpcId, entryId: entriesForId[0].id } });
      offReceipt();
      retainedQueue = { rpcId, send: rpcSend, receipts, drained };
    } finally { await rpcReceiver.close(); }

    await suite.evidence('R11-actions.json', { ids, localId, queuedLocal: queuedLocal.result, replay, steer: steer.result, retained, unknown, afterUnknown: afterUnknown.result, later, exclusion, reloadedSteer, retainedQueue,
      roster: roster.result, cwd: cwd.result, status: status.result,
      ambiguous: ambiguous.result, hidden: hidden.result, sent: sent.result, cancelled: cancelled.result, pending: pending.result,
      question1, reply1: reply1.result, answer1: answer1.result, question2, reply2: reply2.result, answer2: answer2.result });
  } finally {
    await saveIntercomEvidence(suite, network);
    for (const session of sessions.reverse()) await session.close();
    await network.close();
  }
  await adoption(suite);
  const unrelatedAfter = await fingerprint(), terminalAfter = await suite.hc(['get', address, '--json']);
  expect(unrelatedAfter).toEqual(unrelatedBefore);
  expect(terminalAfter.json).toMatchObject({ state: 'live' });
  expect((terminalAfter.json as { address?: string }).address).toBe((terminalBefore.json as { address?: string }).address);
  await suite.evidence('R11-isolation.json', { unrelatedBefore, unrelatedAfter, terminalBefore: terminalBefore.json, terminalAfter: terminalAfter.json });
}

function edge(machine: Machine, peer: Machine): IntercomEdgeState | null {
  const db = openDbReadOnly(join(machine.global, 'roam', 'intercom', 'queue.db'));
  if (!db) return null;
  try {
    const row = db.prepare('SELECT state_json FROM intercom_edge_state WHERE peer=?').get(peer.id) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) : null;
  } finally { db.close(); }
}

function copy(machine: Machine, id: string, direction: 'outbound' | 'inbound' = 'outbound'): { peer: string; state: string; endpoint_json: string; payload_json: string | null; unknown_outcome: number; receipt_json: string | null; reconciliation_json: string | null } | null {
  const db = openDbReadOnly(join(machine.global, 'roam', 'intercom', 'queue.db'));
  if (!db) return null;
  try { return (db.prepare('SELECT peer,state,endpoint_json,payload_json,unknown_outcome,receipt_json,reconciliation_json FROM intercom_copies WHERE direction=? AND id=?').get(direction, id) ?? null) as ReturnType<typeof copy>; }
  finally { db.close(); }
}

async function outages(suite: Suite): Promise<void> {
  const values: ScriptFile['scripts'] = {
    ready: parentTurns(text('ready')),
    ask: parentTurns(intercom('outage-ask', { action: 'ask', to: 'box-1.invalid/helper', message: 'outage question' })),
    knownDown: parentTurns(intercom('knownDown', { action: 'ask', to: 'box-1.invalid/helper', message: 'known-down question' })),
    restartSend: parentTurns(intercom('restartSend', { action: 'send', to: 'box-1.invalid/helper', message: 'queued across host restart' })),
    expiringAsk: parentTurns(intercom('expiringAsk', { action: 'ask', to: 'box-1.invalid/helper', message: 'expiring undelivered question' })),
    expiringBusy: [held('expiring-busy', 'receiver finishes after question expiry')],
    first: parentTurns(intercom('first', { action: 'send', to: 'box-1.invalid/helper', message: 'queued first' })),
    second: parentTurns(intercom('second', { action: 'send', to: 'box-1.invalid/helper', message: 'queued second' })),
    cancelSend: parentTurns(intercom('cancelSend', { action: 'send', to: 'box-1.invalid/helper', message: 'cancelled private body' })),
    lateReply: parentTurns(intercom('lateReply', { action: 'reply', message: 'late answer after link-down' })),
    expiry: parentTurns(intercom('expiry', { action: 'send', to: 'box-1.invalid/helper', message: 'expiring private body' })),
    barrier: parentTurns(intercom('barrier', { action: 'send', to: 'box-1.invalid/helper', message: 'recovery barrier' })),
  };
  const gates = await scripts(suite, values);
  const network = await intercomNetwork(suite, { faults: true, virtualClock: true });
  const sessions: InteractiveDriver[] = [], cwds: string[] = [], ids: string[] = [];
  try {
    await pauseFederation(network);
    for (const [i, machine, name] of [[0, 0, 'coordinator'], [1, 1, 'helper'], [2, 2, 'reviewer'], [3, 0, 'second-sender']] as const) {
      const cwd = await suite.project(`outage-${i}`); cwds.push(cwd);
      const session = await launchMachinePi(suite, network.machines[machine], cwd, name, i === 3 ? { PI_INTERCOM_ASK_TIMEOUT_MS: '5000' } : {});
      sessions.push(session);
      const start = await session.waitEvent('session_start', () => true, deadline(30_000)); ids.push(String(start.sessionId));
      const before = Date.now(); await session.prompt(mark('ready'));
      await session.waitEvent('agent_settled', event => event.at >= before, deadline(30_000));
    }
    const [hub, box] = network.machines;
    await syncOrigins(suite, network);
    await resumeFederation(network);
    await waitFor('live box roster before outage', () => hub.probe.listSessions(), list => list.some(session => session.name === 'helper'), deadline(60_000));
    await sessions[1].prompt(mark('expiringBusy')); await gates.ready('expiring-busy', deadline(30_000));
    await sessions[3].prompt(mark('expiringAsk'));
    const expiredAsk = await sessions[3].toolResult('expiringAsk', deadline(30_000));
    expect(expiredAsk.isError).toBe(true);
    expect(result(expiredAsk).details.deliveryState).toBe('expired');
    const expiredAskId = String(result(expiredAsk).details.messageId);
    const expiredAskCopy = await waitFor('undelivered expired ask erases source payload', () => copy(hub, expiredAskId),
      row => row?.state === 'expired' && row.payload_json === null, deadline(30_000));
    const expiredAskInbox = await waitFor('receiver accepts the expired ask tombstone', () => copy(box, expiredAskId, 'inbound'),
      row => row?.state === 'expired' && row.payload_json === null, deadline(30_000));
    const receiverFile = join(box.sessions, `${ids[1]}.jsonl`);
    expect((await readFile(receiverFile, 'utf8')).split('\n').some(line => line.includes('intercom_pending') && line.includes(expiredAskId))).toBe(false);
    const releaseAt = Date.now(); gates.release('expiring-busy');
    await sessions[1].waitEvent('agent_settled', event => event.at >= releaseAt, deadline(30_000));
    expect((await sessions[1].events()).some(event => received(event, 'expiring undelivered question'))).toBe(false);
    await sessions[0].prompt(mark('ask'));
    await sessions[1].waitEvent('message_end', event => received(event, 'outage question'), deadline(60_000));
    await setLinkFault(hub, [box.alias]); await setLinkFault(box, [hub.alias]);
    const firstFailure = await waitFor('one transient edge failure preserves the active wait', () => edge(hub, box),
      state => state?.status === 'recovering' && state.failures === 1, deadline(30_000));
    expect((await sessions[0].events()).some(event => event.type === 'tool_execution_end' && event.toolCallId === 'outage-ask')).toBe(false);
    const down = await waitFor('packaged hub marks the failed edge down after its retry', () => edge(hub, box), state => state?.status === 'down', deadline(60_000));
    const downRoster = await hub.probe.listSessions();
    expect(downRoster.find(session => session.id === ids[1])).toMatchObject({ name: 'helper', machineAlias: 'box-1.invalid', reachability: 'down' });
    const failedAsk = await sessions[0].toolResult('outage-ask', deadline(30_000));
    expect(failedAsk.isError).toBe(true);
    expect(result(failedAsk).details).toMatchObject({ error: true, reason: 'link-down' });
    const knownDown = await call(sessions[3], 'knownDown');
    expect(knownDown.isError).toBe(true);
    expect(result(knownDown).details).toMatchObject({ error: true, reason: 'link-down' });
    const first = await call(sessions[0], 'first'), second = await call(sessions[0], 'second');
    for (const item of [first, second]) expect(result(item).details).toMatchObject({ delivered: true, delivery: 'queued', outcomeKnown: true, acceptance: { durable: true } });
    const cancelSend = await call(sessions[0], 'cancelSend'), cancelledId = String(result(cancelSend).details.messageId);
    expect(result(cancelSend).details).toMatchObject({ delivered: true, delivery: 'queued' });
    values.cancel = parentTurns(intercom('cancel', { action: 'cancel', messageId: cancelledId }));
    await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: values });
    const cancelled = await call(sessions[0], 'cancel');
    expect(result(cancelled).details).toMatchObject({ messageId: cancelledId, delivered: true });
    const advanced = await advanceIntercomClock(hub, 10 * 60_000);
    const retried = await waitFor('failed outage probe finishes before recovery', () => edge(hub, box),
      state => state?.status === 'down' && state.failures > down!.failures, deadline(30_000));
    const status = await requestHubControl(join(hub.global, 'roam', 'hub.sock'), { op: 'status' });
    const links = (status.value?.intercom as { links: { peer: string; status: string; since: number }[] }).links;
    expect(links.filter(link => link.peer === box.id)).toHaveLength(1);
    expect(links.find(link => link.peer === box.id)).toMatchObject({ status: 'down', since: down!.outageSince });
    expect(advanced.offset).toBe(10 * 60_000);
    const firstId = String(result(first).details.messageId), secondId = String(result(second).details.messageId);
    await dropNextReply(hub, box.alias, firstId);
    await sessions[0].close();
    await waitFor('sender is absent before link recovery', () => hub.probe.listSessions(), list => !list.some(session => session.id === ids[0]), deadline(30_000));
    await setLinkFault(hub, []); await setLinkFault(box, []);
    await advanceIntercomClock(hub, 30_000);
    await waitFor('packaged hub recovers the edge', () => edge(hub, box), state => state?.status === 'live', deadline(60_000));
    await sessions[1].waitEvent('message_end', event => received(event, 'queued second'), deadline(60_000));
    sessions[0] = await launchMachinePi(suite, hub, cwds[0], 'coordinator', {}, ids[0]);
    const returned = await sessions[0].waitEvent('session_start', () => true, deadline(30_000));
    expect(returned.sessionId).toBe(ids[0]);
    const barrier = await call(sessions[0], 'barrier');
    expect(result(barrier).details.delivered).toBe(true);
    await sessions[1].waitEvent('message_end', event => received(event, 'recovery barrier'), deadline(60_000));
    const events = await sessions[1].events();
    const firsts = events.filter(event => received(event, 'queued first')), seconds = events.filter(event => received(event, 'queued second'));
    expect(firsts).toHaveLength(1); expect(seconds).toHaveLength(1);
    expect(JSON.stringify(firsts[0].content)).toContain(firstId); expect(JSON.stringify(seconds[0].content)).toContain(secondId);
    expect(events.indexOf(firsts[0])).toBeLessThan(events.indexOf(seconds[0]));
    const senderEvents = await sessions[0].events();
    expect(senderEvents.some(event => received(event, 'queued first') || received(event, 'queued second'))).toBe(false);
    expect(copy(hub, firstId, 'inbound')).toBeNull(); expect(copy(hub, secondId, 'inbound')).toBeNull();
    const claims = await waitFor('targeted real exchange reply was lost', async () => {
      const directory = join(hub.global, '..');
      const names = (await readdir(directory)).filter(name => name.startsWith(`fault.json.drop-${box.alias}.claimed-`));
      return await Promise.all(names.map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))));
    }, rows => rows.some(row => row.code === 0 && row.cut === false), deadline(30_000));
    expect(claims).toHaveLength(1);
    const settled = await waitFor('same accepted IDs reconcile at the source', () => [copy(hub, firstId), copy(hub, secondId)],
      rows => rows.every(row => row?.state === 'injected' && row.payload_json === null), deadline(60_000));
    expect(events.some(event => received(event, 'cancelled private body'))).toBe(false);
    const beforeReload = (await hub.probe.listSessions()).find(session => session.id === ids[0]);
    expect(beforeReload?.activationEpoch).toBeTruthy();
    const reloadDeadline = deadline(30_000);
    await sessions[0].prompt('/reload');
    await waitFor('returned sender reload completes before the late reply', () => sessions[0].events(),
      entries => entries.filter(event => event.type === 'session_start').length >= 2, reloadDeadline);
    const localPresence = await waitFor('reloaded sender registers its new activation', () => hub.probe.listSessions(),
      list => list.some(session => session.id === ids[0] && !!session.activationEpoch && session.activationEpoch !== beforeReload!.activationEpoch), reloadDeadline);
    const activation = localPresence.find(session => session.id === ids[0] && !!session.activationEpoch && session.activationEpoch !== beforeReload!.activationEpoch)!.activationEpoch;
    await waitFor('helper sees the reloaded sender activation', () => box.probe.listSessions(),
      list => list.some(session => session.remote === true && session.id === ids[0] && session.activationEpoch === activation && session.reachability === 'live'), reloadDeadline);
    const lateReply = await call(sessions[1], 'lateReply');
    expect(result(lateReply).details.delivered).toBe(true);
    await sessions[0].waitEvent('message_end', event => received(event, 'late answer after link-down'), deadline(60_000));
    expect((await sessions[0].events()).filter(event => received(event, 'late answer after link-down'))).toHaveLength(1);
    await waitFor('recovered edge has no outage diagnostic', async () => {
      const current = await requestHubControl(join(hub.global, 'roam', 'hub.sock'), { op: 'status' });
      return (current.value?.intercom as { links: { peer: string }[] }).links;
    }, current => !current.some(link => link.peer === box.id), deadline(60_000));
    await setLinkFault(hub, [box.alias]); await setLinkFault(box, [hub.alias]);
    await waitFor('restart outage is down', () => edge(hub, box), state => state?.status === 'down', deadline(60_000));
    const restartSend = await call(sessions[0], 'restartSend'), restartId = String(result(restartSend).details.messageId);
    expect(result(restartSend).details).toMatchObject({ delivered: true, delivery: 'queued' });
    const previousSupervisor = box.service.identity;
    await network.restartBox(1, box.config);
    expect(box.service.identity).not.toEqual(previousSupervisor);
    expect(copy(hub, restartId)?.state).toBe('queued');
    const restartDown = await waitFor('edge remains down after the host restart', () => edge(hub, box), state => state?.status === 'down', deadline(60_000));
    await advanceIntercomClock(hub, 30_000);
    await waitFor('post-restart outage probe finishes', () => edge(hub, box),
      state => state?.status === 'down' && state.failures > restartDown!.failures, deadline(30_000));
    await setLinkFault(hub, []); await setLinkFault(box, []);
    await advanceIntercomClock(hub, 30_000);
    await waitFor('edge recovers after the host restart', () => edge(hub, box), state => state?.status === 'live', deadline(60_000));
    await sessions[1].waitEvent('message_end', event => received(event, 'queued across host restart'), deadline(60_000));
    expect((await sessions[1].events()).filter(event => received(event, 'queued across host restart'))).toHaveLength(1);
    await setLinkFault(hub, [box.alias]); await setLinkFault(box, [hub.alias]);
    await waitFor('expiry outage is down', () => edge(hub, box), state => state?.status === 'down', deadline(60_000));
    const expiry = await call(sessions[0], 'expiry'), expiredId = String(result(expiry).details.messageId);
    expect(result(expiry).details).toMatchObject({ delivered: true, delivery: 'queued' });
    const expiredClock = await advanceIntercomClock(hub, 24 * 60 * 60_000 + 1_000);
    const expired = await waitFor('expired queued payload is erased', () => copy(hub, expiredId),
      row => row?.state === 'expired' && row.payload_json === null, deadline(30_000));
    expect((await sessions[1].events()).some(event => received(event, 'expiring private body'))).toBe(false);
    const logPaths = [join(suite.root, 'hc-calls.jsonl'), join(suite.root, 'via.jsonl'),
      ...network.machines.flatMap(machine => [join(machine.global, '..', 'service.log'), join(machine.global, '..', 'broker.log')])];
    for (const path of logPaths) {
      const log = await readFile(path, 'utf8');
      for (const body of ['outage question', 'known-down question', 'queued first', 'queued second', 'cancelled private body', 'queued across host restart', 'expiring undelivered question', 'expiring private body', 'late answer after link-down']) expect(log).not.toContain(body);
    }
    await suite.evidence('R12-outage.json', { firstFailure, down, downRoster, retried, advanced, links, failedAsk: failedAsk.result, knownDown: knownDown.result, first: first.result, second: second.result,
      cancelled: cancelled.result, returned, lateReply: lateReply.result, restartSend: restartSend.result, previousSupervisor, restartedSupervisor: box.service.identity,
      expiredAsk: expiredAsk.result, expiredAskCopy, expiredAskInbox, expiry: expiry.result, expiredClock, expired, claims, settled, logPaths,
      barrier: barrier.result, received: [...firsts, ...seconds] });
  } finally {
    await saveIntercomEvidence(suite, network);
    for (const session of sessions.reverse()) await session.close();
    await network.close();
  }
}

async function topology(suite: Suite): Promise<void> {
  const phaseStarted = Date.now();
  const phase = (name: string) => console.info(JSON.stringify({ story: suite.story, phase: name, elapsedMs: Date.now() - phaseStarted }));
  phase('scripts');
  const values: ScriptFile['scripts'] = {
    ready: parentTurns(text('ready')),
    relayA: parentTurns(intercom('relayA', { action: 'send', to: 'box-2.invalid/beta', message: 'hub relay A to B' })),
    relayB: parentTurns(intercom('relayB', { action: 'send', to: 'box-1.invalid/alpha', message: 'hub relay B to A' })),
    hubHeld: parentTurns(intercom('hubHeld', { action: 'send', to: 'box-2.invalid/beta', message: 'hub custody before transition' })),
    held: parentTurns(intercom('held', { action: 'send', to: 'box-2.invalid/beta', message: 'hub-only retained mail' })),
    originalPeer: parentTurns(intercom('originalPeer', { action: 'send', to: 'box-1.invalid/alpha', message: 'original sessions peer B to A' })),
    peerAfter: parentTurns(intercom('peerAfter', { action: 'send', to: 'box-2.invalid/beta', message: 'original sessions peer A to B' })),
    peerA: parentTurns(intercom('peerA', { action: 'send', to: 'box-2.invalid/beta-peer', message: 'peer A to B' })),
    peerB: parentTurns(intercom('peerB', { action: 'send', to: 'box-1.invalid/alpha-peer', message: 'peer B to A' })),
    hubToA: parentTurns(intercom('hubToA', { action: 'send', to: 'box-1.invalid/alpha', message: 'hub to alpha after transition' })),
    aToHub: parentTurns(intercom('aToHub', { action: 'send', to: 'hub.invalid/coordinator', message: 'alpha to hub after transition' })),
    hubToB: parentTurns(intercom('hubToB', { action: 'send', to: 'box-2.invalid/beta', message: 'hub to beta after transition' })),
    bToHub: parentTurns(intercom('bToHub', { action: 'send', to: 'hub.invalid/coordinator', message: 'beta to hub after transition' })),
    askOriginalA: parentTurns(intercom('askOriginalA', { action: 'ask', to: 'box-2.invalid/beta', message: 'original peer question A' })),
    replyOriginalB: parentTurns(intercom('replyOriginalB', { action: 'reply', message: 'original peer answer B' })),
    askOriginalB: parentTurns(intercom('askOriginalB', { action: 'ask', to: 'box-1.invalid/alpha', message: 'original peer question B' })),
    replyOriginalA: parentTurns(intercom('replyOriginalA', { action: 'reply', message: 'original peer answer A' })),
    askFreshA: parentTurns(intercom('askFreshA', { action: 'ask', to: 'box-2.invalid/beta-peer', message: 'fresh peer question A' })),
    replyFreshB: parentTurns(intercom('replyFreshB', { action: 'reply', message: 'fresh peer answer B' })),
    askFreshB: parentTurns(intercom('askFreshB', { action: 'ask', to: 'box-1.invalid/alpha-peer', message: 'fresh peer question B' })),
    replyFreshA: parentTurns(intercom('replyFreshA', { action: 'reply', message: 'fresh peer answer A' })),
  };
  await scripts(suite, values);
  phase('network-setup');
  const network = await intercomNetwork(suite, { faults: true }), sessions: InteractiveDriver[] = [], sessionIds: string[] = [];
  let pair: PairFixture | undefined;
  try {
    phase('cold-cli-startup');
    const durationMs = await coldCliStartup(suite.invoke, suite.packed.roamCli, network.machines[0].env);
    const startup = { story: suite.story, measurement: 'cold-cli-startup', command: '--help', processCold: true, durationMs };
    console.info(JSON.stringify(startup));
    await suite.evidence('R13-cold-cli-startup.json', startup);
    phase('original-sessions');
    await pauseFederation(network);
    for (const [i, name] of ['coordinator', 'alpha', 'beta'].entries()) {
      const session = await launchMachinePi(suite, network.machines[i], await suite.project(`topology-${i}`), name);
      sessions.push(session);
      sessionIds.push(String((await session.waitEvent('session_start', () => true, deadline(30_000))).sessionId));
      const before = Date.now(); await session.prompt(mark('ready'));
      await session.waitEvent('agent_settled', event => event.at >= before, deadline(30_000));
    }
    phase('initial-origin-sync');
    const [hub, source, target] = network.machines;
    await syncOrigins(suite, network);
    phase('initial-hub-relays');
    await resumeFederation(network);
    await waitFor('hub-only boxes see each other through the hub', () => source.probe.listSessions(), list => list.some(session => session.name === 'beta'), deadline(60_000));
    const relayA = await call(sessions[1], 'relayA');
    expect(result(relayA).details.delivered).toBe(true);
    await sessions[2].waitEvent('message_end', event => received(event, 'hub relay A to B'), deadline(60_000));
    const relayB = await call(sessions[2], 'relayB');
    expect(result(relayB).details.delivered).toBe(true);
    await sessions[1].waitEvent('message_end', event => received(event, 'hub relay B to A'), deadline(60_000));
    for (const [machine, relay] of [[source, relayA], [target, relayB]] as const) {
      const id = String(result(relay).details.messageId);
      await waitFor('hub relay receipt returns to its origin', () => copy(machine, id), row => row?.state === 'injected', deadline(60_000));
    }
    phase('hold-hub-relay');
    await setLinkFault(hub, [target.alias]); await setLinkFault(target, [hub.alias]);
    const hubHeld = await call(sessions[1], 'hubHeld'), hubHeldId = String(result(hubHeld).details.messageId);
    expect(result(hubHeld).details.delivered).toBe(true);
    await waitFor('hub durably holds the pre-transition relay', () => copy(hub, hubHeldId, 'inbound'), row => row?.state === 'queued', deadline(60_000));
    expect(copy(target, hubHeldId, 'inbound')).toBeNull();
    const hubHeldEndpoint = JSON.parse(copy(source, hubHeldId)!.endpoint_json);
    expect(hubHeldEndpoint).toMatchObject({ machineId: target.id, homeEpoch: null });
    await hub.service.stop();
    await setLinkFault(source, [hub.alias]); await setLinkFault(target, [hub.alias]);
    phase('hub-off-custody');
    const held = await call(sessions[1], 'held'), heldId = String(result(held).details.messageId);
    expect(result(held).details).toMatchObject({ delivered: true, delivery: 'queued', acceptance: { durable: true } });
    await waitFor('hub-only route is down', () => edge(source, hub), state => state?.status === 'down', deadline(60_000));
    expect(copy(source, heldId)?.state).toBe('queued');
    const heldEndpoint = JSON.parse(copy(source, heldId)!.endpoint_json);
    expect(heldEndpoint).toEqual(hubHeldEndpoint);
    expect((await sessions[2].events()).some(event => received(event, 'hub-only retained mail'))).toBe(false);

    phase('prepare-peer-pair');
    pair = await preparePair(suite, network);
    await suite.evidence('R13-staged-rosters.json', await Promise.all(network.machines.map(machine => machine.probe.listSessions())));
    await setLinkFault(hub, [source.alias, target.alias], "exchange");
    await network.restartHub();
    phase('enroll-peer-pair');
    const firstEnrollment = await enrollPair(suite, network, pair);
    let enrollment = firstEnrollment;
    if (firstEnrollment.code === 3 && firstEnrollment.output.includes('intercom-verification-pending')) {
      const operation = /Operation:\s*([0-9a-f-]{36})/.exec(firstEnrollment.output)?.[1];
      if (!operation) throw new Error('pending enrollment did not identify its operation');
      await waitFor('both real peer bridges become live', () => [edge(source, target), edge(target, source)],
        rows => rows.every(row => row?.status === 'live'), deadline(60_000));
      enrollment = await enrollPair(suite, network, pair, operation);
    }
    expect(enrollment.code, enrollment.output).toBe(0);
    expect(enrollment.output).toContain('intercom-enrolled');
    const topologyState = () => {
      const db = openDbReadOnly(join(hub.global, 'roam', 'intercom', 'queue.db'));
      if (!db) return null;
      try {
        const row = db.prepare('SELECT mode,transition_json FROM intercom_topology WHERE id=1').get() as { mode: string; transition_json: string | null };
        return { mode: row.mode, transition: row.transition_json ? JSON.parse(row.transition_json) : null };
      } finally { db.close(); }
    };
    phase('drain-fence');
    const draining = await waitFor('explicit enrollment durably fences relay intake', topologyState, row => row?.transition?.state === 'draining', deadline(30_000));
    expect(draining?.mode).toBe('hub-only');
    expect(copy(source, heldId)?.peer).toBe(hub.id);
    const beforeRestart = draining!.transition.transitionId;
    await hub.service.stop(); await network.restartHub();
    expect(topologyState()?.transition).toMatchObject({ transitionId: beforeRestart, state: 'draining' });
    phase('first-home-adoption');
    await waitFor('original registrations adopt their first replicated home without reload',
      () => Promise.all([source.probe.listSessions(), target.probe.listSessions()]),
      rosters => rosters.every((list, i) => list.some(session => session.id === sessionIds[i + 1] && session.homeEpoch === 1)), deadline(60_000));
    phase('drain-custody');
    await setLinkFault(hub, []); await setLinkFault(source, []); await setLinkFault(target, []);
    await suite.evidence('R13-drain-rosters.json', await Promise.all(network.machines.map(machine => machine.probe.listSessions())));
    await sessions[2].waitEvent('message_end', event => received(event, 'hub custody before transition'), deadline(60_000));
    const drainedSource = await waitFor('drained relay consumption reaches the original source', () => copy(source, hubHeldId), row => row?.state === 'injected' && row.payload_json === null, deadline(60_000));
    expect(JSON.parse(drainedSource!.endpoint_json)).toEqual(hubHeldEndpoint);
    expect(JSON.parse(copy(target, hubHeldId, 'inbound')!.endpoint_json)).toEqual(hubHeldEndpoint);
    expect(JSON.parse(drainedSource!.receipt_json!)).toMatchObject({ messageId: hubHeldId, status: 'injected',
      evidence: { sessionId: sessionIds[2], activationEpoch: hubHeldEndpoint.activationEpoch } });
    phase('switch-acknowledgement');
    const complete = await waitFor('both boxes acknowledge the durable topology switch', topologyState, row => row?.transition?.state === 'complete', deadline(60_000));
    expect(complete).toMatchObject({ mode: 'peers', transition: { boxes: { [source.id]: 'switched', [target.id]: 'switched' } } });
    await waitFor('hub edges are live after the completed switch', () => [edge(hub, source), edge(source, hub), edge(hub, target), edge(target, hub)],
      states => states.every(state => state?.status === 'live'), deadline(60_000));
    expect(edge(source, hub)?.roster.every(entry => entry.machineId === hub.id)).toBe(true);
    expect(edge(target, hub)?.roster.every(entry => entry.machineId === hub.id)).toBe(true);
    phase('hub-message-roundtrips');
    for (const [sender, recipient, marker, body] of [[0, 1, 'hubToA', 'hub to alpha after transition'], [1, 0, 'aToHub', 'alpha to hub after transition'],
      [0, 2, 'hubToB', 'hub to beta after transition'], [2, 0, 'bToHub', 'beta to hub after transition']] as const) {
      const sent = await call(sessions[sender], marker);
      await suite.evidence(`R13-${marker}.json`, sent.result as object);
      expect(result(sent).details.delivered).toBe(true);
      await sessions[recipient].waitEvent('message_end', event => received(event, body), deadline(60_000));
    }
    await hub.service.stop();
    await setLinkFault(source, [hub.alias]); await setLinkFault(target, [hub.alias]);
    phase('original-enrolled-peers');
    const registrations = await Promise.all(network.machines.map(async machine => JSON.parse(await readFile(join(machine.global, 'roam', 'intercom', 'enrollments', `${pair!.pairId}.json`), 'utf8'))));
    expect(registrations.map(record => record.state)).toEqual(['active', 'active', 'active']);
    expect(new Set(registrations.map(record => record.operationId)).size).toBe(1);
    const connectorProcesses = [source, target].map((machine, i) => {
      const record = registrations[i + 1], main = record.unit.main as { pid: number; startIdentity: string; controlGroup: string };
      expect(main.pid).toBeGreaterThan(0);
      expect(identityOf(main.pid).start).toBe(main.startIdentity);
      const group = Number(execFileSync('/bin/ps', ['-p', String(main.pid), '-o', 'pgid='], { encoding: 'utf8' }).trim());
      expect(group).toBe(pair!.managers[i].identity.pid);
      expect(record.unit.name).toBe(`spider-pair-${pair!.pairId}-${i === 0 ? 'connect' : 'host'}.service`);
      expect(record.resources.route.name).toBe(pair!.alias);
      return { machine: machine.id, ...main, group };
    });
    await waitFor('original sessions see each other on the enrolled peer edge', async () => Promise.all([source.probe.listSessions(), target.probe.listSessions()]),
      lists => lists[0].some(session => session.remote === true && session.name === 'beta' && session.reachability === 'live') &&
        lists[1].some(session => session.remote === true && session.name === 'alpha' && session.reachability === 'live'), deadline(60_000));
    const originalPeer = await call(sessions[2], 'originalPeer'), originalPeerId = String(result(originalPeer).details.messageId);
    expect(result(originalPeer).details.delivered).toBe(true);
    await sessions[1].waitEvent('message_end', event => received(event, 'original sessions peer B to A'), deadline(60_000));
    const originalPeerCopy = await waitFor('original peer send is consumed over the direct edge', () => copy(target, originalPeerId),
      row => row?.state === 'injected', deadline(60_000));
    expect(originalPeerCopy?.peer).toBe(source.id);
    expect((await sessions[1].events()).filter(event => received(event, 'original sessions peer B to A'))).toHaveLength(1);
    phase('rebind-backlog');
    const rebound = await waitFor('source-held backlog rebinds to the enrolled peer edge', () => copy(source, heldId),
      row => row?.peer === target.id, deadline(30_000));
    const heldReceived = await sessions[2].waitEvent('message_end', event => received(event, 'hub-only retained mail'), deadline(60_000));
    const heldSource = await waitFor('rebound mail receipt reaches its origin', () => copy(source, heldId),
      row => row?.state === 'injected' && row.receipt_json !== null, deadline(60_000));
    const heldTarget = copy(target, heldId, 'inbound');
    expect(heldSource?.peer).toBe(target.id);
    expect(heldTarget).toMatchObject({ state: 'injected', peer: source.id });
    expect(JSON.parse(heldSource!.endpoint_json)).toEqual(heldEndpoint);
    expect(JSON.parse(heldTarget!.endpoint_json)).toEqual(heldEndpoint);
    const auditDb = openDbReadOnly(join(source.global, 'roam', 'intercom', 'queue.db'));
    if (!auditDb) throw new Error('source queue unavailable');
    let audit: unknown, heldOrigin: unknown, drainedOrigin: unknown;
    try {
      audit = auditDb.prepare('SELECT id,transition_id,old_next_hop,new_next_hop FROM intercom_topology_audit WHERE id=?').all(heldId);
      heldOrigin = auditDb.prepare('SELECT identity_json FROM intercom_messages WHERE id=?').get(heldId);
      const targetDb = openDbReadOnly(join(target.global, 'roam', 'intercom', 'queue.db'));
      if (!targetDb) throw new Error('recipient queue unavailable');
      try { drainedOrigin = targetDb.prepare('SELECT identity_json FROM intercom_messages WHERE id=?').get(hubHeldId); }
      finally { targetDb.close(); }
    } finally { auditDb.close(); }
    expect(audit).toEqual([{ id: heldId, transition_id: beforeRestart, old_next_hop: hub.id, new_next_hop: target.id }]);
    expect(JSON.parse((heldOrigin as { identity_json: string }).identity_json).originMachineId).toBe(source.id);
    expect(JSON.parse((drainedOrigin as { identity_json: string }).identity_json).originMachineId).toBe(source.id);
    expect(copy(hub, heldId, 'inbound')).toBeNull();
    expect((await sessions[2].events()).filter(event => received(event, 'hub custody before transition'))).toHaveLength(1);
    const receipt = JSON.parse(heldSource!.receipt_json!);
    expect(receipt).toMatchObject({ messageId: heldId, status: 'injected', evidence: { kind: 'entry', sessionId: sessionIds[2] } });
    const peerAfter = await call(sessions[1], 'peerAfter'), peerAfterId = String(result(peerAfter).details.messageId);
    expect(result(peerAfter).details.delivered).toBe(true);
    await sessions[2].waitEvent('message_end', event => received(event, 'original sessions peer A to B'), deadline(60_000));
    const peerAfterCopy = await waitFor('original A to B send is consumed over the peer edge', () => copy(source, peerAfterId),
      row => row?.state === 'injected', deadline(60_000));
    expect(peerAfterCopy?.peer).toBe(target.id);
    // Already-synced sessions still communicate above while the hub is off.
    // New sessions cannot be claimed remotely until their captured origin syncs.
    phase('fresh-unsynced-sessions');
    const freshSessionIds: string[] = [];
    const originRefusal = (machine: Machine, peer: Machine) => {
      const db = openDbReadOnly(join(machine.global, 'roam', 'intercom', 'queue.db'));
      if (!db) return null;
      try { return db.prepare('SELECT reason FROM intercom_rejections WHERE peer=? AND reason=?').get(peer.id, 'presence-origin-unknown') ?? null; }
      finally { db.close(); }
    };
    expect(originRefusal(source, target)).toBeNull();
    expect(originRefusal(target, source)).toBeNull();
    for (const [index, name] of [[1, 'alpha-peer'], [2, 'beta-peer']] as const) {
      const session = await launchMachinePi(suite, network.machines[index], await suite.project(`topology-${name}`), name);
      sessions.push(session);
      freshSessionIds.push(String((await session.waitEvent('session_start', () => true, deadline(30_000))).sessionId));
      const before = Date.now(); await session.prompt(mark('ready'));
      await session.waitEvent('agent_settled', event => event.at >= before, deadline(30_000));
    }
    await waitFor('unsynced peer sessions are refused remotely with presence-origin-unknown', async () => ({
      lists: await Promise.all([source.probe.listSessions(), target.probe.listSessions()]),
      refusals: [originRefusal(source, target), originRefusal(target, source)],
    }), state => state.refusals.every(refusal => refusal !== null) &&
      !state.lists[0].some(session => session.id === freshSessionIds[1]) && !state.lists[1].some(session => session.id === freshSessionIds[0]), deadline(60_000));
    expect(originRefusal(source, target)).toEqual({ reason: 'presence-origin-unknown' });
    expect(originRefusal(target, source)).toEqual({ reason: 'presence-origin-unknown' });
    expect(await source.probe.listSessions()).not.toContainEqual(expect.objectContaining({ id: freshSessionIds[1] }));
    expect(await target.probe.listSessions()).not.toContainEqual(expect.objectContaining({ id: freshSessionIds[0] }));
    expect(hub.service.child.exitCode !== null || hub.service.child.signalCode !== null).toBe(true);
    await suite.evidence('R13-unsynced-origin-refusals.json', { ids: freshSessionIds,
      refusals: [originRefusal(source, target), originRefusal(target, source)] });
    await setLinkFault(source, []); await setLinkFault(target, []);
    await network.restartHub();
    phase('fresh-origin-sync');
    await waitFor('hub links return before fresh origin sync', () => [edge(source, hub), edge(target, hub)],
      states => states.every(state => state?.status === 'live'), deadline(60_000));
    await syncOrigins(suite, network);
    await waitFor('the same new sessions become reachable after origin sync', async () => Promise.all([source.probe.listSessions(), target.probe.listSessions()]),
      lists => lists[0].some(session => session.remote === true && session.id === freshSessionIds[1] && session.reachability === 'live') &&
        lists[1].some(session => session.remote === true && session.id === freshSessionIds[0] && session.reachability === 'live'), deadline(60_000));
    await hub.service.stop();
    await setLinkFault(source, [hub.alias]); await setLinkFault(target, [hub.alias]);
    phase('fresh-offline-messages');
    await waitFor('synced new and original sessions stay reachable with the hub off', async () => Promise.all([source.probe.listSessions(), target.probe.listSessions()]),
      lists => [sessionIds[2], freshSessionIds[1]].every(id => lists[0].some(session => session.remote === true && session.id === id && session.reachability === 'live')) &&
        [sessionIds[1], freshSessionIds[0]].every(id => lists[1].some(session => session.remote === true && session.id === id && session.reachability === 'live')), deadline(60_000));
    expect(hub.service.child.exitCode !== null || hub.service.child.signalCode !== null).toBe(true);
    const peerA = await call(sessions[3], 'peerA'); expect(result(peerA).details.delivered).toBe(true);
    await sessions[4].waitEvent('message_end', event => received(event, 'peer A to B'), deadline(60_000));
    const peerB = await call(sessions[4], 'peerB'); expect(result(peerB).details.delivered).toBe(true);
    await sessions[3].waitEvent('message_end', event => received(event, 'peer B to A'), deadline(60_000));
    for (const [session, body] of [[sessions[4], 'peer A to B'], [sessions[3], 'peer B to A']] as const)
      expect((await session.events()).filter(event => received(event, body))).toHaveLength(1);
    phase('peer-ask-reply');
    const asks: unknown[] = [];
    for (const [asker, recipient, askMarker, replyMarker, question, answer] of [
      [1, 2, 'askOriginalA', 'replyOriginalB', 'original peer question A', 'original peer answer B'],
      [2, 1, 'askOriginalB', 'replyOriginalA', 'original peer question B', 'original peer answer A'],
      [3, 4, 'askFreshA', 'replyFreshB', 'fresh peer question A', 'fresh peer answer B'],
      [4, 3, 'askFreshB', 'replyFreshA', 'fresh peer question B', 'fresh peer answer A'],
    ] as const) {
      expect(edge(target, source)).toMatchObject({ status: 'live', outbound: { poll: 0, push: 0 } });
      const askStarted = Date.now();
      await sessions[asker].prompt(mark(askMarker));
      const injected = await sessions[recipient].waitEvent('message_end', event => received(event, question), deadline(60_000));
      await sessions[recipient].waitEvent('agent_settled', event => event.at >= injected.at, deadline(30_000));
      const reply = await call(sessions[recipient], replyMarker);
      expect(result(reply).details.delivered).toBe(true);
      const answered = await sessions[asker].toolResult(askMarker, deadline(30_000));
      expect(JSON.stringify(answered.result)).toContain(answer);
      expect(result(answered).details.error).not.toBe(true);
      const elapsedMs = Date.now() - askStarted;
      expect(elapsedMs).toBeLessThan(5000);
      expect(edge(target, source)).toMatchObject({ status: 'live', outbound: { poll: 0, push: 0 } });
      asks.push({ ask: answered.result, reply: reply.result, elapsedMs, responder: edge(target, source) });
    }
    const recordedCalls = (await readFile(join(suite.root, 'hc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { namespace: string; argv: string[] });
    const reverseCalls = recordedCalls.filter(call => call.namespace === target.core.namespace && call.argv[0] === 'exec' &&
      call.argv.includes('--on') && [source.alias, source.core.coreId].includes(call.argv[call.argv.indexOf('--on') + 1]));
    expect(reverseCalls).toEqual([]);
    const sourceRoutes = await runHc(suite.cores!.wrapper, ['machine', 'ls', '--json'], source.core.env);
    const targetRoutes = await runHc(suite.cores!.wrapper, ['machine', 'ls', '--json'], target.core.env);
    const rows = (sourceRoutes.json as { machines: { name: string; id: string }[] }).machines;
    expect(rows.find(row => row.name === pair!.alias)?.id).toBe(target.core.coreId);
    expect(rows.some(row => row.name === target.alias)).toBe(false);
    expect((targetRoutes.json as { machines: { name: string }[] }).machines.some(row => row.name === source.alias)).toBe(false);
    phase('hub-return');
    const hubExit = { code: hub.service.child.exitCode, signal: hub.service.child.signalCode };
    await setLinkFault(source, []); await setLinkFault(target, []);
    await network.restartHub();
    await waitFor('hub edges reconnect in both directions', () => [edge(hub, source), edge(source, hub), edge(hub, target), edge(target, hub)],
      states => states.every(state => state?.status === 'live'), deadline(60_000));
    await waitFor('Mac and box sessions are mutually reachable after hub return', async () => Promise.all(network.machines.map(machine => machine.probe.listSessions())),
      lists => lists[0].some(session => session.remote === true && session.name === 'alpha' && session.reachability === 'live') &&
        lists[0].some(session => session.remote === true && session.name === 'beta' && session.reachability === 'live') &&
        lists[1].some(session => session.remote === true && session.name === 'coordinator' && session.reachability === 'live') &&
        lists[2].some(session => session.remote === true && session.name === 'coordinator' && session.reachability === 'live'), deadline(60_000));
    phase('final-receipts');
    const targetEntries = (await readFile(join(target.sessions, `${sessionIds[2]}.jsonl`), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const heldEntries = targetEntries.filter(entry => entry.type === 'custom_message' && entry.customType === 'intercom_message' && entry.details?.message?.id === heldId);
    expect(heldEntries).toHaveLength(1);
    expect(receipt.evidence.entryId).toBe(heldEntries[0].id);
    expect(receipt.evidence.activationEpoch).toBe(heldEndpoint.activationEpoch);
    const drainedEntries = targetEntries.filter(entry => entry.type === 'custom_message' && entry.customType === 'intercom_message' && entry.details?.message?.id === hubHeldId);
    expect(drainedEntries).toHaveLength(1);
    expect(JSON.parse(drainedSource!.receipt_json!).evidence.entryId).toBe(drainedEntries[0].id);
    expect((await sessions[2].events()).filter(event => received(event, 'hub-only retained mail'))).toHaveLength(1);
    await suite.evidence('R13-topology.json', { sessionIds, relayA: relayA.result, relayB: relayB.result, held: held.result,
      firstEnrollment, enrollment, originalPeer: originalPeer.result, originalPeerCopy, peerA: peerA.result, peerB: peerB.result, sourceRoutes: sourceRoutes.json, targetRoutes: targetRoutes.json,
      hubExit, draining, complete, audit, heldOrigin, hubHeld: hubHeld.result, hubHeldEndpoint, drainedSource, drainedEntries, drainedOrigin, heldEndpoint, asks, rebound, heldReceived, heldSource, heldTarget, receipt, peerAfter: peerAfter.result, peerAfterCopy, heldEntries, pairId: pair.pairId, connectorProcesses });
  } finally {
    phase('cleanup-evidence');
    await saveIntercomEvidence(suite, network);
    phase('cleanup-sessions');
    for (const session of sessions.reverse()) await session.close();
    phase('cleanup-network');
    await network.close();
    phase('cleanup-pair');
    await pair?.close();
    phase('closed');
  }
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('R11'), title: 'Packaged intercom actions on three isolated machines', tiers: ['headless'], run: actions },
  { id: storyId('R12'), title: 'Packaged intercom routine outages and reconciliation', tiers: ['headless'], run: outages },
  { id: storyId('R13'), title: 'Hub-only and enrolled peer topology without the hub', tiers: ['headless'], run: topology },
];
registerScenarios(scenarios);
