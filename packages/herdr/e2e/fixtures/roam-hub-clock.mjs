// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Only the injected clock is controlled; services, transports and brokers remain production code.
import { createServer } from 'node:net';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createFixtureClock(initialOffset = 0) {
  let offset = initialOffset;
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
  return {
    clock,
    advance(ms) {
      if (!Number.isSafeInteger(ms) || ms < 0 || ms > 2 * 24 * 60 * 60_000) throw new Error('invalid clock advance');
      offset += ms;
      for (const item of timers) { clearTimeout(item.timer); arm(item); }
      return { now: now(), offset, timers: timers.size };
    },
    close() { for (const item of timers) clearTimeout(item.timer); timers.clear(); },
  };
}

export async function serveFixtureClock(socketPath) {
  const controlled = createFixtureClock(Number(process.env.SPIDER_E2E_INTERCOM_CLOCK_OFFSET ?? 0));
  const server = createServer(socket => {
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString('utf8');
      if (input.length > 1024) return socket.destroy();
      if (!input.includes('\n')) return;
      try { socket.end(`${JSON.stringify(controlled.advance(JSON.parse(input).advanceMs))}\n`); }
      catch { socket.end('{"error":"invalid-clock-request"}\n'); }
    });
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(socketPath, ok); });
  let accepting = true;
  const stopAccepting = () => { if (!accepting) return; accepting = false; server.close(); };
  return { clock: controlled.clock, stopAccepting, close() { stopAccepting(); controlled.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [entry, root, socketPath] = process.argv.slice(2);
  if (![entry, root, socketPath].every(value => value && isAbsolute(value) && resolve(value) === value) ||
      relative(root, socketPath).startsWith('..') || relative(root, socketPath) === '') throw new Error('unsafe fixture clock paths');
  const controlled = await serveFixtureClock(socketPath);
  const { startProductionHub } = await import(pathToFileURL(entry).href);
  const hub = await startProductionHub(root, { intercomClock: controlled.clock });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return; stopping = true;
    controlled.stopAccepting();
    void hub.stop().then(() => { controlled.close(); process.exitCode = 0; }, error => { controlled.close(); console.error(error); process.exitCode = 1; });
  });
}
