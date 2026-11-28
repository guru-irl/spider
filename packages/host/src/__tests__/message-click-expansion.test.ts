import { CustomMessageComponent, initTheme, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Container, Text, TuiAltScreen, stripTerminalSequences, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import spiderExtension from "../extension.js";
import { withIntercomCards } from "../intercom-cards.js";
import { withClickExpansion } from "../message-click-expansion.js";
import { hostUnitPorts, withPiEvents } from "./fixtures/pi-events.js";

const width = 72;
const output = (component: Container) => component.render(width).map(stripTerminalSequences).join("\n");
function click(component: Container, y: number, x = 1, button: "left" | "right" = "left") {
  const height = component.render(width).length;
  return component.handleMouse({ type: "click", button, x, y, width, height,
    screenX: x, screenY: y, shift: false, alt: false, ctrl: false });
}

const incoming = {
  from: { id: "sender", name: "Alex" },
  message: { content: { text: "First line\nSecond line", attachments: [{ name: "note.txt" }] } },
};

const renderers = new Map<string, MessageRenderer>();
beforeAll(() => {
  initTheme("dark");
  const pi = withPiEvents({
    on: () => () => {},
    registerMessageRenderer: (name: string, render: MessageRenderer) => renderers.set(name, render),
  });
  spiderExtension(pi as never, hostUnitPorts);
  withIntercomCards(pi as never, () => "text", "desk").registerMessageRenderer("intercom_message", () => undefined);
});

function card(customType: string, details: unknown, content = "") {
  return new CustomMessageComponent({ role: "custom", customType, details, content, display: true, timestamp: 0 }, renderers.get(customType)!);
}

it.each([
  { type: "intercom_message", details: incoming, content: "", extra: "Attachment: note.txt" },
  { type: "spider.subagent_done", details: { name: "scribe", status: "done", output: "alpha beta gamma delta epsilon\nsecond\nthird\nfourth\nfifth\nEnd of run" }, content: "", extra: "End of run" },
  { type: "spider.command", details: undefined, content: "First\nSecond\nThird\nFourth\nFifth\nLast command line", extra: "Last command line" },
])("toggles the expanded view of $type on each left click", ({ type, details, content, extra }) => {
  const message = card(type, details, content);
  const collapsed = output(message);
  expect(collapsed).not.toContain(extra);
  expect(click(message, 2)).toMatchObject({ handled: true });
  expect(output(message)).toContain(extra);
  expect(click(message, 2)).toMatchObject({ handled: true });
  expect(output(message)).toBe(collapsed);
});

it("expands a message on a fullscreen press and release but not a drag", () => {
  let input: (data: string) => void = () => { throw new Error("terminal not started"); };
  const terminal: Terminal = {
    columns: width, rows: 24, kittyProtocolActive: false,
    start(onInput) { input = onInput; }, stop() {}, async drainInput() {}, write() {},
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
    clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  const screen = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  screen.addChild(card("intercom_message", incoming));
  const screenText = () => screen.getScreenLines().map(stripTerminalSequences).join("\n");
  const mouse = (button: number, x: number, y: number, release = false) =>
    input(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
  screen.start();
  try {
    screen.renderNow();
    const y = screen.getScreenLines().findIndex(line => stripTerminalSequences(line).includes("First line Second line"));
    expect(y).toBeGreaterThanOrEqual(0);
    expect(screenText()).not.toContain("Attachment: note.txt");
    mouse(0, 5, y);
    screen.renderNow();
    expect(screenText()).not.toContain("Attachment: note.txt");
    mouse(0, 5, y, true);
    screen.renderNow();
    expect(screenText()).toContain("Attachment: note.txt");
    mouse(0, 5, y);
    mouse(32, 9, y);
    mouse(0, 9, y, true);
    screen.renderNow();
    expect(screenText()).toContain("Attachment: note.txt");
    mouse(0, 5, y);
    mouse(0, 5, y, true);
    screen.renderNow();
    expect(screenText()).not.toContain("Attachment: note.txt");
  } finally {
    screen.stop();
  }
});

describe("incoming intercom clicks", () => {
  it("leaves the spacer, adjacent card, off-card columns, and right click alone", () => {
    const first = card("intercom_message", incoming);
    const second = card("intercom_message", incoming);
    const transcript = new Container();
    transcript.addChild(first);
    transcript.addChild(second);
    expect(click(transcript, 0)).toBeUndefined();
    expect(click(transcript, 2, width)).toBeUndefined();
    expect(click(transcript, 2, 1, "right")).toBeUndefined();
    expect(output(transcript)).not.toContain("Attachment: note.txt");
    expect(click(transcript, 2)).toMatchObject({ handled: true });
    expect(output(first)).toContain("Attachment: note.txt");
    expect(output(second)).not.toContain("Attachment: note.txt");
  });

  it("keeps the click state through Pi invalidations", () => {
    const message = card("intercom_message", incoming);
    click(message, 2);
    message.invalidate();
    expect(output(message)).toContain("Attachment: note.txt");
    click(message, 2);
    message.invalidate();
    expect(output(message)).not.toContain("Attachment: note.txt");
  });

  it("discards a click override when Pi changes the global expansion state", () => {
    const message = card("intercom_message", incoming);
    click(message, 2);
    expect(output(message)).toContain("Attachment: note.txt");

    // Ctrl+O flips Pi's global flag and sends that value to each card.
    message.setExpanded(true);
    expect(output(message)).toContain("Attachment: note.txt");
    message.setExpanded(false);
    expect(output(message)).not.toContain("Attachment: note.txt");
    message.setExpanded(true);
    click(message, 2);
    expect(output(message)).not.toContain("Attachment: note.txt");
    message.setExpanded(false);
    message.setExpanded(true);
    expect(output(message)).toContain("Attachment: note.txt");
  });
});

it("lets a child handle its own click without expanding the card", () => {
  const render = withClickExpansion((_message, { expanded }) => {
    const child = new Text(expanded ? "Full details" : "[action] Preview", 0, 0);
    return Object.assign(child, { handleMouse(event: TuiMouseEvent) {
      if (event.type !== "click" || event.button !== "left" || event.x >= 8) return undefined;
      child.setText("Action handled");
      return { handled: true };
    } });
  });
  const message = new CustomMessageComponent({ role: "custom", customType: "fixture", content: "", display: true, timestamp: 0 }, render);
  expect(click(message, 1, 2)).toMatchObject({ handled: true });
  expect(output(message)).toContain("Action handled");
  expect(output(message)).not.toContain("Full details");
  expect(click(message, 1, 9)).toMatchObject({ handled: true });
  expect(output(message)).toContain("Full details");
});

it("does not claim clicks on an escalation, which always shows the full summary", () => {
  const message = card("spider.escalation", { severity: "warning", summary: "Check the manifest" });
  const before = output(message);
  expect(before).toContain("Check the manifest");
  expect(click(message, 2)).toBeUndefined();
  message.setExpanded(true);
  expect(output(message)).toBe(before);
  expect(click(message, 2)).toBeUndefined();
});
