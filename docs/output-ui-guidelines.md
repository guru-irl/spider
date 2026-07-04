# Spider tool output-UI guidelines

Every `spider` tool result is painted inside pi's **default tool shell**, which already
renders the title line **`🕸 spider · <action>`** (green while running, red on error) from the
tool `label` + `renderCall`. Renderers draw *below* that line. The rules below exist because
ignoring them produces the double-header bug (`🕸 spider · todo` **and** `🕸 todo · session`).

## Rules

1. **No repeated chrome.** A `renderResult` body MUST NOT emit the `🕸` glyph, the word
   "spider", or the action name. The tool shell already shows all three. Repeating them
   double-heads the output.

2. **Body-only.** Return just the content lines. For visual grouping inside the body use a
   plain **`sectionRule(theme, label, width)`** → `label ─────────` (muted label, dim rule,
   **no glyph**). Never use the glyph-titled `card()` in a tool-result renderer.

3. **`card()` is overlay-only.** The 🕸-titled `card()` frame is reserved for **standalone
   surfaces** mounted via `ctx.ui.custom` (overlays / full screens) that have *no* outer tool
   shell. Even there, prefer a subtle `─── Title ───` rule over heavy glyph chrome.

4. **Width-safe + semantic.** Every line must pass through `truncateToWidth(l, width, "")`
   (or `"…"` when signalling truncation). Encode status with **glyph + color together**
   (`✓` success · `○` muted · `✗` error · `●` on · `⚠` warn) — never color alone. Collapse
   long lists with a `⎿ … N more` line and honor `expanded` (the in-chat Ctrl+O toggle).

5. **Overlays** (`/todos`, pickers, screens) must use the **active theme** (color + glyphs),
   a subtle `─── Title ───` rule, generous blank-line spacing, a context line (e.g. the
   session), an `N/M completed` summary, and a footer key hint (`a: … · q: close`). Never
   render a monochrome, spacing-free list — that is the regression the old `pi-todo-sqlite`
   overlay avoided and the bar to beat.

## Reference implementations

- **Body-only tool result:** `packages/host/src/render-result.ts` → `renderSearch` (explicit
  "no repeated 🕸 header" note), and the `@spider/ui` renderers `renderTodoChecklist`,
  `renderStats`, `renderInsights`, `renderModels` (all body-only + `sectionRule`).
- **`sectionRule` / `card`:** `packages/ui/src/renderers/types.ts`.
- **Overlay:** `packages/todo/src/command.ts` (`/todos`) — theme-driven rule + spacing +
  counts + footer, modeled on `/mnt/data/src/pi-todo-sqlite`.

## Test contract

Every renderer test uses the identity `ThemeAdapter` and asserts:
- `lines.join("\n")` does **not** contain `🕸` (body-only), and does not repeat the action name.
- content + status glyphs are present; every line `visibleWidth(l) <= width`.
