import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { visibleWidth } from "@earendil-works/pi-tui";
import intercom from "./local.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
afterEach(() => vi.unstubAllEnvs());

it("uses the selected failure and warning glyphs in message tool results", () => {
  vi.stubEnv("PI_SUBAGENT_ORCHESTRATOR_TARGET", "parent");
  vi.stubEnv("PI_SUBAGENT_RUN_ID", "run");
  vi.stubEnv("PI_SUBAGENT_CHILD_AGENT", "worker");
  vi.stubEnv("PI_SUBAGENT_CHILD_INDEX", "1");
  vi.stubEnv("PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR", "");
  const emitter = new EventEmitter();
  const tools = new Map<string, any>();
  const pi = {
    events: { on: (name: string, fn: (...args: any[]) => void) => { emitter.on(name, fn); return () => emitter.off(name, fn); }, emit: (name: string, value: unknown) => emitter.emit(name, value) },
    on: () => {}, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {},
    registerShortcut: () => {}, registerMessageRenderer: () => {},
  };
  let style: "text" | "nerd" = "text";
  intercom(pi as never, async () => {}, () => style);
  const failed = { content: [{ type: "text", text: "not delivered" }], details: { error: true } };
  const warning = { content: [{ type: "text", text: "reply" }], details: { structuredReplyParseError: "invalid" } };
  const render = (name: string, result: unknown) => tools.get(name).renderResult(result, { isPartial: false }, theme, { isError: false }).render(100).join("\n");
  const textFailure = render("intercom", failed), textWarning = render("contact_supervisor", warning);
  style = "nerd";
  const nerdFailure = render("intercom", failed), nerdWarning = render("contact_supervisor", warning);
  expect(textFailure).toContain("❌ not delivered");
  expect(nerdFailure).toContain("\u{F0156}  not delivered");
  expect(textWarning).toContain("⚠\uFE0F reply");
  expect(nerdWarning).toContain("\u{F002A}  reply");
  expect(visibleWidth(nerdFailure)).toBe(visibleWidth(textFailure));
  expect(visibleWidth(nerdWarning)).toBe(visibleWidth(textWarning));
});
