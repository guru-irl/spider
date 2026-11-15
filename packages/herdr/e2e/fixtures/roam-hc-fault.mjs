// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Fail or interrupt only named `hc exec --on` calls; every other call reaches the real recording wrapper.
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';

const root = process.env.SPIDER_E2E_FIXTURE_ROOT, real = process.env.SPIDER_E2E_HC_REAL, file = process.env.SPIDER_E2E_HC_FAULT;
const inside = value => value && isAbsolute(value) && resolve(value) === value && relative(root, value) && !relative(root, value).startsWith('..');
if (!root || !isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root ||
    !inside(real) || !inside(file) || realpathSync(real) !== real || realpathSync(file) !== file) throw new Error('unsafe fixture transport paths');
const args = process.argv.slice(2), at = args.indexOf('--on');
const target = args[0] === 'exec' && at >= 0 ? args[at + 1] : null;
const pairAlias = process.env.SPIDER_E2E_PAIR_ALIAS;
if (pairAlias && !/^spider-pair-[A-Za-z0-9._-]+$/.test(pairAlias)) throw new Error('invalid fixture pair alias');
if (target && !['hub.invalid', 'box-1.invalid', 'box-2.invalid', pairAlias].includes(target)) throw new Error('unowned fixture target');
const down = () => {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (state.scope !== undefined && state.scope !== 'exchange') return true;
    if (state.scope === 'exchange' && !args.includes('exchange')) return false;
    return !Array.isArray(state.down) || state.down.includes(target);
  }
  catch { return true; }
};
if (target && down()) { process.stderr.write('fixture transport outage\n'); process.exit(1); }
let claim = null, input = null;
if (target && args.includes('--stdin') && args.includes('exchange')) {
  const token = `${file}.drop-${target}`, candidate = `${token}.claimed-${process.pid}`;
  let id;
  try { id = readFileSync(token, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (id !== undefined) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid fixture drop identity');
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 1024 * 1024) throw new Error('fixture request too large'); chunks.push(chunk); }
    input = Buffer.concat(chunks);
    if (input.includes(id)) {
      try { renameSync(token, candidate); claim = candidate; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
const child = spawn(real, args, { env: process.env, stdio: [input ? 'pipe' : 'inherit', claim ? 'pipe' : 'inherit', 'inherit'] });
if (input) child.stdin.end(input);
child.stdout?.resume();
let cut = false;
const watcher = target ? setInterval(() => { if (!cut && down()) { cut = true; child.kill('SIGTERM'); } }, 40) : null;
watcher?.unref();
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.once('error', () => { if (watcher) clearInterval(watcher); process.exit(1); });
child.once('close', (code, signal) => {
  if (watcher) clearInterval(watcher);
  if (claim) writeFileSync(claim, JSON.stringify({ target, code, signal, cut }), { mode: 0o600 });
  if (cut || claim && code === 0) process.exit(1);
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
  else process.exit(code ?? 1);
});
