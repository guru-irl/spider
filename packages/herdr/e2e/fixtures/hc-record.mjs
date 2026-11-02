#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Recording wrapper around the real hc: logs argv, pid, namespace and socket, then runs hc unchanged.
// Replies are never overridden. Usage: HC_RECORD_LOG=<jsonl> HC_REAL_BINARY=<hc> hc-record.mjs <hc argv...>
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const log = process.env.HC_RECORD_LOG, real = process.env.HC_REAL_BINARY;
if (!log || !real) { process.stderr.write('hc-record: HC_RECORD_LOG and HC_REAL_BINARY are required\n'); process.exit(97); }
const env = { ...process.env };
delete env.HC_RECORD_LOG; delete env.HC_REAL_BINARY;
const namespace = env.HC_SESSION?.trim() || 'default';
const socket = env.HC_SOCKET || (env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, 'herdr-core', namespace, `${namespace}.sock`) : null);
appendFileSync(log, JSON.stringify({ at: Date.now(), pid: process.pid, ppid: process.ppid, argv: process.argv.slice(2), namespace, socket, cwd: process.cwd(), terminal: env.HC_TERMINAL_ID ?? null }) + '\n');
const child = spawn(real, process.argv.slice(2), { env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.once('error', error => { process.stderr.write(`hc-record: ${error.message}\n`); process.exit(98); });
child.once('exit', (code, signal) => { if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } else process.exit(code ?? 1); });
