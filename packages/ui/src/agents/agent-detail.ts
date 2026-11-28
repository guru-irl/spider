import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "../component";
import { icon } from "../icons.js";
import * as conversation from "./detail-conversation";
import type { ConversationBlock, WrappedRow } from "./detail-conversation";
import { initialFollowState, reduceFollow } from "./detail-follow";
import type { FollowState } from "./detail-follow";
import { initialMessageCount, updateMessageCount } from "./detail-message-count";
import type { MessageCountState } from "./detail-message-count";
import { detailViewport } from "./detail-viewport";
import type { DetailViewport } from "./detail-viewport";
import { formatDuration, shortModel } from "./footer";
import { formatRunUsage } from "./usage";
import { agentGlyph, statusGlyph, statusToken } from "./types";
import type { AgentSnapshot, RunCostFormatter, StoredRunEvent, ThemeAdapter } from "./types";

export type DetailRead =
  | { kind: "loaded"; run: AgentSnapshot | undefined; events: readonly StoredRunEvent[] }
  | { kind: "failed" };
export type DetailBackTarget = "selector" | "chat" | "size";
export interface DetailOptions {
  viewport: () => { safeHeight: number };
  requestRender: () => void;
  now?: () => number;
  formatRunCost?: RunCostFormatter;
}

type NormalViewport = Extract<DetailViewport, { kind: "normal" }>;
interface WrapCacheEntry { text: string; eventId: number | undefined; width: number; generation: number; rows: WrappedRow[]; }
const KILL_ARM_MS = 3000;
type KillState =
  | { kind: "idle" }
  | { kind: "armed"; deadline: number; timer: ReturnType<typeof setTimeout> }
  | { kind: "pending" }
  | { kind: "failed"; message: string };

export class AgentDetail implements Component {
  private readonly now: () => number;
  private back?: (target: DetailBackTarget) => void;
  private kill?: (runId: string) => void;
  private killState: KillState = { kind: "idle" };
  private disposed = false;
  private sizeCloseRequested = false;
  private run?: AgentSnapshot;
  private events: readonly StoredRunEvent[] = [];
  private loaded = false;
  private unavailable = false;
  private blocks: ConversationBlock[] = [];
  private rows: WrappedRow[] = [];
  private follow: FollowState = initialFollowState();
  private counts?: MessageCountState;
  private readonly wrapCache = new Map<string, WrapCacheEntry>();
  private generation = 0;
  private dirty = true;
  private wrappedWidth?: number;
  private layoutRows?: number;
  private viewport?: DetailViewport;

  constructor(private readonly runId: string, private readonly theme: ThemeAdapter, private readonly opts: DetailOptions) {
    this.now = opts.now ?? Date.now;
  }

  onBack(fn: (target: DetailBackTarget) => void): void { this.back = fn; }
  onKill(fn: (runId: string) => void): void { this.kill = fn; }
  setKillPending(): void {
    if (this.disposed || this.killState.kind === "pending") return;
    this.disarm();
    this.killState = { kind: "pending" };
    this.opts.requestRender();
  }
  setKillError(message: string): void {
    if (this.disposed) return;
    this.disarm();
    const clean = stripTerminalSequences(message).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    this.killState = { kind: "failed", message: clean || "Could not stop" };
    this.opts.requestRender();
  }

  update(read: DetailRead): void {
    if (this.disposed) return;
    if (read.kind === "failed") {
      this.unavailable = true;
      if (!this.loaded) this.dirty = true;
      this.opts.requestRender();
      return;
    }
    this.run = read.run;
    this.events = read.events;
    this.loaded = true;
    this.unavailable = false;
    this.blocks = this.run ? conversation.projectConversation(this.events, this.run, this.theme) : [];
    this.counts = this.counts
      ? updateMessageCount(this.counts, this.events, this.blocks, this.follow.mode === "following")
      : initialMessageCount(this.events, this.blocks);
    if (!this.canKillRun()) this.disarm();
    this.dirty = true;
    this.opts.requestRender();
  }

  updateRun(run: AgentSnapshot): void {
    if (this.disposed) return;
    this.run = run;
    this.blocks = [
      ...this.blocks.filter(block => block.key !== "activity"),
      ...conversation.projectConversation([], run, this.theme),
    ];
    if (!this.canKillRun()) this.disarm();
    this.dirty = true;
    this.opts.requestRender();
  }

  private canKillRun(): boolean {
    return this.run !== undefined && (this.run.status === "running" || this.run.status === "queued" || this.run.status === "paused");
  }

  private disarm(): boolean {
    if (this.killState.kind !== "armed") return false;
    clearTimeout(this.killState.timer);
    this.killState = { kind: "idle" };
    return true;
  }

  private isArmed(): boolean {
    return this.killState.kind === "armed" && this.now() < this.killState.deadline;
  }

  private marker(): string {
    return this.follow.mode === "paused" ? `${icon(this.theme.iconStyle, "arrowDown")} ${this.counts?.pending.size ?? 0} new` : "";
  }

  private canShowConfirmation(view: NormalViewport): boolean {
    return visibleWidth([this.marker(), "k again to kill", "Esc"].filter(Boolean).join(" ")) <= view.textWidth;
  }

  private arm(): void {
    this.disarm();
    const armed: Extract<KillState, { kind: "armed" }> = {
      kind: "armed", deadline: this.now() + KILL_ARM_MS,
      timer: setTimeout(() => {
        if (this.disposed || this.killState !== armed) return;
        this.killState = { kind: "idle" };
        this.opts.requestRender();
      }, KILL_ARM_MS),
    };
    (armed.timer as unknown as { unref?: () => void }).unref?.();
    this.killState = armed;
  }

  handleInput(data: string): boolean {
    if (this.disposed) return true;
    if (data === "k") {
      if (this.killState.kind === "pending") return true;
      if (!this.kill || !this.canKillRun() || this.viewport?.kind !== "normal" || !this.canShowConfirmation(this.viewport)) {
        if (this.disarm()) this.opts.requestRender();
        return true;
      }
      if (this.isArmed()) {
        this.disarm();
        this.kill(this.runId);
      } else this.arm();
      this.opts.requestRender();
      return true;
    }
    const disarmed = this.disarm();
    if (matchesKey(data, Key.escape)) this.back?.("selector");
    else if (matchesKey(data, Key.ctrl("c"))) this.back?.("chat");
    else if (matchesKey(data, Key.up)) this.scroll(-1);
    else if (matchesKey(data, Key.down)) this.scroll(1);
    else if (matchesKey(data, Key.pageUp)) this.scroll(-Math.max(1, (this.viewport?.kind === "normal" ? this.viewport.conversationRows : 1) - 1));
    else if (matchesKey(data, Key.pageDown)) this.scroll(Math.max(1, (this.viewport?.kind === "normal" ? this.viewport.conversationRows : 1) - 1));
    else if (matchesKey(data, Key.end) && this.viewport?.kind === "normal") {
      this.ensureLayout(this.viewport);
      this.follow = reduceFollow(this.follow, { type: "end" }, this.rows, this.viewport.conversationRows);
      this.clearUnreadWhenFollowing();
      this.opts.requestRender();
    } else if (disarmed) this.opts.requestRender();
    // This focused, read-only view consumes even unowned keys.
    return true;
  }

  scroll(delta: number): void {
    if (this.disposed) return;
    const disarmed = this.disarm();
    if (this.viewport?.kind !== "normal") {
      if (disarmed) this.opts.requestRender();
      return;
    }
    this.ensureLayout(this.viewport);
    this.follow = reduceFollow(this.follow, { type: "scroll", delta }, this.rows, this.viewport.conversationRows);
    this.clearUnreadWhenFollowing();
    this.opts.requestRender();
  }

  scrollAt(row: number, delta: number): void {
    if (this.disposed) return;
    const disarmed = this.disarm();
    const view = this.viewport;
    if (view?.kind === "normal" && row >= view.conversationTop && row < view.conversationTop + view.conversationRows) {
      this.scroll(delta);
    } else if (disarmed) this.opts.requestRender();
  }

  private clearUnreadWhenFollowing(): void {
    if (this.follow.mode === "following" && this.counts?.pending.size) {
      this.counts = updateMessageCount(this.counts, this.events, this.blocks, true);
    }
  }

  private placeholder(): ConversationBlock {
    const label = this.unavailable && !this.loaded ? "Conversation unavailable"
      : this.loaded && !this.run ? "Run not found"
      : this.run && !this.canKillRun() ? "No recorded conversation"
      : "Waiting for output";
    return { key: "placeholder", text: this.theme.fg("dim", label), assistantMessage: false };
  }

  private ensureLayout(view: NormalViewport): void {
    const rebuild = this.dirty || this.wrappedWidth !== view.textWidth;
    const previousRows = this.rows;
    if (rebuild) {
      const blocks = this.blocks.length ? this.blocks : [this.placeholder()];
      const activeKeys = new Set(blocks.map(block => block.key));
      for (const key of this.wrapCache.keys()) if (!activeKeys.has(key)) this.wrapCache.delete(key);
      this.rows = blocks.flatMap(block => {
        const cached = this.wrapCache.get(block.key);
        if (cached && cached.text === block.text && cached.eventId === block.eventId &&
            cached.width === view.textWidth && cached.generation === this.generation) return cached.rows;
        const rows = conversation.wrapConversation([block], view.textWidth);
        this.wrapCache.set(block.key, { text: block.text, eventId: block.eventId, width: view.textWidth, generation: this.generation, rows });
        return rows;
      });
      this.wrappedWidth = view.textWidth;
      this.dirty = false;
    }
    if (rebuild || this.layoutRows !== view.conversationRows) {
      this.follow = reduceFollow(this.follow, { type: "layout", previousRows }, this.rows, view.conversationRows);
      this.layoutRows = view.conversationRows;
      this.clearUnreadWhenFollowing();
    }
  }

  private frameRow(content: string, width: number): string {
    const inner = width - 2;
    const leftPad = inner >= 2 ? " " : "";
    const budget = Math.max(0, inner - leftPad.length - (inner >= 2 ? 1 : 0));
    const fitted = truncateToWidth(content, budget, "…");
    const body = leftPad + fitted;
    const border = (s: string) => this.theme.fg("muted", s);
    return border("│") + body + " ".repeat(Math.max(0, inner - visibleWidth(body))) + border("│");
  }

  private top(width: number): string {
    const inner = width - 2;
    const status = this.run ? `${statusGlyph(this.theme, this.run.status)} ${this.run.status}` : "unknown";
    const statusWidth = visibleWidth(status);
    const name = truncateToWidth(` ${agentGlyph(this.theme)} ${this.run?.name ?? "agent"}`, Math.max(0, inner - statusWidth - 1), "…");
    const gap = "─".repeat(Math.max(0, inner - visibleWidth(name) - statusWidth));
    return this.theme.fg("muted", "╭") + this.theme.fg("toolTitle", name) + this.theme.fg("muted", gap) +
      this.theme.fg(this.run ? statusToken(this.run.status) : "muted", status) + this.theme.fg("muted", "╮");
  }

  private controls(width: number): string {
    const marker = this.marker();
    const status = this.isArmed() ? "k again to kill"
      : this.killState.kind === "pending" ? "Stopping"
      : this.killState.kind === "failed" ? `Kill failed: ${this.killState.message}`
      : this.kill && this.canKillRun() ? "k kill" : "kill unavailable";
    const readError = this.unavailable && this.loaded;
    const rows: { parts: string[]; separator: string }[] = [];
    const add = (separator: string, ...parts: string[]) => rows.push({ separator, parts: parts.filter(Boolean) });
    add(" · ", marker, status, readError ? "Conversation unavailable" : "", "Esc");
    // An idle kill hint matters less than a read error, so drop it before abbreviating the error.
    if (readError && this.killState.kind === "idle") add(" · ", marker, "Conversation unavailable", "Esc");
    if (readError) add(" ", marker, status, "read err", "Esc");
    if (readError && this.killState.kind === "idle") add(" ", marker, "read err", "Esc");
    add(" ", marker, status, "Esc");
    if (this.killState.kind === "failed") add(" ", marker, "Failed", "Esc");
    if (readError) add(" ", marker, "read err", "Esc");
    add(" ", marker, "Esc");
    const chosen = rows.find(row => visibleWidth(row.parts.join(row.separator)) <= width) ?? rows.at(-1)!;
    const hints = `${icon(this.theme.iconStyle, "arrowUp")}${icon(this.theme.iconStyle, "arrowDown")} scroll · PgUp/PgDn · End`;
    if (visibleWidth([hints, ...chosen.parts].join(chosen.separator)) <= width) chosen.parts.unshift(hints);
    if (this.isArmed()) {
      const index = chosen.parts.indexOf(status);
      const warning = `${icon(this.theme.iconStyle, "warning")} ${status}`;
      if (index >= 0 && visibleWidth(chosen.parts.join(chosen.separator)) + visibleWidth(warning) - visibleWidth(status) <= width) {
        chosen.parts[index] = warning;
      }
    }
    return this.theme.fg("dim", chosen.parts.join(chosen.separator));
  }

  private compact(view: Extract<DetailViewport, { kind: "compact" }>): string[] {
    this.disarm();
    const border = (s: string) => this.theme.fg("muted", s);
    const body = Array.from({ length: view.height - 2 }, () => "");
    body[0] = "Use a larger terminal";
    if (body.length > 1) body[body.length - 1] = "Esc back";
    return [border(`╭${"─".repeat(view.width - 2)}╮`), ...body.map(line => this.frameRow(line, view.width)),
      border(`╰${"─".repeat(view.width - 2)}╯`)];
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const view = detailViewport(width, this.opts.viewport().safeHeight);
    this.viewport = view;
    if (view.kind === "unusable") {
      this.disarm();
      if (!this.sizeCloseRequested) {
        this.sizeCloseRequested = true;
        queueMicrotask(() => { if (!this.disposed) this.back?.("size"); });
      }
      return [];
    }
    if (view.kind === "compact") return this.compact(view);
    if (this.killState.kind === "armed" && (!this.isArmed() || !this.canShowConfirmation(view))) this.disarm();
    this.ensureLayout(view);
    const a = this.run;
    const turns = a?.stepCount === 1 ? "1 turn" : `${a?.stepCount ?? 0} turns`;
    const model = a?.model ? shortModel(a.model) : "unknown";
    const elapsed = a?.startedAt === undefined ? 0 : (a.endedAt ?? this.now()) - a.startedAt;
    const instructions = (a?.task ?? "").trim().replace(/\s+/g, " ") || "No instructions";
    let costText = a?.costText;
    try { if (a?.usageCosts && this.opts.formatRunCost) costText = this.opts.formatRunCost(a.usageCosts); }
    catch { /* retain the last formatted value */ }
    const role = a?.role ?? a?.agent;
    const roleLabel = role ? this.theme.italic?.(role) ?? role : "unknown";
    const header = [
      `${model} · ${roleLabel} · ${a?.thinking ?? "unknown"} · ${turns}`,
      `${formatRunUsage(a?.tokenCount ?? 0, a?.cost ?? 0, a?.compactionCount, costText)} · ${formatDuration(elapsed)}`,
      `Run: ${this.runId}`,
      `Instructions: ${instructions}`,
    ];
    const visible = this.rows.slice(this.follow.offset, this.follow.offset + view.conversationRows).map(row => row.text);
    while (visible.length < view.conversationRows) visible.push("");
    const border = (s: string) => this.theme.fg("muted", s);
    return [
      this.top(view.width),
      ...header.map(line => this.frameRow(this.theme.fg("dim", line), view.width)),
      border(`├${"─".repeat(view.width - 2)}┤`),
      ...visible.map(line => this.frameRow(line, view.width)),
      this.frameRow(this.controls(view.textWidth), view.width),
      border(`╰${"─".repeat(view.width - 2)}╯`),
    ];
  }

  invalidate(): void {
    if (this.disposed) return;
    this.generation++;
    this.blocks = this.run ? conversation.projectConversation(this.events, this.run, this.theme) : [];
    this.dirty = true;
  }

  dispose(): void { this.disarm(); this.disposed = true; this.wrapCache.clear(); }
}
