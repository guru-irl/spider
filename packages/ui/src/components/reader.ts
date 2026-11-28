import type { Component } from "@earendil-works/pi-tui";

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

export class TabbedReader implements Component {
  constructor(_document: ReaderDocument, private readonly env: ReaderEnvironment) {}
  render(width: number): string[] { return Array<string>(this.env.height()).fill(" ".repeat(width)); }
  invalidate(): void {}
  dispose(): void {}
}
