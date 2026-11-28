import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { registerIntercomOnce } from "@spider/intercom";
import { localMachineLabel, withIntercomCards } from "../intercom-cards.js";

const plain = { bg: (_: string, value: string) => value, fg: (_: string, value: string) => value, bold: (value: string) => value };
const marked = { bg: plain.bg, fg: (name: string, value: string) => `<${name}>${value}</${name}>`, bold: (value: string) => `<bold>${value}</bold>` };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs(); });

async function fixture(initialStyle: "text" | "nerd") {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  vi.stubEnv("PI_SUBAGENT_ORCHESTRATOR_TARGET", "planner");
  vi.stubEnv("PI_SUBAGENT_RUN_ID", "run");
  vi.stubEnv("PI_SUBAGENT_CHILD_AGENT", "worker");
  vi.stubEnv("PI_SUBAGENT_CHILD_INDEX", "1");
  vi.stubEnv("PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR", "");
  const bus = new EventEmitter();
  const hooks = new Map<string, Function[]>();
  const tools: any[] = [], upstream: any[] = [];
  const renderers = new Map<string, Function>();
  let style = initialStyle;
  const pi: any = {
    events: { on(name: string, fn: (...args: any[]) => void) { bus.on(name, fn); return () => bus.off(name, fn); }, emit(name: string, data: unknown) { bus.emit(name, data); } },
    on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
    registerTool(tool: any) { tools.push(tool); }, registerMessageRenderer(name: string, renderer: Function) { renderers.set(name, renderer); },
    registerCommand() {}, registerShortcut() {}, getAllTools: () => tools, getActiveTools: () => tools.map(tool => tool.name), setActiveTools() {},
    getSessionName: () => "alice", sendMessage() {}, appendEntry() {},
  };
  const context: any = { cwd: process.cwd(), mode: "rpc", hasUI: false, model: { id: "fixture" },
    sessionManager: { getSessionId: () => "fixture-session", getEntries: () => [] }, isIdle: () => true,
    ui: { notify() {}, setStatus() {} }, abort() {}, shutdown() {} };
  const presentation = withIntercomCards(pi, () => style, "Desk-Mac");
  const observed = new Proxy(presentation, { get(target, key, receiver) {
    if (key === "registerTool") return (tool: any) => { upstream.push(tool); target.registerTool(tool); };
    return Reflect.get(target, key, receiver);
  } });
  registerIntercomOnce(observed, async () => {});
  for (const start of [...hooks.get("session_start") ?? []]) await start({}, context);
  cleanups.push(async () => { for (const stop of [...hooks.get("session_shutdown") ?? []]) await stop({}, context); });
  return { tools, upstream, renderers, context, presentation, setStyle(value: "text" | "nerd") { style = value; } };
}

const lines = (component: any) => component.render(160).map((line: string) => line.trimEnd());
const messageLines = (component: any) => lines(component).slice(1, -1);
const call = (tool: any, args: object, theme = plain) => lines(tool.renderCall(args, theme, {})).join("\n");
const result = (tool: any, value: object, action: string, expanded = false, partial = false, theme = plain) =>
  lines(tool.renderResult(value, { isPartial: partial, expanded }, theme, { args: { action }, isError: false, expanded })).join("\n");

const local = { id: "local-session", name: "ben", cwd: "/project", model: "m", pid: 1, startedAt: 0, lastActivity: 0 };
const remote = { remote: true, id: "remote-session", address: { sessionId: "remote-session", scopeId: null }, machineId: "m", machineAlias: "peer", homeEpoch: 1, activationEpoch: "a", endpointEpoch: "e", name: "ben", cwd: "/remote", model: "m", startedAt: 0, lastActivity: 0 };
const message = { id: "msg-id", timestamp: 0, replyTo: "parent-id", provenance: { type: "extension_outbox", extensionId: "ext-id", extensionName: "Notifier", requestId: "req-id" }, content: { text: "First line\nSecond line", attachments: [{ type: "snippet", name: "note.txt", content: "details" }] } };

describe.each(["text", "nerd"] as const)("registered intercom cards in %s style", style => {
  const logo = style === "nerd" ? "\u{F0BCA}  " : "◆ ";
  const success = style === "nerd" ? "\u{F012C}  " : "✓ ";
  const failure = style === "nerd" ? "\u{F0156}  " : "× ";
  const warning = style === "nerd" ? "\u{F002A}  " : "▲ ";
  const indent = style === "nerd" ? "    " : "   ";
  const toolIndent = indent.slice(1);

  it("renders send, ask, reply, and list calls with a bold title", async () => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "intercom");
    for (const action of ["send", "ask", "reply"]) {
      expect(call(tool, { action, to: "planner", message: "hello\nthere" })).toBe(`${logo}intercom · ${action} → planner\n${toolIndent}hello there`);
    }
    expect(call(tool, { action: "list" })).toBe(`${logo}intercom · list`);
    const title = call(tool, { action: "send", to: "planner" }, marked);
    expect(title).toContain(`<toolTitle>${style === "nerd" ? "\u{F0BCA} " : "◆"}</toolTitle>`);
    expect(title).toContain("<bold>intercom</bold>");
    expect(title).toContain("<muted>send → planner</muted>");
  });

  it("wraps title, preview, and result continuations under the text column", async () => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "intercom");
    const width = 24;
    const title = tool.renderCall({ action: "send", to: "long-target-name", message: "alpha beta gamma delta epsilon zeta eta theta" }, plain, {}).render(width).map((line: string) => line.trimEnd());
    const previewRow = title.findIndex((line: string) => line.startsWith(`${toolIndent}alpha`));
    expect(previewRow).toBeGreaterThan(1);
    expect(title.slice(1, previewRow).every((line: string) => line.startsWith(toolIndent))).toBe(true);
    expect(title.length).toBeGreaterThan(previewRow + 1);
    expect(title.slice(previewRow + 1).every((line: string) => line.startsWith(toolIndent))).toBe(true);
    expect(title.every((line: string) => visibleWidth(line) <= width)).toBe(true);
    const ansi = { fg: (_: string, value: string) => `\x1b[34m${value}\x1b[39m`, bold: (value: string) => `\x1b[1m${value}\x1b[22m` };
    const styled = tool.renderCall({ action: "send", to: "long-target-name", message: "alpha beta gamma delta epsilon zeta eta theta" }, ansi, {}).render(width);
    const plainRows = styled.map((line: string) => stripTerminalSequences(line).trimEnd());
    const styledPreview = plainRows.findIndex((line: string) => line.startsWith(`${toolIndent}alpha`));
    expect(styledPreview).toBe(previewRow);
    expect(plainRows.slice(1, styledPreview).every((line: string) => line.startsWith(toolIndent))).toBe(true);
    expect(plainRows.slice(styledPreview + 1).every((line: string) => line.startsWith(toolIndent))).toBe(true);
    expect(styled.every((line: string) => visibleWidth(line) <= width)).toBe(true);
    const output = tool.renderResult({ content: [{ type: "text", text: "alpha beta gamma delta epsilon zeta\nmore alpha beta gamma delta" }], details: {} },
      { isPartial: false, expanded: true }, plain, { args: { action: "send" }, isError: false, expanded: true }).render(width);
    expect(output.slice(1).every((line: string) => line.startsWith(toolIndent))).toBe(true);
    expect(output.every((line: string) => visibleWidth(line) <= width)).toBe(true);
  });

  it("keeps tool calls and results within narrow widths", async () => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "intercom");
    const value = { content: [{ type: "text", text: "結果計画計画 色付き本文 and a Unicode tail" }], details: {} };
    for (const width of [1, 2, 18, 31, 52]) {
      const callRows = tool.renderCall({ action: "send", to: "計画", message: "色付き本文 and a Unicode tail" }, plain, {}).render(width);
      const resultRows = tool.renderResult(value, { isPartial: false, expanded: true }, plain,
        { args: { action: "send" }, isError: false, expanded: true }).render(width);
      for (const line of [...callRows, ...resultRows]) {
        expect(visibleWidth(line), `width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("renders errors and warnings from both tools with monochrome glyphs", async () => {
    const h = await fixture(style);
    const cases = [
      { tool: "intercom", text: "not delivered", details: { error: true }, marker: failure },
      { tool: "intercom", text: "reply", details: { structuredReplyParseError: "invalid" }, marker: warning },
      { tool: "contact_supervisor", text: "reply", details: { structuredReplyParseError: "invalid" }, marker: warning },
      { tool: "contact_supervisor", text: "invalid reason", details: { error: true }, marker: failure },
    ];
    for (const item of cases) {
      const value = { content: [{ type: "text", text: item.text }], details: item.details };
      const before = structuredClone(value);
      const output = result(h.tools.find(tool => tool.name === item.tool), value, item.tool);
      expect(output.split("\n")[0]).toBe(`${item.marker}${item.text}`);
      expect(output).not.toContain("❌");
      expect(output).not.toContain("⚠️");
      expect(value).toEqual(before);
    }
  });

  it("aligns statuses and continuation rows, including failures and partial results", async () => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "intercom");
    const value = { content: [{ type: "text", text: "Message sent to planner\nsecond line" }], details: { delivered: true, path: "relay box", targetMachine: "box", relaySkips: ["other"] } };
    const before = structuredClone(value);
    expect(result(tool, value, "send")).toBe(`${success}Message sent to planner\n${toolIndent}second line`);
    expect(result(tool, { content: [{ type: "text", text: "not delivered" }], details: { delivered: false } }, "send")).toBe(`${failure}not delivered`);
    expect(result(tool, value, "list", false, true)).toBe("Intercom working...");
    expect(value).toEqual(before);
  });

  it("shows named list rows without session IDs while preserving the original result", async () => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "intercom");
    const value = { content: [{ type: "text", text: "**Current session:**\n• alice (f00dbabe) — /project (m) [self]\n\n**Other sessions:**\n• bob (deadbeef) — /project (m)\n• Unnamed session (cafe1234) — /project (m)" }], details: {} };
    const before = structuredClone(value);
    const collapsed = result(tool, value, "list");
    expect(collapsed).toContain("alice — /project");
    expect(collapsed).toContain("bob — /project");
    expect(collapsed).not.toContain("f00dbabe");
    expect(collapsed).not.toContain("deadbeef");
    expect(collapsed).toContain("Unnamed session (cafe1234)");
    expect(result(tool, value, "list", true)).toContain("alice (f00dbabe)");
    expect(value).toEqual(before);
  });

  it("separates a relayed ask's route from its multiline reply", async () => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "intercom");
    const value = {
      content: [{ type: "text", text: "**Reply from Alex:**\nFirst reply line\nSecond reply line\nPath: relay ridge.\nsummit: busy." }],
      details: { delivery: "replied", path: "relay ridge", targetMachine: "desk", relaySkips: [{ relay: "summit", reason: "busy" }] },
    };
    const before = structuredClone(value);
    const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
    const theme = { ...plain, fg: (role: string, text: string) => role === "dim" ? dim(text) : text };
    for (const expanded of [false, true]) {
      expect(result(tool, value, "ask", expanded, false, theme).split("\n")).toEqual([
        `${success}Reply from Alex:`,
        `${toolIndent}First reply line`,
        `${toolIndent}Second reply line`,
        `${toolIndent}${dim("→ asked via ridge")}`,
        `${toolIndent}${dim("summit skipped: busy")}`,
      ]);
    }
    expect(value).toEqual(before);
  });

  it("keeps route-like reply lines when the raw suffix is not an exact match", async () => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "intercom");
    const details = { delivery: "replied", path: "relay ridge", relaySkips: [{ relay: "summit", reason: "busy" }] };
    for (const body of [
      "Path: **relay ridge**.\nsummit: busy.",
      "Path: relay ridge.\nsummit: down.",
      "Path: relay ridge.\nsummit: busy.\nFinal reply line.",
    ]) {
      const output = result(tool, { content: [{ type: "text", text: `Reply from Alex:\n${body}` }], details }, "ask");
      for (const line of body.replaceAll("**", "").split("\n")) expect(output).toContain(`${toolIndent}${line}`);
      expect(output).not.toContain("asked via ridge");
      expect(output).not.toContain("summit skipped: busy");
    }
  });

  it("shows the route once when transcript saving fails", async () => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "intercom");
    const value = {
      content: [{ type: "text", text: "**Reply from Alex:**\nHello\nPath: relay ridge.\nsummit: busy.\nThe transcript entry could not be saved." }],
      details: { delivery: "replied", path: "relay ridge", relaySkips: [{ relay: "summit", reason: "busy" }] },
    };
    const output = result(tool, value, "ask");
    expect(output).toContain("The transcript entry could not be saved.");
    expect((output.match(/ridge/g) ?? [])).toHaveLength(1);
    expect((output.match(/summit/g) ?? [])).toHaveLength(1);
  });

  it.each([
    { action: "send", body: "Sent to Alex (broker accepted the message).", verb: "sent" },
    { action: "reply", body: "Reply sent to Alex", verb: "replied" },
  ])("renders the relayed $action route separately from its result", async ({ action, body, verb }) => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "intercom");
    const value = {
      content: [{ type: "text", text: `${body}\nPath: relay ridge.\nsummit: busy.` }],
      details: { delivered: true, path: "relay ridge", relaySkips: [{ relay: "summit", reason: "busy" }] },
    };
    const before = structuredClone(value);
    const output = result(tool, value, action, false, false, marked);
    expect(output).toContain(`<dim>→ ${verb} via ridge</dim>`);
    expect(output).toContain("<dim>summit skipped: busy</dim>");
    expect(output).not.toContain("Path: relay ridge.");
    expect(output).not.toContain("summit: busy.");
    expect(value).toEqual(before);
  });

  it("describes a refused relay ask as an attempt, not a queued ask", async () => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "intercom");
    const value = {
      content: [{ type: "text", text: "Relay busy. Nothing was queued.\nPath: relay ridge.\nsummit: busy." }],
      details: { error: true, code: "relay-busy", path: "relay ridge", relaySkips: [{ relay: "summit", reason: "busy" }] },
    };
    const output = result(tool, value, "ask", false, false, marked);
    expect(output).toContain("Relay busy. Nothing was queued.");
    expect(output).toContain("<dim>→ tried via ridge</dim>");
    expect(output).not.toContain("asked via ridge");
    expect(output).not.toContain("Path: relay ridge.");
  });

  it("leaves skips without a path as error lines on a refused ask", async () => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "intercom");
    const value = {
      content: [{ type: "text", text: "No relay is reachable. Nothing was queued.\nsummit: down." }],
      details: { error: true, code: "no-relay", relaySkips: [{ relay: "summit", reason: "down" }] },
    };
    const output = result(tool, value, "ask", false, false, marked);
    expect(output).toContain("<error>summit: down.</error>");
    expect(output).not.toContain("skipped:");
  });

  it.each(["local", "direct"])("does not draw a route row for a %s ask", async path => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "intercom");
    const value = {
      content: [{ type: "text", text: `Reply from Alex:\nNo updates.\nPath: ${path}.` }],
      details: { delivery: "replied", path },
    };
    expect(result(tool, value, "ask")).toBe(`${success}Reply from Alex:\n${toolIndent}No updates.`);
  });

  it("shows a too-short relay ask timeout as an error without a route row", async () => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "intercom");
    const text = "The ask timeout is too short for a relay. At least 4001 ms must remain. Nothing was queued.";
    const value = { content: [{ type: "text", text }], details: { error: true, code: "ask-timeout-too-short" } };
    expect(result(tool, value, "ask")).toBe(`${failure}${text}`);
  });

  it("hides message IDs only in collapsed display without altering results", async () => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "intercom");
    const id = "12345678-abcdef";
    const value = { content: [{ type: "text", text: `Queued (ID ${id}) for planner\n(ID ${id}) still pending` }], details: { delivered: true, messageId: id, path: "direct", targetMachine: "box", relaySkips: ["skip"] } };
    const before = structuredClone(value);
    expect(result(tool, value, "ask")).toBe(`${success}Queued for planner\n${toolIndent}still pending`);
    expect(result(tool, value, "ask", true)).toContain(id);
    expect(value).toEqual(before);
    const uncertain = { content: [{ type: "text", text: `Delivery could not be confirmed (ID ${id}). Check the recipient.` }], details: { delivered: false, messageId: id } };
    expect(result(tool, uncertain, "ask")).toBe(`${failure}Delivery could not be confirmed. Check the recipient.`);
    expect(result(tool, uncertain, "ask", true)).toContain(`(ID ${id}).`);
    const pending = { content: [{ type: "text", text: "Pending asks:\n- planner · abc123 · 5s ago · Please decide" }], details: {} };
    expect(result(tool, pending, "pending")).toContain("planner · 5s ago · Please decide");
    expect(result(tool, pending, "pending", true)).toContain("abc123");
    const cancel = { content: [{ type: "text", text: "Cancellation requested for abc123" }], details: { messageId: "abc123" } };
    expect(result(tool, cancel, "cancel")).toContain("Cancellation requested for message");
  });

  it("renders the supervisor call, warning and multiline reply with aligned rows", async () => {
    const h = await fixture(style);
    const tool = h.tools.find(tool => tool.name === "contact_supervisor");
    expect(call(tool, { reason: "need_decision", message: "please decide" })).toBe(`${logo}contact_supervisor · need_decision → planner\n${toolIndent}please decide`);
    const warningResult = { content: [{ type: "text", text: "Reply from supervisor:\nUse stable API" }], details: { structuredReplyParseError: "invalid" } };
    expect(result(tool, warningResult, "contact_supervisor")).toBe(`${warning}Reply from supervisor:\n${toolIndent}Use stable API\n${toolIndent}Structured reply parse issue: invalid`);
    expect(result(tool, warningResult, "contact_supervisor", false, true)).toBe("Waiting for supervisor...");
  });

  it("keeps correlation IDs out of expanded reply hints", async () => {
    const h = await fixture(style);
    const render = h.renderers.get("intercom_message")!;
    const replyCommand = `intercom({ action: "reply", replyTo: ${JSON.stringify(message.id)}, message: "..." })`;
    const details = { from: local, message, replyCommand };
    const before = structuredClone(details);
    const output = messageLines(render({ details }, { expanded: true }, plain)).join("\n");
    expect(output).toContain("To reply: use intercom for this message");
    expect(output).not.toContain(message.id);
    expect(details).toEqual(before);
  });

  it("renders local and remote messages in collapsed and expanded form", async () => {
    const h = await fixture(style);
    const render = h.renderers.get("intercom_message")!;
    for (const [from, machine] of [[local, "Desk-Mac"], [remote, "peer"]] as const) {
      const details = { from, message, replyCommand: "intercom reply" };
      const before = structuredClone(details);
      const collapsed = messageLines(render({ details }, { expanded: false }, plain));
      expect(collapsed).toEqual([` ${logo}intercom · from ben · ${machine}`, `${indent}First line Second line`]);
      const expanded = messageLines(render({ details }, { expanded: true }, plain));
      expect(expanded[0]).toBe(` ${logo}intercom · from ben · ${machine}`);
      for (const text of ["First line", "Second line", "To reply: intercom reply", "Attachment: note.txt", "Via extension: Notifier", "In reply to a message"]) expect(expanded).toContain(`${indent}${text}`);
      expect(expanded.join("\n")).not.toMatch(/msg-id|parent-id|ext-id|req-id|[╭╮╰╯│]/);
      const styledTitle = messageLines(render({ details }, { expanded: false }, marked))[0];
      expect(styledTitle).toContain(`<toolTitle>${style === "nerd" ? "\u{F0BCA} " : "◆"}</toolTitle>`);
      expect(styledTitle).toContain("<bold>intercom</bold>");
      expect(details).toEqual(before);
    }
  });
});

it("draws half edges in the custom-message color without a filled edge row", async () => {
  const h = await fixture("text");
  const render = h.renderers.get("intercom_message")!;
  const theme = { ...plain, bg: (_: string, value: string) => `\x1b[48;2;6;6;7m${value}\x1b[49m` };
  const rows = render({ details: { from: local, message } }, { expanded: false, outputPad: 1 }, theme).render(42);
  expect(rows[0]).toBe(`\x1b[38;2;6;6;7m${"▄".repeat(42)}\x1b[39m`);
  expect(rows[1]).toMatch(/^\x1b\[48;2;6;6;7m ◆ intercom/u);
  expect(rows[2]).toMatch(/^\x1b\[48;2;6;6;7m {3}First line Second line/u);
  expect(rows.at(-1)).toBe(`\x1b[38;2;6;6;7m${"▀".repeat(42)}\x1b[39m`);
});

it("uses the short hostname without changing its case", () => {
  expect(localMachineLabel(() => "Desk-Mac.local")).toBe("Desk-Mac");
  expect(localMachineLabel(() => "box-alpha")).toBe("box-alpha");
  expect(localMachineLabel(() => "")).toBe("(unknown machine)");
});

it("uses the current icon style for registered tool and incoming-message renderers", async () => {
  const h = await fixture("text");
  const render = h.renderers.get("intercom_message")!;
  const tool = h.tools.find(tool => tool.name === "intercom");
  const details = { from: local, message };
  expect(call(tool, { action: "list" })).toBe("◆ intercom · list");
  expect(messageLines(render({ details }, { expanded: false }, plain))[0]).toBe(" ◆ intercom · from ben · Desk-Mac");
  h.setStyle("nerd");
  expect(call(tool, { action: "list" })).toBe("\u{F0BCA}  intercom · list");
  expect(messageLines(render({ details }, { expanded: false }, plain))[0]).toBe(" \u{F0BCA}  intercom · from ben · Desk-Mac");
  expect(render({}, { expanded: false }, plain)).toBeUndefined();
});

it("preserves upstream execute and parameters and never mutates its result", async () => {
  const h = await fixture("text");
  const tool = h.tools.find(tool => tool.name === "intercom");
  const original = h.upstream.find(tool => tool.name === "intercom");
  for (const key of Object.keys(original)) {
    if (key !== "renderCall" && key !== "renderResult") expect(tool[key]).toBe(original[key]);
  }
  const output = await tool.execute("fixture", { action: "send", message: "hello" }, new AbortController().signal, undefined, h.context);
  expect(output.content[0].text).toBe("Missing 'to' or 'cwd', or missing 'message' parameter");
  expect(output.details).toMatchObject({ error: true });
  const before = structuredClone(output);
  result(tool, output, "send");
  expect(output).toEqual(before);
});

it("accounts for the Nerd pad cell in error and warning result widths", async () => {
  const h = await fixture("text");
  const cases = [
    { tool: "intercom", details: { error: true }, text: "not delivered" },
    { tool: "contact_supervisor", details: { structuredReplyParseError: "invalid" }, text: "reply" },
  ];
  for (const item of cases) {
    const tool = h.tools.find(tool => tool.name === item.tool);
    const value = { content: [{ type: "text", text: item.text }], details: item.details };
    h.setStyle("text");
    const text = result(tool, value, item.tool).split("\n")[0];
    h.setStyle("nerd");
    const nerd = result(tool, value, item.tool).split("\n")[0];
    expect(visibleWidth(nerd)).toBe(visibleWidth(text) + 1);
  }
});

it("passes unrelated tool and message renderers through unchanged", async () => {
  const h = await fixture("text");
  const unrelated = { name: "other", execute: vi.fn(), renderCall: vi.fn(), renderResult: vi.fn() };
  const renderer = vi.fn();
  h.presentation.registerTool(unrelated as never);
  h.presentation.registerMessageRenderer("other_message", renderer);
  expect(h.tools.at(-1)).toBe(unrelated);
  expect(h.renderers.get("other_message")).toBe(renderer);
});

it("keeps cards within the given widths", async () => {
  const h = await fixture("nerd");
  const render = h.renderers.get("intercom_message")!;
  const details = { from: local, message: { ...message, content: { text: "色付き本文 and a Unicode tail 計画計画" } } };
  for (const expanded of [false, true]) for (const width of [1, 2, 18, 31, 52]) {
    for (const line of render({ details }, { expanded }, plain).render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});
