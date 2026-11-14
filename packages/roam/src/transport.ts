import { posix } from 'node:path';
import { createArgvClient } from '@spider/herdr/client/argv-client';
import { invokeCli, machineAliases } from '@spider/herdr/client/hc';
import type { CliRequestOptions } from '@spider/herdr/client/cli-transport';
import { HerdrError, object, parseCore, selectedSocket, text } from '@spider/herdr/client/parse';
import { DEFAULT_LIMITS } from './contracts';
import { BOOTSTRAP_AGENT_DIRECTORY_SCRIPT, BOOTSTRAP_IDENTITY_SCRIPT, BOOTSTRAP_SCRIPT, BOOTSTRAP_SETTINGS_SCRIPT } from './bootstrap-script';
import { PROVISION_REMOTE_SCRIPT } from './provision-remote-script';
import { isMachineId } from './machine-id';
import { normalizeConfiguredClis, normalizeCoreUnit, parseBootstrapInventory, sanitizeBootstrapError } from './bootstrap-reply';
import type { BootstrapPeer, CallOptions, Journal, Peer, Transport } from './contracts';
import type { AgentDirectoryProbe, CoreFence } from './provision-contracts';
import { validSettingsDigests } from './selected-files';
import type { SettingsDestinationPreview, SettingsKeyDigest } from './selected-files';

type CoreObservation = CoreFence;
interface Resolved { peer: Peer; core: CoreObservation; invalidated?: 'core-changed' | 'peer-invalidated' }
type Route = { kind: 'enrolled'; peer: Peer } | { kind: 'bootstrap'; peer: BootstrapPeer };

function coreChanged(): HerdrError & { retryable: true } {
  return Object.assign(new HerdrError('core-changed', 'Herdr core identity changed; resolve the peer again'), { retryable: true as const });
}
function invalidHandle(state: Resolved): HerdrError & { retryable: true } {
  return state.invalidated === 'core-changed' ? coreChanged()
    : Object.assign(new HerdrError('peer-invalidated', 'The peer handle is no longer valid; resolve it again'), { retryable: true as const });
}
function observationFailure(error: unknown): unknown {
  return error instanceof HerdrError && (error.code === 'core-unavailable' || error.code === 'machine-not-found')
    ? Object.assign(error, { retryable: true as const }) : error;
}
function sameCore(a: CoreObservation, b: CoreObservation): boolean {
  return a.local === b.local && a.remote === b.remote;
}
function validCore(value: unknown): value is CoreObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const core = value as Record<string, unknown>;
  return Object.keys(core).length === 2 && ['local', 'remote'].every(key => typeof core[key] === 'string' &&
    (core[key] as string).length > 0 && (core[key] as string).length <= 4096 && !/[\u0000-\u001f\u007f]/.test(core[key] as string));
}
function samePeer(a: Peer, b: Peer): boolean {
  return a.machineId === b.machineId && a.alias === b.alias && a.node === b.node && a.pi === b.pi &&
    a.cli === b.cli && a.core === b.core && a.globalRoot === b.globalRoot;
}
function snapshotCall(options: CallOptions): CallOptions {
  return { timeoutMs: options.timeoutMs, maxBytes: options.maxBytes,
    ...(options.stdin === undefined ? {} : { stdin: Buffer.from(options.stdin) }),
    ...(options.remoteTimeoutMs === undefined ? {} : { remoteTimeoutMs: options.remoteTimeoutMs }),
    ...(options.postReserveMs === undefined ? {} : { postReserveMs: options.postReserveMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.stdinForTimeout === undefined ? {} : { stdinForTimeout: options.stdinForTimeout }),
    ...(options.onConnected === undefined ? {} : { onConnected: options.onConnected }) };
}
function privateProtocol(argv: readonly string[]): boolean {
  return argv[0] === 'roam' && (argv[1] === 'agent' || argv[1] === 'observe' || argv[1] === 'artifact' && argv[2] === 'receive' ||
    argv[1] === 'intercom' && argv[2] === 'exchange');
}
function remoteArgs(peer: Peer, argv: readonly string[]): string[] {
  return [peer.node, peer.cli, ...(privateProtocol(argv) ? ['--global-root', peer.globalRoot] : []), ...argv];
}
function bootstrapTarget(value: BootstrapPeer): BootstrapPeer {
  const invalid = () => { throw new HerdrError('invalid-bootstrap-request', 'Invalid bootstrap probe request'); };
  if (!value || typeof value !== 'object') return invalid();
  const { alias, node, pi, cli, globalRoot } = value;
  if (typeof alias !== 'string' || !alias || alias.length > 255 || alias.trim() !== alias || /[\u0000-\u001f\u007f]/.test(alias) ||
      [node, pi, cli, globalRoot].some(file => typeof file !== 'string' || file.length > 4096 || !posix.isAbsolute(file) || /[\u0000-\u001f\u007f]/.test(file))) return invalid();
  return Object.freeze({ alias, node, pi, cli, globalRoot });
}
function deadline(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new HerdrError('invalid-cli-deadline', 'A finite positive deadline is required');
  }
}

interface TransportOptions { binary: string; env: Readonly<NodeJS.ProcessEnv>; enrolled: readonly Peer[] }
export interface ProvisionTransport {
  transport: Transport;
  probeAgentDirectory(peer: Peer, home: string): Promise<AgentDirectoryProbe>;
  previewSettings(peer: Peer, home: string, entries: readonly SettingsKeyDigest[], maximum: number, core: CoreFence): Promise<SettingsDestinationPreview>;
  claimIdentity(peer: Peer, operationId: string, core: CoreFence): Promise<{ machineId: string; coreId: string }>;
  executeProvision(peer: Peer, request: Record<string, unknown>): Promise<unknown>;
  launchRelease(peer: Peer, operationId: string, requestFile: string): Promise<{ terminal: string }>;
}

function transportPorts(options: TransportOptions, journal?: Journal): ProvisionTransport {
  const binary = options.binary;
  const client = createArgvClient({ binary, env: options.env });
  const env = Object.freeze({ ...options.env, HC_SOCKET: selectedSocket(options.env) });
  const enrolled = options.enrolled;
  const current = new Map<string, Resolved>();
  const handles = new WeakMap<Peer, Resolved>();
  const provisionCores = new Map<string, CoreObservation>();

  async function observe(alias: string, signal: AbortSignal): Promise<{ core: CoreObservation; connected: boolean }> {
    const call = { timeoutMs: DEFAULT_LIMITS.controlMs, signal };
    const local = parseCore(await invokeCli(binary, ['server', 'status', '--json'], env, DEFAULT_LIMITS.replyBytes, undefined, call), env).coreId;
    const reply = object(await invokeCli(binary, ['machine', 'ls', '--json'], env, DEFAULT_LIMITS.replyBytes, undefined, call));
    if (!Array.isArray(reply.machines)) throw new HerdrError('invalid-reply', 'Expected a machine list');
    const rows = reply.machines.map(object);
    const exact = rows.filter(machine => machine.name === alias);
    const normalized = alias.toLowerCase().replace(/\.$/, '');
    const matches = exact.length ? exact : rows.filter(machine => machineAliases(machine).includes(normalized));
    if (!matches.length) throw new HerdrError('machine-not-found', 'The enrolled machine is unavailable');
    if (matches.length !== 1) throw new HerdrError('machine-ambiguous', 'The enrolled machine alias is ambiguous');
    return { core: { local, remote: text(matches[0].id) }, connected: matches[0].state === 'connected' };
  }

  function invalidate(alias: string, expected: Resolved | undefined, reason: Resolved['invalidated'] = 'peer-invalidated'): void {
    if (current.get(alias) === expected) {
      current.delete(alias);
      if (expected) expected.invalidated = reason;
    }
  }
  function enrollment(peer: Peer): Peer {
    const matches = enrolled.filter(candidate => candidate.alias === peer.alias);
    if (matches.length !== 1 || !samePeer(matches[0], peer)) {
      throw new HerdrError('machine-not-enrolled', 'The requested machine is not enrolled');
    }
    return matches[0];
  }
  function resolved(peer: Peer): Resolved {
    const state = handles.get(peer);
    if (!state) throw new HerdrError('unresolved-peer', 'Resolve the enrolled machine before using it');
    if (current.get(state.peer.alias) !== state) throw invalidHandle(state);
    try { enrollment(state.peer); }
    catch (error) { invalidate(state.peer.alias, state); throw error; }
    return state;
  }

  async function bracket<T>(route: Route, expected: Resolved | undefined, timeoutMs: number,
    call: (signal: AbortSignal, remainingMs: number, core: CoreObservation) => Promise<T>,
    options?: { signal?: AbortSignal; onConnected?: (connected: boolean) => void }): Promise<{ value: T; core: CoreObservation }> {
    const alias = route.peer.alias;
    const observed = expected ?? current.get(alias);
    const requireEnrollment = () => {
      if (route.kind === 'bootstrap') return;
      try { enrollment(route.peer); }
      catch (error) { invalidate(alias, observed); throw error; }
    };
    deadline(timeoutMs);
    const aborter = new AbortController();
    const aborted = () => aborter.abort();
    if (options?.signal?.aborted) throw new HerdrError('cli-aborted', 'CLI request aborted');
    options?.signal?.addEventListener('abort', aborted, { once: true });
    const expiresAt = performance.now() + timeoutMs;
    let timedOut = false;
    const timeout = () => Object.assign(new HerdrError('cli-timeout', `Herdr request exceeded ${timeoutMs} ms`, { timeoutMs }), { retryable: true as const });
    const remaining = () => {
      const ms = Math.floor(expiresAt - performance.now());
      if (ms <= 0) { timedOut = true; aborter.abort(); throw timeout(); }
      return ms;
    };
    const timer = setTimeout(() => { timedOut = true; aborter.abort(); }, timeoutMs);
    try {
      requireEnrollment();
      let before: Awaited<ReturnType<typeof observe>>;
      try { before = await observe(alias, aborter.signal); }
      catch (error) { invalidate(alias, observed); throw observationFailure(error); }
      if (expected && current.get(alias) !== expected) throw invalidHandle(expected);
      if (expected && !sameCore(before.core, expected.core)) {
        invalidate(alias, expected, 'core-changed'); throw coreChanged();
      }
      requireEnrollment();
      options?.onConnected?.(before.connected);
      let value: T | undefined;
      let failure: unknown;
      let failed = false;
      try { value = await call(aborter.signal, remaining(), before.core); }
      catch (error) { failed = true; failure = error; }
      if (aborter.signal.aborted) throw new HerdrError('cli-aborted', 'CLI request aborted');
      let after: Awaited<ReturnType<typeof observe>>;
      try { after = await observe(alias, aborter.signal); }
      catch (error) { invalidate(alias, observed); throw observationFailure(error); }
      if (!sameCore(before.core, after.core)) {
        invalidate(alias, observed, 'core-changed'); throw coreChanged();
      }
      if (expected && current.get(alias) !== expected) throw invalidHandle(expected);
      requireEnrollment();
      remaining();
      if (failed) throw failure;
      return { value: value as T, core: before.core };
    } catch (error) {
      if (timedOut || performance.now() >= expiresAt) { invalidate(alias, observed); throw timeout(); }
      if (options?.signal?.aborted) throw new HerdrError('cli-aborted', 'CLI request aborted');
      throw error;
    } finally { clearTimeout(timer); options?.signal?.removeEventListener('abort', aborted); }
  }

  const transport: Transport = {
    async resolve(peer, options) {
      const configured = Object.freeze({ ...enrollment(peer) });
      const previous = current.get(configured.alias);
      const file = posix.join(configured.globalRoot, 'roam', 'machine.json');
      const pinned = provisionCores.get(configured.alias);
      const observation = await bracket({ kind: 'enrolled', peer: configured }, undefined, options?.timeoutMs ?? DEFAULT_LIMITS.fileMs, (signal, remainingMs, core) => {
        if (pinned && !sameCore(core, pinned)) throw coreChanged();
        return client.exec(configured.alias, ['cat', '--', file], { timeoutMs: remainingMs, maxBytes: DEFAULT_LIMITS.replyBytes, signal });
      }, { signal: options?.signal })
        .catch(error => { invalidate(configured.alias, previous); throw error; });
      let machineId: unknown;
      try { machineId = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(observation.value))).machineId; }
      catch { invalidate(configured.alias, previous); throw new HerdrError('machine-mismatch', 'Cannot verify the enrolled machine identity'); }
      if (machineId !== configured.machineId) {
        invalidate(configured.alias, previous); throw new HerdrError('machine-mismatch', 'The remote machine identity does not match enrollment');
      }
      const existing = current.get(configured.alias);
      const handle = Object.freeze({ ...configured });
      const state = existing && sameCore(existing.core, observation.core) && samePeer(existing.peer, configured)
        ? existing : { peer: handle, core: observation.core };
      if (existing && state !== existing) existing.invalidated = sameCore(existing.core, observation.core) ? 'peer-invalidated' : 'core-changed';
      current.set(configured.alias, state);
      handles.set(handle, state);
      return handle;
    },
    async bootstrapProbe(peer, kind, options) {
      if (kind !== 'inventory') throw new HerdrError('invalid-bootstrap-kind', 'Unsupported bootstrap probe');
      const target = bootstrapTarget(peer);
      const timeoutMs = options?.timeoutMs ?? DEFAULT_LIMITS.controlMs;
      const maxBytes = options?.maxBytes ?? 64 * 1024;
      deadline(timeoutMs);
      if (timeoutMs > DEFAULT_LIMITS.directMs) throw new HerdrError('invalid-cli-deadline', 'Direct execution requires a deadline of at most 600 seconds');
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new HerdrError('invalid-byte-limit', 'A positive bootstrap reply limit is required');
      const checks = normalizeConfiguredClis(options?.configuredClis);
      const coreUnit = normalizeCoreUnit(options?.coreUnit);
      if (options?.expectedCore !== undefined && !validCore(options.expectedCore)) throw new HerdrError('invalid-bootstrap-request', 'Invalid bootstrap probe request');
      const pinned = provisionCores.get(target.alias);
      if (pinned && options?.expectedCore && !sameCore(pinned, options.expectedCore)) throw coreChanged();
      const expectedCore = options?.expectedCore ? { ...options.expectedCore } : pinned;
      const stdin = Buffer.from(JSON.stringify({ pi: target.pi, cli: target.cli, globalRoot: target.globalRoot, coreUnit,
        checks: checks.map(({ executable, authFile }) => ({ executable, authFile })) }));
      if (stdin.length > 300_000) throw new HerdrError('invalid-bootstrap-request', 'Invalid bootstrap probe request');
      const result = await bracket({ kind: 'bootstrap', peer: target }, undefined, timeoutMs, (signal, remainingMs, core) => {
        if (expectedCore && !sameCore(core, expectedCore)) throw coreChanged();
        return client.exec(target.alias, [target.node, '-e', BOOTSTRAP_SCRIPT],
          { timeoutMs: remainingMs, maxBytes: Math.min(maxBytes, 64 * 1024), stdin, signal });
      })
        .catch(error => { throw sanitizeBootstrapError(error); });
      return parseBootstrapInventory(result.value, target, checks.length, coreUnit);
    },
    async exec(peer, argv, options: CallOptions) {
      const state = resolved(peer);
      const args = remoteArgs(state.peer, argv);
      const call = snapshotCall(options);
      return (await bracket({ kind: 'enrolled', peer: state.peer }, state, call.timeoutMs, (signal, remainingMs) =>
        client.exec(state.peer.alias, args, { ...call, timeoutMs: remainingMs, signal }),
      { signal: call.signal, onConnected: call.onConnected })).value;
    },
    async run(peer, argv, operationId) {
      if (!operationId || /[\u0000-\u001f\u007f]/.test(operationId)) {
        throw new HerdrError('invalid-operation', 'A valid operation ID is required for a background launch');
      }
      const state = resolved(peer);
      const args = remoteArgs(state.peer, argv);
      return (await bracket({ kind: 'enrolled', peer: state.peer }, state, DEFAULT_LIMITS.launchMs, signal =>
        client.run(state.peer.alias, args, { 'spider.operation': operationId, 'spider.machine': state.peer.machineId }, { signal }))).value;
    },
    async read(peer, path, options: CallOptions) {
      const state = resolved(peer);
      const call = snapshotCall(options);
      return (await bracket({ kind: 'enrolled', peer: state.peer }, state, call.timeoutMs, (signal, remainingMs) =>
        client.exec(state.peer.alias, ['cat', '--', path], { ...call, timeoutMs: remainingMs, signal }))).value;
    },
    async write(peer, path, bytes, timeoutMs) {
      const state = resolved(peer);
      const target = state.peer.alias.startsWith('-') ? [`--on=${state.peer.alias}`] : ['--on', state.peer.alias];
      const input = Buffer.from(bytes);
      await bracket({ kind: 'enrolled', peer: state.peer }, state, timeoutMs, async (signal, remainingMs) => {
        const call = { timeoutMs: remainingMs, signal, strictInput: true } satisfies CliRequestOptions;
        try { return await invokeCli(binary, ['file', 'write', '--json', ...target, '--', path], env, DEFAULT_LIMITS.replyBytes, input, call); }
        catch (error) {
          throw new HerdrError(error instanceof HerdrError ? error.code : 'cli-error', 'Remote file write failed');
        }
      });
    },
  };

  return {
    transport,
    async launchRelease(peer, operationId, requestFile) {
      const state = resolved(peer);
      if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId) ||
          requestFile !== posix.join(state.peer.globalRoot, 'roam', 'provision', operationId, 'release-request')) {
        throw new HerdrError('invalid-provision-request', 'Invalid provisioning request');
      }
      const approved = journal?.read(operationId).some(({ action, result }) => action === 'provision-consent' && result.approved === true &&
        result.target === state.peer.alias && result.machineId === state.peer.machineId);
      if (!approved) throw new HerdrError('consent-required', 'Provisioning consent must be recorded before installation');
      try {
        return (await bracket({ kind: 'enrolled', peer: state.peer }, state, DEFAULT_LIMITS.launchMs, signal =>
          client.run(state.peer.alias, [state.peer.node, '--input-type=module-typescript', '-e', PROVISION_REMOTE_SCRIPT, requestFile],
            { 'spider.operation': operationId, 'spider.machine': state.peer.machineId }, { signal }))).value;
      } catch (error) {
        const allowed = new Set(['core-changed', 'core-unavailable', 'machine-not-found', 'machine-ambiguous', 'machine-not-enrolled',
          'peer-invalidated', 'cli-timeout', 'cli-aborted', 'cli-exit', 'missing-hc', 'spawn-error', 'reply-too-large']);
        const candidate = error instanceof HerdrError ? error.code : '';
        const safe = new HerdrError(allowed.has(candidate) ? candidate : 'release-launch-uncertain', 'Release launch needs reconciliation');
        if (error && typeof error === 'object' && 'retryable' in error && error.retryable === true) Object.assign(safe, { retryable: true });
        throw safe;
      }
    },
    async executeProvision(peer, request) {
      const state = resolved(peer);
      const actions = new Set(['enrollment', 'prepare', 'secret-chunk', 'cleanup', 'install-files', 'auth-install', 'release-prepare', 'release-observe', 'unit-write', 'systemctl', 'switchover', 'verify', 'clear-secrets']);
      if (!request || typeof request !== 'object' || typeof request.action !== 'string' || !actions.has(request.action) ||
          typeof request.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.operationId) ||
          request.machineId !== state.peer.machineId || request.globalRoot !== state.peer.globalRoot || request.node !== state.peer.node ||
          request.pi !== state.peer.pi || request.cli !== state.peer.cli) throw new HerdrError('invalid-provision-request', 'Invalid provisioning request');
      const consent = journal?.read(request.operationId).find(({ action, result }) => action === 'provision-consent' &&
        result.approved === true && result.target === state.peer.alias && result.machineId === state.peer.machineId);
      if (!consent) throw new HerdrError('consent-required', 'Provisioning consent must be recorded before installation');
      const file = request.file && typeof request.file === 'object' && !Array.isArray(request.file) ? request.file as Record<string, unknown> : null;
      const secretFile = request.action === 'install-files' && Array.isArray(file?.chunks) && file.chunks.some(chunk =>
        chunk && typeof chunk === 'object' && typeof chunk.name === 'string' && chunk.name.startsWith('secret-'));
      if ((request.action === 'auth-install' || request.action === 'secret-chunk' || secretFile) &&
          (!Array.isArray(request.providers) || !request.providers.length || request.providers.length > 64 ||
            new Set(request.providers).size !== request.providers.length || !Array.isArray(consent.result.providers) ||
            request.providers.some(provider => typeof provider !== 'string' || !(consent.result.providers as unknown[]).includes(provider)))) {
        throw new HerdrError('consent-required', 'Authentication providers must be confirmed before installation');
      }
      const timeout = DEFAULT_LIMITS.controlMs;
      let result: { value: Buffer; core: CoreObservation };
      try {
        result = await bracket({ kind: 'enrolled', peer: state.peer }, state, timeout, async (signal, remainingMs, core) => {
          let stdin: Buffer;
          try { stdin = Buffer.from(JSON.stringify({ ...request, core: state.peer.core, coreId: core.remote })); }
          catch { throw new HerdrError('invalid-provision-request', 'Invalid provisioning request'); }
          try {
            if (stdin.length > 2 * 1024 * 1024) throw new HerdrError('invalid-provision-request', 'Provisioning request is too large');
            return await client.exec(state.peer.alias, [state.peer.node, '--input-type=module-typescript', '-e', PROVISION_REMOTE_SCRIPT],
              { timeoutMs: remainingMs, maxBytes: 64 * 1024, stdin, signal });
          } finally { stdin.fill(0); }
        });
      } catch (error) {
        const allowed = new Set(['core-changed', 'core-unavailable', 'machine-not-found', 'machine-ambiguous', 'machine-not-enrolled',
          'peer-invalidated', 'cli-timeout', 'cli-aborted', 'cli-exit', 'stdin-error', 'missing-hc', 'spawn-error', 'reply-too-large', 'invalid-provision-request']);
        const candidate = error instanceof HerdrError ? error.code : '';
        const safe = new HerdrError(allowed.has(candidate) ? candidate : 'provision-transport-failed', 'Provisioning transport failed');
        if (error && typeof error === 'object' && 'retryable' in error && error.retryable === true) Object.assign(safe, { retryable: true });
        throw safe;
      }
      let reply: Record<string, unknown>;
      try { reply = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.value))); }
      catch { throw new HerdrError('invalid-provision-reply', 'Invalid provisioning reply'); }
      if (reply.kind !== 'provision' || reply.version !== 1 || Object.keys(reply).length !== 3) {
        throw new HerdrError('invalid-provision-reply', 'Invalid provisioning reply');
      }
      if (Object.hasOwn(reply, 'error')) {
        const allowed = new Set(['invalid-enrollment', 'unsafe-enrollment', 'enrollment-identity-mismatch', 'enrollment-conflict', 'enrollment-publication-pending',
          'invalid-request', 'invalid-staging-name', 'unsafe-path', 'unsafe-staging', 'invalid-chunk', 'invalid-chunks',
          'chunk-mismatch', 'too-large', 'command-failed', 'unsafe-context', 'machine-mismatch', 'invalid-limits', 'invalid-file',
          'invalid-release', 'release-hash-mismatch', 'incomplete-release', 'pi-version-mismatch', 'invalid-unit', 'invalid-systemctl',
          'unsafe-release', 'invalid-switchover-journal', 'missing-switchover-backup', 'unknown-provision-action', 'provision-failed',
          'selection-not-allowed', 'unsafe-destination', 'invalid-destination-settings', 'settings-preview-changed', 'invalid-settings-preview',
          'credential-file-requires-consent', 'provider-consent-required', 'invalid-providers', 'invalid-auth', 'unsafe-auth', 'provider-unavailable',
          'unsupported-credential-command', 'invalid-release-request', 'invalid-release-receipt', 'release-arguments-changed',
          'release-evidence-unavailable', 'release-in-progress', 'process-identity-unavailable', 'operation-arguments-changed', 'short-write-pending', 'core-unavailable', 'core-changed']);
        if (typeof reply.error !== 'string' || !allowed.has(reply.error)) throw new HerdrError('invalid-provision-reply', 'Invalid provisioning reply');
        if (reply.error === 'core-changed') { invalidate(state.peer.alias, state, 'core-changed'); throw coreChanged(); }
        throw new HerdrError(reply.error, 'Provisioning operation failed');
      }
      if (!Object.hasOwn(reply, 'value')) throw new HerdrError('invalid-provision-reply', 'Invalid provisioning reply');
      if (request.action === 'enrollment') {
        if (reply.value !== 'enrolled' && reply.value !== 'already-enrolled') throw new HerdrError('invalid-provision-reply', 'Invalid enrollment reply');
      } else if (request.action === 'release-observe') {
        const value = object(reply.value);
        if (value.state === 'absent') {
          if (Object.keys(value).length !== 2 || typeof value.prepared !== 'boolean') throw new HerdrError('invalid-provision-reply', 'Invalid provisioning reply');
        } else if (value.state === 'started') {
          if (Object.keys(value).length !== 1) throw new HerdrError('invalid-provision-reply', 'Invalid provisioning reply');
        } else if (value.state === 'failed') {
          if (Object.keys(value).length !== 2 || !['installer-interrupted', 'release-install-failed', 'command-failed', 'release-hash-mismatch',
            'incomplete-release', 'pi-version-mismatch'].includes(String(value.reason))) throw new HerdrError('invalid-provision-reply', 'Invalid provisioning reply');
        } else if (value.state === 'finished') {
          const installed = object(value.value);
          if (Object.keys(value).length !== 2 || Object.keys(installed).length !== 3 || installed.pi !== state.peer.pi ||
            installed.cli !== state.peer.cli || installed.supervisor !== request.supervisor) throw new HerdrError('invalid-provision-reply', 'Invalid provisioning reply');
        } else throw new HerdrError('invalid-provision-reply', 'Invalid provisioning reply');
      } else if (request.action === 'switchover') {
        const value = object(reply.value);
        if (Object.keys(value).length !== 1 || !['applied', 'already', 'migration-pending'].includes(String(value.status))) {
          throw new HerdrError('invalid-provision-reply', 'Invalid provisioning reply');
        }
      } else if (request.action === 'verify') {
        const value = object(reply.value), keys = ['piSignedIn', 'nativeSqlite', 'extensionLoaded', 'exactSession', 'privateModes',
          'bundledIntercom', 'intercomUnique', 'legacyDrained', 'federation'];
        if (Object.keys(value).length !== keys.length || keys.some(key => typeof value[key] !== 'boolean')) {
          throw new HerdrError('invalid-provision-reply', 'Invalid provisioning reply');
        }
      } else if (reply.value !== true) throw new HerdrError('invalid-provision-reply', 'Invalid provisioning reply');
      return reply.value;
    },
    async probeAgentDirectory(peer, home) {
      const target = bootstrapTarget(peer);
      if (typeof home !== 'string' || home.length > 4096 || home === '/' || !posix.isAbsolute(home) ||
          posix.normalize(home) !== home || /[\u0000-\u001f\u007f]/.test(home)) {
        throw new HerdrError('invalid-bootstrap-request', 'Invalid agent directory probe request');
      }
      try {
        const result = await bracket({ kind: 'bootstrap', peer: target }, undefined, DEFAULT_LIMITS.controlMs, async (signal, remainingMs) => {
          const stdin = Buffer.from(JSON.stringify({ home }));
          let bytes: Buffer;
          try { bytes = await client.exec(target.alias, [target.node, '-e', BOOTSTRAP_AGENT_DIRECTORY_SCRIPT],
            { timeoutMs: remainingMs, maxBytes: 1024, stdin, signal }); }
          finally { stdin.fill(0); }
          let reply: Record<string, unknown>;
          try { reply = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
          catch { throw new HerdrError('invalid-bootstrap-reply', 'Invalid agent directory reply'); }
          if (reply.version !== 1 || reply.kind !== 'agent-directory' || Object.keys(reply).length !== 3) {
            throw new HerdrError('invalid-bootstrap-reply', 'Invalid agent directory reply');
          }
          if (reply.error === 'agent-directory-probe-failed') throw new HerdrError('agent-directory-probe-failed', 'Agent directory probe failed');
          if (reply.value !== 'default' && reply.value !== 'custom' && reply.value !== 'unknown') {
            throw new HerdrError('invalid-bootstrap-reply', 'Invalid agent directory reply');
          }
          return reply.value;
        });
        if (!validCore(result.core)) throw new HerdrError('invalid-bootstrap-reply', 'Invalid core identity');
        return { status: result.value, core: { ...result.core } };
      } catch (error) {
        const allowed = new Set(['core-changed', 'core-unavailable', 'machine-not-found', 'machine-ambiguous', 'cli-timeout',
          'cli-aborted', 'cli-exit', 'spawn-error', 'missing-hc', 'reply-too-large', 'invalid-bootstrap-reply', 'agent-directory-probe-failed']);
        const code = error instanceof HerdrError && allowed.has(error.code) ? error.code : 'agent-directory-probe-failed';
        const safe = new HerdrError(code, 'Agent directory probe failed');
        if (error && typeof error === 'object' && 'retryable' in error && error.retryable === true) Object.assign(safe, { retryable: true });
        throw safe;
      }
    },
    async previewSettings(peer, home, entries, maximum, requestedCore) {
      const target = bootstrapTarget(peer);
      if (typeof home !== 'string' || home === '/' || home.length > 4096 || !posix.isAbsolute(home) || posix.normalize(home) !== home ||
          /[\u0000-\u001f\u007f]/.test(home) || !validCore(requestedCore) || !validSettingsDigests(entries) ||
          !Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 256 * 1024 * 1024) {
        throw new HerdrError('invalid-bootstrap-request', 'Invalid settings preview request');
      }
      const expectedCore = { ...requestedCore }, prior = provisionCores.get(target.alias);
      if (prior && !sameCore(prior, expectedCore)) throw coreChanged();
      const snapshot = entries.map(entry => ({ path: [...entry.path], sha256: entry.sha256 }));
      const stdin = Buffer.from(JSON.stringify({ home, agentDir: posix.join(home, '.pi', 'agent'), paths: snapshot.map(entry => entry.path), maximum }));
      if (stdin.length > 2 * 1024 * 1024) { stdin.fill(0); throw new HerdrError('invalid-bootstrap-request', 'Invalid settings preview request'); }
      try {
        const result = await bracket({ kind: 'bootstrap', peer: target }, undefined, DEFAULT_LIMITS.controlMs, async (signal, remainingMs, core) => {
          if (!sameCore(core, expectedCore)) throw coreChanged();
          const bytes = await client.exec(target.alias, [target.node, '--input-type=module-typescript', '-e', BOOTSTRAP_SETTINGS_SCRIPT],
            { timeoutMs: remainingMs, maxBytes: 2 * 1024 * 1024, stdin, signal });
          let reply: Record<string, unknown>;
          try { reply = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
          catch { throw new HerdrError('invalid-bootstrap-reply', 'Invalid settings preview reply'); }
          if (reply.version !== 1 || reply.kind !== 'settings-preview' || Object.keys(reply).length !== 3) throw new HerdrError('invalid-bootstrap-reply', 'Invalid settings preview reply');
          if (Object.hasOwn(reply, 'error')) {
            if (typeof reply.error !== 'string' || !['invalid-destination-settings', 'unsafe-destination', 'invalid-settings-preview', 'settings-preview-failed'].includes(reply.error)) {
              throw new HerdrError('invalid-bootstrap-reply', 'Invalid settings preview reply');
            }
            throw new HerdrError(reply.error, 'Settings preview failed');
          }
          const value = object(reply.value);
          if (Object.keys(value).sort().join(',') !== 'digests,fingerprint' || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
              !Array.isArray(value.digests) || value.digests.length !== snapshot.length ||
              value.digests.some(digest => digest !== null && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)))) {
            throw new HerdrError('invalid-bootstrap-reply', 'Invalid settings preview reply');
          }
          const changedKeys = snapshot.filter((entry, index) => entry.sha256 !== (value.digests as (string | null)[])[index])
            .map(entry => entry.path.join('.')).sort();
          return { fingerprint: value.fingerprint, changedKeys };
        });
        return result.value;
      } catch (error) {
        const allowed = new Set(['core-changed', 'core-unavailable', 'machine-not-found', 'machine-ambiguous', 'cli-timeout', 'cli-aborted',
          'cli-exit', 'spawn-error', 'missing-hc', 'reply-too-large', 'invalid-bootstrap-reply', 'invalid-destination-settings', 'unsafe-destination',
          'invalid-settings-preview', 'settings-preview-failed']);
        const code = error instanceof HerdrError && allowed.has(error.code) ? error.code : 'settings-preview-failed';
        const safe = new HerdrError(code, 'Settings preview failed');
        if (error && typeof error === 'object' && 'retryable' in error && error.retryable === true) Object.assign(safe, { retryable: true });
        throw safe;
      } finally { stdin.fill(0); }
    },
    async claimIdentity(peer, operationId, requestedCore) {
      const target = bootstrapTarget(peer);
      if (!validCore(requestedCore)) throw new HerdrError('invalid-bootstrap-request', 'Invalid identity bootstrap request');
      const expectedCore = { ...requestedCore }, prior = provisionCores.get(target.alias);
      if (prior && !sameCore(prior, expectedCore)) throw coreChanged();
      if (!isMachineId(peer.machineId) || typeof peer.core !== 'string' || !posix.isAbsolute(peer.core) ||
          peer.core.length > 4096 || /[\u0000-\u001f\u007f]/.test(peer.core) ||
          typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) {
        throw new HerdrError('invalid-bootstrap-request', 'Invalid identity bootstrap request');
      }
      const approved = journal?.read(operationId).some(({ action, result }) => action === 'provision-consent' &&
        result.approved === true && result.target === target.alias && result.machineId === peer.machineId);
      if (!approved) throw new HerdrError('consent-required', 'Provisioning consent must be recorded before identity creation');
      try {
        const result = await bracket({ kind: 'bootstrap', peer: target }, undefined, DEFAULT_LIMITS.controlMs, async (signal, remainingMs, core) => {
          if (!sameCore(core, expectedCore)) throw coreChanged();
          const stdin = Buffer.from(JSON.stringify({ globalRoot: target.globalRoot, machineId: peer.machineId, core: peer.core, coreId: core.remote, operationId }));
          const bytes = await client.exec(target.alias, [target.node, '--input-type=module-typescript', '-e', BOOTSTRAP_IDENTITY_SCRIPT],
            { timeoutMs: remainingMs, maxBytes: 16 * 1024, stdin, signal });
          let reply: Record<string, unknown>;
          try { reply = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
          catch { throw new HerdrError('invalid-bootstrap-reply', 'Invalid identity bootstrap reply'); }
          if (reply.version !== 1 || reply.kind !== 'identity') throw new HerdrError('invalid-bootstrap-reply', 'Invalid identity bootstrap reply');
          if (Object.hasOwn(reply, 'error')) {
            if (Object.keys(reply).length !== 3 || typeof reply.error !== 'string' ||
                !['invalid-request', 'core-unavailable', 'core-changed', 'unsafe-identity', 'machine-mismatch', 'identity-bootstrap-failed'].includes(reply.error)) {
              throw new HerdrError('invalid-bootstrap-reply', 'Invalid identity bootstrap reply');
            }
            if (reply.error === 'core-changed') throw coreChanged();
            throw new HerdrError(reply.error, 'Identity bootstrap failed');
          }
          if (Object.keys(reply).length !== 4 || !Object.hasOwn(reply, 'coreId') || !Object.hasOwn(reply, 'machineId')) {
            throw new HerdrError('invalid-bootstrap-reply', 'Invalid identity bootstrap reply');
          }
          if (reply.coreId !== core.remote) throw coreChanged();
          if (reply.machineId !== peer.machineId) throw new HerdrError('machine-mismatch', 'The remote machine identity does not match enrollment');
          return { machineId: peer.machineId, coreId: core.remote };
        });
        provisionCores.set(target.alias, expectedCore);
        return result.value;
      } catch (error) {
        const safe = sanitizeBootstrapError(error);
        safe.message = 'Identity bootstrap failed';
        throw safe;
      }
    },
  };
}

export function createTransport(options: TransportOptions): Transport {
  return transportPorts(options).transport;
}

/** A narrow pre-enrollment identity operation, separate from ordinary transport. */
export function createProvisionTransport(options: TransportOptions, journal: Journal): ProvisionTransport {
  return transportPorts(options, journal);
}
