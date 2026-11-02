#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { appendFile } from 'node:fs/promises';

const log = process.env.FIXTURE_TRANSPORT_LOG;
if (!log) process.exit(90);
const argv = process.argv.slice(2);
await appendFile(log, JSON.stringify({ argv }) + '\n', { mode: 0o600 });
let input = '';
if (process.env.FIXTURE_TRANSPORT_SKIP_INPUT !== '1') for await (const chunk of process.stdin) input += chunk;
process.stdout.write(`TRANSPORT-OUT\n${JSON.stringify(argv)}\n${input}`);
process.stderr.write('TRANSPORT-ERR\n');
process.exitCode = 41;
