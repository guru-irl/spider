// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Only the intercom clock is controlled; the packed hub, transports and broker remain production code.
import { createServer } from 'node:net';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [entry, root, socketPath] = process.argv.slice(2);
if (![entry, root, socketPath].every(value => value && isAbsolute(value) && resolve(value) === value) ||
    relative(root, socketPath).startsWith('..') || relative(root, socketPath) === '') throw new Error('unsafe fixture clock paths');
let offset = 0;
const timers = new Set();
const now = () => Date.now() + offset;
function arm(item) {
  item.timer = setTimeout(() => { timers.delete(item); item.fn(); }, Math.max(0, item.at - now()));
}
const clock = {
  now,
  later(ms, fn) {
    const item = { at: now() + Math.max(0, ms), fn, timer: null };
    timers.add(item); arm(item);
    return () => { timers.delete(item); clearTimeout(item.timer); };
  },
};
const advance = ms => {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 2 * 24 * 60 * 60_000) throw new Error('invalid clock advance');
  offset += ms;
  for (const item of timers) { clearTimeout(item.timer); arm(item); }
  return { now: now(), offset, timers: timers.size };
};
const server = createServer(socket => {
  let input = '';
  socket.on('data', chunk => {
    input += chunk.toString('utf8');
    if (input.length > 1024) return socket.destroy();
    if (!input.includes('\n')) return;
    try { socket.end(`${JSON.stringify(advance(JSON.parse(input).advanceMs))}\n`); }
    catch { socket.end('{"error":"invalid-clock-request"}\n'); }
  });
});
await new Promise((ok, fail) => { server.once('error', fail); server.listen(socketPath, ok); });
const { startProductionHub } = await import(pathToFileURL(entry).href);
const hub = await startProductionHub(root, { intercomClock: clock });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return; stopping = true;
  server.close();
  void hub.stop().then(() => { for (const item of timers) clearTimeout(item.timer); process.exitCode = 0; }, error => { console.error(error); process.exitCode = 1; });
});
