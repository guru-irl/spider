import { describe, expect, it } from "vitest";
import { renderSpiderResult } from "../render-result";
import { toToolResult } from "../result";

function render(details: unknown): string {
  const args = { action: "message", to: "peer", message: "Please use the corrected brief." };
  return renderSpiderResult(toToolResult({ details }), { expanded: true }, {}, { args }).render(120).join("\n");
}

describe("message delivery rendering", () => {
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
