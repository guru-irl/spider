import { posix } from 'node:path';
import { createArgvClient } from '@spider/herdr/client/argv-client';
import { invokeCli, machineAliases } from '@spider/herdr/client/hc';
import type { CliRequestOptions } from '@spider/herdr/client/cli-transport';
import { HerdrError, object, parseCore, selectedSocket, text } from '@spider/herdr/client/parse';
import { DEFAULT_LIMITS } from './contracts';
import type { CallOptions, Peer, Transport } from './contracts';

interface CoreObservation { local: string; remote: string }
interface Resolved { peer: Peer; core: CoreObservation; invalidated?: 'core-changed' | 'peer-invalidated' }

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
function samePeer(a: Peer, b: Peer): boolean {
  return a.machineId === b.machineId && a.alias === b.alias && a.node === b.node && a.pi === b.pi &&
    a.cli === b.cli && a.core === b.core && a.globalRoot === b.globalRoot;
}
function snapshotCall(options: CallOptions): CallOptions {
  return { timeoutMs: options.timeoutMs, maxBytes: options.maxBytes,
    ...(options.stdin === undefined ? {} : { stdin: Buffer.from(options.stdin) }) };
}
function privateProtocol(argv: readonly string[]): boolean {
  return argv[0] === 'roam' && (argv[1] === 'agent' || argv[1] === 'observe' || argv[1] === 'artifact' && argv[2] === 'receive');
}
function remoteArgs(peer: Peer, argv: readonly string[]): string[] {
  return [peer.node, peer.cli, ...(privateProtocol(argv) ? ['--global-root', peer.globalRoot] : []), ...argv];
}
function deadline(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new HerdrError('invalid-cli-deadline', 'A finite positive deadline is required');
  }
}

export function createTransport(options: { binary: string; env: Readonly<NodeJS.ProcessEnv>; enrolled: readonly Peer[] }): Transport {
  const binary = options.binary;
  const client = createArgvClient({ binary, env: options.env });
  const env = Object.freeze({ ...options.env, HC_SOCKET: selectedSocket(options.env) });
  const enrolled = options.enrolled;
  const current = new Map<string, Resolved>();
  const handles = new WeakMap<Peer, Resolved>();

  async function observe(alias: string, signal: AbortSignal): Promise<CoreObservation> {
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
    return { local, remote: text(matches[0].id) };
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

  async function bracket<T>(peer: Peer, expected: Resolved | undefined, timeoutMs: number,
    call: (signal: AbortSignal, remainingMs: number) => Promise<T>): Promise<{ value: T; core: CoreObservation }> {
    const alias = peer.alias;
    const observed = expected ?? current.get(alias);
    const requireEnrollment = () => {
      try { enrollment(peer); }
      catch (error) { invalidate(alias, observed); throw error; }
    };
    deadline(timeoutMs);
    const aborter = new AbortController();
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
      let before: CoreObservation;
      try { before = await observe(alias, aborter.signal); }
      catch (error) { invalidate(alias, observed); throw observationFailure(error); }
      if (expected && current.get(alias) !== expected) throw invalidHandle(expected);
      if (expected && !sameCore(before, expected.core)) {
        invalidate(alias, expected, 'core-changed'); throw coreChanged();
      }
      requireEnrollment();
      let value: T | undefined;
      let failure: unknown;
      let failed = false;
      try { value = await call(aborter.signal, remaining()); }
      catch (error) { failed = true; failure = error; }
      let after: CoreObservation;
      try { after = await observe(alias, aborter.signal); }
      catch (error) { invalidate(alias, observed); throw observationFailure(error); }
      if (!sameCore(before, after)) {
        invalidate(alias, observed, 'core-changed'); throw coreChanged();
      }
      if (expected && current.get(alias) !== expected) throw invalidHandle(expected);
      requireEnrollment();
      remaining();
      if (failed) throw failure;
      return { value: value as T, core: before };
    } catch (error) {
      if (timedOut || performance.now() >= expiresAt) { invalidate(alias, observed); throw timeout(); }
      throw error;
    } finally { clearTimeout(timer); }
  }

  return {
    async resolve(peer) {
      const configured = Object.freeze({ ...enrollment(peer) });
      const previous = current.get(configured.alias);
      const file = posix.join(configured.globalRoot, 'roam', 'machine.json');
      const observation = await bracket(configured, undefined, DEFAULT_LIMITS.fileMs, (signal, remainingMs) =>
        client.exec(configured.alias, ['cat', '--', file], { timeoutMs: remainingMs, maxBytes: DEFAULT_LIMITS.replyBytes, signal }))
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
    async exec(peer, argv, options: CallOptions) {
      const state = resolved(peer);
      const args = remoteArgs(state.peer, argv);
      const call = snapshotCall(options);
      return (await bracket(state.peer, state, call.timeoutMs, (signal, remainingMs) =>
        client.exec(state.peer.alias, args, { ...call, timeoutMs: remainingMs, signal }))).value;
    },
    async run(peer, argv, operationId) {
      if (!operationId || /[\u0000-\u001f\u007f]/.test(operationId)) {
        throw new HerdrError('invalid-operation', 'A valid operation ID is required for a background launch');
      }
      const state = resolved(peer);
      const args = remoteArgs(state.peer, argv);
      return (await bracket(state.peer, state, DEFAULT_LIMITS.launchMs, signal =>
        client.run(state.peer.alias, args, { 'spider.operation': operationId, 'spider.machine': state.peer.machineId }, { signal }))).value;
    },
    async read(peer, path, options: CallOptions) {
      const state = resolved(peer);
      const call = snapshotCall(options);
      return (await bracket(state.peer, state, call.timeoutMs, (signal, remainingMs) =>
        client.exec(state.peer.alias, ['cat', '--', path], { ...call, timeoutMs: remainingMs, signal }))).value;
    },
    async write(peer, path, bytes, timeoutMs) {
      const state = resolved(peer);
      const target = state.peer.alias.startsWith('-') ? [`--on=${state.peer.alias}`] : ['--on', state.peer.alias];
      const input = Buffer.from(bytes);
      await bracket(state.peer, state, timeoutMs, async (signal, remainingMs) => {
        const call = { timeoutMs: remainingMs, signal, strictInput: true } satisfies CliRequestOptions;
        try { return await invokeCli(binary, ['file', 'write', '--json', ...target, '--', path], env, DEFAULT_LIMITS.replyBytes, input, call); }
        catch (error) {
          throw new HerdrError(error instanceof HerdrError ? error.code : 'cli-error', 'Remote file write failed');
        }
      });
    },
  };
}
