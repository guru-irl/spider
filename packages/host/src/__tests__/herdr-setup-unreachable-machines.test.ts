// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr, undoHerdrUpgrade } from '../../../herdr/src/setup/installer.js';
import { doctorHerdr } from '../../../herdr/src/setup/doctor.js';
import { readJournal } from '../../../herdr/src/setup/backup.js';
import { cleanup, type SetupFixture } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

const remote = 'remote.invalid';
const unreachable = { stderr: { error: { kind: 'unavailable', message: `cannot reach ${remote}: the connection closed` } }, exitCode: 1 };
const fixture = () => focusedSetupFixture({ coreTransport: 'socket' });

async function sleep(f: SetupFixture) {
  const machines = (await f.h.cli(['machine', 'ls', '--json']) as { machines: { name: string; state: string }[] }).machines;
  cleanup.push(() => f.h.scenario({}));
  await f.h.scenario({ steps: [
    { argvPrefix: ['machine', 'ls'], reply: { machines: machines.map(row => row.name === remote ? { ...row, state: 'disconnected' } : row) } },
    { argvIncludes: ['--on', remote], ...unreachable },
  ] });
}

async function apply(f: SetupFixture) {
  const parts = await f.ports.setupParts(f.request), warnings: string[] = [];
  parts.warn = message => warnings.push(message);
  return { result: await setupHerdr(f.request, parts), warnings };
}

async function remoteCalls(f: SetupFixture, start: number) {
  return (await f.h.calls()).slice(start).map(call => call.argv).filter(argv => argv.includes('--on') && argv.includes(remote));
}

async function omitRemote(f: SetupFixture) {
  const { machines } = await f.h.cli(['machine', 'ls', '--json']) as { machines: { name: string }[] };
  await f.h.scenario({ steps: [{ argvPrefix: ['machine', 'ls'], reply: { machines: machines.filter(row => row.name !== remote) } }] });
}

test('setup rejects a configured machine missing from the core inventory', async () => {
  const f = await fixture();
  await omitRemote(f);
  await expect(apply(f)).rejects.toMatchObject({ code: 'machine-not-found' });
});

test('doctor reports a failure for a configured machine missing from the core inventory', async () => {
  const f = await fixture();
  await sleep(f);
  await apply(f);
  await f.h.scenario({});
  await omitRemote(f);
  const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
  expect(report.failures).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining(remote) })]));
  expect(report.warnings.filter(row => row.code === 'runtime-unavailable')).toEqual([]);
});

test('setup skips a disconnected machine and still installs the local look, keys and mods', async () => {
  const f = await fixture();
  await sleep(f);
  const start = (await f.h.calls()).length;
  const { result, warnings } = await apply(f);
  expect(warnings).toEqual([expect.stringMatching(/remote\.invalid.*next time setup.*reachable/i)]);
  expect(await remoteCalls(f, start)).toEqual([]);
  expect(result.cutover).not.toBeNull();
  expect(result.doctor.failures).toEqual([]);
  const journal = await readJournal(f.request.journalRoot);
  expect(journal).toMatchObject({ verified: true, pendingRuntimes: [remote], runtimes: [] });
  expect(result.writes).toContain(join(f.request.config.app.home, 'keys.json'));
  expect(result.writes).toContain(join(f.request.config.app.home, 'mods/spider-panel/main.js'));
  expect(JSON.parse(await readFile(join(f.request.config.app.home, 'settings.json'), 'utf8'))).toMatchObject({ theme: 'spider-glass', layout: 'spider-glass' });
});

test.each([
  { stage: 'Node version probe', argvPrefix: ['run'], argvIncludes: ['--version'] },
  { stage: 'runtime upload', argvPrefix: ['file', 'write'], argvIncludes: [] },
  { stage: 'runtime bootstrap', argvPrefix: ['run'], argvIncludes: ['--install'] },
])('setup defers a machine that becomes unreachable at the $stage', async ({ argvPrefix, argvIncludes }) => {
  const f = await fixture();
  // The fake inventory still says connected. Only the selected stage fails.
  await f.h.scenario({ steps: [{ argvPrefix, argvIncludes: ['--on', remote, ...argvIncludes], ...unreachable }] });
  const start = (await f.h.calls()).length;
  const { result, warnings } = await apply(f);
  expect(warnings).toEqual([expect.stringContaining(remote)]);
  expect(result.doctor.failures).toEqual([]);
  expect(await readJournal(f.request.journalRoot)).toMatchObject({ verified: true, pendingRuntimes: [remote], runtimes: [] });
  const calls = await remoteCalls(f, start);
  expect(calls.at(-1)?.slice(0, argvPrefix.length)).toEqual(argvPrefix);
  for (const arg of argvIncludes) expect(calls.at(-1)).toContain(arg);
});

test('setup reuses the visible Node check after a failed runtime bootstrap', async () => {
  const f = await fixture();
  await f.h.scenario({ steps: [{ argvPrefix: ['run'], argvIncludes: ['--on', remote, '--install'], stderr: 'permission denied', exitCode: 1 }] });
  const start = (await f.h.calls()).length;
  await expect(apply(f)).rejects.toMatchObject({ code: 'runtime-bootstrap-failed' });
  await f.h.scenario({});
  const { result } = await apply(f);
  expect(result.doctor.failures).toEqual([]);
  const calls = await remoteCalls(f, start);
  expect(calls.filter(argv => argv[0] === 'run' && argv.includes('--version'))).toHaveLength(1);
  expect(calls.filter(argv => argv[0] === 'run' && argv.includes('--install'))).toHaveLength(2);
});

const probeTimeout = { stderr: { error: { kind: 'probe-timeout', message: 'Destination Node probe did not finish' } }, exitCode: 1 };

test('setup retries the runtime install after a root health probe times out', async () => {
  const f = await fixture();
  await apply(f);
  await f.h.scenario({ steps: [{ argvPrefix: ['run'], argvIncludes: ['--on', remote, '--probe'], once: true, ...probeTimeout }] });
  const start = (await f.h.calls()).length;
  const { result, warnings } = await apply(f);
  expect(warnings).toEqual([]);
  expect(result.doctor.failures).toEqual([]);
  expect((await remoteCalls(f, start)).filter(argv => argv.includes('--install'))).toHaveLength(1);
});

test('setup reports a bootstrap timeout without suggesting permission repair', async () => {
  const f = await fixture();
  await apply(f);
  await f.h.scenario({ steps: [
    { argvPrefix: ['run'], argvIncludes: ['--on', remote, '--probe'], once: true, ...probeTimeout },
    { argvPrefix: ['run'], argvIncludes: ['--on', remote, '--install'], ...probeTimeout },
  ] });
  const start = (await f.h.calls()).length;
  const retry = apply(f);
  await expect(retry).rejects.toMatchObject({ code: 'runtime-bootstrap-failed', message: expect.stringMatching(/timed out.*remote\.invalid/i) });
  await expect(retry).rejects.not.toMatchObject({ message: expect.stringMatching(/permission/i) });
  expect((await remoteCalls(f, start)).filter(argv => argv.includes('--install'))).toHaveLength(1);
});

test('setup does not turn a permission error into a skipped runtime', async () => {
  const f = await fixture();
  await f.h.scenario({ steps: [{ argvPrefix: ['file', 'read'], argvIncludes: ['--on', remote],
    stderr: { error: { kind: 'unavailable', message: 'permission denied' } }, exitCode: 1 }] });
  await expect(apply(f)).rejects.toMatchObject({ code: 'unavailable', message: 'permission denied' });
  expect((await readJournal(f.request.journalRoot)).verified).toBe(false);
});

test('setup rejects an existing runtime with the wrong digest', async () => {
  const f = await fixture();
  await f.h.scenario({ steps: [{ argvPrefix: ['file', 'read'], argvIncludes: ['--on', remote], reply: { text: 'wrong runtime bytes' } }] });
  await expect(apply(f)).rejects.toMatchObject({ code: 'runtime-digest-mismatch' });
});

test('setup rejects a failed runtime install', async () => {
  const f = await fixture();
  await f.h.scenario({ steps: [{ argvPrefix: ['run'], argvIncludes: ['--on', remote, '--install'],
    stderr: { error: { kind: 'probe-failed', message: 'Destination probe failed' } }, exitCode: 1 }] });
  await expect(apply(f)).rejects.toMatchObject({ code: 'runtime-bootstrap-failed' });
});

test('setup rejects an unsupported remote Node version', async () => {
  const f = await fixture();
  await f.h.scenario({ steps: [{ argvPrefix: ['read'], reply: { text: 'v16.20.2', complete: true, how: 'history' }, once: true }] });
  await expect(apply(f)).rejects.toMatchObject({ code: 'remote-node-unavailable', message: expect.stringContaining('Unsupported or missing Node version') });
});

test('a later setup installs the deferred runtime without repeating local cutover', async () => {
  const f = await fixture();
  await sleep(f);
  const { result: first } = await apply(f);
  await f.h.scenario({});
  const start = (await f.h.calls()).length;
  const { result: later, warnings } = await apply(f);
  expect(warnings).toEqual([]);
  expect(later.writes).toEqual([]);
  expect(later.cutover).toEqual(first.cutover);
  const installed = await readJournal(f.request.journalRoot);
  expect(installed.pendingRuntimes ?? []).toEqual([]);
  expect(installed.runtimes).toEqual([expect.objectContaining({ machine: remote })]);
  const calls = await remoteCalls(f, start);
  expect(calls.some(argv => argv[0] === 'file' && argv[1] === 'write')).toBe(true);
  expect(calls.some(argv => argv.includes('--install'))).toBe(true);
});

test('doctor warns once for an unreachable runtime and does not probe it', async () => {
  const f = await fixture();
  await apply(f);
  await sleep(f);
  const start = (await f.h.calls()).length;
  const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
  expect(report.failures).toEqual([]);
  expect(report.warnings.filter(row => row.message.includes(remote))).toEqual([
    expect.objectContaining({ repair: expect.stringMatching(/setup.*reachable/i) }),
  ]);
  expect(await remoteCalls(f, start)).toEqual([]);
});

test.each([
  { check: 'Node version probe', flag: '--version' },
  { check: 'runtime root probe', flag: '--probe' },
])('doctor defers a machine that becomes unreachable at the $check', async ({ flag }) => {
  const f = await fixture();
  await apply(f);
  await f.h.scenario({ steps: [{ argvPrefix: ['run'], argvIncludes: ['--on', remote, flag], ...unreachable }] });
  const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
  expect(report.failures).toEqual([]);
  expect(report.deferredRuntimes).toEqual([remote]);
  expect(report.warnings.filter(row => row.code === 'runtime-unavailable')).toEqual([
    expect.objectContaining({ message: expect.stringContaining(remote) }),
  ]);
});

test('doctor warns about a pending runtime even after the machine reconnects', async () => {
  const f = await fixture();
  await sleep(f);
  await apply(f);
  await f.h.scenario({});
  const start = (await f.h.calls()).length;
  const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
  expect(report.failures).toEqual([]);
  expect(report.warnings.filter(row => row.message.includes(remote))).toEqual([
    expect.objectContaining({ repair: expect.stringMatching(/setup.*reachable/i) }),
  ]);
  expect(await remoteCalls(f, start)).toEqual([]);
});

test('an upgrade preserves the sleeping runtime entry and undo restores the prior journal', async () => {
  const f = await fixture();
  await apply(f);
  const journalPath = join(f.request.journalRoot, 'journal.json');
  const previous = await readFile(journalPath);
  const oldRuntimes = (await readJournal(f.request.journalRoot)).runtimes;
  const packagedMod = join(f.root, 'packages/herdr/assets/mods/spider/main.js');
  await writeFile(packagedMod, (await readFile(packagedMod, 'utf8')) + '\n// upgraded mod\n');
  const artifact = join(f.root, 'dist/herdr/remote-runtime.mjs');
  await writeFile(artifact, (await readFile(artifact, 'utf8')) + '\n// upgraded runtime\n');
  await sleep(f);
  const start = (await f.h.calls()).length;
  await apply(f);
  expect(await readJournal(f.request.journalRoot)).toMatchObject({ pendingRuntimes: [remote], runtimes: oldRuntimes });
  const undone = await undoHerdrUpgrade(f.request, await f.ports.setupParts(f.request));
  expect(undone.restored).toContain(journalPath);
  expect(undone.remoteNotRestored).toEqual([]);
  expect(await readFile(journalPath)).toEqual(previous);
  expect(await remoteCalls(f, start)).toEqual([]);
});
