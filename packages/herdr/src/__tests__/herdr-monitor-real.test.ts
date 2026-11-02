// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHerdrHarness, proveSocketPaths } from './testutil.js';
import { createHcClient } from '../client/hc.js';
import { createJobMonitor, type JobNotice } from '../jobs/monitor.js';
import { createJobStore } from '../jobs/store.js';
import { parseHerdrConfig } from '../config.js';
import { setupHerdr, runtimeInstallPath } from '../setup/installer.js';
import { sha256 } from '../remote/runtime.js';
import { prepareRemoteProgram } from '../../../context/src/remote-plan.js';
import { createHostHerdrPorts, createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { effectiveHerdrConfigPath } from '../../../host/src/herdr/mount.js';
import type { RuntimeTarget } from '../contracts.js';
import { bounded } from './herdr-monitor-fixture.js';

const binary = process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc');
const enabled = process.env.SPIDER_HERDR_E2E === '1' && await access(binary).then(() => true, () => false);
if (!enabled) console.info('SKIP real monitor regression: requires installed hc and SPIDER_HERDR_E2E=1; isolated cores only, no app window');
it.skipIf(!enabled)('real hc collects 2.5-second via-machine reads and releases shutdown after core loss', async () => {
  const h = await createHerdrHarness('hc');
  proveSocketPaths(h.root, [h.localSocket, h.remoteSocket]);
  const ports = createProductionHerdrCliPorts(resolve('.'), { ...h.localEnv, SPIDER_GLOBAL_ROOT: h.directories.global });
  const monitors: ReturnType<typeof createJobMonitor>[] = [];
  const evidence: Record<string, unknown> = { binary, localSocket: h.localSocket, remoteSocket: h.remoteSocket };
  let client: ReturnType<typeof createHcClient> | undefined, output: ReturnType<typeof createHostHerdrPorts> | undefined;
  try {
    await h.start(); execFileSync('git', ['init', '-q', h.root]);
    expect(h.localSocket).not.toBe(join(homedir(), '.local/state/herdr-core/default/default.sock'));
    expect(h.localCoreId).not.toBe(h.remoteCoreId);
    console.info('ISOLATED', h.localSocket, h.remoteSocket, h.localCoreId, h.remoteCoreId);
    vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global);
    const configFile = join(h.directories.global, 'herdr/config.json'); await mkdir(join(h.directories.global, 'herdr'), { recursive: true });
    const input = parseHerdrConfig({ enabled: true, core: { binary: h.hcBinary, config: join(h.directories.local, 'core.toml') }, app: { binary: h.appBinary, home: h.directories.app }, globalRoot: h.directories.global, agentDirectory: h.directories.agent, shellRc: join(h.root, 'shellrc'), spaces: [],
      machines: [{ name: 'remote.invalid', nodePath: process.execPath, runtime: { directory: join(h.directories.remote, 'runtime'), cwd: null, commands: {} } }],
    });
    await writeFile(configFile, JSON.stringify(input));
    await writeFile(join(input.app.home, 'settings.json'), '{}');
    const request = { ...await ports.request(configFile), packageRoot: h.root }, parts = await ports.setupParts(request);
    await setupHerdr(request, { ...parts,
      preflight: async () => ({ fingerprint: 'monitor-runtime', coreIdentity: h.owner!.terminal, mods: ['agents', 'spaces', 'pane', 'panel', 'machines'].map(name => ({ directory: join(input.app.home, 'mods', `spider-${name}`) })), targets: [], retiredTerminals: [], layoutExport: true }),
      stageLook: async () => [], generateTemplates: async () => [], installResume: async () => [], cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }),
    });
    expect(effectiveHerdrConfigPath(h.root)).toBe(configFile);
    const config = parseHerdrConfig(JSON.parse(await readFile(configFile, 'utf8'))), runtime = await readFile(resolve('dist/herdr/remote-runtime.mjs'));
    const runtimePath = runtimeInstallPath(config.machines[0].runtime.directory, runtime);
    expect((await h.hc.fileRead('remote.invalid' as never, runtimePath)).equals(runtime)).toBe(true);
    const marker = join(h.root, 'slow-reads'), log = join(h.root, 'read-delays.jsonl'), wrapper = join(h.root, 'slow-hc');
    const wrapperSource = join(h.root, 'slow-hc.mjs');
    await writeFile(wrapperSource, `import { spawn } from 'node:child_process';\nimport { existsSync, appendFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nif (args[0] === 'file' && args[1] === 'read' && args.includes('--on') && existsSync(${JSON.stringify(marker)})) { const began = Date.now(); await new Promise(r => setTimeout(r, 2500)); appendFileSync(${JSON.stringify(log)}, JSON.stringify({ path: args.at(-1), delayMs: Date.now() - began }) + '\\n'); }\nconst child = spawn(${JSON.stringify(h.hcBinary)}, args, { stdio: 'inherit', env: process.env });\nfor (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));\nchild.once('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });\n`);
    await writeFile(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${wrapperSource}' "$@"\n`); await chmod(wrapper, 0o700);
    client = createHcClient({ binary: wrapper, env: h.localEnv });
    output = createHostHerdrPorts({ hc: client, config, runtimeBytes: runtime, runtimePath: () => runtimePath });
    const errors: unknown[] = [], notices: JobNotice[] = [];
    const jobs = createJobMonitor({ hc: client, journalRoot: join(h.root, 'jobs'), outputCollector: output.outputCollector, clock: Date.now, notifier: notice => { notices.push(notice); }, observedJobMessages: async () => [], reportError: error => { errors.push(error); } }); monitors.push(jobs);
    const target: RuntimeTarget = { on: 'remote.invalid' as never, ...config.machines[0].runtime, environment: {}, nodePath: process.execPath, runtimePath, runtimeSha256: sha256(runtime) };
    const program = await prepareRemoteProgram({ kind: 'code', language: 'shell', code: 'sleep 1; printf "slow output\\n"; printf "slow diagnostic\\n" >&2; exit 23' }, target);
    const handle = await jobs.start(program, h.owner!, target.on, {});
    await writeFile(marker, '');
    const result = await bounded(handle.finished, 45000);
    expect(result).toMatchObject({ exitCode: 23, reason: 'exited' });
    await jobs.detach(handle.id); await jobs.reconcile(); await jobs.reconcile();
    expect(await readFile(join(handle.localDirectory, 'stdout.log'), 'utf8')).toBe('slow output\n');
    expect(await readFile(join(handle.localDirectory, 'stderr.log'), 'utf8')).toBe('slow diagnostic\n');
    const receipt = JSON.parse(await readFile(join(handle.localDirectory, 'receipt.json'), 'utf8'));
    expect(receipt).toMatchObject({ jobId: handle.id, exitCode: 23 });
    expect(notices).toHaveLength(1); expect(errors).toEqual([]);
    const delayed = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { path: string; delayMs: number });
    expect(delayed.length).toBeGreaterThanOrEqual(3); expect(delayed.every(row => row.delayMs >= 2500)).toBe(true);
    evidence.output = { finish: result, delayedReads: delayed, notices: notices.length, errors: errors.length, stdout: 'slow output', stderr: 'slow diagnostic', runtimePath, receipt };
    console.info('REAL OUTPUT', evidence.output);
    // Stop only the owned local core while a second original is still running.
    const running = await prepareRemoteProgram({ kind: 'code', language: 'shell', code: 'sleep 60' }, target);
    // The read delay also applies during preparation; its two reads fit the release window.
    const live = await jobs.start(running, h.owner!, target.on, {});
    await h.cli(['server', 'stop', '--json']); await expect.poll(() => existsSync(h.localSocket), { timeout: 5000, interval: 10 }).toBe(false);
    await bounded(jobs.shutdown('quit'), 3000); await bounded(jobs.shutdown('quit'), 3000); await bounded(Promise.resolve(client.dispose()), 3000);
    expect(errors).toEqual([]);
    expect((await createJobStore(join(h.root, 'jobs'), h.owner!.sessionId).read()).jobs.some(job => job.id === live.id)).toBe(true);
    evidence.coreLoss = { liveJob: live.id, idempotentShutdown: true, errors: errors.length };
    console.info('REAL CORE LOSS', evidence.coreLoss);
  } finally {
    for (const monitor of monitors) await monitor.shutdown('reload');
    output?.dispose(); await client?.dispose(); await ports.dispose(); vi.unstubAllEnvs();
    if (!existsSync(h.localSocket)) await h.cli(['server', 'start', '--json']);
    await h.close();
    evidence.cleanup = h.cleanupProof;
    await writeFile(resolve('.spider/scratch/fx4-monitor-real-evidence.json'), JSON.stringify(evidence, null, 2));
    console.info('REAL CLEANUP', h.cleanupProof);
  }
  expect(await h.remainingOwnedResources()).toEqual([]);
}, 120000);
