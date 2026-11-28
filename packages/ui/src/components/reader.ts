import {
  ScrollView, matchesKey, truncateToWidth, visibleWidth,
  type Component, type OverlayOptions, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

export const FULLSCREEN_READER_OVERLAY = {
  overlay: true,
  overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } satisfies OverlayOptions,
} as const;

export interface ReaderTab {
  label: string;
  count?: number | string;
  content: Component;
}

export interface ReaderDocument {
  title: string;
  breadcrumb?: string;
  tabs: readonly [ReaderTab, ...ReaderTab[]];
  footerHint?: string;
}

type ReaderColor = "accent" | "borderMuted" | "dim" | "muted" | "text" | "scrollbarTrack" | "scrollbarThumb";
interface ReaderEnvironment {
  theme: { fg(role: ReaderColor, text: string): string; bold(text: string): string };
  height(): number;
  requestRender(): void;
  close(): void;
}

type Hit = { x: number; y: number; width: number };
type Viewport = { top: number; height: number; contentWidth: number; scrollbarX: number };

const fit = (text: string, width: number) => truncateToWidth(text, width, "…", true);

function splitRow(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  return rightWidth > 0 && rightWidth + 2 <= width ? fit(left, width - rightWidth - 1) + " " + right : fit(left, width);
}

const hits = (rect: Hit, { x, y }: TuiMouseEvent) => y === rect.y && x >= rect.x && x < rect.x + rect.width;

export class TabbedReader implements Component {
  private tabIndex = 0;
  private readonly scroll: ScrollView;
  private viewport: Viewport | undefined;
  private content: { width: number; lines: string[] } | undefined;
  private grabOffset: number | undefined;
  private tabHits: (Hit & { index: number })[] = [];
  private closeHit: Hit | undefined;

  constructor(private readonly document: ReaderDocument, private readonly env: ReaderEnvironment) {
    this.scroll = new ScrollView({
      render: width => this.activeTab.content.render(width),
      invalidate: () => { for (const tab of this.document.tabs) tab.content.invalidate(); },
    }, {
      scrollbar: "auto",
      scrollbarTrackStyle: text => this.env.theme.fg("scrollbarTrack", text),
      scrollbarThumbStyle: text => this.env.theme.fg("scrollbarThumb", text),
    });
  }

  private get activeTab(): ReaderTab { return this.document.tabs[this.tabIndex]!; }

  invalidate(): void {
    this.scroll.invalidate();
    this.content = undefined;
  }

  dispose(): void { this.scroll.hideTransientScrollbar(); }

  private updateContent(view: Viewport): string[] {
    if (this.content?.width !== view.contentWidth) {
      this.content = { width: view.contentWidth, lines: view.contentWidth > 0 ? this.scroll.render(view.contentWidth) : [] };
    }
    this.scroll.updateLayout(this.content.lines.length, view.height, this.env.requestRender);
    return this.content.lines;
  }

  private get maxScrollTop(): number {
    return Math.max(0, (this.content?.lines.length ?? 0) - this.scroll.viewportHeight);
  }

  private thumb() {
    // Pi paints scroll layout nodes only in the main tree, not in overlays.
    // Keep its geometry here; ScrollView owns clamping and the auto-hide timer.
    const height = this.scroll.viewportHeight;
    const size = Math.max(Math.min(2, height), Math.round(height * height / (height + this.maxScrollTop)));
    const travel = height - size;
    const offset = Math.round(travel * this.scroll.scrollTop / this.maxScrollTop);
    return { offset, size, travel };
  }

  private select(index: number): void {
    if (this.tabIndex === index) return;
    this.tabIndex = index;
    this.grabOffset = undefined;
    this.scroll.setScrollbarActive(false);
    this.scroll.scrollToStart();
    this.scroll.hideTransientScrollbar();
    this.content = undefined;
    if (this.viewport) this.updateContent(this.viewport);
    this.env.requestRender();
  }

  handleInput(data: string): void {
    const page = Math.max(1, this.scroll.viewportHeight - 4);
    const tabs = this.document.tabs.length;
    if (matchesKey(data, "escape")) this.env.close();
    else if (matchesKey(data, "tab") || matchesKey(data, "right")) this.select((this.tabIndex + 1) % tabs);
    else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) this.select((this.tabIndex + tabs - 1) % tabs);
    else if (matchesKey(data, "up")) this.scroll.scrollBy(-1);
    else if (matchesKey(data, "down")) this.scroll.scrollBy(1);
    else if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-page);
    else if (matchesKey(data, "pageDown")) this.scroll.scrollBy(page);
    else if (matchesKey(data, "home")) this.scroll.scrollToStart();
    else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const view = this.viewport;
    if (!view) return;
    const onTrack = view.height > 0 && this.maxScrollTop > 0 && event.x === view.scrollbarX &&
      event.y >= view.top && event.y < view.top + view.height;
    if (event.type === "move" || event.type === "wheel") {
      this.scroll.setScrollbarActive(onTrack || this.grabOffset !== undefined);
      if (event.type === "wheel") {
        this.scroll.scrollBy(event.wheelDelta ?? 0);
        return { handled: true }; // Never send an overlay wheel event to the transcript.
      }
      return;
    }
    if (event.type === "release" && this.grabOffset !== undefined) {
      this.grabOffset = undefined;
      this.scroll.setScrollbarActive(onTrack);
      return { handled: true };
    }
    if (event.type === "drag" && this.grabOffset !== undefined) {
      const { travel } = this.thumb();
      this.scrollToPointer(event.y - view.top, travel, this.grabOffset);
      return { handled: true };
    }
    if (event.button !== "left") return;
    const tab = this.tabHits.find(hit => hits(hit, event));
    const close = this.closeHit && hits(this.closeHit, event);
    if (event.type === "press") {
      this.grabOffset = undefined;
      this.scroll.setScrollbarActive(onTrack);
      if (onTrack) {
        const y = event.y - view.top;
        const { offset, size, travel } = this.thumb();
        const onThumb = y >= offset && y < offset + size;
        this.grabOffset = onThumb ? y - offset : Math.floor(size / 2);
        if (!onThumb) this.scrollToPointer(y, travel, this.grabOffset);
        return { handled: true, capture: true };
      }
      // A handled press gives Pi a target for its synthesized click.
      if (close || tab) return { handled: true };
    }
    if (event.type === "click") {
      if (close) { this.env.close(); return { handled: true }; }
      if (tab) { this.select(tab.index); return { handled: true }; }
    }
    return;
  }

  private scrollToPointer(y: number, travel: number, grabOffset: number): void {
    const offset = Math.max(0, Math.min(travel, y - grabOffset));
    this.scroll.scrollTo(travel ? Math.round((offset / travel) * this.maxScrollTop) : 0);
  }

  private tabLabel(index: number, width: number, bar: boolean): string {
    const { theme } = this.env;
    const tab = this.document.tabs[index]!;
    const active = this.tabIndex === index;
    const label = active ? theme.bold(theme.fg("text", tab.label)) : theme.fg("muted", tab.label);
    const count = tab.count === undefined ? "" : theme.fg(active ? "accent" : "dim", String(tab.count));
    const mark = !bar ? "" : active ? theme.fg("accent", "▏ ") : "  ";
    return mark + splitRow(label, count, Math.max(0, width - visibleWidth(mark)));
  }

  private compactTabs(width: number, y: number): string {
    const { tabs } = this.document;
    const { theme } = this.env;
    const side = width < 24 ? Math.min(2, Math.floor((width - 1) / 2)) : Math.floor(width / 4);
    const center = width - side * 2;
    const prev = (this.tabIndex + tabs.length - 1) % tabs.length;
    const next = (this.tabIndex + 1) % tabs.length;
    if (tabs.length > 1) {
      this.tabHits.push({ x: 0, y, width: side, index: prev }, { x: width - side, y, width: side, index: next });
    }
    const arrow = (glyph: string, label: string) => theme.fg("muted", glyph + (side >= 8 ? ` ${label}` : ""));
    return fit(tabs.length > 1 ? arrow("‹", tabs[prev]!.label) : "", side) +
      this.tabLabel(this.tabIndex, center, center >= 4) + fit(tabs.length > 1 ? arrow("›", tabs[next]!.label) : "", side);
  }

  render(width: number): string[] {
    const height = this.env.height();
    const { theme } = this.env;
    const { title, breadcrumb, tabs, footerHint } = this.document;
    this.tabHits = [];
    this.closeHit = undefined;
    if (width <= 0 || height <= 0) return [];
    const hasRules = height >= 6;
    const hasNavigationRow = height >= 4;
    const rail = width >= 64 && height >= 6 ? Math.min(28, Math.max(22, Math.floor(width / 5))) : 0;
    const margin = width >= 8 ? 2 : 0;
    const navY = hasRules ? 2 : 1;
    const top = navY + (hasNavigationRow ? 1 : 0);
    const bodyHeight = Math.max(0, height - top - (hasRules ? 2 : hasNavigationRow ? 1 : 0));
    const view = { top, height: bodyHeight, contentWidth: Math.max(0, width - rail - margin - 1), scrollbarX: width - 1 };
    this.viewport = view;
    const content = this.updateContent(view);

    const close = width >= 24 ? "Close esc" : "esc";
    const trail = [breadcrumb, this.activeTab.label].filter(Boolean).join(" / ");
    const heading = theme.bold(theme.fg("text", title)) + theme.fg("muted", ` / ${trail}`);
    const rule = theme.fg("borderMuted", "─".repeat(width));
    const rows = [splitRow(heading, theme.fg("muted", close), width)];
    if (width >= close.length + 2) this.closeHit = { x: width - close.length, y: 0, width: close.length };
    if (hasRules) rows.push(rule);
    const divider = theme.fg("borderMuted", "│");
    if (hasNavigationRow) rows.push(rail ? " ".repeat(rail - 1) + divider + " ".repeat(width - rail) : this.compactTabs(width, navY));

    const firstTab = Math.max(0, this.tabIndex - bodyHeight + 1);
    const thumb = this.maxScrollTop > 0 && this.scroll.isScrollbarVisible ? this.thumb() : undefined;
    for (let row = 0; row < bodyHeight; row++) {
      const index = firstTab + row;
      const text = content[this.scroll.scrollTop + row] ?? "";
      let left = "";
      if (rail) {
        if (index < tabs.length) this.tabHits.push({ x: 0, y: top + row, width: rail - 1, index });
        left = (index < tabs.length ? this.tabLabel(index, rail - 2, true) : " ".repeat(rail - 2)) + " " + divider;
      }
      const bar = !thumb ? " " : row >= thumb.offset && row < thumb.offset + thumb.size
        ? this.scroll.scrollbarThumbStyle(this.scroll.isScrollbarActive ? "█" : "┃")
        : this.scroll.scrollbarTrackStyle("│");
      rows.push(left + " ".repeat(margin) + truncateToWidth(text, view.contentWidth, "", true) + bar);
    }
    if (hasRules) rows.push(rule);
    if (hasNavigationRow) {
      const progress = this.maxScrollTop ? Math.round(100 * this.scroll.scrollTop / this.maxScrollTop) : 0;
      const hint = footerHint ?? (width >= 60 ? "↑↓ scroll  PgUp/PgDn page  Tab sections  Esc close" : "↑↓ scroll  Tab sections");
      rows.push(splitRow(theme.fg("dim", hint), theme.fg("muted", `${progress}% scrolled`), width));
    }
    return rows;
  }
}
