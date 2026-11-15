#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// The supervisor itself comes from the packed release. This process supplies
// only the host inventory and limit ports that are unavailable on the test host.
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pairPorts } from './roam-pair-platform.mjs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [entry, globalRoot] = process.argv.slice(2);
const manifest = process.env.SPIDER_HERDR_E2E_PROCESS_DOMAIN;
const packedRoot = process.env.SPIDER_HERDR_E2E_PACKED_ROOT;
const checkout = process.env.SPIDER_TEST_FIXTURE_CHECKOUT;
if (!entry || !globalRoot || !manifest || !packedRoot || !checkout) throw new Error('fixture supervisor requires owned paths');
const owner = JSON.parse(readFileSync(manifest, 'utf8'));
const root = realpathSync(owner.root);
const inside = path => {
  const part = relative(root, realpathSync(path));
  return part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
const packed = realpathSync(packedRoot), scratch = realpathSync(join(checkout, '.spider', 'scratch', 'e2'));
const packageRelative = relative(scratch, packed);
if (!inside(globalRoot) || process.env.SPIDER_GLOBAL_ROOT !== globalRoot || !packageRelative ||
    packageRelative === '..' || packageRelative.startsWith(`..${sep}`) || isAbsolute(packageRelative) ||
    realpathSync(entry) !== join(packed, 'dist', 'roam', 'supervisor.mjs')) {
  throw new Error('fixture supervisor refuses unowned paths');
}
const unavailable = async () => { throw new Error('fixture has no hosting intents'); };
const probe = async pid => {
  try {
    const row = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat=,lstart='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } }).trim();
    return !row || row.startsWith('Z') ? { kind: 'absent' } : { kind: 'live', startIdentity: row.replace(/^\S+\s+/, '') };
  } catch { return { kind: 'absent' }; }
};
const system = {
  async bootId() { return 'fixture-boot'; },
  async limits() { return { soft: 8192, hard: 8192 }; },
  inventory: {
    probe,
    async processes() { return []; },
    presence: { async list() { return []; }, register: unavailable, remove: unavailable },
    leases: { root: globalRoot, get: unavailable, claim: unavailable, transfer: unavailable, release: unavailable, adopt: unavailable },
  },
};
let stop;
const stopped = new Promise(resolve => { stop = resolve; });
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const { startProductionSupervisor } = await import(pathToFileURL(entry).href);
const descriptor = process.env.SPIDER_E2E_PAIR_DESCRIPTOR;
if (descriptor && !inside(descriptor)) throw new Error('fixture pair descriptor is not owned');
const service = await startProductionSupervisor(globalRoot, { system, ...(descriptor ? { intercomLocalPorts: pairPorts(descriptor) } : {}) });
process.stdout.write('fixture supervisor ready\n');
try { await stopped; } finally { await service.stop(); }
