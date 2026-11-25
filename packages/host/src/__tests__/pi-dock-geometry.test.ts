import { describe, expect, it, vi, afterEach } from "vitest";
import { Container, TuiMainScreen, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { installPiDockGeometry } from "../agents/pi-dock-geometry";
import { agentsTuiFixture, FakeTerminal } from "./fixtures/agents-tui";

const fixtures: ReturnType<typeof agentsTuiFixture>[] = [];
function fixture(mode: "regular" | "fullscreen", opts = { columns: 120, rows: 40, documentRows: 60, dockRows: 10 }) {
  const value = agentsTuiFixture(mode, opts); fixtures.push(value); return value;
}
afterEach(() => { for (const value of fixtures.splice(0)) value.dispose(); });

const overlay: Component = { render: () => ["foreign"], invalidate() {} };
type Fixture = ReturnType<typeof agentsTuiFixture>;
type Entry = { component: Component; basis?: number | "auto"; grow?: number; shrink?: number; minSize?: number; maxSize?: number; visible?: () => boolean };
const rootShape = (f: Fixture) => f.root as unknown as { gap: number; align: string; layoutType: string; entries: Entry[]; children: Component[] };
const dockShape = (f: Fixture) => f.dock as unknown as { gap: number; align: string; layoutType: string; entries: Entry[]; children: Component[] };

describe("pi dock geometry", () => {
  it("publishes same-frame fullscreen dock growth before rendering the detail", () => {
    const fullscreen = fixture("fullscreen");
    expect(fullscreen.geometry.read()).toMatchObject({ kind: "ready", width: 120, safeHeight: 30, frameRows: 40, origin: "terminal" });
    const beforeOpen = fullscreen.markerPositions();
    expect(Object.values(beforeOpen).every(Boolean)).toBe(true);
    fullscreen.openDetail();
    expect(fullscreen.detailRows()).toHaveLength(30);
    expect(fullscreen.detailRows().every(line => visibleWidth(line) === 96)).toBe(true);
    expect(fullscreen.markerPositions()).toEqual(beforeOpen);
    const repaint = vi.spyOn(fullscreen.tui, "requestRender");
    fullscreen.growEditorBy(3);
    fullscreen.renderBaseFrame();
    expect(fullscreen.lastDetailHeight()).toBe(27);
    expect(fullscreen.observedHeights.at(-1)).toBe(27);
    expect(fullscreen.geometry.read()).toMatchObject({ kind: "ready", safeHeight: 27 });
    expect(repaint).toHaveBeenCalledTimes(1);
    fullscreen.renderBaseFrame();
    expect(repaint).toHaveBeenCalledTimes(1);
    repaint.mockRestore();
  });

  it("tracks terminal resize without covering the dock or losing transcript scroll", () => {
    const fullscreen = fixture("fullscreen");
    fullscreen.transcript.scrollBy(-5);
    fullscreen.renderBaseFrame();
    const scrollTop = fullscreen.transcript.scrollTop;
    const before = fullscreen.markerPositions();
    fullscreen.openDetail();
    expect(fullscreen.transcript.scrollTop).toBe(scrollTop);
    expect(fullscreen.markerPositions()).toEqual(before);
    fullscreen.terminal.resize(80, 35);
    fullscreen.renderBaseFrame();
    expect(fullscreen.geometry.read()).toMatchObject({ kind: "ready", width: 80, safeHeight: 25, frameRows: 35 });
    expect(fullscreen.lastDetailHeight()).toBe(25);
    expect(fullscreen.detailRows().every(line => visibleWidth(line) === 64)).toBe(true);
    fullscreen.closeDetail();
    expect(fullscreen.transcript.scrollTop).toBe(scrollTop);
  });

  it("never grows a short regular document when its detail opens or closes", () => {
    const regular = fixture("regular", { columns: 120, rows: 40, documentRows: 6, dockRows: 10 });
    expect(regular.geometry.read()).toMatchObject({ kind: "ready", width: 120, safeHeight: 6, frameRows: 16, origin: "base-document" });
    expect(regular.baseRows()).toBe(16);
    const before = regular.markerPositions();
    expect(Object.values(before).every(Boolean)).toBe(true);
    regular.openDetail();
    expect(regular.lastDetailHeight()).toBe(6);
    expect(regular.baseRows()).toBe(16);
    expect(regular.renderedRows()).toBe(16);
    expect(regular.markerPositions()).toEqual(before);
    regular.closeDetail();
    expect(regular.renderedRows()).toBe(16);
    expect(regular.markerPositions()).toEqual(before);
  });

  it("preserves regular dock positions for long, shortened and narrow documents", () => {
    const regular = fixture("regular");
    const longBefore = regular.markerPositions();
    expect(regular.geometry.read()).toMatchObject({ kind: "ready", safeHeight: 30, frameRows: 40 });
    const stateBefore = (regular.tui as import("@earendil-works/pi-tui").TuiMainScreen).captureRenderState();
    regular.openDetail();
    expect(regular.renderedRows()).toBe(70);
    expect(regular.markerPositions()).toEqual(longBefore);
    expect((regular.tui as import("@earendil-works/pi-tui").TuiMainScreen).captureRenderState().previousViewportTop)
      .toBe(stateBefore.previousViewportTop);
    regular.closeDetail();
    regular.setDocumentRows(6);
    regular.renderBaseFrame();
    const shortBefore = regular.markerPositions();
    expect(regular.geometry.read()).toMatchObject({ kind: "ready", safeHeight: 6, frameRows: 16 });
    regular.openDetail();
    expect(regular.renderedRows()).toBe(16);
    expect(regular.markerPositions()).toEqual(shortBefore);
    regular.closeDetail();
    regular.terminal.resize(20, 40);
    regular.renderBaseFrame();
    const narrowBefore = regular.markerPositions();
    regular.openDetail();
    expect(regular.detailRows().every(line => visibleWidth(line) === 20)).toBe(true);
    expect(regular.markerPositions()).toEqual(narrowBefore);
  });

  it("clamps fullscreen dock allocation at both extremes", () => {
    const fullscreen = fixture("fullscreen", { columns: 60, rows: 10, documentRows: 20, dockRows: 10 });
    fullscreen.openDetail();
    expect(fullscreen.geometry.read()).toMatchObject({ kind: "ready", safeHeight: 1 });
    fullscreen.growEditorBy(100);
    fullscreen.renderBaseFrame();
    expect(fullscreen.lastDetailHeight()).toBe(1);
    for (const child of fullscreen.children.slice(1) as Container[]) {
      for (const inner of child.children) inner.render = () => [];
    }
    fullscreen.renderBaseFrame();
    // VStack pads the editor to its three-row minimum even when its child is empty.
    expect(fullscreen.geometry.read()).toMatchObject({ kind: "ready", safeHeight: 7 });
    expect(fullscreen.lastDetailHeight()).toBe(7);
    fullscreen.geometry.dispose();
    const originalDock = fullscreen.dock.render;
    fullscreen.dock.render = () => [];
    const adapter = installPiDockGeometry(fullscreen.tui, "1.2.0");
    try {
      fullscreen.renderBaseFrame();
      expect(adapter.read()).toMatchObject({ kind: "ready", safeHeight: 9 });
      fullscreen.terminal.resize(60, 1);
      fullscreen.renderBaseFrame();
      expect(adapter.read()).toMatchObject({ kind: "ready", safeHeight: 0 });
    } finally { adapter.dispose(); fullscreen.dock.render = originalDock; }
  });

  it("clamps a regular frame when the dock is taller than the screen", () => {
    const regular = fixture("regular", { columns: 60, rows: 5, documentRows: 6, dockRows: 10 });
    expect(regular.geometry.read()).toMatchObject({ kind: "ready", safeHeight: 0, frameRows: 5 });
    regular.openDetail();
    expect(regular.lastDetailHeight()).toBe(0);
  });

  it("fails closed when the running host version was not supplied", () => {
    const fullscreen = fixture("fullscreen"); fullscreen.geometry.dispose();
    const adapter = installPiDockGeometry(fullscreen.tui);
    expect(adapter.read()).toEqual({ kind: "unavailable", reason: "Pi host version is unavailable" });
    adapter.dispose();
  });

  it("rejects unknown versions, changed roots, sizing and incompatible methods", () => {
    const fullscreen = fixture("fullscreen");
    fullscreen.geometry.dispose();
    for (const version of ["0.0.0", "1.2.1"]) {
      const incompatible = installPiDockGeometry(fullscreen.tui, version);
      expect(incompatible.read()).toEqual({ kind: "unavailable", reason: `Unsupported pi version: ${version}` });
      incompatible.dispose();
    }
    const raw = fullscreen.tui as unknown as { layoutRoot?: unknown; compositeOverlays?: unknown };
    const originalRoot = raw.layoutRoot;
    raw.layoutRoot = undefined;
    expect(installPiDockGeometry(fullscreen.tui, "1.2.0").read().kind).toBe("unavailable");
    raw.layoutRoot = originalRoot;
    const entries = (fullscreen.root as unknown as { entries: { basis?: unknown }[] }).entries;
    const basis = entries[0]!.basis; entries[0]!.basis = 1;
    expect(installPiDockGeometry(fullscreen.tui, "1.2.0").read().kind).toBe("unavailable");
    entries[0]!.basis = basis;
    raw.compositeOverlays = undefined;
    expect(installPiDockGeometry(fullscreen.tui, "1.2.0").read()).toEqual({ kind: "unavailable", reason: "Unrecognized pi renderer" });
    delete raw.compositeOverlays;
  });

  it("fails closed if a layout accessor throws", () => {
    const fullscreen = fixture("fullscreen");
    const raw = fullscreen.tui as unknown as { layoutRoot: unknown };
    const root = raw.layoutRoot;
    raw.layoutRoot = new Proxy(fullscreen.root, {
      get(target, property, receiver) {
        if (property === "entries") throw new Error("changed layout");
        return Reflect.get(target, property, receiver);
      },
    });
    try {
      expect(() => fullscreen.geometry.read()).not.toThrow();
      expect(fullscreen.geometry.read().kind).toBe("unavailable");
      fullscreen.geometry.dispose();
      let candidate: ReturnType<typeof installPiDockGeometry> | undefined;
      expect(() => { candidate = installPiDockGeometry(fullscreen.tui, "1.2.0"); }).not.toThrow();
      expect(candidate!.read().kind).toBe("unavailable");
      candidate!.dispose();
    } finally { raw.layoutRoot = root; }
  });

  it.each<[string, (f: Fixture) => void]>([
    ["non-stack root", f => {
      const root = rootShape(f);
      (f.tui as unknown as { layoutRoot: unknown }).layoutRoot = { ...root, render: f.root.render.bind(f.root), invalidate() {} };
    }],
    ["root gap", f => { rootShape(f).gap = 1; }],
    ["root alignment", f => { rootShape(f).align = "center"; }],
    ["root axis", f => { rootShape(f).layoutType = "hstack"; }],
    ["root entry count", f => { rootShape(f).entries.pop(); }],
    ["root entry count extra", f => { rootShape(f).entries.push(rootShape(f).entries[1]!); }],
    ["missing root entry", f => { (rootShape(f).entries as (Entry | undefined)[])[0] = undefined; }],
    ["root child count", f => { rootShape(f).children.pop(); }],
    ["root child count extra", f => { rootShape(f).children.push(rootShape(f).children[0]!); }],
    ["transcript basis", f => { rootShape(f).entries[0]!.basis = 1; }],
    ["transcript growth", f => { rootShape(f).entries[0]!.grow = 0; }],
    ["transcript shrink", f => { rootShape(f).entries[0]!.shrink = 0; }],
    ["transcript minimum", f => { rootShape(f).entries[0]!.minSize = 0; }],
    ["transcript maximum", f => { rootShape(f).entries[0]!.maxSize = 10; }],
    ["transcript visibility", f => { rootShape(f).entries[0]!.visible = () => true; }],
    ["dock basis", f => { rootShape(f).entries[1]!.basis = 0; }],
    ["dock growth", f => { rootShape(f).entries[1]!.grow = 1; }],
    ["dock shrink", f => { rootShape(f).entries[1]!.shrink = 0; }],
    ["dock minimum", f => { rootShape(f).entries[1]!.minSize = 0; }],
    ["root child identity", f => { rootShape(f).children[0] = rootShape(f).children[1]!; }],
    ["root dock identity", f => { rootShape(f).children[1] = rootShape(f).children[0]!; }],
    ["scroll document", f => { (f.transcript as unknown as { child: unknown }).child = f.children[1]; }],
    ["scroll primary", f => { (f.transcript as unknown as { primary: boolean }).primary = false; }],
    ["scroll following policy", f => { (f.transcript as unknown as { followEnd: boolean }).followEnd = false; }],
    ["scroll child count", f => { f.transcript.children.length = 0; }],
    ["scroll child count extra", f => { f.transcript.children.push(f.children[0]!); }],
    ["scroll child identity", f => { f.transcript.children[0] = f.children[1]!; }],
    ["dock gap", f => { dockShape(f).gap = 1; }],
    ["dock alignment", f => { dockShape(f).align = "start"; }],
    ["dock entry count", f => { dockShape(f).entries.pop(); }],
    ["dock entry count extra", f => { dockShape(f).entries.push(dockShape(f).entries[0]!); }],
    ["dock child count", f => { dockShape(f).children.pop(); }],
    ["dock child count extra", f => { dockShape(f).children.push(dockShape(f).children[0]!); }],
    ["editor minimum", f => { dockShape(f).entries[3]!.minSize = 0; }],
    ["dock child order", f => { dockShape(f).children[0] = f.children[2]!; }],
    ["dock entry order", f => { dockShape(f).entries[0]!.component = f.children[2]!; }],
    ["document shape", f => { (f.children[0] as Container).children.pop(); }],
    ["non-array dock children", f => { (f.children[1] as unknown as { children?: unknown }).children = undefined; }],
    ["container without invalidate", f => { (f.children[1] as unknown as { invalidate?: unknown }).invalidate = undefined; }],
    ["editor container", f => { (f.children[4] as Container).children.pop(); }],
    ["footer container", f => { (f.children[6] as Container).children.pop(); }],
    ["repeated components", f => { f.tui.children[1] = f.tui.children[2]!; }],
    ["non-container dock child", f => {
      const fake = { children: [], render: () => [], invalidate() {} };
      f.tui.children[1] = fake; dockShape(f).children[0] = fake; dockShape(f).entries[0]!.component = fake;
    }],
    ["non-scroll transcript", f => {
      const fake = { child: f.children[0], children: [f.children[0]], primary: true, followEnd: true, render: () => [], invalidate() {} };
      rootShape(f).children[0] = fake; rootShape(f).entries[0]!.component = fake;
    }],
  ])("rejects incompatible fullscreen layout: %s", (_name, alter) => {
    const fullscreen = fixture("fullscreen");
    fullscreen.geometry.dispose();
    alter(fullscreen);
    let candidate: ReturnType<typeof installPiDockGeometry> | undefined;
    expect(() => { candidate = installPiDockGeometry(fullscreen.tui, "1.2.0"); }).not.toThrow();
    expect(candidate!.read()).toEqual({ kind: "unavailable", reason: "Incompatible pi layout" });
    candidate!.dispose();
  });

  it("does not reuse a prior frame when dock measurement is missing", () => {
    const fullscreen = fixture("fullscreen");
    fullscreen.openDetail();
    expect(fullscreen.lastDetailHeight()).toBe(30);
    const original = fullscreen.dock.render;
    fullscreen.dock.render = () => [];
    fullscreen.renderBaseFrame();
    expect(fullscreen.geometry.read().kind).toBe("unavailable");
    expect(fullscreen.lastDetailHeight()).toBe(0);
    fullscreen.dock.render = original;
    fullscreen.renderBaseFrame();
    expect(fullscreen.geometry.read()).toMatchObject({ kind: "ready", safeHeight: 30 });
  });

  it("does not reuse a regular dock row from an earlier frame", () => {
    const regular = fixture("regular", { columns: 120, rows: 40, documentRows: 6, dockRows: 10 });
    regular.openDetail();
    const child = regular.children[1]!;
    const original = child.render;
    child.render = () => ["[pending]"];
    regular.renderBaseFrame();
    expect(regular.geometry.read().kind).toBe("unavailable");
    expect(regular.lastDetailHeight()).toBe(0);
    child.render = original;
    regular.renderBaseFrame();
    expect(regular.geometry.read()).toMatchObject({ kind: "ready", safeHeight: 6 });
  });

  it("rejects geometry measured for different terminal dimensions", () => {
    const fullscreen = fixture("fullscreen");
    fullscreen.openDetail();
    const original = fullscreen.dock.render;
    fullscreen.dock.render = function(this: typeof fullscreen.dock, width) {
      const lines = original.call(this, width);
      fullscreen.terminal.columns = width - 1;
      return lines;
    };
    try {
      fullscreen.renderBaseFrame();
      expect(fullscreen.lastDetailHeight()).toBe(0);
    } finally {
      fullscreen.terminal.columns = 120;
      fullscreen.dock.render = original;
    }
    expect(fullscreen.geometry.read().kind).toBe("unavailable");
  });

  it.each(["fullscreen", "regular"] as const)("rejects composition outside a %s render frame", mode => {
    const value = fixture(mode);
    value.openDetail();
    const compose = (value.tui as unknown as { compositeOverlays: (lines: string[], width: number, height: number) => string[] }).compositeOverlays;
    compose.call(value.tui, Array(value.baseRows()).fill("document"), 120, 40);
    expect(value.lastDetailHeight()).toBe(0);
    expect(value.geometry.read().kind).toBe("unavailable");
    value.renderBaseFrame();
    expect(value.geometry.read().kind).toBe("ready");
  });

  it("rejects a fullscreen dock measurement at a different width", () => {
    const fullscreen = fixture("fullscreen"); fullscreen.openDetail();
    const raw = fullscreen.tui as unknown as { compositeOverlays: (lines: string[], width: number, height: number) => string[] };
    const owned = raw.compositeOverlays;
    raw.compositeOverlays = function(this: unknown, lines, width, height) {
      fullscreen.terminal.columns = width - 1;
      try { return owned.call(this, lines, width - 1, height); }
      finally { fullscreen.terminal.columns = width; }
    };
    try { fullscreen.renderBaseFrame(); expect(fullscreen.lastDetailHeight()).toBe(0); }
    finally { raw.compositeOverlays = owned; }
  });

  it("rejects a regular dock row measured at a different width", () => {
    const regular = fixture("regular"); regular.geometry.dispose();
    const original = regular.tui.render;
    regular.tui.render = function(this: TUI, width) {
      return this.children.flatMap((child, index) => child.render(index === 1 ? width - 1 : width));
    };
    const adapter = installPiDockGeometry(regular.tui, "1.2.0");
    try {
      regular.renderBaseFrame();
      expect(adapter.read()).toEqual({ kind: "unavailable", reason: "Current dock measurement is unavailable" });
    } finally { adapter.dispose(); regular.tui.render = original; }
  });

  it("rejects a regular base frame measured in a prior render", () => {
    const regular = fixture("regular"); regular.geometry.dispose();
    const original = regular.tui.render;
    const adapter = installPiDockGeometry(regular.tui, "1.2.0");
    regular.renderBaseFrame();
    expect(adapter.read().kind).toBe("ready");
    const owned = regular.tui.render;
    regular.tui.render = original;
    const observed: string[] = [];
    const detail: Component = { render: () => { observed.push(adapter.read().kind); return []; }, invalidate() {} };
    const untrack = adapter.track(detail);
    regular.tui.showOverlay(detail);
    try { regular.renderBaseFrame(); expect(observed.at(-1)).toBe("unavailable"); }
    finally { regular.tui.render = owned; untrack(); adapter.dispose(); }
  });

  it("rejects a regular base frame with a changed line count", () => {
    const regular = fixture("regular"); regular.openDetail();
    const raw = regular.tui as unknown as { compositeOverlays: (lines: string[], width: number, height: number) => string[] };
    const owned = raw.compositeOverlays;
    raw.compositeOverlays = function(this: unknown, lines, width, height) {
      return owned.call(this, lines.slice(1), width, height);
    };
    try { regular.renderBaseFrame(); expect(regular.lastDetailHeight()).toBe(0); }
    finally { raw.compositeOverlays = owned; }
  });

  it("rejects dock rows exceeding the regular base frame", () => {
    const regular = fixture("regular"); regular.geometry.dispose();
    const original = regular.tui.render;
    regular.tui.render = function(this: TUI, width) {
      this.children[0]!.render(width);
      const dock = this.children.slice(1).flatMap(child => child.render(width));
      return dock.slice(1);
    };
    const adapter = installPiDockGeometry(regular.tui, "1.2.0");
    try {
      regular.renderBaseFrame();
      expect(adapter.read()).toEqual({ kind: "unavailable", reason: "Incompatible dock measurement" });
    } finally { adapter.dispose(); regular.tui.render = original; }
  });

  it("rejects a regular base frame measured at a different width", () => {
    const regular = fixture("regular"); regular.geometry.dispose();
    const original = regular.tui.render;
    regular.tui.render = function(this: TUI, width) { return this.children.flatMap(child => child.render(width - 1)); };
    const adapter = installPiDockGeometry(regular.tui, "1.2.0");
    const observed: string[] = [];
    const detail: Component = { render: () => { observed.push(adapter.read().kind); return []; }, invalidate() {} };
    const untrack = adapter.track(detail);
    regular.tui.showOverlay(detail);
    const raw = regular.tui as unknown as { compositeOverlays: (lines: string[], width: number, height: number) => string[] };
    const owned = raw.compositeOverlays;
    raw.compositeOverlays = function(this: unknown, lines, width, height) {
      regular.terminal.columns = width - 1;
      try { return owned.call(this, lines, width - 1, height); }
      finally { regular.terminal.columns = width; }
    };
    try { regular.renderBaseFrame(); expect(observed.at(-1)).toBe("unavailable"); }
    finally { raw.compositeOverlays = owned; untrack(); adapter.dispose(); regular.tui.render = original; }
  });

  it("fails closed if an overlay stack accessor throws", () => {
    const fullscreen = fixture("fullscreen"); fullscreen.openDetail();
    const entry = (fullscreen.tui as unknown as { overlayStack: object[] }).overlayStack[0]!;
    const descriptor = Object.getOwnPropertyDescriptor(entry, "hidden")!;
    Object.defineProperty(entry, "hidden", { configurable: true, get() { throw new Error("changed stack"); } });
    try {
      expect(() => fullscreen.geometry.read()).not.toThrow();
      expect(fullscreen.geometry.read().kind).toBe("unavailable");
    } finally { Object.defineProperty(entry, "hidden", descriptor); }
  });

  it.each<[string, (entry: Record<string, unknown>) => void]>([
    ["hidden flag", (entry: Record<string, unknown>) => { entry.hidden = undefined; }],
    ["options", (entry: Record<string, unknown>) => { entry.options = null; }],
    ["visibility callback", (entry: Record<string, unknown>) => { entry.options = { visible: 0 }; }],
    ["visibility result", (entry: Record<string, unknown>) => { entry.options = { visible: () => 1 }; }],
    ["throwing visibility", (entry: Record<string, unknown>) => { entry.options = { visible: () => { throw new Error("bad visibility"); } }; }],
  ])("rejects malformed overlay %s", (_name, alter) => {
    const fullscreen = fixture("fullscreen"); fullscreen.openDetail();
    const entries = (fullscreen.tui as unknown as { overlayStack: Record<string, unknown>[] }).overlayStack;
    const entry = entries[0]!;
    const hidden = entry.hidden, options = entry.options;
    try { alter(entry); expect(fullscreen.geometry.read().kind).toBe("unavailable"); }
    finally { entry.hidden = hidden; entry.options = options; }
  });

  it("bounds zero-height regular frames without composing percentage overlays", () => {
    const terminal = new FakeTerminal(40, 20);
    const tui = new TuiMainScreen(terminal);
    const empty = (): Component => ({ render: () => [], invalidate() {} });
    const document = new Container();
    document.addChild(empty()); document.addChild(empty()); document.addChild(empty());
    tui.addChild(document);
    for (let i = 0; i < 6; i++) { const child = new Container(); child.addChild(empty()); tui.addChild(child); }
    const adapter = installPiDockGeometry(tui, "1.2.0");
    const render = vi.fn(() => []);
    const detail: Component = { render, invalidate() {} };
    try {
      tui.start(); tui.renderNow();
      expect(adapter.read()).toMatchObject({ kind: "ready", safeHeight: 0, frameRows: 0 });
      const untrack = adapter.track(detail);
      tui.showOverlay(detail, { width: "80%", maxHeight: "100%" });
      tui.renderNow();
      expect(render).not.toHaveBeenCalled();
      expect((tui as unknown as { previousLines: string[] }).previousLines).toHaveLength(0);
      untrack();
    } finally { adapter.dispose(); tui.stop(); }
  });

  it("rejects a forwarding reference with a different terminal", () => {
    const fullscreen = fixture("fullscreen"); fullscreen.geometry.dispose();
    const reference = new Proxy({} as TUI, {
      get(_target, property) {
        if (property === "valueOf") return () => fullscreen.tui;
        if (property === "terminal") return new FakeTerminal(120, 40);
        const value = Reflect.get(fullscreen.tui, property, fullscreen.tui);
        return typeof value === "function" ? value.bind(fullscreen.tui) : value;
      },
      getPrototypeOf() { return Reflect.getPrototypeOf(fullscreen.tui); },
    });
    expect(installPiDockGeometry(reference, "1.2.0").read()).toEqual({ kind: "unavailable", reason: "Unrecognized pi renderer" });
  });

  it.each(["terminal", "children", "overlayStack"] as const)("rejects a renderer with an invalid %s", field => {
    const fullscreen = fixture("fullscreen"); fullscreen.geometry.dispose();
    const raw = fullscreen.tui as unknown as Record<string, unknown>;
    const original = raw[field]; raw[field] = null;
    let candidate: ReturnType<typeof installPiDockGeometry> | undefined;
    try {
      let result: ReturnType<ReturnType<typeof installPiDockGeometry>["read"]> | undefined;
      expect(() => { candidate = installPiDockGeometry(fullscreen.tui, "1.2.0"); result = candidate.read(); }).not.toThrow();
      expect(result).toEqual({ kind: "unavailable", reason: "Unrecognized pi renderer" });
    } finally { candidate?.dispose(); raw[field] = original; }
  });

  it("rejects an unrecognized renderer prototype even when its methods match", () => {
    const fullscreen = fixture("fullscreen"); fullscreen.geometry.dispose();
    const original = Object.getPrototypeOf(fullscreen.tui);
    const prototype = Object.create(original);
    Object.defineProperty(prototype, "constructor", { value: class DifferentRenderer {} });
    Object.setPrototypeOf(fullscreen.tui, prototype);
    try {
      expect(installPiDockGeometry(fullscreen.tui, "1.2.0").read()).toEqual({ kind: "unavailable", reason: "Unrecognized pi renderer" });
    } finally { Object.setPrototypeOf(fullscreen.tui, original); }
  });

  it.each(["prototype", "mode", "children", "method"] as const)("rejects a forwarding reference with a different %s", field => {
    const fullscreen = fixture("fullscreen"); fullscreen.geometry.dispose();
    const reference = new Proxy({} as TUI, {
      get(_target, property) {
        if (property === "valueOf") return () => fullscreen.tui;
        if (field === "mode" && property === "mode") return "regular";
        if (field === "children" && property === "children") return [];
        if (field === "method" && property === "doRender") return undefined;
        const value = Reflect.get(fullscreen.tui, property, fullscreen.tui);
        return typeof value === "function" ? value.bind(fullscreen.tui) : value;
      },
      getPrototypeOf() { return field === "prototype" ? Object.prototype : Reflect.getPrototypeOf(fullscreen.tui); },
    });
    expect(installPiDockGeometry(reference, "1.2.0").read()).toEqual({ kind: "unavailable", reason: "Unrecognized pi renderer" });
  });

  it("rejects remounted or reordered regular components", () => {
    const regular = fixture("regular", { columns: 120, rows: 40, documentRows: 6, dockRows: 10 });
    const children = [...regular.tui.children];
    regular.tui.children.splice(3, 1);
    expect(() => regular.geometry.read()).not.toThrow();
    expect(regular.geometry.read().kind).toBe("unavailable");
    regular.tui.children.splice(0, regular.tui.children.length, ...children);
    [regular.tui.children[1], regular.tui.children[2]] = [regular.tui.children[2]!, regular.tui.children[1]!];
    expect(regular.geometry.read().kind).toBe("unavailable");
    regular.tui.children.splice(0, regular.tui.children.length, ...children);
  });

  it("rejects duplicate regular children before installing wrappers", () => {
    const regular = fixture("regular"); regular.geometry.dispose();
    regular.tui.children[1] = regular.tui.children[2]!;
    const adapter = installPiDockGeometry(regular.tui, "1.2.0");
    expect(adapter.read()).toEqual({ kind: "unavailable", reason: "Incompatible pi layout" });
    adapter.dispose();
  });

  it("does not shorten composition for an unrelated visible overlay", () => {
    const regular = fixture("regular", { columns: 120, rows: 40, documentRows: 6, dockRows: 10 });
    regular.openDetail();
    expect(regular.renderedRows()).toBe(16);
    const other = regular.tui.showOverlay(overlay, { anchor: "bottom-center", width: 20 });
    regular.renderBaseFrame();
    expect(regular.geometry.read()).toMatchObject({ kind: "unavailable" });
    expect(regular.renderedRows()).toBe(40);
    other.hide();
    regular.renderBaseFrame();
    expect(regular.geometry.read()).toMatchObject({ kind: "ready", safeHeight: 6 });
    expect(regular.renderedRows()).toBe(16);
  });

  it("leaves pi composition unchanged when no agents overlay is visible", () => {
    const regular = fixture("regular", { columns: 120, rows: 40, documentRows: 6, dockRows: 10 });
    const other = regular.tui.showOverlay(overlay, { visible: () => false });
    regular.renderBaseFrame();
    expect(regular.geometry.read()).toMatchObject({ kind: "ready", safeHeight: 6 });
    expect(regular.renderedRows()).toBe(40);
    other.hide();
  });

  it("ignores a hidden unrelated overlay for regular composition", () => {
    const regular = fixture("regular", { columns: 120, rows: 40, documentRows: 6, dockRows: 10 });
    regular.openDetail();
    const other = regular.tui.showOverlay(overlay, { visible: () => false });
    regular.renderBaseFrame();
    expect(regular.geometry.read()).toMatchObject({ kind: "ready", safeHeight: 6 });
    expect(regular.geometry.isTop(regular.detail)).toBe(false);
    expect(regular.renderedRows()).toBe(16);
    other.hide();
  });

  it("ignores an explicitly hidden unrelated overlay", () => {
    const regular = fixture("regular", { columns: 120, rows: 40, documentRows: 6, dockRows: 10 });
    regular.openDetail();
    const other = regular.tui.showOverlay(overlay);
    other.setHidden(true);
    regular.renderBaseFrame();
    expect(regular.geometry.read()).toMatchObject({ kind: "ready", safeHeight: 6 });
    expect(regular.renderedRows()).toBe(16);
    other.hide();
  });

  it("notifies when tracking an existing stack entry changes ownership", () => {
    const fullscreen = fixture("fullscreen");
    const other = fullscreen.tui.showOverlay(overlay);
    const changed = vi.fn();
    const off = fullscreen.geometry.onChange(changed);
    const untrack = fullscreen.geometry.track(overlay);
    expect(changed).toHaveBeenCalledTimes(1);
    changed.mockClear();
    untrack();
    expect(changed).toHaveBeenCalledTimes(1);
    off(); other.hide();
  });

  it("tracks the actual last stack entry and notifies when ownership changes", () => {
    const fullscreen = fixture("fullscreen");
    const changed = vi.fn();
    const off = fullscreen.geometry.onChange(changed);
    fullscreen.openDetail();
    expect(fullscreen.geometry.isTop(fullscreen.detail)).toBe(true);
    changed.mockClear();
    const other = fullscreen.tui.showOverlay(overlay, { visible: () => false });
    expect(fullscreen.geometry.isTop(fullscreen.detail)).toBe(false);
    expect(fullscreen.geometry.isTop(overlay)).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    changed.mockClear();
    other.hide();
    expect(fullscreen.geometry.isTop(fullscreen.detail)).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    off();
    changed.mockClear();
    fullscreen.closeDetail();
    expect(changed).not.toHaveBeenCalled();
  });

  it("checks the raw stack top even when a foreign visibility callback throws", () => {
    const fullscreen = fixture("fullscreen");
    const foreign = fullscreen.tui.showOverlay(overlay, { nonCapturing: true, visible: () => false });
    const top: Component = { render: () => [], invalidate() {} };
    const topHandle = fullscreen.tui.showOverlay(top);
    const entries = (fullscreen.tui as unknown as { overlayStack: { component: Component; options: { visible: () => boolean } }[] }).overlayStack;
    const entry = entries.find(item => item.component === overlay)!;
    const visible = entry.options.visible;
    let calls = 0;
    entry.options.visible = () => { calls++; throw new Error("foreign visibility failed"); };
    try {
      expect(fullscreen.geometry.isTop(top)).toBe(true);
      expect(fullscreen.geometry.isTop(overlay)).toBe(false);
      expect(calls).toBe(0);
    } finally { entry.options.visible = visible; topHandle.hide(); foreign.hide(); }
  });

  it("retires geometry work but retains raw top checks until disposal", () => {
    const fullscreen = fixture("fullscreen");
    fullscreen.openDetail();
    const changed = vi.fn();
    fullscreen.geometry.onChange(changed);
    expect(fullscreen.geometry.retire).toBeTypeOf("function");
    fullscreen.geometry.retire();
    expect(fullscreen.geometry.read()).toEqual({ kind: "unavailable", reason: "Geometry adapter is retired" });
    expect(fullscreen.geometry.isTop(fullscreen.detail)).toBe(true);
    const request = vi.spyOn(fullscreen.tui, "requestRender");
    fullscreen.growEditorBy(3);
    fullscreen.renderBaseFrame();
    expect(changed).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(fullscreen.geometry.isTop(fullscreen.detail)).toBe(true);
    fullscreen.geometry.dispose();
    expect(Object.getOwnPropertyDescriptor(fullscreen.tui, "doRender")).toEqual(fullscreen.original.doRender);
    expect(Object.getOwnPropertyDescriptor(fullscreen.dock, "render")).toEqual(fullscreen.original.dockRender);
    request.mockRestore();
  });

  it("restores only owned wrappers and makes retained wrappers inert", () => {
    const fullscreen = fixture("fullscreen");
    const raw = fullscreen.tui as unknown as { compositeOverlays: (lines: string[], width: number, height: number) => string[] };
    const owned = raw.compositeOverlays;
    const later = function(this: unknown, lines: string[], width: number, height: number) {
      return owned.call(this, lines, width, height);
    };
    raw.compositeOverlays = later;
    fullscreen.geometry.dispose(); fullscreen.geometry.dispose();
    expect(raw.compositeOverlays).toBe(later);
    expect(Object.getOwnPropertyDescriptor(fullscreen.tui, "doRender")).toEqual(fullscreen.original.doRender);
    expect(Object.getOwnPropertyDescriptor(fullscreen.dock, "render")).toEqual(fullscreen.original.dockRender);
    expect(later.call(fullscreen.tui, ["base"], 120, 40)).toEqual(["base"]);
  });

  it("accepts a forwarding reference and rebinds after a mode switch", () => {
    const first = fixture("fullscreen"); first.geometry.dispose();
    const second = fixture("regular"); second.geometry.dispose();
    let current = first.tui;
    const reference = new Proxy({} as TUI, {
      get(_target, property) {
        const receiver = current;
        const value = Reflect.get(receiver, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const actual = current;
          return Reflect.apply(Reflect.get(actual, property, actual), actual, args);
        };
      },
      set(_target, property, value) { return Reflect.set(current, property, value, current); },
      has(_target, property) { return Reflect.has(current, property); },
      getPrototypeOf() { return Reflect.getPrototypeOf(current); },
    });
    const fullscreen = installPiDockGeometry(reference, "1.2.0");
    first.renderBaseFrame();
    expect(fullscreen.read()).toMatchObject({ kind: "ready", safeHeight: 30 });
    expect(Object.getOwnPropertyDescriptor(first.tui, "compositeOverlays")).toBeDefined();
    fullscreen.dispose();
    expect(Object.getOwnPropertyDescriptor(first.tui, "compositeOverlays")).toEqual(first.original.composite);
    current = second.tui;
    const regular = installPiDockGeometry(reference, "1.2.0");
    const tracked = regular.track(overlay);
    second.tui.showOverlay(overlay, { width: 1, maxHeight: 1 });
    second.renderBaseFrame();
    expect(regular.read()).toMatchObject({ kind: "ready", origin: "base-document" });
    tracked(); regular.dispose();
    expect(Object.getOwnPropertyDescriptor(second.tui, "render")).toEqual(second.original.render);
  });
});
