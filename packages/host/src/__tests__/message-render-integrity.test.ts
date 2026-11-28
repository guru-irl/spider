import { describe, expect, it } from "vitest";
import { renderSpiderResult } from "../render-result";
import { toToolResult } from "../result";

function render(details: unknown, to = "peer"): string {
  const args = { action: "message", to, message: "Please use the corrected brief." };
  return renderSpiderResult(toToolResult({ details }), { expanded: true }, {}, { args }).render(120).join("\n");
}

describe("message delivery rendering", () => {
  it.each([
    { delivery: "delivered", delivered: true, transformed: false, icon: "✓", status: "delivered" },
    { delivery: "delivered", delivered: true, transformed: true, icon: "✓", status: "delivered, transformed" },
    { delivery: "accepted but not confirmed", delivered: false, icon: "▲", status: "accepted but not confirmed" },
    { delivery: "no reply yet, delivery unknown", delivered: false, icon: "▲", status: "no reply yet, delivery unknown" },
    { delivery: "child-accepted", delivered: false, icon: "▲", status: "accepted but not confirmed" },
    { delivery: "refused", delivered: false, icon: "×", status: "refused" },
    { delivery: "broker-accepted", delivered: false, icon: "▲", status: "broker accepted · acknowledgement unconfirmed" },
  ])("renders $delivery (transformed=$transformed) with truthful severity", row => {
    const text = render({ ...row, recipientAcknowledged: false, error: "Delivery diagnostic." });
    expect(text).toContain(row.icon); expect(text).toContain(row.status);
    expect(text).toContain("Delivery diagnostic.");
    if (row.icon !== "×") expect(text).not.toContain("×");
  });
  it("shows the resolved run name in both the status and refusal", () => {
    const runId = "5f3b8190-92e9-4ad5-8a01-d823e4bf0e09";
    const text = render({ runId, runName: "tia-3", delivery: "refused", error: `Subagent ${runId} is done. Start a fresh run.` }, runId.slice(0, 8));
    expect(text).toContain(" × → tia-3 · refused");
    expect(text).toContain("tia-3 is done. Start a fresh run.");
    expect(text).not.toContain(runId.slice(0, 8));
  });

  it.each([["release", "release"], [undefined, "typed-target"]])("uses the peer name when reported (%s)", (sessionName, target) => {
    const text = render({ sessionName, delivered: true, delivery: "broker-accepted" }, "typed-target");
    expect(text).toContain(`→ ${target} · broker accepted`);
  });

  it("labels broker acceptance without claiming a recipient acknowledgement", () => {
    const text = render({ delivered: true, queued: true, delivery: "broker-accepted", recipientAcknowledged: false });
    expect(text).toMatch(/broker accepted/i);
    expect(text).toMatch(/acknowledgement.*unconfirmed/i);
  });
  it("shows the reason a headless child cannot receive a correction", () => {
    const text = render({ delivered: false, queued: false, delivery: "unavailable", error: "A one-shot headless child is not a peer session. Start a fresh run." });
    expect(text).toContain("headless");
    expect(text).toContain("fresh run");
  });
  it("renders pending transport separately from failed or confirmed delivery", () => {
    const text = render({ delivered: false, queued: true, delivery: "queued", recipientAcknowledged: false, error: "Peer is offline." });
    expect(text).toMatch(/queued.*not delivered/i);
    expect(text).toContain("offline");
  });
});
