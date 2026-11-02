// SPDX-License-Identifier: MIT
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createBashTool, createLocalBashOperations } from '@earendil-works/pi-coding-agent';
import { createHcClient } from '@spider/herdr/client/hc';
import { isCoreAvailable } from '@spider/herdr/client/liveness';
import { HerdrError } from '@spider/herdr/client/parse';
import { parseHerdrConfig } from '@spider/herdr/config';
import { registerHerdrJobs } from '@spider/herdr/jobs/register';
import type { JobMonitor } from '@spider/herdr/jobs/monitor';
import { processStartIdentity } from '@spider/herdr/jobs/handoff';
import { processStartTime } from '../../../subagents/src/process-identity.js';
import { createRemoteExecutor } from '@spider/herdr/remote/execute';
import { sha256 } from '@spider/herdr/remote/runtime';
import { runtimeInstallPath } from '@spider/herdr/setup/installer';
import { registerChildAgentConsoleLifecycle } from '@spider/herdr/remote/console';
import { guardHerdrToolCall, type RoutingPorts } from '@spider/herdr/ssh/register';
import { createSshPolicyReader } from '@spider/herdr/ssh/policy';
import { createTransportPolicy } from '@spider/herdr/ssh/admin';
import { createExecutionEnvironmentPolicy, ordinaryExecutionEnvironment, sshShimDirectory, SSH_DESCRIPTOR_ENV } from '@spider/herdr/ssh/shim';
import { readMachineSnapshot, type CacheDescriptor, type MachineSnapshot } from '@spider/herdr/ssh/cache';
import type { HcClient, HerdrConfig, Owner, RemoteExecutionPort, ExecutionEnvironmentPolicy, MachineName } from '@spider/herdr';
import { createRemoteFileResolver } from './remote-file.js';
import { disabledHerdrEnvironment, createHostHerdrPorts, type HostHerdrOptions, type HostHerdrPorts } from './ports.js';
import { controlConfig } from '../control.js';
import { paths } from '@spider/db-core';
import { createProcessPresence } from '@spider/herdr/sessions/presence';
import { explicitExtensionArguments } from './ports.js';
import { effectiveHerdrConfigPath, resolveRealSshBinary, type HerdrMount } from './mount.js';

export function mountChildHerdr(pi: ExtensionAPI, options: HostHerdrOptions, jobIdsForToolResult: typeof import('./mount.js').jobIdsForToolResult): HerdrMount {
  let client: ReturnType<typeof createHcClient> | null = null, owner: Owner | null = null, config: HerdrConfig | null = null;
  let monitor: JobMonitor | null = null, output: HostHerdrPorts | null = null, remote: RemoteExecutionPort | undefined;
  let remoteFiles: ReturnType<typeof createRemoteFileResolver> | null = null;
  let context: ExtensionContext | null = null, disposed = false;
  let runtimeBytes: Buffer | null = null, childIdentity: string | null = null;
  let environment: ExecutionEnvironmentPolicy = ordinaryExecutionEnvironment;
  let inheritedDescriptor: CacheDescriptor | null = null, inactiveReason = 'Child activation unavailable';
  let activationEnv: Readonly<NodeJS.ProcessEnv> | null = null;
  let coreWatch: ReturnType<typeof setInterval> | undefined, coreProbe: Promise<void> | undefined;
  let coreLost = false, expectedHerdr = false;
  let activationMode: unknown = 'auto';
  const inactiveNotices = new Set<string>();
  const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
  const inheritPolicy = () => {
    // The ssh package validates the inherited descriptor and its executable paths.
    const serialized = ordinaryExecutionEnvironment(process.env)[SSH_DESCRIPTOR_ENV];
    inheritedDescriptor = serialized ? (JSON.parse(serialized) as { cacheDescriptor: CacheDescriptor }).cacheDescriptor : null;
  };
  const need = <T>(value: T | null): T => { if (!value) throw new HerdrError('herdr-unavailable', 'No active Herdr child execution'); return value; };
  const hc: HcClient = new Proxy({} as HcClient, { get(_target, key) { const c = need(client), value = Reflect.get(c, key); return typeof value === 'function' ? value.bind(c) : value; } });
  const report = (error: unknown) => { try { options.reportError?.(error); } catch { /* Reporting must not break the embedding host. */ } };
  const notice = (error: unknown, force = false) => {
    if (!force && (activationMode === false || activationMode !== true && !expectedHerdr)) return;
    const sessionId = context?.sessionManager?.getSessionId?.() ?? '(child)';
    if (inactiveNotices.has(sessionId)) return;
    inactiveNotices.add(sessionId);
    const message = `Herdr inactive: ${describe(error).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1024)}`;
    try {
      if (context?.hasUI) context.ui.notify(message, activationMode === true ? 'error' : 'warning');
      else if (options.reportError) report(error);
      else process.stderr.write(`${message}\n`);
    } catch { /* A notice must never disable the embedding host. */ }
  };
  const presence = createProcessPresence(join(process.env.SPIDER_GLOBAL_ROOT ?? paths.globalRoot, 'herdr'));
  const identity = { pid: process.pid, startIdentity: '' };
  const recordPresence = async (ctx: ExtensionContext | undefined) => {
    try {
      if (!identity.startIdentity) identity.startIdentity = processStartTime(process.pid) ?? '';
      if (!identity.startIdentity) throw new HerdrError('child-identity-unavailable', 'Cannot read child process start time');
      await presence.record({ ...identity,
        sessionId: (ctx as Partial<ExtensionContext> | undefined)?.sessionManager?.getSessionId?.() as Owner['sessionId'] ?? null,
        sessionFile: (ctx as Partial<ExtensionContext> | undefined)?.sessionManager?.getSessionFile?.() ?? null,
        sessionName: pi.getSessionName?.() ?? null, kind: 'child', mode: ctx?.mode ?? 'unknown',
        extensionArguments: explicitExtensionArguments(process.argv), hcAddress: owner?.terminal.address ?? null,
      });
      return true;
    } catch (error) { inactiveReason = describe(error); notice(error, true); return false; }
  };
  async function closeResources() {
    clearInterval(coreWatch); coreWatch = undefined; activationEnv = null;
    runtimeBytes = null; childIdentity = null; remote = undefined; remoteFiles = null;
    await monitor?.shutdown('reload'); monitor = null;
    output?.dispose(); output = null; await client?.dispose(); client = null; owner = null;
    environment = coreLost ? disabledHerdrEnvironment : ordinaryExecutionEnvironment;
  }
  const probeCore = (): Promise<void> => {
    if (coreProbe) return coreProbe;
    const current = owner, descriptor = inheritedDescriptor, env = activationEnv;
    if (!env || disposed || coreLost || !current && !descriptor) return Promise.resolve();
    const pending = (async () => {
      if (await isCoreAvailable(env) || disposed || owner !== current || inheritedDescriptor !== descriptor) return;
      coreLost = true; inheritedDescriptor = null; owner = null;
      environment = disabledHerdrEnvironment; remote = undefined;
      inactiveReason = 'Herdr core unavailable; use /reload to recover';
      notice(new HerdrError('core-unavailable', inactiveReason), true);
      await closeResources();
    })().finally(() => { if (coreProbe === pending) coreProbe = undefined; });
    coreProbe = pending; return pending;
  };
  const watchCore = () => {
    if (disposed || coreLost || !owner && !inheritedDescriptor) return;
    activationEnv = Object.freeze({ ...process.env });
    coreWatch = setInterval(() => { void probeCore().catch(report); }, 2000); coreWatch.unref?.();
  };
  const registrationPi = new Proxy(pi, { get(target, key) {
    if (key === 'on') return (name: string, handler: Function) => (pi.on as Function)(name, (event: unknown, ...args: unknown[]) =>
      Promise.resolve().then(() => handler(event ?? {}, ...args)).catch(async error => {
        inactiveReason = describe(error); await closeResources().catch(report); notice(error, true);
      })) ?? (() => {});
    return Reflect.get(target, key);
  } });
  const offs = [registrationPi.on('session_start', async (_event, ctx) => {
    if (disposed || process.env.PI_SUBAGENT_CHILD !== '1') return;
    try {
      await monitor?.shutdown('reload'); await closeResources(); context = ctx ?? null; config = null;
      coreLost = false; environment = ordinaryExecutionEnvironment; activationMode = 'auto'; expectedHerdr = Boolean(process.env.HC_TERMINAL_ID);
      inactiveReason = 'Child activation unavailable'; inheritPolicy();
      const processReady = await recordPresence(ctx);
      if (!ctx?.sessionManager) return;
      try {
        if (options.readConfig) {
          expectedHerdr = true;
          config = await options.readConfig(ctx); activationMode = config?.enabled ?? 'auto';
          expectedHerdr = Boolean(config || process.env.HC_TERMINAL_ID);
          if (config?.enabled === false) environment = disabledHerdrEnvironment;
        }
        else {
          const enabled = controlConfig('get', ctx.cwd, 'herdr.enabled'); activationMode = enabled;
          if (enabled === false) environment = disabledHerdrEnvironment;
          const file = effectiveHerdrConfigPath(ctx.cwd); expectedHerdr ||= Boolean(file && existsSync(file));
          if (enabled !== false && file) config = parseHerdrConfig(JSON.parse(await readFile(file, 'utf8')));
          if (config && (enabled === true || enabled === 'auto')) config = { ...config, enabled };
        }
      } catch (error) { inactiveReason = describe(error); notice(error); return; }
      if (environment === disabledHerdrEnvironment) inheritedDescriptor = null;
      if (!processReady) return;
      if (!config || config.enabled === false || !process.env.HC_TERMINAL_ID) {
        inactiveReason = !config ? 'No Herdr configuration' : config.enabled === false ? 'herdr.enabled is false' : 'not inside Herdr';
        notice(new HerdrError('herdr-unavailable', inactiveReason)); return;
      }
      const sessionId = process.env.PI_SPIDER_TOP_SESSION_ID || process.env.PI_SPIDER_SESSION_ID;
      if (!sessionId || !process.env.PI_SUBAGENT_RUN_ID) {
        inactiveReason = 'Child owner session or run identity is missing'; notice(new HerdrError('herdr-unavailable', inactiveReason)); return;
      }
      try {
        const env = Object.freeze({ ...process.env });
        if (!await isCoreAvailable(env)) {
          coreLost = true; inheritedDescriptor = null; environment = disabledHerdrEnvironment;
          inactiveReason = 'Herdr core is not running'; notice(new HerdrError('core-unavailable', inactiveReason)); return;
        }
        childIdentity = processStartIdentity(process.pid);
        if (!childIdentity) throw new HerdrError('child-identity-unavailable', 'Cannot establish the child job writer identity');
        client = createHcClient({ binary: config.core.binary, env });
        const terminal = await client.caller(env);
        owner = { terminal, sessionId: sessionId as Owner['sessionId'], generation: randomBytes(16).toString('hex') as Owner['generation'], cwd: ctx.cwd, sessionFile: (ctx as Partial<ExtensionContext> | undefined)?.sessionManager?.getSessionFile?.() ?? null, name: process.env.PI_SUBAGENT_RUN_NAME ?? null };
        // Read existing enforcement artifacts. A child never refreshes the cache or installs the shim.
        const key = createHash('sha256').update(JSON.stringify([terminal.coreId, terminal.sessionNamespace, terminal.socket])).digest('hex');
        const cacheDescriptor = { path: join(config.globalRoot, 'herdr/ssh', `${key}.json`), identity: terminal };
        const shimDirectory = sshShimDirectory(cacheDescriptor);
        environment = createExecutionEnvironmentPolicy({ shimDirectory, realSshBinary: await resolveRealSshBinary(env, shimDirectory), shimProgram: join(options.packageRoot, 'dist/herdr/cli.mjs'), cacheDescriptor });
        runtimeBytes = await readFile(join(options.packageRoot, 'dist/herdr/remote-runtime.mjs'));
        remoteFiles = createRemoteFileResolver(hc, config.machines, { manager: ctx.sessionManager, id: ctx.sessionManager.getSessionId() });
        output = createHostHerdrPorts({ hc, config, runtimeBytes, runtimePath: on => runtimePath(on) });
        if (!await recordPresence(ctx)) await closeResources();
      } catch (error) { inactiveReason = describe(error); await closeResources(); notice(error); }
    } catch (error) { inactiveReason = describe(error); await closeResources().catch(report); notice(error, true); }
    finally { watchCore(); }
  })];
  const runtimePath = (on: string) => {
    const machine = need(config).machines.find(m => m.name === on);
    if (!machine) throw new HerdrError('machine-unconfigured', 'Destination is not configured');
    return runtimeInstallPath(machine.runtime.directory, need(runtimeBytes));
  };
  const jobs = registerHerdrJobs(registrationPi, { currentOwner: () => owner, jobIdsForToolResult, bind: m => {
    monitor = m;
    remote = m ? createRemoteExecutor({ hc, jobs: m, prepare: (source, target) => need(remoteFiles).prepare(source, target), environmentPolicy: env => environment(env), clock: Date.now, logSink: async job => need(output).logReader(job.id), target: async on => {
      const machine = need(config).machines.find(m => m.name === on); if (!machine) throw new HerdrError('machine-unconfigured', 'Destination is not configured');
      const bytes = need(runtimeBytes);
      return { on, ...machine.runtime, nodePath: machine.nodePath ?? 'node', environment: {}, runtimePath: runtimePath(on), runtimeSha256: sha256(bytes) };
    } }) : undefined;
  }, monitorOptions: () => ({ hc, clock: Date.now, journalRoot: join(need(config).globalRoot, 'herdr/jobs'), outputCollector: need(output).outputCollector, reportError: report,
    child: { id: process.env.PI_SUBAGENT_RUN_ID as import('@spider/herdr').RunId, pid: process.pid, startIdentity: need(childIdentity) },
  }) });
  const consoles = registerChildAgentConsoleLifecycle(registrationPi, { hc, currentOwner: () => owner });
  offs.push(registrationPi.on('session_shutdown', async () => { await closeResources(); await presence.remove(identity); context = null; }));
  // Active children read hc; inactive children retain their parent's read-only policy.
  const transportPolicy = createTransportPolicy(createSshPolicyReader(async () => {
    if (!owner) return inheritedDescriptor ? readMachineSnapshot(inheritedDescriptor) : null;
    const terminal = need(owner).terminal;
    let machines: Awaited<ReturnType<HcClient['machines']>>;
    try { machines = await hc.machines(); }
    catch {
      await probeCore();
      return inheritedDescriptor ? readMachineSnapshot(inheritedDescriptor) : null;
    }
    const snapshot: MachineSnapshot = { version: 1, identity: terminal, fetchedAt: Date.now(), machines: machines.map(machine => ({ id: machine.id, name: machine.name, targets: [...new Set([machine.name, ...machine.aliases, ...(need(config).machines.find(m => m.name === machine.name)?.aliases ?? [])])] })) };
    return snapshot;
  }), () => process.env);
  const withCause = async (decision: ReturnType<typeof transportPolicy.checkShell>) => {
    const result = await decision;
    return result.kind === 'refuse' && !owner ? { ...result, reason: `Herdr child inactive: ${inactiveReason}. ${result.reason}` } : result;
  };
  const policy = { checkArgv: (argv: readonly string[]) => withCause(transportPolicy.checkArgv(argv)), checkShell: (code: string) => withCause(transportPolicy.checkShell(code)) };
  const routing: RoutingPorts = { policy, environmentPolicy: env => environment(env), currentOwner: () => owner, createBashTool, createLocalBashOperations,
    enabled: () => Boolean(owner || inheritedDescriptor), readShellFile: async (file, on) => on ? need(remoteFiles).read(file, on as MachineName) : readFile(resolve(context?.cwd ?? process.cwd(), file), 'utf8'),
  };
  return { owner: () => owner, enabled: () => Boolean(owner && config && config.enabled !== false), execution: () => ({ ...(owner ? { owner } : {}), ...(remote ? { remote } : {}), environmentPolicy: env => environment(env) }), guard: async event => {
      await probeCore();
      if (!owner && event.input.on !== undefined) return { block: true, reason: 'herdr-disabled: on requires an enabled live Herdr owner' };
      const refusal = await guardHerdrToolCall(event, routing);
      if (refusal) await probeCore();
      if (coreLost) return event.input.on !== undefined ? { block: true, reason: 'herdr-disabled: on requires an enabled live Herdr owner' } : undefined;
      return refusal;
    },
    async dispose() { if (disposed) return; disposed = true; for (const off of offs) off(); await jobs.dispose(); await consoles.dispose(); await closeResources(); await presence.remove(identity); },
  };
}
