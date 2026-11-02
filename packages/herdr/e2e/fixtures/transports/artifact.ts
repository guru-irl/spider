// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { listenCoreIdentity } from './live-socket.js';
import type { Suite, InvokeResult } from '../../harness/suite.js';
import type { OwnedPath } from '../../harness/environment.js';

export interface ArtifactTransport {
  root: OwnedPath; bin: string; sentinel: string; log: string; cache: string;
  env: Record<string, string>; records(): Promise<{ argv: string[] }[]>;
  valid(): Promise<void>; expired(): Promise<void>; malformed(): Promise<void>; close(): Promise<void>;
  run(argv: string[], extra?: Record<string, string>): Promise<InvokeResult>;
}

export async function artifactTransport(suite: Suite): Promise<ArtifactTransport> {
  const root = suite.ownPath(join(suite.root, 'ssh-artifact'));
  const bin = join(root, 'bin');
  const sentinel = join(root, 'transport');
  const log = join(root, 'transport.jsonl');
  const cache = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/ssh/fixture.json');
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await mkdir(join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/ssh'), { recursive: true, mode: 0o700 });
  await copyFile(resolve('packages/herdr/e2e/fixtures/transports/ssh-sentinel.mjs'), sentinel);
  await chmod(sentinel, 0o700);
  // --ssh-shim checks this path's identity. The direct entry tests never execute it.
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nexit 90\n', { mode: 0o700 });
  const identity = { coreId: 'fixture-core', socket: join(suite.root, 'ssh.sock'), sessionNamespace: 'fixture' };
  const snapshot = (fetchedAt: number) => ({ version: 1, identity, fetchedAt, machines: [{ id: 'm1', name: 'managed.invalid', targets: ['managed.invalid', 'alias.invalid'] }] });
  const descriptor = JSON.stringify({ shimDirectory: bin, realSshBinary: sentinel, shimProgram: suite.packed.cli, cacheDescriptor: { path: cache, identity } });
  const env = { ...suite.env, SPIDER_HERDR_SSH_DESCRIPTOR: descriptor, FIXTURE_TRANSPORT_LOG: log };
  const records = async (): Promise<{ argv: string[] }[]> => {
    try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const alive = await listenCoreIdentity(suite, identity.socket);
  return {
    close: () => alive.close(), root, bin, sentinel, log, cache, env, records,
    valid: () => writeFile(cache, JSON.stringify(snapshot(Date.now())), { mode: 0o600 }),
    expired: () => writeFile(cache, JSON.stringify(snapshot(Date.now() - 180_000)), { mode: 0o600 }),
    malformed: () => writeFile(cache, '{not json', { mode: 0o600 }),
    run: (argv: string[], extra: Record<string, string> = {}) => suite.invoke(process.execPath, [suite.packed.cli, '--ssh-shim', ...argv], { ...env, ...extra }),
  };
}
