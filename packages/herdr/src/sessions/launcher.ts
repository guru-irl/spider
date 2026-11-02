// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { open, constants } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { SessionId } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { canonicalSessionFile, launchEnvironment, refuseExplicitExtensions, type LaunchEnvironment } from './registry.js';
import { assessSessionLiveness, recordedSessionLiveness, type SessionLeasePolicy, type ProcessIdentity, type ProcessInventoryPorts, type SessionLeases } from './lease.js';
export interface SessionLaunchRequest { sessionFile: string; sessionId: SessionId; cwd: string; environment: LaunchEnvironment }
export interface PiSpawnRequest extends SessionLaunchRequest { argv: readonly string[]; env: Readonly<NodeJS.ProcessEnv> }
export interface SessionLaunchResult extends ProcessIdentity { sessionFile: string; sessionId: SessionId; cwd: string; token: string }
export interface SessionLaunchPorts {
  leases: SessionLeases; processInventory: ProcessInventoryPorts; processIdentity: ProcessIdentity;
  leasePolicy?: SessionLeasePolicy;
  env: Readonly<NodeJS.ProcessEnv>; spawnPi(request: PiSpawnRequest): Promise<ProcessIdentity>;
  publishMapping?(result: SessionLaunchResult, request: SessionLaunchRequest): Promise<void>;
}
export function safeLaunchEnvironment(env: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const safe = { ...env }; for (const key of Object.keys(safe)) if (key.startsWith('SPIDER_HERDR_LEASE_') || key === 'SPIDER_HERDR_SSH_BYPASS') delete safe[key]; return safe;
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
    await ports.leases.transfer(file, lease.token, process);
    const result = { ...process, token: lease.token, sessionFile: file, sessionId: header.id, cwd: request.cwd };
    await ports.publishMapping?.(result, { ...request, sessionFile: file, environment }); return result;
  } catch (error) {
    // A lost spawn/publication reply must not authorize a second writer. Inventory can reclaim after proved exit.
    if (!starting) await ports.leases.release(file, lease.token); throw error;
  }
}
