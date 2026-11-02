// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHerdrHarness, proveSocketPaths } from './testutil.js';
import { parseHerdrConfig } from '../config.js';
import { setupHerdr, runtimeInstallPath } from '../setup/installer.js';
import { createJobMonitor } from '../jobs/monitor.js';
import { createJobStore } from '../jobs/store.js';
import { createRemoteExecutor } from '../remote/execute.js';
import { prepareRemoteProgram } from '../../../context/src/remote-plan.js';
import { runExec } from '../../../context/src/actions/exec.js';
import { createHostHerdrPorts, createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { effectiveHerdrConfigPath } from '../../../host/src/herdr/mount.js';
import { configFixtureCwd } from '../../../host/src/__tests__/herdr-config-fixture.js';
import { sha256 } from '../remote/runtime.js';

const binary = process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc');
const enabled = process.env.SPIDER_HERDR_E2E === '1' && existsSync(binary);
if (!enabled) console.info('SKIP missing-runtime regression: requires hc and SPIDER_HERDR_E2E=1; isolated cores only, no app window');
it.skipIf(!enabled)('the first remote command after runtime-root loss returns the setup hint and has no payload effect on real isolated hc', async () => {
  const h = await createHerdrHarness('hc');
  proveSocketPaths(h.root, [h.localSocket, h.remoteSocket]);
  const packageRoot = join(h.root, 'package');
  const cli = configFixtureCwd(createProductionHerdrCliPorts(packageRoot, h.localEnv), h.root);
  let output: ReturnType<typeof createHostHerdrPorts> | undefined;
  let jobs: ReturnType<typeof createJobMonitor> | undefined;
  const evidence: Record<string, unknown> = { binary, localSocket: h.localSocket, remoteSocket: h.remoteSocket };
  try {
    await h.start();
    execFileSync('git', ['init', '-q', h.root]);
    const runtime = await readFile(resolve('dist/herdr/remote-runtime.mjs'));
    await mkdir(join(packageRoot, 'dist/herdr'), { recursive: true });
    await writeFile(join(packageRoot, 'dist/herdr/remote-runtime.mjs'), runtime);
    expect(h.localSocket).not.toBe(join(homedir(), '.local/state/herdr-core/default/default.sock'));
    expect(h.localCoreId).not.toBe(h.remoteCoreId);
    Object.assign(evidence, { localCoreId: h.localCoreId, remoteCoreId: h.remoteCoreId });
    console.info('ISOLATED', { binary, localSocket: h.localSocket, remoteSocket: h.remoteSocket, localCoreId: h.localCoreId, remoteCoreId: h.remoteCoreId });
    vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global);
    vi.stubEnv('HC_TERMINAL_ID', '');
    const configFile = join(h.directories.global, 'herdr/config.json');
    await mkdir(join(h.directories.global, 'herdr'), { recursive: true });
    const input = parseHerdrConfig({ enabled: true, core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') }, app: { binary: h.appBinary, home: h.directories.app }, globalRoot: h.directories.global, agentDirectory: h.directories.agent, shellRc: join(h.root, 'shellrc'), spaces: [],
      machines: [{ name: 'remote.invalid', nodePath: process.execPath, runtime: { directory: join(h.directories.remote, 'programs'), cwd: null, commands: {} } }],
    });
    await writeFile(configFile, JSON.stringify(input));
    const request = await cli.request(configFile), parts = await cli.setupParts(request);
    await setupHerdr(request, { ...parts,
      preflight: async () => ({ fingerprint: 'runtime-failure', coreIdentity: h.owner!.terminal, mods: [], targets: [], retiredTerminals: [], layoutExport: true }),
      stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
      cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }),
    });
    expect(effectiveHerdrConfigPath(h.root)).toBe(configFile);
    const config = parseHerdrConfig(JSON.parse(await readFile(configFile, 'utf8')));
    const root = config.machines[0].runtime.directory, on = config.machines[0].name;
    const runtimePath = runtimeInstallPath(root, runtime);
    expect((await h.hc.fileRead(on, runtimePath)).equals(runtime)).toBe(true);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    // Preserve setup's empty root, then let real hc recreate it using its ordinary umask.
    await rename(root, join(h.directories.remote, 'saved-programs'));
    expect(existsSync(root)).toBe(false);
    evidence.runtimeRootMissingBeforeCommand = !existsSync(root);
    output = createHostHerdrPorts({ hc: h.hc, config, runtimeBytes: runtime, runtimePath: () => runtimePath });
    const errors: unknown[] = [];
    const journalRoot = join(h.root, 'jobs');
    jobs = createJobMonitor({ hc: h.hc, journalRoot, outputCollector: output.outputCollector, clock: Date.now, observedJobMessages: async () => [], notifier() {}, reportError: error => { errors.push(error); } });
    const remote = createRemoteExecutor({ hc: h.hc, jobs, prepare: prepareRemoteProgram, environmentPolicy: env => env, clock: Date.now,
      target: async machine => ({ on: machine, ...config.machines[0].runtime, environment: {}, nodePath: process.execPath, runtimePath, runtimeSha256: sha256(runtime) }),
      logSink: async job => output!.logReader(job.id),
    });
    const effect = join(h.root, 'payload-effect');
    const result = await runExec({ on, language: 'javascript', code: `(await import('node:fs')).writeFileSync(${JSON.stringify(effect)}, 'must not run')` }, { cwd: h.root, owner: h.owner!, remote });
    const journal = await createJobStore(journalRoot, h.owner!.sessionId).read();
    const receipt = JSON.parse(await readFile(join(journal.jobs[0].localDirectory, 'receipt.json'), 'utf8'));
    expect(existsSync(effect)).toBe(false);
    expect(receipt).toMatchObject({ outcome: 'spawn-error', exitCode: null, stdoutBytes: 0, stderrBytes: 0, error: expect.stringContaining('rerun spider herdr setup') });
    expect(journal.jobs[0].originalFinish).toMatchObject({ reason: 'exited', exitCode: 127 });
    expect(result.details).toMatchObject({ outcome: 'spawn-error', exitCode: null });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('rerun spider herdr setup');
    expect(result.text).not.toContain('Exit uncertain');
    expect(journal.jobs).toHaveLength(1);
    expect(journal.jobs[0].evidenceConflict).toBe(false);
    expect(errors).toEqual([]);
    evidence.command = { result, receipt, native: journal.jobs[0].originalFinish, payloadEffect: existsSync(effect), recreatedRootMode: (await stat(root)).mode & 0o777, runtimePath };
    console.info('FIRST COMMAND', evidence.command);
  } finally {
    await jobs?.shutdown('reload'); output?.dispose(); await cli.dispose(); vi.unstubAllEnvs();
    await h.close();
    evidence.cleanup = h.cleanupProof;
    await mkdir(resolve('.spider/scratch/e127'), { recursive: true });
    await writeFile(resolve('.spider/scratch/e127/real-evidence.json'), JSON.stringify(evidence, null, 2));
    console.info('CLEANUP', JSON.stringify(h.cleanupProof));
    expect(await h.remainingOwnedResources()).toEqual([]);
  }
}, 60000);
