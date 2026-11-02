// SPDX-License-Identifier: MIT
import { createServer, type Socket } from 'node:net';
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { appendRunEvent, openDb } from '@spider/db-core';
import { directSpawner } from './spawn-direct';
import { RunStore } from './run-store';
import { decideOutcome } from './completion-output';
import { emitStatus } from './run-events';
import { attachRpcReader, PERSISTED_EVENT_TYPES } from './rpc-child';
import { recordRunUsage } from './usage';
import type { ChildSpawnSpec } from './pi-args';
import type { SupervisorState } from './durable-child';
import { processStartTime } from './process-identity';
import { HERDR_NOTICES } from '@spider/herdr/notices';

// This file is a separate executable. Importing the extension never starts it.
const requestFile = process.argv[2];
if (!requestFile) throw new Error('A subagent supervisor request file is required.');
const spec = JSON.parse(readFileSync(requestFile, 'utf8')) as ChildSpawnSpec;
const launch = spec.supervisor! as NonNullable<ChildSpawnSpec['supervisor']> & { token: string };
const { directory, dbPath, runId, sessionId, token } = launch;
const atomic = (name: string, value: unknown) => {
  const file = join(directory, name); writeFileSync(file + '.next', JSON.stringify(value), { mode: 0o600 }); renameSync(file + '.next', file);
};
atomic('starting.json', { version: 1, supervisorPid: process.pid, supervisorStartTime: processStartTime(process.pid), startedAt: Date.now() });
process.on('SIGHUP', () => { /* no controlling terminal owns this run */ });
let stop: () => void = () => { process.exit(1); };
process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop());
const launcherPid = Number(process.argv[3]), reparentDeadline = Date.now() + 5000;
while (Number.isSafeInteger(launcherPid) && launcherPid > 0 && process.platform !== 'win32' && process.ppid === launcherPid) {
  if (Date.now() >= reparentDeadline) throw new Error('Subagent supervisor launcher did not release its child.');
  await delay(10);
}
const unixSocket = join(directory, 's');
const socketPath: SupervisorState['socket'] = process.platform === 'win32' ? `\\\\.\\pipe\\spider-${token.slice(0, 24)}`
  : Buffer.byteLength(unixSocket) <= 103 ? unixSocket : { host: '127.0.0.1', port: 0 };
const db = openDb(dbPath, { fileMustExist: true });
const store = new RunStore(db);
const clients = new Set<Socket>(), connections = new Set<Socket>();
let owner: Socket | undefined, stopping = false, finished = false;
const state: SupervisorState = { ...launch, version: 1, socket: socketPath, supervisorPid: process.pid, supervisorStartTime: processStartTime(process.pid), ownerPid: null, herdrTerminal: process.env.HC_TERMINAL_ID };
const prior = store.get(runId);
if (!prior || !['queued', 'running', 'paused'].includes(prior.status)) {
  const saved = { exitCode: prior?.status === 'done' ? 0 : prior?.status === 'cancelled' ? 130 : 1,
    result: prior?.result ?? (prior ? undefined : 'Run no longer exists.') };
  atomic('exit.json', saved); unlinkSync(requestFile); db.close();
  process.exit(saved.exitCode);
}
const saveState = () => atomic('state.json', state);
const send = (client: Socket, value: unknown) => {
  if (client.destroyed || !client.writable) return;
  // Slow or disappeared parents cannot stall the child. Transcripts and persisted events
  // are read from disk on resume, not replayed through an unbounded socket buffer.
  if (client.writableLength > 1024 * 1024) { client.destroy(); return; }
  client.write(JSON.stringify(value) + '\n');
};
const persist = (event: Record<string, any>) => {
  if (!PERSISTED_EVENT_TYPES.includes(event.type)) return;
  if (event.type === 'spider_usage') recordRunUsage(db, runId, { provider: event.provider, model: event.model, usage: event.usage }, event.purpose, event.compactionCount);
  else appendRunEvent(db, { runId, sessionId, ts: Date.now(), type: event.type,
    summary: event.message ?? event.error ?? (event.type === 'spider_compaction' ? 'Child compacted.' : 'Child pending queue changed.'), payload: event });
};
let persistenceError: unknown;
const childEnv: Record<string, string> = { ...spec.env, TMPDIR: directory };
for (const key of ['HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE']) {
  if (process.env[key]) childEnv[key] = process.env[key]!;
  else delete childEnv[key];
}
const child = directSpawner({ ...spec, env: childEnv, supervisor: undefined, onRpcEvent(event) {
  try { persist(event); } catch (error) { persistenceError = error; console.error('Could not persist child event', error); }
  for (const client of clients) send(client, { type: 'event', event: { ...event, spiderDurablePersisted: true } });
} });
state.childPid = child.pid; state.childStartTime = child.startTime;
if (child.pid !== undefined) store.setPid(runId, child.pid, process.pid, child.startTime);
appendRunEvent(db, { runId, sessionId, ts: Date.now(), type: 'child_supervisor', payload: { version: 1, directory } });
const server = createServer(client => {
  connections.add(client);
  let authenticated = false;
  client.on('error', () => {});
  client.on('close', () => {
    clients.delete(client); connections.delete(client);
    if (owner === client) { owner = undefined; state.ownerPid = null; try { saveState(); } catch {} }
  });
  attachRpcReader(client, message => {
    if (message.token !== token) { client.destroy(); return; }
    if (message.op === 'attach') {
      if (owner && owner !== client && !owner.destroyed) {
        send(client, { type: 'unavailable', reason: 'Another live parent owns this subagent. Reconnect after that parent releases it.' }); client.end(); return;
      }
      authenticated = true; owner = client; clients.add(client);
      state.ownerPid = Number.isInteger(message.ownerPid) ? message.ownerPid : null; saveState();
      send(client, { type: 'attached', childPid: child.pid }); return;
    }
    if (!authenticated || client !== owner || typeof message.id !== 'string') { client.destroy(); return; }
    const reply = (value: unknown) => send(client, { type: 'reply', id: message.id, value });
    if (message.op === 'steer' && typeof message.message === 'string') {
      const row = store.get(runId);
      if (stopping || finished || !row || !['queued', 'running', 'paused'].includes(row.status)) return reply({ accepted: false, delivery: 'refused', error: 'Run has finished or was explicitly stopped.' });
      if (!child.steer) return reply({ accepted: false, delivery: 'refused', error: 'Print children cannot be steered.' });
      void child.steer(message.message).then(reply, error => reply({ accepted: false, error: String(error) }));
    } else if (message.op === 'stop') {
      stopping = true;
      // Persist the tombstone before sending anything. A racing reconnect cannot restart it.
      store.cancel(runId, typeof message.reason === 'string' ? message.reason : 'Explicit stop');
      void (child.killAsync?.(Math.min(5000, Math.max(1, Number(message.graceMs) || 250))) ?? Promise.resolve(child.kill())).then(() => reply({ stopped: true }), error => reply({ error: String(error) }));
    } else reply({ error: 'Unknown supervisor operation.' });
  }, () => client.destroy());
});
server.on('error', error => { console.error(error); store.finish(runId, { status: 'failed', result: `Subagent supervisor failed. ${String(error)}` }); void child.killAsync?.(); });
server.listen(typeof socketPath === 'string' ? { path: socketPath } : socketPath, () => {
  if (typeof socketPath === 'string') { if (process.platform !== 'win32') chmodSync(socketPath, 0o600); }
  else {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Supervisor loopback address is unavailable.');
    state.socket = { host: '127.0.0.1', port: address.port };
  }
  saveState(); unlinkSync(requestFile);
});
stop = () => {
  if (stopping) return;
  stopping = true;
  const result = HERDR_NOTICES.supervisorSignalled.text;
  if (store.finish(runId, { status: 'failed', result })) emitStatus(db, { runId, sessionId, status: 'failed', summary: result });
  child.kill();
};
const exit = await child.wait();
finished = true;
const outcome = decideOutcome(db, runId, exit.exitCode, exit.result);
if (persistenceError) { outcome.status = 'failed'; outcome.result = `Child event persistence failed. ${String(persistenceError)}`; }
db.transaction(() => {
  if (store.finish(runId, outcome)) emitStatus(db, { runId, sessionId, status: outcome.status });
})();
// A child reporter or an explicit stop may already have finalized the row.
const final = store.get(runId)!;
const saved = { exitCode: final.status === 'done' ? 0 : final.status === 'cancelled' ? 130 : exit.exitCode || 1, result: final.result ?? undefined };
atomic('exit.json', saved);
for (const client of connections) {
  if (!clients.has(client)) { client.destroy(); continue; }
  send(client, { type: 'exit', exit: saved }); client.end();
  // The saved receipt is authoritative if a slow owner cannot drain its socket.
  const deadline = setTimeout(() => client.destroy(), 250); deadline.unref();
  client.once('close', () => clearTimeout(deadline));
}
await new Promise<void>(resolve => server.close(() => resolve()));
try { if (process.platform !== 'win32' && typeof socketPath === 'string') unlinkSync(socketPath); } catch {}
db.close();
