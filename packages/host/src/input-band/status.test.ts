import { CustomEditor, InteractiveMode, Theme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Loader, stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerInputBand } from "./index.js";
import glass from "../../../herdr/assets/themes/dracula-plus-glass.json" with { type: "json" };

const colors = Object.fromEntries(Object.entries(glass.colors).map(([role, value]) => [role, glass.vars[value as keyof typeof glass.vars] ?? value]));
const theme = new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
const tui = { requestRender() {} } as any;
class Indicator extends Loader {
  constructor(public kind: string) { super(tui, s => theme.fg("error", s), s => s, "Status"); }
  dispose() { this.stop(); }
}
const mode = () => Object.assign(Object.create(InteractiveMode.prototype), {
  defaultEditor: { setWorkingStatusIndicator() {} }, editor: {}, statusContainer: new Container(),
});
function activate(style = "text") {
  const handlers = new Map<string, Function>();
  const pi = { on: (name: string, handler: Function) => handlers.set(name, handler) } as unknown as ExtensionAPI;
  const ctx = { cwd: "/project", mode: "tui", hasUI: true, ui: { theme, setEditorComponent() {}, getEditorComponent: () => undefined } };
  registerInputBand(pi, { CustomEditor, InteractiveMode }, () => ({ "ui.icons": style }));
  handlers.get("session_start")?.({ reason: "startup" }, ctx);
  return () => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
}
let stop: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("COLORTERM", "truecolor"); });
afterEach(() => { stop?.(); stop = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it.each([ ["compaction", "accent"], ["branchSummary", "accent"], ["retry", "warning"] ] as const)(
  "renders the %s status with animated moon frames in %s", (kind, color) => {
    stop = activate();
    const view = mode(), indicator = new Indicator(kind);
    view.showStatusIndicator(indicator);
    expect(view.statusContainer.children).toEqual([indicator]);
    let row = view.statusContainer.render(40).join("\n") as string;
    expect(row).toContain(theme.fg(color, "◐"));
    expect(stripTerminalSequences(row)).toContain("◐ Status");
    vi.advanceTimersByTime(250);
    row = view.statusContainer.render(40).join("\n");
    expect(row).toContain(theme.fg(color, "◓"));
    indicator.dispose();
  },
);

it("keeps only the latest session binding and restores Pi's spinner after shutdown", () => {
  const first = activate();
  stop = activate("nerd");
  first();
  const view = mode(), during = new Indicator("retry");
  view.showStatusIndicator(during);
  expect(stripTerminalSequences(view.statusContainer.render(40).join("\n"))).toContain("\uE3E3 Status");
  stop(); stop = undefined;
  const after = new Indicator("retry");
  view.showStatusIndicator(after);
  expect(stripTerminalSequences(view.statusContainer.render(40).join("\n"))).toContain("⠋ Status");
  after.dispose();
});

it("uses Nerd moon frames, while leaving working and unknown shapes alone", () => {
  stop = activate("nerd");
  const view = mode(), working = new Indicator("working");
  view.showStatusIndicator(working);
  expect(stripTerminalSequences(view.statusContainer.render(40).join("\n"))).toContain("⠋ Status");
  const other = new Indicator("compaction");
  view.showStatusIndicator(other);
  expect(stripTerminalSequences(view.statusContainer.render(40).join("\n"))).toContain("\uE3E3 Status");
  const unknown = { kind: "retry", render: () => ["unchanged"], invalidate() {}, dispose() {} };
  view.showStatusIndicator(unknown);
  expect(view.statusContainer.render(40)).toEqual(["unchanged"]);
  other.dispose();
});
