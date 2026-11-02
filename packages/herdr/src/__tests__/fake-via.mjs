#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (process.argv[2] === '--ssh') {
  const scenario = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  appendFileSync(process.argv[4], JSON.stringify(process.argv.slice(5)) + '\n');
  process.stdout.write(scenario.ssh?.stdout || ''); process.stderr.write(scenario.ssh?.stderr || ''); process.exit(scenario.ssh?.exitCode ?? 23);
}
const descriptor = process.env.HERDR_TEST_VIA_DESCRIPTOR || process.argv[2];
if (!descriptor) throw new Error('A test-owned transport descriptor is required');
const config = JSON.parse(readFileSync(descriptor, 'utf8'));
const env = { ...process.env, ...config.env };
for (const k of Object.keys(env)) if (k.startsWith('HC_') && !['HC_SESSION'].includes(k)) delete env[k];
if (!(env.XDG_STATE_HOME === config.root || env.XDG_STATE_HOME?.startsWith(config.root + '/')) || !env.XDG_CONFIG_HOME?.startsWith(config.root + '/')) throw new Error('Unfenced fake transport');
appendFileSync(config.log, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + '\n');
const child = spawn('/bin/sh', ['-c', process.argv.at(-1)], { env, stdio: 'inherit' });
appendFileSync(config.log, JSON.stringify({ pid: process.pid, childPid: child.pid }) + '\n');
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.once('exit', (code, signal) => { if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } else process.exit(code ?? 1); });
