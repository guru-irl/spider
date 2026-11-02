// SPDX-License-Identifier: MIT
import { startSessionEndpoint } from '../feed/ipc-server.js';
import { publishSessionFeed } from '../feed/publisher.js';
import type { AppClient, HcClient, Owner, OwnerPlacement, RunCursor, RunId, RunSummary, RunViewFrame, SessionFeed, TerminalAddress } from '../contracts.js';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import { HerdrError } from '../client/parse.js';
import { runViewer } from '../viewers/program.js';
import { createSessionIpcClient } from '../feed/ipc-client.js';
import { submitViewerSteer } from '../viewers/steering.js';

const { owner, root, runId } = JSON.parse(process.env.HERDR_VIEWER_OWNER!) as { owner: Owner; root: string; runId: RunId };
if (process.env.HERDR_VIEWER_MODE === 'viewer') {
  const abort = new AbortController();
  process.once('SIGTERM', () => abort.abort());
  const clients: ReturnType<typeof createSessionIpcClient>[] = [];
  try {
    await runViewer({ runId, sessionId: owner.sessionId, feedRoot: root, stdin: process.stdin, stdout: process.stdout, signal: abort.signal,
      createClient: descriptor => { const client = createSessionIpcClient(descriptor); clients.push(client); return client; },
      submitSteer: (client, text) => submitViewerSteer(client, runId, text) });
  } finally { for (const client of clients) client.dispose(); }
  process.exit(0);
}
const run: RunSummary = { id: runId, ownerSessionId: owner.sessionId, name: null, status: 'running', childMode: 'rpc', canSteer: true, startedAt: 1, finishedAt: null, result: null, viewer: null };
const history = ['BEFORE_SUSPEND\n'];
const emitters = new Set<(frame: RunViewFrame) => void>();
let steers = 0, revision = 0;
const endpoint = await startSessionEndpoint(owner, {
  currentOwner: () => owner, liveCapabilities: () => ({ native: 'working', effective: 'working' }), ownsRun: id => id === runId,
  subscribeRun: (_id, cursor, emit) => {
    process.send?.({ type: 'attached', cursor });
    emit({ runId, cursor: cursor ?? '0' as RunCursor, kind: 'snapshot', data: { run } });
    for (let i = Number(cursor ?? 0); i < history.length; i++) emit({ runId, cursor: String(i + 1) as RunCursor, kind: 'event', data: { text: history[i], events: [] } });
    emitters.add(emit); return { dispose() { emitters.delete(emit); } };
  },
  steerRun: (_id, text) => {
    process.send?.({ type: 'steer', text, count: ++steers });
    return { delivery: 'delivered', accepted: true, delivered: true, queued: false };
  },
  openRun: () => null, openView() {}, ownsJob: () => false, openJob: () => null,
}, root);
const publish = () => publishSessionFeed(root, {
  version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: ++revision, updatedAt: Date.now(), owner,
  lifecycle: 'live', placement: null, status: { native: 'working', effective: 'working', message: null },
  runs: { rows: [run], total: 1, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
  pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' },
  approvals: [], notifications: [], errors: [], ipc: { address: endpoint.descriptor.address, capabilityFile: endpoint.descriptor.capabilityFile },
} satisfies SessionFeed);
await publish();
const heartbeat = setInterval(() => { void publish(); }, 1000);
let panes: ReturnType<typeof createAuxiliaryPanes> | undefined;
process.on('message', async (message: { type: 'output' | 'finish' | 'stop' | 'place'; viewerPid?: number }) => {
  if (message.type === 'place') {
    const viewer = 'viewer' as TerminalAddress, placement = { space: 'space', tab: 'tab', pane: 'pane' } as OwnerPlacement;
    const app: AppClient = {
      ownerPlacement: async address => { if (address === viewer) throw new HerdrError('owner-unplaced', 'Viewer is parked'); return placement; },
      awaitPane: async () => {
        process.send?.({ type: 'placement-pending' });
        await new Promise(resolve => setTimeout(resolve, 10000));
        throw new HerdrError('pane-timeout', 'Pane was not acknowledged');
      },
      command: async () => ({}),
    };
    const hc = {
      events: () => ({ ready: Promise.resolve(), subscribe: () => () => {}, dispose() {} }),
      get: async () => ({ address: viewer, state: 'live', labels: { 'spider.kind': 'subagent-viewer' } }),
      setLabels: async () => {},
      kill: async () => { process.kill(message.viewerPid!, 'SIGTERM'); }, rm: async () => {},
    } as unknown as HcClient;
    panes = createAuxiliaryPanes({ hc, discardSubagentViewer: async (_id, _owner, viewer) => { await hc.kill(viewer); await hc.rm(viewer); }, app, subagentViewer: async () => viewer, clock: Date.now });
    void panes.acquire('subagent', runId, owner, { timeoutMs: 10000, automatic: true }).catch(error => process.send?.({ type: 'placement-failed', code: error.code }));
  }
  if (message.type === 'output') {
    history.push('UNKNOWN_STEER_APPLIED\n');
    for (const emit of emitters) emit({ runId, cursor: String(history.length) as RunCursor, kind: 'event', data: { text: history.at(-1)!, events: [] } });
  }
  if (message.type === 'finish') for (const emit of emitters) emit({ runId, cursor: String(history.length) as RunCursor, kind: 'end', data: { reason: 'finished' } });
  if (message.type === 'stop') { clearInterval(heartbeat); await panes?.dispose(); await endpoint.dispose(); process.disconnect(); }
});
process.send?.({ type: 'ready', descriptor: endpoint.descriptor });
