import type { ProcessIdentity, ProcessProbe, ProcessInventoryPorts } from "@spider/herdr/sessions/lease";
import { canonicalSessionFile } from "@spider/herdr/sessions/registry";
import { claimIdLock, type IdLockHandle } from "@spider/herdr/sessions/id-lock";
import { readLaunchHandoff, removeLaunchHandoff } from "@spider/herdr/sessions/launch-handoff";
import { HerdrError } from "@spider/herdr/client/parse";
import type { SessionId } from "@spider/herdr/contracts";
import { processStartTime } from "../../../subagents/src/process-identity";
import { createProcessInventory } from "./process-inventory";
export interface ParticipantLockOptions {
  identity?: ProcessIdentity;
  probe?: (pid: number) => Promise<ProcessProbe>;
  bootId?: () => Promise<string>;
  env?: Readonly<NodeJS.ProcessEnv>;
}

function processIdentity(options: ParticipantLockOptions): ProcessIdentity {
  return options.identity ?? { pid: process.pid, startIdentity: processStartTime(process.pid) ?? '' };
}

/** The interactive process owns its session ID without a transcript or roaming config. */
export async function lockParticipantId(root: string, sessionId: string, options: ParticipantLockOptions = {}): Promise<IdLockHandle> {
  const probe = options.probe ?? createProcessInventory(root).probe;
  return claimIdLock(root, sessionId, processIdentity(options), probe, { bootId: options.bootId });
}

/** Hold the file lease and, unless the caller already owns it, the session ID lock. */
export async function lockParticipant(root: string, sessionId: string, file: string, options: ParticipantLockOptions = {}, pinnedId?: IdLockHandle): Promise<() => Promise<void>> {
  const inventory = createProcessInventory(root);
  const identity = processIdentity(options);
  const probe = options.probe ?? inventory.probe;
  const env = options.env ?? process.env;
  const canonical = await canonicalSessionFile(file), handoffPath = env.SPIDER_HERDR_HANDOFF_FILE;
  if (handoffPath === undefined && (env.SPIDER_HERDR_HANDOFF_OPERATION_ID !== undefined || env.SPIDER_HERDR_HANDOFF_NONCE !== undefined)) {
    throw new HerdrError('invalid-launch-handoff', 'Participant handoff requires a private file');
  }
  const fromFile = handoffPath === undefined ? undefined : await readLaunchHandoff(root, handoffPath, sessionId, canonical);
  const handoff = fromFile && { operationId: fromFile.operationId, nonce: fromFile.nonce, file: canonical };
  const leaseToken = fromFile?.leaseToken;
  if (handoff && (!leaseToken || (await inventory.leases.get(canonical))?.token !== leaseToken)) {
    throw new HerdrError('lease-token-invalid', 'Participant handoff requires its exact file lease');
  }
  if (pinnedId && (handoff || !await pinnedId.isHeldByClaim?.())) {
    throw new HerdrError('session-id-owner', 'Cannot verify the interactive session ID lock');
  }
  const id = pinnedId ?? await claimIdLock(root, sessionId, identity, probe, { bootId: options.bootId, handoff });
  const isSelf = (value: { pid: number; startIdentity: string | null }) => value.pid === identity.pid && value.startIdentity === identity.startIdentity;
  const others: ProcessInventoryPorts = {
    ...inventory, probe,
    processes: async () => (await inventory.processes()).filter(value => !isSelf(value)),
    presence: { ...inventory.presence, list: async () => (await inventory.presence.list()).filter(value => !isSelf(value)) },
    leases: { ...inventory.leases, get: async path => { const lease = await inventory.leases.get(path); return lease && isSelf(lease) ? null : lease; } },
  };
  try {
    const existing = await inventory.leases.get(canonical);
    const lease = handoff ? await inventory.leases.adopt(canonical, leaseToken!, identity) :
      existing && isSelf(existing) ? existing : await inventory.leases.claim(canonical, identity, others, { mode: 'switch', sessionId: sessionId as SessionId });
    if (handoff) {
      await removeLaunchHandoff(root, handoff.operationId);
      if (env === process.env) {
        delete process.env.SPIDER_HERDR_HANDOFF_FILE;
        delete process.env.SPIDER_HERDR_HANDOFF_OPERATION_ID;
        delete process.env.SPIDER_HERDR_HANDOFF_NONCE;
        process.env.SPIDER_HERDR_LEASE_FILE = canonical;
        process.env.SPIDER_HERDR_LEASE_TOKEN = lease.token;
      }
    }
    return async () => {
      try { await inventory.leases.release(file, lease.token, { mode: 'switch' }); }
      finally { if (!pinnedId) await id.release(); }
    };
  } catch (error) {
    // An adopted ID stays fenced while its process is alive, even if file adoption fails.
    if (!handoff && !pinnedId) await id.release();
    throw error;
  }
}
