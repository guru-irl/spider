import { launchJournalDigest, moveLaunchAbsenceAction, readMoveLaunchAbsenceReceipt, type MoveLaunchAbsenceReceipt } from "@spider/roam/pending-handoff";
import { provedNoStart, type LaunchEvidence } from "@spider/herdr/sessions/launcher";
import type { HostIntent, Journal } from "@spider/roam/contracts";
import type { JsonObject } from "@spider/db-core/roam/types";
export async function recordMoveLaunchAbsence(input: {
  journal: Journal; operationId: string; launchId: string; sessionId: string; epoch: number; coreId: string; bootId: string; intent: HostIntent | null;
  readiness(): Promise<unknown>; ownership(): Promise<unknown>; evidence(): Promise<LaunchEvidence>;
}): Promise<MoveLaunchAbsenceReceipt | null> {
  try {
    const adopted = async () => !!(await input.readiness() || await input.ownership() || input.journal.read(input.launchId).some(row => row.action === "ready-durable"));
    const intent = input.intent;
    if (!intent || intent.sessionId !== input.sessionId || intent.epoch !== input.epoch || intent.moveId !== input.operationId || intent.desired !== "running" || intent.suspended || await adopted()) return null;
    const evidence = await input.evidence();
    if (!provedNoStart(evidence, input.launchId, input.coreId, input.bootId) || await adopted()) return null;
    const tuple = { moveId: input.operationId, launchDigest: launchJournalDigest(input.journal, input.launchId), launchId: input.launchId, sessionId: input.sessionId, epoch: input.epoch, coreId: input.coreId, bootId: input.bootId, evidence };
    let value: MoveLaunchAbsenceReceipt;
    if (evidence.proof?.kind === "terminal-exited-without-adoption") {
      const terminals = input.journal.read(input.launchId).filter(row => row.action === "exact-terminal");
      if (evidence.terminal !== "present" || terminals.length !== 1 || terminals[0].result.terminalId !== evidence.proof.terminalId) return null;
      value = { ...tuple, kind: "exited-without-adoption", terminalId: evidence.proof.terminalId };
    } else {
      if (evidence.receipt === "started" || evidence.receipt === "finished" || evidence.terminal === "present") return null;
      value = { ...tuple, kind: "never-started" };
    }
    const prior = readMoveLaunchAbsenceReceipt(input.journal, input.operationId, input.launchId);
    if (prior) {
      if (["moveId", "launchDigest", "launchId", "sessionId", "epoch", "coreId", "bootId", "kind"].some(key => prior[key as keyof MoveLaunchAbsenceReceipt] !== value[key as keyof MoveLaunchAbsenceReceipt])) return null;
      if (prior.kind === "exited-without-adoption" && (value.kind !== prior.kind || prior.terminalId !== value.terminalId)) return null;
      return prior;
    }
    if (input.journal.read(input.operationId).some(row => (row.action === "move-no-start" || row.action === "move-unadopted-launch-exit") && row.result.launchId === input.launchId)) return null;
    input.journal.record(input.operationId, moveLaunchAbsenceAction(value), value as unknown as JsonObject);
    return value;
  } catch { return null; }
}
