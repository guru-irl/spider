// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePairCommand } from '../../../roam/src/intercom-pair-files.js';
// @ts-ignore The connector also loads this ESM fixture directly.
import { connectCommands } from './roam-pair-command.mjs';
import { parseConfig } from '../../../roam/src/config.js';
import type { Peer } from '../../../roam/src/contracts.js';
import { HarnessError, assertSocketPath } from '../harness/environment.js';
import { runHc } from '../harness/hc.js';
import { spawnOwned, type OwnedProcess } from '../harness/processes.js';
import { identityOf } from '../harness/resources.js';
import { deadline, waitFor } from '../harness/wait.js';
import type { Suite } from '../harness/suite.js';
import type { Network } from './roam-intercom.js';

const PAIR = 'fixture-pair', EPOCH = 'fixture-pair-epoch', ALIAS = `spider-pair-${PAIR}`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function ports(): Promise<[number, number]> {
  const servers = [createServer(), createServer()];
  await Promise.all(servers.map(server => new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); })));
  const values = servers.map(server => (server.address() as { port: number }).port);
  await Promise.all(servers.map(server => new Promise<void>(ok => server.close(() => ok()))));
  return [values[0], values[1]];
}
function socketCall(path: string, value: object): Promise<Record<string, unknown>> {
  return new Promise((ok, fail) => {
    const socket = createConnection(path); let text = '';
    socket.on('connect', () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on('data', chunk => {
      text += chunk.toString('utf8'); const end = text.indexOf('\n');
      if (end < 0) return;
      socket.destroy(); try { ok(JSON.parse(text.slice(0, end))); } catch (error) { fail(error); }
    });
    socket.on('error', fail);
    socket.setTimeout(5000, () => { socket.destroy(); fail(new Error('fixture socket deadline')); });
  });
}
export interface PairFixture { graph: string; pairId: string; alias: string; descriptors: readonly string[]; managers: readonly OwnedProcess[];
  presentedKey(value: 'system' | 'other'): Promise<void>; close(): Promise<void> }

/** No direct box alias survives: enrollment must create its reserved route through the connector. */
export async function preparePair(suite: Suite, network: Network): Promise<PairFixture> {
  if (!suite.cores) throw new HarnessError('missing-prerequisite', 'pair enrollment requires owned cores');
  const [hub, source, target] = network.machines, managers: OwnedProcess[] = [];
  const close = async () => { for (const manager of managers.reverse()) await manager.stop(); };
  try {
    for (const [machine, other] of [[source, target], [target, source]]) {
      const removed = await runHc(suite.cores.wrapper, ['machine', 'rm', other.alias, '--json'], machine.core.env);
      if (removed.exitCode !== 0) throw new HarnessError('hc-failed', 'cannot remove fixture shortcut');
      const list = await runHc(suite.cores.wrapper, ['machine', 'ls', '--json'], machine.core.env);
      const rows = (list.json as { machines?: { name: string }[] })?.machines;
      if (!rows || rows.some(row => row.name === other.alias)) throw new HarnessError('isolation-unproved', 'box shortcut remains');
    }
    const bin = suite.ownPath(join(suite.root, 'bin'));
    for (const name of ['roam-pair-systemd.mjs', 'roam-pair-connector.mjs', 'roam-pair-command.mjs', 'roam-pair-platform.mjs', 'roam-pair-cli.mjs', 'roam-pair-ssh.mjs', 'via.mjs']) {
      await copyFile(fileURLToPath(new URL(`./${name}`, import.meta.url)), join(bin, name));
    }
    const connector = join(bin, 'roam-pair-connector.mjs'), ssh = join(bin, 'pair-ssh');
    await writeFile(ssh, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(bin, 'roam-pair-ssh.mjs'))} ${quote(join(source.global, '..', 'pair.json'))} "$@"\n`, { mode: 0o700 });
    const [hostPort, localPort] = await ports(), descriptors: string[] = [];
    let targetKeys: { served: string; system: string; other: string } | undefined;
    for (const [offset, machine] of [source, target].entries()) {
      const machineRoot = join(machine.global, '..'), home = join(machineRoot, 'h');
      const hostKey = join(machineRoot, 'host-key');
      const keygen = await suite.invoke('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey], machine.env);
      if (keygen.exitCode !== 0) throw new HarnessError('fixture-keygen', keygen.stderr);
      const otherKey = join(machineRoot, 'other-host-key');
      const otherKeygen = await suite.invoke('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', otherKey], machine.env);
      if (otherKeygen.exitCode !== 0) throw new HarnessError('fixture-keygen', otherKeygen.stderr);
      const systemSsh = join(machineRoot, 'system-ssh'), systemKey = join(systemSsh, 'ssh_host_ed25519_key.pub'), servedKey = join(machineRoot, 'served-key.pub');
      await mkdir(systemSsh, { mode: 0o755 }); await copyFile(`${hostKey}.pub`, systemKey); await copyFile(`${hostKey}.pub`, servedKey);
      if (offset === 1) targetKeys = { served: servedKey, system: systemKey, other: `${otherKey}.pub` };
      const keyscan = join(machineRoot, 'ssh-keyscan');
      await writeFile(keyscan, `#!/bin/sh\n[ "$#" -eq 7 ] && [ "$1" = -T ] && [ "$2" = 5 ] && [ "$3" = -t ] && [ "$4" = ed25519,ecdsa,rsa ] && [ "$5" = -p ] && [ "$6" = ${quote(String(hostPort))} ] && [ "$7" = 127.0.0.1 ] || exit 2\nIFS=' ' read -r type key comment < ${quote(servedKey)}\n[ "$type" = ssh-ed25519 ] && [ -n "$key" ] || exit 2\nprintf '# 127.0.0.1:%s SSH-2.0-OpenSSH_9.8\\n[127.0.0.1]:%s %s %s\\n# 127.0.0.1:%s SSH-2.0-OpenSSH_9.8\\n# 127.0.0.1:%s SSH-2.0-OpenSSH_9.8\\n' ${quote(String(hostPort))} ${quote(String(hostPort))} "$type" "$key" ${quote(String(hostPort))} ${quote(String(hostPort))}\n`, { mode: 0o700 });
      const descriptor = suite.ownPath(join(machineRoot, 'pair.json')), socket = assertSocketPath(suite.root, join(machineRoot, 'sd.sock'));
      const stateFile = suite.ownPath(join(machineRoot, 'sd.json'));
      Object.assign(machine.env, { SPIDER_E2E_PAIR_ALIAS: ALIAS });
      const value = { root: suite.root, global: machine.global, machineId: machine.id, home, socket, stateFile, node: process.execPath,
        connector, systemctl: join(machineRoot, 'systemctl'), ssh, keyscan, systemSsh, hc: suite.cores.wrapper, env: machine.env,
        hostPort, localPort, connectCommands: connectCommands(target.core.namespace).map((command: string) => ({ command, envelope: encodePairCommand({ pairId: PAIR, edgeEpoch: EPOCH }, command) })), localCore: machine.core.socket, peerCore: (offset === 0 ? target : source).core.socket,
        via: join(bin, 'via.mjs'), viaDescriptor: join(suite.root, 'via-i2.json'), viaRoute: join(bin, 'via-i2') };
      await writeFile(descriptor, JSON.stringify(value), { mode: 0o600 }); descriptors.push(descriptor);
      const manager = spawnOwned(suite.ledger, { label: `pair-systemd-${offset + 1}`, command: process.execPath,
        args: [join(bin, 'roam-pair-systemd.mjs'), descriptor], env: machine.env, cwd: suite.root, stdio: { log: join(machineRoot, 'systemd.log') } });
      managers.push(manager);
      await waitFor('owned pair service manager starts', () => existsSync(socket), Boolean, deadline(20_000));
    }
    const map = suite.ownPath(join(suite.root, 'pair-map.json')), cli = suite.ownPath(join(bin, 'pair-cli.mjs'));
    await writeFile(map, JSON.stringify({ root: suite.root, entry: suite.packed.roamCli,
      cli: join(suite.packed.root, 'dist/roam/cli-main.mjs'), machines: [source, target].map((machine, i) => ({ global: machine.global, descriptor: descriptors[i] })) }), { mode: 0o600 });
    await writeFile(cli, `import {run} from ${JSON.stringify(pathToFileURL(join(bin, 'roam-pair-cli.mjs')).href)};\nawait run(${JSON.stringify(map)},process.argv.slice(2));\n`, { mode: 0o700 });
    const peers: Peer[] = [source, target].map(machine => ({ machineId: machine.id, alias: machine.alias, node: process.execPath,
      pi: suite.pi.launcher, cli, core: suite.cores!.wrapper, globalRoot: machine.global }));
    const hubConfig = parseConfig({ ...hub.config, peers });
    await writeFile(join(hub.global, 'roam', 'config.json'), JSON.stringify(hubConfig), { mode: 0o600 });
    for (const [offset, machine] of [source, target].entries()) {
      const recipe = { check: [process.execPath, connector, 'check', descriptors[offset]],
        host: [process.execPath, connector, 'host', '{pairId}', '{remotePort}', descriptors[offset]],
        connect: [process.execPath, connector, 'connect', '{pairId}', '{localPort}', '{remotePort}', descriptors[offset]], localPort };
      const config = parseConfig({ ...machine.config, intercom: { ...machine.config.intercom, connector: recipe,
        routes: machine.config.intercom.routes } });
      await network.restartBox((offset + 1) as 1 | 2, config, descriptors[offset]);
    }
    // The production CLI creates this exact reserved alias; register its ownership before that effect.
    suite.ledger.update(ledger => { ledger.machines.push({ side: source.core.side, name: ALIAS }); });
    const graph = suite.ownPath(join(suite.root, 'pair-graph.json'));
    await writeFile(graph, JSON.stringify({ pairs: [{ pairId: PAIR, source: source.alias, target: target.alias, edgeEpoch: EPOCH,
      connector: { tunnelId: 'fixture-tunnel', session: target.core.namespace, remotePort: hostPort } }] }), { mode: 0o600 });
    if (!targetKeys) throw new HarnessError('fixture-keygen', 'target host keys unavailable');
    const keys = targetKeys;
    return { graph, pairId: PAIR, alias: ALIAS, descriptors, managers, close,
      async presentedKey(value) { await copyFile(value === 'system' ? keys.system : keys.other, keys.served); } };
  } catch (error) { await close(); throw error; }
}

/** Real TTY approval goes to the packaged CLI; the inner child and broker are ledger-owned. */
export async function enrollPair(suite: Suite, network: Network, pair: PairFixture, operationId?: string, attempt?: 'verified' | 'retry'): Promise<{ code: number | null; output: string }> {
  const suffix = attempt ?? (operationId ? 'retry' : 'first');
  const hub = network.machines[0], socket = assertSocketPath(suite.root, join(suite.root, `enroll-${suffix}.sock`));
  const log = suite.ownPath(join(suite.root, `enroll-${suffix}.raw`)), envFile = suite.ownPath(join(suite.root, `enroll-${suffix}-env.json`));
  await writeFile(envFile, JSON.stringify(hub.env), { mode: 0o600 });
  const broker = spawnOwned(suite.ledger, { label: 'pair-enrollment-tty', command: '/usr/bin/python3', args: [fileURLToPath(new URL('../harness/pty-broker.py', import.meta.url)),
    '--socket', socket, '--log', log, '--env-file', envFile, '--', process.execPath, suite.packed.roamCli, 'roam', 'intercom', 'enroll', '--graph', pair.graph,
    ...(operationId ? ['--operation', operationId] : [])],
    env: hub.env, cwd: suite.root, stdio: { log: join(suite.root, `enroll-${suffix}-pty.log`) } });
  try {
    await waitFor('enrollment TTY socket', () => existsSync(socket), Boolean, deadline(20_000));
    const hello = await socketCall(socket, { op: 'hello' });
    if (typeof hello.pid !== 'number' || typeof hello.terminal !== 'string') throw new HarnessError('broker-identity', 'enrollment TTY identity unavailable');
    suite.ledger.update(ledger => { ledger.processes.push({ ...identityOf(hello.pid as number), label: 'pair-enrollment-cli', group: false }); });
    if (!operationId) {
      await waitFor('exact pair consent is presented', async () => await readFile(log, 'utf8'), value => value.includes('Type approve:'), deadline(30_000));
      const sent = await socketCall(socket, { op: 'input', pid: hello.pid, terminal: hello.terminal, data: 'approve\n' });
      if (sent.ok !== true) throw new HarnessError('broker-identity', 'enrollment approval was not delivered');
    }
    await waitFor('packaged enrollment finishes', () => broker.child.exitCode !== null || broker.child.signalCode !== null, Boolean, deadline(120_000));
    const exit = await broker.exited;
    const replies = await readFile(join(suite.root, 'pair-replies.jsonl'), 'utf8').catch(() => '');
    const results = replies.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { at: number; durationMs: number; machineId: string; command: string[]; code?: number; stdout: string; stderr: string; error?: string });
    console.info(JSON.stringify({ story: suite.story, measurement: 'enrollment-helpers', attempt: suffix, code: exit.code,
      results: results.map(row => {
        let reply: { ok?: boolean; reason?: string } = {};
        try { reply = JSON.parse(row.stdout); } catch { /* Preserve non-JSON failures below. */ }
        return { at: row.at, durationMs: row.durationMs, machineId: row.machineId, command: row.command, code: row.code,
          ok: reply.ok, reason: reply.reason, error: row.error, ...(row.code || row.error || reply.ok === false ? { stderr: row.stderr } : {}) };
      }) }));
    return { code: exit.code, output: await readFile(log, 'utf8') };
  } finally { await broker.stop(); }
}
