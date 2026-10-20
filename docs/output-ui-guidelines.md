# Spider tool output-UI guidelines

Pi draws every `spider` tool result inside its **default tool shell**. The shell already
renders the title line **`🕸 spider · <action>`** (green while running, red on error) from the
tool `label` + `renderCall`. Renderers draw *below* that line. These rules exist because
breaking them causes the double-header bug (`🕸 spider · todo` **and** `🕸 todo · session`).

## Rules

1. **No repeated chrome.** A `renderResult` body MUST NOT emit the `🕸` glyph, the word
   "spider", or the action name. The tool shell already shows all of them. Repeating them
   gives the output two headers.

2. **Body-only.** Return only the content lines. To group content visually inside the body, use a
   plain **`sectionRule(theme, label, width)`**, which draws `label ─────────` (a muted label, a dim rule,
   and **no glyph**). Never use the glyph-titled `card()` in a tool-result renderer.

3. **`card()` is overlay-only.** The 🕸-titled `card()` frame is only for **standalone
   screens** mounted through `ctx.ui.custom` (overlays and full screens) that have *no* outer tool
   shell. Even there, prefer a subtle `─── Title ───` rule to a heavy glyph frame.

4. **Width-safe + semantic.** Every line must pass through `truncateToWidth(l, width, "")`
   (or `"…"` to signal truncation). Show status with **a glyph and a color together**
   (`✓` success, `○` muted, `✗` error, `●` on, `⚠` warn), never with color alone. Collapse
   long lists into a `⎿ … N more` line, and respect `expanded` (the Ctrl+O toggle in the chat).

5. **Overlays** (`/todos`, pickers, screens) must use the **active theme** (its colors and glyphs).
   They need a subtle `─── Title ───` rule, plenty of blank lines between parts, a context line
   (for example, the session), an `N/M completed` summary, and a footer with key hints
   (`a: … · q: close`). Never render a monochrome list with no spacing. The old `pi-todo-sqlite`
   overlay avoided that regression, and it is the standard to beat.

## Reference implementations

- **Body-only tool result:** `renderSearch` in `packages/host/src/render-result.ts` (with an explicit
  "no repeated 🕸 header" note), and the `@spider/ui` renderers `renderTodoChecklist`,
  `renderStats`, `renderInsights`, `renderModels` (all body-only, using `sectionRule`).
- **`sectionRule` / `card`:** `packages/ui/src/renderers/types.ts`.
- **Overlay:** `packages/todo/src/command.ts` (`/todos`). It has a rule and spacing driven by the theme,
  counts and a footer, and it follows the model of `/mnt/data/src/pi-todo-sqlite`.

## Test contract

Every renderer test uses the identity `ThemeAdapter` and asserts that:
- `lines.join("\n")` does **not** contain `🕸` (body-only), and does not repeat the action name.
- The content and the status glyphs are present, and every line meets `visibleWidth(l) <= width`.
