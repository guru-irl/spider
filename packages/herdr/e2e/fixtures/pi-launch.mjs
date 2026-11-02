#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Test-owned `pi` on PATH. Runs the installed pi CLI in this process after installing a resolve hook that refuses any
// module under the checkout's workspace source (packages/<name>/src), so a passing story cannot load spider from source.
// Spider spawns children as `pi` from PATH, so children pass through this launcher too.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';

const cli = process.env.SPIDER_E2E_PI_CLI, guard = process.env.SPIDER_E2E_SOURCE_GUARD;
if (!cli || !guard) { process.stderr.write('pi-launch: SPIDER_E2E_PI_CLI and SPIDER_E2E_SOURCE_GUARD are required\n'); process.exit(97); }
const forbidden = new RegExp(`^${pathToFileURL(guard).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+/src/`);
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (forbidden.test(result.url)) {
      const message = `e2e-source-import-refused: ${result.url} (from ${context.parentURL ?? 'entry'})`;
      process.stderr.write(message + '\n');
      throw new Error(message);
    }
    return result;
  },
});
// P1 process domain: register this pi (PID plus the same start identity spider's process probe reads).
const domain = process.env.SPIDER_HERDR_E2E_PROCESS_DOMAIN;
if (domain) {
  let start = null;
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8'); start = `linux:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
  } else start = `posix:${execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } }).trim()}`;
  const procs = join(dirname(domain), 'procs');
  mkdirSync(procs, { recursive: true, mode: 0o700 });
  const temporary = join(procs, `.${process.pid}.new`);
  writeFileSync(temporary, JSON.stringify({ version: 1, pid: process.pid, start }), { mode: 0o600 });
  renameSync(temporary, join(procs, `${process.pid}.json`));
}
process.env.PI_OFFLINE = '1'; process.env.PI_SKIP_VERSION_CHECK = '1'; process.env.PI_TELEMETRY = '0';
await import(pathToFileURL(cli).href);
