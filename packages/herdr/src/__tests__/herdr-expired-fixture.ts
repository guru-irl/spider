// SPDX-License-Identifier: MIT
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { createJobMonitor } from '../jobs/monitor.js';
import { createJobStore, type JobJournal } from '../jobs/store.js';
import { parseHerdrConfig } from '../config.js';
import { setupHerdr } from '../setup/installer.js';
import { installRuntimeDirectory } from '../remote/runtime.js';
import { prepareRemoteProgram } from '../../../context/src/remote-plan.js';
import { createHostHerdrPorts, createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import type { HcClient, RemoteExecuteRequest, TerminalAddress } from '../contracts.js';
import type { RemoteExecutionPorts } from '../remote/execute.js';

export interface ExpiredRemoteFixture {
  h: HerdrHarness; ports: RemoteExecutionPorts; request(code: string): RemoteExecuteRequest;
  expired: Set<TerminalAddress>; journal(): Promise<JobJournal>; close(): Promise<void>;
}
export async function createExpiredRemoteFixture(mode: 'fake' | 'hc' = 'fake'): Promise<ExpiredRemoteFixture> {
  const h = await createHerdrHarness(mode); await h.start();
  const payloads = new Set<TerminalAddress>(), expired = new Set<TerminalAddress>();
  const removals = new Map<TerminalAddress, Promise<void>>();
  const expire = (address: TerminalAddress) => {
    let removing = removals.get(address);
    if (!removing) { removing = h.hc.rm(address).then(() => { expired.add(address); }); removals.set(address, removing); }
    return removing;
  };
  const hc: HcClient = { ...h.hc,
    run: async request => { const handle = await h.hc.run(request); if (request.labels['spider.job']) payloads.add(handle.address); return handle; },
    events: () => {
      const stream = h.hc.events();
      return { ...stream,
        subscribe: listener => stream.subscribe(event => {
          if (event.type === 'finished' && payloads.has(event.terminal)) { void expire(event.terminal); return; }
          if (event.type === 'snapshot' || event.type === 'missed') {
            listener({ ...event, terminals: event.terminals.filter(t => { if (payloads.has(t.address) && t.state === 'finished') { void expire(t.address); return false; } return true; }) });
          } else listener(event);
        }),
        lookup: async address => { const terminal = await stream.lookup(address); if (terminal?.state === 'finished' && payloads.has(address)) { await expire(address); return null; } return terminal; },
      };
    },
  };
  const config = parseHerdrConfig({ enabled: true, app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', nodePath: process.execPath, runtime: { directory: join(h.directories.remote, 'programs'), cwd: null, commands: {} } }] });
  const packageRoot = join(h.root, 'package'); await mkdir(join(packageRoot, 'dist/herdr'), { recursive: true });
  await writeFile(join(packageRoot, 'dist/herdr/remote-runtime.mjs'), await readFile(resolve('dist/herdr/remote-runtime.mjs')));
  const cli = createProductionHerdrCliPorts(packageRoot, h.localEnv);
  let runtime: Awaited<ReturnType<Awaited<ReturnType<typeof cli.setupParts>>['ensureRuntime']>>[number];
  try {
    const request = { config, configPath: join(h.root, 'config.json'), packageRoot, journalRoot: join(h.root, 'setup') }, parts = await cli.setupParts(request);
    await setupHerdr(request, { ...parts, hc,
      preflight: async () => ({ fingerprint: 'expired-proof', coreIdentity: h.owner!.terminal, mods: [], targets: [], retiredTerminals: [], layoutExport: true }), stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [], bootstrapRuntime: async () => { await installRuntimeDirectory(config.machines[0].runtime.directory); }, cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }) });
    [runtime] = await parts.ensureRuntime(request, {} as never);
  } catch (error) { await h.close(); throw error; }
  finally { await cli.dispose(); }
  const output = createHostHerdrPorts({ hc, config, runtimeBytes: runtime.bytes, runtimePath: () => runtime.path });
  const journalRoot = join(h.root, 'jobs');
  const jobs = createJobMonitor({ hc, journalRoot, outputCollector: output.outputCollector, observedJobMessages: async () => [], notifier() {}, clock: Date.now });
  const on = config.machines[0].name;
  const ports: RemoteExecutionPorts = { hc, jobs, prepare: prepareRemoteProgram, environmentPolicy: env => env, clock: Date.now, target: async machine => { if (machine !== on) throw Object.assign(new Error('Machine is not configured'), { code: 'machine-not-found' }); return { on, ...config.machines[0].runtime, environment: {}, nodePath: process.execPath, runtimePath: runtime.path, runtimeSha256: runtime.sha256 }; }, logSink: async job => output.logReader(job.id) };
  const request = (code: string): RemoteExecuteRequest => ({ source: { kind: 'code', language: 'javascript', code }, on, owner: h.owner! });
  return { h, ports, request, expired, journal: () => createJobStore(journalRoot, h.owner!.sessionId).read(), async close() {
    await jobs.shutdown('reload'); output.dispose(); await Promise.all(removals.values()); await h.close();
  } };
}
