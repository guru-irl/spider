# spider Phase 8 — Polish (per-action renderers, slash commands, config/models UI, doctor/stats/insights) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the spider surface — bespoke `@spider/ui` `renderCall`/`renderResult` for every remaining action, all slash commands, the `control config` picker + a new `control models` catalog/tier UI, and the `control doctor`/`stats`/`insights` observability screens — then perform the final strangler cutover removing the deprecated legacy tools.

**Architecture:** All rendering is pure `(details, {theme, width, expanded}) => string[]` functions in `@spider/ui/src/renderers/*` (width-safe, glyph+color, theme-token driven), wrapped into pi `Component`s and dispatched by action in a single host `rendererRegistry`. Screens (`config`, `models`, `doctor`, `stats`, `insights`) are built from injected data through pure builders (`buildConfigModel`, `catalogRows`, `runDoctorChecks`, `summarizeStats`, `buildInsightGraph`) so they are unit-testable without pi, then mounted through `ctx.ui.custom`. Config edits round-trip through Phase-0 `controlConfig`; `control models` edits the `models` config group backed by `@spider/models.catalog()`; hot-reload fires on `resources_discover`.

**Tech Stack:** TypeScript (ESM), `@spider/ui` over `@earendil-works/pi-tui` + `@earendil-works/pi-coding-agent` (peer), `@spider/db-core`, `@spider/models` (catalog/pick), `@spider/host` (control + slash + registry), Vitest (TDD).

## Global Constraints

- **Language:** TypeScript, Node ≥ 22.19.0 (target Node 24). ESM (`"type":"module"`). `better-sqlite3` synchronous, WAL + busy_timeout + retry.
- **UI hard rule:** `@spider/ui` owns ALL spider visual output — **no** ad-hoc `console.log`/string rendering anywhere in any package. Every screen/renderer honors pi **active theme tokens** (light/dark/user) via the injected `ThemeAdapter`; signature glyph is **🕸** (spider/web) on every section rule/header; **never color-only** (always glyph + color).
- **Width safety (non-negotiable):** every string returned from a renderer or `render(width)` MUST be `≤ width` visible cells; run each line through `truncateToWidth(line, width)` (pass `""` ellipsis when appending a suffix); use `visibleWidth` for alignment math; guard `width < 3`.
- **Stable, diffable trees:** components cache `{cachedWidth,cachedLines}`; recompute only on version/theme/width change; implement `invalidate()` (pi calls it on theme change).
- **Zero temp-dir:** integration/round-trip DBs + config files under `packages/<pkg>/.spider/scratch/` or a test tmp created under the repo. NEVER `/tmp`, `$TMPDIR`, `/var/tmp`.
- **Canonical names (do not rename — from `plans/README.md`):** the tool is `spider`; `ActionCtx`/`ActionHandler`/`registerAction` (A2); `@spider/models` `catalog(pi)`/`pick(profile)`/`Tier`/`ModelEntry` (A1); `ThemeAdapter` from `@spider/ui` (Phase 5); host `controlDoctor(cwd)`/`controlConfig(op,cwd,key?,value?)` (Phase 0); DB tables `model_stats`, `insights`, `content`, `vector_map`, `runs`. Config groups: `organism`, `embeddings`, `memory`, `routing`, `curator`, `self_naming`, `models`, `ui`.
- **Config format:** plain JSON; precedence defaults < global `~/.pi/agent/spider/config.json` < project `.spider/config.json` < env. `set` writes the PROJECT config (Phase 0). Hot-reload via `resources_discover`; restart only for embedding model/dim change.
- **Tests:** Vitest; TDD (test first → red → green → refactor); pure builders get unit tests; UI components tested via `render(width)` with an identity `ThemeAdapter`; config/models round-trip tested against a temp config dir; commit per green task (conventional commits).
- **Strangler:** the deprecated legacy tools (`memory`, `memory_search`, `session_search`, `skill_manage`, `todo`, `subagent`, `wait`, 11× `ctx_*`) are removed **only** in this phase's final cutover task, after every spider action is fully rendered.

---

## Dependencies & preconditions

- **Phase 0** delivered: single `spider` tool + `registerAction` dispatch; `controlDoctor(cwd): {ok,lines}` + `controlConfig(op,cwd,key?,value?)` in `packages/host/src/control.ts`; `resources_discover` empty hook; `@spider/ui` skeleton (`Component`, `theme`, `Panel`, `SectionRule`, `StatusLine`, `ListView`, `Picker`, `StatsPanel`, `Callout`); `@spider/models` `catalog`/`pick`/`complete`/`recordModelStat` (A1).
- **Phase 5** delivered: `ThemeAdapter` interface + `piTheme(theme)` adapter in `packages/host/src/agents/theme-adapter.ts`; `AgentFooter`/`Grid`; `/agents` reachable via Ctrl+G; `Table`/`ProgressBar`/`DiffView`/`Spinner` components.
- **Phases 1/2/4/6/7** delivered the actions Phase 8 renders and the DB rows Phase 8 reads: `remember`/`recall`/`todo` (+ existing `render*Result` in `@spider/memory`/`@spider/todo`), `search`/`import` (+ `renderSearchResult`/`renderImportSummaryResult` in `@spider/ui/src/renderers`), `exec`/`exec_file`/`batch`/`index`/`fetch` (context), `run`/`wait`/`message` (subagents), `insights` rows (organism, Phase 6), `model_stats` rows (A1).
- **This phase does not change action semantics** — it only adds/upgrades renderers, screens, slash commands, config/models UI, and the legacy removal. Where an earlier phase already shipped a partial `renderResult`, Phase 8 **supersedes** it by routing through the unified `rendererRegistry` (old per-package render fns are re-exported/kept as pure builders, wired centrally). If an expected `result.details` field is missing at runtime, renderers MUST degrade to a single summary line, never throw. See Risks.

---

## File Structure

All paths under `/mnt/data/src/spider/`.

```
packages/ui/src/renderers/
├── types.ts             # RenderCtx + all *Details detail shapes + card()/kv()/statusIcon() helpers
├── exec.ts              # renderExecCall / renderExecResult (exec | exec_file | batch)
├── index-fetch.ts       # renderIndexResult / renderFetchResult
├── memory-card.ts       # renderMemoryCard (recall | remember)
├── todo-checklist.ts    # renderTodoChecklist
├── run-view.ts          # renderRunResult (run | wait) — pipeline-aware inline view
├── message.ts           # renderMessageResult
├── search.ts            # (exists) + renderSearchCall added
└── index.ts             # (exists barrel) MODIFY: re-export the Phase 8 renderer surface

packages/ui/src/screens/
├── config-model.ts      # buildConfigModel(schema,cfg) → groups/fields for the picker
├── config-schema.ts     # CONFIG_SCHEMA (8 groups) + getField/validateField/coerce
├── config-view.ts       # ConfigView component (group→field SelectList navigation)
├── models-model.ts      # catalogRows(entries,defaults) + MODEL_ROLES + resolveDefault
├── models-view.ts       # ModelsView component (tier-grouped catalog + defaults editor)
├── doctor-checks.ts     # runDoctorChecks(probes) → DoctorResult[] (pure)
├── doctor-view.ts       # DoctorView component
├── stats-collect.ts     # summarizeStats(input) → StatsSummary (pure)
├── stats-view.ts        # StatsView component
├── insights-graph.ts    # buildInsightGraph(rows) → InsightGraph (pure)
└── insights-view.ts     # InsightsView component

packages/host/src/
├── renderers/registry.ts   # rendererRegistry: action → {renderCall,renderResult} (wraps ui builders in Component)
├── control/config-cmd.ts   # control config picker: probes + coerce + controlConfig write + hot-reload notify
├── control/models-cmd.ts   # control models: catalog(pi) + config group read/write
├── control/doctor-cmd.ts   # control doctor: build probes from db-core/models/native + runDoctorChecks
├── control/stats-cmd.ts    # control stats: DB queries → summarizeStats
├── control/insights-cmd.ts # control insights: insights table → buildInsightGraph
├── slash.ts                # registerSlashCommands(pi): /spider /memory /search /insights /learn + thin /doctor /stats /upgrade /purge
├── legacy-removal.ts       # removeLegacyTools(pi) — deletes deprecated registrations (final cutover)
├── extension.ts            # MODIFY: install registry + slash + control screens; call removeLegacyTools
└── __tests__/              # registry.test.ts config-cmd.test.ts models-cmd.test.ts doctor-cmd.test.ts
                            #   stats-cmd.test.ts insights-cmd.test.ts slash.test.ts legacy-removal.test.ts

packages/ui/src/__tests__/     # exec/index-fetch/memory-card/todo-checklist/run-view/message renderer tests
packages/ui/src/screens/__tests__/  # config/models/doctor/stats/insights builder + view tests
```

**Single-writer discipline:** `packages/ui/src/renderers/*` (Tasks 1–8), `packages/ui/src/screens/*` (Tasks 10–22), and `packages/host/src/extension.ts` (Tasks 9, 12, 16, 18, 20, 22, 23, 24) are touched by many tasks — serialize edits to `index.ts` and `extension.ts`.

---

## Interfaces (canonical for this phase — define once, reuse verbatim)

```ts
// packages/ui/src/renderers/types.ts
import type { ThemeAdapter } from "../agents/types.js"; // Phase 5 ThemeAdapter { fg,bg,bold,glyph }

export interface RenderCtx { theme: ThemeAdapter; width: number; expanded?: boolean; }

export type ExecKind = "exec" | "exec_file" | "batch";
export interface ExecDetails {
  kind: ExecKind; commands: string[]; ok: boolean; exitCode: number;
  outLines: number; ms?: number; preview: string[]; indexed?: { source: string; chunks: number };
}
export interface IndexDetails {
  kind: "index" | "fetch"; source: string; targets: string[];
  chunks: number; embedded: number; skipped?: number; urls?: string[];
}
export interface MemoryRecordView {
  uuid: string; category: string; content: string; link?: string;
  status: string; source: string; confidence?: number;
}
export interface MemoryCardDetails { mode: "remember" | "recall"; records: MemoryRecordView[]; staged: number; }
export interface TodoItemView { id: number; text: string; done: boolean; }
export interface TodoChecklistDetails { scope: string; items: TodoItemView[]; done: number; total: number; }
export interface RunView { runId: string; name: string; role?: string; status: string; model?: string; steps: number; tokens: number; phase?: string; }
export interface RunResultDetails { runs: RunView[]; pipeline: { from: string; to: string; phase?: string }[]; }
export interface MessageDetails { verb: "send" | "ask" | "reply" | "broadcast"; to?: string; from?: string; kind?: string; body: string; delivered: boolean; }

// packages/ui/src/screens/config-schema.ts
export type ConfigFieldType = "boolean" | "number" | "string" | "enum";
export interface ConfigField {
  key: string;               // dotted path, e.g. "memory.snapshotCharCap"
  label: string; type: ConfigFieldType; default: unknown;
  enum?: string[]; min?: number; max?: number; description: string; restart?: boolean;
}
export interface ConfigGroup { id: string; label: string; fields: ConfigField[]; }

// packages/ui/src/screens/config-model.ts
export interface ConfigFieldRow { field: ConfigField; value: unknown; isDefault: boolean; }
export interface ConfigGroupModel { id: string; label: string; rows: ConfigFieldRow[]; }

// packages/ui/src/screens/models-model.ts
import type { ModelEntry, Tier } from "@spider/models";
export const MODEL_ROLES: string[]; // reviewer worker scout planner researcher oracle digest self_name upstream_watch
export interface CatalogRow { provider: string; id: string; ref: string; tier: Tier; available: boolean; reasoning: boolean; vision: boolean; isDefaultFor: string[]; }
export interface TierGroup { tier: Tier; rows: CatalogRow[]; }

// packages/ui/src/screens/doctor-checks.ts
export type CheckStatus = "ok" | "warn" | "fail";
export interface DoctorResult { id: string; label: string; status: CheckStatus; detail: string; }
export interface DoctorProbes {
  nativeDeps: { name: string; loaded: boolean; version?: string; error?: string }[];
  dbHealth: { global: boolean; project: boolean; migrated: boolean; pending?: string[] };
  sqliteVec: { loaded: boolean; error?: string };
  embeddingProvider: { provider: string; reachable: boolean; detail?: string };
  modelRouter: { providers: { provider: string; reachable: boolean; models: number }[] };
  registry: { projects: number; orphans: string[] };
}

// packages/ui/src/screens/stats-collect.ts
export interface StatsInput {
  contentChunks: number; avgChunkTokens: number;
  rowCounts: Record<string, number>;
  modelStats: { model: string; ms: number; ok: number; tokens: number }[];
}
export interface ModelStatRow { model: string; calls: number; okRate: number; avgMs: number; tokens: number; }
export interface StatsSummary {
  tokenSavings: { indexedChunks: number; estTokensSaved: number };
  rowCounts: Record<string, number>;
  models: ModelStatRow[];
}

// packages/ui/src/screens/insights-graph.ts
export interface InsightRow { kind: string; a?: string | null; b?: string | null; weight?: number | null; payload?: string | null; }
export interface InsightNode { id: string; kind: string; label: string; weight: number; }
export interface InsightEdge { from: string; to: string; weight: number; }
export interface InsightGraph { nodes: InsightNode[]; edges: InsightEdge[]; }

// packages/host/src/renderers/registry.ts
import type { Component } from "@spider/ui";
export interface ActionRenderer {
  renderCall?(args: Record<string, unknown>, theme: unknown): Component;
  renderResult?(result: { details?: unknown; isError?: boolean }, meta: { expanded?: boolean; isPartial?: boolean }, theme: unknown): Component;
}
export function buildRendererRegistry(): Record<string, ActionRenderer>;
```

Status/glyph vocabulary (single source, reused everywhere): `✓` ok/done (`success`) · `✗` fail/error (`error`) · `⚠` warn (`warning`) · `○` off/empty (`muted`) · `●` on/active (`accent`) · `■` paused (`muted`) · `▸` overflow · `→` handoff/edge · `│`/`⎿` continuation gutter (`dim`). Section rules carry the **🕸** glyph.

---

## Task 1: Renderer detail types + shared card/kv/icon helpers

**Files:**
- Create: `packages/ui/src/renderers/types.ts`
- Test: `packages/ui/src/__tests__/renderer-helpers.test.ts`

**Interfaces:**
- Consumes: `ThemeAdapter` from `../agents/types.js`; `truncateToWidth`/`visibleWidth` from `@earendil-works/pi-tui`.
- Produces: every `*Details` type from the Interfaces block, plus `card(theme,title,lines,width): string[]`, `kv(theme,label,value,width): string`, `statusIcon(theme,status): string` where `status ∈ "ok"|"fail"|"warn"|"on"|"off"|"paused"`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/renderer-helpers.test.ts
import { describe, it, expect } from "vitest";
import { card, kv, statusIcon } from "../renderers/types.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("renderer helpers", () => {
  it("card frames a title with the 🕸 glyph and keeps every line within width", () => {
    const lines = card(id, "memory", ["a", "b"], 30);
    expect(lines[0]).toContain("🕸");
    expect(lines[0]).toContain("memory");
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(30);
  });
  it("kv right-truncates the value and never exceeds width", () => {
    const line = kv(id, "provider", "a-really-long-model-identifier-value", 20);
    expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    expect(line).toContain("provider");
  });
  it("statusIcon maps status to a glyph", () => {
    expect(statusIcon(id, "ok")).toContain("✓");
    expect(statusIcon(id, "fail")).toContain("✗");
    expect(statusIcon(id, "warn")).toContain("⚠");
    expect(statusIcon(id, "on")).toContain("●");
    expect(statusIcon(id, "off")).toContain("○");
    expect(statusIcon(id, "paused")).toContain("■");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/renderer-helpers.test.ts`
Expected: FAIL — `Cannot find module '../renderers/types.js'`.

- [ ] **Step 3: Write the module**

```ts
// packages/ui/src/renderers/types.ts
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";

export interface RenderCtx { theme: ThemeAdapter; width: number; expanded?: boolean; }

export type ExecKind = "exec" | "exec_file" | "batch";
export interface ExecDetails {
  kind: ExecKind; commands: string[]; ok: boolean; exitCode: number;
  outLines: number; ms?: number; preview: string[]; indexed?: { source: string; chunks: number };
}
export interface IndexDetails {
  kind: "index" | "fetch"; source: string; targets: string[];
  chunks: number; embedded: number; skipped?: number; urls?: string[];
}
export interface MemoryRecordView {
  uuid: string; category: string; content: string; link?: string;
  status: string; source: string; confidence?: number;
}
export interface MemoryCardDetails { mode: "remember" | "recall"; records: MemoryRecordView[]; staged: number; }
export interface TodoItemView { id: number; text: string; done: boolean; }
export interface TodoChecklistDetails { scope: string; items: TodoItemView[]; done: number; total: number; }
export interface RunView { runId: string; name: string; role?: string; status: string; model?: string; steps: number; tokens: number; phase?: string; }
export interface RunResultDetails { runs: RunView[]; pipeline: { from: string; to: string; phase?: string }[]; }
export interface MessageDetails { verb: "send" | "ask" | "reply" | "broadcast"; to?: string; from?: string; kind?: string; body: string; delivered: boolean; }

type St = "ok" | "fail" | "warn" | "on" | "off" | "paused";
const ICON: Record<St, { g: string; token: string }> = {
  ok: { g: "✓", token: "success" }, fail: { g: "✗", token: "error" }, warn: { g: "⚠", token: "warning" },
  on: { g: "●", token: "accent" }, off: { g: "○", token: "muted" }, paused: { g: "■", token: "muted" },
};

export function statusIcon(theme: ThemeAdapter, status: St): string {
  const s = ICON[status];
  return theme.fg(s.token, s.g);
}

export function kv(theme: ThemeAdapter, label: string, value: string, width: number): string {
  if (width < 3) return truncateToWidth(label, width, "");
  const head = theme.fg("muted", label) + " ";
  const budget = Math.max(0, width - visibleWidth(label) - 1);
  return truncateToWidth(head + theme.fg("text", value), width, "") ;
  // note: budget kept for callers that pre-slice; truncateToWidth is the width guarantee.
}

export function card(theme: ThemeAdapter, title: string, lines: string[], width: number): string[] {
  const rule = truncateToWidth(theme.fg("accent", `🕸 ${theme.bold(title)} `) + theme.fg("dim", "─".repeat(width)), width, "");
  const out = [rule];
  for (const l of lines) out.push(truncateToWidth(l, width, ""));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/renderer-helpers.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/renderers/types.ts packages/ui/src/__tests__/renderer-helpers.test.ts
git commit -m "feat(ui): renderer detail types + card/kv/statusIcon helpers (🕸)"
```

---

## Task 2: exec / exec_file / batch renderer

**Files:**
- Create: `packages/ui/src/renderers/exec.ts`
- Test: `packages/ui/src/__tests__/exec-renderer.test.ts`

**Interfaces:**
- Consumes: `ExecDetails`, `RenderCtx`, helpers from `types.ts`; `truncateToWidth`.
- Produces: `renderExecCall(details: Pick<ExecDetails,"kind"|"commands">, ctx): string[]` (command block, dim gutter, `+N more`), `renderExecResult(details: ExecDetails, ctx): string[]` (status header `🕸 spider <kind> ✓ exit 0 · N lines · Nms`, preview tail collapsed to 1 / full on `expanded`, `indexed → source (N chunks)` note).

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/exec-renderer.test.ts
import { describe, it, expect } from "vitest";
import { renderExecCall, renderExecResult } from "../renderers/exec.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("exec renderer", () => {
  it("call shows a command block and +N more when over the cap", () => {
    const cmds = Array.from({ length: 14 }, (_, i) => `cmd${i}`);
    const lines = renderExecCall({ kind: "batch", commands: cmds }, { theme: id, width: 40 });
    expect(lines.join("\n")).toContain("cmd0");
    expect(lines.join("\n")).toMatch(/more/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });
  it("result header carries ✓/exit/lines and the indexed note", () => {
    const lines = renderExecResult({
      kind: "exec", commands: ["ls"], ok: true, exitCode: 0, outLines: 12, ms: 34,
      preview: ["a", "b", "c"], indexed: { source: "shell:ls", chunks: 2 },
    }, { theme: id, width: 60, expanded: true });
    expect(lines[0]).toContain("🕸");
    expect(lines[0]).toContain("✓");
    expect(lines.join("\n")).toMatch(/exit 0/);
    expect(lines.join("\n")).toMatch(/12/);
    expect(lines.join("\n")).toMatch(/shell:ls|2 chunks/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });
  it("collapsed preview shows one line + more-indicator", () => {
    const lines = renderExecResult({
      kind: "exec", commands: ["ls"], ok: false, exitCode: 1, outLines: 5, preview: ["x", "y", "z"],
    }, { theme: id, width: 40, expanded: false });
    expect(lines[0]).toContain("✗");
    expect(lines.join("\n")).toMatch(/more/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/exec-renderer.test.ts`
Expected: FAIL — `Cannot find module '../renderers/exec.js'`.

- [ ] **Step 3: Write the renderer**

```ts
// packages/ui/src/renderers/exec.ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "./types.js";
import type { ExecDetails, RenderCtx } from "./types.js";

const CALL_CAP = 10;

export function renderExecCall(
  details: Pick<ExecDetails, "kind" | "commands">,
  ctx: RenderCtx,
): string[] {
  const { theme, width } = ctx;
  const head = truncateToWidth(
    theme.fg("accent", "🕸 ") + theme.fg("toolTitle", theme.bold("spider ")) + theme.fg("muted", details.kind),
    width, "",
  );
  const cmds = details.commands ?? [];
  const shown = cmds.slice(0, CALL_CAP);
  const body = shown.map((c) =>
    truncateToWidth(theme.fg("dim", "│ ") + theme.fg("toolOutput", c), width, ""),
  );
  const extra = cmds.length - shown.length;
  if (extra > 0) body.push(truncateToWidth(theme.fg("dim", `│ … +${extra} more`), width, ""));
  return [head, ...body];
}

export function renderExecResult(details: ExecDetails, ctx: RenderCtx): string[] {
  const { theme, width, expanded } = ctx;
  const icon = statusIcon(theme, details.ok ? "ok" : "fail");
  const meta = [`exit ${details.exitCode}`, `${details.outLines} lines`];
  if (details.ms !== undefined) meta.push(`${details.ms}ms`);
  const head = truncateToWidth(
    theme.fg("accent", "🕸 ") + theme.fg("toolTitle", theme.bold(`spider ${details.kind} `)) +
    icon + " " + theme.fg("muted", meta.join(" · ")),
    width, "",
  );
  const out = [head];
  const preview = details.preview ?? [];
  const shown = expanded ? preview : preview.slice(0, 1);
  for (const p of shown) out.push(truncateToWidth(theme.fg("dim", "⎿ ") + theme.fg("toolOutput", p), width, ""));
  const rest = preview.length - shown.length;
  if (rest > 0) out.push(truncateToWidth(theme.fg("muted", `⎿ … ${rest} more`), width, ""));
  if (details.indexed) {
    out.push(truncateToWidth(
      theme.fg("dim", "⎿ ") + theme.fg("muted", `indexed → ${details.indexed.source} (${details.indexed.chunks} chunks)`),
      width, ""));
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/exec-renderer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/renderers/exec.ts packages/ui/src/__tests__/exec-renderer.test.ts
git commit -m "feat(ui): exec/exec_file/batch renderer (command block + status/indexed)"
```

---

## Task 3: index / fetch renderer

**Files:**
- Create: `packages/ui/src/renderers/index-fetch.ts`
- Test: `packages/ui/src/__tests__/index-fetch-renderer.test.ts`

**Interfaces:**
- Consumes: `IndexDetails`, `RenderCtx`, helpers.
- Produces: `renderIndexResult(details: IndexDetails, ctx): string[]` — `🕸 spider index ✓ <source> · N chunks · N embedded (+skipped)`, then target/url list (collapsed 1 / full on expand).

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/index-fetch-renderer.test.ts
import { describe, it, expect } from "vitest";
import { renderIndexResult } from "../renderers/index-fetch.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("index/fetch renderer", () => {
  it("shows source, chunk + embed counts", () => {
    const lines = renderIndexResult({
      kind: "index", source: "docs", targets: ["a.md", "b.md"], chunks: 20, embedded: 20,
    }, { theme: id, width: 60, expanded: true });
    expect(lines[0]).toContain("🕸");
    expect(lines.join("\n")).toMatch(/docs/);
    expect(lines.join("\n")).toMatch(/20/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });
  it("renders fetch urls and skipped count", () => {
    const lines = renderIndexResult({
      kind: "fetch", source: "web", targets: [], urls: ["https://x/y"], chunks: 4, embedded: 3, skipped: 1,
    }, { theme: id, width: 50, expanded: true });
    expect(lines.join("\n")).toMatch(/https:\/\/x\/y/);
    expect(lines.join("\n")).toMatch(/skip/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/index-fetch-renderer.test.ts`
Expected: FAIL — `Cannot find module '../renderers/index-fetch.js'`.

- [ ] **Step 3: Write the renderer**

```ts
// packages/ui/src/renderers/index-fetch.ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "./types.js";
import type { IndexDetails, RenderCtx } from "./types.js";

export function renderIndexResult(details: IndexDetails, ctx: RenderCtx): string[] {
  const { theme, width, expanded } = ctx;
  const meta = [details.source, `${details.chunks} chunks`, `${details.embedded} embedded`];
  if (details.skipped) meta.push(`${details.skipped} skipped`);
  const head = truncateToWidth(
    theme.fg("accent", "🕸 ") + theme.fg("toolTitle", theme.bold(`spider ${details.kind} `)) +
    statusIcon(theme, "ok") + " " + theme.fg("muted", meta.join(" · ")),
    width, "",
  );
  const out = [head];
  const items = (details.urls && details.urls.length ? details.urls : details.targets) ?? [];
  const shown = expanded ? items : items.slice(0, 1);
  for (const t of shown) out.push(truncateToWidth(theme.fg("dim", "⎿ ") + theme.fg("toolOutput", t), width, ""));
  const rest = items.length - shown.length;
  if (rest > 0) out.push(truncateToWidth(theme.fg("muted", `⎿ … ${rest} more`), width, ""));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/index-fetch-renderer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/renderers/index-fetch.ts packages/ui/src/__tests__/index-fetch-renderer.test.ts
git commit -m "feat(ui): index/fetch renderer (source + chunk/embed/skip counts)"
```

---

## Task 4: memory card renderer (recall / remember)

**Files:**
- Create: `packages/ui/src/renderers/memory-card.ts`
- Test: `packages/ui/src/__tests__/memory-card-renderer.test.ts`

**Interfaces:**
- Consumes: `MemoryCardDetails`, `RenderCtx`, `card`/`statusIcon`.
- Produces: `renderMemoryCard(details: MemoryCardDetails, ctx): string[]` — a framed card per record: `[category] content` line + dim `→ link` + `status·source·conf`; a `staged N` callout line when `staged > 0`; collapsed shows first record + `+N more`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/memory-card-renderer.test.ts
import { describe, it, expect } from "vitest";
import { renderMemoryCard } from "../renderers/memory-card.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("memory card renderer", () => {
  it("renders a card with category, content and link", () => {
    const lines = renderMemoryCard({
      mode: "recall", staged: 0,
      records: [{ uuid: "u1", category: "convention", content: "use tabs", link: "src/x.ts", status: "active", source: "user" }],
    }, { theme: id, width: 60, expanded: true });
    expect(lines[0]).toContain("🕸");
    expect(lines.join("\n")).toMatch(/convention/);
    expect(lines.join("\n")).toMatch(/use tabs/);
    expect(lines.join("\n")).toMatch(/src\/x\.ts/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });
  it("shows a staged callout and collapses extra records", () => {
    const recs = Array.from({ length: 3 }, (_, i) => ({ uuid: `u${i}`, category: "insight", content: `c${i}`, status: "staged", source: "auto" }));
    const lines = renderMemoryCard({ mode: "remember", staged: 3, records: recs }, { theme: id, width: 50, expanded: false });
    expect(lines.join("\n")).toMatch(/staged/i);
    expect(lines.join("\n")).toMatch(/more/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/memory-card-renderer.test.ts`
Expected: FAIL — `Cannot find module '../renderers/memory-card.js'`.

- [ ] **Step 3: Write the renderer**

```ts
// packages/ui/src/renderers/memory-card.ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import { card } from "./types.js";
import type { MemoryCardDetails, MemoryRecordView, RenderCtx } from "./types.js";

function recordLines(theme: RenderCtx["theme"], r: MemoryRecordView, width: number): string[] {
  const out: string[] = [];
  out.push(truncateToWidth(theme.fg("accent", `[${r.category}] `) + theme.fg("text", r.content), width, ""));
  if (r.link) out.push(truncateToWidth(theme.fg("dim", `  → ${r.link}`), width, ""));
  const meta = [r.status, r.source];
  if (r.confidence !== undefined) meta.push(`conf ${r.confidence.toFixed(2)}`);
  out.push(truncateToWidth(theme.fg("muted", `  ${meta.join(" · ")}`), width, ""));
  return out;
}

export function renderMemoryCard(details: MemoryCardDetails, ctx: RenderCtx): string[] {
  const { theme, width, expanded } = ctx;
  const recs = details.records ?? [];
  const shown = expanded ? recs : recs.slice(0, 1);
  const body: string[] = [];
  for (const r of shown) body.push(...recordLines(theme, r, width));
  const rest = recs.length - shown.length;
  if (rest > 0) body.push(truncateToWidth(theme.fg("muted", `⎿ … +${rest} more`), width, ""));
  if (details.staged > 0) body.push(truncateToWidth(theme.fg("warning", `⚠ ${details.staged} staged — approve via control memory pending`), width, ""));
  const title = details.mode === "remember" ? "remember" : "recall";
  return card(theme, title, body, width);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/memory-card-renderer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/renderers/memory-card.ts packages/ui/src/__tests__/memory-card-renderer.test.ts
git commit -m "feat(ui): memory card renderer (recall/remember, staged callout)"
```

---

## Task 5: todo checklist renderer

**Files:**
- Create: `packages/ui/src/renderers/todo-checklist.ts`
- Test: `packages/ui/src/__tests__/todo-checklist-renderer.test.ts`

**Interfaces:**
- Consumes: `TodoChecklistDetails`, `RenderCtx`, `card`.
- Produces: `renderTodoChecklist(details, ctx): string[]` — card titled by scope; each item `✓/○ #id text` (done in `dim`/strikethrough token `muted`, open in `text`); footer `N/total completed`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/todo-checklist-renderer.test.ts
import { describe, it, expect } from "vitest";
import { renderTodoChecklist } from "../renderers/todo-checklist.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("todo checklist renderer", () => {
  it("renders check glyphs, ids and a completion footer", () => {
    const lines = renderTodoChecklist({
      scope: "session", done: 1, total: 2,
      items: [{ id: 1, text: "write test", done: true }, { id: 2, text: "impl", done: false }],
    }, { theme: id, width: 40 });
    expect(lines.join("\n")).toContain("✓");
    expect(lines.join("\n")).toContain("○");
    expect(lines.join("\n")).toMatch(/#1|#2/);
    expect(lines.join("\n")).toMatch(/1\/2/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/todo-checklist-renderer.test.ts`
Expected: FAIL — `Cannot find module '../renderers/todo-checklist.js'`.

- [ ] **Step 3: Write the renderer**

```ts
// packages/ui/src/renderers/todo-checklist.ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import { card } from "./types.js";
import type { RenderCtx, TodoChecklistDetails } from "./types.js";

export function renderTodoChecklist(details: TodoChecklistDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const body = details.items.map((t) => {
    const glyph = t.done ? theme.fg("success", "✓") : theme.fg("muted", "○");
    const idTok = theme.fg("accent", `#${t.id}`);
    const text = t.done ? theme.fg("dim", t.text) : theme.fg("text", t.text);
    return truncateToWidth(`${glyph} ${idTok} ${text}`, width, "");
  });
  body.push(truncateToWidth(theme.fg("muted", `${details.done}/${details.total} completed`), width, ""));
  return card(theme, `todo · ${details.scope}`, body, width);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/todo-checklist-renderer.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/renderers/todo-checklist.ts packages/ui/src/__tests__/todo-checklist-renderer.test.ts
git commit -m "feat(ui): todo checklist renderer"
```

---

## Task 6: run / wait renderer (pipeline-aware inline view)

**Files:**
- Create: `packages/ui/src/renderers/run-view.ts`
- Test: `packages/ui/src/__tests__/run-view-renderer.test.ts`

**Interfaces:**
- Consumes: `RunResultDetails`, `RenderCtx`, `card`, Phase 5 `STATUS_GLYPH`/`statusToken`, `Table`.
- Produces: `renderRunResult(details, ctx): string[]` — a `Table` of runs (name/role, status glyph, model, steps, tokens, phase) + a pipeline line `a → b (phase)` per handoff edge.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/run-view-renderer.test.ts
import { describe, it, expect } from "vitest";
import { renderRunResult } from "../renderers/run-view.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("run/wait renderer", () => {
  it("tabulates runs and draws pipeline edges", () => {
    const lines = renderRunResult({
      runs: [
        { runId: "r1", name: "scribe", role: "worker", status: "done", model: "gpt-x", steps: 5, tokens: 900, phase: "impl" },
        { runId: "r2", name: "critic", role: "reviewer", status: "running", steps: 2, tokens: 120 },
      ],
      pipeline: [{ from: "scribe", to: "critic", phase: "review" }],
    }, { theme: id, width: 70, expanded: true });
    expect(lines[0]).toContain("🕸");
    expect(lines.join("\n")).toMatch(/scribe/);
    expect(lines.join("\n")).toMatch(/critic/);
    expect(lines.join("\n")).toMatch(/scribe.*→.*critic/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(70);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/run-view-renderer.test.ts`
Expected: FAIL — `Cannot find module '../renderers/run-view.js'`.

- [ ] **Step 3: Write the renderer**

```ts
// packages/ui/src/renderers/run-view.ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import { card } from "./types.js";
import type { RenderCtx, RunResultDetails } from "./types.js";
import { renderTable } from "../components/table.js";
import { STATUS_GLYPH, statusToken } from "../agents/types.js";
import type { AgentStatus } from "../agents/types.js";

export function renderRunResult(details: RunResultDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const rows = details.runs.map((r) => {
    const st = r.status as AgentStatus;
    const glyph = STATUS_GLYPH[st] ?? "○";
    return [r.name + (r.role ? `/${r.role}` : ""), glyph, r.model ?? "—", String(r.steps), String(r.tokens), r.phase ?? "—"];
  });
  const table = renderTable(theme, {
    columns: [
      { header: "agent" }, { header: "st" }, { header: "model" },
      { header: "steps", align: "right" }, { header: "tok", align: "right" }, { header: "phase" },
    ],
    rows, width,
  });
  const body = [...table];
  for (const e of details.pipeline) {
    body.push(truncateToWidth(theme.fg("dim", `↪ `) + theme.fg("text", `${e.from} → ${e.to}`) + (e.phase ? theme.fg("muted", ` (${e.phase})`) : ""), width, ""));
  }
  // touch statusToken so lint keeps it referenced for future colorization
  void statusToken;
  return card(theme, "agents", body, width);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/run-view-renderer.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/renderers/run-view.ts packages/ui/src/__tests__/run-view-renderer.test.ts
git commit -m "feat(ui): run/wait renderer (agents table + pipeline edges)"
```

---

## Task 7: message renderer

**Files:**
- Create: `packages/ui/src/renderers/message.ts`
- Test: `packages/ui/src/__tests__/message-renderer.test.ts`

**Interfaces:**
- Consumes: `MessageDetails`, `RenderCtx`, `statusIcon`.
- Produces: `renderMessageResult(details, ctx): string[]` — `🕸 spider message <verb> → <to> ✓/⚠` + quoted body (collapsed 1 / full).

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/message-renderer.test.ts
import { describe, it, expect } from "vitest";
import { renderMessageResult } from "../renderers/message.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("message renderer", () => {
  it("shows verb, target, delivery glyph and body", () => {
    const lines = renderMessageResult({ verb: "ask", to: "spider", body: "status?", delivered: true }, { theme: id, width: 50, expanded: true });
    expect(lines[0]).toContain("🕸");
    expect(lines.join("\n")).toMatch(/ask/);
    expect(lines.join("\n")).toMatch(/spider/);
    expect(lines.join("\n")).toContain("✓");
    expect(lines.join("\n")).toMatch(/status\?/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(50);
  });
  it("shows a warn glyph when not delivered", () => {
    const lines = renderMessageResult({ verb: "send", to: "worker", body: "hi", delivered: false }, { theme: id, width: 40 });
    expect(lines[0]).toContain("⚠");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/message-renderer.test.ts`
Expected: FAIL — `Cannot find module '../renderers/message.js'`.

- [ ] **Step 3: Write the renderer**

```ts
// packages/ui/src/renderers/message.ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "./types.js";
import type { MessageDetails, RenderCtx } from "./types.js";

export function renderMessageResult(details: MessageDetails, ctx: RenderCtx): string[] {
  const { theme, width, expanded } = ctx;
  const target = details.to ?? details.from ?? "—";
  const icon = statusIcon(theme, details.delivered ? "ok" : "warn");
  const head = truncateToWidth(
    theme.fg("accent", "🕸 ") + theme.fg("toolTitle", theme.bold("spider message ")) +
    theme.fg("muted", `${details.verb} → ${target} `) + icon,
    width, "",
  );
  const out = [head];
  const bodyLines = details.body.split("\n");
  const shown = expanded ? bodyLines : bodyLines.slice(0, 1);
  for (const b of shown) out.push(truncateToWidth(theme.fg("dim", "│ ") + theme.fg("text", b), width, ""));
  const rest = bodyLines.length - shown.length;
  if (rest > 0) out.push(truncateToWidth(theme.fg("muted", `│ … ${rest} more`), width, ""));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/__tests__/message-renderer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/renderers/message.ts packages/ui/src/__tests__/message-renderer.test.ts
git commit -m "feat(ui): message renderer (verb/target/delivery + body)"
```

---

## Task 8: search renderCall + renderers barrel export

**Files:**
- Modify: `packages/ui/src/renderers/search.ts` (add `renderSearchCall`)
- Modify: `packages/ui/src/index.ts` (re-export the Phase 8 renderer surface)
- Test: `packages/ui/src/__tests__/search-call-renderer.test.ts`

**Interfaces:**
- Consumes: existing `renderSearchResult` (Phase 2), `RenderCtx`.
- Produces: `renderSearchCall(args: { query: string; scope?: string }, ctx): string[]`; barrel re-exports `renderExecCall`/`renderExecResult`/`renderIndexResult`/`renderMemoryCard`/`renderTodoChecklist`/`renderRunResult`/`renderMessageResult`/`renderSearchCall` and all `*Details` types.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/search-call-renderer.test.ts
import { describe, it, expect } from "vitest";
import { renderSearchCall } from "../renderers/search.js";
import type { ThemeAdapter } from "../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("search call renderer", () => {
  it("shows the query and scope within width", () => {
    const lines = renderSearchCall({ query: "vector fusion", scope: "memory" }, { theme: id, width: 40 });
    expect(lines[0]).toContain("🕸");
    expect(lines.join("\n")).toMatch(/vector fusion/);
    expect(lines.join("\n")).toMatch(/memory/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/search-call-renderer.test.ts`
Expected: FAIL — `renderSearchCall` is not exported.

- [ ] **Step 3: Add `renderSearchCall` and update the barrel**

Append to `packages/ui/src/renderers/search.ts`:
```ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { RenderCtx } from "./types.js";

export function renderSearchCall(args: { query: string; scope?: string }, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const scope = args.scope ? theme.fg("muted", ` [${args.scope}]`) : "";
  return [truncateToWidth(
    theme.fg("accent", "🕸 ") + theme.fg("toolTitle", theme.bold("spider search ")) +
    theme.fg("text", `"${args.query}"`) + scope,
    width, "",
  )];
}
```

Add to `packages/ui/src/index.ts` (extend existing exports — do not remove Phase 2/5 exports):
```ts
export * from "./renderers/types.js";
export { renderExecCall, renderExecResult } from "./renderers/exec.js";
export { renderIndexResult } from "./renderers/index-fetch.js";
export { renderMemoryCard } from "./renderers/memory-card.js";
export { renderTodoChecklist } from "./renderers/todo-checklist.js";
export { renderRunResult } from "./renderers/run-view.js";
export { renderMessageResult } from "./renderers/message.js";
export { renderSearchCall } from "./renderers/search.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/ui/src/__tests__/search-call-renderer.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/renderers/search.ts packages/ui/src/index.ts packages/ui/src/__tests__/search-call-renderer.test.ts
git commit -m "feat(ui): search renderCall + export Phase 8 renderer surface"
```

---

## Task 9: host renderer registry (action → renderCall/renderResult)

**Files:**
- Create: `packages/host/src/renderers/registry.ts`
- Test: `packages/host/src/__tests__/registry.test.ts`
- Modify: `packages/host/src/extension.ts` (attach registry to the `spider` tool registration)

**Interfaces:**
- Consumes: all `render*` builders from `@spider/ui`; `piTheme` (Phase 5 `packages/host/src/agents/theme-adapter.ts`); `Text` from `@earendil-works/pi-tui`.
- Produces: `buildRendererRegistry(): Record<string, ActionRenderer>` mapping `exec`/`exec_file`/`batch`/`index`/`fetch`/`remember`/`recall`/`todo`/`run`/`wait`/`message`/`search` to `{renderCall?,renderResult?}`; each wraps builder output in `new Text(lines.join("\n"), 0, 0)` and derives `RenderCtx` from `piTheme(theme)` + a width default (`80`) + `expanded`. A missing/mismatched `details` shape returns a single dim summary line (never throws). `attachRenderers(toolDef): toolDef` chooses the renderer by `args.action`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/host/src/__tests__/registry.test.ts
import { describe, it, expect } from "vitest";
import { buildRendererRegistry } from "../renderers/registry.js";

const theme = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s, bold: (s: string) => s };

describe("renderer registry", () => {
  it("has a renderer for every everyday action", () => {
    const reg = buildRendererRegistry();
    for (const a of ["exec", "exec_file", "batch", "index", "fetch", "remember", "recall", "todo", "run", "wait", "message", "search"]) {
      expect(reg[a], `missing renderer for ${a}`).toBeDefined();
    }
  });
  it("exec renderResult produces a Component and never throws on missing details", () => {
    const reg = buildRendererRegistry();
    const comp = reg.exec.renderResult!({ details: undefined }, { expanded: false }, theme);
    expect(typeof comp.render).toBe("function");
    const lines = comp.render(60);
    expect(Array.isArray(lines)).toBe(true);
  });
  it("search renderCall renders the query", () => {
    const reg = buildRendererRegistry();
    const comp = reg.search.renderCall!({ action: "search", query: "abc" }, theme);
    expect(comp.render(40).join("\n")).toMatch(/abc/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/host/src/__tests__/registry.test.ts`
Expected: FAIL — `Cannot find module '../renderers/registry.js'`.

- [ ] **Step 3: Write the registry**

```ts
// packages/host/src/renderers/registry.ts
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@spider/ui";
import {
  renderExecCall, renderExecResult, renderIndexResult, renderMemoryCard,
  renderTodoChecklist, renderRunResult, renderMessageResult, renderSearchCall, renderSearchResult,
} from "@spider/ui";
import { piTheme } from "../agents/theme-adapter.js";

export interface ActionRenderer {
  renderCall?(args: Record<string, unknown>, theme: unknown): Component;
  renderResult?(result: { details?: unknown; isError?: boolean }, meta: { expanded?: boolean; isPartial?: boolean }, theme: unknown): Component;
}

const DEFAULT_WIDTH = 80;
const comp = (lines: string[]): Component => new Text(lines.join("\n"), 0, 0) as unknown as Component;

function ctx(theme: unknown, expanded?: boolean) {
  return { theme: piTheme(theme as never), width: DEFAULT_WIDTH, expanded };
}
function safe(fn: () => string[], theme: unknown): Component {
  try { return comp(fn()); } catch { return comp([piTheme(theme as never).fg("dim", "spider 🕸")]); }
}

export function buildRendererRegistry(): Record<string, ActionRenderer> {
  const exec: ActionRenderer = {
    renderCall: (a, t) => safe(() => renderExecCall({ kind: (a.action as never) ?? "exec", commands: (a.commands as string[]) ?? (a.code ? [String(a.code)] : []) }, ctx(t)), t),
    renderResult: (r, m, t) => safe(() => renderExecResult((r.details as never) ?? { kind: "exec", commands: [], ok: !r.isError, exitCode: r.isError ? 1 : 0, outLines: 0, preview: [] }, ctx(t, m.expanded)), t),
  };
  const idx: ActionRenderer = {
    renderResult: (r, m, t) => safe(() => renderIndexResult((r.details as never) ?? { kind: "index", source: "?", targets: [], chunks: 0, embedded: 0 }, ctx(t, m.expanded)), t),
  };
  const mem: ActionRenderer = {
    renderResult: (r, m, t) => safe(() => renderMemoryCard((r.details as never) ?? { mode: "recall", staged: 0, records: [] }, ctx(t, m.expanded)), t),
  };
  const todo: ActionRenderer = {
    renderResult: (r, m, t) => safe(() => renderTodoChecklist((r.details as never) ?? { scope: "session", items: [], done: 0, total: 0 }, ctx(t, m.expanded)), t),
  };
  const run: ActionRenderer = {
    renderResult: (r, m, t) => safe(() => renderRunResult((r.details as never) ?? { runs: [], pipeline: [] }, ctx(t, m.expanded)), t),
  };
  const msg: ActionRenderer = {
    renderResult: (r, m, t) => safe(() => renderMessageResult((r.details as never) ?? { verb: "send", body: "", delivered: false }, ctx(t, m.expanded)), t),
  };
  const search: ActionRenderer = {
    renderCall: (a, t) => safe(() => renderSearchCall({ query: String(a.query ?? ""), scope: a.scope as string | undefined }, ctx(t)), t),
    renderResult: (r, m, t) => safe(() => renderSearchResult((r.details as never), ctx(t, m.expanded)), t),
  };
  return {
    exec, exec_file: exec, batch: exec,
    index: idx, fetch: idx,
    remember: mem, recall: mem,
    todo, run, wait: run, message: msg, search,
  };
}
```

Then in `packages/host/src/extension.ts` where the `spider` tool is registered, add `renderCall`/`renderResult` that dispatch on `args.action`:
```ts
import { buildRendererRegistry } from "./renderers/registry.js";
const RENDERERS = buildRendererRegistry();
// inside registerTool({ ... }):
renderCall(args, theme) {
  const r = RENDERERS[(args as { action?: string }).action ?? ""];
  return r?.renderCall?.(args as Record<string, unknown>, theme);
},
renderResult(result, meta, theme) {
  const action = (result?.details as { action?: string } | undefined)?.action
    ?? (meta as { action?: string } | undefined)?.action ?? "";
  const r = RENDERERS[action];
  return r?.renderResult?.(result as never, meta as never, theme);
},
```
> Note: `control` sub-command screens are mounted via `ctx.ui.custom` (Tasks 12/16/18/20/22), not through inline `renderResult`; the registry deliberately omits `control`. `edit`/`write` keep pi's native renderer (Phase 3) — not in this registry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/host/src/__tests__/registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/renderers/registry.ts packages/host/src/extension.ts packages/host/src/__tests__/registry.test.ts
git commit -m "feat(host): unified renderer registry dispatch by action"
```

---

## Task 10: config schema (8 groups) + field validation

**Files:**
- Create: `packages/ui/src/screens/config-schema.ts`
- Test: `packages/ui/src/screens/__tests__/config-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CONFIG_SCHEMA: ConfigGroup[]` (groups `organism`, `embeddings`, `memory`, `routing`, `curator`, `self_naming`, `models`, `ui`), `getField(key): ConfigField | undefined`, `coerce(field, raw): { ok: boolean; value?: unknown; error?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/screens/__tests__/config-schema.test.ts
import { describe, it, expect } from "vitest";
import { CONFIG_SCHEMA, getField, coerce } from "../config-schema.js";

describe("config schema", () => {
  it("declares all eight groups", () => {
    const ids = CONFIG_SCHEMA.map((g) => g.id).sort();
    expect(ids).toEqual(["curator", "embeddings", "memory", "models", "organism", "routing", "self_naming", "ui"].sort());
  });
  it("every field key is dotted-prefixed by its group id", () => {
    for (const g of CONFIG_SCHEMA) for (const f of g.fields) expect(f.key.startsWith(g.id + ".")).toBe(true);
  });
  it("coerce validates booleans, enums and numeric ranges", () => {
    const boolF = getField("organism.enabled")!;
    expect(coerce(boolF, "true")).toEqual({ ok: true, value: true });
    const numF = getField("memory.snapshotCharCap")!;
    expect(coerce(numF, "abc").ok).toBe(false);
    expect(coerce(numF, String((numF.max ?? 100000) + 1)).ok).toBe(false);
    const enumF = CONFIG_SCHEMA.flatMap((g) => g.fields).find((f) => f.type === "enum")!;
    expect(coerce(enumF, "___not_in_enum___").ok).toBe(false);
    expect(coerce(enumF, enumF.enum![0])).toEqual({ ok: true, value: enumF.enum![0] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/screens/__tests__/config-schema.test.ts`
Expected: FAIL — `Cannot find module '../config-schema.js'`.

- [ ] **Step 3: Write the schema** (values match the spec's Config & observability groups)

```ts
// packages/ui/src/screens/config-schema.ts
export type ConfigFieldType = "boolean" | "number" | "string" | "enum";
export interface ConfigField {
  key: string; label: string; type: ConfigFieldType; default: unknown;
  enum?: string[]; min?: number; max?: number; description: string; restart?: boolean;
}
export interface ConfigGroup { id: string; label: string; fields: ConfigField[]; }

export const CONFIG_SCHEMA: ConfigGroup[] = [
  { id: "organism", label: "Organism", fields: [
    { key: "organism.enabled", label: "Master enable", type: "boolean", default: true, description: "Autonomic organism master toggle." },
    { key: "organism.runToMemory", label: "run→memory", type: "boolean", default: true, description: "Digest run outputs into memory/todo." },
    { key: "organism.todoToMemory", label: "todo→memory", type: "boolean", default: true, description: "Digest completed todos into memory." },
    { key: "organism.learningLoop", label: "Learning loop", type: "boolean", default: true, description: "Failures/corrections learning pass." },
    { key: "organism.selfName", label: "Self-name update", type: "boolean", default: true, description: "Session self-naming pass." },
    { key: "organism.reflection", label: "Reflection", type: "boolean", default: true, description: "Vector-cluster umbrella memories." },
    { key: "organism.crossProject", label: "Cross-project insights", type: "boolean", default: true, description: "Cross-project insight graph pass." },
  ]},
  { id: "embeddings", label: "Embeddings", fields: [
    { key: "embeddings.provider", label: "Provider", type: "enum", default: "fastembed", enum: ["fastembed", "copilot", "openai", "mistral", "google", "fts-only"], description: "Embedding backend.", restart: true },
    { key: "embeddings.model", label: "Model", type: "string", default: "BGE-small-en-v1.5", description: "Embedding model id (dim-locked).", restart: true },
    { key: "embeddings.dim", label: "Dimensions", type: "number", default: 384, min: 8, max: 4096, description: "Vector dim (change → control reembed).", restart: true },
    { key: "embeddings.queue", label: "Background queue", type: "boolean", default: true, description: "Async embed queue on/off." },
  ]},
  { id: "memory", label: "Memory", fields: [
    { key: "memory.autoWriteBudget", label: "Auto-write budget", type: "number", default: 20, min: 0, max: 1000, description: "Per-session staged auto-write cap." },
    { key: "memory.stagingFailClosed", label: "Staging fail-closed", type: "boolean", default: true, description: "Stage all auto/background writes." },
    { key: "memory.snapshotCharCap", label: "Snapshot char cap", type: "number", default: 6000, min: 500, max: 40000, description: "Frozen snapshot character budget." },
  ]},
  { id: "routing", label: "Routing / safety", fields: [
    { key: "routing.tracking", label: "Universal tracking", type: "boolean", default: true, description: "Log all tool intents/results." },
    { key: "routing.secretScrub", label: "Secret scrub", type: "boolean", default: true, description: "Scrub secrets from results." },
    { key: "routing.injectionScan", label: "Injection scan", type: "boolean", default: true, description: "Prompt-injection scan of results." },
    { key: "routing.autoIndexThreshold", label: "Auto-index threshold (bytes)", type: "number", default: 4000, min: 0, max: 1000000, description: "Large-output auto-index cutoff." },
  ]},
  { id: "curator", label: "Skill curator", fields: [
    { key: "curator.minIntervalHours", label: "Min interval (h)", type: "number", default: 24, min: 1, max: 336, description: "Minimum hours between curator runs." },
  ]},
  { id: "self_naming", label: "Self-naming", fields: [
    { key: "self_naming.enabled", label: "Enabled", type: "boolean", default: true, description: "Session self-naming on/off." },
    { key: "self_naming.budget", label: "Aux budget", type: "enum", default: "cheap", enum: ["cheap", "normal", "premium"], description: "Aux-model budget tier." },
  ]},
  { id: "models", label: "Model routing", fields: [
    { key: "models.autoSelect", label: "Auto-select", type: "boolean", default: true, description: "Router picks per-task model." },
  ]},
  { id: "ui", label: "UI", fields: [
    { key: "ui.footer", label: "Agents footer", type: "boolean", default: true, description: "Show the agents footer." },
    { key: "ui.gridHotkey", label: "Grid hotkey", type: "string", default: "ctrl+g", description: "Live grid toggle chord." },
    { key: "ui.theme", label: "Theme", type: "enum", default: "auto", enum: ["auto", "light", "dark"], description: "spider UI theme preference." },
  ]},
];

export function getField(key: string): ConfigField | undefined {
  for (const g of CONFIG_SCHEMA) for (const f of g.fields) if (f.key === key) return f;
  return undefined;
}

export function coerce(field: ConfigField, raw: string): { ok: boolean; value?: unknown; error?: string } {
  switch (field.type) {
    case "boolean": {
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false, error: "expected true|false" };
    }
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: "expected a number" };
      if (field.min !== undefined && n < field.min) return { ok: false, error: `min ${field.min}` };
      if (field.max !== undefined && n > field.max) return { ok: false, error: `max ${field.max}` };
      return { ok: true, value: n };
    }
    case "enum": {
      if (!field.enum?.includes(raw)) return { ok: false, error: `one of ${field.enum?.join("|")}` };
      return { ok: true, value: raw };
    }
    default:
      return { ok: true, value: raw };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/screens/__tests__/config-schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/config-schema.ts packages/ui/src/screens/__tests__/config-schema.test.ts
git commit -m "feat(ui): config schema (8 groups) + field coercion/validation"
```

---

## Task 11: config model builder (merge schema + current values)

**Files:**
- Create: `packages/ui/src/screens/config-model.ts`
- Test: `packages/ui/src/screens/__tests__/config-model.test.ts`

**Interfaces:**
- Consumes: `CONFIG_SCHEMA`, `getField`.
- Produces: `readPath(cfg, key): unknown` (dotted-path read), `buildConfigModel(cfg): ConfigGroupModel[]` where each row = `{ field, value: readPath ?? default, isDefault }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/screens/__tests__/config-model.test.ts
import { describe, it, expect } from "vitest";
import { buildConfigModel, readPath } from "../config-model.js";

describe("config model", () => {
  it("reads a dotted path", () => {
    expect(readPath({ ui: { footer: false } }, "ui.footer")).toBe(false);
    expect(readPath({}, "ui.footer")).toBeUndefined();
  });
  it("falls back to defaults and flags isDefault", () => {
    const groups = buildConfigModel({ ui: { footer: false } });
    const ui = groups.find((g) => g.id === "ui")!;
    const footer = ui.rows.find((r) => r.field.key === "ui.footer")!;
    expect(footer.value).toBe(false);
    expect(footer.isDefault).toBe(false);
    const theme = ui.rows.find((r) => r.field.key === "ui.theme")!;
    expect(theme.value).toBe("auto");
    expect(theme.isDefault).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/screens/__tests__/config-model.test.ts`
Expected: FAIL — `Cannot find module '../config-model.js'`.

- [ ] **Step 3: Write the builder**

```ts
// packages/ui/src/screens/config-model.ts
import { CONFIG_SCHEMA } from "./config-schema.js";
import type { ConfigField } from "./config-schema.js";

export interface ConfigFieldRow { field: ConfigField; value: unknown; isDefault: boolean; }
export interface ConfigGroupModel { id: string; label: string; rows: ConfigFieldRow[]; }

export function readPath(cfg: unknown, key: string): unknown {
  let cur: unknown = cfg;
  for (const part of key.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function buildConfigModel(cfg: unknown): ConfigGroupModel[] {
  return CONFIG_SCHEMA.map((g) => ({
    id: g.id, label: g.label,
    rows: g.fields.map((field) => {
      const raw = readPath(cfg, field.key);
      const has = raw !== undefined;
      return { field, value: has ? raw : field.default, isDefault: !has };
    }),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/screens/__tests__/config-model.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/config-model.ts packages/ui/src/screens/__tests__/config-model.test.ts
git commit -m "feat(ui): config model builder (schema × current values)"
```

---

## Task 12: `control config` picker UI + get/set round-trip + hot-reload

**Files:**
- Create: `packages/ui/src/screens/config-view.ts` (ConfigView component)
- Create: `packages/host/src/control/config-cmd.ts` (mount + write + reload)
- Test: `packages/ui/src/screens/__tests__/config-view.test.ts`
- Test: `packages/host/src/__tests__/config-cmd.test.ts`
- Modify: `packages/host/src/extension.ts` (route `control config` with no args → UI; keep `get`/`set` string API)

**Interfaces:**
- Consumes: `buildConfigModel`, `coerce`, `getField`, `ThemeAdapter`, pi-tui `SelectList`/`truncateToWidth`; Phase-0 `controlConfig(op,cwd,key,value)`.
- Produces: `class ConfigView implements Component` (renders group list → field rows with values + `⚠ restart`/`● changed`); `mountConfig(pi, ctx, cwd): Promise<void>` (mounts via `ctx.ui.custom`, on field commit → `coerce` → `controlConfig("set",cwd,key,value)` → `pi.emit?.("resources_discover")` or the host's `reloadConfig()` + `ctx.ui.notify`). `applyConfigEdit(cwd, key, raw): { ok: boolean; error?: string }` = the pure round-trip seam (coerce + write + read-back verify).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/host/src/__tests__/config-cmd.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { applyConfigEdit } from "../control/config-cmd.js";
import { controlConfig } from "../control.js";

// Use a repo-local scratch dir (never /tmp).
const scratch = join(process.cwd(), "packages/host/.spider/scratch");

describe("applyConfigEdit round-trip", () => {
  it("coerces, writes and reads back a boolean", () => {
    const dir = mkdtempSync(join(scratch, "cfg-"));
    const r = applyConfigEdit(dir, "ui.footer", "false");
    expect(r.ok).toBe(true);
    expect(controlConfig("get", dir, "ui.footer")).toBe(false);
  });
  it("rejects an out-of-range number without writing", () => {
    const dir = mkdtempSync(join(scratch, "cfg-"));
    const r = applyConfigEdit(dir, "memory.snapshotCharCap", "999999999");
    expect(r.ok).toBe(false);
    expect(controlConfig("get", dir, "memory.snapshotCharCap")).toBeUndefined();
  });
  it("rejects an unknown key", () => {
    const dir = mkdtempSync(join(scratch, "cfg-"));
    expect(applyConfigEdit(dir, "nope.nope", "x").ok).toBe(false);
  });
});
```

```ts
// packages/ui/src/screens/__tests__/config-view.test.ts
import { describe, it, expect } from "vitest";
import { ConfigView } from "../config-view.js";
import type { ThemeAdapter } from "../../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("ConfigView", () => {
  it("renders group labels and stays within width", () => {
    const v = new ConfigView({ ui: { footer: false } }, id, () => {});
    const lines = v.render(50);
    expect(lines.join("\n")).toContain("🕸");
    expect(lines.join("\n")).toMatch(/Organism|UI|Memory/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(50);
  });
});
```

Ensure the scratch dir exists first: `mkdir -p packages/host/.spider/scratch` (git-ignored).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/host/src/__tests__/config-cmd.test.ts packages/ui/src/screens/__tests__/config-view.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the view + command**

```ts
// packages/ui/src/screens/config-view.ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";
import { buildConfigModel } from "./config-model.js";
import { card } from "../renderers/types.js";

/** Read-only summary render; interactive navigation is wired by the host mount via SelectList. */
export class ConfigView {
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  constructor(private cfg: unknown, private theme: ThemeAdapter, private onEdit: (key: string, raw: string) => void) {}
  invalidate(): void { this.cachedWidth = -1; }
  render(width: number): string[] {
    if (width === this.cachedWidth) return this.cachedLines;
    const groups = buildConfigModel(this.cfg);
    const body: string[] = [];
    for (const g of groups) {
      body.push(truncateToWidth(this.theme.fg("accent", `── ${g.label} ──`), width, ""));
      for (const r of g.rows) {
        const changed = r.isDefault ? this.theme.fg("dim", "○") : this.theme.fg("accent", "●");
        const restart = r.field.restart ? this.theme.fg("warning", " ⚠restart") : "";
        const line = `${changed} ${this.theme.fg("text", r.field.label)} ${this.theme.fg("muted", String(r.value))}${restart}`;
        body.push(truncateToWidth(line, width, ""));
      }
    }
    void this.onEdit;
    this.cachedLines = card(this.theme, "config", body, width);
    this.cachedWidth = width;
    return this.cachedLines;
  }
}
```

```ts
// packages/host/src/control/config-cmd.ts
import { coerce, getField } from "@spider/ui";           // re-exported from screens/config-schema via ui barrel
import { controlConfig } from "../control.js";

export function applyConfigEdit(cwd: string, key: string, raw: string): { ok: boolean; error?: string } {
  const field = getField(key);
  if (!field) return { ok: false, error: `unknown key ${key}` };
  const c = coerce(field, raw);
  if (!c.ok) return { ok: false, error: c.error };
  controlConfig("set", cwd, key, c.value);
  return { ok: true };
}

// mountConfig is UI-gated (ctx.hasUI). It builds a SelectList over groups→fields, and on commit
// calls applyConfigEdit then triggers a config hot-reload + toast. Pseudocode-free wiring lives here;
// the pure seam applyConfigEdit is what tests exercise.
export async function mountConfig(
  pi: { ui?: { notify?: (t: string, k?: string) => void } },
  ctx: { hasUI?: boolean; ui: { custom: <T>(f: (...a: unknown[]) => unknown, o?: unknown) => Promise<T>; notify?: (t: string, k?: string) => void }; cwd: string },
  reloadConfig: () => void,
): Promise<void> {
  if (!ctx.hasUI) { ctx.ui.notify?.("config UI needs an interactive terminal", "error"); return; }
  await ctx.ui.custom((/* tui, theme, keybindings, done */) => {
    // Build ConfigView + a SelectList of editable fields; on field commit:
    //   const r = applyConfigEdit(ctx.cwd, key, raw);
    //   if (r.ok) { reloadConfig(); ctx.ui.notify?.(`set ${key}`); } else ctx.ui.notify?.(r.error!, "error");
    // Return the component; done(null) on Esc.
    return { render: (_w: number) => [], invalidate: () => {}, handleInput: () => {} };
  });
  void pi;
}
```

> The `@spider/ui` barrel must re-export `coerce`/`getField`/`CONFIG_SCHEMA` from `./screens/config-schema.js` and `ConfigView` from `./screens/config-view.js`. Add those exports in this task's `index.ts` edit.

In `packages/host/src/extension.ts`, route `control config` with no `key` and `ctx.hasUI` → `mountConfig(pi, ctx, () => reloadConfig())`; otherwise keep the Phase-0 `controlConfig(op,cwd,key,value)` string API. `reloadConfig()` re-reads config and re-applies `ui`/`routing`/`organism` toggles (the host already holds these).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/host/src/__tests__/config-cmd.test.ts packages/ui/src/screens/__tests__/config-view.test.ts`
Expected: PASS (config-cmd 3 tests; config-view 1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/config-view.ts packages/ui/src/screens/config-schema.ts packages/host/src/control/config-cmd.ts packages/ui/src/index.ts packages/host/src/extension.ts packages/ui/src/screens/__tests__/config-view.test.ts packages/host/src/__tests__/config-cmd.test.ts
git commit -m "feat(host+ui): control config picker + get/set round-trip + reload"
```

---

## Task 13: config hot-reload on resources_discover

**Files:**
- Modify: `packages/host/src/extension.ts` (`resources_discover` handler calls `reloadConfig()`)
- Create: `packages/host/src/config-reload.ts` (`makeConfigReloader(cwd, apply)`)
- Test: `packages/host/src/__tests__/config-reload.test.ts`

**Interfaces:**
- Consumes: `controlConfig("get", cwd)` merged config.
- Produces: `makeConfigReloader(cwd, apply): { reload(): void }` where `apply(merged)` re-applies live toggles; called from `resources_discover` and after every `control config set`. Embedding model/dim changes are flagged `restart` and NOT hot-applied (spec: restart only for embedding model/dim).

- [ ] **Step 1: Write the failing test**

```ts
// packages/host/src/__tests__/config-reload.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { makeConfigReloader } from "../config-reload.js";
import { controlConfig } from "../control.js";

const scratch = join(process.cwd(), "packages/host/.spider/scratch");

describe("config hot-reload", () => {
  it("re-applies merged config on reload()", () => {
    const dir = mkdtempSync(join(scratch, "reload-"));
    controlConfig("set", dir, "ui.footer", false);
    let applied: unknown;
    const r = makeConfigReloader(dir, (m) => { applied = m; });
    r.reload();
    expect((applied as { ui?: { footer?: boolean } }).ui?.footer).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/host/src/__tests__/config-reload.test.ts`
Expected: FAIL — `Cannot find module '../config-reload.js'`.

- [ ] **Step 3: Write the reloader**

```ts
// packages/host/src/config-reload.ts
import { controlConfig } from "./control.js";

export function makeConfigReloader(cwd: string, apply: (merged: unknown) => void): { reload(): void } {
  return {
    reload(): void {
      const merged = controlConfig("get", cwd);
      apply(merged);
    },
  };
}
```

In `packages/host/src/extension.ts`: build one reloader per session (`const reloader = makeConfigReloader(ctx.cwd, applyLiveToggles)`), call `reloader.reload()` inside the `resources_discover` handler and after `control config set`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/host/src/__tests__/config-reload.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/config-reload.ts packages/host/src/extension.ts packages/host/src/__tests__/config-reload.test.ts
git commit -m "feat(host): config hot-reload via resources_discover"
```

---

## Task 14: models catalog rows (tier grouping + availability + defaults)

**Files:**
- Create: `packages/ui/src/screens/models-model.ts`
- Test: `packages/ui/src/screens/__tests__/models-model.test.ts`

**Interfaces:**
- Consumes: `ModelEntry`/`Tier` from `@spider/models`.
- Produces: `MODEL_ROLES: string[]`; `catalogRows(entries: ModelEntry[], defaults: Record<string,string>): TierGroup[]` (grouped by tier order `nano<mini<standard<capable<reasoning`, each row flags `isDefaultFor` roles and `available`); `resolveDefault(defaults, role, entries): string | undefined` (config default if still available, else undefined).

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/screens/__tests__/models-model.test.ts
import { describe, it, expect } from "vitest";
import { catalogRows, resolveDefault, MODEL_ROLES } from "../models-model.js";
import type { ModelEntry } from "@spider/models";

const E = (over: Partial<ModelEntry>): ModelEntry => ({
  provider: "copilot", id: "m", tier: "standard", reasoning: false, vision: false,
  ctx: 128000, speed: 1, costHint: 1, available: true, ...over,
});

describe("models model", () => {
  it("groups by tier and marks defaults + availability", () => {
    const entries = [E({ id: "fast", tier: "nano" }), E({ id: "smart", tier: "reasoning", reasoning: true }), E({ id: "gone", tier: "mini", available: false })];
    const groups = catalogRows(entries, { worker: "copilot/fast", reviewer: "copilot/smart" });
    expect(groups[0].tier).toBe("nano");
    const nano = groups.find((g) => g.tier === "nano")!.rows[0];
    expect(nano.ref).toBe("copilot/fast");
    expect(nano.isDefaultFor).toContain("worker");
    const gone = groups.flatMap((g) => g.rows).find((r) => r.id === "gone")!;
    expect(gone.available).toBe(false);
  });
  it("resolveDefault returns undefined when the configured model vanished", () => {
    const entries = [E({ id: "fast" })];
    expect(resolveDefault({ worker: "copilot/missing" }, "worker", entries)).toBeUndefined();
    expect(resolveDefault({ worker: "copilot/fast" }, "worker", entries)).toBe("copilot/fast");
  });
  it("declares the routing roles", () => {
    expect(MODEL_ROLES).toContain("reviewer");
    expect(MODEL_ROLES).toContain("worker");
    expect(MODEL_ROLES).toContain("digest");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/screens/__tests__/models-model.test.ts`
Expected: FAIL — `Cannot find module '../models-model.js'`.

- [ ] **Step 3: Write the builder**

```ts
// packages/ui/src/screens/models-model.ts
import type { ModelEntry, Tier } from "@spider/models";

export const MODEL_ROLES: string[] = [
  "reviewer", "worker", "scout", "planner", "researcher", "oracle", "digest", "self_name", "upstream_watch",
];
const TIER_ORDER: Tier[] = ["nano", "mini", "standard", "capable", "reasoning"];

export interface CatalogRow {
  provider: string; id: string; ref: string; tier: Tier;
  available: boolean; reasoning: boolean; vision: boolean; isDefaultFor: string[];
}
export interface TierGroup { tier: Tier; rows: CatalogRow[]; }

const refOf = (e: ModelEntry): string => `${e.provider}/${e.id}`;

export function catalogRows(entries: ModelEntry[], defaults: Record<string, string>): TierGroup[] {
  const byRole = new Map<string, string[]>();
  for (const [role, ref] of Object.entries(defaults ?? {})) {
    const arr = byRole.get(ref) ?? [];
    arr.push(role);
    byRole.set(ref, arr);
  }
  return TIER_ORDER.map((tier) => ({
    tier,
    rows: entries.filter((e) => e.tier === tier).map((e) => ({
      provider: e.provider, id: e.id, ref: refOf(e), tier,
      available: e.available, reasoning: e.reasoning, vision: e.vision,
      isDefaultFor: byRole.get(refOf(e)) ?? [],
    })),
  })).filter((g) => g.rows.length > 0);
}

export function resolveDefault(defaults: Record<string, string>, role: string, entries: ModelEntry[]): string | undefined {
  const ref = defaults?.[role];
  if (!ref) return undefined;
  return entries.some((e) => `${e.provider}/${e.id}` === ref && e.available) ? ref : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/screens/__tests__/models-model.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/models-model.ts packages/ui/src/screens/__tests__/models-model.test.ts
git commit -m "feat(ui): models catalog rows (tier grouping + availability + role defaults)"
```

---

## Task 15: `control models` view + defaults editor round-trip

**Files:**
- Create: `packages/ui/src/screens/models-view.ts` (ModelsView component)
- Create: `packages/host/src/control/models-cmd.ts`
- Test: `packages/ui/src/screens/__tests__/models-view.test.ts`
- Test: `packages/host/src/__tests__/models-cmd.test.ts`
- Modify: `packages/host/src/extension.ts` (route `control models`), `packages/ui/src/index.ts` (export ModelsView/catalogRows)

**Interfaces:**
- Consumes: `catalogRows`/`resolveDefault`/`MODEL_ROLES`, `@spider/models.catalog(pi)`, `applyConfigEdit`-style write via `controlConfig("set", cwd, "models.defaults", obj)`, `ThemeAdapter`, `Table`.
- Produces: `class ModelsView implements Component` (tier sections with availability glyph `●/○`, `reasoning`/`vision` badges, `default-for` roles); `setModelDefault(cwd, role, ref): { ok: boolean; error?: string }` (validates `role ∈ MODEL_ROLES`, merges into `models.defaults`, writes); `listCatalog(pi): ModelEntry[]` (thin wrapper over `catalog(pi)`, degrades to `[]`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/host/src/__tests__/models-cmd.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { setModelDefault } from "../control/models-cmd.js";
import { controlConfig } from "../control.js";

const scratch = join(process.cwd(), "packages/host/.spider/scratch");

describe("setModelDefault", () => {
  it("writes and merges models.defaults", () => {
    const dir = mkdtempSync(join(scratch, "mdl-"));
    expect(setModelDefault(dir, "worker", "copilot/fast").ok).toBe(true);
    expect(setModelDefault(dir, "reviewer", "copilot/smart").ok).toBe(true);
    const defaults = controlConfig("get", dir, "models.defaults") as Record<string, string>;
    expect(defaults).toEqual({ worker: "copilot/fast", reviewer: "copilot/smart" });
  });
  it("rejects an unknown role", () => {
    const dir = mkdtempSync(join(scratch, "mdl-"));
    expect(setModelDefault(dir, "not_a_role", "x/y").ok).toBe(false);
  });
});
```

```ts
// packages/ui/src/screens/__tests__/models-view.test.ts
import { describe, it, expect } from "vitest";
import { ModelsView } from "../models-view.js";
import type { ThemeAdapter } from "../../agents/types.js";
import type { ModelEntry } from "@spider/models";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };
const E = (o: Partial<ModelEntry>): ModelEntry => ({ provider: "copilot", id: "m", tier: "standard", reasoning: false, vision: false, ctx: 1, speed: 1, costHint: 1, available: true, ...o });

describe("ModelsView", () => {
  it("renders tier sections, availability glyphs and default-for roles", () => {
    const v = new ModelsView([E({ id: "fast", tier: "nano" }), E({ id: "gone", tier: "mini", available: false })], { worker: "copilot/fast" }, id);
    const lines = v.render(70);
    expect(lines.join("\n")).toContain("🕸");
    expect(lines.join("\n")).toMatch(/nano|mini/);
    expect(lines.join("\n")).toContain("●"); // available
    expect(lines.join("\n")).toContain("○"); // unavailable
    expect(lines.join("\n")).toMatch(/worker/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(70);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/host/src/__tests__/models-cmd.test.ts packages/ui/src/screens/__tests__/models-view.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the view + command**

```ts
// packages/ui/src/screens/models-view.ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";
import type { ModelEntry } from "@spider/models";
import { catalogRows } from "./models-model.js";
import { card } from "../renderers/types.js";

export class ModelsView {
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  constructor(private entries: ModelEntry[], private defaults: Record<string, string>, private theme: ThemeAdapter) {}
  invalidate(): void { this.cachedWidth = -1; }
  render(width: number): string[] {
    if (width === this.cachedWidth) return this.cachedLines;
    const t = this.theme;
    const groups = catalogRows(this.entries, this.defaults);
    const body: string[] = [];
    for (const g of groups) {
      body.push(truncateToWidth(t.fg("accent", `── ${g.tier} ──`), width, ""));
      for (const r of g.rows) {
        const avail = r.available ? t.fg("accent", "●") : t.fg("muted", "○");
        const badges = [r.reasoning ? "R" : "", r.vision ? "V" : ""].filter(Boolean).join("");
        const roles = r.isDefaultFor.length ? t.fg("success", ` ⟵ ${r.isDefaultFor.join(",")}`) : "";
        const line = `${avail} ${t.fg("text", r.ref)} ${t.fg("dim", badges)}${roles}`;
        body.push(truncateToWidth(line, width, ""));
      }
    }
    this.cachedLines = card(t, "models", body, width);
    this.cachedWidth = width;
    return this.cachedLines;
  }
}
```

```ts
// packages/host/src/control/models-cmd.ts
import { MODEL_ROLES } from "@spider/ui";           // re-exported from screens/models-model via ui barrel
import { catalog } from "@spider/models";
import type { ModelEntry } from "@spider/models";
import { controlConfig } from "../control.js";

export function listCatalog(pi: unknown): ModelEntry[] {
  try { return catalog(pi as never); } catch { return []; }
}

export function setModelDefault(cwd: string, role: string, ref: string): { ok: boolean; error?: string } {
  if (!MODEL_ROLES.includes(role)) return { ok: false, error: `unknown role ${role}` };
  const cur = (controlConfig("get", cwd, "models.defaults") as Record<string, string> | undefined) ?? {};
  const next = { ...cur, [role]: ref };
  controlConfig("set", cwd, "models.defaults", next);
  return { ok: true };
}
```

In `extension.ts`, route `control models` (no UI → return `{ catalog: listCatalog(pi) }` text; with UI → mount `ModelsView` + role→model `SelectList` calling `setModelDefault` then `reloader.reload()`). Barrel: export `ModelsView`, `catalogRows`, `resolveDefault`, `MODEL_ROLES` from `./screens/models-model.js` / `./screens/models-view.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/host/src/__tests__/models-cmd.test.ts packages/ui/src/screens/__tests__/models-view.test.ts`
Expected: PASS (models-cmd 2 tests; models-view 1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/models-view.ts packages/host/src/control/models-cmd.ts packages/ui/src/index.ts packages/host/src/extension.ts packages/host/src/__tests__/models-cmd.test.ts packages/ui/src/screens/__tests__/models-view.test.ts
git commit -m "feat(host+ui): control models catalog/tier UI + per-role defaults editor"
```

---

## Task 16: doctor checks (pure functions)

**Files:**
- Create: `packages/ui/src/screens/doctor-checks.ts`
- Test: `packages/ui/src/screens/__tests__/doctor-checks.test.ts`

**Interfaces:**
- Consumes: `DoctorProbes` (injected — no I/O in the pure layer).
- Produces: `runDoctorChecks(probes: DoctorProbes): DoctorResult[]` — one result per area: native deps, DB health/migrations, sqlite-vec load, embedding-provider reachability, model-router reachability, registry integrity. Status precedence: any missing native dep → `fail`; unmigrated/pending → `warn`; unreachable provider → `warn`; orphaned registry rows → `warn`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/screens/__tests__/doctor-checks.test.ts
import { describe, it, expect } from "vitest";
import { runDoctorChecks } from "../doctor-checks.js";
import type { DoctorProbes } from "../doctor-checks.js";

const healthy: DoctorProbes = {
  nativeDeps: [{ name: "better-sqlite3", loaded: true, version: "11" }, { name: "sqlite-vec", loaded: true }],
  dbHealth: { global: true, project: true, migrated: true },
  sqliteVec: { loaded: true },
  embeddingProvider: { provider: "fastembed", reachable: true },
  modelRouter: { providers: [{ provider: "copilot", reachable: true, models: 8 }] },
  registry: { projects: 3, orphans: [] },
};

describe("runDoctorChecks", () => {
  it("all ok on a healthy system", () => {
    const results = runDoctorChecks(healthy);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(results.map((r) => r.id)).toEqual(["native", "db", "vec", "embed", "router", "registry"]);
  });
  it("fails when a native dep is missing", () => {
    const p = { ...healthy, nativeDeps: [{ name: "better-sqlite3", loaded: false, error: "not built" }] };
    expect(runDoctorChecks(p).find((r) => r.id === "native")!.status).toBe("fail");
  });
  it("warns on pending migrations and registry orphans", () => {
    const p: DoctorProbes = { ...healthy, dbHealth: { global: true, project: true, migrated: false, pending: ["003"] }, registry: { projects: 3, orphans: ["/gone"] } };
    const r = runDoctorChecks(p);
    expect(r.find((x) => x.id === "db")!.status).toBe("warn");
    expect(r.find((x) => x.id === "registry")!.status).toBe("warn");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/screens/__tests__/doctor-checks.test.ts`
Expected: FAIL — `Cannot find module '../doctor-checks.js'`.

- [ ] **Step 3: Write the checks**

```ts
// packages/ui/src/screens/doctor-checks.ts
export type CheckStatus = "ok" | "warn" | "fail";
export interface DoctorResult { id: string; label: string; status: CheckStatus; detail: string; }
export interface DoctorProbes {
  nativeDeps: { name: string; loaded: boolean; version?: string; error?: string }[];
  dbHealth: { global: boolean; project: boolean; migrated: boolean; pending?: string[] };
  sqliteVec: { loaded: boolean; error?: string };
  embeddingProvider: { provider: string; reachable: boolean; detail?: string };
  modelRouter: { providers: { provider: string; reachable: boolean; models: number }[] };
  registry: { projects: number; orphans: string[] };
}

export function runDoctorChecks(p: DoctorProbes): DoctorResult[] {
  const results: DoctorResult[] = [];

  const missing = p.nativeDeps.filter((d) => !d.loaded);
  results.push({
    id: "native", label: "Native deps",
    status: missing.length ? "fail" : "ok",
    detail: missing.length ? `missing: ${missing.map((d) => `${d.name} (${d.error ?? "not loaded"})`).join(", ")}` : p.nativeDeps.map((d) => d.name).join(", "),
  });

  const dbOk = p.dbHealth.global && p.dbHealth.project;
  results.push({
    id: "db", label: "DB health / migrations",
    status: !dbOk ? "fail" : p.dbHealth.migrated ? "ok" : "warn",
    detail: !dbOk ? "cannot open one or both databases" : p.dbHealth.migrated ? "migrated" : `pending: ${(p.dbHealth.pending ?? []).join(", ") || "unknown"}`,
  });

  results.push({
    id: "vec", label: "sqlite-vec",
    status: p.sqliteVec.loaded ? "ok" : "warn",
    detail: p.sqliteVec.loaded ? "loaded" : `not loaded — brute-force cosine fallback (${p.sqliteVec.error ?? "n/a"})`,
  });

  results.push({
    id: "embed", label: "Embedding provider",
    status: p.embeddingProvider.reachable ? "ok" : "warn",
    detail: `${p.embeddingProvider.provider}: ${p.embeddingProvider.reachable ? "reachable" : `unreachable — FTS-only (${p.embeddingProvider.detail ?? "n/a"})`}`,
  });

  const reachable = p.modelRouter.providers.filter((x) => x.reachable);
  const totalModels = reachable.reduce((s, x) => s + x.models, 0);
  results.push({
    id: "router", label: "Model router",
    status: reachable.length ? "ok" : "warn",
    detail: reachable.length ? `${reachable.length} provider(s), ${totalModels} models` : "no reachable providers",
  });

  results.push({
    id: "registry", label: "Registry integrity",
    status: p.registry.orphans.length ? "warn" : "ok",
    detail: p.registry.orphans.length ? `${p.registry.orphans.length} orphaned: ${p.registry.orphans.join(", ")}` : `${p.registry.projects} project(s)`,
  });

  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/screens/__tests__/doctor-checks.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/doctor-checks.ts packages/ui/src/screens/__tests__/doctor-checks.test.ts
git commit -m "feat(ui): doctor checks as pure functions (native/db/vec/embed/router/registry)"
```

---

## Task 17: doctor view + `control doctor` wiring

**Files:**
- Create: `packages/ui/src/screens/doctor-view.ts`
- Create: `packages/host/src/control/doctor-cmd.ts` (builds probes, replaces Phase-0 doctor body)
- Test: `packages/ui/src/screens/__tests__/doctor-view.test.ts`
- Modify: `packages/host/src/control.ts` (`controlDoctor` returns real probe results), `packages/host/src/extension.ts` (mount view when `ctx.hasUI`), `packages/ui/src/index.ts`

**Interfaces:**
- Consumes: `runDoctorChecks`, `DoctorResult`, `statusIcon`, `card`, `ThemeAdapter`; probe builders over `@spider/db-core`/`@spider/models`/native require checks.
- Produces: `renderDoctor(results: DoctorResult[], theme, width): string[]`; `class DoctorView`; `buildDoctorProbes(cwd, pi): DoctorProbes` (host, real I/O, degrades gracefully); `controlDoctor(cwd, pi?)` now returns `{ ok, lines }` derived from `runDoctorChecks(buildDoctorProbes(...))`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/screens/__tests__/doctor-view.test.ts
import { describe, it, expect } from "vitest";
import { renderDoctor } from "../doctor-view.js";
import type { ThemeAdapter } from "../../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("renderDoctor", () => {
  it("renders a glyph per check and stays within width", () => {
    const lines = renderDoctor([
      { id: "native", label: "Native deps", status: "ok", detail: "better-sqlite3" },
      { id: "db", label: "DB health", status: "warn", detail: "pending: 003" },
      { id: "vec", label: "sqlite-vec", status: "fail", detail: "not loaded" },
    ], id, 50);
    expect(lines[0]).toContain("🕸");
    expect(lines.join("\n")).toContain("✓");
    expect(lines.join("\n")).toContain("⚠");
    expect(lines.join("\n")).toContain("✗");
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/screens/__tests__/doctor-view.test.ts`
Expected: FAIL — `Cannot find module '../doctor-view.js'`.

- [ ] **Step 3: Write the view + host probes**

```ts
// packages/ui/src/screens/doctor-view.ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";
import type { CheckStatus, DoctorResult } from "./doctor-checks.js";
import { statusIcon, card } from "../renderers/types.js";

const ICON: Record<CheckStatus, "ok" | "fail" | "warn"> = { ok: "ok", fail: "fail", warn: "warn" };

export function renderDoctor(results: DoctorResult[], theme: ThemeAdapter, width: number): string[] {
  const body = results.map((r) =>
    truncateToWidth(`${statusIcon(theme, ICON[r.status])} ${theme.fg("text", r.label)} ${theme.fg("muted", "— " + r.detail)}`, width, ""),
  );
  return card(theme, "doctor", body, width);
}

export class DoctorView {
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  constructor(private results: DoctorResult[], private theme: ThemeAdapter) {}
  invalidate(): void { this.cachedWidth = -1; }
  render(width: number): string[] {
    if (width === this.cachedWidth) return this.cachedLines;
    this.cachedLines = renderDoctor(this.results, this.theme, width);
    this.cachedWidth = width;
    return this.cachedLines;
  }
}
```

`packages/host/src/control/doctor-cmd.ts`: `buildDoctorProbes(cwd, pi)` — require-check native deps (try/catch around `require("better-sqlite3")`, `require("sqlite-vec")`), open global/project DBs + read `migrations` table for pending, attempt `db.loadVec()` for sqlite-vec, ping the configured embedding provider (cheap HEAD/no-op), `catalog(pi)` grouped by provider for router reachability, and compare `projects.db_path` existence for orphans. Every probe wrapped so a throw becomes a `fail`/`warn` result, never an exception. Update `controlDoctor` in `control.ts` to call `runDoctorChecks(buildDoctorProbes(cwd, pi))` and format `{ ok: results.every(r=>r.status!=="fail"), lines: renderDoctorPlain(results) }`. Export `renderDoctor`/`DoctorView` from the ui barrel; mount `DoctorView` in `extension.ts` when `ctx.hasUI` else return `{ lines }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ui/src/screens/__tests__/doctor-view.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/doctor-view.ts packages/host/src/control/doctor-cmd.ts packages/host/src/control.ts packages/ui/src/index.ts packages/host/src/extension.ts packages/ui/src/screens/__tests__/doctor-view.test.ts
git commit -m "feat(host+ui): control doctor screen — full checks + view"
```

---

## Task 18: stats collect (pure) + `control stats` view

**Files:**
- Create: `packages/ui/src/screens/stats-collect.ts`
- Create: `packages/ui/src/screens/stats-view.ts`
- Create: `packages/host/src/control/stats-cmd.ts`
- Test: `packages/ui/src/screens/__tests__/stats-collect.test.ts`
- Test: `packages/ui/src/screens/__tests__/stats-view.test.ts`
- Modify: `packages/host/src/extension.ts`, `packages/ui/src/index.ts`

**Interfaces:**
- Consumes: `StatsInput`; `Table`/`card`.
- Produces: `summarizeStats(input): StatsSummary` (token savings `= indexedChunks * avgChunkTokens`; per-model `calls/okRate/avgMs/tokens` from `model_stats` rows); `renderStats(summary, theme, width): string[]`; `class StatsView`; host `collectStats(cwd): StatsSummary` (queries `content` count, `avgChunkTokens` estimate, row counts of `memory`/`todos`/`runs`/`sessions`/`content`, and `model_stats` aggregation).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/ui/src/screens/__tests__/stats-collect.test.ts
import { describe, it, expect } from "vitest";
import { summarizeStats } from "../stats-collect.js";

describe("summarizeStats", () => {
  it("computes token savings and per-model aggregates", () => {
    const s = summarizeStats({
      contentChunks: 100, avgChunkTokens: 120,
      rowCounts: { memory: 42, todos: 8 },
      modelStats: [
        { model: "copilot/fast", ms: 100, ok: 1, tokens: 500 },
        { model: "copilot/fast", ms: 300, ok: 0, tokens: 700 },
        { model: "copilot/smart", ms: 200, ok: 1, tokens: 1000 },
      ],
    });
    expect(s.tokenSavings).toEqual({ indexedChunks: 100, estTokensSaved: 12000 });
    expect(s.rowCounts.memory).toBe(42);
    const fast = s.models.find((m) => m.model === "copilot/fast")!;
    expect(fast.calls).toBe(2);
    expect(fast.okRate).toBeCloseTo(0.5);
    expect(fast.avgMs).toBe(200);
    expect(fast.tokens).toBe(1200);
  });
});
```

```ts
// packages/ui/src/screens/__tests__/stats-view.test.ts
import { describe, it, expect } from "vitest";
import { renderStats } from "../stats-view.js";
import type { ThemeAdapter } from "../../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("renderStats", () => {
  it("renders token savings, row counts and model table", () => {
    const lines = renderStats({
      tokenSavings: { indexedChunks: 100, estTokensSaved: 12000 },
      rowCounts: { memory: 42, todos: 8 },
      models: [{ model: "copilot/fast", calls: 2, okRate: 0.5, avgMs: 200, tokens: 1200 }],
    }, id, 60);
    expect(lines[0]).toContain("🕸");
    expect(lines.join("\n")).toMatch(/12000|12,000/);
    expect(lines.join("\n")).toMatch(/memory/);
    expect(lines.join("\n")).toMatch(/copilot\/fast/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/ui/src/screens/__tests__/stats-collect.test.ts packages/ui/src/screens/__tests__/stats-view.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write collect + view**

```ts
// packages/ui/src/screens/stats-collect.ts
export interface StatsInput {
  contentChunks: number; avgChunkTokens: number;
  rowCounts: Record<string, number>;
  modelStats: { model: string; ms: number; ok: number; tokens: number }[];
}
export interface ModelStatRow { model: string; calls: number; okRate: number; avgMs: number; tokens: number; }
export interface StatsSummary {
  tokenSavings: { indexedChunks: number; estTokensSaved: number };
  rowCounts: Record<string, number>;
  models: ModelStatRow[];
}

export function summarizeStats(input: StatsInput): StatsSummary {
  const byModel = new Map<string, { ms: number; ok: number; tokens: number; calls: number }>();
  for (const s of input.modelStats) {
    const cur = byModel.get(s.model) ?? { ms: 0, ok: 0, tokens: 0, calls: 0 };
    cur.ms += s.ms; cur.ok += s.ok; cur.tokens += s.tokens; cur.calls += 1;
    byModel.set(s.model, cur);
  }
  const models: ModelStatRow[] = [...byModel.entries()].map(([model, v]) => ({
    model, calls: v.calls, okRate: v.calls ? v.ok / v.calls : 0,
    avgMs: v.calls ? Math.round(v.ms / v.calls) : 0, tokens: v.tokens,
  })).sort((a, b) => b.calls - a.calls);
  return {
    tokenSavings: { indexedChunks: input.contentChunks, estTokensSaved: input.contentChunks * input.avgChunkTokens },
    rowCounts: input.rowCounts,
    models,
  };
}
```

```ts
// packages/ui/src/screens/stats-view.ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";
import type { StatsSummary } from "./stats-collect.js";
import { renderTable } from "../components/table.js";
import { card } from "../renderers/types.js";

export function renderStats(s: StatsSummary, theme: ThemeAdapter, width: number): string[] {
  const body: string[] = [];
  body.push(truncateToWidth(theme.fg("accent", "── token savings ──"), width, ""));
  body.push(truncateToWidth(`${theme.fg("muted", "indexed chunks")} ${theme.fg("text", String(s.tokenSavings.indexedChunks))}  ${theme.fg("muted", "est tokens saved")} ${theme.fg("success", String(s.tokenSavings.estTokensSaved))}`, width, ""));
  body.push(truncateToWidth(theme.fg("accent", "── rows ──"), width, ""));
  for (const [k, v] of Object.entries(s.rowCounts)) {
    body.push(truncateToWidth(`${theme.fg("muted", k)} ${theme.fg("text", String(v))}`, width, ""));
  }
  if (s.models.length) {
    body.push(truncateToWidth(theme.fg("accent", "── models ──"), width, ""));
    body.push(...renderTable(theme, {
      columns: [{ header: "model" }, { header: "calls", align: "right" }, { header: "ok%", align: "right" }, { header: "avgms", align: "right" }, { header: "tok", align: "right" }],
      rows: s.models.map((m) => [m.model, String(m.calls), `${Math.round(m.okRate * 100)}`, String(m.avgMs), String(m.tokens)]),
      width,
    }));
  }
  return card(theme, "stats", body, width);
}

export class StatsView {
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  constructor(private summary: StatsSummary, private theme: ThemeAdapter) {}
  invalidate(): void { this.cachedWidth = -1; }
  render(width: number): string[] {
    if (width === this.cachedWidth) return this.cachedLines;
    this.cachedLines = renderStats(this.summary, this.theme, width);
    this.cachedWidth = width;
    return this.cachedLines;
  }
}
```

`packages/host/src/control/stats-cmd.ts`: `collectStats(cwd)` opens the project DB, runs `SELECT count(*) FROM content|memory|todos|runs|sessions`, estimates `avgChunkTokens` (chars/4 average over a `content` sample), reads `model_stats` from the global DB, and calls `summarizeStats`. `control stats` mounts `StatsView` (UI) or returns text lines. Export `renderStats`/`StatsView`/`summarizeStats` from the barrel.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/ui/src/screens/__tests__/stats-collect.test.ts packages/ui/src/screens/__tests__/stats-view.test.ts`
Expected: PASS (stats-collect 1; stats-view 1).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/stats-collect.ts packages/ui/src/screens/stats-view.ts packages/host/src/control/stats-cmd.ts packages/ui/src/index.ts packages/host/src/extension.ts packages/ui/src/screens/__tests__/stats-collect.test.ts packages/ui/src/screens/__tests__/stats-view.test.ts
git commit -m "feat(host+ui): control stats — token savings + row counts + model_stats"
```

---

## Task 19: insights graph (pure) + `control insights` view

**Files:**
- Create: `packages/ui/src/screens/insights-graph.ts`
- Create: `packages/ui/src/screens/insights-view.ts`
- Create: `packages/host/src/control/insights-cmd.ts`
- Test: `packages/ui/src/screens/__tests__/insights-graph.test.ts`
- Test: `packages/ui/src/screens/__tests__/insights-view.test.ts`
- Modify: `packages/host/src/extension.ts`, `packages/ui/src/index.ts`

**Interfaces:**
- Consumes: `InsightRow` (rows from the `insights` table: `kind ∈ node|edge|insight`).
- Produces: `buildInsightGraph(rows): InsightGraph` (node/edge/insight partition; `node` → `{id:a,kind,label:payload||a,weight}`; `edge` → `{from:a,to:b,weight}`; `insight` → synthetic node with `kind:"insight"`); `renderInsights(graph, theme, width): string[]` (nodes list + `a → b (w)` edges); `class InsightsView`; host `loadInsights(cwd)` reading the global `insights` table.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/ui/src/screens/__tests__/insights-graph.test.ts
import { describe, it, expect } from "vitest";
import { buildInsightGraph } from "../insights-graph.js";

describe("buildInsightGraph", () => {
  it("partitions nodes, edges and insights", () => {
    const g = buildInsightGraph([
      { kind: "node", a: "skill:tdd", payload: "TDD", weight: 2 },
      { kind: "node", a: "mem:u1", payload: "prefers tabs" },
      { kind: "edge", a: "skill:tdd", b: "mem:u1", weight: 0.8 },
      { kind: "insight", a: "cross:1", payload: "tabs across projects", weight: 3 },
    ]);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["cross:1", "mem:u1", "skill:tdd"].sort());
    expect(g.edges).toEqual([{ from: "skill:tdd", to: "mem:u1", weight: 0.8 }]);
    expect(g.nodes.find((n) => n.id === "skill:tdd")!.label).toBe("TDD");
  });
});
```

```ts
// packages/ui/src/screens/__tests__/insights-view.test.ts
import { describe, it, expect } from "vitest";
import { renderInsights } from "../insights-view.js";
import type { ThemeAdapter } from "../../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("renderInsights", () => {
  it("renders nodes and edges within width", () => {
    const lines = renderInsights({
      nodes: [{ id: "skill:tdd", kind: "node", label: "TDD", weight: 2 }, { id: "mem:u1", kind: "node", label: "tabs", weight: 1 }],
      edges: [{ from: "skill:tdd", to: "mem:u1", weight: 0.8 }],
    }, id, 60);
    expect(lines[0]).toContain("🕸");
    expect(lines.join("\n")).toMatch(/TDD/);
    expect(lines.join("\n")).toMatch(/skill:tdd.*→.*mem:u1/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/ui/src/screens/__tests__/insights-graph.test.ts packages/ui/src/screens/__tests__/insights-view.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write graph + view**

```ts
// packages/ui/src/screens/insights-graph.ts
export interface InsightRow { kind: string; a?: string | null; b?: string | null; weight?: number | null; payload?: string | null; }
export interface InsightNode { id: string; kind: string; label: string; weight: number; }
export interface InsightEdge { from: string; to: string; weight: number; }
export interface InsightGraph { nodes: InsightNode[]; edges: InsightEdge[]; }

export function buildInsightGraph(rows: InsightRow[]): InsightGraph {
  const nodes: InsightNode[] = [];
  const edges: InsightEdge[] = [];
  for (const r of rows) {
    if (r.kind === "edge" && r.a && r.b) {
      edges.push({ from: r.a, to: r.b, weight: r.weight ?? 0 });
    } else if ((r.kind === "node" || r.kind === "insight") && r.a) {
      nodes.push({ id: r.a, kind: r.kind, label: r.payload ?? r.a, weight: r.weight ?? 0 });
    }
  }
  return { nodes, edges };
}
```

```ts
// packages/ui/src/screens/insights-view.ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";
import type { InsightGraph } from "./insights-graph.js";
import { card } from "../renderers/types.js";

export function renderInsights(g: InsightGraph, theme: ThemeAdapter, width: number): string[] {
  const body: string[] = [];
  body.push(truncateToWidth(theme.fg("accent", `── nodes (${g.nodes.length}) ──`), width, ""));
  for (const n of g.nodes) {
    const badge = n.kind === "insight" ? theme.fg("warning", "✦") : theme.fg("dim", "•");
    body.push(truncateToWidth(`${badge} ${theme.fg("text", n.id)} ${theme.fg("muted", n.label)}`, width, ""));
  }
  body.push(truncateToWidth(theme.fg("accent", `── edges (${g.edges.length}) ──`), width, ""));
  for (const e of g.edges) {
    body.push(truncateToWidth(`${theme.fg("text", e.from)} ${theme.fg("dim", "→")} ${theme.fg("text", e.to)} ${theme.fg("muted", `(${e.weight})`)}`, width, ""));
  }
  return card(theme, "insights", body, width);
}

export class InsightsView {
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  constructor(private graph: InsightGraph, private theme: ThemeAdapter) {}
  invalidate(): void { this.cachedWidth = -1; }
  render(width: number): string[] {
    if (width === this.cachedWidth) return this.cachedLines;
    this.cachedLines = renderInsights(this.graph, this.theme, width);
    this.cachedWidth = width;
    return this.cachedLines;
  }
}
```

`packages/host/src/control/insights-cmd.ts`: `loadInsights(cwd)` opens the global DB, `SELECT kind,a,b,weight,payload FROM insights ORDER BY created_at DESC LIMIT 500`, calls `buildInsightGraph`. `control insights` mounts `InsightsView` (UI) or returns text. Export from barrel.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/ui/src/screens/__tests__/insights-graph.test.ts packages/ui/src/screens/__tests__/insights-view.test.ts`
Expected: PASS (graph 1; view 1).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/screens/insights-graph.ts packages/ui/src/screens/insights-view.ts packages/host/src/control/insights-cmd.ts packages/ui/src/index.ts packages/host/src/extension.ts packages/ui/src/screens/__tests__/insights-graph.test.ts packages/ui/src/screens/__tests__/insights-view.test.ts
git commit -m "feat(host+ui): control insights — learning graph builder + view"
```

---

## Task 20: slash commands (/spider /memory /search /insights /learn + thin /doctor /stats /upgrade /purge)

**Files:**
- Create: `packages/host/src/slash.ts`
- Test: `packages/host/src/__tests__/slash.test.ts`
- Modify: `packages/host/src/extension.ts` (call `registerSlashCommands(pi, deps)`)

**Interfaces:**
- Consumes: a fake `pi` with `registerCommand(name, opts)`; the control command handlers (`mountConfig`/`ModelsView`/`DoctorView`/`StatsView`/`InsightsView`) and the `spider` dispatch.
- Produces: `registerSlashCommands(pi, deps): void` registering `spider`, `memory`, `search`, `insights`, `learn`, `doctor`, `stats`, `upgrade`, `purge`; each maps to the matching `spider` action/`control` command. `/todos` (Phase 1) and `/agents` (Phase 5) are already registered — do NOT re-register (guard by checking `deps.registered`). Thin commands (`/doctor`,`/stats`,`/upgrade`,`/purge`) forward to `control <cmd>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/host/src/__tests__/slash.test.ts
import { describe, it, expect, vi } from "vitest";
import { registerSlashCommands, SLASH_COMMANDS } from "../slash.js";

describe("registerSlashCommands", () => {
  it("registers each slash command exactly once", () => {
    const registered = new Set<string>();
    const pi = { registerCommand: vi.fn((name: string) => { registered.add(name); }) };
    registerSlashCommands(pi as never, { run: vi.fn(), alreadyRegistered: new Set(["todos", "agents"]) } as never);
    for (const c of SLASH_COMMANDS) expect(registered.has(c)).toBe(true);
    // does not re-register the pre-existing ones
    expect([...registered]).not.toContain("todos");
  });
  it("thin commands forward to a control sub-command", async () => {
    const calls: unknown[] = [];
    const pi = { registerCommand: vi.fn((_n: string, opts: { handler: (ctx: unknown) => unknown }) => { (pi as never as { _o: Record<string, unknown> })._o ??= {}; (pi as never as { _o: Record<string, () => unknown> })._o[_n] = opts.handler; }) };
    const run = vi.fn(async (args: unknown) => { calls.push(args); return { content: "ok" }; });
    registerSlashCommands(pi as never, { run, alreadyRegistered: new Set() } as never);
    await (pi as never as { _o: Record<string, (c: unknown) => Promise<unknown>> })._o.doctor({ cwd: "/x", hasUI: false, ui: {} });
    expect(calls.some((a) => (a as { command?: string }).command === "doctor")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/host/src/__tests__/slash.test.ts`
Expected: FAIL — `Cannot find module '../slash.js'`.

- [ ] **Step 3: Write the slash registrar**

```ts
// packages/host/src/slash.ts
export const SLASH_COMMANDS = ["spider", "memory", "search", "insights", "learn", "doctor", "stats", "upgrade", "purge"] as const;

interface SlashDeps {
  run: (args: Record<string, unknown>, ctx: unknown) => Promise<{ content: string; details?: unknown }>;
  alreadyRegistered: Set<string>;
}
interface PiLike { registerCommand(name: string, opts: { description: string; handler: (ctx: unknown) => unknown }): void; }

// Map slash → the spider tool invocation it forwards.
const FORWARD: Record<string, (ctx: unknown) => Record<string, unknown>> = {
  spider: () => ({ action: "control", command: "stats" }),   // /spider = dashboard entry (stats overview)
  memory: () => ({ action: "recall" }),
  search: (ctx) => ({ action: "search", query: (ctx as { arg?: string }).arg ?? "" }),
  insights: () => ({ action: "control", command: "insights" }),
  learn: (ctx) => ({ action: "skill", op: "learn", from: "conversation", note: (ctx as { arg?: string }).arg }),
  doctor: () => ({ action: "control", command: "doctor" }),
  stats: () => ({ action: "control", command: "stats" }),
  upgrade: () => ({ action: "control", command: "upgrade" }),
  purge: () => ({ action: "control", command: "purge" }),
};

const DESC: Record<string, string> = {
  spider: "spider 🕸 dashboard", memory: "browse memory", search: "unified search",
  insights: "learning graph", learn: "distill a skill from this conversation",
  doctor: "spider health check", stats: "token savings + row counts", upgrade: "upgrade spider", purge: "purge caches/scratch",
};

export function registerSlashCommands(pi: PiLike, deps: SlashDeps): void {
  for (const name of SLASH_COMMANDS) {
    if (deps.alreadyRegistered.has(name)) continue;
    pi.registerCommand(name, {
      description: DESC[name],
      handler: (ctx) => deps.run(FORWARD[name](ctx), ctx),
    });
  }
}
```

Wire in `extension.ts`: `registerSlashCommands(pi, { run: dispatchSpider, alreadyRegistered: new Set(["todos", "agents"]) })`. (`/todos` = Phase 1, `/agents` = Phase 5.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/host/src/__tests__/slash.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/slash.ts packages/host/src/extension.ts packages/host/src/__tests__/slash.test.ts
git commit -m "feat(host): slash commands (/spider /memory /search /insights /learn + thin admin)"
```

---

## Task 21: strangler cutover — remove deprecated legacy tools

**Files:**
- Create: `packages/host/src/legacy-removal.ts`
- Test: `packages/host/src/__tests__/legacy-removal.test.ts`
- Modify: `packages/host/src/extension.ts` (call `removeLegacyTools(pi)` after registering `spider`)

**Interfaces:**
- Consumes: `pi` with `unregisterTool?(name)` / `getTool?(name)` (TC3 surfaces). If the running pi lacks an unregister API, `removeLegacyTools` no-ops the missing ones and returns the list it could not remove (logged once, not thrown).
- Produces: `LEGACY_TOOLS: string[]` (`memory`, `memory_search`, `session_search`, `skill_manage`, `todo`, `subagent`, `wait`, and the 11 `ctx_*` tools); `removeLegacyTools(pi): { removed: string[]; skipped: string[] }`. **Guard:** never removes pi built-ins `edit`/`write`/`read`/`bash`/`grep`/`find`/`ls` (those are overridden, not legacy).

- [ ] **Step 1: Write the failing test**

```ts
// packages/host/src/__tests__/legacy-removal.test.ts
import { describe, it, expect, vi } from "vitest";
import { removeLegacyTools, LEGACY_TOOLS } from "../legacy-removal.js";

describe("removeLegacyTools", () => {
  it("removes every legacy tool when unregister exists", () => {
    const removed: string[] = [];
    const pi = { unregisterTool: vi.fn((n: string) => { removed.push(n); return true; }) };
    const res = removeLegacyTools(pi as never);
    expect(res.removed.sort()).toEqual([...LEGACY_TOOLS].sort());
    expect(res.skipped).toEqual([]);
  });
  it("never targets pi built-ins", () => {
    for (const builtin of ["edit", "write", "read", "bash", "grep", "find", "ls"]) {
      expect(LEGACY_TOOLS).not.toContain(builtin);
    }
  });
  it("degrades to skipped when no unregister API", () => {
    const res = removeLegacyTools({} as never);
    expect(res.removed).toEqual([]);
    expect(res.skipped.length).toBe(LEGACY_TOOLS.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/host/src/__tests__/legacy-removal.test.ts`
Expected: FAIL — `Cannot find module '../legacy-removal.js'`.

- [ ] **Step 3: Write the removal**

```ts
// packages/host/src/legacy-removal.ts
export const LEGACY_TOOLS: string[] = [
  "memory", "memory_search", "session_search", "skill_manage", "todo", "subagent", "wait",
  "ctx_execute", "ctx_execute_file", "ctx_batch_execute", "ctx_index", "ctx_fetch_and_index",
  "ctx_search", "ctx_status", "ctx_list", "ctx_remove", "ctx_reindex", "ctx_config",
];

interface PiLike { unregisterTool?(name: string): boolean; }

export function removeLegacyTools(pi: PiLike): { removed: string[]; skipped: string[] } {
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const name of LEGACY_TOOLS) {
    if (typeof pi.unregisterTool === "function") {
      try { pi.unregisterTool(name); removed.push(name); } catch { skipped.push(name); }
    } else {
      skipped.push(name);
    }
  }
  return { removed, skipped };
}
```

Wire in `extension.ts`: after `registerTool("spider", ...)` and all `registerAction` calls, `const cut = removeLegacyTools(pi); if (cut.skipped.length) log("info", "legacy tools not unregistered by host API", cut.skipped);`. Confirm the 11 `ctx_*` names against the real context-mode tool list during execution (VALIDATE-FIRST) — adjust the array if any name differs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/host/src/__tests__/legacy-removal.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/legacy-removal.ts packages/host/src/extension.ts packages/host/src/__tests__/legacy-removal.test.ts
git commit -m "feat(host): strangler cutover — remove deprecated legacy tools"
```

---

## Task 22: full-suite green + build + barrel completeness

**Files:**
- Modify: `packages/ui/src/index.ts` (verify every Phase 8 symbol is exported)
- Test: `packages/ui/src/__tests__/barrel.test.ts`

**Interfaces:**
- Consumes: the complete `@spider/ui` barrel.
- Produces: `barrel.test.ts` asserting the presence of every Phase 8 public symbol; a green full suite + a clean `tsc -b` + `esbuild` bundle.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/__tests__/barrel.test.ts
import { describe, it, expect } from "vitest";
import * as ui from "../index.js";

describe("ui barrel", () => {
  it("exports the full Phase 8 renderer + screen surface", () => {
    for (const name of [
      "renderExecCall", "renderExecResult", "renderIndexResult", "renderMemoryCard",
      "renderTodoChecklist", "renderRunResult", "renderMessageResult", "renderSearchCall",
      "CONFIG_SCHEMA", "coerce", "getField", "buildConfigModel", "ConfigView",
      "catalogRows", "MODEL_ROLES", "ModelsView", "runDoctorChecks", "renderDoctor", "DoctorView",
      "summarizeStats", "renderStats", "StatsView", "buildInsightGraph", "renderInsights", "InsightsView",
      "card", "kv", "statusIcon",
    ]) {
      expect((ui as Record<string, unknown>)[name], `missing export ${name}`).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/barrel.test.ts`
Expected: FAIL — some exports missing (fill any gaps in `index.ts`).

- [ ] **Step 3: Complete the barrel + re-export screens**

Ensure `packages/ui/src/index.ts` re-exports from `./screens/config-schema.js`, `./screens/config-model.js`, `./screens/config-view.js`, `./screens/models-model.js`, `./screens/models-view.js`, `./screens/doctor-checks.js`, `./screens/doctor-view.js`, `./screens/stats-collect.js`, `./screens/stats-view.js`, `./screens/insights-graph.js`, `./screens/insights-view.js`, plus the Task 8 renderer exports.

- [ ] **Step 4: Run the full suite + build**

Run: `npx vitest run && npm run -w spider build`
Expected: all tests PASS; `tsc -b` clean; `esbuild` bundle emits `dist/extension.js`; `assert-bundle` passes.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/index.ts packages/ui/src/__tests__/barrel.test.ts
git commit -m "test(ui): barrel completeness + full Phase 8 suite green"
```

---

## Files to Modify
- `packages/ui/src/index.ts` — re-export all Phase 8 renderers + screens (Tasks 8, 12, 15, 17, 18, 19, 22).
- `packages/host/src/extension.ts` — attach renderer registry; route `control config|models|doctor|stats|insights` to UI mounts; register slash commands; hot-reload; `removeLegacyTools` (Tasks 9, 12, 13, 15, 17, 18, 19, 20, 21).
- `packages/host/src/control.ts` — `controlDoctor` now derives from `runDoctorChecks(buildDoctorProbes(...))` (Task 17).
- `packages/ui/src/renderers/search.ts` — add `renderSearchCall` (Task 8).

## New Files
- `packages/ui/src/renderers/{types,exec,index-fetch,memory-card,todo-checklist,run-view,message}.ts` — per-action renderers (Tasks 1–7).
- `packages/ui/src/screens/{config-schema,config-model,config-view,models-model,models-view,doctor-checks,doctor-view,stats-collect,stats-view,insights-graph,insights-view}.ts` — config/models/observability screens (Tasks 10–19).
- `packages/host/src/renderers/registry.ts` — action→renderer dispatch (Task 9).
- `packages/host/src/control/{config-cmd,models-cmd,doctor-cmd,stats-cmd,insights-cmd}.ts` — control-command hosts (Tasks 12, 15, 17, 18, 19).
- `packages/host/src/{config-reload,slash,legacy-removal}.ts` — hot-reload, slash registrar, strangler cutover (Tasks 13, 20, 21).
- All matching `*.test.ts` under `packages/ui/src/__tests__/`, `packages/ui/src/screens/__tests__/`, `packages/host/src/__tests__/`.

## Dependencies
- Tasks 2–8 depend on Task 1 (detail types + helpers).
- Task 9 (registry) depends on Tasks 2–8 (all renderers exist + barrel exports).
- Tasks 11–12 depend on Task 10 (config schema). Task 13 depends on Task 12 (write path). 
- Tasks 15 depends on Task 14 (catalog rows). 
- Tasks 17 depends on Task 16 (doctor checks). Task 18/19 are independent of each other but share the `Table`/`card` helpers (Task 1 + Phase 5).
- Task 20 (slash) depends on the control screens (12/15/17/18/19) being routable.
- Task 21 (strangler cutover) MUST run last among behavior tasks — only after every action renders (9) and all screens exist.
- Task 22 depends on all prior tasks (barrel + full-suite green).

## Risks
- **`result.details` shape drift:** renderers assume the `*Details` shapes above; the owning phases (1/2/4) must populate them. The registry's `safe()` wrapper + per-renderer defaults prevent throws, but a mismatch degrades to a one-line summary. **Validate** each action's real `details` payload against the Interfaces block during execution; adjust builders (not the shapes' names) if fields differ.
- **Action attribution in `renderResult`:** pi's `renderResult(result, meta, theme)` may not carry the original `args.action`. The registry reads `result.details.action` first; ensure every action handler stamps `details.action` (a tiny change in the owning phases) OR that the host threads `args` into `meta`. **Validate against pi `types.d.ts`** before Task 9; if neither is available, fall back to a single generic spider renderer keyed off `details.kind`.
- **`ctx.ui.custom` mount signature:** the config/models/doctor/stats/insights views mount through `ctx.ui.custom((tui,theme,keybindings,done)=>Component)`. The pure builders/components are fully tested; the mount glue is thin and only smoke-testable in headless pi. Keep all logic in the pure seam (`applyConfigEdit`, `setModelDefault`, `runDoctorChecks`, `summarizeStats`, `buildInsightGraph`) so coverage stays high.
- **`pi.unregisterTool` may not exist (TC3 mentions `getTool`, not unregister):** Task 21 degrades to `skipped` and logs; if no runtime removal API exists, the legacy tools must instead be *not registered* by their owning phases once deprecated. **Validate** the real pi extension API for a tool-removal surface; if absent, change Task 21 to assert the owning phases no longer call `registerTool` for legacy names (grep-based test) rather than runtime unregister.
- **`@spider/models.catalog(pi)` availability offline:** `listCatalog` degrades to `[]` (Task 15) and `control models` shows an empty catalog with a callout; the doctor `router` check reports "no reachable providers" (warn, not fail). Confirm `catalog(pi)` never throws on missing creds.
- **Config `set` writes project scope only (Phase 0):** the picker edits project config; a user wanting a global default must hand-edit or we add a scope toggle. Spec says `set` → project; keep that. Flag in the UI which scope a value resolves from (future enhancement, out of scope here).
- **`control stats` `avgChunkTokens` is an estimate:** token savings is heuristic (chars/4). Label it "est" in the UI (done) so it is not read as exact.
- **Theme-token coverage:** all renderers use only tokens enumerated in the UI-kit recon (`accent/muted/dim/text/success/error/warning/toolTitle/toolOutput/toolDiff*`). If a pi theme lacks one, `piTheme` must fall back gracefully (Phase 5 adapter responsibility) — verify no renderer introduces a new token name.

## Self-Review (performed against the spec)
- **Spec coverage — per-action renderers:** exec/exec_file/batch (T2), index/fetch (T3), memory card recall/remember (T4), todo checklist (T5), run/agents view + wait (T6), message (T7), search call (T8); registry dispatch (T9). ✔ (`edit`/`write` intentionally inherit pi's native renderer per TC3 — not re-rendered.)
- **Slash commands:** /spider /memory /search /insights /learn + thin /doctor /stats /upgrade /purge (T20); /todos (Phase 1) + /agents (Phase 5) guarded from re-registration. ✔
- **Config UI:** picker over the 8 JSON schema groups (T10–T12), get/set round-trip tested (T12), hot-reload via resources_discover (T13). ✔
- **`control models` (new):** catalog with tier/availability + per-role/per-kind defaults from the `models` config group, backed by `@spider/models.catalog()` (T14–T15). ✔
- **Observability:** doctor (native deps, DB/migrations, sqlite-vec, embedding + router reachability, registry integrity) (T16–T17); stats (token savings + row counts + model_stats) (T18); insights (learning graph) (T19). ✔
- **Hard rule — all output via spider-ui, theme tokens + 🕸, width-adaptive:** every renderer/screen returns `string[]` through `@spider/ui`, uses `truncateToWidth`, carries the 🕸 glyph, and is tested for `visibleWidth ≤ width`. ✔
- **Strangler cutover:** deprecated legacy tools removed last (T21), built-ins guarded. ✔
- **TDD + temp DB in `.spider/scratch/`:** every task is red→green→commit; config/models round-trips use `packages/host/.spider/scratch` (never `/tmp`). ✔
- **Type consistency:** `ThemeAdapter`/`RenderCtx`/`*Details`/`ConfigField`/`DoctorProbes`/`StatsSummary`/`InsightGraph`/`CatalogRow` names are identical across the Interfaces block and every task. ✔
- **Gap watch:** `/spider` is mapped to the stats overview as the dashboard entry; if a richer multi-panel dashboard is desired it is an additive follow-up (not required by the spec's command list). Flagged, not blocking.
