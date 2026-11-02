#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync, lstatSync, realpathSync, existsSync, openSync, closeSync, appendFileSync, writeFileSync, watch } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { spawn } from 'node:child_process';

try {
  const configPath = process.argv[2], c = JSON.parse(readFileSync(configPath, 'utf8'));
  const root = realpathSync(c.root);
  if (root !== resolve(c.root) || !root.includes(`${sep}.spider${sep}scratch${sep}`)) throw new Error('fault-root-unowned');
  const own = p => {
    p = resolve(p);
    if (!p.startsWith(root + sep)) throw new Error('fault-path-unowned');
    for (let at = p; at !== root; at = dirname(at)) {
      try { const stat = lstatSync(at); if (stat.isSymbolicLink()) throw new Error('fault-symlink'); if (stat.isFile() && stat.nlink !== 1) throw new Error('fault-hardlink'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return p;
  };
  for (const p of [configPath, c.real, c.log, c.once]) own(p);
  if (!['drop-reply', 'corrupt-read', 'reject', 'hold', 'wrong-version'].includes(c.mode) || !Array.isArray(c.match) || !c.match.length) throw new Error('fault-invalid-config');
  const argv = process.argv.slice(3);
  let selected = c.match.every((v, i) => argv[i] === v) && (!c.contains || argv.includes(c.contains)) && (!c.containsSuffix || argv.some(v => v.endsWith(c.containsSuffix))) && (!c.scope || process.env.SPIDER_E2E_FAULT_SCOPE === c.scope);
  if (selected) {
    try { closeSync(openSync(c.once, 'wx', 0o600)); } catch (e) { if (e.code === 'EEXIST') selected = false; else throw e; }
  }
  const record = data => appendFileSync(own(c.log), JSON.stringify({ at: Date.now(), pid: process.pid, argv, mode: c.mode, ...data }) + '\n', { mode: 0o600 });
  if (selected && c.mode === 'reject') {
    record({ phase: 'rejected' }); process.stderr.write('transport-fault: rejected before forwarding\n'); process.exitCode = 95;
  } else {
    if (selected && c.mode === 'hold') {
      const gate = c.gate;
      if (!gate || !gate.nonce || !Number.isFinite(gate.deadlineAt)) throw new Error('fault-gate-invalid');
      own(gate.ready); own(gate.release);
      writeFileSync(own(gate.ready), JSON.stringify({ nonce: gate.nonce, argv, pid: process.pid }), { mode: 0o600 });
      record({ phase: 'held' });
      await new Promise((resolve, reject) => {
        let timer;
        const watcher = watch(dirname(gate.release), check);
        function finish(error) { watcher.close(); clearTimeout(timer); error ? reject(error) : resolve(); }
        function check() {
          if (existsSync(gate.release)) {
            try { if (JSON.parse(readFileSync(own(gate.release), 'utf8')).nonce !== gate.nonce) return finish(new Error('fault-gate-mismatch')); return finish(); } catch (e) { return finish(e); }
          }
          if (Date.now() >= gate.deadlineAt) return finish(new Error('fault-gate-deadline'));
          clearTimeout(timer); timer = setTimeout(check, Math.min(100, gate.deadlineAt - Date.now()));
        }
        check();
      });
    }
    if (selected) record({ phase: 'forwarded' });
    const child = spawn(own(c.real), argv, { env: process.env, stdio: selected ? ['inherit', 'pipe', 'pipe'] : 'inherit' });
    const out = [], err = [];
    if (selected) { child.stdout.on('data', d => out.push(d)); child.stderr.on('data', d => err.push(d)); }
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
    child.on('error', e => { process.stderr.write(`transport-fault: ${e.message}\n`); process.exitCode = 94; });
    child.on('close', (exitCode, signal) => {
      if (selected) record({ phase: exitCode === 0 ? 'accepted' : 'failed', exitCode, signal, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
      if (selected && exitCode === 0 && c.mode === 'drop-reply') { process.stderr.write('transport-fault: accepted reply intentionally lost\n'); process.exitCode = 96; }
      else if (selected && exitCode === 0 && c.mode === 'wrong-version') { const value = JSON.parse(Buffer.concat(out).toString()); value.version = '0.1.15'; process.stdout.write(JSON.stringify(value) + '\n'); process.exitCode = 0; }
      else if (selected && exitCode === 0 && c.mode === 'corrupt-read') { process.stdout.write('{"text":"corrupt-publication"}\n'); process.exitCode = 0; }
      else {
        if (selected) { process.stdout.write(Buffer.concat(out)); process.stderr.write(Buffer.concat(err)); }
        if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } else process.exitCode = exitCode ?? 94;
      }
    });
  }
} catch (e) { process.stderr.write(`transport-fault: ${e.message}\n`); process.exitCode = 94; }
