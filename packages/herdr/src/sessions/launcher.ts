// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { open, constants, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HERDR_LABELS, type SessionId } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { canonicalSessionFile, launchEnvironment, refuseExplicitExtensions, type LaunchEnvironment } from './registry.js';
import { assessSessionLiveness, recordedSessionLiveness, type SessionLeasePolicy, type ProcessIdentity, type ProcessInventoryPorts, type SessionLeases } from './lease.js';
import { claimIdLock, inspectIdLock } from './id-lock.js';
import { exactLaunchArgv } from './launch-limits.js';
import { launchHandoffPath, removeLaunchHandoff, writeLaunchHandoff } from './launch-handoff.js';
export interface SessionLaunchRequest { sessionFile: string; sessionId: SessionId; cwd: string; environment: LaunchEnvironment }
export interface ExactTerminalLaunch {
  background: true; noNotify: true; outliveParent: true; parent: null; labels: Readonly<Record<string, string>>;
}
export interface PiSpawnRequest extends SessionLaunchRequest { argv: readonly string[]; env: Readonly<NodeJS.ProcessEnv>; terminal?: ExactTerminalLaunch }
export interface SessionLaunchResult extends ProcessIdentity { sessionFile: string; sessionId: SessionId; cwd: string; token: string; operationId?: string }
export interface SessionLaunchPorts {
  leases: SessionLeases; processInventory: ProcessInventoryPorts; processIdentity: ProcessIdentity;
  leasePolicy?: SessionLeasePolicy;
  env: Readonly<NodeJS.ProcessEnv>; spawnPi(request: PiSpawnRequest): Promise<ProcessIdentity | void>;
  publishMapping?(result: SessionLaunchResult, request: SessionLaunchRequest): Promise<void>;
}
export function safeLaunchEnvironment(env: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const safe = { ...env }; for (const key of Object.keys(safe)) if (key.startsWith('SPIDER_HERDR_LEASE_') || key.startsWith('SPIDER_HERDR_HANDOFF_') || key === 'SPIDER_HERDR_SSH_BYPASS') delete safe[key]; return safe;
}
export async function readSessionHeader(file: string): Promise<{ id: SessionId; cwd: string }> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); const buffer = Buffer.alloc(65536); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); const line = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]; const header = JSON.parse(line) as { type?: unknown; id?: unknown; cwd?: unknown; version?: unknown }; if (header.type !== 'session' || typeof header.id !== 'string' || !header.id || typeof header.cwd !== 'string' || !isAbsolute(header.cwd) || ![1, 2, 3].includes(Number(header.version ?? 1))) throw new Error('Invalid header'); return { id: header.id as SessionId, cwd: header.cwd }; }
  catch { throw new HerdrError('session-file-invalid', 'Session has no valid persistent header'); }
  finally { await handle?.close(); }
}
export async function launchSession(request: SessionLaunchRequest, ports: SessionLaunchPorts): Promise<SessionLaunchResult> {
  const environment = launchEnvironment(request.environment); refuseExplicitExtensions(request.sessionId, environment.extensionArguments); if (!isAbsolute(request.cwd)) throw new HerdrError('launch-environment-invalid', 'Session cwd must be absolute');
  const file = await canonicalSessionFile(request.sessionFile);
  const policy = ports.leasePolicy ?? { mode: 'cutover' };
  const live = policy.mode === 'bookkeeping' ? { kind: 'free' as const } : policy.mode === 'switch' ? await recordedSessionLiveness(file, ports.processInventory, request.sessionId) : await assessSessionLiveness(file, ports.processInventory);
  if (live.kind !== 'free') throw new HerdrError('session-may-be-live', `Session is held by PID ${live.pids.join(', ')}. Close that session before resuming it.`);
  const lease = await ports.leases.claim(file, ports.processIdentity, ports.processInventory, policy);
  let starting = false;
  try {
    const header = await readSessionHeader(file); if (header.id !== request.sessionId) throw new HerdrError('session-id-mismatch', 'Session file identity changed');
    const argv = ['pi', '--session', file];
    const env = { ...safeLaunchEnvironment(ports.env), PI_CODING_AGENT_DIR: environment.agentDirectory, SPIDER_HERDR_LEASE_TOKEN: lease.token, SPIDER_HERDR_LEASE_FILE: file };
    starting = true; const process = await ports.spawnPi({ ...request, sessionFile: file, environment, argv, env });
    if (!process) throw new HerdrError('process-identity-unavailable', 'Cannot prove launched pi identity');
    await ports.leases.transfer(file, lease.token, process);
    const result = { ...process, token: lease.token, sessionFile: file, sessionId: header.id, cwd: request.cwd };
    await ports.publishMapping?.(result, { ...request, sessionFile: file, environment }); return result;
  } catch (error) {
    // A lost spawn/publication reply must not authorize a second writer. Inventory can reclaim after proved exit.
    if (!starting) await ports.leases.release(file, lease.token); throw error;
  }
}

export interface ExactSessionLaunchRequest {
  sessionId: string; file: string; cwd: string; sha256: string; epoch: number; moveId: string | null; pi: string;
}
export type LaunchNoStartProof =
  | ({ kind: 'prelaunch-error'; operationId: string; beforeLaunch: true } &
      ({ errorCode: 'core-unavailable' | 'core-mismatch' } | { errorCode: 'missing-hc' | 'spawn-error'; hcPid: null }))
  | { kind: 'no-terminal-after-hc-exit'; operationId: string; coreIdBefore: string; hcExitedAt: number;
      first: { coreId: string; issuedAt: number; terminal: 'absent' }; second: { coreId: string; issuedAt: number; terminal: 'absent' }; confirmationBoundMs: number }
  | { kind: 'terminal-exited-without-adoption'; operationId: string; coreId: string; terminalId: string; terminalExited: true; lockNeverAdopted: true };
export interface LaunchEvidence {
  receipt: 'absent' | 'started' | 'finished' | 'unknown'; terminal: 'absent' | 'present' | 'unknown'; proof?: LaunchNoStartProof;
}
function provedNoStart(value: LaunchEvidence, operationId: string, coreId: string): boolean {
  const proof = value.proof;
  if (!proof || proof.operationId !== operationId) return false;
  if (proof.kind === 'prelaunch-error') {
    const safeError = proof.errorCode === 'core-unavailable' || proof.errorCode === 'core-mismatch' ||
      (proof.errorCode === 'missing-hc' || proof.errorCode === 'spawn-error') && proof.hcPid === null;
    return proof.beforeLaunch === true && safeError && (proof as { details?: unknown }).details === undefined &&
      value.receipt !== 'started' && value.receipt !== 'finished' && value.terminal !== 'present';
  }
  if (proof.kind === 'terminal-exited-without-adoption') {
    return proof.coreId === coreId && typeof proof.terminalId === 'string' && proof.terminalId.length > 0 &&
      proof.terminalId.length <= 256 && !/[\x00-\x1f\x7f/]/.test(proof.terminalId) &&
      proof.terminalExited === true && proof.lockNeverAdopted === true;
  }
  if (proof.kind === 'no-terminal-after-hc-exit') {
    const { first, second, hcExitedAt, confirmationBoundMs } = proof;
    return value.terminal === 'absent' && proof.coreIdBefore === coreId && !!first && !!second &&
      first.coreId === coreId && second.coreId === coreId && first.terminal === 'absent' && second.terminal === 'absent' &&
      Number.isFinite(hcExitedAt) && Number.isFinite(first.issuedAt) && Number.isFinite(second.issuedAt) &&
      Number.isFinite(confirmationBoundMs) && confirmationBoundMs > 0 && first.issuedAt > hcExitedAt &&
      second.issuedAt - first.issuedAt >= confirmationBoundMs;
  }
  return false;
}
const ACTIVE_EXACT = Symbol.for('spider.herdr.exact-launch.active');
const launchRuntime = globalThis as typeof globalThis & { [ACTIVE_EXACT]?: Set<string> };
const activeExact = launchRuntime[ACTIVE_EXACT] ??= new Set<string>();
export interface ExactSessionLaunchPorts extends SessionLaunchPorts {
  bootId(): Promise<string>; limits(): Promise<{ soft: number; hard: number }>; shell: string;
  machineId: string; core: { session: string; socket: string; coreId: string };
  /** Reconcile the same operation against its receipt, labelled terminal and authoritative proof. */
  reconcileLaunch(operationId: string, options: { signal: AbortSignal }): Promise<LaunchEvidence>;
  sessionBytes?: number; launchMs?: number; reconcileMs?: number; now?(): number; wait?(ms: number): Promise<void>;
}

async function launchEvidence(ports: ExactSessionLaunchPorts, operationId: string): Promise<LaunchEvidence> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>(resolveTimeout => { timer = setTimeout(() => { abort.abort(); resolveTimeout(null); }, ports.reconcileMs ?? 60_000); });
    const value = await Promise.race([Promise.resolve().then(() => ports.reconcileLaunch(operationId, { signal: abort.signal })), timeout]);
    if (value && ['absent', 'started', 'finished', 'unknown'].includes(value.receipt) && ['absent', 'present', 'unknown'].includes(value.terminal)) return value;
  } catch { /* An unavailable observation cannot authorize a retry. */ }
  finally { if (timer) clearTimeout(timer); }
  return { receipt: 'unknown', terminal: 'unknown' };
}

async function verifyExactFile(request: ExactSessionLaunchRequest, maximum: number): Promise<{ file: string; device: number; inode: number }> {
  const file = resolve(request.file);
  let handle;
  try {
    if (await canonicalSessionFile(file) !== file) throw new Error('Session path is not canonical');
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    const privateFile = (info: typeof before) => process.platform === 'win32' || (info.mode & 0o777) === 0o600 && info.uid === process.getuid?.();
    if (!before.isFile() || !privateFile(before) || before.size <= 0 || before.size > maximum) throw new Error('Invalid session file');
    const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let position = 0, last = -1, headerBytes = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk); position += bytesRead; last = chunk[chunk.length - 1];
      if (position > maximum) throw new Error('Session exceeds its size limit');
      if (!headerBytes.includes(10) && headerBytes.length < 64 * 1024) {
        headerBytes = Buffer.concat([headerBytes, chunk.subarray(0, 64 * 1024 - headerBytes.length)]);
      }
    }
    const after = await handle.stat(), path = await lstat(file);
    if (!path.isFile() || path.isSymbolicLink() || !privateFile(path) || !privateFile(after) || before.dev !== path.dev || before.ino !== path.ino ||
        before.size !== position || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        last !== 10 || digest.digest('hex') !== request.sha256) throw new Error('Session changed');
    const newline = headerBytes.indexOf(10);
    if (newline < 0) throw new Error('Missing header');
    const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes.subarray(0, newline))) as
      { type?: unknown; version?: unknown; id?: unknown; cwd?: unknown };
    if (header.type !== 'session' || ![1, 2, 3].includes(Number(header.version ?? 1)) || header.id !== request.sessionId || header.cwd !== request.cwd) throw new Error('Invalid header');
    return { file, device: before.dev, inode: before.ino };
  } catch {
    throw new HerdrError('session-file-invalid', 'Exact session file is missing, changed, or invalid');
  } finally { await handle?.close(); }
}

export async function launchExactSession(request: ExactSessionLaunchRequest, ports: ExactSessionLaunchPorts): Promise<SessionLaunchResult> {
  const globalRoot = ports.env.SPIDER_GLOBAL_ROOT, agentDirectory = ports.env.PI_CODING_AGENT_DIR;
  const launchMs = ports.launchMs ?? 60_000, reconcileMs = ports.reconcileMs ?? 60_000, sessionBytes = ports.sessionBytes ?? 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(launchMs) || launchMs <= 0 || !Number.isSafeInteger(reconcileMs) || reconcileMs <= 0) throw new HerdrError('launch-deadline-invalid', 'Exact session deadlines must be positive milliseconds');
  if (!Number.isSafeInteger(sessionBytes) || sessionBytes <= 0) throw new HerdrError('launch-environment-invalid', 'Exact session byte limit is invalid');
  const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
  if (!text(request.sessionId) || !isAbsolute(request.file) || !isAbsolute(request.cwd) || !isAbsolute(request.pi) ||
      !/^[a-f0-9]{64}$/.test(request.sha256) || !Number.isSafeInteger(request.epoch) || request.epoch < 1 ||
      !(request.moveId === null || text(request.moveId)) || !isAbsolute(ports.shell) || !globalRoot || !isAbsolute(globalRoot) ||
      !agentDirectory || !isAbsolute(agentDirectory) || !text(ports.machineId) || !text(ports.core.session) || !text(ports.core.coreId) || !isAbsolute(ports.core.socket)) {
    throw new HerdrError('launch-environment-invalid', 'Exact session launch arguments are invalid');
  }
  const root = resolve(globalRoot, 'herdr'), sessionId = request.sessionId as SessionId;
  if (ports.leases.root !== root || ports.processInventory.leases.root !== root) {
    throw new HerdrError('launch-environment-invalid', 'Exact session leases must use the destination ownership root');
  }
  const key = `${root}\0${request.sessionId}`;
  if (activeExact.has(key)) throw new HerdrError('session-id-owner', 'An exact session launch is already in progress');
  activeExact.add(key);
  try {
    const file = resolve(request.file), previous = await inspectIdLock(root, request.sessionId);
    let recoverPending: string | undefined;
    if (previous?.pendingOperationId) {
      const evidence = await launchEvidence(ports, previous.pendingOperationId);
      if (!provedNoStart(evidence, previous.pendingOperationId, ports.core.coreId) ||
          evidence.proof?.kind !== 'prelaunch-error' && previous.pendingCoreId !== ports.core.coreId || !previous.pendingFile ||
          await canonicalSessionFile(previous.pendingFile) !== previous.pendingFile) throw new HerdrError('launch-pending', 'Exact session launch needs reconciliation');
      recoverPending = previous.pendingOperationId;
    }
    let boot = '';
    try { const observed = await ports.bootId(); if (typeof observed === 'string') boot = observed.trim(); } catch { /* An unknown boot identity cannot fence a launch. */ }
    if (!boot) throw new HerdrError('process-identity-unavailable', 'Cannot verify the local boot identity');
    const id = await claimIdLock(root, request.sessionId, ports.processIdentity, ports.processInventory.probe,
      { bootId: async () => boot, exclusive: true, ...(recoverPending ? { recoverPending } : {}) });
    let lease: Awaited<ReturnType<SessionLeases['claim']>> | undefined, operationId: string | undefined, handoffFile: string | undefined, starting = false;
    let ownPending = Boolean(previous?.pendingOperationId && previous.bootId === boot && previous.identity.pid === ports.processIdentity.pid && previous.identity.startIdentity === ports.processIdentity.startIdentity);
    try {
      if (previous?.pendingOperationId && previous.pendingFile) {
        const oldLease = await ports.leases.get(previous.pendingFile);
        if (oldLease && (oldLease.pid !== previous.identity.pid || oldLease.startIdentity !== previous.identity.startIdentity || oldLease.bootId !== previous.bootId)) {
          throw new HerdrError('launch-pending', 'The previous file lease needs reconciliation');
        }
        if (ownPending) {
          if (!await id.clearHandoff(previous.pendingOperationId)) throw new HerdrError('launch-pending', 'Exact session launch needs reconciliation');
          ownPending = false;
        }
        await removeLaunchHandoff(root, previous.pendingOperationId);
        if (oldLease) await ports.leases.release(previous.pendingFile, oldLease.token, { mode: 'cutover' });
      }
      const verified = await verifyExactFile(request, sessionBytes);
      lease = await ports.leases.claim(file, ports.processIdentity, ports.processInventory, { mode: 'cutover', bootId: boot });
      let limits: Awaited<ReturnType<ExactSessionLaunchPorts['limits']>>;
      try { limits = await ports.limits(); } catch { throw new HerdrError('launch-limits-unavailable', 'Cannot verify the local file limits'); }
      operationId = randomUUID();
      const handoff = await id.prepareHandoff(operationId, file, ports.core.coreId);
      handoffFile = await writeLaunchHandoff(root, { version: 1, operationId, sessionId: request.sessionId,
        sessionFile: file, nonce: handoff.nonce, leaseToken: lease.token });
      const argv = exactLaunchArgv(ports.shell, request.pi, file, limits, { globalRoot, agentDirectory, handoffFile });
      const environment = launchEnvironment({ agentDirectory, extensionArguments: [] });
      const env = safeLaunchEnvironment(ports.env);
      for (const key of Object.keys(env)) if (key.startsWith('HC_')) delete env[key];
      Object.assign(env, { HC_SESSION: ports.core.session, HC_SOCKET: ports.core.socket, PI_CODING_AGENT_DIR: agentDirectory });
      const terminal: ExactTerminalLaunch = { background: true, noNotify: true, outliveParent: true, parent: null,
        labels: { [HERDR_LABELS.kind]: 'session', [HERDR_LABELS.session]: request.sessionId, [HERDR_LABELS.machine]: ports.machineId,
          'spider.roam.epoch': String(request.epoch), 'spider.roam.move': request.moveId ?? '', 'spider.roam.operation': operationId } };
      const rechecked = await verifyExactFile(request, sessionBytes);
      if (rechecked.device !== verified.device || rechecked.inode !== verified.inode) {
        throw new HerdrError('session-file-invalid', 'Exact session file was replaced before launch');
      }
      starting = true;
      void Promise.resolve().then(() => ports.spawnPi({ sessionFile: file, sessionId, cwd: request.cwd, environment, argv, env, terminal }))
        .catch(() => { /* Reconciliation distinguishes a proved pre-launch error from a lost reply. */ });
      const now = ports.now ?? Date.now, wait = ports.wait ?? (ms => delay(ms));
      const deadline = now() + launchMs;
      const adopted = async (): Promise<SessionLaunchResult | null> => {
        const owner = await inspectIdLock(root, request.sessionId);
        if (!owner || owner.operationId !== operationId || owner.pendingOperationId !== null || owner.bootId !== boot ||
            owner.identity.pid === ports.processIdentity.pid && owner.identity.startIdentity === ports.processIdentity.startIdentity) return null;
        const current = await ports.leases.get(file);
        if (!current || current.pid !== owner.identity.pid || current.startIdentity !== owner.identity.startIdentity) return null;
        try { await lstat(launchHandoffPath(root, operationId)); return null; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        let live: Awaited<ReturnType<ProcessInventoryPorts['probe']>>;
        try { live = await ports.processInventory.probe(owner.identity.pid); } catch { return null; }
        if (live.kind !== 'live' || live.startIdentity !== owner.identity.startIdentity) return null;
        return { ...owner.identity, sessionFile: file, sessionId, cwd: request.cwd, token: current.token, operationId };
      };
      for (;;) {
        const result = await adopted();
        if (result) return result;
        if (now() >= deadline) break;
        await wait(Math.min(25, Math.max(1, deadline - now())));
      }
      const evidence = await launchEvidence(ports, operationId);
      const result = await adopted();
      if (result) return result;
      if (provedNoStart(evidence, operationId, ports.core.coreId) && await id.cancelHandoff(operationId)) {
        try { await removeLaunchHandoff(root, operationId); }
        finally { await ports.leases.release(file, lease.token, { mode: 'cutover' }); }
        throw new HerdrError('launch-not-started', 'Exact session did not acquire ownership');
      }
      throw new HerdrError('launch-pending', 'Exact session launch needs reconciliation');
    } catch (error) {
      if (!starting && !ownPending) {
        if (!operationId || !await id.cancelHandoff(operationId)) await id.release();
        try { if (handoffFile && operationId) await removeLaunchHandoff(root, operationId); }
        finally { if (lease) await ports.leases.release(file, lease.token, { mode: 'cutover' }); }
      }
      throw error;
    }
  } finally { activeExact.delete(key); }
}
