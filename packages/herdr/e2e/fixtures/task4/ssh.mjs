#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, relative, isAbsolute } from 'node:path';

try {
  const input = process.argv[2];
  const fd = fs.openSync(input, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let config;
  try { if (!fs.fstatSync(fd).isFile()) throw new Error('configuration is not a regular file'); config = JSON.parse(fs.readFileSync(fd, 'utf8')); }
  finally { fs.closeSync(fd); }
  const root = fs.realpathSync(config.root);
  const inside = path => { const suffix = relative(root, path); return suffix !== '' && suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix); };
  if (config.version !== 1 || !process.env.SPIDER_GLOBAL_ROOT || fs.realpathSync(dirname(process.env.SPIDER_GLOBAL_ROOT)) !== root || !inside(input) || !inside(config.cwd) || !inside(config.log)) throw new Error('configuration escaped the fixture');
  if (fs.realpathSync(config.cwd) !== config.cwd || fs.realpathSync(dirname(config.log)) !== dirname(config.log)) throw new Error('nonphysical fixture path');
  const argv = process.argv.slice(3);
  const log = fs.openSync(config.log, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(log, JSON.stringify({ at: Date.now(), pid: process.pid, argv, cwd: config.cwd }) + '\n'); } finally { fs.closeSync(log); }
  if (argv[0] !== config.alias && argv[0] !== config.unmanagedAlias) throw new Error('refusing non-fixture alias');
  if (argv.length !== 2 || !Array.isArray(config.commands) || !config.commands.includes(argv[1])) throw new Error('refusing undeclared fixture command');
  // Never invoke real ssh. This is the owned local destination behind the transport boundary.
  const result = spawnSync('/bin/sh', ['-c', argv[1]], { cwd: config.cwd, env: process.env, stdio: 'inherit', timeout: 15000 });
  if (result.error || result.signal || result.status === null) throw new Error('fixture command did not exit normally');
  process.exitCode = result.status;
} catch (error) {
  process.stderr.write(`task4-fixture-ssh: ${error.message}\n`);
  process.exitCode = 92;
}
