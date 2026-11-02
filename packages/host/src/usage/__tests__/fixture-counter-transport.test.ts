import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { bootUsageWorker } from '../worker-entry.js';
import type { UsageWorkerEvent } from '../protocol.js';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selectFixtureCounterTransport } from '../fixture-counter-transport.js';
import { parseCounterResponse } from '../counter.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const endpoint = 'https://api.github.com/copilot_internal/user';
function fixture() {
  const scratch = resolve('.spider/scratch/e2'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'c-')); chmodSync(root, 0o700);
  const auth = join(root, 'auth.json');
  writeFileSync(auth, JSON.stringify({ 'github-copilot': { type: 'oauth', refresh: 'fixture-only-oauth', access: 'fixture-only-access', expires: 0 } }), { mode: 0o600 });
  const socket = join(root, 'c.sock');
  const env = { SPIDER_TEST_FIXTURE_CHECKOUT: process.cwd(), SPIDER_HERDR_E2E_COUNTER_SOCKET: socket };
  return { root, auth, socket, env };
}
async function listen(socket: string, callback: (request: IncomingMessage, response: ServerResponse) => void): Promise<void> {
  const server = createServer(callback); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, () => resolve()); }); chmodSync(socket, 0o600);
}
describe('fixture counter external fetch boundary', () => {
  it('returns the ordinary transport unchanged when no fixture is requested', () => {
    const ordinary = (() => { throw new Error('not called'); }) as typeof fetch;
    expect(selectFixtureCounterTransport('unused-auth', ordinary, {})).toBe(ordinary);
  });
  it('uses only the private Unix socket and keeps the production quota parser', async () => {
    const f = fixture(), requests: string[] = [];
    await listen(f.socket, (req: any, res: any) => { requests.push(`${req.method} ${req.url}`); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ quota_snapshots: { premium_interactions: { credits_used: 80, entitlement: 100, remaining: 20, token_based_billing: true } } })); });
    const transport = selectFixtureCounterTransport(f.auth, (() => { throw new Error('account API fallback'); }) as typeof fetch, f.env);
    const response = await transport(endpoint, { method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer fixture-only-oauth' } });
    expect(response.status).toBe(200);
    expect(parseCounterResponse(await response.json(), 123)).toMatchObject({ ts: 123, creditsUsed: 80, entitlement: 100, remaining: 20 });
    expect(requests).toEqual(['GET /copilot_internal/user']);
    await expect(transport('https://wrong.invalid/copilot_internal/user')).rejects.toThrow(/known counter request/);
    await expect(transport(endpoint, { method: 'POST' })).rejects.toThrow(/known counter request/);
    expect(requests).toEqual(['GET /copilot_internal/user']);
  });
  it('fails closed on malformed explicit configuration, missing fences, and nonprivate auth', async () => {
    const f = fixture(); await listen(f.socket, (_req: any, res: any) => res.end('{}'));
    const fallback = (() => { throw new Error('account API fallback'); }) as typeof fetch;
    for (const env of [{ SPIDER_HERDR_E2E_COUNTER_SOCKET: f.socket }, { ...f.env, SPIDER_HERDR_E2E_COUNTER_SOCKET: '' }, { ...f.env, SPIDER_HERDR_E2E_COUNTER_SOCKET: join(f.root, 'missing.sock') }]) {
      expect(() => selectFixtureCounterTransport(f.auth, fallback, env)).toThrow(/fixture-counter-config/);
    }
    chmodSync(f.auth, 0o644); expect(() => selectFixtureCounterTransport(f.auth, fallback, f.env)).toThrow(/private auth/);
  });
  it('rejects symlinks and a credential file from another fixture domain', async () => {
    const f = fixture(), other = fixture(); await listen(f.socket, (_req: any, res: any) => res.end('{}'));
    const link = join(f.root, 'auth-link.json'); symlinkSync(f.auth, link);
    expect(() => selectFixtureCounterTransport(link, fetch, f.env)).toThrow(/symlink/);
    expect(() => selectFixtureCounterTransport(other.auth, fetch, f.env)).toThrow(/same fixture domain/);
    const socketLink = join(f.root, 'link.sock'); symlinkSync(f.socket, socketLink);
    expect(() => selectFixtureCounterTransport(f.auth, fetch, { ...f.env, SPIDER_HERDR_E2E_COUNTER_SOCKET: socketLink })).toThrow(/symlink/);
  });
  it('boots the actual worker poller through the fenced transport and publishes its real parsed counter', async () => {
    const f = fixture(); await listen(f.socket, (_req: any, res: any) => res.end(JSON.stringify({ quota_snapshots: { premium_interactions: { credits_used: 80, entitlement: 100, remaining: 20, token_based_billing: true } } })));
    vi.stubEnv('SPIDER_TEST_FIXTURE_CHECKOUT', process.cwd()); vi.stubEnv('SPIDER_HERDR_E2E_COUNTER_SOCKET', f.socket);
    const channel = new MessageChannel();
    const observation = new Promise<UsageWorkerEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('real worker counter observation deadline')), 10000);
      channel.port2.on('message', (event: UsageWorkerEvent) => {
        if (event.type === 'snapshot' && event.counter.latest?.creditsUsed === 80) { clearTimeout(timer); resolve(event); }
        else if (event.type === 'snapshot' && event.counter.errorCode === 'network') { clearTimeout(timer); reject(new Error('worker used account API fallback instead of fixture transport')); }
      });
    });
    const assertion = expect(observation).resolves.toMatchObject({ type: 'snapshot', counter: { availability: 'available', latest: { creditsUsed: 80, raw: {} } } });
    try {
      await bootUsageWorker(channel.port1, { type: 'start', owner: `${process.pid}:fixture-counter`, child: false, poll: true,
        roots: { registryDb: join(f.root, 'missing-registry.db'), sessionsDir: join(f.root, 'sessions'), ledgerFile: join(f.root, 'usage.db'), authPath: f.auth, leaseDir: join(f.root, 'leases') } },
        { fetch: (() => { throw new Error('account API fallback'); }) as typeof fetch });
      await assertion;
    } finally {
      const stopped = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('worker stop deadline')), 5000); channel.port2.on('message', (e: UsageWorkerEvent) => { if (e.type === 'stopped') { clearTimeout(timer); resolve(); } }); });
      channel.port2.postMessage({ type: 'stop' }); await stopped; channel.port1.close(); channel.port2.close();
    }
  });
  it('honors abort before connection and while the real socket request is held', async () => {
    const f = fixture(); let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
    await listen(f.socket, () => { ready(); });
    const transport = selectFixtureCounterTransport(f.auth, fetch, f.env);
    await expect(transport(endpoint, { signal: AbortSignal.abort() })).rejects.toThrow();
    const controller = new AbortController(), pending = transport(endpoint, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow(); await started; controller.abort(); await rejected;
  });
});
