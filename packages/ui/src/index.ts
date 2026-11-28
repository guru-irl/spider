// Shared Spider UI. Glyphs come from the selected icon style; colours use pi theme tokens.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "./component";
import { fitResultLines } from "./renderers/types";
import { icon, type IconStyle } from "./icons.js";
export type { Component } from "./component";
export { cachedLines } from "./component";
export { joinToolCards } from "./tool-card-join.js";
export { bindHalfBox, bindToolCardShell, edgeInk, halfEdge, isHalfEdge, isImageRow, stripRow } from "./tool-card-edge.js";
export { foregroundFromBackground, reopenBackground } from "./ansi.js";
export { ICON_STYLES, ACTIVITY_FRAMES, BAND_GLYPHS, REPLY_FRAME, icon, isIconStyle, type IconStyle, type IconRole } from "./icons.js";
export { formatRunUsage, formatCompactionCount } from "./agents/usage";

// Phase 0 kept a static ANSI token table; that is gone. Colour is NEVER hardcoded here —
// all spider colouring flows through pi's live theme tokens via the ThemeAdapter (piTheme).
// The only "token" left is the box-drawing rule char used by SectionRule (not a colour).
const DEFAULT_TOKENS: Record<string, string> = {
  rule: "─",
};

export const theme: { glyph: string; token(name: string): string } = {
  glyph: icon("text", "spider"),
  token(name: string): string {
    return DEFAULT_TOKENS[name] ?? "";
  },
};

function clamp(s: string, width: number): string {
  return truncateToWidth(s, width, "…");
}

export function SectionRule(title?: string, iconStyle?: IconStyle): Component {
  return {
    render(width: number): string[] {
      const glyph = icon(iconStyle, "spider");
      const label = title ? ` ${glyph} ${title} ` : ` ${glyph} `;
      const fill = theme.token("rule");
      const remaining = Math.max(0, width - visibleWidth(label));
      return [clamp(label + fill.repeat(remaining), width)];
    },
  };
}

export function Panel(opts: { title?: string; body: string[]; expanded?: boolean; iconStyle?: IconStyle }): Component {
  return {
    render(width: number): string[] {
      const out: string[] = [];
      if (opts.title) out.push(...SectionRule(opts.title, opts.iconStyle).render(width));
      if (opts.expanded) out.push(...fitResultLines(opts.body, width, true));
      else for (const line of opts.body) out.push(clamp(line, width));
      return out;
    },
  };
}

export function StatusLine(opts: { left?: string; right?: string }): Component {
  return {
    render(width: number): string[] {
      const left = opts.left ?? "";
      const right = opts.right ?? "";
      const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
      return [clamp(left + " ".repeat(gap) + right, width)];
    },
  };
}

export function LiveWidget(
  source: { subscribe(fn: () => void): () => void },
  render: (width: number) => string[],
): Component {
  let dirty = true;
  let last: string[] = [];
  let lastWidth = 0;
  source.subscribe(() => { dirty = true; });
  return {
    render(width: number): string[] {
      if (dirty || width !== lastWidth) {
        last = render(width);
        lastWidth = width;
        dirty = false;
      }
      return last;
    },
    invalidate() { dirty = true; },
  };
}

// ---- Phase 5: subagents footer + live grid ----
export * from "./agents/types";
export { AgentStore, projectRow, applyEvent } from "./agents/store";
export { FrameScheduler } from "./agents/coalesce";
export { diffLines, hasChanges } from "./agents/diff";
export { buildFooterModel } from "./agents/footer-model";
export { AgentFooter, formatDuration, formatAgentLine, shortModel } from "./agents/footer";
export { AgentList } from "./agents/agent-list";
export { renderGridCell } from "./agents/grid-cell";
export { AgentDetail } from "./agents/agent-detail";
export type { DetailRead, DetailBackTarget, DetailOptions } from "./agents/agent-detail";
export { MOON_CYCLE_MS, moonFrame } from "./components/spinner";
export { renderProgressBar } from "./components/progress-bar";
export { renderDiffView } from "./components/diff-view";
export { renderTable } from "./components/table";

// ---- Phase 8: per-action renderers ----
export type {
  RenderCtx, ExecKind, ExecDetails, IndexDetails, MemoryRecordView, MemoryCardDetails,
  TodoItemView, TodoChecklistDetails, RunView, RunResultDetails, MessageDetails,
} from "./renderers/types";
export { card, kv, statusIcon, sectionRule, fitResultLines, cardDetailIndent, flushLeft } from "./renderers/types";
export { renderErrorResult } from "./renderers/error";
export { renderExecCall, renderExecResult } from "./renderers/exec";
export { renderIndexResult } from "./renderers/index-fetch";
export { renderMessageResult } from "./renderers/message";
export { renderKillResult } from "./renderers/kill";
export type { KillDetails, KillResultLine } from "./renderers/kill";
export { renderTodoChecklist } from "./renderers/todo-checklist";
export { renderEscalation } from "./renderers/escalation";
export type { EscalationDetails } from "./renderers/escalation";
export { renderMigrateResult } from "./renderers/migrate";
export type { MigrateDetails } from "./renderers/migrate";
export { renderBindResult } from "./renderers/bind";
export type { BindDetails } from "./renderers/bind";

// ---- Phase 8: observability + config screens ----
export { summarizeStats } from "./screens/stats-collect";
export type { StatsInput, StatsSummary, ModelStatRow } from "./screens/stats-collect";
export { renderStats, StatsView } from "./screens/stats-view";
export { renderInsights, InsightsView } from "./screens/insights-view";
export type { InsightGraphView } from "./screens/insights-view";
export { catalogRows, resolveDefault, MODEL_ROLES, isAgentModelRole } from "./screens/models-model";
export type { CatalogRow, TierGroup, ModelThinkingDisplay } from "./screens/models-model";
export { renderModels, ModelsView } from "./screens/models-view";
export { isAbsolutePathList } from "./screens/absolute-paths";
export { CONFIG_SCHEMA, createConfigSchema, getField, coerce, isToolSelectorList } from "./screens/config-schema";
export type { ConfigField, ConfigGroup, ConfigFieldType } from "./screens/config-schema";
export { buildConfigModel, readPath } from "./screens/config-model";
export type { ConfigFieldRow, ConfigGroupModel } from "./screens/config-model";
export { renderConfig, ConfigView } from "./screens/config-view";
