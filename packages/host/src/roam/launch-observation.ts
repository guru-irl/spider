import { launchJournalDigest } from "@spider/roam/pending-handoff";
import { provedNoStart, type LaunchEvidence } from "@spider/herdr/sessions/launcher";
import type { HostIntent, Journal } from "@spider/roam/contracts";
import type { JsonObject } from "@spider/db-core/roam/types";
export async function recordMoveNoStart(input: {
  journal: Journal; operationId: string; launchId: string; sessionId: string; epoch: number; coreId: string; bootId: string; intent: HostIntent | null;
  readiness(): Promise<unknown>; evidence(): Promise<LaunchEvidence>;
}): Promise<string | null> {
  try {
    const intent = input.intent;
    if (!intent || intent.sessionId !== input.sessionId || intent.epoch !== input.epoch || intent.desired !== "running" || intent.suspended || await input.readiness()) return null;
    const evidence = await input.evidence();
    if (evidence.receipt === "started" || evidence.receipt === "finished" || evidence.terminal === "present" || !provedNoStart(evidence, input.launchId, input.coreId, input.bootId) || await input.readiness()) return null;
    const value = { moveId: input.operationId, launchDigest: launchJournalDigest(input.journal, input.launchId), launchId: input.launchId, sessionId: input.sessionId, epoch: input.epoch, coreId: input.coreId, bootId: input.bootId, evidence };
    const prior = input.journal.read(input.operationId).find(row => row.action === "move-no-start");
    if (prior && ["moveId", "launchDigest", "launchId", "sessionId", "epoch", "coreId", "bootId"].some(key => prior.result[key] !== value[key as keyof typeof value])) return null;
    if (!prior) input.journal.record(input.operationId, "move-no-start", value as unknown as JsonObject);
    return input.launchId;
  } catch { return null; }
}
