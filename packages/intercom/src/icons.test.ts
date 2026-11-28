import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import intercom, { localMachineLabel } from "./local.js";

const plain = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const marked = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `<bold>${text}</bold>` };
afterEach(() => vi.unstubAllEnvs());

function toolsFor(style: "text" | "nerd" | (() => "text" | "nerd")) {
  vi.stubEnv("PI_SUBAGENT_ORCHESTRATOR_TARGET", "planner");
  vi.stubEnv("PI_SUBAGENT_RUN_ID", "run");
  vi.stubEnv("PI_SUBAGENT_CHILD_AGENT", "worker");
  vi.stubEnv("PI_SUBAGENT_CHILD_INDEX", "1");
  vi.stubEnv("PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR", "");
  const emitter = new EventEmitter();
  const tools = new Map<string, any>();
  const pi = {
    events: { on: (name: string, fn: (...args: any[]) => void) => { emitter.on(name, fn); return () => emitter.off(name, fn); }, emit: (name: string, value: unknown) => emitter.emit(name, value) },
    on: () => {}, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {},
    registerShortcut: () => {}, registerMessageRenderer: (name: string, renderer: any) => tools.set(`renderer:${name}`, renderer),
  };
  intercom(pi as never, async () => {}, () => typeof style === "function" ? style() : style);
  return tools;
}

const renderCall = (tool: any, args: object, theme = plain) => tool.renderCall(args, theme, {}).render(160).map((line: string) => line.trimEnd()).join("\n");
const renderResult = (tool: any, result: object, expanded = false) => tool.renderResult(result, { isPartial: false }, plain, { isError: false, expanded }).render(160).map((line: string) => line.trimEnd()).join("\n");

it("uses the short hostname without changing its case", () => {
  expect(localMachineLabel(() => "Desk-Mac.local")).toBe("Desk-Mac");
  expect(localMachineLabel(() => "box-alpha")).toBe("box-alpha");
});

it("uses the current icon style when rendering incoming messages", () => {
  let style: "text" | "nerd" = "text";
  const render = toolsFor(() => style).get("renderer:intercom_message");
  assertRegisteredMessageRender(render, () => { style = "nerd"; });
});

function assertRegisteredMessageRender(render: any, setNerd: () => void) {
  const details = { from: { id: "sender-id", name: "sender", cwd: "/project", model: "m", pid: 1, startedAt: 0, lastActivity: 0 }, message: { id: "msg", timestamp: 0, content: { text: "hello" } } };
  const original = structuredClone(details);
  expect(render({}, { expanded: false }, plain)).toBeUndefined();
  expect(render({ details }, { expanded: false }, plain).render(80)[0]).toContain("◆ intercom");
  setNerd();
  expect(render({ details }, { expanded: false }, plain).render(80)[0]).toContain("\u{F0BCA}  intercom");
  expect(details).toEqual(original);
}

describe.each(["text", "nerd"] as const)("intercom cards in %s style", style => {
  const logo = style === "nerd" ? "\u{F0BCA}  " : "◆ ";
  const gutter = style === "nerd" ? "└  " : "└ ";
  const success = style === "nerd" ? "\u{F012C}  " : "✓ ";
  const failure = style === "nerd" ? "\u{F0156}  " : "× ";
  const warning = style === "nerd" ? "\u{F002A}  " : "▲ ";

  it("renders the intercom call with a bold command, muted details, and a gutter preview", () => {
    const tool = toolsFor(style).get("intercom");
    const args = { action: "send", to: "planner", message: "hello there" };
    expect(renderCall(tool, args)).toBe(` ${logo}intercom · send → planner\n ${gutter}hello there`);
    const title = renderCall(tool, args, marked);
    expect(title).toContain("<bold>intercom</bold>");
    expect(title).toContain("<muted>send → planner</muted>");
    expect(title).not.toContain("<accent>send");
  });

  it("renders a supervisor call in the same style, with reason and recipient muted", () => {
    const tool = toolsFor(style).get("contact_supervisor");
    const args = { reason: "need_decision", message: "please decide" };
    expect(renderCall(tool, args)).toBe(` ${logo}contact_supervisor · need_decision → planner\n ${gutter}please decide`);
    const title = renderCall(tool, args, marked);
    expect(title).toContain("<bold>contact_supervisor</bold>");
    expect(title).toContain("<muted>need_decision → planner</muted>");
  });

  it("hides IDs in generated cancellation and pending summaries without changing the result", () => {
    const tool = toolsFor(style).get("intercom");
    const cancel = { content: [{ type: "text", text: "Cancellation requested for abc123" }], details: { delivered: true, messageId: "abc123" } };
    const pending = { content: [{ type: "text", text: "**Pending asks:**\n- planner · abc123 · 5s ago · Please decide" }], details: {} };
    const render = (result: object, action: string, expanded: boolean) => tool.renderResult(result, { isPartial: false, expanded }, plain, { args: { action }, isError: false, expanded }).render(160).map((line: string) => line.trimEnd()).join("\n");
    expect(render(cancel, "cancel", false)).toContain("Cancellation requested for message");
    expect(render(pending, "pending", false)).toContain("planner · 5s ago · Please decide");
    expect(render(cancel, "cancel", true)).toContain("abc123");
    expect(render(pending, "pending", true)).toContain("abc123");
    expect(cancel.content[0].text).toBe("Cancellation requested for abc123");
    expect(pending.content[0].text).toContain("abc123");
  });

  it("uses plain status icons and ignores routing details and message IDs in the collapsed result", () => {
    const tools = toolsFor(style);
    const result = { content: [{ type: "text", text: "Message sent to planner" }], details: { delivered: true, messageId: "12345678-abcdef", path: "relay box", targetMachine: "box", relaySkips: ["other"] } };
    const before = structuredClone(result);
    for (const name of ["intercom", "contact_supervisor"]) {
      const output = renderResult(tools.get(name), result);
      expect(output).toBe(`${success}Message sent to planner`);
      expect(output).not.toContain("12345678");
      expect(output).not.toContain("relay");
    }
    expect(result).toEqual(before);
    expect(renderResult(tools.get("intercom"), { content: [{ type: "text", text: "not delivered" }], details: { delivered: false } })).toBe(`${failure}not delivered`);
    expect(renderResult(tools.get("contact_supervisor"), { content: [{ type: "text", text: "reply" }], details: { structuredReplyParseError: "invalid" } })).toContain(`${warning}reply`);
  });
});
