#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Guardian: <ledger.json> <lease.json> [--remove-root]. Ready is emitted before bootstrap;
// --remove-root keeps stdout open and streams the final proof after deleting the owned root.
// --supervise <config.json> renews over SSH while the owner pipe and ledger remain live.
// --transport <config.json> <ssh argv...> is hc's real-SSH boundary, never a --via transport.
import { readFileSync, writeFileSync, renameSync, existsSync, watch, lstatSync, realpathSync, rmSync, readdirSync, appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function processStart(pid) {
  try {
    if (process.platform === 'linux') { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); const f = stat.slice(stat.lastIndexOf(')') + 2).split(' '); return f[0] === 'Z' ? null : `linux:${f[19]}`; }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'stat=,lstart='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } }).trim();
    return !out || out.startsWith('Z') ? null : out.replace(/^\S+\s+/, '');
  } catch { return null; }
}
const alive = p => {
  if (process.platform !== 'linux' || p.start.startsWith('linux:')) return processStart(p.pid) === p.start;
  // The local resources ledger uses ps lstart on every host; remote core records use /proc start ticks.
  const r = bounded('/bin/ps', ['-p', String(p.pid), '-o', 'stat=,lstart='], { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' });
  const out = r.stdout?.trim();
  return r.status === 0 && out && !out.startsWith('Z') && out.replace(/^\S+\s+/, '') === p.start;
};
export const listening = path => !existsSync(path) ? Promise.resolve(false) : new Promise(resolve => {
  const s = connect(path); const done = v => { s.destroy(); resolve(v); };
  s.once('connect', () => done(true)); s.once('error', () => done(false)); s.setTimeout(2000, () => done(false));
});
const settle = async (check, ms) => { const end = Date.now() + ms; for (;;) { if (await check()) return true; if (Date.now() >= end) return false; await new Promise(r => setTimeout(r, 50)); } };
function writeAtomic(path, value) { const t = `${path}.${process.pid}.new`; writeFileSync(t, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(t, path); }
const bounded = (binary, argv, env, seconds = 15) => spawnSync('/usr/bin/perl', ['-e', 'alarm shift; exec @ARGV', String(seconds), binary, ...argv], { env, encoding: 'utf8', timeout: (seconds + 2) * 1000 });
const within = (root, path) => { const r = relative(root, path); return r !== '' && r !== '..' && !r.startsWith('../') && !isAbsolute(r); };

function validateLedger(ledger, leasePath) {
  const fail = () => { throw new Error('unsafe-remote-ledger: root, namespace or socket is not owned'); };
  const root = ledger.root;
  const fencedPath = path => {
    if (typeof path !== 'string' || resolve(path) !== path || !within(root, path)) fail();
    let part = root;
    for (const component of relative(root, path).split('/')) {
      part += '/' + component;
      try { if (lstatSync(part).isSymbolicLink()) fail(); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
  };
  if (ledger.version !== 1 || typeof root !== 'string' || resolve(root) !== root || !Array.isArray(ledger.cores) || !Array.isArray(ledger.processes)) fail();
  if (!/\/spider-herdr-e2e-[a-f0-9]{8}$/.test(root) && !/\/\.spider\/scratch\/e2\/[a-z0-9]{5}$/.test(root)) fail();
  const s = lstatSync(root);
  if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(root) !== root || s.uid !== process.getuid() || (s.mode & 0o077) !== 0) fail();
  if (!within(root, leasePath) || lstatSync(leasePath).isSymbolicLink()) fail();
  for (const core of ledger.cores) {
    if (!core.namespace || core.namespace === 'default' || !within(root, core.socket) || core.env?.HC_SESSION !== core.namespace) fail();
    fencedPath(core.socket);
    for (const path of [core.socket, core.socket.replace(/\.sock$/, '.holder.4294967295.sock')]) if (Buffer.byteLength(path) > 103) fail();
    if (['HC_SOCKET', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE'].some(key => core.env[key] !== undefined)) fail();
    for (const key of ['HOME', 'TMPDIR', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', ...(core.env.XDG_RUNTIME_DIR === undefined ? [] : ['XDG_RUNTIME_DIR'])]) {
      fencedPath(core.env[key]);
    }
  }
}

export async function defaultInventory(core) {
  if (!core) return null;
  // Never query hc in the default namespace, even for an apparently read-only inventory.
  const directory = (core.env.XDG_STATE_HOME || core.env.HOME + '/.local/state') + '/herdr-core/default';
  const read = name => {
    const path = directory + '/' + name;
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('default-inventory-symlink');
      return { present: true, value: JSON.parse(readFileSync(path, 'utf8')) };
    } catch (error) { if (error.code === 'ENOENT') return { present: false }; throw error; }
  };
  const machines = read('machines.json'), saved = read('terminals.json');
  const active = await listening(core.socket);
  if (!saved.present) {
    if (active || core.wasListening) throw new Error('default-inventory-unavailable: persisted terminals are missing');
    return { listening: active, terminals: [], machines };
  }
  const value = saved.value?.terminals;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('default-inventory-malformed');
  return { listening: active, terminals: Object.keys(value).sort().map(id => ({ id })), machines };
}

// An observed root process is never signalled by name. Unregistered survivors fail the proof.
export function rootProcesses(root, exclude = []) {
  if (process.platform !== 'linux') return [];
  const out = [];
  for (const name of readdirSync('/proc')) {
    const pid = Number(name); if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || exclude.includes(pid) || !processStart(pid)) continue;
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
      let cwd = ''; try { cwd = realpathSync(`/proc/${pid}/cwd`); } catch { /* process exited */ }
      if (command.includes(root + '/') || cwd === root || cwd.startsWith(root + '/')) out.push({ pid, start: processStart(pid), command });
    } catch { /* another user or exited */ }
  }
  return out;
}

async function guardian(ledgerPath, leasePath, removeRoot) {
  let ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  validateLedger(ledger, leasePath);
  const root = ledger.root;
  const leaseExpiry = () => { try { const l = JSON.parse(readFileSync(leasePath, 'utf8')); return l.version === 1 && Number.isFinite(l.expiresAt) ? l.expiresAt : 0; } catch { return 0; } };
  async function cleanup(reason) {
    ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    validateLedger(ledger, leasePath);
    const proof = { ledger: ledgerPath, id: ledger.id, root, reason, at: new Date().toISOString(), signalled: [], refused: [], coreActions: [], survivors: [], clean: false, rootRemoved: false };
    if (ledger.state === 'open' || ledger.state === 'cleanup-failed' || removeRoot) {
      for (const core of ledger.cores) {
        if (!(await listening(core.socket))) continue;
        const hc = argv => { const r = bounded(core.hcBinary, argv, core.env); proof.coreActions.push({ side: core.side, argv, exitCode: r.status }); try { return JSON.parse(r.stdout); } catch { return null; } };
        const listing = hc(['ls', '--all', '--json']);
        if (!Array.isArray(listing?.terminals)) proof.survivors.push({ kind: 'inventory-unavailable', id: core.side });
        for (const t of listing?.terminals ?? []) { if (!t.address || t.address.includes('/')) continue; if (t.state === 'live') hc(['kill', t.address, '--json']); hc(['rm', t.address, '--json']); }
        for (const m of hc(['machine', 'ls', '--json'])?.machines ?? []) if (m.name) hc(['machine', 'rm', m.name, '--json']);
        hc(['server', 'stop', '--json']);
      }
      const owned = [...ledger.processes].reverse();
      for (const core of ledger.cores) if (core.pid && core.start) owned.push({ pid: core.pid, start: core.start, label: `core:${core.side}`, group: false });
      for (const p of owned) {
        if (!processStart(p.pid)) continue;
        if (!alive(p)) { proof.refused.push({ pid: p.pid, label: p.label, why: 'start identity changed; not ours' }); continue; }
        try { process.kill(p.group ? -p.pid : p.pid, 'SIGTERM'); proof.signalled.push({ pid: p.pid, label: p.label, signal: 'SIGTERM' }); } catch { /* gone */ }
      }
      for (const p of owned) if (!(await settle(() => !alive(p), 3000))) try { process.kill(p.group ? -p.pid : p.pid, 'SIGKILL'); proof.signalled.push({ pid: p.pid, label: p.label, signal: 'SIGKILL' }); } catch { /* gone */ }
    }
    for (const core of ledger.cores) {
      if (!(await settle(async () => !(await listening(core.socket)), 3000))) proof.survivors.push({ kind: 'socket', id: core.socket });
      if (core.pid && core.start && alive(core)) proof.survivors.push({ kind: 'core-process', id: String(core.pid) });
    }
    for (const p of ledger.processes) if (alive(p)) proof.survivors.push({ kind: 'process', id: `${p.label}:${p.pid}` });
    await settle(() => rootProcesses(root).length === 0, 3000);
    for (const p of rootProcesses(root)) proof.survivors.push({ kind: 'root-process', id: `${p.pid} ${p.command.slice(0, 200)}` });
    try {
      proof.defaultBefore = ledger.defaultBefore ?? null;
      proof.defaultAfter = await defaultInventory(ledger.defaultCore);
      if (JSON.stringify(proof.defaultBefore) !== JSON.stringify(proof.defaultAfter)) proof.survivors.push({ kind: 'default-inventory-changed', id: 'default' });
    } catch (error) { proof.survivors.push({ kind: 'default-inventory-unverified', id: String(error) }); }
    proof.clean = proof.survivors.length === 0;
    writeAtomic(ledgerPath.replace(/\.json$/, '.remote-cleanup.json'), proof);
    ledger.state = proof.clean ? 'closed' : 'cleanup-failed'; writeAtomic(ledgerPath, ledger);
    if (proof.clean && removeRoot) { rmSync(root, { recursive: true }); proof.rootRemoved = !existsSync(root); }
    if (removeRoot) process.stdout.write(JSON.stringify(proof) + '\n');
    process.exit(proof.clean ? 0 : 1);
  }
  let firing = false;
  const fire = reason => { if (firing) return; firing = true; void cleanup(reason).catch(error => { process.stderr.write(String(error) + '\n'); process.exit(1); }); };
  const check = () => {
    if (firing) return;
    let state; try { state = JSON.parse(readFileSync(ledgerPath, 'utf8')).state; } catch { state = 'missing'; }
    if (state === 'closed') { if (removeRoot) fire('closed-ledger-recovery'); else process.exit(0); return; }
    if (state !== 'open' || Date.now() >= leaseExpiry()) fire('lease-expired');
  };
  for (const signal of ['SIGHUP', 'SIGPIPE']) process.on(signal, () => {});
  process.stdout.on('error', () => {}); // a lost observer is not a lost guardian
  process.stdout.write(`guardian-ready ${process.pid}\n`); if (!removeRoot) process.stdout.end();
  process.on('SIGTERM', () => fire('guardian-terminated'));
  try { watch(dirname(leasePath), check); } catch { /* bounded reconciliation below */ }
  setInterval(check, 250); check();
}

async function supervise(configPath) {
  const c = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c.machine) || c.leaseMs < 1000 || c.renewMs >= c.leaseMs / 2 || !Number.isFinite(c.deadlineAt)) throw new Error('invalid-lease-supervisor');
  let stopped = false, timer;
  const stop = () => { stopped = true; clearTimeout(timer); process.exit(0); };
  process.stdin.on('end', stop); process.stdin.on('error', stop); process.stdin.resume();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, stop);
  let ready = false;
  const tick = () => {
    if (stopped || Date.now() >= c.deadlineAt) return stop();
    if (c.localLedger) {
      const l = JSON.parse(readFileSync(c.localLedger, 'utf8'));
      if (l.state !== 'open' || !alive(l.owner)) return stop();
    }
    const expiresAt = Math.min(c.deadlineAt, Date.now() + c.leaseMs);
    const code = `const fs=require('node:fs');const p=${JSON.stringify(c.leasePath)};if(!fs.existsSync(p))process.exit(2);const t=p+'.renew';fs.writeFileSync(t,JSON.stringify({version:1,expiresAt:${expiresAt}}),{mode:384});fs.renameSync(t,p);`;
    const env = c.remoteEnv ? Object.entries(c.remoteEnv).map(([k, v]) => `${k}=${quote(v)}`).join(' ') : `PATH="$PATH" HOME="$HOME" TMPDIR=${quote(c.remoteTmp)}`;
    const line = `exec env -i ${env} /usr/bin/perl -e 'alarm shift; exec @ARGV' 10 ${quote(c.remoteNode)} -e ${quote(code)}`;
    const result = bounded(c.sshBinary, ['-S', 'none', '-o', 'ControlMaster=no', '-o', 'ControlPersist=no', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-T', '--', c.machine, line], c.env, 12);
    if (result.status !== 0) { process.stderr.write(`lease-renewal-failed: ${result.status} ${result.stderr}\n`); process.exit(1); }
    if (!ready) { ready = true; process.stdout.write(`supervisor-ready ${process.pid}\n`); }
    timer = setTimeout(tick, c.renewMs);
  };
  tick();
}

function transport(configPath, args) {
  const c = JSON.parse(readFileSync(configPath, 'utf8'));
  if (c.log) appendFileSync(c.log, JSON.stringify({ at: Date.now(), argv: args }) + '\n');
  if (args.length < 2 || args.at(-2) !== c.machine) throw new Error('remote-transport-destination-refused');
  if (!c.remoteEnv || typeof c.remoteEnv !== 'object' || Object.entries(c.remoteEnv).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string')) throw new Error('remote-transport-environment-refused');
  const env = Object.entries(c.remoteEnv).map(([k, v]) => `${k}=${quote(v)}`).join(' ');
  const line = `exec env -i ${env} /usr/bin/perl -e 'alarm shift; exec @ARGV' ${c.seconds} /bin/sh -c ${quote(c.prefix + args.at(-1))}`;
  const r = spawnSync('/usr/bin/perl', ['-e', 'alarm shift; exec @ARGV', String(c.seconds), c.sshBinary, '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ControlPersist=no', '-o', 'ConnectTimeout=10', ...args.slice(0, -1), line], { env: c.env, stdio: 'inherit' });
  if (r.signal) { process.kill(process.pid, r.signal); return; }
  process.exit(r.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [first, second, ...rest] = process.argv.slice(2);
  try {
    if (first === '--supervise') await supervise(second);
    else if (first === '--transport') transport(second, rest);
    else if (first && second) await guardian(first, second, rest.includes('--remove-root'));
    else throw new Error('usage: remote-guardian.mjs <ledger> <lease> [--remove-root] | --supervise <config> | --transport <config> <ssh argv>');
  } catch (error) { process.stderr.write(String(error) + '\n'); process.exit(2); }
}
