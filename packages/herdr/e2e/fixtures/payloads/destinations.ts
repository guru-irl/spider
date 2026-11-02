// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { writeFile, mkdir, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Suite } from '../../harness/suite.js';
import type { MachineName } from '../../../src/contracts.js';
import { assertSocketPath, HarnessError } from '../../harness/environment.js';
import type { RemoteSuite } from '../../harness/remote.js';
import { identityOf } from '../../harness/resources.js';
import { shellQuote } from './index.js';

/** A separate third namespace, registered before bootstrap and cleaned by the same independent supervisor. */
export async function secondDestination(suite: Suite): Promise<MachineName> {
  if (suite.options.tier === 'remote') return secondRemoteDestination(suite as RemoteSuite);
  const cores = suite.cores!;
  const env: Record<string, string> = { ...cores.dest.env, HC_SESSION: 'e', XDG_CONFIG_HOME: join(suite.root, 'ec'), HOME: join(suite.root, 'eh'), TMPDIR: join(suite.root, 'et') };
  for (const dir of [env.XDG_CONFIG_HOME, env.HOME, env.TMPDIR, join(env.XDG_CONFIG_HOME, 'herdr-core')]) await mkdir(suite.ownPath(dir), { recursive: true });
  await writeFile(join(env.XDG_CONFIG_HOME, 'herdr-core/config.toml'), 'notes = false\n');
  const socket = assertSocketPath(suite.root, join(env.XDG_STATE_HOME, 'herdr-core/e/e.sock'));
  assert.notEqual(socket, cores.dest.socket); assert.notEqual(socket, cores.local.socket);
  suite.ledger.update(l => l.cores.push({ side: 'extra', namespace: 'e', socket, hcBinary: cores.wrapper, env }));
  assert.equal((await suite.invoke(cores.wrapper, ['server', 'start', '--json'], env)).exitCode, 0);
  const result = await suite.invoke(cores.wrapper, ['server', 'status', '--json'], env), value = JSON.parse(result.stdout);
  assert.equal(value.version, '0.1.16'); assert.notEqual(value.core.id, cores.local.coreId); assert.notEqual(value.core.id, cores.dest.coreId);
  assert.ok((await stat(socket)).isSocket());
  const identity = identityOf(value.pid);
  suite.ledger.update(l => { const c = l.cores.find(c => c.side === 'extra')!; c.coreId = value.core.id; c.pid = identity.pid; c.start = identity.start; });
  const descriptor = suite.ownPath(join(suite.root, 'via-e.json')), via = suite.ownPath(join(suite.root, 'bin/via-e'));
  await writeFile(descriptor, JSON.stringify({ root: suite.root, env, log: cores.viaLog, ledgerPath: suite.ledger.path, socket, viaDirectory: suite.ledger.read().viaDirectory }), { mode: 0o600 });
  await writeFile(via, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL('../via.mjs', import.meta.url)))} ${shellQuote(descriptor)} "$@"\n`, { mode: 0o700 }); await chmod(via, 0o700);
  const name = 'second.invalid' as MachineName; suite.ledger.update(l => l.machines.push({ side: 'local', name }));
  const added = await suite.hc(['machine', 'add', '--via', via, '--name', name, '--session', 'e', '--json']); await suite.evidence('second-machine-add.json', added);
  assert.equal(added.exitCode, 0, added.stderr || added.stdout);
  await suite.evidence('second-core.json', { ...value, socket }); return name;
}

async function secondRemoteDestination(suite: RemoteSuite): Promise<MachineName> {
  const m = suite.remote.metadata, name = 'second.invalid' as MachineName;
  const namespace = 's' + m.namespace.slice(1), socket = m.env.XDG_RUNTIME_DIR + '/herdr-core/' + namespace + '.sock';
  for (const path of [socket, socket.replace(/\.sock$/, '.holder.4294967295.sock')]) if (Buffer.byteLength(path) > 103) throw new HarnessError('socket-path-too-long', 'second destination socket exceeds the fixture limit');
  const env = { ...m.env, HC_SESSION: namespace };
  const code = `import fs from 'node:fs';import cp from 'node:child_process';const m=${JSON.stringify(m)},env=${JSON.stringify(env)},socket=${JSON.stringify(socket)};const path=m.ledger;const ledger=JSON.parse(fs.readFileSync(path));if(ledger.root!==m.root||ledger.state!=='open'||ledger.cores.some(c=>c.namespace===env.HC_SESSION))throw Error('second-core-unowned');const core={side:'second',namespace:env.HC_SESSION,socket,hcBinary:m.hc,env};ledger.cores.push(core);const save=()=>{fs.writeFileSync(path+'.second',JSON.stringify(ledger),{mode:384});fs.renameSync(path+'.second',path)};save();const run=args=>JSON.parse(cp.execFileSync('/usr/bin/perl',['-e','alarm shift; exec @ARGV','15',m.hc,...args],{env,cwd:m.root,encoding:'utf8'}));run(['server','start','--json']);const status=run(['server','status','--json']);if(status.version!=='0.1.16'||!status.core?.id||status.core.id===m.coreId||!fs.statSync(socket).isSocket())throw Error('second-core-isolation-unproved');const helpers=await import(m.root+'/guardian.mjs');Object.assign(core,{coreId:status.core.id,pid:status.pid,start:helpers.processStart(status.pid)});save();console.log(JSON.stringify({coreId:core.coreId,socket,pid:core.pid,start:core.start}));`;
  const result = await suite.remote.exec(`${shellQuote(m.nodePath)} --input-type=module -e ${shellQuote(code)}`);
  assert.equal(result.exitCode, 0, result.stderr); const remote = JSON.parse(result.stdout);
  assert.notEqual(remote.coreId, suite.cores!.local.coreId); assert.notEqual(remote.coreId, suite.cores!.dest.coreId);
  suite.ledger.update(l => l.machines.push({ side: 'local', name }));
  const { remoteMachine } = await import('../../harness/remote.js');
  const added = await suite.hc(['machine', 'add', remoteMachine(), '--name', name, '--session', namespace, '--json']);
  await suite.evidence('second-machine-add.json', added); assert.equal(added.exitCode, 0, added.stderr);
  const inventory = (await suite.hc(['machine', 'ls', '--json'])).json as { machines: { name: string; id: string }[] };
  assert.equal(inventory.machines.find(m => m.name === name)?.id, remote.coreId);
  await suite.evidence('second-core.json', { ...remote, namespace }); return name;
}
