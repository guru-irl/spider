import type { CustomEditor, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { BAND_GLYPHS, icon } from "@spider/ui";
import { foregroundFromBackground, reopenBackground } from "./ansi.js";

type Edge = { original: string; hidden: number };
const INSET = 2;
const HISTORY_KEY = Symbol.for("spider.inputBand.history");
const processState = globalThis as typeof globalThis & { [HISTORY_KEY]?: string[] };
const history = processState[HISTORY_KEY] ??= []; // Oldest first, as when Pi replays a session.

// The shim supplies the running Pi's class, not the native bundle's other copy.
export function createBandEditor(Base: typeof CustomEditor): new (
  tui: TUI, theme: EditorTheme, keys: KeybindingsManager, readTheme: () => Theme,
) => CustomEditor {
  return class BandEditor extends Base {
    private edges?: { top?: Edge; bottom?: Edge };
    private renderWidth = 0;
    private inset = 0;

    constructor(tui: TUI, theme: EditorTheme, keys: KeybindingsManager, private readTheme: () => Theme) {
      super(tui, theme, keys, { paddingX: 0 });
      for (const prompt of history) super.addToHistory(prompt);
    }

    override addToHistory(text: string): void {
      super.addToHistory(text);
      const prompt = text.trim();
      if (!prompt || prompt === history.at(-1)) return;
      history.push(prompt);
      if (history.length > 100) history.shift();
    }

    // Pi may set its symmetric editor padding at any time. The band has a fixed left inset.
    override setPaddingX(_padding: number): void {}

    protected override renderTopBorder(width: number, hidden: number): string {
      const original = super.renderTopBorder(width, hidden);
      if (this.edges) this.edges.top = { original, hidden };
      return original;
    }

    protected override renderBottomBorder(width: number, hidden: number): string {
      const original = super.renderBottomBorder(width, hidden);
      if (this.edges) this.edges.bottom = { original, hidden };
      return original;
    }

    override render(width: number): string[] {
      const theme = this.readTheme();
      const bg = theme.getBgAnsi("userMessageBg");
      const fg = foregroundFromBackground(bg);
      const stock = () => {
        this.inset = 0;
        // Pi reserves a cursor cell. Give its wrap routine room for a wide grapheme.
        this.renderWidth = Math.max(3, width);
        return super.render(this.renderWidth).map(row => truncateToWidth(row, width, ""));
      };
      const inner = width - INSET;
      if (!fg || inner < 3) return stock();

      const edges: NonNullable<BandEditor["edges"]> = {};
      this.edges = edges;
      let rows: string[];
      try { rows = super.render(inner); }
      finally { this.edges = undefined; }
      if (!edges.top || !edges.bottom || rows[0] !== edges.top.original) return stock();
      const bottom = rows.indexOf(edges.bottom.original, 2);
      if (bottom < 2) return stock();
      this.inset = INSET;
      this.renderWidth = inner;

      const color = this.getText().trimStart().startsWith("!") ? "bashMode" : "accent";
      const bar = theme.fg(color, BAND_GLYPHS.bar);
      const bandRow = (text: string) => {
        const line = truncateToWidth(text, inner, "");
        const pad = " ".repeat(Math.max(0, inner - visibleWidth(line)));
        return `${bar}${bg} ${reopenBackground(line, bg)}${pad}\x1b[49m`;
      };
      const edge = (top: boolean, hidden: number) => hidden > 0
        ? bandRow(theme.fg("dim", `${icon("text", top ? "arrowUp" : "arrowDown")} ${hidden} more`))
        : theme.fg(color, top ? BAND_GLYPHS.barTop : BAND_GLYPHS.barBottom)
          + fg + (top ? BAND_GLYPHS.top : BAND_GLYPHS.bottom).repeat(width - 1) + "\x1b[39m";
      return [edge(true, edges.top.hidden), ...rows.slice(1, bottom).map(bandRow), edge(false, edges.bottom.hidden),
        ...rows.slice(bottom + 1).map(row => truncateToWidth("  " + row, width, ""))];
    }

    override handleMouse(event: TuiMouseEvent) {
      if (event.x < this.inset && this.isShowingAutocomplete()) return undefined;
      return super.handleMouse({ ...event, x: Math.max(0, event.x - this.inset), width: this.renderWidth || event.width });
    }
  };
}
