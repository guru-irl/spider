// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@spider/db-core';
import { cleanupLedger, identityAlive, identityOf, openLedger, rootProcesses } from '../../e2e/harness/resources.js';

const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const brokerScript = `const fs=require('node:fs'),net=require('node:net'),path=require('node:path');
  const directory=process.env.BROKER_DIRECTORY;
  const server=net.createServer(socket=>socket.end());
  server.listen(path.join(directory,'broker.sock'),()=>{fs.writeFileSync(path.join(directory,'broker.pid'),String(process.pid));process.stdout.write('ready\\n');});`;
async function fixture() {
  const base = paths.scratch('worktree', process.cwd()); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'bc-')); roots.push(root);
  const directory = join(root, 'agent', 'intercom'); await mkdir(directory, { recursive: true });
  const ledger = openLedger(join(root, 'ledgers'), root);
  ledger.update(value => { Object.assign(value, { intercomDirectories: [directory] }); });
  return { root, directory, ledger };
}
function startBroker(directory: string) {
  const child = spawn(process.execPath, ['-e', brokerScript], { detached: true, env: { PATH: '/usr/bin:/bin', BROKER_DIRECTORY: directory }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child); return child;
}
test('cleanup records and stops an auto-started broker even when its command never names the fixture', async () => {
  const f = await fixture(), broker = startBroker(f.directory);
  await once(broker.stdout!, 'data');
  const identity = identityOf(broker.pid!);
  expect(rootProcesses(f.root).some(process => process.pid === broker.pid)).toBe(false);
  const proof = await cleanupLedger(f.ledger.path, 'broker-test');
  expect(proof.clean).toBe(true);
  expect(identityAlive(identity)).toBe(false);
  expect(proof.signalled).toContainEqual({ pid: broker.pid, label: 'intercom-broker', signal: 'SIGTERM' });
  expect(f.ledger.read().processes).toContainEqual({ ...identity, label: 'intercom-broker', group: false });
});
test('cleanup collects a broker restarted while its last producer shuts down', async () => {
  const f = await fixture();
  const producerScript = `const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{const child=spawn(process.execPath,['-e',process.env.BROKER_SCRIPT],{detached:true,env:process.env,stdio:['ignore','pipe','inherit']});child.stdout.once('data',()=>{child.stdout.destroy();child.unref();process.exit(0);});});
    process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const producer = spawn(process.execPath, ['-e', producerScript], { env: { PATH: '/usr/bin:/bin', BROKER_DIRECTORY: f.directory, BROKER_SCRIPT: brokerScript }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(producer); await once(producer.stdout!, 'data');
  f.ledger.update(value => { value.processes.push({ ...identityOf(producer.pid!), label: 'producer', group: false }); });
  let brokerPid: number | undefined;
  try {
    const proof = await cleanupLedger(f.ledger.path, 'broker-restart-test');
    brokerPid = Number(await readFile(join(f.directory, 'broker.pid'), 'utf8'));
    expect(proof.clean).toBe(true);
    expect(f.ledger.read().processes.find(process => process.label === 'intercom-broker')).toMatchObject({ pid: brokerPid });
    expect(proof.signalled).toContainEqual({ pid: brokerPid, label: 'intercom-broker', signal: 'SIGTERM' });
  } finally {
    brokerPid ??= Number(await readFile(join(f.directory, 'broker.pid'), 'utf8').catch(() => '0'));
    if (brokerPid) { try { process.kill(brokerPid, 'SIGKILL'); } catch {} }
  }
});
test('a forged broker pid cannot claim a process holding a different socket', async () => {
  const f = await fixture(), outside = await fixture(), broker = startBroker(outside.directory);
  await once(broker.stdout!, 'data'); const identity = identityOf(broker.pid!);
  await writeFile(join(f.directory, 'broker.pid'), String(broker.pid));
  const proof = await cleanupLedger(f.ledger.path, 'broker-decoy-test');
  expect(proof.clean).toBe(false);
  expect(proof.survivors).toContainEqual({ kind: 'broker-identity', id: f.directory });
  expect(proof.signalled.some(process => process.pid === broker.pid)).toBe(false);
  expect(identityAlive(identity)).toBe(true);
});
