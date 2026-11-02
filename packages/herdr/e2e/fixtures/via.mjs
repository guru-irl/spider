#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Local `hc machine add --via` transport: runs the shell line it is given under the destination's
// isolated namespace, never over ssh. Usage: via.mjs <descriptor.json> <shell line>
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';

const descriptorPath = process.argv[2];
const line = process.argv.at(-1);
if (!descriptorPath || process.argv.length < 4) { process.stderr.write('via: usage via.mjs <descriptor> <line>\n'); process.exit(96); }
const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
const env = { ...descriptor.env };
const within = path => typeof path === 'string' && path.startsWith(descriptor.root + '/');
if (!within(env.XDG_STATE_HOME) || !within(env.XDG_CONFIG_HOME) || !within(env.HOME) || !within(env.TMPDIR) || !within(descriptor.log) || !within(descriptor.socket) || descriptor.viaDirectory !== join(descriptor.root, 'via-processes') || !env.HC_SESSION || typeof descriptor.ledgerPath !== 'string') {
  process.stderr.write('via: unfenced destination descriptor\n'); process.exit(95);
}
const processStart = pid => {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'stat=,lstart='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } }).trim();
    return !out || out.startsWith('Z') ? null : out.replace(/^\S+\s+/, '');
  } catch { return null; }
};
const start = processStart(process.pid);
if (!start) { process.stderr.write('via: process identity unavailable\n'); process.exit(95); }
mkdirSync(descriptor.viaDirectory, { recursive: true, mode: 0o700 });
const registration = join(descriptor.viaDirectory, `${process.pid}.json`);
const register = record => {
  const temporary = `${registration}.${process.pid}.new`;
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 }); renameSync(temporary, registration);
};
register({ pid: process.pid, start });
process.once('exit', () => { try { unlinkSync(registration); } catch { /* already removed */ } });
const allowed = () => {
  try {
    const ledger = JSON.parse(readFileSync(descriptor.ledgerPath, 'utf8'));
    return ledger.root === descriptor.root && ledger.state === 'open' && ledger.tearingDown !== true && ledger.viaDirectory === descriptor.viaDirectory
      && Array.isArray(ledger.cores) && ledger.cores.some(core => core.side !== 'local' && core.socket === descriptor.socket);
  } catch { return false; }
};
const listening = () => new Promise(resolve => {
  const socket = connect(descriptor.socket);
  const done = value => { socket.destroy(); resolve(value); };
  socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(1000, () => done(false));
});
if (!allowed() || !await listening() || !allowed()) {
  appendFileSync(descriptor.log, JSON.stringify({ at: Date.now(), pid: process.pid, line, outcome: 'refused' }) + '\n');
  process.stderr.write('via: destination unavailable or suite is tearing down\n'); process.exit(94);
}
appendFileSync(descriptor.log, JSON.stringify({ at: Date.now(), pid: process.pid, line }) + '\n');
const child = spawn('/bin/sh', ['-c', line], { env, cwd: env.HOME, stdio: 'inherit' });
const childStart = child.pid ? processStart(child.pid) : null;
if (child.pid && childStart) register({ pid: process.pid, start, child: { pid: child.pid, start: childStart } });
appendFileSync(descriptor.log, JSON.stringify({ at: Date.now(), pid: process.pid, childPid: child.pid }) + '\n');
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.once('exit', (code, signal) => { if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } else process.exit(code ?? 1); });
