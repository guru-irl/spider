// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect } from 'vitest';
import { readFile, writeFile, access, mkdir, mkdtemp, symlink, link, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnOwned } from '../../harness/processes.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSuite } from '../../harness/suite.js';
import { storyId } from '../../harness/scenario.js';
import { deadline, waitFor } from '../../harness/wait.js';
import { stagePayload, removeDestination } from './index.js';

const payload = fileURLToPath(new URL('./controlled.mjs', import.meta.url));
const faults = fileURLToPath(new URL('../transport-faults.mjs', import.meta.url));
const exists = async (p: string) => access(p).then(() => true, () => false);

describe('remote fixture controls', () => {
  it('stages the exported payload API and releases the real destination payload', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-payload-api') });
    try {
      const p = await stagePayload(suite, { id: 'api', stdout: 'api-out\n', stderr: 'api-err\n', exitCode: 29 });
      const running = suite.invoke('/bin/sh', ['-c', p.code], suite.cores!.dest.env);
      await p.ready(deadline(10000));
      expect(await p.effect()).toBe(null);
      await p.release();
      expect(await running).toEqual({ exitCode: 29, stdout: 'api-out\n', stderr: 'api-err\n' });
      expect(await p.effect()).toBe('api\n');
      await removeDestination(suite, p.machine, p.effectPath); expect(await p.effect()).toBe(null);
      await removeDestination(suite, p.machine, p.effectPath); expect(await p.effect()).toBe(null);
      await expect(removeDestination(suite, p.machine, join(suite.root, '..', 'foreign'))).rejects.toThrow();
      await expect(stagePayload(suite, { id: '../foreign' })).rejects.toThrow('payload-id-invalid');
    } finally { await suite.close(); }
  });
  it('replaces the shell and preserves a trapped signal exit zero as a numeric exit', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-payload-signal') });
    try {
      const p = await stagePayload(suite, { id: 'trap', onSignalExitZero: true });
      const script = suite.ownPath(join(suite.root, 'trap.sh')); await writeFile(script, p.code + '\n');
      const running = spawnOwned(suite.ledger, { label: 'signal-payload', command: '/bin/sh', args: [script], env: suite.cores!.dest.env, cwd: suite.root, stdio: 'pipe' });
      let out = ''; running.child.stdout!.on('data', d => out += d);
      const ready = await p.ready(deadline(10000)); expect(ready.pid).toBe(running.identity.pid);
      process.kill(-running.identity.pid, 'SIGHUP');
      expect(await running.exited).toEqual({ code: 0, signal: null });
      expect(out).toBe('trapped:SIGHUP\n'); expect(await p.effect()).toBe(null);
    } finally { await suite.close(); }
  });
  it('refuses a dangling effect symlink before writing outside the declared payload domain', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-payload-symlink') });
    const escapedRoot = await mkdtemp(join(dirname(suite.root), 'payload-escape-'));
    const escaped = join(escapedRoot, 'effect');
    try {
      expect(escaped.startsWith(suite.root + '/')).toBe(false);
      const domain = join(suite.root, 'domain'); await mkdir(domain);
      const effect = join(domain, 'effect'); await symlink(escaped, effect);
      const config = join(domain, 'input.json');
      await writeFile(config, JSON.stringify({ root: domain, story: 'H-payload-symlink', id: 'bad', nonce: 'fixture-nonce', effect }));
      const value = await suite.invoke(process.execPath, [payload, config]);
      expect(value.exitCode).toBe(91); expect(value.stderr).toContain('payload-symlink'); expect(await exists(escaped)).toBe(false);
      await suite.evidence('outside-suite-effect-control.json', { root: suite.root, escaped, result: value, escapedEffectExists: await exists(escaped) });
    } finally { try { await suite.close(); } finally { await rm(escapedRoot, { recursive: true, force: true }); } }
  });
  it('emits independently checked large bytes, split Unicode and stdin EOF', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-payload-streams') });
    try {
      const config = join(suite.root, 'input.json');
      await writeFile(config, JSON.stringify({ root: suite.root, story: 'H-payload-streams', id: 'bytes', nonce: 'fixture-nonce', stdin: true, splitUnicode: true, large: { lines: 20000, bytes: 5 * 1024 * 1024 }, stderr: 'final-error\n', exitCode: 31 }));
      const value = await suite.invoke(process.execPath, [payload, config]);
      const lines = Array.from({ length: 20000 }, (_, i) => `line-${String(i).padStart(5, '0')}\n`).join('');
      const bytes = 'abcdefghijklmnopqrstuvwxyz'.repeat(Math.ceil(5 * 1024 * 1024 / 26)).slice(0, 5 * 1024 * 1024);
      const expected = `stdin-bytes:0\nsplit:雪🙂é\n${lines}bytes-start\n${bytes}\nbytes-end\n`;
      const hash = (s: string) => createHash('sha256').update(s).digest('hex');
      expect(Buffer.byteLength(value.stdout)).toBe(Buffer.byteLength(expected)); expect(hash(value.stdout)).toBe(hash(expected));
      expect(value.stderr).toBe('interleaved-error\nfinal-error\n'); expect(value.exitCode).toBe(31);
      expect(hash(value.stdout)).not.toBe(hash(expected.slice(0, -1)));
    } finally { await suite.close(); }
  });
  it('holds effects until the exact release and captures separate streams and exit', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-payload') });
    try {
      const config = join(suite.root, 'payload.json'), ready = join(suite.root, 'ready.json');
      const release = join(suite.root, 'release.json'), effect = join(suite.root, 'effect');
      await writeFile(config, JSON.stringify({ root: suite.root, story: 'H-payload', id: 'hold', nonce: 'fixture-nonce', ready, release, effect, deadlineAt: Date.now() + 20000, stdout: 'out\n', stderr: 'err\n', exitCode: 23 }));
      const running = suite.invoke(process.execPath, [payload, config]);
      await waitFor('payload ready', () => exists(ready), Boolean, deadline(10000));
      expect(await exists(effect)).toBe(false);
      await writeFile(release, JSON.stringify({ story: 'H-payload', id: 'hold', nonce: 'fixture-nonce' }));
      const result = await running;
      expect(result).toEqual({ exitCode: 23, stdout: 'out\n', stderr: 'err\n' });
      expect(await readFile(effect, 'utf8')).toBe('hold\n');
    } finally { await suite.close(); }
  });
  it('rejects a foreign release without executing an effect', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-payload-bad') });
    try {
      const config = join(suite.root, 'payload.json'), release = join(suite.root, 'release.json'), effect = join(suite.root, 'effect');
      await writeFile(config, JSON.stringify({ root: suite.root, story: 'H-payload-bad', id: 'bad', nonce: 'expected', ready: join(suite.root, 'ready'), release, effect, deadlineAt: Date.now() + 20000 }));
      await writeFile(release, JSON.stringify({ story: 'other', id: 'bad', nonce: 'expected' }));
      const result = await suite.invoke(process.execPath, [payload, config]);
      expect(result.exitCode).toBe(91);
      expect(result.stderr).toContain('payload-release-mismatch');
      expect(await exists(effect)).toBe(false);
    } finally { await suite.close(); }
  });
  it('holds a real file read before forwarding until the exact owned release', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-hold-transport') });
    try {
      const input = join(suite.root, 'input.txt'), config = join(suite.root, 'fault.json');
      const ready = join(suite.root, 'transport-ready'), release = join(suite.root, 'transport-release');
      await writeFile(input, 'old\n');
      await writeFile(config, JSON.stringify({ root: suite.root, real: suite.cores!.wrapper, log: join(suite.root, 'fault.jsonl'), once: join(suite.root, 'claimed'), mode: 'hold', match: ['file', 'read'], gate: { ready, release, nonce: 'transport-nonce', deadlineAt: Date.now() + 20000 } }));
      const running = suite.invoke(process.execPath, [faults, config, 'file', 'read', '--json', input], suite.cores!.local.env);
      await waitFor('transport held before forwarding', () => exists(ready), Boolean, deadline(10000));
      await writeFile(input, 'new\n');
      await writeFile(release, JSON.stringify({ nonce: 'transport-nonce' }));
      const reply = await running; expect(reply.exitCode).toBe(0); expect(JSON.parse(reply.stdout).text).toBe('new\n');
    } finally { await suite.close(); }
  });
  it('corrupts a read only after accepting the real reply and leaves the next read unchanged', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-corrupt-read') });
    try {
      const config = join(suite.root, 'fault.json'), log = join(suite.root, 'fault.jsonl'), input = join(suite.root, 'input'); await writeFile(input, 'real-input\n');
      await writeFile(config, JSON.stringify({ root: suite.root, real: suite.cores!.wrapper, log, once: join(suite.root, 'claimed'), mode: 'corrupt-read', match: ['file', 'read'] }));
      const args = [faults, config, 'file', 'read', '--json', input];
      const first = await suite.invoke(process.execPath, args, suite.cores!.local.env); expect(first.exitCode).toBe(0); expect(JSON.parse(first.stdout).text).toBe('corrupt-publication');
      const records = (await readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
      expect(JSON.parse(records.find(r => r.phase === 'accepted').stdout).text).toBe('real-input\n');
      const next = await suite.invoke(process.execPath, args, suite.cores!.local.env); expect(next.exitCode).toBe(0); expect(JSON.parse(next.stdout).text).toBe('real-input\n');
    } finally { await suite.close(); }
  });
  it('changes only an accepted version reply while preserving the actual core identity', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-wrong-version') });
    try {
      const config = join(suite.root, 'fault.json'), log = join(suite.root, 'fault.jsonl');
      await writeFile(config, JSON.stringify({ root: suite.root, real: suite.cores!.wrapper, log, once: join(suite.root, 'claimed'), mode: 'wrong-version', match: ['server', 'status'], scope: 'version-test' }));
      const args = [faults, config, 'server', 'status', '--json'];
      const ordinary = await suite.invoke(process.execPath, args, suite.cores!.local.env); expect(JSON.parse(ordinary.stdout).version).toBe('0.1.16');
      const scoped = { ...suite.cores!.local.env, SPIDER_E2E_FAULT_SCOPE: 'version-test' };
      const first = await suite.invoke(process.execPath, args, scoped); expect(first.exitCode).toBe(0); expect(JSON.parse(first.stdout).version).toBe('0.1.15'); expect(JSON.parse(first.stdout).core.id).toBe(suite.cores!.local.coreId);
      const records = (await readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l)); expect(JSON.parse(records.find(r => r.phase === 'accepted').stdout).version).toBe('0.1.16');
      const next = await suite.invoke(process.execPath, args, scoped); expect(JSON.parse(next.stdout).version).toBe('0.1.16');
    } finally { await suite.close(); }
  });
  it('refuses a dangling transport log symlink before writing outside its declared domain', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-transport-symlink') });
    try {
      const domain = join(suite.root, 'domain'); await mkdir(domain);
      const real = join(domain, 'hc'), config = join(domain, 'fault.json'), log = join(domain, 'log'), escaped = join(suite.root, 'escaped');
      await writeFile(real, `#!/bin/sh\nexec '${suite.cores!.wrapper}' "$@"\n`, { mode: 0o700 }); await symlink(escaped, log);
      await writeFile(config, JSON.stringify({ root: domain, real, log, once: join(domain, 'claimed'), mode: 'reject', match: ['server', 'status'] }));
      const value = await suite.invoke(process.execPath, [faults, config, 'server', 'status', '--json'], suite.cores!.local.env);
      expect(value.exitCode).toBe(94); expect(value.stderr).toContain('fault-symlink'); expect(await exists(escaped)).toBe(false);
    } finally { await suite.close(); }
  });
  it('refuses a declared mutation root that excludes the actual config file', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-config-root') });
    try {
      const p = await stagePayload(suite, { id: 'root-switch', gate: false }), domain = join(suite.root, 'domain'); await mkdir(domain);
      const config = JSON.parse(await readFile(p.configPath, 'utf8')); config.root = domain;
      for (const key of ['ready', 'effect', 'signalFile']) config[key] = join(domain, key); await writeFile(p.configPath, JSON.stringify(config));
      const value = await suite.invoke('/bin/sh', ['-c', p.code], suite.cores!.dest.env);
      expect(value.exitCode).toBe(91); expect(value.stderr).toContain('payload-path-unowned'); expect(await exists(config.effect)).toBe(false);
    } finally { await suite.close(); }
  });
  it('refuses a hardlinked effect before appending to a shared inode', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-effect-hardlink') });
    try {
      const p = await stagePayload(suite, { id: 'hard-effect', gate: false }), other = join(suite.root, 'other'); await writeFile(other, 'unchanged'); await link(other, p.effectPath);
      const value = await suite.invoke('/bin/sh', ['-c', p.code], suite.cores!.dest.env);
      expect(value.exitCode).toBe(91); expect(value.stderr).toContain('payload-hardlink'); expect(await readFile(other, 'utf8')).toBe('unchanged');
      await expect(removeDestination(suite, p.machine, p.effectPath)).rejects.toMatchObject({ code: 'fixture-remove-failed' }); expect(await exists(p.effectPath)).toBe(true); expect(await readFile(other, 'utf8')).toBe('unchanged');
      await rm(p.effectPath); expect((await suite.invoke('/bin/sh', ['-c', p.code], suite.cores!.dest.env)).exitCode).toBe(0); expect(await p.effect()).toBe('hard-effect\n'); expect(await readFile(other, 'utf8')).toBe('unchanged');
    } finally { await suite.close(); }
  });
  it('rechecks a gated effect path before writing when its inode becomes a symlink', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-late-effect-link') });
    try {
      const p = await stagePayload(suite, { id: 'late-effect' }), other = join(suite.root, 'other'); await writeFile(other, 'unchanged');
      const running = spawnOwned(suite.ledger, { label: 'late-effect-payload', command: '/bin/sh', args: ['-c', p.code], env: suite.cores!.dest.env, cwd: suite.root, stdio: 'pipe' });
      let error = ''; running.child.stderr!.on('data', d => error += d);
      await p.ready(deadline(10000)); await symlink(other, p.effectPath); await p.release();
      expect(await running.exited).toEqual({ code: 91, signal: null }); expect(error).toContain('payload-symlink'); expect(await readFile(other, 'utf8')).toBe('unchanged');
    } finally { await suite.close(); }
  });
  it('refuses a hardlinked transport log before appending any fault metadata', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-log-hardlink') });
    try {
      const other = join(suite.root, 'other'), log = join(suite.root, 'log'), config = join(suite.root, 'fault.json'); await writeFile(other, 'unchanged'); await link(other, log);
      await writeFile(config, JSON.stringify({ root: suite.root, real: suite.cores!.wrapper, log, once: join(suite.root, 'claimed'), mode: 'reject', match: ['server', 'status'] }));
      const value = await suite.invoke(process.execPath, [faults, config, 'server', 'status', '--json'], suite.cores!.local.env);
      expect(value.exitCode).toBe(94); expect(value.stderr).toContain('fault-hardlink'); expect(await readFile(other, 'utf8')).toBe('unchanged');
    } finally { await suite.close(); }
  });
  it('drops a reply only after the real core accepts the operation, once', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-drop-reply') });
    try {
      const config = join(suite.root, 'fault.json'), log = join(suite.root, 'fault.jsonl'), effect = join(suite.root, 'effect');
      await writeFile(config, JSON.stringify({ root: suite.root, real: suite.cores!.wrapper, log, once: join(suite.root, 'claimed'), mode: 'drop-reply', match: ['run'] }));
      const result = await suite.invoke(process.execPath, [faults, config, 'run', '--json', '--bg', '--no-notify', '--outlive-parent', '--keep', '--', '/bin/sh', '-c', `printf 'accepted\\n' >> '${effect}'`], suite.cores!.local.env);
      expect(result.exitCode).toBe(96);
      expect(result.stdout).toBe('');
      await waitFor('accepted payload effect', () => exists(effect), Boolean, deadline(10000));
      expect(await readFile(effect, 'utf8')).toBe('accepted\n');
      const records = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(records.some(r => r.phase === 'accepted' && r.exitCode === 0)).toBe(true);
      expect(records.filter(r => r.phase === 'forwarded')).toHaveLength(1);
    } finally { await suite.close(); }
  });
});
