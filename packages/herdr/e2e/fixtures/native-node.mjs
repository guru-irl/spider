// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const config = JSON.parse(readFileSync(fileURLToPath(new URL('./native-node.json', import.meta.url)), 'utf8'));
const args = process.argv.slice(2);
const ledger = JSON.parse(readFileSync(config.ledger, 'utf8'));
if (ledger.tearingDown || ledger.state !== 'open') process.exit(99);
if (!args[0]?.endsWith('/feed-reader.mjs')) {
  const command = spawn(config.nodePath, args, { stdio: 'inherit' });
  command.on('exit', code => process.exit(code ?? 128));
} else {
  if (args[1] !== '--root' || args[2] !== config.feedRoot || args.length !== 3 || config.directory !== join(ledger.root, 'native-processes')) process.exit(99);
  const stderrPath = join(config.directory, `${process.pid}.stderr.log`);
  const stderr = openSync(stderrPath, 'wx', 0o600);
  const command = spawn(config.nodePath, [args[0], '--serve', '--root', config.feedRoot], { detached: true, stdio: ['ignore', 'pipe', stderr] });
  closeSync(stderr);
  const start = execFileSync('/bin/ps', ['-p', String(command.pid), '-o', 'lstart='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } }).trim();
  const recordPath = join(config.directory, `${command.pid}.json`);
  const record = { pid: command.pid, start, argv: [config.nodePath, args[0], '--serve', '--root', config.feedRoot], stderrPath,
    env: Object.fromEntries(['HOME', 'PATH', 'SPIDER_GLOBAL_ROOT', 'SPIDER_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'HERDR_APP_HOME', 'HC_SOCKET', 'HC_SESSION'].map(key => [key, process.env[key] ?? null])), acknowledged: false, exitCode: null };
  writeFileSync(recordPath, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  let ready = '';
  command.stdout.on('data', data => {
    ready += String(data);
    if (!ready.includes('\n')) return;
    const line = ready.split('\n')[0];
    const connection = JSON.parse(line);
    if (connection.pid !== command.pid) process.exit(99);
    record.acknowledged = true; writeFileSync(recordPath, JSON.stringify(record));
    process.stdout.write(line + '\n', () => { command.unref(); process.exit(0); });
  });
  command.on('exit', code => { record.exitCode = code; writeFileSync(recordPath, JSON.stringify(record)); process.exit(code ?? 128); });
}
