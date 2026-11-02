// SPDX-License-Identifier: MIT
import { startSessionEndpoint } from '../feed/ipc-server.js';
import type { Owner, RunCursor, RunId, RunSummary, RunViewFrame } from '../contracts.js';

const { owner, root, runId, tailCursor } = JSON.parse(process.env.HERDR_FX5_VIEWER_OWNER!) as { owner: Owner; root: string; runId: RunId; tailCursor: RunCursor };
const run: RunSummary = { id: runId, ownerSessionId: owner.sessionId, name: null, status: 'running', childMode: 'rpc', canSteer: true, startedAt: 1, finishedAt: null, result: null, viewer: null };
let tail = '';
const emitters = new Set<(frame: RunViewFrame) => void>();
const endpoint = await startSessionEndpoint(owner, {
  currentOwner: () => owner, liveCapabilities: () => ({ native: 'working', effective: 'working' }), ownsRun: id => id === runId,
  subscribeRun: (_id, cursor, emit) => {
    process.send?.({ type: 'attached', cursor, sessionId: owner.sessionId });
    emit({ runId, cursor: cursor ?? 'initial' as RunCursor, kind: 'snapshot', data: { run } });
    if (tail && cursor !== tailCursor) emit({ runId, cursor: tailCursor, kind: 'event', data: { text: tail, events: [] } });
    emitters.add(emit); return { dispose() { emitters.delete(emit); } };
  },
  steerRun: (_id, text) => { process.send?.({ type: 'unexpected-steer', text }); return { delivery: 'refused', accepted: false, delivered: false, queued: false }; },
  openRun: () => null, openView() {}, ownsJob: () => false, openJob: () => null,
}, root);
process.on('message', async (message: { type: 'tail' | 'finish' | 'stop'; text?: string }) => {
  if (message.type === 'tail') { tail = message.text!; for (const emit of emitters) emit({ runId, cursor: tailCursor, kind: 'event', data: { text: tail, events: [] } }); }
  if (message.type === 'finish') for (const emit of emitters) emit({ runId, cursor: tailCursor, kind: 'end', data: { reason: 'finished' } });
  if (message.type === 'stop') { await endpoint.dispose(); process.disconnect(); }
});
process.send?.({ type: 'ready', descriptor: endpoint.descriptor, pid: process.pid });
