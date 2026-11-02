// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureRoot } from '../environment.js';

const guardian = fileURLToPath(new URL('../../fixtures/remote-guardian.mjs', import.meta.url));
const scope = { roots: ['/owned-fixture'], namespaces: ['e-owned'], coreIds: ['owned-core'], runIds: ['owned-run'], jobIds: ['owned-job'] };
const row = (labels: Record<string, string>, argv = ['/bin/node', '/other/job.js'], cwd = '/other') => ({ labels, argv, cwd, identity: 'fixture' });

it('records foreign additions and updates without failing the default-core check', async () => {
  const helper = await import(/* @vite-ignore */ guardian);
  expect(helper.assessDefaultInventory).toBeTypeOf('function');
  const root = await createFixtureRoot(), state = join(root, 'state/herdr-core/default');
  await mkdir(state, { recursive: true });
  const core = { socket: join(root, 'absent.sock'), env: { HOME: root, XDG_STATE_HOME: join(root, 'state') }, wasListening: false };
  try {
    await writeFile(join(state, 'terminals.json'), JSON.stringify({ terminals: { '1': row({ 'spider.owner-core': 'foreign-core' }) } }));
    const before = await helper.defaultInventory(core, scope);
    await writeFile(join(state, 'terminals.json'), JSON.stringify({ terminals: { '1': row({ 'spider.owner-core': 'foreign-core' }, ['/bin/changed']), '2': row({ 'spider.owner-core': 'another-core' }) } }));
    const after = await helper.defaultInventory(core, scope);
    const assessment = helper.assessDefaultInventory(before, after, scope);
    expect(assessment.clean).toBe(true);
    expect(assessment.foreignActivity).toEqual(expect.arrayContaining([expect.objectContaining({ id: '1' }), expect.objectContaining({ id: '2' })]));
    expect(JSON.stringify(after)).not.toContain('foreign-core');
    await writeFile(join(state, 'terminals.json'), JSON.stringify({ terminals: { '2': row({ 'spider.owner-core': 'another-core' }) } }));
    expect(helper.assessDefaultInventory(after, await helper.defaultInventory(core, scope), scope)).toMatchObject({ clean: true, foreignActivity: expect.arrayContaining([expect.objectContaining({ id: '1', kind: 'removed' })]) });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('projects machine inventory without exposing its contents when terminals are absent', async () => {
  const helper = await import(/* @vite-ignore */ guardian);
  const root = await createFixtureRoot(), state = join(root, 'state/herdr-core/default');
  await mkdir(state, { recursive: true });
  try {
    await writeFile(join(state, 'machines.json'), JSON.stringify({ machines: [{ target: 'private-marker' }] }));
    const value = await helper.defaultInventory({ socket: join(root, 'absent.sock'), env: { HOME: root, XDG_STATE_HOME: join(root, 'state') }, wasListening: false }, scope);
    expect(value.machines).toMatchObject({ present: true, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), ownedPath: false });
    expect(JSON.stringify(value)).not.toContain('private-marker');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('collects fixture identities and marks a truncated session feed incomplete', async () => {
  const module = await import('../remote.js') as Record<string, unknown>;
  expect(module.ownedJournalIds).toBeTypeOf('function');
  const collect = module.ownedJournalIds as (root: string) => Promise<{ sessionIds: string[]; runIds: string[]; jobIds: string[]; terminalIds: string[]; identitiesComplete: boolean }>;
  const root = await createFixtureRoot();
  try {
    const jobs = join(root, 'herdr/jobs/sessions/session'), feed = join(root, 'herdr/sessions/session');
    await mkdir(jobs, { recursive: true }); await mkdir(feed, { recursive: true });
    await writeFile(join(jobs, 'jobs.json'), JSON.stringify({ version: 1, sessionId: 'session', jobs: [{ id: 'job-owned', runId: 'run-owned', owner: { sessionId: 'session' }, phase: { address: 'alpha/t4' } }] }));
    await writeFile(join(feed, 'session.json'), JSON.stringify({ sessionId: 'session', runs: { rows: [{ id: 'run-other' }], truncated: false } }));
    expect(await collect(root)).toMatchObject({ sessionIds: ['session'], runIds: expect.arrayContaining(['run-owned', 'run-other']), jobIds: ['job-owned'], terminalIds: ['t4'], identitiesComplete: true });
    await writeFile(join(feed, 'session.json'), JSON.stringify({ sessionId: 'session', runs: { rows: [], truncated: true } }));
    expect((await collect(root)).identitiesComplete).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('writes the complete cleanup proof when a shared inventory exceeds the pipe buffer', async () => {
  const helper = await import(/* @vite-ignore */ guardian);
  const root = await createFixtureRoot(), state = join(root, 'state/herdr-core/default');
  await mkdir(state, { recursive: true });
  const core = { socket: join(root, 'absent.sock'), env: { HOME: root, XDG_STATE_HOME: join(root, 'state') }, wasListening: false };
  const terminals = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [String(i), row({ 'spider.owner-core': `foreign-${i}` })]));
  await writeFile(join(state, 'terminals.json'), JSON.stringify({ terminals }));
  const before = await helper.defaultInventory(core, scope), ledger = join(root, 'ledger.json'), lease = join(root, 'lease.json');
  await writeFile(ledger, JSON.stringify({ version: 1, id: 'large-proof', root, state: 'open', processes: [], cores: [], defaultCore: core, defaultBefore: before, ownership: scope }));
  await writeFile(lease, JSON.stringify({ version: 1, expiresAt: 0 }));
  const child = spawn(process.execPath, [guardian, ledger, lease, '--remove-root'], { env: { PATH: process.env.PATH, TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  try {
    const exit = await new Promise<number | null>(resolve => child.once('close', resolve));
    expect(exit, err).toBe(0);
    expect(Buffer.byteLength(out)).toBeGreaterThan(65536);
    const line = out.split('\n').find(value => value.startsWith('{'))!;
    expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(line)).toMatchObject({ clean: true, rootRemoved: true });
  } finally { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});

it('fails for harness-owned labels or paths and unproved pre-existing removals', async () => {
  const helper = await import(/* @vite-ignore */ guardian);
  expect(helper.assessDefaultInventory).toBeTypeOf('function');
  const root = await createFixtureRoot(), state = join(root, 'state/herdr-core/default');
  await mkdir(state, { recursive: true });
  const core = { socket: join(root, 'absent.sock'), env: { HOME: root, XDG_STATE_HOME: join(root, 'state') }, wasListening: false };
  try {
    await writeFile(join(state, 'terminals.json'), JSON.stringify({ terminals: { 'old': row({}) } }));
    const before = await helper.defaultInventory(core, scope);
    for (const owned of [row({ 'spider.owner-core': 'owned-core' }), row({ 'spider.run': 'owned-run' }), row({ 'spider.job': 'owned-job' }), row({}, ['/bin/node', '/owned-fixture/job.js']), row({}, ['/bin/node'], '/owned-fixture/work')]) {
      await writeFile(join(state, 'terminals.json'), JSON.stringify({ terminals: { old: row({}), added: owned } }));
      const after = await helper.defaultInventory(core, scope);
      expect(helper.assessDefaultInventory(before, after, scope).clean).toBe(false);
    }
    await writeFile(join(state, 'terminals.json'), JSON.stringify({ terminals: {} }));
    expect(helper.assessDefaultInventory(before, await helper.defaultInventory(core, scope), scope).clean).toBe(false);
    await writeFile(join(state, 'terminals.json'), JSON.stringify({ terminals: { '4': row({ 'spider.owner-core': 'foreign-core' }) } }));
    const reachable = await helper.defaultInventory(core, scope);
    await writeFile(join(state, 'terminals.json'), JSON.stringify({ terminals: {} }));
    expect(helper.assessDefaultInventory(reachable, await helper.defaultInventory(core, scope), { ...scope, terminalIds: ['4'] }).clean).toBe(false);
    expect(helper.assessDefaultInventory(reachable, await helper.defaultInventory(core, scope), { ...scope, identitiesComplete: false }).clean).toBe(false);
    await writeFile(join(state, 'terminals.json'), JSON.stringify({ terminals: { added: row({ 'spider.owner-core': 'foreign-core', 'spider.run': 'unknown-run' }) } }));
    expect(helper.assessDefaultInventory({ ...before, terminals: [] }, await helper.defaultInventory(core, scope), { ...scope, identitiesComplete: false }).clean).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
