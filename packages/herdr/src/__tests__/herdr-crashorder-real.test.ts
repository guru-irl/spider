// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createHerdrHarness, proveSocketPaths } from './testutil.js';
import { createJobMonitor, type JobNotice } from '../jobs/monitor.js';
import { createHcClient } from '../client/hc.js';
import { createJobStore } from '../jobs/store.js';
import { processStartIdentity } from '../jobs/handoff.js';
import { ensureAgentConsole, closeAgentConsoles } from '../remote/console.js';
import { sha256 } from '../remote/runtime.js';
import { parseHerdrConfig } from '../config.js';
import { setupHerdr, runtimeInstallPath } from '../setup/installer.js';
import { createHostHerdrPorts, createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { effectiveHerdrConfigPath } from '../../../host/src/herdr/mount.js';
import type { JobId, RunId, RuntimeTarget, TerminalAddress } from '../contracts.js';

const binary = process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc');
const enabled = process.env.SPIDER_HERDR_E2E === '1' && await access(binary).then(() => true, () => false);
if (!enabled) console.info('SKIP crash recovery proof: requires hc and SPIDER_HERDR_E2E=1; isolated cores only, no app window');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
it.skipIf(!enabled)('console closure after child SIGKILL guarantees foreground cleanup while background and sibling survive', async () => {
  const h = await createHerdrHarness('hc'); proveSocketPaths(h.root, [h.localSocket, h.remoteSocket]);
  const installer = createProductionHerdrCliPorts(resolve('.'), { ...h.localEnv, SPIDER_GLOBAL_ROOT: h.directories.global });
  const monitors: ReturnType<typeof createJobMonitor>[] = [];
  let child: ReturnType<typeof spawn> | undefined, output: ReturnType<typeof createHostHerdrPorts> | undefined;
  let client: ReturnType<typeof createHcClient> | undefined;
  const evidence: Record<string, unknown> = {};
  try {
    await h.start(); execFileSync('git', ['init', '-q', h.root]);
    expect(h.localSocket).not.toBe(join(homedir(), '.local/state/herdr-core/default/default.sock'));
    expect(h.localCoreId).not.toBe(h.remoteCoreId);
    console.info('ISOLATED CRASH CORES', h.localSocket, h.remoteSocket, h.localCoreId, h.remoteCoreId);
    vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global);
    const configFile = join(h.directories.global, 'herdr/config.json'); await mkdir(join(h.directories.global, 'herdr'), { recursive: true });
    const input = parseHerdrConfig({ enabled: true, core: { binary: h.hcBinary, config: join(h.directories.local, 'core.toml') }, app: { binary: h.appBinary, home: h.directories.app }, globalRoot: h.directories.global, agentDirectory: h.directories.agent, shellRc: join(h.root, 'shellrc'), spaces: [],
      machines: [{ name: 'remote.invalid', nodePath: process.execPath, runtime: { directory: join(h.directories.remote, 'runtime'), cwd: null, commands: {} } }],
    });
    await writeFile(configFile, JSON.stringify(input)); await writeFile(join(input.app.home, 'settings.json'), '{}');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(h.root);
    let resolvedRequest;
    try { resolvedRequest = await installer.request(configFile); } finally { cwd.mockRestore(); }
    const request = { ...resolvedRequest, packageRoot: h.root }, parts = await installer.setupParts(request);
    await setupHerdr(request, { ...parts,
      preflight: async () => ({ fingerprint: 'crash-runtime', coreIdentity: h.owner!.terminal, mods: ['agents', 'spaces', 'pane', 'panel', 'machines'].map(name => ({ directory: join(input.app.home, 'mods', `spider-${name}`) })), targets: [], retiredTerminals: [], layoutExport: true }),
      stageLook: async () => [], generateTemplates: async () => [], installResume: async () => [], cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }),
    });
    expect(effectiveHerdrConfigPath(h.root)).toBe(configFile);
    const config = parseHerdrConfig(JSON.parse(await readFile(configFile, 'utf8'))), runtimeFile = resolve('dist/herdr/remote-runtime.mjs'), runtime = await readFile(runtimeFile);
    const runtimePath = runtimeInstallPath(config.machines[0].runtime.directory, runtime);
    expect((await h.hc.fileRead('remote.invalid' as never, runtimePath)).equals(runtime)).toBe(true);
    await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.spiderHerdrRuntimeEntry': 'false' }, ssr: { noExternal: [/^@spider\//] }, build: { ssr: fileURLToPath(new URL('./herdr-crashfg-owner.ts', import.meta.url)), outDir: join(h.root, 'bundle'), emptyOutDir: false, minify: false,
      rollupOptions: { external: [/^@earendil-works\//, 'better-sqlite3', 'sqlite-vec'], output: { entryFileNames: 'owner.mjs' } },
    } });
    const gate = join(h.root, 'release'), foregroundEffect = join(h.root, 'foreground-effect'), backgroundEffect = join(h.root, 'background-effect');
    const held = (name: string, effect: string) => `printf '%s' "$$" > ${quote(join(h.root, name + '-ready'))}; while [ ! -f ${quote(gate)} ]; do sleep 0.05; done; printf ${quote(name)} > ${quote(effect)}; exit 29`;
    const journalRoot = join(config.globalRoot, 'herdr/jobs'), readyFile = join(h.root, 'owner-ready.json'), descriptor = join(h.root, 'owner-input.json');
    const runId = 'crashed-console-run' as RunId;
    await writeFile(descriptor, JSON.stringify({ owner: h.owner, runId, configFile, runtimeFile, journalRoot, readyFile, foreground: held('foreground', foregroundEffect), background: held('background', backgroundEffect) }));
    let stderr = '';
    child = spawn(process.execPath, [join(h.root, 'bundle/owner.mjs'), descriptor], { env: h.localEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr!.on('data', bytes => { stderr += bytes; });
    const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
    await expect.poll(() => existsSync(readyFile), { timeout: 20000, message: 'Owner failed to launch: ' + stderr }).toBe(true);
    await expect.poll(() => existsSync(join(h.root, 'foreground-ready')) && existsSync(join(h.root, 'background-ready')), { timeout: 10000 }).toBe(true);
    const ready = JSON.parse(await readFile(readyFile, 'utf8')) as { pid: number; foreground: { id: JobId; address: TerminalAddress }; background: { id: JobId; address: TerminalAddress } };
    expect(ready.pid).toBe(child.pid);
    const payloadPid = Number(await readFile(join(h.root, 'foreground-ready'), 'utf8')), payloadIdentity = processStartIdentity(payloadPid);
    expect(payloadIdentity).not.toBeNull();
    expect(await h.hc.get(ready.foreground.address)).toMatchObject({ state: 'live', parent: null });
    expect(await h.hc.get(ready.background.address)).toMatchObject({ state: 'live', parent: null });
    child.kill('SIGKILL'); await exited;
    expect(child.signalCode).toBe('SIGKILL');
    const owner = h.owner!;
    const env = { ...h.localEnv }; delete env.HC_TERMINAL_ID; delete env.HC_TERMINAL_SOCKET;
    client = createHcClient({ binary: h.hcBinary, env });
    output = createHostHerdrPorts({ hc: client, config, runtimeBytes: runtime, runtimePath: () => runtimePath });
    const target: RuntimeTarget = { on: config.machines[0].name, ...config.machines[0].runtime, nodePath: process.execPath, runtimePath, runtimeSha256: sha256(runtime), environment: {} };
    const consoleRequest = { owner, on: target.on, target, source: { kind: 'code', language: 'shell', code: 'held command' } as const };
    const consoleEnv = { ...h.localEnv, PI_SUBAGENT_CHILD: '1', PI_SUBAGENT_RUN_ID: runId };
    const crashedConsole = (await ensureAgentConsole(consoleRequest, client, consoleEnv))!;
    const siblingConsole = (await ensureAgentConsole(consoleRequest, client, { ...consoleEnv, PI_SUBAGENT_RUN_ID: 'live-sibling-run' }))!;
    expect(await h.hc.get(crashedConsole.address)).toMatchObject({ state: 'live' });
    expect(await h.hc.get(siblingConsole.address)).toMatchObject({ state: 'live' });
    const notices: JobNotice[] = [], errors: unknown[] = [];
    let payloadIdentityAtClose: string | null | undefined, foregroundStateAtClose: string | undefined, closeCount = 0;
    const closeConsoles = async (consoleOwner: Parameters<typeof closeAgentConsoles>[0]) => {
      await closeAgentConsoles(consoleOwner, client!);
      if (consoleOwner.runId !== runId) return;
      closeCount++;
      payloadIdentityAtClose = processStartIdentity(payloadPid);
      foregroundStateAtClose = (await h.hc.get(ready.foreground.address)).state;
      // The consumer releases both payloads as soon as the child's real console closes.
      // Wait for background's effect before returning so early closure cannot hide behind scheduling.
      await writeFile(gate, 'console closed');
      await expect.poll(() => existsSync(backgroundEffect), { timeout: 10000 }).toBe(true);
    };
    const monitor = () => { const jobs = createJobMonitor({ hc: client!, journalRoot, closeAgentConsoles: closeConsoles, outputCollector: output!.outputCollector, clock: Date.now, notifier: notice => { notices.push(notice); }, observedJobMessages: async () => [], reportError: error => { errors.push(error); } }); monitors.push(jobs); return jobs; };
    const resumed = monitor(); await resumed.activate(owner); await resumed.reconcile();
    await expect.poll(async () => (await h.hc.get(ready.foreground.address)).state, { timeout: 10000 }).toBe('finished');
    await expect.poll(() => processStartIdentity(payloadPid), { timeout: 10000 }).not.toBe(payloadIdentity);
    expect(closeCount).toBe(1);
    await expect.poll(() => existsSync(backgroundEffect), { timeout: 10000 }).toBe(true);
    await expect.poll(async () => { await resumed.reconcile(); return notices.filter(notice => notice.details.jobId === ready.background.id).length; }, { timeout: 15000 }).toBe(1);
    await resumed.reconcile();
    expect(existsSync(foregroundEffect), 'console closed before crashed foreground was stopped').toBe(false);
    expect(payloadIdentityAtClose).not.toBe(payloadIdentity);
    expect(foregroundStateAtClose).toBe('finished');
    await expect(h.hc.get(crashedConsole.address)).rejects.toMatchObject({ code: 'not_found' });
    expect(await h.hc.get(siblingConsole.address)).toMatchObject({ state: 'live' }); expect(await readFile(backgroundEffect, 'utf8')).toBe('background');
    const journal = await createJobStore(journalRoot, owner.sessionId, runId).read();
    expect(journal.jobs.find(job => job.id === ready.foreground.id)).toMatchObject({ phase: { kind: 'finished', result: { reason: 'cancelled' } }, settledMarked: true });
    expect(notices.filter(notice => notice.details.jobId === ready.background.id)[0].details).toMatchObject({ exitCode: 29, runId });
    expect(notices.filter(notice => notice.details.jobId === ready.background.id)[0].content).toContain(runId);
    await resumed.shutdown('reload'); const reloaded = monitor(); await reloaded.activate(owner); await reloaded.reconcile();
    expect(notices.filter(notice => notice.details.jobId === ready.background.id)).toHaveLength(1);
    expect(notices.filter(notice => notice.details.jobId === ready.foreground.id).length).toBeLessThanOrEqual(1);
    expect(closeCount).toBe(1);
    expect(await h.hc.get(siblingConsole.address)).toMatchObject({ state: 'live' });
    expect(errors, stderr).toEqual([]); expect(stderr).toBe('');
    evidence.result = { closeCount, payloadIdentityAtClose, foregroundStateAtClose, crashedConsole: crashedConsole.address, siblingConsole: siblingConsole.address, foreground: journal.jobs.find(job => job.id === ready.foreground.id), background: journal.jobs.find(job => job.id === ready.background.id), foregroundEffect: false, foregroundPayloadGone: processStartIdentity(payloadPid) !== payloadIdentity, backgroundEffect: 'background', notices: notices.length, writerPid: ready.pid };
    console.info('REAL CRASH RESULT', JSON.stringify(evidence.result));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill('SIGKILL'); await exited; }
    for (const monitor of monitors) await monitor.shutdown('reload');
    output?.dispose(); await client?.dispose(); await installer.dispose(); vi.unstubAllEnvs(); await h.close();
    evidence.cleanup = h.cleanupProof; await mkdir(resolve('.spider/scratch/crashorder'), { recursive: true });
    await writeFile(resolve('.spider/scratch/crashorder/real-evidence.json'), JSON.stringify(evidence, null, 2));
    console.info('REAL CRASH CLEANUP', JSON.stringify(h.cleanupProof));
  }
  expect(await h.remainingOwnedResources()).toEqual([]);
}, 90000);
