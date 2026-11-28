import { CustomEditor, InteractiveMode, Theme, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerInputBand } from "./index.js";
import glass from "../../../herdr/assets/themes/dracula-plus-glass.json" with { type: "json" };

const colors = Object.fromEntries(Object.entries(glass.colors).map(([role, value]) => [role, glass.vars[value as keyof typeof glass.vars] ?? value]));
const theme = new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
const plain = (rows: string[]) => rows.map(row => stripTerminalSequences(row).trimEnd());
const dim = "\x1b[38;2;155;155;156m";
const strip = "\x1b[48;2;16;16;18m";
let stop: (() => void) | undefined;
beforeEach(() => { vi.stubEnv("COLORTERM", "truecolor"); initTheme("dark"); });
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllEnvs(); });

function activate(config: Record<string, unknown> = {}) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = { on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler) } as unknown as ExtensionAPI;
  const ctx = { cwd: "/project", mode: "tui", hasUI: true, ui: { theme, setEditorComponent() {}, getEditorComponent: () => undefined } };
  registerInputBand(pi, { CustomEditor, InteractiveMode }, () => config);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);
  return () => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
}

function mode(steering = ["Check the result"], followUp = ["Summarize it"]) {
  let steer = steering.slice(), follow = followUp.slice();
  let text = "draft";
  const instance = Object.create(InteractiveMode.prototype) as any;
  Object.assign(instance, {
    pendingMessagesContainer: new Container(), pendingBashComponents: [], compactionQueuedMessages: [],
    runtimeHost: { session: {
      getSteeringMessages: () => steer, getFollowUpMessages: () => follow,
      clearQueue: () => { const result = { steering: steer, followUp: follow }; steer = []; follow = []; return result; },
    } },
    editor: { getText: () => text, setText: (next: string) => { text = next; } },
    getAppKeyDisplay: () => "Option+Up",
  });
  return { instance, getText: () => text };
}

it("draws steering and follow-up bands with a gray bar and hourglass, then Pi's hint", () => {
  stop = activate({ "ui.icons": "nerd" });
  const { instance } = mode();
  instance.updatePendingMessagesDisplay();
  const rows = instance.pendingMessagesContainer.render(32) as string[];
  expect(plain(rows)).toEqual([
    "", `▗${"▄".repeat(31)}`, "▐ \u{F051F}  Check the result", `▝${"▀".repeat(31)}`,
    `▗${"▄".repeat(31)}`, "▐ \u{F051F}  Summarize it", `▝${"▀".repeat(31)}`,
    " ↳ Option+Up to edit all que...",
  ]);
  expect(rows[1]).toContain(`${dim}▗`);
  expect(rows[2]).toContain(`${dim}▐`);
  expect(rows[2]).toContain(`${dim}\u{F051F} `);
  expect(rows[2]).toContain(strip);
  expect(rows.every(row => visibleWidth(row) <= 32)).toBe(true);
});

it("keeps Pi's dequeue behavior and restores the stock display when disabled", () => {
  const { instance, getText } = mode();
  instance.updatePendingMessagesDisplay();
  const stock = instance.pendingMessagesContainer.render(60);
  const first = activate();
  stop = activate();
  first();
  instance.updatePendingMessagesDisplay();
  expect(plain(instance.pendingMessagesContainer.render(60)).join("\n")).toContain("Check the result");
  expect(instance.restoreQueuedMessagesToEditor()).toBe(2);
  expect(getText()).toBe("Check the result\n\nSummarize it\n\ndraft");
  expect(instance.pendingMessagesContainer.render(60)).toEqual([]);
  stop(); stop = undefined;
  const other = mode().instance;
  other.updatePendingMessagesDisplay();
  expect(other.pendingMessagesContainer.render(60)).toEqual(stock);
});

it("leaves unknown Pi queue display shapes alone and fits narrow widths", () => {
  stop = activate();
  const { instance } = mode(["界界界 hello"], []);
  instance.updatePendingMessagesDisplay();
  for (let width = 3; width <= 12; width++) {
    expect((instance.pendingMessagesContainer.render(width) as string[]).every(row => visibleWidth(row) <= width), `${width} columns`).toBe(true);
  }
  // An extra component is not a Pi queue row and must never be replaced.
  const original = new Container();
  instance.pendingBashComponents = [original];
  instance.updatePendingMessagesDisplay();
  expect(instance.pendingMessagesContainer.children[0]).toBe(original);
});
