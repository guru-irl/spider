import { expect, it } from "vitest";
import { reconcileOwnIntercom } from "../intercom";
const owner = { address: { sessionId: "own", scopeId: null }, machineId: "machine", homeEpoch: 1, activationEpoch: "old" };
const request = { messageId: "message", owner };
function context(entries: unknown[], complete = true): any {
  return { sessionManager: { getSessionId: () => "own", getSessionFile: () => complete ? "fixture.jsonl" : undefined, getEntries: () => entries,
    getBranch: () => [], getLeafId: () => "compacted" } };
}
it("complete own-session metadata resolves unknown", async () => {
  const entries = [{ type: "custom_message", customType: "intercom_message", id: "physical", parentId: "older-branch", details: { message: { id: "message" }, intercom: { sessionId: "own", activationEpoch: "old" } } }];
  const [proof] = await reconcileOwnIntercom(context(entries), [request]);
  expect(proof.receipt).toMatchObject({ status: "injected", evidence: { kind: "entry", entryId: "physical", activationEpoch: "old" } });
}, 5000);
it("missing or competing generation stays unknown", async () => {
  const entries = [{ role: "custom", customType: "intercom_message", id: "projection", details: { message: { id: "message" }, intercom: { sessionId: "own", activationEpoch: "old" } } }];
  for (const ctx of [context(entries, false), context(entries)]) {
    const [proof] = await reconcileOwnIntercom(ctx, [{ ...request, exclusion: { owner, excludedGeneration: "different", kind: "generation-fenced" } }]);
    expect(proof.receipt.status).toBe("unknown");
  }
  const [foreign] = await reconcileOwnIntercom({ sessionManager: { getSessionId: () => "other", getEntries: () => entries } } as any, [request]);
  expect(foreign.receipt.status).toBe("unknown");
}, 5000);
it("busy steer reload before drain keeps payload for same-id redelivery", async () => {
  const [reload] = await reconcileOwnIntercom(context([]), [request]);
  expect(reload.receipt.status).toBe("unknown");
  const [fenced] = await reconcileOwnIntercom(context([]), [{ ...request, exclusion: { owner, excludedGeneration: "old", kind: "owner-exited" } }]);
  expect(fenced.receipt).toMatchObject({ status: "not_injected", evidence: { kind: "absence", excludedGeneration: "old", complete: true } });
}, 5000);
it("restored waiter receipt retains the original ask id", async () => {
  const [proof] = await reconcileOwnIntercom(context([{ type: "custom", customType: "intercom_waiter_receipt", id: "waiter-entry", data: { messageId: "message", askId: "original-ask", sessionId: "own", activationEpoch: "old" } }]), [request]);
  expect(proof.receipt).toMatchObject({ status: "matched_waiter", evidence: { kind: "waiter", entryId: "waiter-entry", askId: "original-ask" } });
}, 5000);

it("an excluded old owner does not prove absence in a competing generation", async () => {
  const [proof] = await reconcileOwnIntercom(context([{ type: "custom_message", customType: "intercom_message", id: "competing", details: { message: { id: "message" }, intercom: { sessionId: "own", activationEpoch: "new" } } }]), [{ ...request, exclusion: { owner, excludedGeneration: "old", kind: "generation-fenced" } }]);
  expect(proof.receipt.status).toBe("unknown");
}, 5000);

it("an excluded owner still needs a complete current own-session tree", async () => {
  const fenced = { ...request, exclusion: { owner, excludedGeneration: "old", kind: "generation-fenced" as const } };
  const [unavailable] = await reconcileOwnIntercom(context([], false), [fenced]);
  expect(unavailable.receipt.status).toBe("unknown");
  const entries = [{ type: "custom_message", customType: "intercom_message", id: "physical", details: { message: { id: "message" }, intercom: { sessionId: "own", activationEpoch: "old" } } }];
  const foreign = context(entries); foreign.sessionManager.getSessionId = () => "other";
  const [wrongSession] = await reconcileOwnIntercom(foreign, [fenced]); expect(wrongSession.receipt.status).toBe("unknown");
}, 5000);

it("a competing generation waiter receipt cannot become an absence proof", async () => {
  const [proof] = await reconcileOwnIntercom(context([{ type: "custom", customType: "intercom_waiter_receipt", id: "competing-waiter", data: { messageId: "message", askId: "original-ask", sessionId: "own", activationEpoch: "new" } }]), [{ ...request, exclusion: { owner, excludedGeneration: "old", kind: "generation-fenced" } }]);
  expect(proof.receipt.status).toBe("unknown");
}, 5000);
