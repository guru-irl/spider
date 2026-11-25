import {
  Container, ScrollView, TuiAltScreen, TuiMainScreen, VStack, visibleWidth,
  type Component, type OverlayHandle, type Terminal, type TUI,
} from "@earendil-works/pi-tui";
import { installPiDockGeometry, type DockGeometryAdapter } from "../../agents/pi-dock-geometry";

/** A cell screen for the cursor, erase and scroll sequences emitted by pi. */
export class FakeTerminal implements Terminal {
  columns: number;
  rows: number;
  readonly kittyProtocolActive = false;
  readonly writes: string[] = [];
  private cells: string[][];
  private row = 0;
  private col = 0;
  private input?: (data: string) => void;
  private resized?: () => void;
  private readonly graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  constructor(columns: number, rows: number) {
    this.columns = columns; this.rows = rows;
    this.cells = this.blankScreen();
  }
  private blankScreen(): string[][] { return Array.from({ length: this.rows }, () => Array(this.columns).fill(" ")); }
  start(onInput: (data: string) => void, onResize: () => void): void { this.input = onInput; this.resized = onResize; }
  stop(): void { this.input = undefined; this.resized = undefined; }
  async drainInput(): Promise<void> {}
  send(data: string): void { this.input?.(data); }
  resize(columns: number, rows: number): void {
    const old = this.cells;
    this.columns = columns; this.rows = rows; this.cells = this.blankScreen();
    for (let y = 0; y < Math.min(rows, old.length); y++) {
      for (let x = 0; x < Math.min(columns, old[y]!.length); x++) this.cells[y]![x] = old[y]![x]!;
    }
    this.row = Math.max(0, Math.min(this.row, rows - 1));
    this.col = Math.max(0, Math.min(this.col, columns - 1));
    this.resized?.();
  }
  screen(): string[] { return this.cells.map(row => row.join("")); }
  private newline(): void {
    this.row++;
    if (this.row >= this.rows) { this.cells.shift(); this.cells.push(Array(this.columns).fill(" ")); this.row = this.rows - 1; }
  }
  private applyCsi(params: string, command: string): void {
    const nums = params.replace(/^[?<>=]/, "").split(";").map(value => value ? Number(value) : 0);
    const first = nums[0] || 1;
    if (command === "H" || command === "f") {
      this.row = Math.max(0, Math.min(this.rows - 1, (nums[0] || 1) - 1));
      this.col = Math.max(0, Math.min(this.columns - 1, (nums[1] || 1) - 1));
    } else if (command === "A") this.row = Math.max(0, this.row - first);
    else if (command === "B") this.row = Math.min(this.rows - 1, this.row + first);
    else if (command === "C") this.col = Math.min(this.columns - 1, this.col + first);
    else if (command === "D") this.col = Math.max(0, this.col - first);
    else if (command === "G") this.col = Math.max(0, Math.min(this.columns - 1, first - 1));
    else if (command === "J" && (nums[0] === 2 || nums[0] === 3)) this.cells = this.blankScreen();
    else if (command === "K") {
      const from = nums[0] === 2 ? 0 : this.col;
      const to = nums[0] === 1 ? this.col + 1 : this.columns;
      for (let x = from; x < to; x++) this.cells[this.row]![x] = " ";
    } else if (command === "S") {
      for (let i = 0; i < first; i++) { this.cells.shift(); this.cells.push(Array(this.columns).fill(" ")); }
    }
  }
  write(data: string): void {
    this.writes.push(data);
    for (let i = 0; i < data.length;) {
      if (data[i] === "\x1b" && data[i + 1] === "[") {
        const match = /^\x1b\[([0-9;?<>=:]*)(?:[ -/]*)?([@-~])/.exec(data.slice(i));
        if (match) { this.applyCsi(match[1]!, match[2]!); i += match[0].length; continue; }
      }
      if (data[i] === "\x1b" && (data[i + 1] === "]" || data[i + 1] === "_")) {
        let end = i + 2;
        while (end < data.length && data[end] !== "\x07" && !(data[end] === "\x1b" && data[end + 1] === "\\")) end++;
        i = Math.min(data.length, end + (data[end] === "\x07" ? 1 : 2));
        continue;
      }
      if (data[i] === "\x1b") { i += 2; continue; }
      if (data[i] === "\r") { this.col = 0; i++; continue; }
      if (data[i] === "\n") { this.newline(); i++; continue; }
      let end = i;
      while (end < data.length && data[end] !== "\x1b" && data[end] !== "\r" && data[end] !== "\n") end++;
      for (const { segment } of this.graphemes.segment(data.slice(i, end))) {
        const width = visibleWidth(segment);
        if (width <= 0) continue;
        if (this.col >= this.columns) break;
        this.cells[this.row]![this.col] = segment;
        for (let extra = 1; extra < width && this.col + extra < this.columns; extra++) this.cells[this.row]![this.col + extra] = "";
        this.col += width;
      }
      i = end;
    }
  }
  moveBy(lines: number): void { this.row = Math.max(0, Math.min(this.rows - 1, this.row + lines)); }
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void { this.applyCsi("2", "K"); }
  clearFromCursor(): void { this.applyCsi("0", "K"); }
  clearScreen(): void { this.cells = this.blankScreen(); }
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(_status: unknown): void {}
}

const component = (rows: () => string[]): Component => ({ render: () => rows(), invalidate() {} });
const container = (child: Component): Container => { const result = new Container(); result.addChild(child); return result; };
const markers = ["[pending]", "[status]", "[above]", "[editor]", "[below]", "[footer]"] as const;

export interface FixtureEditor extends Component {
  focused: boolean;
  cursor: number;
  getText(): string;
  setText(text: string): void;
  handleInput(data: string): void;
}

export interface AgentsTuiFixture {
  tui: TUI;
  editor: FixtureEditor;
  terminal: FakeTerminal;
  geometry: DockGeometryAdapter;
  root: VStack;
  dock: VStack;
  transcript: ScrollView;
  children: Container[];
  detail: Component;
  original: { render?: PropertyDescriptor; composite?: PropertyDescriptor; doRender?: PropertyDescriptor; dockRender?: PropertyDescriptor };
  observedHeights: number[];
  openDetail(): void;
  closeDetail(): void;
  detailRows(): string[];
  markerPositions(): Record<string, { row: number; col: number } | undefined>;
  growEditorBy(rows: number): void;
  setDocumentRows(rows: number): void;
  baseRows(): number;
  renderedRows(): number;
  renderBaseFrame(): void;
  lastDetailHeight(): number | undefined;
  dispose(): void;
}

export function agentsTuiFixture(
  mode: "regular" | "fullscreen",
  opts: { columns: number; rows: number; documentRows: number; dockRows: number },
): AgentsTuiFixture {
  if (opts.dockRows < 8) throw new Error("fixture dock needs at least eight rows");
  const terminal = new FakeTerminal(opts.columns, opts.rows);
  let documentRows = opts.documentRows;
  let editorRows = opts.dockRows - 5;
  const document = new Container();
  document.addChild(component(() => []));
  document.addChild(component(() => []));
  document.addChild(component(() => Array.from({ length: documentRows }, (_, i) => `document-${i}`)));
  const pending = container(component(() => ["[pending]"]));
  const status = container(component(() => ["[status]"]));
  const above = container(component(() => ["[above]"]));
  let editorText = "draft text";
  const editorInput: FixtureEditor = {
    focused: false,
    cursor: 3,
    getText: () => editorText,
    setText(text) { editorText = text; this.cursor = Math.min(this.cursor, text.length); },
    handleInput(data) { editorText += data; this.cursor = editorText.length; },
    render: () => Array.from({ length: editorRows }, (_, i) => i === 0 ? "[editor]" : `editor-${i}`),
    invalidate() {},
  };
  const editor = container(editorInput);
  const below = container(component(() => ["[below]"]));
  const footer = container(component(() => ["[footer]"]));
  const children = [document, pending, status, above, editor, below, footer];
  const dock = new VStack([
    { component: pending, shrink: 1, minSize: 0 },
    { component: status, shrink: 1, minSize: 0 },
    { component: above, shrink: 1, minSize: 0 },
    { component: editor, shrink: 1, minSize: 3 },
    { component: below, shrink: 1, minSize: 0 },
    { component: footer, shrink: 1, minSize: 0 },
  ]);
  const transcript = new ScrollView(document, { follow: "end", primary: true, scrollbar: "hidden" });
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  const tui: TUI = mode === "fullscreen" ? new TuiAltScreen(terminal, false, undefined, { mouse: false, wheelScrollLines: 3 }) : new TuiMainScreen(terminal);
  for (const child of children) tui.addChild(child);
  if (tui instanceof TuiAltScreen) tui.setLayoutRoot(root);
  const original = {
    render: Object.getOwnPropertyDescriptor(tui, "render"),
    composite: Object.getOwnPropertyDescriptor(tui, "compositeOverlays"),
    doRender: Object.getOwnPropertyDescriptor(tui, "doRender"),
    dockRender: Object.getOwnPropertyDescriptor(dock, "render"),
  };
  const geometry = installPiDockGeometry(tui, "1.2.0");
  let detailRows: string[] = [];
  const observedHeights: number[] = [];
  const detail: Component = {
    render(width) {
      const reading = geometry.read();
      const height = reading.kind === "ready" ? reading.safeHeight : 0;
      observedHeights.push(height);
      detailRows = Array.from({ length: height }, (_, i) => (`DETAIL-${i}`).padEnd(width, "·"));
      return detailRows;
    },
    invalidate() {},
  };
  let handle: OverlayHandle | undefined;
  let untrack: (() => void) | undefined;
  tui.start();
  tui.renderNow();
  return {
    tui, editor: editorInput, terminal, geometry, root, dock, transcript, children, detail, original, observedHeights,
    openDetail() {
      untrack = geometry.track(detail);
      handle = tui.showOverlay(detail, { anchor: "top-center", width: "80%", minWidth: 24, maxHeight: "100%" });
      tui.renderNow();
    },
    closeDetail() {
      handle?.hide(); handle = undefined; untrack?.(); untrack = undefined;
      tui.renderNow();
    },
    detailRows: () => [...detailRows],
    markerPositions() {
      const screen = terminal.screen();
      return Object.fromEntries(markers.map(marker => {
        const row = screen.findIndex(line => line.includes(marker));
        return [marker, row < 0 ? undefined : { row, col: screen[row]!.indexOf(marker) }];
      }));
    },
    growEditorBy(rows: number) { editorRows += rows; },
    setDocumentRows(rows: number) { documentRows = rows; },
    baseRows: () => children.reduce((sum, child) => sum + child.render(terminal.columns).length, 0),
    renderedRows: () => mode === "regular"
      ? (tui as unknown as { previousLines: string[] }).previousLines.length
      : (tui as TuiAltScreen).getScreenLines().length,
    renderBaseFrame() { tui.renderNow(); },
    lastDetailHeight: () => observedHeights.at(-1),
    dispose() { untrack?.(); geometry.dispose(); tui.stop({ preserveScreen: true }); },
  };
}
