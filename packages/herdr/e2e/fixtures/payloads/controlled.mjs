#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync, writeFileSync, appendFileSync, lstatSync, realpathSync, watch, existsSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';

function fail(code) { throw new Error(code); }
try {
  const c = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const root = realpathSync(c.root);
  const remoteRoot = /\/spider-herdr-e2e-[a-f0-9]{8}$/.test(root);
  const rootStat = lstatSync(root);
  if (root !== resolve(c.root) || (!root.includes(`${sep}.spider${sep}scratch${sep}`) && !remoteRoot) || remoteRoot && (rootStat.isSymbolicLink() || !rootStat.isDirectory() || rootStat.uid !== process.getuid() || (rootStat.mode & 0o077) !== 0)) fail('payload-root-unowned');
  const own = p => {
    p = resolve(p);
    if (!p.startsWith(root + sep)) fail('payload-path-unowned');
    for (let at = p; at !== root; at = dirname(at)) {
      try { const stat = lstatSync(at); if (stat.isSymbolicLink()) fail('payload-symlink'); if (stat.isFile() && stat.nlink !== 1) fail('payload-hardlink'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return p;
  };
  own(process.argv[2]);
  for (const key of ['ready', 'release', 'effect', 'signalFile']) if (c[key]) own(c[key]);
  if (!c.story || !c.id || !c.nonce) fail('payload-identity-missing');
  const write = (stream, data) => new Promise((resolve, reject) => stream.write(data, e => e ? reject(e) : resolve()));
  const emit = async (out, err) => { if (out) await write(process.stdout, out); if (err) await write(process.stderr, err); };
  if (c.onSignalExitZero) for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (c.signalFile) writeFileSync(own(c.signalFile), JSON.stringify({ signal, exitCode: 0 }), { mode: 0o600 });
    process.stdout.write(`trapped:${signal}\n`, () => process.exit(0));
  });
  await emit(c.beforeStdout, c.beforeStderr);
  if (c.release) {
    writeFileSync(own(c.ready), JSON.stringify({ story: c.story, id: c.id, nonce: c.nonce, pid: process.pid, cwd: process.cwd() }), { mode: 0o600 });
    await new Promise((resolve, reject) => {
      let timer;
      const watcher = watch(dirname(c.release), check);
      function finish(error) { watcher.close(); clearTimeout(timer); error ? reject(error) : resolve(); }
      function check() {
        if (existsSync(c.release)) {
          try {
            const r = JSON.parse(readFileSync(own(c.release), 'utf8'));
            if (r.story !== c.story || r.id !== c.id || r.nonce !== c.nonce) return finish(new Error('payload-release-mismatch'));
            return finish();
          } catch (e) { return finish(e); }
        }
        if (!Number.isFinite(c.deadlineAt) || Date.now() >= c.deadlineAt) return finish(new Error('payload-gate-deadline'));
        clearTimeout(timer); timer = setTimeout(check, Math.min(100, c.deadlineAt - Date.now()));
      }
      check();
    });
  }
  if (c.effect) appendFileSync(own(c.effect), c.id + '\n', { mode: 0o600 });
  if (c.stdin) {
    const input = readFileSync(0);
    await write(process.stdout, `stdin-bytes:${input.length}\n`);
  }
  if (c.splitUnicode) {
    const bytes = Buffer.from('split:雪🙂é\n');
    for (const end of [7, 9, 12, bytes.length]) {
      const start = end === 7 ? 0 : end === 9 ? 7 : end === 12 ? 9 : 12;
      await write(process.stdout, bytes.subarray(start, end));
      if (end === 9) await write(process.stderr, 'interleaved-error\n');
    }
  }
  if (c.large) {
    for (let i = 0; i < c.large.lines; i += 1000) {
      let text = '';
      for (let j = i; j < Math.min(i + 1000, c.large.lines); j++) text += `line-${String(j).padStart(5, '0')}\n`;
      await write(process.stdout, text);
    }
    await write(process.stdout, 'bytes-start\n');
    for (let offset = 0; offset < c.large.bytes; offset += 32768) {
      const b = Buffer.alloc(Math.min(32768, c.large.bytes - offset));
      for (let i = 0; i < b.length; i++) b[i] = 97 + (offset + i) % 26;
      await write(process.stdout, b);
    }
    await write(process.stdout, '\nbytes-end\n');
  }
  await emit(c.stdout, c.stderr);
  if (c.signal) process.kill(process.pid, c.signal);
  else process.exitCode = c.exitCode ?? 0;
} catch (e) { process.stderr.write(`payload-control: ${e.message}\n`); process.exitCode = 91; }
