// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { migrate, openDb } from '@spider/db-core';
import { createExportPolicy } from '@spider/db-core/roam/event-policy';
import { exportBatch } from '@spider/db-core/roam/export';
import { writeLocal } from '@spider/db-core/roam/local-state';
import { mapWorkspace } from '@spider/db-core/roam/repo-map';
import { seedSession } from '@spider/db-core/roam/seed';
import { DEFAULT_LIMITS } from '@spider/roam/contracts';
import { createHomeStore } from '@spider/roam/relocate/home';
import type { RelocateId, RunningHome, SessionId, SessionPlacement } from '@spider/roam/relocate/types';
import { readLocalIdentity } from '@spider/roam/runtime';
import { createStorePort } from '@spider/roam/stores';
import { inspectIdLock } from '../../src/sessions/id-lock.js';
import { createSessionLeases } from '../../src/sessions/lease.js';
import { mark, text } from '../fixtures/child-scripts.js';
import { registerScenarios, storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import { deadline, waitFor } from '../harness/wait.js';

const HUB = '00000000-0000-4000-8000-000000000001';
const BOX = '00000000-0000-4000-8000-000000000002';
const REPO = '00000000-0000-4000-8000-000000000003';
const WORKSPACE = '00000000-0000-4000-8000-000000000004';
const WORKTREE = `worktree:${REPO}:${WORKSPACE}` as const;

async function copiedFile(suite: Suite): Promise<void> {
  const hub = suite.directories.SPIDER_GLOBAL_ROOT, hubAgent = suite.directories.PI_CODING_AGENT_DIR;
  const box = suite.ownPath(join(suite.root, 'bg')), boxAgent = suite.ownPath(join(suite.root, 'ba'));
  const hubCwd = await suite.project('copy'), boxCwd = await suite.project('owner');
  const sessionId = randomUUID() as SessionId, moveId = `v0-${randomUUID()}` as RelocateId;
  for (const agent of [hubAgent, boxAgent]) await mkdir(join(agent, 'sessions'), { recursive: true, mode: 0o700 });
  for (const name of ['settings.json', 'models.json']) await copyFile(join(hubAgent, name), join(boxAgent, name));
  suite.ledger.update(ledger => { (ledger.intercomDirectories ??= []).push(join(boxAgent, 'intercom')); });
  for (const [root, machineId] of [[hub, HUB], [box, BOX]] as const) {
    await mkdir(join(root, 'roam'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'roam', 'machine.json'), JSON.stringify({ machineId }), { mode: 0o600 });
    await writeFile(join(root, 'roam', 'config.json'), JSON.stringify({ enabled: true,
      role: machineId === HUB ? 'hub' : 'box', machineId, hubMachineId: HUB, peers: [], coreUnit: 'fixture.service' }), { mode: 0o600 });
    const db = openDb(join(root, 'spider.db'));
    try {
      migrate(db, 'global', { machineId, globalRoot: root });
      db.prepare("UPDATE roam_meta SET store_key='global' WHERE id=1").run();
    } finally { db.close(); }
  }
  await copyFile(join(hub, 'config.json'), join(box, 'config.json'));
  const hubProject = join(hubCwd, '.spider', 'project.db');
  await mkdir(join(hubCwd, '.spider'), { mode: 0o700 });

  const file = join(boxAgent, 'sessions', `${sessionId}.jsonl`);
  await writeFile(file, [
    { type: 'session', version: 3, id: sessionId, cwd: boxCwd, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'message', id: 'seed', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'fixture history', timestamp: 1 } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  const hubDb = openDb(join(hub, 'spider.db'));
  let away: RunningHome;
  // Exercise the real home commit and away fence. The story starts after the
  // workspace transfer; the box is given the resulting local replica.
  try {
    const homes = createHomeStore({ db: hubDb, hubMachineId: HUB, localMachineId: HUB });
    const original = await homes.initialize(sessionId, HUB);
    const moving = { ...original, state: 'moving', destination: BOX, moveId, epoch: original.epoch + 1 } as const;
    away = { ...moving, state: 'running', machineId: BOX, destination: null, epoch: moving.epoch + 1 };
    expect(await homes.compareAndSwap(original, moving)).toMatchObject({ kind: 'applied' });
    expect(await homes.compareAndSwap(moving, away)).toEqual({ kind: 'applied', home: away });
  } finally { hubDb.close(); }
  const boxDb = openDb(join(box, 'spider.db'));
  try {
    // The box receives the worktree batch, then maps the replica into its checkout.
    const source = openDb(hubProject);
    try {
      migrate(source, 'worktree', { machineId: HUB, globalRoot: hub });
      // Stand in for the source Pi's startup row (packages/host/src/hooks.ts:149).
      source.prepare('INSERT INTO sessions(id,started_at) VALUES (?,1)').run(sessionId);
      seedSession(source, sessionId, 1, WORKTREE, DEFAULT_LIMITS.hardBatchBytes);
      const batch = await exportBatch(source, { after: 0, targetBytes: DEFAULT_LIMITS.targetBatchBytes, batchId: randomUUID() },
        createExportPolicy((_file, machineId) => ({ machineId, reference: 'unavailable' })));
      try {
        const incoming = createStorePort(readLocalIdentity(box), boxDb, { unmappedWorktree: WORKTREE });
        try { await incoming.accept(WORKTREE, batch); }
        finally { incoming.close(); }
      } finally { await unlink(batch.file); }
    } finally { source.close(); }
    await mapWorkspace(boxDb, { repoKey: REPO, workspaceId: WORKSPACE, path: boxCwd });
    boxDb.prepare('INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,?,?,?,?,?)')
      .run(sessionId, BOX, away.epoch, moveId, away.updatedAt, away.state, away.destination);
    const placement: SessionPlacement = { sessionId, machineId: BOX, historyMachine: HUB, repoKey: REPO,
      workspaceId: WORKSPACE, repository: boxCwd, cwd: boxCwd, file, stores: ['global', WORKTREE] };
    writeLocal(boxDb, 'relocate-managed', sessionId, placement);
  } finally { boxDb.close(); }

  const owner = await suite.launchPi({ mode: 'rpc', cwd: boxCwd, args: ['--session', file],
    extraEnv: { SPIDER_GLOBAL_ROOT: box, PI_CODING_AGENT_DIR: boxAgent, PI_CODING_AGENT_SESSION_DIR: join(boxAgent, 'sessions') } });
  try {
    if (owner.mode !== 'rpc') throw Error('RPC driver required');
    const lock = (root: string) => inspectIdLock(join(root, 'herdr'), sessionId);
    await waitFor('the v0 box owner claims the session ID', () => lock(box), row => row?.identity.pid === owner.pid, deadline(30_000));
    expect(await owner.prompt(mark('probe'))).toMatchObject({ type: 'agent_settled' });
    expect((await createSessionLeases(join(box, 'herdr')).get(file))?.pid).toBe(owner.pid);
    const copied = join(hubAgent, 'sessions', 'copied.jsonl');
    await copyFile(file, copied);
    const ordinaryEntries = (bytes: string) => bytes.trimEnd().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'message' || row.type === 'custom');
    const portableState = () => {
      const db = openDb(hubProject);
      try { return Object.fromEntries(['sessions', 'todos', 'runs', 'run_events', 'events'].map(table => [table,
        db.prepare(`SELECT * FROM ${table} WHERE ${table === 'sessions' ? 'id' : 'session_id'}=? ORDER BY id`).all(sessionId)])); }
      finally { db.close(); }
    };
    const before = ordinaryEntries(await readFile(copied, 'utf8')), beforeRows = portableState(), ownerLock = await lock(box);
    const refused = await suite.launchPi({ mode: 'rpc', cwd: hubCwd, args: ['--session', copied] });
    try {
      if (refused.mode !== 'rpc') throw Error('RPC driver required');
      const response = await refused.rpc({ type: 'prompt', message: mark('probe') });
      expect(response.data).toMatchObject({ disposition: 'handled' });
      expect((await refused.events()).filter(row => row.type === 'tool_execution_start' || row.type === 'message_end' && row.role === 'assistant')).toEqual([]);
      expect(ordinaryEntries(await readFile(copied, 'utf8'))).toEqual(before);
      const forbidden = suite.ownPath(join(suite.root, 'nonowner-tool-effect'));
      const toolResponse = await refused.rpc({ type: 'bash', command: `printf forbidden > '${forbidden.replaceAll("'", "'\\''")}'` });
      expect(toolResponse.data).toMatchObject({ exitCode: 1 });
      expect(existsSync(forbidden)).toBe(false);
      expect(portableState()).toEqual(beforeRows);
      expect(await lock(hub)).toBeNull();
      expect(await lock(box)).toEqual(ownerLock);
      expect((await createSessionLeases(join(box, 'herdr')).get(file))?.pid).toBe(owner.pid);
      const db = openDb(join(hub, 'spider.db'));
      try { expect(await createHomeStore({ db, hubMachineId: HUB, localMachineId: HUB }).read(sessionId)).toEqual(away); }
      finally { db.close(); }
      expect(portableState().runs).toEqual([]);
      await suite.evidence('R10-admission.json', { sessionId, copied, response, toolResponse, owner: ownerLock, home: away });
    } finally { await refused.close(); }
  } finally { await owner.close(); }
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('R10'), title: 'copied v0 away home refuses ordinary work', tiers: ['headless'],
    script: { scripts: { probe: [text('owned v0 session responds')] } }, run: copiedFile },
];
registerScenarios(scenarios);
