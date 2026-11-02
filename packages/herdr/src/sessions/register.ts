// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Disposable, Owner, ProcessPresence, SessionId, TerminalIdentity } from '../contracts.js';
import { processContainsCaller } from '../client/hc.js';
import type { ProcessPresenceStore } from './presence.js';
import { canonicalSessionFile, type LaunchEnvironment, type TerminalRegistry } from './registry.js';
import type { ProcessIdentity, ProcessInventoryPorts, SessionLease, SessionLeases } from './lease.js';
export interface SessionRegistrationPorts extends ProcessInventoryPorts {
  currentSession(ctx: ExtensionContext): ProcessPresence; owner(): Owner | null;
  registry: TerminalRegistry; presence: ProcessPresenceStore; leases: SessionLeases;
  processIdentity: ProcessIdentity; launchEnvironment: LaunchEnvironment;
  active?(): boolean; warn?(message: string): void;
  coreStartedAt(): number; env?: Readonly<NodeJS.ProcessEnv>;
}
export async function hasLiveMappedAncestor(terminal: TerminalIdentity, ports: Pick<SessionRegistrationPorts, 'registry' | 'presence' | 'probe' | 'processIdentity' | 'env'>): Promise<boolean> {
  const mapping = await ports.registry.get(terminal);
  if (!mapping) return false;
  for (const record of await ports.presence.list()) {
    if (record.pid === ports.processIdentity.pid || record.kind !== 'top-level' || record.sessionId !== mapping.owner.sessionId || record.hcAddress !== terminal.address) continue;
    const current = await ports.probe(record.pid);
    if (current.kind === 'live' && current.startIdentity === record.startIdentity && await processContainsCaller(record.pid, ports.env ?? process.env, ports.processIdentity.pid)) return true;
  }
  return false;
}
export function registerHerdrSessions(pi: ExtensionAPI, ports: SessionRegistrationPorts): Disposable {
  const held = new Map<string, SessionLease>(); let disposed = false;
  const isSelf = (p: { pid: number; startIdentity: string | null }) => p.pid === ports.processIdentity.pid && p.startIdentity === ports.processIdentity.startIdentity;
  const ownInventory: ProcessInventoryPorts = {
    ...ports,
    processes: async () => (await ports.processes()).filter(p => !isSelf(p)),
    presence: { ...ports.presence, list: async () => (await ports.presence.list()).filter(p => !isSelf(p)) },
    leases: { ...ports.leases, get: async file => { const lease = await ports.leases.get(file); return lease && isSelf(lease) ? null : lease; } },
  };
  const active = () => ports.active?.() ?? ports.owner() !== null;
  const warn = (message: string) => ports.warn ? ports.warn(message) : process.stderr.write(message + '\n');
  async function reserve(file: string, sessionId?: SessionId): Promise<SessionLease | undefined> {
    const canonical = await canonicalSessionFile(file); const existing = held.get(canonical); if (existing) return existing;
    const token = ports.env?.SPIDER_HERDR_LEASE_TOKEN;
    try {
      const lease = token && ports.env?.SPIDER_HERDR_LEASE_FILE === canonical ? await ports.leases.adopt(canonical, token, ports.processIdentity) : await ports.leases.claim(canonical, ports.processIdentity, ownInventory, active() ? { mode: 'switch', sessionId } : { mode: 'bookkeeping' });
      held.set(canonical, lease); return lease;
    } catch (error) { if (active()) throw error; return undefined; }
  }

  async function activation(ctx: ExtensionContext): Promise<void> {
    if (disposed) return;
    const current = ports.currentSession(ctx);
    await ports.presence.record({ ...current, sessionId: ctx.sessionManager.getSessionId() as SessionId, mode: ctx.mode, extensionArguments: ports.launchEnvironment.extensionArguments }); // Unconditional: HC, enablement, and child status do not participate.
    if (current.sessionFile !== null && current.kind === 'top-level') await reserve(current.sessionFile, ctx.sessionManager.getSessionId() as SessionId);
    const owner = ports.owner(); if (!owner || ctx.mode !== 'tui' && ctx.mode !== 'rpc' || current.kind !== 'top-level') return;
    if (await hasLiveMappedAncestor(owner.terminal, ports)) return;
    await ports.registry.record({ owner: { ...owner, sessionFile: current.sessionFile, name: current.sessionName }, recordedAt: Date.now(), coreStartedAt: ports.coreStartedAt(), environment: ports.launchEnvironment });
  }
  async function cleanup(targetSessionFile?: string): Promise<void> {
    const handoff = targetSessionFile ? await canonicalSessionFile(targetSessionFile) : null;
    for (const [file, lease] of held) if (file !== handoff) { try { await ports.leases.release(file, lease.token, active() ? { mode: 'switch' } : { mode: 'bookkeeping' }); } catch (error) { if (active()) throw error; } }
    // The disk lease survives teardown; the same process claims it in the destination runtime.
    held.clear(); await ports.presence.remove(ports.processIdentity);
  }
  const unsubscribe = [
    pi.on('session_start', async (_event, ctx) => activation(ctx)),
    pi.on('session_info_changed', async (_event, ctx) => activation(ctx)),
    pi.on('session_before_switch', async event => { if (!event.targetSessionFile) return; try { await reserve(event.targetSessionFile); } catch (error) { if (!active()) return; warn(error instanceof Error ? error.message : 'Target session is held by another recorded process'); return { cancel: true }; } }),
    pi.on('session_shutdown', async event => cleanup(event.reason === 'resume' || event.reason === 'new' ? event.targetSessionFile : undefined)),
  ];
  return { async dispose() { if (disposed) return; disposed = true; for (const off of unsubscribe) off(); await cleanup(); } };
}
