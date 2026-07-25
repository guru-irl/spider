// spider-ui skeleton. All spider visual output flows through this kit.
// Honors pi active theme tokens; signature glyph is 🕸 (never color-only).

import type { Component } from "./component";
export type { Component } from "./component";

// Phase 0 kept a static ANSI token table; that is gone. Colour is NEVER hardcoded here —
// all spider colouring flows through pi's live theme tokens via the ThemeAdapter (piTheme).
// The only "token" left is the box-drawing rule char used by SectionRule (not a colour).
const DEFAULT_TOKENS: Record<string, string> = {
  rule: "─",
};

export const theme = {
  glyph: "🕸" as const,
  token(name: string): string {
    return DEFAULT_TOKENS[name] ?? "";
  },
};

function clamp(s: string, width: number): string {
  return s.length <= width ? s : s.slice(0, Math.max(0, width - 1)) + "…";
}

export function SectionRule(title?: string): Component {
  return {
    render(width: number): string[] {
      const glyph = theme.glyph;
      const label = title ? ` ${glyph} ${title} ` : ` ${glyph} `;
      const fill = theme.token("rule");
      const remaining = Math.max(0, width - label.length);
      return [clamp(label + fill.repeat(remaining), width)];
    },
  };
}

export function Panel(opts: { title?: string; body: string[] }): Component {
  return {
    render(width: number): string[] {
      const out: string[] = [];
      if (opts.title) out.push(...SectionRule(opts.title).render(width));
      for (const line of opts.body) out.push(clamp(line, width));
      return out;
    },
  };
}

export function StatusLine(opts: { left?: string; right?: string }): Component {
  return {
    render(width: number): string[] {
      const left = opts.left ?? "";
      const right = opts.right ?? "";
      const gap = Math.max(1, width - left.length - right.length);
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
export { AgentFooter, formatDuration, formatAgentLine } from "./agents/footer";
export { AgentList } from "./agents/agent-list";
export { renderGridCell } from "./agents/grid-cell";
export { AgentDetail } from "./agents/agent-detail";
export { Spinner, BRAILLE_FRAMES } from "./components/spinner";
export { renderProgressBar } from "./components/progress-bar";
export { renderDiffView } from "./components/diff-view";
export { renderTable } from "./components/table";

// ---- Phase 8: per-action renderers ----
export type {
  RenderCtx, ExecKind, ExecDetails, IndexDetails, MemoryRecordView, MemoryCardDetails,
  TodoItemView, TodoChecklistDetails, RunView, RunResultDetails, MessageDetails,
} from "./renderers/types";
export { card, kv, statusIcon, sectionRule } from "./renderers/types";
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
export { catalogRows, resolveDefault, MODEL_ROLES } from "./screens/models-model";
export type { CatalogRow, TierGroup } from "./screens/models-model";
export { renderModels, ModelsView } from "./screens/models-view";
export { CONFIG_SCHEMA, getField, coerce } from "./screens/config-schema";
export type { ConfigField, ConfigGroup, ConfigFieldType } from "./screens/config-schema";
export { buildConfigModel, readPath } from "./screens/config-model";
export type { ConfigFieldRow, ConfigGroupModel } from "./screens/config-model";
export { renderConfig, ConfigView } from "./screens/config-view";
