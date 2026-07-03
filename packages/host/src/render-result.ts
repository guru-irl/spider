// packages/host/src/render-result.ts
// pi `ToolDefinition.renderResult` dispatcher for the spider tool. pi calls this
// with the tool result plus a ToolRenderContext whose `args` are the spider call
// params ({ action, ... }); `result.details` is the handler's structured payload
// (untouched) and `result.content` is the model-facing text blocks.
//
// Contract (VERIFIED):
//   renderResult: (result, options, theme, context) => Component
// A pi Component requires BOTH render(width):string[] AND invalidate():void.
// @spider/ui Components (Panel/StatusLine/...) return { render } only, so every
// @spider/ui Component we hand back to pi is wrapped to add invalidate().
import type { Component } from "@spider/ui";
import {
  renderRememberResult,
  renderRecallResult,
  renderPending,
  type StageResult,
  type MemoryRecord,
} from "@spider/memory";
// Item 2 wires context renderers here:
// import { renderSearchResult, renderImportResult } from "@spider/context";

const ANSI = /\x1b\[[0-9;]*m/g;

/** Wrap an @spider/ui Component so it satisfies pi's Component (adds invalidate). */
function wrap(c: Component): Component {
  return {
    render: (w: number) => c.render(w),
    invalidate: () => c.invalidate?.(),
  };
}

/** Build a plain text Component from the model-facing content blocks. This is the
 *  DEFAULT for any action without a bespoke renderer, guaranteeing pi always gets
 *  a valid Component. Text is ANSI-stripped and clamped to the render width. */
function textComponent(result: any): Component {
  const blocks: any[] = Array.isArray(result?.content) ? result.content : [];
  const raw = blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
  return {
    render(width: number): string[] {
      const lines = raw.replace(ANSI, "").split("\n");
      return lines.map((l) => (l.length <= width ? l : l.slice(0, Math.max(0, width - 1)) + "…"));
    },
    invalidate() {},
  };
}

/**
 * Dispatch a spider tool result to its TUI Component by `action` (and `sub`/`command`
 * for control). Unmatched actions fall back to a text Component built from the
 * model-facing content — so ALL spider actions render something valid.
 */
export function renderSpiderResult(
  result: any,
  _options: unknown,
  _theme: unknown,
  context: any,
): Component {
  const action = String(context?.args?.action ?? "");
  const sub = String(context?.args?.sub ?? context?.args?.command ?? "");
  const details = result?.details;

  switch (action) {
    case "remember":
      return wrap(renderRememberResult(details as StageResult));
    case "recall":
      return wrap(renderRecallResult(details as MemoryRecord[]));
    // Item 2 hooks:
    // case "search": return wrap(renderSearchResult(details as any));
    // case "import": return wrap(renderImportResult(details as any));
    case "control":
      if (sub === "pending") return wrap(renderPending(details as MemoryRecord[]));
      return textComponent(result);
    default:
      return textComponent(result);
  }
}
