// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, openSync } from 'node:fs';
import { join } from 'node:path';

import { checkoutRoot, scratchRoot } from '../environment.js';
import { identityAlive, readLedger, rootProcesses } from '../resources.js';
import { createSuite } from '../suite.js';
import { storyId } from '../scenario.js';
import { waitFor, deadline } from '../wait.js';
import { marker } from '../../fixtures/scripted-provider.js';
import type { RpcDriver } from '../pi.js';

const WORKER = process.env.SPIDER_E2E_DISPOSABLE_WORKER;

if (WORKER) {
  // Disposable worker: build a real suite, start a live pi, report, then wait to be killed by the parent test.
  describe('disposable harness worker', () => {
    it('holds a live suite until killed', async () => {
      const suite = await createSuite({ tier: 'headless', story: storyId('H-killed-worker'), script: { story: 'H-killed-worker', scripts: { hold: [{ steps: [{ gate: 'never' }] }] } } });
      const gates = await suite.gates();
      const pi = await suite.launchPi({ mode: 'rpc', cwd: await suite.project('w') }) as RpcDriver;
      await pi.rpc({ type: 'prompt', message: `${marker('hold')} wait forever` });
      await gates.ready('never', deadline(60_000));
      writeFileSync(WORKER, JSON.stringify({ ledger: suite.ledger.path, root: suite.root, pid: process.pid, piPid: pi.pid }));
      await new Promise(() => {});
    }, 600_000);
  });
} else {
  describe('createSuite', () => {
    it('builds a fenced headless fixture with real cores, packed pi and a ledger, and closes cleanly', async () => {
      const suite = await createSuite({ tier: 'headless', story: storyId('H-suite') });
      let closed = false;
      try {
        expect(suite.root.startsWith(join(scratchRoot(), 'e2') + '/')).toBe(true);
        expect(suite.cores!.local.coreId).not.toBe(suite.cores!.dest.coreId);
        expect(suite.env.PATH.split(':')[0]).toBe(join(suite.root, 'bin'));
        expect(Object.keys(suite.env).some(k => k.startsWith('VITEST'))).toBe(false);
        const ls = await suite.hc(['ls', '--all', '--json']);
        expect(ls.json).toMatchObject({ terminals: [] });
        const r = await suite.invoke('/bin/sh', ['-c', 'printf out; printf err >&2; exit 3']);
        expect(r).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
        await expect((await suite.app()).ls()).resolves.toEqual({ spaces: [], recent: [] });
        const kept = await suite.evidence('note.json', { ok: true });
        expect(kept.startsWith(join(scratchRoot(), 'e2', '_evidence', 'H-suite') + '/')).toBe(true);
        await expect(suite.evidence('../escape', 'x')).rejects.toThrow(/invalid-evidence-name/);
        const ledger = readLedger(suite.ledger.path);
        expect(ledger.cores.map(c => c.side)).toEqual(['local', 'dest']);
        expect(ledger.watchdog && identityAlive(ledger.watchdog)).toBe(true);
        const proof = await suite.close({ removeRoot: true }); closed = true;
        expect(proof.clean).toBe(true);
        expect(existsSync(suite.root)).toBe(false);
        expect(readFileSync(kept, 'utf8')).toContain('"ok": true');
        expect(existsSync(suite.cleanupProofPath)).toBe(true);
        expect(existsSync(suite.ledger.path.replace(/\.json$/, '.cleanup.json'))).toBe(true);
        for (const core of ledger.cores) expect(existsSync(core.socket)).toBe(false);
        await waitFor('watchdog exits after release', () => identityAlive(ledger.watchdog!), a => !a, deadline(10_000));
      } finally { if (!closed) await suite.close(); }
    });

    it('refuses the app tier without the user opt-in', async () => {
      await expect(createSuite({ tier: 'app', story: storyId('H-app'), consent: true, displayUuid: '' })).rejects.toThrow(/app-consent-required/);
    });
  });

  describe('process domain (P1)', () => {
    it('every fixture pi registers itself, and the domain sees it but not a foreign same-user pi', async () => {
      const suite = await createSuite({ tier: 'ci', story: storyId('H-domain') });
      const foreign = spawn(process.execPath, ['-e', "process.title = 'pi'; process.stdout.write('ok'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
      try {
        await new Promise<void>(r => foreign.stdout!.once('data', () => r()));
        expect(suite.env.SPIDER_HERDR_E2E_PROCESS_DOMAIN).toBe(join(suite.root, 'manifest.json'));
        const pi = await suite.launchPi({ mode: 'rpc', cwd: await suite.project('d') }) as RpcDriver;
        await pi.waitEvent('session_start', () => true, deadline(60_000));
        // The host module resolves spider paths on import; give it the fixture's global root first.
        process.env.SPIDER_GLOBAL_ROOT ??= suite.directories.SPIDER_GLOBAL_ROOT;
        const { fixtureProcessDomain } = await import('../../../../host/src/herdr/fixture-process-domain.js');
        const domain = fixtureProcessDomain(join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr'), { ...suite.env, SPIDER_TEST_FIXTURE_CHECKOUT: checkoutRoot() })!;
        const listed = (await domain.processes()).map(p => p.pid);
        expect(listed).toEqual([pi.pid]);
        expect(listed).not.toContain(foreign.pid);
        await pi.close();
        expect(await domain.processes()).toEqual([]);
      } finally { foreign.kill('SIGKILL'); await suite.close({ removeRoot: true }); }
    }, 180_000);
  });

  describe('killed worker', () => {
    it('SIGKILL of a worker process group leaves no cores, terminals or pi processes: the watchdog cleans up from outside the group', async () => {
      const dir = join(scratchRoot(), 'e2', `_kw${process.pid}`); mkdirSync(dir, { recursive: true });
      const report = join(dir, 'ready.json'), config = join(dir, 'w.config.mjs');
      writeFileSync(config, `export default { root: ${JSON.stringify(checkoutRoot())}, test: { include: ['packages/herdr/e2e/harness/__tests__/processes.test.ts'], pool: 'forks', maxWorkers: 1, testTimeout: 600000 } };\n`);
      // The worker is a harness runner like this one, so it keeps the runner's environment minus Vitest markers.
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST')));
      env.SPIDER_E2E_DISPOSABLE_WORKER = report;
      const worker = spawn(join(checkoutRoot(), 'node_modules/.bin/vitest'), ['run', '--config', config], { cwd: checkoutRoot(), env, detached: true, stdio: ['ignore', openSync(join(dir, 'worker.log'), 'a'), openSync(join(dir, 'worker.log'), 'a')] });
      try {
        const ready = (await waitFor('worker reports a live suite', () => { if (existsSync(report)) return JSON.parse(readFileSync(report, 'utf8')) as { ledger: string; root: string; pid: number; piPid: number }; if (worker.exitCode !== null) throw new Error(`worker exited ${worker.exitCode}`); return null; }, Boolean, deadline(240_000), { reconcileMs: 250, subscribe: wake => { worker.once('exit', wake); return () => worker.off('exit', wake); } }).catch(error => { throw new Error(`${String(error)}\n${readFileSync(join(dir, 'worker.log'), 'utf8').slice(-3000)}`); }))!;
        const ledger = readLedger(ready.ledger);
        expect(ledger.state).toBe('open');
        expect(ledger.cores.every(c => existsSync(c.socket))).toBe(true);
        const pi = ledger.processes.find(p => p.pid === ready.piPid)!;
        expect(identityAlive(pi)).toBe(true);
        // The killer (this test) is outside the worker's group; so is the watchdog.
        expect(ledger.watchdog && identityAlive(ledger.watchdog)).toBe(true);
        process.kill(-worker.pid!, 'SIGKILL');
        await waitFor('watchdog finishes the ledger', () => readLedger(ready.ledger).state, s => s !== 'open', deadline(90_000), { reconcileMs: 250 });
        const proof = JSON.parse(readFileSync(ready.ledger.replace(/\.json$/, '.cleanup.json'), 'utf8'));
        expect(proof).toMatchObject({ clean: true, reason: 'watchdog:owner-pipe-closed' });
        expect(identityAlive(pi)).toBe(false);
        for (const core of ledger.cores) { expect(existsSync(core.socket)).toBe(false); expect(identityAlive({ pid: core.pid!, start: core.start! })).toBe(false); }
        expect(rootProcesses(ready.root, [ledger.watchdog!.pid])).toEqual([]);
        rmSync(ready.root, { recursive: true, force: true });
      } finally {
        try { process.kill(-worker.pid!, 'SIGKILL'); } catch { /* already gone */ }
        rmSync(dir, { recursive: true, force: true });
      }
    }, 400_000);
  });
}
