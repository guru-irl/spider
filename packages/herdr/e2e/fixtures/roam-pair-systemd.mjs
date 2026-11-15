// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// A macOS/CI replacement for the user service-manager boundary. Unit files and connector processes are real.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { isAbsolute, join, relative, resolve } from 'node:path';

const descriptor = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { root, home, socket, stateFile, connector, node } = descriptor;
const inside = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && relative(root, value) && !relative(root, value).startsWith('..');
if (![home, socket, stateFile, connector].every(inside) || !isAbsolute(node)) throw new Error('unsafe fixture service manager');
const units = new Map();
const state = () => Object.fromEntries([...units].map(([name, unit]) => [name, { pid: unit.child?.pid ?? 0, start: unit.start ?? null, group: `/fixture/${name}` }]));
function save() { const temporary = `${stateFile}.${process.pid}.new`; writeFileSync(temporary, JSON.stringify(state()), { mode: 0o600 }); renameSync(temporary, stateFile); }
function startIdentity(pid) {
  const value = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat=,lstart='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } }).trim();
  if (!value || value.startsWith('Z')) throw new Error('fixture process identity unavailable');
  return value.replace(/^\S+\s+/, '');
}
function unitFile(name) {
  if (!/^spider-pair-[A-Za-z0-9._-]+-(host|connect)\.service$/.test(name)) throw new Error('unsafe fixture unit');
  return join(home, '.config', 'systemd', 'user', name);
}
function unitArgs(name) {
  const content = readFileSync(unitFile(name), 'utf8'), line = content.split('\n').find(row => row.startsWith('ExecStart='));
  if (!line || !content.includes('\nKillMode=control-group\n')) throw new Error('unsafe fixture unit contents');
  const encoded = line.slice('ExecStart='.length), parts = encoded.match(/"(?:\\.|[^"\\])*"/g) ?? [];
  if (parts.join(' ') !== encoded) throw new Error('invalid fixture unit argv');
  const argv = parts.map(part => JSON.parse(part)), match = /^spider-pair-(.+)-(host|connect)\.service$/.exec(name);
  if (!match || argv.length !== (match[2] === 'host' ? 6 : 7) || argv[0] !== node || argv[1] !== connector || argv[2] !== match[2] || argv[3] !== match[1] || !inside(argv.at(-1)) || argv.slice(4, -1).some(value => !/^[0-9]+$/.test(value))) throw new Error('unowned fixture connector');
  return argv;
}
async function start(name) {
  if (units.get(name)?.child) return;
  const argv = unitArgs(name), child = spawn(argv[0], argv.slice(1), { env: process.env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!child.pid) throw new Error('fixture connector spawn failed');
  const unit = { child, start: startIdentity(child.pid) }; units.set(name, unit); save();
  child.once('exit', () => { unit.child = null; save(); });
  await new Promise((ok, fail) => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.includes('connector ready\n')) ok(); });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.once('error', fail); child.once('exit', () => fail(new Error('fixture connector exited before ready')));
  });
}
async function command(argv) {
  if (!Array.isArray(argv) || argv[0] !== '--user') throw new Error('invalid fixture systemctl');
  const action = argv[1], name = argv[2];
  if (action === 'daemon-reload' && argv.length === 2) return { code: 0, stdout: '' };
  const file = unitFile(name);
  if (action === 'enable' || action === 'disable') return { code: 0, stdout: '' };
  if (action === 'start') { await start(name); return { code: 0, stdout: '' }; }
  if (action === 'stop') { units.get(name)?.child?.kill('SIGTERM'); return { code: 0, stdout: '' }; }
  if (action !== 'show') throw new Error('unsupported fixture systemctl');
  const unit = units.get(name), pid = unit?.child?.pid ?? 0;
  return { code: 0, stdout: `Id=${name}\nActiveState=${pid ? 'active' : 'inactive'}\nMainPID=${pid}\nControlGroup=${pid ? `/fixture/${name}` : ''}\nKillMode=control-group\nFragmentPath=${file}\nDropInPaths=\nNeedDaemonReload=no\n` };
}
save();
const server = createServer(socket => {
  let input = '';
  socket.on('data', chunk => {
    input += chunk.toString('utf8'); if (input.length > 16 * 1024) return socket.destroy();
    if (!input.includes('\n')) return;
    void command(JSON.parse(input).argv).then(value => socket.end(`${JSON.stringify(value)}\n`), () => socket.end('{"code":1,"stdout":""}\n'));
  });
});
await new Promise((ok, fail) => { server.once('error', fail); server.listen(socket, ok); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); for (const unit of units.values()) unit.child?.kill('SIGTERM'); });
process.stdout.write('fixture service manager ready\n');
