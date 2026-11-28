import test from "../test-support.js";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { InlineMessageComponent } from "../ui/inline-message.js";
import type { Message, SessionInfo } from "../types.js";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
const from: SessionInfo = { id: "session-12345678", name: "sender", cwd: "/project", model: "model", pid: 1, startedAt: 0, lastActivity: 0 };
const remote: SessionInfo = { remote: true, id: "remote-session", address: { sessionId: "remote-session", scopeId: null }, machineId: "machine-id", machineAlias: "box-1", homeEpoch: 1, activationEpoch: "a", endpointEpoch: "e", name: "sender", cwd: "/remote", model: "model", startedAt: 0, lastActivity: 0 };
const message: Message = { id: "message-id", timestamp: 0, replyTo: "parent-message-id", provenance: { type: "extension_outbox", extensionId: "ext-id", extensionName: "Notifier", requestId: "req-id" }, content: { text: "First line of the message\nSecond line has the full body", attachments: [{ type: "snippet", name: "note.txt", content: "details" }] } };

for (const style of ["text", "nerd"] as const) {
  for (const [sender, machine] of [[from, "my-mac"], [remote, "box-1"]] as const) {
    test(`${style} received message shows ${machine} and a one-line collapsed preview`, () => {
      const component = new InlineMessageComponent(sender, message, theme as any, "intercom reply", undefined, true, style, "my-mac");
      const lines = component.render(90);
      const logo = style === "nerd" ? "\u{F0BCA}  " : "◆ ";
      const gutter = style === "nerd" ? "└  " : "└ ";
      assert.equal(lines[0], ` ${logo}intercom · from sender · ${machine}`);
      assert.equal(lines[1], ` ${gutter}First line of the message Second line has the full body`);
      assert.equal(lines.length, 2);
      assert.doesNotMatch(lines.join("\n"), /parent-message|message-id|ext-id|req-id|[╭╮╰╯│]/);
      assert.ok((lines.join("\n").match(/Ctrl\+O/g) ?? []).length <= 1);
    });
    test(`${style} received message expands body and metadata on ${machine}`, () => {
      const original = structuredClone(message);
      const component = new InlineMessageComponent(sender, message, theme as any, "intercom reply", undefined, false, style, "my-mac");
      const lines = component.render(90);
      const indent = style === "nerd" ? "    " : "   ";
      assert.ok(lines.includes(`${indent}First line of the message`));
      assert.ok(lines.includes(`${indent}Second line has the full body`));
      assert.ok(lines.includes(`${indent}To reply: intercom reply`));
      assert.ok(lines.includes(`${indent}Attachment: note.txt`));
      assert.ok(lines.includes(`${indent}Via extension: Notifier`));
      assert.ok(lines.includes(`${indent}In reply to a message`));
      assert.doesNotMatch(lines.join("\n"), /parent-message|message-id|ext-id|req-id|[╭╮╰╯│]/);
      assert.deepEqual(message, original);
    });
  }
}

test("an unnamed sender falls back to a short session id", () => {
  const unnamed = { ...from, name: undefined };
  assert.match(new InlineMessageComponent(unnamed, message, theme as any, undefined, undefined, false, "text", "my-mac").render(90)[0], /from session- · my-mac/);
});

test("cards wrap and truncate to the actual terminal width, including ANSI and wide characters", () => {
  const styled = { fg: (_name: string, text: string) => `\u001b[33m${text}\u001b[0m`, bold: (text: string) => `\u001b[1m${text}\u001b[0m` };
  const unicodeMessage = { ...message, content: { text: "\u001b[36m色付き本文\u001b[0m with emoji 🧪 and Unicode tail 計画計画計画" } };
  for (const collapsed of [true, false]) {
    const component = new InlineMessageComponent({ ...from, name: "送信者" }, unicodeMessage, styled as any, "返信", undefined, collapsed, "nerd");
    for (const width of [1, 2, 18, 31, 52]) {
      const lines = component.render(width);
      assert.ok(lines.length > 0);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${stripVTControlCharacters(line)}`);
    }
  }
});

test("title and metadata use the active theme and only the command is bold", () => {
  const calls: string[] = [];
  const styled = { fg: (name: string, text: string) => { calls.push(name); return `<${name}>${text}</${name}>`; }, bold: (text: string) => `<bold>${text}</bold>` };
  const lines = new InlineMessageComponent(from, message, styled as any, "intercom reply").render(200).join("\n");
  assert.match(lines, /<bold>intercom<\/bold>/);
  assert.doesNotMatch(lines, /This computer/);
  assert.match(lines, /<dim>To reply: intercom reply<\/dim>/);
  assert.ok(calls.includes("text"));
});

test("theme changes apply when the component rerenders", () => {
  const palette: Record<string, number> = { accent: 31, toolTitle: 32, text: 33, muted: 34, dim: 35 };
  const mutable = { fg: (name: string, text: string) => `\u001b[${palette[name]}m${text}\u001b[0m`, bold: (text: string) => text };
  const component = new InlineMessageComponent(from, message, mutable as any);
  const before = component.render(72).join("\n");
  palette.toolTitle = 96; palette.text = 97; palette.muted = 90;
  const after = component.render(72).join("\n");
  assert.match(before, /\u001b\[32mintercom/);
  assert.match(after, /\u001b\[96mintercom/);
  assert.match(after, /\u001b\[97mFirst line/);
  assert.notEqual(before, after);
});
