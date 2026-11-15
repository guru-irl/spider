// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
    const helper = await import(pathToFileURL(map.helper).href);
    process.exitCode = await helper.main(argv[1], argv[4]);
  } else {
    const cli = await import(pathToFileURL(map.cli).href);
    process.exitCode = await cli.main(argv, io, { pairPorts: pairPorts(row.descriptor) });
  }
}
