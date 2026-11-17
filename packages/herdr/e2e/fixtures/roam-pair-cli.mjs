// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { pairPorts } from './roam-pair-platform.mjs';

export async function run(mapPath, argv) {
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const inside = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && relative(map.root, value) && !relative(map.root, value).startsWith('..');
  if (realpathSync(map.root) !== map.root || !inside(mapPath) || argv[0] !== '--global-root' || !inside(argv[1])) throw new Error('unsafe fixture remote cli');
  const row = map.machines.find(machine => machine.global === argv[1]);
  if (!row || !inside(row.descriptor)) throw new Error('unowned fixture machine');
  const d = JSON.parse(readFileSync(row.descriptor, 'utf8'));
  Object.assign(process.env, d.env);
  const io = { out: text => process.stdout.write(text), err: text => process.stderr.write(text) };
  if (argv.length === 5 && argv[2] === 'roam' && argv[3] === 'intercom' && ['exchange', 'revoke-local'].includes(argv[4])) {
    const result = spawnSync(process.execPath, [map.entry, ...argv], { env: process.env, stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  } else {
    const cli = await import(pathToFileURL(map.cli).href), stdout = [], stderr = [];
    let error;
    try {
      process.exitCode = await cli.main(argv, { out: text => { stdout.push(text); io.out(text); }, err: text => { stderr.push(text); io.err(text); } }, { pairPorts: pairPorts(row.descriptor) });
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); throw caught; }
    finally { appendFileSync(join(map.root, 'pair-replies.jsonl'), JSON.stringify({ at: Date.now(), machineId: d.machineId, command: argv.slice(2),
      code: process.exitCode, stdout: stdout.join(''), stderr: stderr.join(''), error }) + '\n'); }
  }
}
