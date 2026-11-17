// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

export function pairPorts(path) {
  const d = JSON.parse(readFileSync(path, 'utf8'));
  const inside = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && relative(d.root, value) && !relative(d.root, value).startsWith('..');
  if (realpathSync(d.root) !== d.root || ![path, d.global, d.home, d.socket, d.stateFile, d.systemctl, d.ssh, d.keyscan, d.systemSsh, d.hc].every(inside)) throw new Error('unsafe fixture pair ports');
  const request = argv => new Promise((ok, fail) => {
    const socket = createConnection(d.socket); let response = '';
    socket.on('connect', () => socket.write(`${JSON.stringify({ argv })}\n`));
    socket.on('data', chunk => { response += chunk.toString('utf8'); }); socket.on('error', fail);
    socket.on('end', () => { try { ok(JSON.parse(response)); } catch (error) { fail(error); } });
  });
  const state = () => JSON.parse(readFileSync(d.stateFile, 'utf8'));
  const processInfo = pid => {
    if (!Object.values(state()).some(unit => unit.pid === pid)) return { kind: 'unknown' };
    try {
      const output = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat=,lstart='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } }).trim();
      return !output || output.startsWith('Z') ? { kind: 'absent' } : { kind: 'live', startIdentity: output.replace(/^\S+\s+/, '') };
    } catch { return { kind: 'absent' }; }
  };
  const run = async (argv, options) => {
    if (!Array.isArray(argv) || !argv.length || !Number.isSafeInteger(options.timeoutMs) || !Number.isSafeInteger(options.maxBytes)) throw new Error('invalid fixture process request');
    if (argv[0] === d.systemctl) return request(argv.slice(1));
    if (![d.node, d.hc, d.keyscan, '/usr/bin/ssh-keygen'].includes(argv[0])) throw new Error('unowned fixture command');
    return await new Promise((ok, fail) => {
      const child = spawn(argv[0], argv.slice(1), { env: { ...process.env, ...d.env }, cwd: d.root, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', bytes = 0, finished = false;
      const timer = setTimeout(() => { child.kill('SIGTERM'); fail(new Error('fixture process timeout')); }, options.timeoutMs); timer.unref();
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > options.maxBytes) { child.kill('SIGTERM'); fail(new Error('fixture output limit')); } else stdout += chunk.toString('utf8'); });
      child.stderr.resume(); child.once('error', error => { clearTimeout(timer); if (!finished) { finished = true; fail(error); } });
      child.once('close', code => { clearTimeout(timer); if (!finished) { finished = true; ok({ code: code ?? 1, stdout }); } });
    });
  };
  // The files remain fixture-owned; only their uid is simulated as root.
  const openFiles = new Set();
  const systemSshFiles = {
    lstat(value) { if (value !== '/etc/ssh') throw new Error('unowned system SSH directory'); const stat = lstatSync(d.systemSsh); stat.uid = 0; return stat; },
    open(value, flags) {
      if (!/^\/etc\/ssh\/ssh_host_(ed25519|ecdsa|rsa)_key\.pub$/.test(value) || flags !== (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)) throw new Error('unowned system SSH file');
      const fd = openSync(join(d.systemSsh, basename(value)), flags); openFiles.add(fd); return fd;
    },
    fstat(fd) { if (!openFiles.has(fd)) throw new Error('unowned system SSH descriptor'); const stat = fstatSync(fd); stat.uid = 0; return stat; },
    read(fd) { if (!openFiles.has(fd)) throw new Error('unowned system SSH descriptor'); return readFileSync(fd, 'utf8'); },
    close(fd) { if (!openFiles.delete(fd)) throw new Error('unowned system SSH descriptor'); closeSync(fd); },
  };
  const config = JSON.parse(readFileSync(`${d.global}/roam/config.json`, 'utf8'));
  return { machineId: d.machineId, root: d.global, home: d.home, node: d.node, ssh: d.ssh, keygen: '/usr/bin/ssh-keygen',
    keyscan: d.keyscan, systemSshFiles, sshUser: 'fixture', systemctl: d.systemctl, recipe: config.intercom.connector, run,
    process: processInfo,
    cgroup(group) {
      const entries = Object.values(state()).filter(unit => unit.group === group);
      if (entries.length !== 1) throw new Error('fixture cgroup unavailable');
      return entries[0].pid && processInfo(entries[0].pid).kind === 'live' ? [entries[0].pid] : [];
    },
  };
}
