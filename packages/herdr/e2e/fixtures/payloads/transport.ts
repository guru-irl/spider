// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, stat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RemoteStory } from './story.js';
import type { Suite } from '../../harness/suite.js';
import { configChanged, deadline, waitFor } from './story.js';
import { shellQuote, readDestination } from './index.js';
import { destinationPath, assertDestinationPaths } from '../../harness/destination.js';

export interface FaultOptions {
  id: string; mode: 'drop-reply' | 'reject' | 'corrupt-read' | 'hold' | 'wrong-version'; match: string[]; contains?: string; containsSuffix?: string; deferred?: boolean; scope?: string;
}
export interface FaultHandle {
  binary: string; config: string; log: string; readyPath: string; releasePath: string;
  ready(): Promise<{ nonce: string; argv: string[]; pid: number }>;
  release(): Promise<void>;
  records(): Promise<Record<string, any>[]>;
  enable(exactTargetPath: string): Promise<void>;
}
export async function stageFault(suite: Suite, options: FaultOptions, real: string = suite.cores!.wrapper): Promise<FaultHandle> {
  assert.match(options.id, /^[a-z0-9-]+$/); suite.ownPath(real);
  const config = suite.ownPath(join(suite.root, `fault-${options.id}.json`)), binary = suite.ownPath(join(suite.root, 'bin', `hc-${options.id}`));
  const log = suite.ownPath(join(suite.root, `fault-${options.id}.jsonl`)), readyPath = suite.ownPath(join(suite.root, `f-${options.id}-ready`));
  const releasePath = suite.ownPath(join(suite.root, `f-${options.id}-release`)), nonce = randomBytes(16).toString('hex');
  const configuration = { ...options, match: options.deferred ? ['unarmed'] : options.match, root: suite.root, real, log, once: join(suite.root, `fault-${options.id}.claimed`),
    ...(options.mode === 'hold' ? { gate: { ready: readyPath, release: releasePath, nonce, deadlineAt: Date.now() + 90000 } } : {}) };
  await writeFile(config, JSON.stringify(configuration), { mode: 0o600 });
  await writeFile(binary, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL('../transport-faults.mjs', import.meta.url)))} ${shellQuote(config)} "$@"\n`, { mode: 0o700 });
  return {
    binary, config, log, readyPath, releasePath,
    async enable(exactTargetPath) {
      await assertDestinationPaths(suite, [exactTargetPath]);
      const next = { ...configuration, match: options.match, containsSuffix: exactTargetPath, ...(configuration.gate ? { gate: { ...configuration.gate, deadlineAt: Date.now() + 90000 } } : {}) };
      await writeFile(config + '.new', JSON.stringify(next), { mode: 0o600 }); await rename(config + '.new', config);
    },
    async ready() {
      await waitFor('owned transport held acknowledgement', () => stat(readyPath).then(s => s.isFile(), () => false), Boolean, deadline(30000));
      const value = JSON.parse(await readFile(readyPath, 'utf8')); assert.equal(value.nonce, nonce);
      await suite.evidence(`${options.id}-transport-ready.json`, value); return value;
    },
    release: () => writeFile(releasePath, JSON.stringify({ nonce }), { mode: 0o600 }),
    records: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}
export async function armFault(story: RemoteStory, options: FaultOptions): Promise<FaultHandle> {
  const fault = await stageFault(story.suite, options);
  story.config.core.binary = fault.binary; await configChanged(story); return fault;
}
/** Read a real consumer journal only to locate test-owned transport files; never use its phase as a success oracle. */
export async function payloadTransport(story: RemoteStory, payloadConfigPath: string): Promise<{ id: string; address: string; remoteDirectory: string }> {
  const path = join(story.suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/jobs/sessions', story.sessionId, 'jobs.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  await story.suite.evidence('transport-journal.json', journal);
  const rows = journal.jobs as { id: string; remoteDirectory: string; updatedAt: number; phase: { address?: string } }[];
  assert.ok(Array.isArray(rows) && rows.length > 0);
  const matches: { id: string; address: string; remoteDirectory: string }[] = [];
  for (const row of rows) {
    if (!row.phase.address?.startsWith(story.machine + '/')) continue;
    const remoteDirectory = destinationPath(story.suite, row.remoteDirectory);
    const bytes = await readDestination(story.suite, story.machine, join(remoteDirectory, 'request.json'));
    if (!bytes) continue;
    const request = JSON.parse(bytes) as { files: { path: string }[] };
    for (const file of request.files.filter(f => f.path.endsWith('.sh'))) {
      const source = await readDestination(story.suite, story.machine, file.path);
      if (source?.includes(payloadConfigPath)) { matches.push({ id: row.id, address: row.phase.address, remoteDirectory }); break; }
    }
  }
  assert.equal(matches.length, 1, 'one actual uploaded payload config identifies the target job');
  return matches[0];
}
