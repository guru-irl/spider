import { truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { icon, REPLY_FRAME, type IconStyle } from "../icons.js";
import { stripRow } from "../tool-card-edge.js";
import { COUNTERWEIGHT, hangingHinge, HINGE_RIG_HEIGHT, REST_POSE, type ColorCells } from "./hinge.js";

export interface IntroTheme extends ColorCells {
  fg(role: "accent" | "borderMuted" | "dim" | "muted" | "text" | "toolTitle" | "success" | "error", text: string): string;
  bold(text: string): string;
  getBgAnsi(role: "customMessageBg"): string;
}

export interface StartupSessionStats {
  compactions: number;
  turns: number;
  ageMs: number | undefined;
  runs: { total: number; active: number } | undefined;
  todos: number | undefined;
}

export interface StartupResourceCounts {
  context: number | undefined;
  skills: number;
  extensions: number;
  prompts: number;
  promptTokens: number | undefined;
}

export interface StartupFacts {
  iconStyle?: IconStyle;
  version: string;
  cwd: string;
  branch?: string;
  model?: string;
  thinking?: string;
  session: StartupSessionStats;
  resources: StartupResourceCounts;
}

const COMMANDS = [["/spider", "Tool menu"], ["/agents", "Subagent runs"], ["/todos", "Open todos"]] as const;
const fit = (text: string, width: number) => truncateToWidth(text, width, "…", true);

export function introDuration(ms: number, age = false): string {
  const seconds = Math.max(0, Math.floor(ms / 1000)), minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  if (minutes > 0) return age ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function compactCount(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)}b` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}m`
    : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

export const knownCount = (n: number | undefined): string => n === undefined ? "—" : String(n);

function renderBody(width: number, theme: IntroTheme, facts: StartupFacts, pose: number): string[] {
  const wide = width >= 108, beside = width >= 58;
  const rig = wide ? 40 : width >= 74 ? 30 : width >= 27 ? 25 : 0;
  const columns = beside ? width >= 74 ? rig + 4 : rig + 3 : 1;
  const idTop = wide ? 3 : beside ? 1 : rig ? HINGE_RIG_HEIGHT : 0;
  const statsLeft = wide ? 80 : columns;
  const statsTop = wide ? idTop : idTop + 4;
  const commandsTop = wide ? 8 : statsTop + 8;
  const right = width - (wide ? 4 : width > 4 ? 2 : 0);
  const height = beside ? HINGE_RIG_HEIGHT : commandsTop + 3;
  const rows = Array<string>(height).fill("");
  if (rig) hangingHinge(theme, rig, pose).forEach((line, y) => { rows[y] = " " + line; });
  function put(y: number, x: number, text: string, end = right): void {
    const row = rows[y]!;
    if (x >= end) return;
    rows[y] = row + " ".repeat(Math.max(0, x - visibleWidth(row))) + truncateToWidth(text, end - x);
  }
  const fg = theme.fg.bind(theme);
  const identity = theme.bold("spider") + fg("dim", `  pi v${facts.version}`);
  const identityEnd = wide ? statsLeft - 3 : right;
  put(idTop, columns, fg("toolTitle", icon(facts.iconStyle, "spider")) + " " + identity, identityEnd);
  put(idTop + 1, columns, fg("muted", [facts.cwd, facts.branch].filter(Boolean).join(" · ")), identityEnd);
  put(idTop + 2, columns, fg("dim", [facts.model, facts.thinking].filter(Boolean).join(" · ")), identityEnd);

  if (wide) {
    put(commandsTop, columns, theme.bold(fg("muted", "Commands")), identityEnd);
    COMMANDS.forEach(([command, help], i) => put(commandsTop + i + 1, columns,
      fg("accent", command.padEnd(10)) + fg("dim", help), identityEnd));
  }
  const { ageMs, compactions, turns, runs, todos } = facts.session;
  put(statsTop, statsLeft, theme.bold("Session stats"));
  const statsWidth = Math.max(0, right - statsLeft);
  put(statsTop + 1, statsLeft, fg("borderMuted", REPLY_FRAME.top.repeat(statsWidth)));
  const stats = [
    ["Compactions", fg("accent", theme.bold(String(compactions)))],
    ["Turns", theme.bold(String(turns))],
    ["Age", theme.bold(ageMs === undefined ? "—" : introDuration(ageMs, true))],
    ["Subagent runs", runs ? theme.bold(String(runs.total)) + fg("dim", ` · ${runs.active} active`) : "—"],
    ["Open todos", theme.bold(knownCount(todos))],
  ] as const;
  stats.forEach(([label, value], i) => {
    const tail = truncateToWidth(value, Math.max(1, statsWidth - 2));
    const valueWidth = visibleWidth(tail);
    const labelWidth = statsWidth - valueWidth - 1;
    put(statsTop + i + 2, statsLeft, fit(fg("muted", label), Math.max(0, labelWidth)) + " " + tail);
  });
  if (!wide && beside) {
    put(commandsTop, columns, COMMANDS.map(([command]) => fg("accent", command)).join("  "));
  } else if (!beside) {
    COMMANDS.forEach(([command, help], i) => put(commandsTop + i, columns, fg("accent", command.padEnd(10)) + fg("dim", help)));
  }
  return rows;
}

function renderResources(width: number, theme: IntroTheme, facts: StartupFacts): string[] {
  const inner = width - 2;
  const { context, skills, extensions, prompts, promptTokens } = facts.resources;
  const counts = [knownCount(context), String(skills), `≥${extensions}`, String(prompts), promptTokens === undefined ? "—" : `~${compactCount(promptTokens)}`];
  const labels = ["Context", "Skills", "Extensions", "Prompts", "System prompt"];
  const abbreviated = ["Ctx", "Skills", "Ext", "Tmpl", "Sys"];
  const inventory = (mode: number) => counts.map((n, i) => {
    const label = (mode === 0 ? labels : abbreviated)[i];
    return `${label}${mode === 2 && i !== 1 && i !== 4 ? "" : " "}${n}${mode === 0 && i === 4 ? " tokens" : ""}`;
  }).join(mode === 2 ? " " : " · ");
  const title = "Loaded resources", arrow = icon(facts.iconStyle, "arrowRight"), hotkey = `Alt+O ${arrow}`;
  const modes = [[0, 2, 2], [1, 2, 2], [1, 1, 1], [2, 1, 1], [2, 1, 0]] as const;
  const choice = modes.map(([mode, pad, endPad]) => ({ counts: inventory(mode), action: mode === 2 ? arrow : hotkey, pad, endPad }))
    .find(({ counts, action, pad, endPad }) => title.length + counts.length + visibleWidth(action) + 2 * pad + endPad + 1 <= inner);
  const fg = theme.fg.bind(theme);
  const { counts: visibleCounts, action, pad, endPad } = choice ?? { counts: "", action: width >= 28 ? hotkey : arrow, pad: 1, endPad: 1 };
  const actionWidth = visibleWidth(action);
  const summary = theme.bold(title) + (visibleCounts ? " ".repeat(pad) + fg("muted", visibleCounts) : "");
  const row = " ".repeat(pad) + fit(summary, Math.max(0, inner - pad - endPad - actionWidth - 1)) + " " + fg("accent", theme.bold(action)) + " ".repeat(endPad);
  const bg = theme.getBgAnsi("customMessageBg");
  const { topLeft, topRight, bottomLeft, bottomRight, top, left, right } = REPLY_FRAME;
  const border = (text: string) => fg("borderMuted", text);
  return [border(topLeft + top.repeat(inner) + topRight), border(left) + stripRow(row, bg, inner) + border(right), border(bottomLeft + top.repeat(inner) + bottomRight)];
}

export class StartupHeader implements Component {
  private pose: number;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private hit?: { top: number; width: number };
  private cache?: { width: number; lines: string[] };

  constructor(private readonly theme: IntroTheme, private facts: StartupFacts,
    private readonly options: { requestRender(): void; openResources(): void; reducedMotion?: boolean }) {
    this.pose = options.reducedMotion ? REST_POSE : 0;
    if (options.reducedMotion) return;
    COUNTERWEIGHT.slice(1).forEach(({ at }, i) => {
      const timer = setTimeout(() => { this.pose = i + 1; this.invalidate(); options.requestRender(); }, at);
      timer.unref?.();
      this.timers.push(timer);
    });
  }

  update(facts: StartupFacts): void { this.facts = facts; this.invalidate(); this.options.requestRender(); }
  invalidate(): void { this.cache = undefined; }
  dispose(): void { for (const timer of this.timers.splice(0)) clearTimeout(timer); this.hit = undefined; }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const lines = renderBody(width, this.theme, this.facts, this.pose);
    this.hit = undefined;
    if (width >= 12) {
      this.hit = { top: lines.length, width: width - 2 };
      lines.push(...renderResources(width - 2, this.theme, this.facts).map(line => " " + line));
    }
    this.cache = { width, lines };
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const hit = this.hit;
    if (hit && event.type === "click" && event.button === "left" && event.x >= 1 && event.x <= hit.width
      && event.y >= hit.top && event.y < hit.top + 3) {
      this.options.openResources();
      return { handled: true };
    }
    return undefined;
  }
}
