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
import { HERDR_NOTICES, herdrErrorNotice, remoteUnavailableNotice, inactiveHerdrNotice, inactiveHerdrGuardNotice, type InactiveReason } from '@spider/herdr/notices';
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
import { resolveMachine } from './machine.js';
import { withRemoteCopy } from './copy.js';
import { killOwnedJob, findOwnedKillJobs } from './kill-job.js';
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
  const runtimePaths = new Map<string, string>();
  let environment: ExecutionEnvironmentPolicy = ordinaryExecutionEnvironment;
  let inheritedDescriptor: CacheDescriptor | null = null, inactiveReason: InactiveReason = 'activation-problem';
  let activationEnv: Readonly<NodeJS.ProcessEnv> | null = null;
  let coreWatch: ReturnType<typeof setInterval> | undefined, coreProbe: Promise<void> | undefined;
  let coreLost = false, expectedHerdr = false;
  let activationMode: unknown = 'auto';
  let remoteUnavailableReason: string | undefined;
  const inactiveNotices = new Set<string>();
  const inheritPolicy = () => {
    // The ssh package validates the inherited descriptor and its executable paths.
    const serialized = ordinaryExecutionEnvironment(process.env)[SSH_DESCRIPTOR_ENV];
    inheritedDescriptor = serialized ? (JSON.parse(serialized) as { cacheDescriptor: CacheDescriptor }).cacheDescriptor : null;
  };
  const need = <T>(value: T | null): T => { if (!value) throw new HerdrError('herdr-unavailable', 'No active Herdr child execution'); return value; };
  const hc: HcClient = new Proxy({} as HcClient, { get(_target, key) { const c = need(client), value = Reflect.get(c, key); return typeof value === 'function' ? value.bind(c) : value; } });
  const report = (error: unknown, notice?: string) => { try { if (options.reportError) options.reportError(error, notice); else process.stderr.write((notice ?? herdrErrorNotice(error)) + '\n'); } catch { /* Reporting must not break the embedding host. */ } };
  const notice = (reason: InactiveReason, error?: unknown, force = false) => {
    if (error !== undefined) remoteUnavailableReason = remoteUnavailableNotice(error, 'subagent', 'activation');
    if (!force && (activationMode === false || activationMode !== true && !expectedHerdr)) return;
    const sessionId = context?.sessionManager?.getSessionId?.() ?? '(child)';
    if (inactiveNotices.has(sessionId)) return;
    inactiveNotices.add(sessionId);
    const message = error instanceof HerdrError ? herdrErrorNotice(error) : inactiveHerdrNotice(reason);
    try {
      if (context?.hasUI) context.ui.notify(message, activationMode === true ? 'error' : 'warning');
      else if (options.reportError) report(error ?? new Error(message), message);
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
    } catch (error) { inactiveReason = 'child-presence'; notice(inactiveReason, error, true); return false; }
  };
  async function closeResources() {
    clearInterval(coreWatch); coreWatch = undefined; activationEnv = null;
    runtimeBytes = null; childIdentity = null; remote = undefined; remoteFiles = null; runtimePaths.clear();
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
      inactiveReason = 'core-down';
      notice(inactiveReason, new HerdrError('core-unavailable', 'Herdr core unavailable'), true);
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
        inactiveReason = 'activation-problem'; await closeResources().catch(report); notice(inactiveReason, error, true);
      })) ?? (() => {});
    return Reflect.get(target, key);
  } });
  const offs = [registrationPi.on('session_start', async (_event, ctx) => {
    if (disposed || process.env.PI_SUBAGENT_CHILD !== '1') return;
    try {
      await monitor?.shutdown('reload'); await closeResources(); context = ctx ?? null; config = null;
      remoteUnavailableReason = undefined;
      coreLost = false; environment = ordinaryExecutionEnvironment; activationMode = 'auto'; expectedHerdr = Boolean(process.env.HC_TERMINAL_ID);
      inactiveReason = 'activation-problem'; inheritPolicy();
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
          const file = effectiveHerdrConfigPath(ctx.cwd, ctx); expectedHerdr ||= Boolean(file && existsSync(file));
          if (enabled !== false && file) config = parseHerdrConfig(JSON.parse(await readFile(file, 'utf8')));
          if (config && (enabled === true || enabled === 'auto')) config = { ...config, enabled };
        }
      } catch (error) { inactiveReason = 'config-problem'; notice(inactiveReason, error); return; }
      if (environment === disabledHerdrEnvironment) inheritedDescriptor = null;
      if (!processReady) return;
      if (!config || config.enabled === false || !process.env.HC_TERMINAL_ID) {
        inactiveReason = !config || config.enabled === false ? 'no-config' : 'outside';
        notice(inactiveReason); return;
      }
      const sessionId = process.env.PI_SPIDER_TOP_SESSION_ID || process.env.PI_SPIDER_SESSION_ID;
      if (!sessionId || !process.env.PI_SUBAGENT_RUN_ID) {
        inactiveReason = 'child-missing'; notice(inactiveReason); return;
      }
      try {
        const env = Object.freeze({ ...process.env });
        if (!await isCoreAvailable(env)) {
          coreLost = true; inheritedDescriptor = null; environment = disabledHerdrEnvironment;
          inactiveReason = 'core-down'; notice(inactiveReason); return;
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
      } catch (error) { inactiveReason = 'activation-problem'; await closeResources(); notice(inactiveReason, error); }
    } catch (error) { inactiveReason = 'activation-problem'; await closeResources().catch(report); notice(inactiveReason, error, true); }
    finally { watchCore(); }
  })];
  const runtimePath = (on: string) => {
    const path = runtimePaths.get(on);
    if (!path) throw new HerdrError('runtime-target-unavailable', 'Destination runtime has not been resolved');
    return path;
  };
  const jobs = registerHerdrJobs(registrationPi, { currentOwner: () => owner, jobIdsForToolResult,
    activationFailed: error => { remoteUnavailableReason = remoteUnavailableNotice(error, 'subagent', 'monitor'); }, bind: m => {
    monitor = m;
    if (m) remoteUnavailableReason = undefined;
    remote = m ? withRemoteCopy(createRemoteExecutor({ hc, jobs: m, prepare: (source, target) => need(remoteFiles).prepare(source, target), environmentPolicy: env => environment(env), clock: Date.now, logSink: async (job, readerOptions) => need(output).logReader(job.id, readerOptions), target: async on => {
      const resolved = await resolveMachine(hc, need(config).machines, on), machine = resolved.machine;
      const bytes = need(runtimeBytes);
      runtimePaths.set(resolved.on, runtimeInstallPath(machine.runtime.directory, bytes));
      return { on: resolved.on, ...machine.runtime, nodePath: machine.nodePath ?? 'node', environment: {}, runtimePath: runtimePath(resolved.on), runtimeSha256: sha256(bytes) };
    } }), hc, () => need(config).machines) : undefined;
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
    return result.kind === 'refuse' && !owner ? { ...result, reason: `${inactiveHerdrGuardNotice(inactiveReason)} ${result.reason}` } : result;
  };
  const policy = { checkArgv: (argv: readonly string[]) => withCause(transportPolicy.checkArgv(argv)), checkShell: (code: string) => withCause(transportPolicy.checkShell(code)) };
  const routing: RoutingPorts = { policy, environmentPolicy: env => environment(env), currentOwner: () => owner, createBashTool, createLocalBashOperations,
    enabled: () => Boolean(owner || inheritedDescriptor), readShellFile: async (file, on) => on ? need(remoteFiles).read(file, on as MachineName) : readFile(resolve(context?.cwd ?? process.cwd(), file), 'utf8'),
  };
  return { owner: () => owner, enabled: () => Boolean(owner && config && config.enabled !== false), findKillJobs: id => findOwnedKillJobs(id, need(owner), join(need(config).globalRoot, 'herdr/jobs')), killJob: id => killOwnedJob(id, need(owner), hc, need(config).machines, join(need(config).globalRoot, 'herdr/jobs'), remote), execution: () => ({ ...(owner ? { owner } : {}), ...(remote ? { remote } : {}), ...(!remote && remoteUnavailableReason ? { remoteUnavailableReason } : {}), environmentPolicy: env => environment(env) }), guard: async event => {
      await probeCore();
      if (!coreLost && !remote && remoteUnavailableReason && event.input.on !== undefined) return { block: true, reason: remoteUnavailableReason };
      if (!owner && event.input.on !== undefined) return { block: true, reason: coreLost ? HERDR_NOTICES.childCoreLost.text : HERDR_NOTICES.remoteDisabled.text };
      const refusal = await guardHerdrToolCall(event, routing);
      if (refusal) await probeCore();
      if (coreLost) return event.input.on !== undefined ? { block: true, reason: HERDR_NOTICES.childCoreLost.text } : undefined;
      return refusal;
    },
    async dispose() { if (disposed) return; disposed = true; for (const off of offs) off(); await jobs.dispose(); await consoles.dispose(); await closeResources(); await presence.remove(identity); },
  };
}
