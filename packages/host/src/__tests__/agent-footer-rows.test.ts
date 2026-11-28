import { afterEach, describe, expect, it } from "vitest";
import { bus, migrate, openDb, type Db } from "@spider/db-core";
import { cleanupScratch, scratchDbPath } from "@spider/db-core/testutil";
import { stripTerminalSequences, TuiAltScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { installAgentsUI } from "../agents/agents-ui";
import { agentsHostFixture } from "./fixtures/agents-host";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  cleanupScratch();
});

function setup(count: number) {
  const db = openDb(scratchDbPath(`footer-rows-${count}`));
  migrate(db, "project");
  const insert = db.prepare(`INSERT INTO runs (id, session_id, agent, name, status, step_count, token_count, started_at)
    VALUES (?, 's', 'worker', ?, 'running', 0, 0, ?)`);
  for (let i = 1; i <= count; i++) insert.run(`r${i}`, `agent-${i}`, i);
  const host = agentsHostFixture();
  const dispose = installAgentsUI({}, { ui: host.ui } as never, { db, sessionId: "s", piVersion: "1.2.0" }) as
    (() => void) & { openOverlay(): Promise<void> };
  cleanups.push(() => { dispose(); host.close(); db.close(); });
  const footer = host.ui.widgets.get("spider-agents")!;
  const lines = () => footer.render(120).map(stripTerminalSequences);
  const wheel = async (direction: "up" | "down") => {
    await host.settle();
    const screen = (host.view.tui as TuiAltScreen).getScreenLines().map(stripTerminalSequences);
    const y = screen.findIndex(line => line.includes("agent-"));
    expect(y).toBeGreaterThanOrEqual(0);
    await host.send(`\x1b[<${direction === "up" ? 64 : 65};5;${y + 1}M`);
  };
  (host.view.tui as TuiAltScreen).setWheelScrollLines(1);
  return { db, host, dispose, footer, lines, wheel };
}

function names(lines: string[]): string[] {
  return lines.flatMap(line => line.match(/agent-\d+/g) ?? []);
}

describe("agent footer rows", () => {
  it.each([
    [1, ["agent-1"], undefined],
    [2, ["agent-2", "agent-1"], undefined],
    [3, ["agent-3", "agent-2", "agent-1"], undefined],
    [4, ["agent-4", "agent-3"], "+2 more"],
    [5, ["agent-5", "agent-4"], "+3 more"],
    [6, ["agent-6", "agent-5"], "+4 more"],
  ])("renders the correct rows for %i agents", (count, expected, summary) => {
    const { lines } = setup(count);
    const rendered = lines();
    expect(rendered).toHaveLength(Math.min(count, 3));
    expect(names(rendered)).toEqual(expected);
    if (summary) {
      expect(rendered[2]).toContain(`${count} running`);
      expect(rendered[2]).toContain(summary);
    } else expect(rendered.join("\n")).not.toContain("more");
  });

  it("scrolls every collapsed row in both directions through Pi mouse routing", async () => {
    const { host, lines, wheel } = setup(7);
    await host.settle();
    const chatTop = host.view.transcript.scrollTop;
    expect(names(lines())).toEqual(["agent-7", "agent-6"]);
    for (const pair of [["agent-6", "agent-5"], ["agent-5", "agent-4"], ["agent-4", "agent-3"],
      ["agent-3", "agent-2"], ["agent-2", "agent-1"]]) {
      await wheel("down");
      expect(names(lines())).toEqual(pair);
      expect(lines()[2]).toContain("7 running · +5 more");
    }
    await wheel("down");
    expect(names(lines())).toEqual(["agent-2", "agent-1"]);
    await wheel("up");
    expect(names(lines())).toEqual(["agent-3", "agent-2"]);
    expect(host.view.transcript.scrollTop).toBe(chatTop);
  });

  it("moves the first visible row later on a wheel-down event", async () => {
    const { lines, wheel } = setup(7);
    expect(names(lines())[0]).toBe("agent-7");
    await wheel("down");
    expect(names(lines())[0]).toBe("agent-6");
    await wheel("up");
    expect(names(lines())[0]).toBe("agent-7");
  });

  it("moves the cursor down rather than up through three displayed rows", async () => {
    const { host, dispose, lines } = setup(3);
    void dispose.openOverlay();
    await host.settle();
    const cursorIndex = () => lines().findIndex(line => line.startsWith("▸"));
    expect(cursorIndex()).toBe(0);
    await host.send("\x1b[B");
    expect(cursorIndex()).toBe(1);
    await host.send("\x1b[A");
    expect(cursorIndex()).toBe(0);
    await host.send("\u001b");
  });

  it("leaves non-wheel events to Pi", () => {
    const { footer } = setup(5);
    const base: TuiMouseEvent = { type: "click", button: "left", x: 1, y: 0, screenX: 1, screenY: 0,
      width: 120, height: 3, shift: false, alt: false, ctrl: false };
    expect(footer.handleMouse?.(base)).toBeUndefined();
    expect(footer.handleMouse?.({ ...base, type: "drag" })).toBeUndefined();
  });

  it("moves selection down and up in the visible order and reveals hidden selections", async () => {
    const { host, dispose, lines } = setup(5);
    void dispose.openOverlay();
    await host.settle();
    const selected = () => lines().find(line => line.startsWith("▸")) ?? "";
    expect(selected()).toContain("agent-5");
    await host.send("\x1b[B");
    expect(selected()).toContain("agent-4");
    await host.send("\x1b[B");
    expect(selected()).toContain("agent-3");
    expect(names(lines())).toEqual(["agent-4", "agent-3"]);
    await host.send("\x1b[A");
    expect(selected()).toContain("agent-4");
    await host.send("\r");
    expect(host.focused()?.render(96).map(stripTerminalSequences).join("\n")).toContain("agent-4");
    await host.send("\u001b");
    await host.send("\u001b");
  });

  it("clamps the viewport when the agent count shrinks", async () => {
    const { db, host, lines, wheel } = setup(5);
    for (let i = 0; i < 3; i++) await wheel("down");
    expect(names(lines())).toEqual(["agent-2", "agent-1"]);
    for (const runId of ["r1", "r2", "r3"]) {
      db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?").run(Date.now() - 20_000, runId);
      bus.emit({ sessionId: "s", runId, ts: Date.now(), type: "status" });
    }
    await host.settle();
    expect(names(lines())).toEqual(["agent-5", "agent-4"]);
    expect(lines()).toHaveLength(2);
  });
});
