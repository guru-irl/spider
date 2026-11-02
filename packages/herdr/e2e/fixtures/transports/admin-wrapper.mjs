#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { appendFile, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';

// This executable is copied into each disposable fixture and approved by digest.
// Its only transport is the packed CLI's shim, configured with an owned sentinel.
const directory = process.env.FIXTURE_ADMIN_DIRECTORY;
const observations = process.env.FIXTURE_ADMIN_OBSERVATIONS;
const cli = process.env.FIXTURE_SHIM_CLI;
const token = process.env.SPIDER_HERDR_SSH_BYPASS;
if (!directory || !observations || !cli || !token) process.exit(90);
const auditPath = join(directory, 'audit.jsonl');
const capability = join(directory, 'bypass', token);
const rows = (await readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const audit = rows.at(-1);
const capabilityBytes = await readFile(capability, 'utf8');
const auditMode = (await stat(auditPath)).mode & 0o777;
const capabilityMode = (await stat(capability)).mode & 0o777;
const argv = process.argv.slice(2);
await appendFile(observations, JSON.stringify({ audit, auditCount: rows.length, auditMode, capabilityMode, token, capabilityBytes, argv }) + '\n', { mode: 0o600 });
if (process.env.FIXTURE_ADMIN_GATE_SOCKET) {
  const story = process.env.FIXTURE_ADMIN_GATE_STORY, gate = process.env.FIXTURE_ADMIN_GATE_NAME;
  if (!story || !gate) throw new Error('admin gate needs a story and name');
  await new Promise((resolve, reject) => {
    const socket = connect(process.env.FIXTURE_ADMIN_GATE_SOCKET); let buffer = '', settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(); };
    const timer = setTimeout(() => finish(new Error('admin gate timed out')), 120_000);
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'ready', story, gate, marker: 'admin', step: 1, pid: process.pid }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8'); const newline = buffer.indexOf('\n'); if (newline < 0) return;
      try { const reply = JSON.parse(buffer.slice(0, newline)); finish(reply.type === 'release' && reply.story === story && reply.gate === gate && reply.step === 1 ? undefined : new Error('admin gate release mismatch')); }
      catch (error) { finish(error); }
    });
    socket.on('error', finish); socket.on('close', () => finish(new Error('admin gate closed')));
  });
}
const child = spawn(process.execPath, [cli, '--ssh-shim', ...argv], { env: process.env, stdio: 'inherit' });
child.once('error', error => { console.error(error); process.exitCode = 91; });
child.once('close', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); });
