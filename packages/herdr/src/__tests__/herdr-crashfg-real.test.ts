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
import { parseHerdrConfig } from '../config.js';
import { setupHerdr, runtimeInstallPath } from '../setup/installer.js';
import { createHostHerdrPorts, createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { effectiveHerdrConfigPath } from '../../../host/src/herdr/mount.js';
import type { JobId, RunId, TerminalAddress } from '../contracts.js';

const binary = process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc');
const enabled = process.env.SPIDER_HERDR_E2E === '1' && await access(binary).then(() => true, () => false);
if (!enabled) console.info('SKIP crash recovery proof: requires hc and SPIDER_HERDR_E2E=1; isolated cores only, no app window');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
it.skipIf(!enabled).each(['session', 'child'] as const)('real hc stops crashed %s foreground before gate release and reports its surviving background once', async path => {
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
    await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: [/^@spider\//] }, build: { ssr: fileURLToPath(new URL('./herdr-crashfg-owner.ts', import.meta.url)), outDir: join(h.root, 'bundle'), emptyOutDir: false, minify: false,
      rollupOptions: { external: [/^@earendil-works\//, 'better-sqlite3', 'sqlite-vec'], output: { entryFileNames: 'owner.mjs' } },
    } });
    const gate = join(h.root, 'release'), foregroundEffect = join(h.root, 'foreground-effect'), backgroundEffect = join(h.root, 'background-effect');
    const held = (name: string, effect: string) => `printf '%s' "$$" > ${quote(join(h.root, name + '-ready'))}; while [ ! -f ${quote(gate)} ]; do sleep 0.05; done; printf ${quote(name)} > ${quote(effect)}; exit 29`;
    const journalRoot = join(config.globalRoot, 'herdr/jobs'), readyFile = join(h.root, 'owner-ready.json'), descriptor = join(h.root, 'owner-input.json');
    const runId = path === 'child' ? 'crashed-run' as RunId : undefined;
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
    // A new activation of the same saved session owns a new terminal.
    const terminal = await h.hc.run({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: h.root, labels: {}, parent: null, outliveParent: true, background: true, noNotify: true });
    const owner = path === 'session' ? { ...h.owner!, generation: 'resumed-owner' as never, terminal: { ...h.owner!.terminal, address: terminal.address, terminalId: terminal.address as never } } : h.owner!;
    const env = { ...h.localEnv }; delete env.HC_TERMINAL_ID; delete env.HC_TERMINAL_SOCKET;
    client = createHcClient({ binary: h.hcBinary, env });
    output = createHostHerdrPorts({ hc: client, config, runtimeBytes: runtime, runtimePath: () => runtimePath });
    const notices: JobNotice[] = [], errors: unknown[] = [];
    const monitor = () => { const jobs = createJobMonitor({ hc: client!, journalRoot, outputCollector: output!.outputCollector, clock: Date.now, notifier: notice => { notices.push(notice); }, observedJobMessages: async () => [], reportError: error => { errors.push(error); } }); monitors.push(jobs); return jobs; };
    const resumed = monitor(); await resumed.activate(owner); await resumed.reconcile();
    await expect.poll(async () => (await h.hc.get(ready.foreground.address)).state, { timeout: 10000 }).toBe('finished');
    await expect.poll(() => processStartIdentity(payloadPid), { timeout: 10000 }).not.toBe(payloadIdentity);
    expect(await h.hc.get(ready.background.address)).toMatchObject({ state: 'live' });
    await writeFile(gate, 'release both payloads');
    await expect.poll(() => existsSync(backgroundEffect), { timeout: 10000 }).toBe(true);
    await expect.poll(async () => { await resumed.reconcile(); return notices.filter(notice => notice.details.jobId === ready.background.id).length; }, { timeout: 15000 }).toBe(1);
    await resumed.reconcile();
    expect(existsSync(foregroundEffect)).toBe(false); expect(await readFile(backgroundEffect, 'utf8')).toBe('background');
    const journal = await createJobStore(journalRoot, owner.sessionId, runId).read();
    expect(journal.jobs.find(job => job.id === ready.foreground.id)).toMatchObject({ phase: { kind: 'finished', result: { reason: 'cancelled' } }, settledMarked: true });
    expect(notices.filter(notice => notice.details.jobId === ready.background.id)[0].details.exitCode).toBe(29);
    await resumed.shutdown('reload'); const reloaded = monitor(); await reloaded.activate(owner); await reloaded.reconcile();
    expect(notices.filter(notice => notice.details.jobId === ready.background.id)).toHaveLength(1);
    expect(notices.filter(notice => notice.details.jobId === ready.foreground.id).length).toBeLessThanOrEqual(1);
    expect(errors, stderr).toEqual([]);
    evidence.result = { foreground: journal.jobs.find(job => job.id === ready.foreground.id), background: journal.jobs.find(job => job.id === ready.background.id), foregroundEffect: false, foregroundPayloadGone: processStartIdentity(payloadPid) !== payloadIdentity, backgroundEffect: 'background', notices: notices.length, writerPid: ready.pid };
    console.info('REAL CRASH RESULT', JSON.stringify(evidence.result));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill('SIGKILL'); await exited; }
    for (const monitor of monitors) await monitor.shutdown('reload');
    output?.dispose(); await client?.dispose(); await installer.dispose(); vi.unstubAllEnvs(); await h.close();
    await mkdir(resolve('.spider/scratch/crashfg'), { recursive: true });
    evidence.cleanup = h.cleanupProof; await writeFile(resolve(`.spider/scratch/crashfg/real-evidence-${path}.json`), JSON.stringify(evidence, null, 2));
    console.info('REAL CRASH CLEANUP', JSON.stringify(h.cleanupProof));
  }
  expect(await h.remainingOwnedResources()).toEqual([]);
}, 90000);
