import { lstatSync } from "node:fs";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { claimIdLock, inspectIdLock } from "@spider/herdr/sessions/id-lock";
import { launchHandoffPath, readLaunchHandoff, removeLaunchHandoff } from "@spider/herdr/sessions/launch-handoff";
import { provedNoStart, type LaunchEvidence } from "@spider/herdr/sessions/launcher";
import type { ProcessIdentity, ProcessInventoryPorts } from "@spider/herdr/sessions/lease";
import type { Journal, IntercomLifecycle } from "./contracts";
import type { RunningIntentAuthority } from "./session-control";
import { startPrivateControl, requestPrivateControl } from "./control-socket";
export interface MoveNoStartReceipt { moveId: string; launchId: string; sessionId: string; epoch: number; coreId: string; bootId: string; launchDigest: string; evidence: LaunchEvidence }
export interface CancelPendingHandoff { sessionId: string; moveId: string; launchId: string; noStartReceipt: MoveNoStartReceipt }
export interface PendingHandoffControl { cancelPendingHandoff(input: CancelPendingHandoff): Promise<"released" | "already-released" | "refused"> }
export function launchJournalDigest(journal: Journal, launchId: string): string { return createHash("sha256").update(JSON.stringify(journal.read(launchId))).digest("hex"); }
interface CancelContext { file: string; leaseToken: string; owner: ProcessIdentity; bootId: string }
function handoffExists(root: string, launchId: string): boolean {
  try { lstatSync(launchHandoffPath(root, launchId)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export function createPendingHandoffControl(input: { root: string; journal: Journal; authority: RunningIntentAuthority; inventory: Pick<ProcessInventoryPorts, "leases" | "probe">; identity: ProcessIdentity; bootId(): Promise<string>; launchDigest?(launchId: string): string }): PendingHandoffControl {
  const { root, journal, authority, inventory, identity } = input;
  const sameIdentity = (a: ProcessIdentity, b: ProcessIdentity) => a.pid === b.pid && a.startIdentity === b.startIdentity;
  return { async cancelPendingHandoff(request) {
    try { return await withProcessLock(root, `cancel-handoff:${request.sessionId}`, async () => {
      const receipt = request?.noStartReceipt;
      if (!receipt || receipt.sessionId !== request.sessionId || receipt.moveId !== request.moveId || receipt.launchId !== request.launchId ||
          !Number.isSafeInteger(receipt.epoch) || receipt.epoch < 1 || !provedNoStart(receipt.evidence, request.launchId, receipt.coreId, receipt.bootId)) return "refused";
      const durable = journal.read(request.moveId).find(row => row.action === "move-no-start");
      if (!durable || !isDeepStrictEqual(durable.result, receipt)) return "refused";
      const operationId = `cancel-handoff-${createHash("sha256").update(JSON.stringify([request.sessionId, request.moveId, request.launchId])).digest("hex").slice(0, 40)}`;
      const rows = journal.read(operationId);
      if (rows.some(row => row.action === "done")) return "already-released";
      const unchanged = () => (input.launchDigest?.(request.launchId) ?? launchJournalDigest(journal, request.launchId)) === receipt.launchDigest &&
        !journal.read(request.launchId).some(row => row.action === "ready-durable") &&
        !(authority.operationId(request.sessionId) && journal.read(authority.operationId(request.sessionId)!).some(row => row.action === "ready-durable"));
      if (!unchanged() || await input.bootId() !== receipt.bootId) return "refused";
      const intent = await authority.get(request.sessionId), owner = await inspectIdLock(root, request.sessionId);
      if (!intent || intent.sessionId !== request.sessionId || intent.epoch !== receipt.epoch || intent.moveId !== request.moveId || intent.suspended) return "refused";
      const self = await inventory.probe(identity.pid);
      if (self.kind !== "live" || self.startIdentity !== identity.startIdentity) return "refused";
      let context = rows.find(row => row.action === "cancel-context")?.result as unknown as CancelContext | undefined;
      const present = handoffExists(root, request.launchId), pending = present ? await readLaunchHandoff(root, launchHandoffPath(root, request.launchId), request.sessionId, intent.file) : null;
      const lease = await inventory.leases.get(intent.file);
      if (!context) {
        if (!owner || owner.pendingOperationId !== request.launchId || owner.pendingCoreId !== receipt.coreId || owner.bootId !== receipt.bootId ||
            !sameIdentity(owner.identity, identity) || owner.pendingFile !== intent.file || !pending || !lease || lease.token !== pending.leaseToken ||
            lease.pid !== identity.pid || lease.startIdentity !== identity.startIdentity || lease.bootId !== receipt.bootId) return "refused";
        context = { file: intent.file, leaseToken: pending.leaseToken, owner: { ...owner.identity }, bootId: receipt.bootId };
      } else {
        if (context.file !== intent.file || context.bootId !== receipt.bootId || pending && pending.leaseToken !== context.leaseToken ||
            lease && (lease.token !== context.leaseToken || lease.pid !== context.owner.pid || lease.startIdentity !== context.owner.startIdentity || lease.bootId !== context.bootId)) return "refused";
        if (owner) {
          const original = owner.pendingOperationId === request.launchId && owner.pendingCoreId === receipt.coreId && owner.pendingFile === intent.file && owner.bootId === receipt.bootId && sameIdentity(owner.identity, context.owner);
          const reclaimed = rows.some(row => row.action === "lock-reclaim-start") && owner.pendingOperationId === null && owner.operationId === null && owner.bootId === receipt.bootId && sameIdentity(owner.identity, identity);
          if (!original && !reclaimed) return "refused";
          if (original && !sameIdentity(owner.identity, identity) && (await inventory.probe(owner.identity.pid)).kind !== "absent") return "refused";
        } else if (lease || pending) return "refused";
      }
      const machineId = journal.lookupOperation?.(request.moveId)?.machineId;
      if (!machineId || !unchanged()) return "refused";
      journal.begin({ id: operationId, machineId, expectedEpoch: receipt.epoch, kind: "cancel-pending-handoff", args: { sessionId: request.sessionId, moveId: request.moveId, launchId: request.launchId, launchDigest: receipt.launchDigest } });
      if (!rows.some(row => row.action === "cancel-context")) journal.record(operationId, "cancel-context", context as unknown as import("@spider/db-core/roam/types").JsonObject);
      // All refusal checks precede the first mutation. Missing completed resources are resumable only with this durable context.
      await authority.stop(request.sessionId);
      if (lease) await inventory.leases.release(intent.file, context.leaseToken, { mode: "cutover" });
      journal.record(operationId, "lease-released", {});
      if (pending) await removeLaunchHandoff(root, request.launchId);
      journal.record(operationId, "handoff-removed", {});
      if (owner) {
        journal.record(operationId, "lock-reclaim-start", {});
        const wasPending = owner.pendingOperationId !== null;
        const id = await claimIdLock(root, request.sessionId, identity, inventory.probe, { exclusive: wasPending, recoverPending: request.launchId, bootId: input.bootId });
        if (wasPending && sameIdentity(owner.identity, identity) && !await id.cancelHandoff(request.launchId)) throw new Error("handoff-cancellation-pending");
        await id.release();
      }
      journal.record(operationId, "lock-cancelled", {});
      journal.record(operationId, "done", { sessionId: request.sessionId, moveId: request.moveId, launchId: request.launchId });
      return "released";
    }); } catch { return "refused"; }
  } };
}

function parse(bytes: Buffer): CancelPendingHandoff | null {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const token = (x: unknown) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(x);
    if (!value || Object.keys(value).sort().join() !== "launchId,moveId,noStartReceipt,sessionId" || !token(value.sessionId) || !token(value.moveId) || !token(value.launchId) || !value.noStartReceipt || typeof value.noStartReceipt !== "object") return null;
    return value;
  } catch { return null; }
}
export function pendingHandoffLifecycle(root: string, control: PendingHandoffControl, previous?: IntercomLifecycle): IntercomLifecycle {
  let server: Awaited<ReturnType<typeof startPrivateControl>> | undefined;
  return { ...previous, diagnostics: () => previous?.diagnostics() ?? [], async start() { await previous?.start(); server = await startPrivateControl(join(root, "roam", "pending.sock"), parse, async request => {
    const state = await control.cancelPendingHandoff(request);
    return { code: state === "refused" ? 3 : 0, reason: state, value: null };
  }); }, async stop() { try { await server?.close(); } finally { await previous?.stop(); } } };
}
export async function cancelPendingHandoff(root: string, request: CancelPendingHandoff): ReturnType<PendingHandoffControl["cancelPendingHandoff"]> {
  try { const reply = await requestPrivateControl(join(root, "roam", "pending.sock"), request, parse); return reply.code === 0 && (reply.reason === "released" || reply.reason === "already-released") ? reply.reason : "refused"; }
  catch { return "refused"; }
}
