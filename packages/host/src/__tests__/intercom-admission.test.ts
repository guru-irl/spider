import { afterAll, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withPiEvents } from './fixtures/pi-events';

const scratch = resolve('.spider/scratch/i');
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, 'admission-'));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const admission = await import('../roam/admission');
const { default: spiderExtension } = await import('../extension');
const { IntercomClient } = await import('../../../intercom/src/broker/client');
let broker: ChildProcess | undefined;

afterAll(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (broker && broker.exitCode === null) { const exited = once(broker, 'exit'); broker.kill(); await exited; }
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  rmSync(root, { recursive: true, force: true });
}, 5000);

it('blocked admission gates intercom calls but never acknowledges a dropped inbound message as injected', async () => {
  vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  vi.spyOn(admission, 'createAdmissionPorts').mockReturnValue({
    expectedEpoch: null,
    knownParticipant: () => true,
    warnOnce() {}, setContext() {},
    localMachine: async () => 'local.invalid',
    lock: async () => async () => {},
    load: async () => ({ home: { sessionId: 'blocked-target', machineId: 'other.invalid', epoch: 1, moveId: null, updatedAt: 1 },
      states: [{ sessionId: 'blocked-target', epoch: 1, state: 'retired', moveId: null, freezeSeq: null }],
      origin: 'other.invalid', participating: true, captureSafe: true, unfinishedFreeze: false, initialConflict: false }),
  });
  broker = spawn(process.execPath, [resolve('dist/intercom/broker.mjs')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((ready, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture broker did not start')), 3000);
    broker!.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture broker exited ${code}`)); });
    broker!.stdout!.on('data', chunk => { if (String(chunk).includes('Intercom broker started')) { clearTimeout(timer); ready(); } });
  });
  const hooks = new Map<string, Function[]>(), sent: any[] = [];
  const pi = withPiEvents({
    on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; },
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
    getSessionName: () => 'blocked-target', sendMessage(message: unknown) { sent.push(message); },
    sendUserMessage() {}, appendEntry() {},
  });
  const ctx = { cwd: root, mode: 'tui', hasUI: true, isIdle: () => true, model: { id: 'fixture' },
    ui: { notify() {}, setStatus() {} }, abort() {},
    sessionManager: { getSessionId: () => 'blocked-target', getSessionFile: () => join(root, 'session.jsonl'), getBranch: () => [] } };
  const sender = new IntercomClient();
  try {
    spiderExtension(pi as never);
    for (const handler of hooks.get('session_start') ?? []) await handler({}, ctx);
    const gateResults = await Promise.all((hooks.get('tool_call') ?? []).map(handler => handler({ toolName: 'intercom', input: { action: 'list' } }, ctx)));
    expect(gateResults).toContainEqual(expect.objectContaining({ block: true }));
    const now = Date.now();
    await sender.connect({ cwd: root, name: 'sender', model: 'fixture', pid: process.pid, startedAt: now, lastActivity: now }, 'sender');
    await vi.waitFor(async () => expect((await sender.listSessions()).map(session => session.id)).toContain('blocked-target'), { timeout: 3000, interval: 20 });
    const receipts: string[] = [];
    sender.onMessageReceipt((_from, receipt) => { if (receipt.messageId === 'fixture-message') receipts.push(receipt.status); });
    expect((await sender.send('blocked-target', { messageId: 'fixture-message', text: 'fixture message' })).delivered).toBe(true);
    await vi.waitFor(() => expect(receipts).toContain('injected'), { timeout: 2000, interval: 20 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ customType: 'intercom_message', details: { message: { id: 'fixture-message' } } });
  } finally {
    await sender.disconnect();
    for (const handler of hooks.get('session_shutdown') ?? []) await handler({ reason: 'quit' }, ctx);
  }
}, 5000);
