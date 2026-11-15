// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { isAbsolute, relative, resolve } from 'node:path';
import { pairConnectCommand } from './roam-pair-command.mjs';

const [mode, ...rest] = process.argv.slice(2), descriptorPath = rest.at(-1);
const d = JSON.parse(readFileSync(descriptorPath, 'utf8'));
const inside = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && relative(d.root, value) && !relative(d.root, value).startsWith('..');
if (![descriptorPath, d.via, d.viaDescriptor, d.viaRoute, d.localCore, d.peerCore].every(inside) || !Number.isSafeInteger(d.hostPort) || !Number.isSafeInteger(d.localPort)) throw new Error('unsafe fixture connector');
const targetSession = JSON.parse(readFileSync(d.viaDescriptor, 'utf8')).env?.HC_SESSION;
if (mode === 'check') {
  const available = path => new Promise(done => { const socket = connect(path); socket.once('connect', () => { socket.destroy(); done(true); }); socket.once('error', () => done(false)); socket.setTimeout(1000, () => { socket.destroy(); done(false); }); });
  const ready = await available(d.localCore) && await available(d.peerCore);
  process.stdout.write(JSON.stringify({ connector: 'ready', login: 'ready', tunnel: ready ? 'hosted' : 'unhosted', peerPort: ready ? 'reachable' : 'unreachable' }));
} else {
  const pairId = rest[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pairId) || !['host', 'connect'].includes(mode) ||
      (mode === 'host' ? Number(rest[1]) !== d.hostPort : Number(rest[1]) !== d.localPort || Number(rest[2]) !== d.hostPort)) throw new Error('invalid fixture connector pair');
  const connections = new Set(), children = new Set();
  const server = createServer(socket => {
    connections.add(socket); socket.once('close', () => connections.delete(socket)); socket.on('error', () => {});
    if (mode === 'connect') {
      const upstream = connect(d.hostPort, '127.0.0.1'); connections.add(upstream);
      upstream.once('close', () => connections.delete(upstream)); upstream.on('error', () => socket.destroy());
      socket.pipe(upstream); upstream.pipe(socket); return;
    }
    let header = Buffer.alloc(0);
    const begin = chunk => {
      header = Buffer.concat([header, chunk]); if (header.length > 1024 * 1024) return socket.destroy();
      const at = header.indexOf(10); if (at < 0) return;
      socket.off('data', begin);
      let request; try { request = JSON.parse(header.subarray(0, at).toString('utf8')); } catch { socket.destroy(); return; }
      const command = pairConnectCommand(request.line, targetSession, d.connectCommands);
      if (!command) return socket.destroy();
      const routeFd = openSync(d.viaRoute, 'r');
      let child;
      try { child = spawn(process.execPath, [d.via, d.viaDescriptor, command], { cwd: d.root, env: process.env,
        stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', routeFd] }); }
      finally { closeSync(routeFd); }
      children.add(child); child.once('exit', () => { children.delete(child); socket.end(); });
      child.stderr.on('data', data => process.stderr.write(data)); child.stdin.on('error', () => {});
      const remaining = header.subarray(at + 1); header = Buffer.alloc(0);
      if (remaining.length) child.stdin.write(remaining);
      socket.pipe(child.stdin); child.stdout.pipe(socket);
      socket.once('close', () => child.kill('SIGTERM'));
    };
    socket.on('data', begin);
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(mode === 'host' ? d.hostPort : d.localPort, '127.0.0.1', ok); });
  process.stdout.write('connector ready\n');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    for (const socket of connections) socket.destroy();
    for (const child of children) child.kill('SIGTERM');
    server.close();
  });
}
