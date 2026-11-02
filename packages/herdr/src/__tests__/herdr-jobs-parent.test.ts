// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createHerdrHarness } from './testutil.js';
import { createJobMonitor } from '../jobs/monitor.js';
import { ensureAgentConsole, closeAgentConsoles } from '../remote/console.js';
import { parseHerdrConfig } from '../config.js';
import { setupHerdr, runtimeInstallPath } from '../setup/installer.js';
import { sha256 } from '../remote/runtime.js';
import { prepareRemoteProgram } from '../../../context/src/remote-plan.js';
import { createHostHerdrPorts, createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { effectiveHerdrConfigPath } from '../../../host/src/herdr/mount.js';
import type { TerminalAddress, RuntimeTarget } from '../contracts.js';

const binary = process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc');
const real = process.env.SPIDER_HERDR_E2E === '1' && await access(binary).then(() => true, () => false);
if (!real) console.info('SKIP parent survival real proof: requires hc and SPIDER_HERDR_E2E=1; isolated cores only, no app');

async function prove(mode: 'fake' | 'hc') {
  // Omitting parent:null on either launch reintroduces the app's tree-kill edge.
  const h = await createHerdrHarness(mode);
  const setup = createProductionHerdrCliPorts(h.root, h.localEnv);
  let jobs: ReturnType<typeof createJobMonitor> | undefined;
  let output: ReturnType<typeof createHostHerdrPorts> | undefined;
  try {
    await h.start(); execFileSync('git', ['init', '-q', h.root]); vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global);
    const file = join(h.directories.global, 'herdr/config.json');
    await mkdir(join(file, '..'), { recursive: true });
    const config = parseHerdrConfig({ enabled: true, core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') },
      app: { binary: h.appBinary, home: h.directories.app }, globalRoot: h.directories.global, agentDirectory: h.directories.agent, shellRc: join(h.root, 'shellrc'), spaces: [],
      machines: [{ name: 'remote.invalid', nodePath: process.execPath, runtime: { directory: join(h.directories.remote, 'runtime'), cwd: null, commands: {} } }] });
    await writeFile(file, JSON.stringify(config)); await writeFile(join(config.app.home, 'settings.json'), '{}');
    await mkdir(join(h.root, 'packages/herdr'), { recursive: true });
    await cp(resolve('packages/herdr/assets'), join(h.root, 'packages/herdr/assets'), { recursive: true });
    await cp(resolve('dist/herdr'), join(h.root, 'dist/herdr'), { recursive: true });
    const request = { config, configPath: file, packageRoot: h.root, journalRoot: join(h.directories.global, 'herdr/setup') }, parts = await setup.setupParts(request);
    await setupHerdr(request, { ...parts,
      preflight: async () => ({ fingerprint: 'parent-proof', coreIdentity: h.owner!.terminal, mods: ['spider-panel', 'spider-machines'].map(name => ({ directory: join(h.directories.app, 'mods', name) })), targets: [], retiredTerminals: [], layoutExport: true }),
      stageLook: async () => [], generateTemplates: async () => [], installResume: async () => [], cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }),
    });
    expect(effectiveHerdrConfigPath(h.root)).toBe(file);
    const runtime = await readFile(resolve('dist/herdr/remote-runtime.mjs'));
    const runtimePath = runtimeInstallPath(config.machines[0].runtime.directory, runtime);
    expect((await h.hc.fileRead('remote.invalid' as never, runtimePath)).equals(runtime)).toBe(true);
    output = createHostHerdrPorts({ hc: h.hc, config, runtimeBytes: runtime, runtimePath: () => runtimePath });
    jobs = createJobMonitor({ hc: h.hc, journalRoot: join(h.root, 'jobs'), outputCollector: output.outputCollector, clock: Date.now, notifier() {}, observedJobMessages: async () => [] });
    const target: RuntimeTarget = { on: 'remote.invalid' as never, ...config.machines[0].runtime, environment: {}, nodePath: process.execPath, runtimePath, runtimeSha256: sha256(runtime) };
    const source = { kind: 'code', language: 'shell', code: 'sleep 120' } as const;
    const job = await jobs.start(await prepareRemoteProgram(source, target), h.owner!, target.on, { background: true });
    const console = await ensureAgentConsole({ owner: h.owner!, on: target.on, target, source, job }, h.hc, h.localEnv);
    expect(console).not.toBeNull();
    const before = await Promise.all([job.address, console!.address].map(address => h.hc.get(address)));
    expect(before.map(t => t.parent)).toEqual([null, null]);
    // app 0.1.11 kills the owner and every unkept live descendant, recursively.
    const all = (await h.cli(['ls', '--all', '--json']) as { terminals: { address: TerminalAddress; parent: TerminalAddress | null; state: string; labels: Record<string, string> }[] }).terminals;
    const victims = new Set<TerminalAddress>([h.owner!.terminal.address]);
    let changed = true;
    while (changed) { changed = false; for (const t of all) if (t.state === 'live' && t.parent && victims.has(t.parent) && !t.labels['herdr.space'] && !victims.has(t.address)) { victims.add(t.address); changed = true; } }
    for (const address of victims) await h.hc.kill(address);
    await h.hc.rm(h.owner!.terminal.address);
    await expect(h.hc.get(h.owner!.terminal.address)).rejects.toMatchObject({ code: 'not_found' });
    const after = await Promise.all([job.address, console!.address].map(address => h.hc.get(address)));
    expect(after.map(t => t.state)).toEqual(['live', 'live']);
    expect(after.map(t => t.parent)).toEqual([null, null]);
    await consoleInfo(mode, { localSocket: h.localSocket, remoteSocket: h.remoteSocket, localCore: h.localCoreId, remoteCore: h.remoteCoreId, owner: h.owner!.terminal.address, before: before.map(t => ({ address: t.address, parent: t.parent })), after: after.map(t => ({ address: t.address, state: t.state, parent: t.parent })), killed: [...victims] });
  } finally {
    await jobs?.shutdown('reload'); output?.dispose();
    if (h.owner) await closeAgentConsoles(h.owner, h.hc);
    await setup.dispose(); vi.unstubAllEnvs(); await h.close();
    expect(await h.remainingOwnedResources()).toEqual([]);
    await consoleInfo(mode, { cleanup: h.cleanupProof });
  }
}
async function consoleInfo(mode: string, evidence: unknown) {
  console.info('PARENT SURVIVAL', mode, JSON.stringify(evidence));
  const file = resolve(`.spider/scratch/fx5-parent-${mode}-${'cleanup' in (evidence as object) ? 'cleanup' : 'evidence'}.json`);
  await writeFile(file, JSON.stringify(evidence, null, 2));
}
it('fake: jobs and consoles have no parent and survive removal of their owner tree', () => prove('fake'), 45000);
it.skipIf(!real)('real isolated hc: jobs and consoles have no parent and survive removal of their owner tree', () => prove('hc'), 60000);
