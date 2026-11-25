import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";

export type DockGeometry =
  | { kind: "ready"; width: number; safeHeight: number; frameRows: number; origin: "terminal" | "base-document" }
  | { kind: "unavailable"; reason: string };

export const GEOMETRY_WAITING = "Waiting for a measured frame";

export interface DockGeometryAdapter {
  read(): DockGeometry;
  track(component: Component): () => void;
  isTop(component: Component): boolean;
  onChange(fn: () => void): () => void;
  retire(): void;
  dispose(): void;
}

interface OverlayEntry { component: Component; hidden: boolean; options?: OverlayOptions; }
interface StackEntry {
  component: Component;
  basis?: number | "auto";
  grow?: number;
  shrink?: number;
  minSize?: number;
  maxSize?: number;
  visible?: unknown;
}
interface RuntimeStack extends Component {
  children: Component[];
  entries: StackEntry[];
  gap: number;
  align: string;
  layoutType: string;
}
interface RuntimeTui extends TUI {
  layoutRoot?: unknown;
  overlayStack: unknown;
  renderedOverlayLayouts: unknown;
}
interface Shape { children: Component[]; root?: RuntimeStack; dock?: RuntimeStack; }
type Method = (...args: unknown[]) => unknown;

const unavailable = (reason: string): DockGeometry => ({ kind: "unavailable", reason });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isComponent = (value: unknown): value is Component =>
  isRecord(value) && typeof value.render === "function" && typeof value.invalidate === "function";

function inert(reason: string): DockGeometryAdapter {
  return { read: () => unavailable(reason), track: () => () => {}, isTop: () => false, onChange: () => () => {}, retire() {}, dispose() {} };
}

function resolveReceiver(reference: TUI): RuntimeTui | undefined {
  try {
    const value: unknown = reference.valueOf();
    if (!isRecord(value)) return undefined;
    const raw = value as unknown as RuntimeTui;
    const prototype = Object.getPrototypeOf(raw);
    if (!prototype || Object.getPrototypeOf(reference) !== prototype) return undefined;
    const name = raw.mode === "fullscreen" ? "TuiAltScreen" : raw.mode === "regular" ? "TuiMainScreen" : "";
    if (!name || prototype.constructor?.name !== name) return undefined;
    if (reference.mode !== raw.mode || reference.terminal !== raw.terminal || reference.children !== raw.children) return undefined;
    if (!isRecord(raw.terminal) || !Array.isArray(raw.children) || !Array.isArray(raw.overlayStack)) return undefined;
    for (const key of ["render", "doRender", "compositeOverlays", "showOverlay", "hideOverlay", "requestRender"]) {
      if (typeof Reflect.get(raw, key) !== "function" || typeof Reflect.get(reference, key) !== "function") return undefined;
    }
    return raw;
  } catch { return undefined; }
}

function inspectChildren(raw: RuntimeTui): Component[] | undefined {
  const children = raw.children;
  if (!Array.isArray(children) || children.length !== 7 || new Set(children).size !== children.length) return undefined;
  if (!children.every(child => isComponent(child) && isRecord(child) && Array.isArray(child.children) &&
      Object.getPrototypeOf(child)?.constructor?.name === "Container")) return undefined;
  const containers = children as (Component & { children: Component[] })[];
  if (containers[0]!.children.length !== 3 || containers[4]!.children.length !== 1 || containers[6]!.children.length !== 1) return undefined;
  return [...children];
}

function stack(value: unknown): RuntimeStack | undefined {
  if (!isComponent(value) || !isRecord(value)) return undefined;
  if (!Array.isArray(value.entries) || !Array.isArray(value.children) || value.gap !== 0 || value.align !== "stretch" || value.layoutType !== "vstack") return undefined;
  if (Object.getPrototypeOf(value)?.constructor?.name !== "VStack") return undefined;
  return value as unknown as RuntimeStack;
}

function entryMatches(entry: StackEntry | undefined, expected: Omit<StackEntry, "component">): boolean {
  return !!entry && entry.basis === expected.basis && entry.grow === expected.grow &&
    entry.shrink === expected.shrink && entry.minSize === expected.minSize && entry.maxSize === undefined && entry.visible === undefined;
}

function inspectShape(raw: RuntimeTui): Shape | undefined {
  try { return inspectShapeUnchecked(raw); } catch { return undefined; }
}

function inspectShapeUnchecked(raw: RuntimeTui): Shape | undefined {
  const children = inspectChildren(raw);
  if (!children) return undefined;
  if (raw.mode === "regular") return { children };
  const root = stack(raw.layoutRoot);
  if (!root || root.entries.length !== 2 || root.children.length !== 2) return undefined;
  const transcript = root.entries[0];
  const dockEntry = root.entries[1];
  if (!entryMatches(transcript, { basis: 0, grow: 1, shrink: 1, minSize: 1 }) ||
      !entryMatches(dockEntry, { basis: "auto", grow: 0, shrink: 1, minSize: 1 })) return undefined;
  if (root.children[0] !== transcript!.component || root.children[1] !== dockEntry!.component) return undefined;
  const scroll = transcript!.component;
  if (!isRecord(scroll) || Object.getPrototypeOf(scroll)?.constructor?.name !== "ScrollView" ||
      scroll.child !== children[0] || scroll.primary !== true || scroll.followEnd !== true ||
      !Array.isArray(scroll.children) || scroll.children.length !== 1 || scroll.children[0] !== children[0]) return undefined;
  const dock = stack(dockEntry!.component);
  if (!dock || dock.entries.length !== 6 || dock.children.length !== 6) return undefined;
  for (let i = 0; i < 6; i++) {
    if (!entryMatches(dock.entries[i], { shrink: 1, minSize: i === 3 ? 3 : 0 }) ||
        dock.entries[i]!.component !== children[i + 1] || dock.children[i] !== children[i + 1]) return undefined;
  }
  return { children, root, dock };
}

function sameGeometry(left: DockGeometry, right: DockGeometry): boolean {
  if (left.kind === "unavailable" || right.kind === "unavailable") {
    return left.kind === "unavailable" && right.kind === "unavailable" && left.reason === right.reason;
  }
  return left.width === right.width && left.safeHeight === right.safeHeight && left.frameRows === right.frameRows && left.origin === right.origin;
}

/** Install only for the inspected pi version and renderer shape. */
export function installPiDockGeometry(tui: TUI, piVersion?: string): DockGeometryAdapter {
  if (piVersion === undefined) return inert("Pi host version is unavailable");
  if (piVersion !== "1.2.0") return inert(`Unsupported pi version: ${piVersion}`);
  const raw = resolveReceiver(tui);
  if (!raw) return inert("Unrecognized pi renderer");
  const shape = inspectShape(raw);
  if (!shape) return inert("Incompatible pi layout");

  const listeners = new Set<() => void>();
  const tracked = new Set<Component>();
  const restore: (() => void)[] = [];
  let disposed = false;
  let retired = false;
  const inactive = () => disposed || retired;
  let geometry: DockGeometry = unavailable(GEOMETRY_WAITING);
  let measuredColumns = -1;
  let measuredRows = -1;
  let frame = 0;
  let inFrame = false;
  let dockMeasure: { frame: number; width: number; height: number } | undefined;
  let baseMeasure: { frame: number; width: number; height: number } | undefined;
  const dockRows: ({ frame: number; width: number; height: number } | undefined)[] = Array(6).fill(undefined);
  let lastStack: { component: Component; visible: boolean; owned: boolean }[] | undefined;

  const notify = () => {
    for (const listener of [...listeners]) {
      if (inactive()) break;
      try { listener(); } catch { /* isolate listeners */ }
    }
  };
  const currentShape = () => {
    const next = inspectShape(raw);
    return !!next && next.root === shape.root && next.dock === shape.dock &&
      next.children.every((child, index) => child === shape.children[index]);
  };
  const stackEntries = (): { entry: OverlayEntry; visible: boolean }[] | undefined => {
    try {
      const value = raw.overlayStack;
      if (!Array.isArray(value)) return undefined;
      const entries: { entry: OverlayEntry; visible: boolean }[] = [];
      for (const item of value) {
        if (!isRecord(item) || !isComponent(item.component) || typeof item.hidden !== "boolean") return undefined;
        if (item.options !== undefined && !isRecord(item.options)) return undefined;
        const opts = item.options as OverlayOptions | undefined;
        if (opts?.visible !== undefined && typeof opts.visible !== "function") return undefined;
        let visible = !item.hidden;
        if (visible && opts?.visible) {
          const result = opts.visible(raw.terminal.columns, raw.terminal.rows);
          if (typeof result !== "boolean") return undefined;
          visible = result;
        }
        entries.push({ entry: item as unknown as OverlayEntry, visible });
      }
      return entries;
    } catch { return undefined; }
  };
  const ownership = (entries: { entry: OverlayEntry; visible: boolean }[] | undefined) => {
    const next = entries?.map(({ entry, visible }) => ({ component: entry.component, visible, owned: tracked.has(entry.component) }));
    const changed = !lastStack || !next || lastStack.length !== next.length || next.some((entry, i) =>
      entry.component !== lastStack![i]!.component || entry.visible !== lastStack![i]!.visible || entry.owned !== lastStack![i]!.owned);
    if (changed) { lastStack = next; notify(); }
  };
  const foreignVisible = (entries: { entry: OverlayEntry; visible: boolean }[]) =>
    entries.some(({ entry, visible }) => visible && !tracked.has(entry.component));
  const publish = (next: DockGeometry, width: number, height: number) => {
    if (inactive()) return;
    measuredColumns = width; measuredRows = height;
    if (sameGeometry(geometry, next)) return;
    geometry = next;
    notify();
    if (!inactive()) raw.requestRender();
  };
  const dimensionsMatch = (width: number, height: number) =>
    Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0 &&
    raw.terminal.columns === width && raw.terminal.rows === height;
  const regularGeometry = (width: number, height: number, lines: number): DockGeometry => {
    if (!inFrame || !currentShape() || !dimensionsMatch(width, height) || !baseMeasure ||
        baseMeasure.frame !== frame || baseMeasure.width !== width || baseMeasure.height !== lines ||
        dockRows.some(row => !row || row.frame !== frame || row.width !== width)) return unavailable("Current dock measurement is unavailable");
    const dockHeight = dockRows.reduce<number>((sum, row) => sum + row!.height, 0);
    if (dockHeight > lines) return unavailable("Incompatible dock measurement");
    const frameRows = Math.min(height, lines);
    return { kind: "ready", width, safeHeight: Math.max(0, frameRows - dockHeight), frameRows, origin: "base-document" };
  };
  const fullscreenGeometry = (width: number, height: number): DockGeometry => {
    if (!inFrame || !currentShape() || !dimensionsMatch(width, height) || !dockMeasure ||
        dockMeasure.frame !== frame || dockMeasure.width !== width) return unavailable("Current dock measurement is unavailable");
    const dockHeight = height < 2 ? height : Math.min(Math.max(1, dockMeasure.height), height - 1);
    return { kind: "ready", width, safeHeight: Math.max(0, height - dockHeight), frameRows: height, origin: "terminal" };
  };

  const replace = (target: object, key: string, wrap: (original: Method) => Method) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    const original: unknown = Reflect.get(target, key);
    if (typeof original !== "function" || (descriptor && !descriptor.configurable)) throw new Error("Cannot wrap pi method");
    const wrapper = wrap(original as Method);
    Object.defineProperty(target, key, { value: wrapper, writable: true, configurable: true, enumerable: descriptor?.enumerable ?? false });
    restore.push(() => {
      if (Reflect.get(target, key) !== wrapper) return;
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    });
  };

  try {
    replace(raw, "doRender", original => function(this: unknown, ...args: unknown[]) {
      if (inactive()) return Reflect.apply(original, this, args);
      frame++; inFrame = true;
      try { return Reflect.apply(original, this, args); } finally { inFrame = false; }
    });
    if (shape.dock) {
      replace(shape.dock, "render", original => function(this: unknown, ...args: unknown[]) {
        const result = Reflect.apply(original, this, args);
        if (!inactive() && inFrame && this === shape.dock && typeof args[0] === "number" && Array.isArray(result)) {
          dockMeasure = { frame, width: args[0], height: result.length };
        }
        return result;
      });
    } else {
      for (let i = 0; i < 6; i++) {
        const child = shape.children[i + 1]!;
        replace(child, "render", original => function(this: unknown, ...args: unknown[]) {
          const result = Reflect.apply(original, this, args);
          if (!inactive() && inFrame && this === child && typeof args[0] === "number" && Array.isArray(result)) {
            dockRows[i] = { frame, width: args[0], height: result.length };
          }
          return result;
        });
      }
      replace(raw, "render", original => function(this: unknown, ...args: unknown[]) {
        const result = Reflect.apply(original, this, args);
        if (!inactive() && inFrame && this === raw && typeof args[0] === "number" && Array.isArray(result)) {
          const width = args[0];
          baseMeasure = { frame, width, height: result.length };
          const entries = stackEntries();
          if (entries?.length === 0) publish(regularGeometry(width, raw.terminal.rows, result.length), width, raw.terminal.rows);
        }
        return result;
      });
    }
    replace(raw, "compositeOverlays", original => function(this: unknown, ...args: unknown[]) {
      if (inactive()) return Reflect.apply(original, this, args);
      const [lines, width, height] = args;
      if (!Array.isArray(lines) || typeof width !== "number" || typeof height !== "number") return Reflect.apply(original, this, args);
      const entries = stackEntries();
      ownership(entries);
      let next = entries ? (raw.mode === "fullscreen" ? fullscreenGeometry(width, height) : regularGeometry(width, height, lines.length))
        : unavailable("Incompatible overlay stack");
      if (raw.mode === "regular" && entries && foreignVisible(entries)) next = unavailable("Another overlay owns the terminal");
      publish(next, width, height);
      const agentsVisible = entries?.some(({ entry, visible }) => visible && tracked.has(entry.component)) ?? false;
      if (raw.mode === "regular" && next.kind === "ready" && agentsVisible) {
        if (next.frameRows === 0) {
          if (Array.isArray(raw.renderedOverlayLayouts)) raw.renderedOverlayLayouts = [];
          return lines;
        }
        return Reflect.apply(original, this, [lines, width, next.frameRows]);
      }
      return Reflect.apply(original, this, args);
    });
    replace(raw, "showOverlay", original => function(this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args) as OverlayHandle;
      if (inactive()) return result;
      ownership(stackEntries());
      return {
        hide: () => { result.hide(); if (!inactive()) ownership(stackEntries()); },
        setHidden: (hidden: boolean) => { result.setHidden(hidden); if (!inactive()) ownership(stackEntries()); },
        isHidden: () => result.isHidden(),
        focus: () => { result.focus(); if (!inactive()) ownership(stackEntries()); },
        unfocus: (options?: Parameters<OverlayHandle["unfocus"]>[0]) => { result.unfocus(options); if (!inactive()) ownership(stackEntries()); },
        isFocused: () => result.isFocused(),
        getBounds: () => result.getBounds(),
      } satisfies OverlayHandle;
    });
    replace(raw, "hideOverlay", original => function(this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args);
      if (!inactive()) ownership(stackEntries());
      return result;
    });
  } catch {
    disposed = true;
    for (const undo of restore.reverse()) undo();
    return inert("Cannot install pi geometry adapter");
  }

  return {
    read() {
      if (disposed) return unavailable("Geometry adapter is disposed");
      if (retired) return unavailable("Geometry adapter is retired");
      if (!currentShape()) return unavailable("Incompatible pi layout");
      const entries = stackEntries();
      if (!entries) return unavailable("Incompatible overlay stack");
      if (raw.mode === "regular" && foreignVisible(entries)) return unavailable("Another overlay owns the terminal");
      if (measuredColumns !== raw.terminal.columns || measuredRows !== raw.terminal.rows) return unavailable(GEOMETRY_WAITING);
      return geometry;
    },
    track(component) {
      if (inactive()) return () => {};
      tracked.add(component); ownership(stackEntries());
      return () => { if (tracked.delete(component) && !inactive()) ownership(stackEntries()); };
    },
    isTop(component) {
      if (disposed && !retired) return false;
      try {
        const entries = raw.overlayStack;
        const last = Array.isArray(entries) ? entries.at(-1) : undefined;
        return isRecord(last) && last.component === component;
      } catch { return false; }
    },
    onChange(fn) {
      if (inactive()) return () => {};
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    retire() {
      if (inactive()) return;
      retired = true;
      listeners.clear(); tracked.clear();
      lastStack = undefined;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear(); tracked.clear();
      for (const undo of restore.reverse()) undo();
    },
  };
}
