import { describe, it, expect } from "vitest";
import { renderMessageResult } from "../renderers/message.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("message renderer", () => {
  it.each([
    { delivery: "delivered", delivered: true, transformed: false, icon: "✓", status: "delivered" },
    { delivery: "delivered", delivered: true, transformed: true, icon: "✓", status: "delivered, transformed" },
    { delivery: "accepted but not confirmed", delivered: false, icon: "⚠", status: "accepted but not confirmed" },
    { delivery: "no reply yet, delivery unknown", delivered: false, icon: "⚠", status: "no reply yet, delivery unknown" },
    { delivery: "child-accepted", delivered: false, icon: "⚠", status: "accepted but not confirmed" },
    { delivery: "refused", delivered: false, icon: "✗", status: "refused" },
    { delivery: "broker-accepted", delivered: false, icon: "⚠", status: "broker accepted · acknowledgement unconfirmed" },
  ] as const)("renders $delivery (transformed=$transformed) with truthful severity", row => {
    const text = renderMessageResult({ verb: "send", body: "correction", to: "run", ...row, error: "Delivery diagnostic." }, { theme: id, width: 120 }).join("\n");
    expect(text).toContain(row.icon); expect(text).toContain(row.status);
    if (row.icon !== "✗") expect(text).not.toContain("✗");
  });
  it.each(["queued", "broker-accepted", undefined] as const)("keeps %s delivery notes neutral instead of turning them into error headlines", delivery => {
    const colored = { ...id, fg: (token: string, text: string) => token === "error" ? `\x1b[31m${text}\x1b[39m` : text };
    const out = renderMessageResult({ verb: "send", to: "peer", body: "ping", delivered: false, delivery, error: "Peer is offline.\nRetry later." }, { theme: colored, width: 120 }).join("\n");
    if (delivery === "queued") expect(out).toContain("queued · not delivered");
    if (delivery === "broker-accepted") expect(out).toContain("acknowledgement unconfirmed");
    expect(out).toContain("│ Peer is offline.");
    expect(out).not.toContain("\x1b[31mPeer is offline.");
    expect(out).toContain("Retry later.");
  });

  it.each([false, true])("uses one failure glyph and error styling for unavailable delivery (expanded=%s)", expanded => {
    const colored = { ...id, fg: (token: string, text: string) => token === "error" ? `\x1b[31m${text}\x1b[39m` : text };
    const out = renderMessageResult({ verb: "send", to: "peer", body: "", delivered: false, delivery: "unavailable", error: "One-shot child cannot receive messages.\nStart a fresh run." }, { theme: colored, width: 120, expanded }).join("\n");
    expect(out.match(/✗/g)).toHaveLength(1);
    expect(out).toContain("recipient unavailable");
    expect(out).toContain("\x1b[31mOne-shot child cannot receive messages.");
    if (expanded) expect(out).toContain("Start a fresh run.");
    else expect(out).not.toContain("Start a fresh run.");
  });

  it("delivered message shows target + body within width — no repeated header", () => {
    const lines = renderMessageResult({ verb: "send", to: "peer", body: "hello there", delivered: true }, { theme: id, width: 50 });
    const text = lines.join("\n");
    expect(text).not.toMatch(/spider (send|message)/);
    expect(text).toContain("✓");
    expect(text).toMatch(/peer/);
    expect(text).toMatch(/hello there/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(50);
  });
  it("undelivered message shows ✗ and no body line when body empty", () => {
    const lines = renderMessageResult({ verb: "send", to: "x", body: "", delivered: false }, { theme: id, width: 40 });
    expect(lines.join("\n")).toContain("✗");
    expect(lines.filter((l) => l.trim())).toHaveLength(1);
  });
  it("reply/ask/broadcast verbs render distinct arrows", () => {
    expect(renderMessageResult({ verb: "reply", to: "a", body: "b", delivered: true }, { theme: id, width: 40 }).join("\n")).toContain("↩");
    expect(renderMessageResult({ verb: "broadcast", body: "b", delivered: true }, { theme: id, width: 40 }).join("\n")).toContain("⇉");
  });
});
