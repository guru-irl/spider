// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createProcessInventory, isPiProcessRow } from '../ports.js';
import { FIXTURE_PROCESS_DOMAIN_ENV, fixtureProcessDomain } from '../fixture-process-domain.js';
import { processStartTime } from '../../../../subagents/src/process-identity.js';

const checkout = process.env.SPIDER_TEST_FIXTURE_CHECKOUT!;
const base = resolve(checkout, '.spider/scratch/fpd', String(process.pid));
const domain = join(base, 'domain'), manifest = join(domain, 'manifest.json'), inventoryRoot = join(domain, 'g', 'herdr');
const decoys: ChildProcess[] = [];
function codeOf(run: () => unknown): string | undefined { try { run(); return undefined; } catch (error) { return (error as { code?: string }).code; } }

/** A same-user process whose title is `pi`, like every real pi session. */
async function piTitled(): Promise<number> {
  const child = spawn(process.execPath, ['-e', "process.title = 'pi'; process.stdout.write('ok'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  decoys.push(child);
  await new Promise<void>(r => child.stdout!.once('data', () => r()));
  return child.pid!;
}
function psPiProcesses(): number[] {
  const out = execFileSync('ps', ['-U', String(process.getuid!()), '-o', process.platform === 'darwin' ? 'pid=,comm=,ucomm=,args=' : 'pid=,comm=,comm=,args='], { encoding: 'utf8' });
  return out.split('\n').flatMap(line => {
    const [pid, command, nativeName, executable, entry] = line.trim().split(/\s+/);
    const name = command?.split('/').at(-1);
    const direct = name === 'pi' || name === 'pi-coding-agent';
    let binary = nativeName;
    if (process.platform === 'linux') {
      try { binary = readlinkSync(`/proc/${pid}/exe`); } catch { binary = executable; }
    }
    const nodeCli = ['node', 'nodejs'].includes(binary?.split('/').at(-1) ?? '') && /\/pi-coding-agent\/dist\/(?:bundle\/)?cli\.m?js$/.test(entry ?? '');
    return direct || nodeCli ? [Number(pid)] : [];
  });
}
function psRows(pids: number[]): string {
  try { return execFileSync('ps', ['-p', pids.join(','), '-o', process.platform === 'darwin' ? 'pid=,comm=,ucomm=,args=' : 'pid=,comm=,args='], { encoding: 'utf8' }); }
  catch (error) { return `ps unavailable for ${pids.join(',')}: ${String(error)}`; }
}
function register(pid: number, start = processStartTime(pid)): void {
  mkdirSync(join(domain, 'procs'), { recursive: true, mode: 0o700 });
  writeFileSync(join(domain, 'procs', `${pid}.json`), JSON.stringify({ version: 1, pid, start }), { mode: 0o600 });
}
function writeManifest(value: unknown = { version: 1, root: domain }, mode = 0o600): void { writeFileSync(manifest, JSON.stringify(value), { mode }); chmodSync(manifest, mode); }

beforeAll(() => { mkdirSync(inventoryRoot, { recursive: true, mode: 0o700 }); writeManifest(); });
afterAll(() => { for (const d of decoys) d.kill('SIGKILL'); rmSync(base, { recursive: true, force: true }); });

it('classifies process rows by executable and CLI entry without mistaking viewers for pi', () => {
  const cli = '/opt/pi-coding-agent/dist/cli.js', bundle = '/opt/pi-coding-agent/dist/bundle/cli.mjs';
  expect([
    isPiProcessRow('linux', { title: 'MainThread', executable: '/opt/node/bin/node', args: `/opt/node/bin/node ${cli}` }),
    isPiProcessRow('linux', { title: 'MainThread', executable: '/opt/node/bin/node', args: `renamed ${cli}` }),
    isPiProcessRow('linux', { title: 'MainThread', executable: '', args: `/usr/bin/node ${bundle}` }),
    isPiProcessRow('linux', { title: 'MainThread', executable: '/usr/bin/node', args: '/usr/bin/node /opt/viewer.js --pi-root /opt/pi-coding-agent' }),
    isPiProcessRow('linux', { title: 'MainThread', executable: '/usr/bin/python', args: `/usr/bin/node ${cli}` }),
    isPiProcessRow('darwin', { title: 'MainThread', executable: '/usr/local/bin/node', args: `/usr/local/bin/node ${bundle}` }),
    isPiProcessRow('darwin', { title: 'node', executable: '/usr/bin/python', args: `/usr/bin/node ${cli}` }),
    isPiProcessRow('linux', { title: 'pi', executable: '/usr/bin/node', args: 'pi' }),
    isPiProcessRow('darwin', { title: 'pi-coding-agent', executable: '/usr/bin/node', args: 'pi-coding-agent' }),
  ]).toEqual([true, true, true, false, false, true, false, true, true]);
});

describe('default production inventory (no fixture domain)', () => {
  it('still inventories every same-user pi process, including ones it did not start', async () => {
    const env = { ...process.env }; delete env[FIXTURE_PROCESS_DOMAIN_ENV];
    expect(fixtureProcessDomain(inventoryRoot, env)).toBeNull();
    const decoy = await piTitled();
    const unrelated = spawn(process.execPath, ['-e', "process.stdout.write('ok'); setInterval(() => {}, 1000)", 'pi-coding-agent'], { stdio: ['ignore', 'pipe', 'ignore'] });
    decoys.push(unrelated); await new Promise<void>(resolve => unrelated.stdout!.once('data', () => resolve()));
    const before = new Set(psPiProcesses());
    const listed = (await createProcessInventory(inventoryRoot).processes()).map(p => p.pid);
    const after = new Set(psPiProcesses());
    expect(listed).toContain(decoy);
    expect(before.has(unrelated.pid!)).toBe(false);
    expect(listed).not.toContain(unrelated.pid!);
    // Every pi process present for the whole observation is listed; nothing outside ps's view is invented.
    for (const pid of before) if (after.has(pid)) expect(listed).toContain(pid);
    for (const pid of listed) expect(before.has(pid) || after.has(pid)).toBe(true);
    expect(listed.length).toBeGreaterThanOrEqual(1);
  });
});

it.each(['dist/cli.js', 'dist/bundle/cli.mjs'])('distinguishes a node-hosted %s from a viewer with a pi-root argument', async entry => {
  const piRoot = join(base, 'pi-coding-agent'), cli = join(piRoot, entry), viewer = join(base, 'viewer.js');
  mkdirSync(join(cli, '..'), { recursive: true });
  const program = "process.stdout.write('ok'); setInterval(() => {}, 1000)";
  writeFileSync(cli, program); writeFileSync(viewer, program);
  const start = async (argv: string[]) => {
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'ignore'] });
    decoys.push(child); await new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
    return child.pid!;
  };
  const pi = await start([cli]), notPi = await start([viewer, '--pi-root', piRoot]);
  const listed = (await createProcessInventory(inventoryRoot).processes()).map(process => process.pid);
  const rows = `ps rows for ${pi} and ${notPi}:\n${psRows([pi, notPi])}`;
  expect(listed, rows).toContain(pi);
  expect(listed, rows).not.toContain(notPi);
  expect(psPiProcesses(), rows).toContain(pi);
  expect(psPiProcesses(), rows).not.toContain(notPi);
});

describe('fixture process domain', () => {
  it('selects only registered pi processes whose OS start identity still matches', async () => {
    const owned = await piTitled(), foreign = await piTitled(), reused = await piTitled();
    register(owned); register(reused, 'posix:Thu Jan  1 00:00:00 1970');
    const env = { ...process.env, [FIXTURE_PROCESS_DOMAIN_ENV]: manifest };
    const listed = await fixtureProcessDomain(inventoryRoot, env)!.processes();
    expect(listed).toEqual([{ pid: owned, startIdentity: processStartTime(owned), classification: 'pi' }]);
    expect(listed.map(p => p.pid)).not.toContain(foreign);
    // Through the production port: the same selection, and the domain stays blocking for its own unknown pi.
    const prior = process.env[FIXTURE_PROCESS_DOMAIN_ENV];
    process.env[FIXTURE_PROCESS_DOMAIN_ENV] = manifest;
    try { expect((await createProcessInventory(inventoryRoot).processes()).map(p => p.pid)).toEqual([owned]); }
    finally { if (prior === undefined) delete process.env[FIXTURE_PROCESS_DOMAIN_ENV]; else process.env[FIXTURE_PROCESS_DOMAIN_ENV] = prior; }
  });

  it('fails closed on every unproved configuration instead of falling back', () => {
    const env = (extra: Record<string, string | undefined>) => ({ ...process.env, [FIXTURE_PROCESS_DOMAIN_ENV]: manifest, ...extra });
    expect(codeOf(() => fixtureProcessDomain(inventoryRoot, env({ SPIDER_TEST_FIXTURE_CHECKOUT: undefined })))).toBe('fixture-process-domain-unfenced');
    expect(codeOf(() => fixtureProcessDomain(inventoryRoot, env({ [FIXTURE_PROCESS_DOMAIN_ENV]: 'relative.json' })))).toBe('fixture-process-domain-invalid');
    expect(codeOf(() => fixtureProcessDomain(join(base, 'elsewhere'), env({})))).toBe('fixture-process-domain-outside');
    expect(codeOf(() => fixtureProcessDomain('/var/empty/herdr', env({})))).toBe('fixture-process-domain-outside');
    writeManifest(undefined, 0o644);
    expect(codeOf(() => fixtureProcessDomain(inventoryRoot, env({})))).toBe('fixture-process-domain-not-private');
    writeFileSync(manifest, '{not json', { mode: 0o600 }); chmodSync(manifest, 0o600);
    expect(codeOf(() => fixtureProcessDomain(inventoryRoot, env({})))).toBe('fixture-process-domain-invalid');
    writeManifest({ version: 1, root: base });
    expect(codeOf(() => fixtureProcessDomain(inventoryRoot, env({})))).toBe('fixture-process-domain-invalid');
    writeManifest();
    const link = join(base, 'link.json'); rmSync(link, { force: true }); symlinkSync(manifest, link);
    expect(codeOf(() => fixtureProcessDomain(inventoryRoot, env({ [FIXTURE_PROCESS_DOMAIN_ENV]: link })))).toBe('fixture-process-domain-not-private');
    const outside = '/var/empty/manifest.json';
    expect(codeOf(() => fixtureProcessDomain(inventoryRoot, env({ [FIXTURE_PROCESS_DOMAIN_ENV]: outside })))).toBe('fixture-process-domain-outside');
    expect(fixtureProcessDomain(inventoryRoot, env({}))).not.toBeNull();
  });

  it('a malformed registration is blocking, not silently ignored', async () => {
    mkdirSync(join(domain, 'procs'), { recursive: true });
    writeFileSync(join(domain, 'procs', 'bad.json'), '{"pid": "x"}', { mode: 0o600 });
    try {
      await expect(fixtureProcessDomain(inventoryRoot, { ...process.env, [FIXTURE_PROCESS_DOMAIN_ENV]: manifest })!.processes()).rejects.toMatchObject({ code: 'fixture-process-domain-invalid' });
    } finally { rmSync(join(domain, 'procs', 'bad.json')); }
  });
});
