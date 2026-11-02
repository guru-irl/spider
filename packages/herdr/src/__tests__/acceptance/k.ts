// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { HerdrHarness } from '../isolated.js';
import type { HcEvent, TerminalAddress, TerminalFinish, SessionFeed, RunId } from '../../contracts.js';
import { HERDR_LABELS, HERDR_KINDS, HerdrLabelContract } from '../../contracts.js';
import { projectAgentChildren, filterTopLevelAgents } from '../../../assets/agents/children.js';
import { checkThemeContrast, type PiThemeData } from '../../look/contrast.js';
import { prepareFonts } from '../../look/fonts.js';

/** Owned core/asset acceptance. Composed mod checks and real-window TUI scenes are separate gates. */
export async function acceptanceK(h: HerdrHarness): Promise<void> {
  assert(h.owner && h.localCoreId && h.remoteCoreId, 'Harness must prove both independent cores before mutation');
  assert.notEqual(h.localCoreId, h.remoteCoreId);
  if (h.mode === 'app') throw new Error('Composed five-mod, TUI and screenshot look acceptance is pending; never substitute owned-core checks');
  const owner = h.owner, jobId = randomUUID(), runId = randomUUID() as RunId, completedId = randomUUID() as RunId;
  const contract = HerdrLabelContract;
  const labels = (kind: string, key: string, child: 'job' | 'run') => ({ [HERDR_LABELS.kind]: kind, [HERDR_LABELS[child]]: key, [HERDR_LABELS.session]: owner.sessionId, [HERDR_LABELS.ownerCore]: owner.terminal.coreId, [HERDR_LABELS.ownerTerminal]: owner.terminal.terminalId });
  const stream = h.hc.events(); await stream.ready;
  const finished = new Map<TerminalAddress, TerminalFinish>(), waiters = new Map<TerminalAddress, (value: TerminalFinish) => void>();
  const unsubscribe = stream.subscribe((event: HcEvent) => {
    if (event.type !== 'finished') return;
    finished.set(event.terminal, event.data); waiters.get(event.terminal)?.(event.data);
  });
  try {
    const job = await h.hc.run({ argv: [h.nodeBinary, '-e', 'process.stdout.write("\\u001b[31merror: diagnostic failure\\u001b[0m\\n\\u001b[30mANSI 0 sample\\u001b[0m\\n"); process.exitCode = 23;'], cwd: null, on: 'remote.invalid' as never, labels: labels(HERDR_KINDS.exec, jobId, 'job'), outliveParent: true, background: true, noNotify: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<TerminalFinish>((resolve, reject) => {
      waiters.set(job.address, resolve); if (finished.has(job.address)) resolve(finished.get(job.address)!);
      timer = setTimeout(() => reject(new Error('Owned diagnostic did not finish within ten seconds')), 10000);
    });
    const snapshot = await h.hc.get(job.address);
    if (snapshot.state === 'finished' && snapshot.finishedAt !== null) waiters.get(job.address)?.({ exitCode: snapshot.exitCode, signal: snapshot.signal, reason: snapshot.reason!, finishedAt: snapshot.finishedAt });
    const result = await done.finally(() => { if (timer) clearTimeout(timer); waiters.delete(job.address); });
    assert.equal(result.exitCode, 23); assert.equal(result.reason, 'exited');
    assert.match(await h.hc.read(job.address, { lines: 20 }), /error: diagnostic failure/);
    const observer = await h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: h.root, parent: null, labels: labels(HERDR_KINDS.remoteObserver, jobId, 'job'), outliveParent: true, background: true, noNotify: true });
    const viewer = await h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: h.root, parent: owner.terminal.address, labels: labels(HERDR_KINDS.subagentViewer, runId, 'run'), outliveParent: true, background: true, noNotify: true });
    const now = Date.now();
    const feed: SessionFeed = { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: now, owner, placement: null, lifecycle: 'live', status: { native: 'working', effective: 'working', message: null },
      runs: { rows: [{ id: runId, ownerSessionId: owner.sessionId, name: 'Queued child', status: 'queued', childMode: 'print', canSteer: false, startedAt: null, finishedAt: null, viewer: viewer.address, result: null }, { id: completedId, ownerSessionId: owner.sessionId, name: 'Saved child', status: 'done', childMode: 'print', canSteer: false, startedAt: now - 1000, finishedAt: now - 500, viewer: null, result: 'saved fixture result' }], total: 2, truncated: false },
      todos: { rows: [], total: 0, truncated: false }, triggers: [], pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' }, approvals: [], notifications: [], ipc: null, errors: [] };
    const terminals = await Promise.all([job.address, observer.address, viewer.address].map(address => h.hc.get(address)));
    const rows = projectAgentChildren(terminals, [feed], owner.terminal.address, contract, { now });
    assert.deepEqual(rows.map(row => row.key), [runId, completedId]);
    assert.equal(rows.find(row => row.key === jobId), undefined);
    assert.equal(rows.find(row => row.key === runId)?.status, 'queued');
    assert.equal(rows.find(row => row.key === completedId)?.retained, true);
    assert.equal(rows.find(row => row.key === completedId)?.action, null);
    assert.deepEqual(filterTopLevelAgents([owner.terminal, { address: observer.address }, { address: viewer.address }], terminals, contract).map(row => row.address), [owner.terminal.address]);
    const theme = JSON.parse(await readFile(fileURLToPath(new URL('../../../assets/themes/dracula-plus-glass.json', import.meta.url)), 'utf8')) as PiThemeData;
    assert.deepEqual(checkThemeContrast(theme).failures, []);
    const fonts = await prepareFonts({}, { readFile, bundledRoot: fileURLToPath(new URL('../../../assets/fonts/', import.meta.url)) }); assert.equal(fonts.families.body, 'Google Sans Flex'); assert.equal(fonts.families.label, 'Glass Label'); assert.equal(fonts.families.paths, 'JetBrains Mono');
  } finally { unsubscribe(); await stream.dispose(); }
}
