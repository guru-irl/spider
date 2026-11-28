# Input band implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` to work inline. Do not start subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Pi the approved input band, transcript boxes, and activity icons.

**Architecture:** Keep Pi's editor and Markdown in charge of text layout. Apply the band through a `CustomEditor` subclass and narrow wrappers on the running host's transcript components. Keep the glyphs and animation frames in `@spider/ui`, and let the existing footer and agents widget request renders.

**Tech stack:** TypeScript, Pi's public extension API, pi-tui, Vitest, and Python fontTools for the optional font patch.

**Spec:** [Input band design](../specs/2026-11-27-input-band-design.md).

## Global constraints

- Use one test file per run with `--maxWorkers=1`. Do not launch Pi, Herdr, a browser gallery, or stories as part of the preview. Run at most one full typecheck. CI runs the full gate.
- Keep Pi's keyboard, mouse, and transcript behavior. Do not edit Pi's installed files. If the running host has a different component shape, keep its original rendering.
- Use the existing linked worktree and dependencies. Do not install packages or edit relocation, provisioning, or intercom runtime files.
- Use `git commit -F` and stage explicit paths. Open a draft PR to `main`. Do not wait for CI.

## Review focus

- Click at the text column and select a completion after adding a two-column editor prefix. Task 3 drives Pi's mouse handler with those screen coordinates.
- Draw a two-column grapheme at the last available column. Tasks 3 and 4 check narrow rows and the cursor marker.
- Drop a leading blank inside a tool box without moving its clickable result. Task 4 clicks the moved text on a real Pi tool.
- Replace a footer during a working interval. Task 5 advances the clock after replacement and checks that the old footer no longer asks for renders.
- Patch a font twice or encounter an occupied codepoint. Task 7 checks the backup and file bytes.

---

### Task 1: Blue accent and rounded hover frame

**Files:** `packages/herdr/assets/themes/{dracula-plus-glass,spider-glass}.json`, `packages/herdr/src/__tests__/look-theme.test.ts`, `packages/ui/src/{icons,index}.ts`, and `packages/host/src/copy-buttons/{index,copy-hover,copy-spacing,copy-bundled,copy-reload,copy-buttons,plain}.ts` (test files use `.test.ts`).

**Interfaces:** Export `REPLY_FRAME` from `@spider/ui`. It contains the six rounded box-drawing glyphs. Pi provides `Theme.fg('borderMuted', text)`.

- [ ] Assert that Pi's theme resolves `accent`, `borderAccent`, and `customMessageLabel` to `#82aaff`, and all five message and tool backgrounds to `#060607`. Assert `toolTitle` still resolves to `#f8f8f2` and Herdr's native accent matches Pi's. Herdr's theme schema does not define Pi tokens. Keep the terminal background and ANSI palette unchanged.
- [ ] Change the fullscreen hover tests to expect `╭─…─╮`, `│`, and `╰─…─╯` in `borderMuted`, no background, and the same action columns. Keep the off-target expansion test. Run `npm test -- <file> --maxWorkers=1` for the palette and hover tests separately. Expect the old palette and square glyphs to fail.
- [ ] Set `vars.strip` in the Pi theme and point the five roles at it. Change the Herdr accent in its native schema. Change the frame glyphs without changing layout or hit targets.
- [ ] Rerun the palette and copy tests separately. Commit the changes.

### Task 2: Align card details under their title

**Files:** `packages/ui/src/icons.ts`, `packages/ui/src/renderers/{bind,exec,index-fetch,kill,message,migrate}.ts`, `packages/ui/src/screens/insights-view.ts`, `packages/host/src/{render-result,intercom-cards}.ts`, and the card, exec, message, icon, and width tests beside those renderers.

**Interfaces:** Derive the detail indent from the visible width of ` ${icon(style, 'spider')} ` (3 text or 4 Nerd cells). Retain status markers, intentional blank rows, and wrapping.

- [ ] In `packages/host/src/__tests__/card-rules.test.ts`, assert that no rendered card has `└`, and that `sqlite3` starts at the same column as `exec`. Test the collapsed intercom message and the call preview in `intercom-cards.test.ts` the same way. Update exact row assertions in related tests. Run each file separately. Expect the old gutter to fail.
- [ ] Delete the `gutter` role and use spaces for each card's details. Do not change the separate stderr marker in the Herdr remote console or CSS scrollbar layout.
- [ ] Rerun the card, intercom, and renderer tests separately. Commit the changes. Run intercom parity and the repository guard script before delivery.

### Task 3: Mount the input band

**Files:** `packages/host/src/input-band/{ansi,editor,index}.ts`, `packages/host/src/input-band/editor.test.ts`, `packages/host/src/{control,extension}.ts`, `packages/ui/src/{icons,index,screens/config-schema}.ts`, `scripts/{extension-shim.mjs,package-extension.ts}`, and `packages/host/src/__tests__/extension-shim.test.ts`.

**Interfaces:** `createBandEditor(Base: typeof CustomEditor): typeof CustomEditor` supplies `BandEditor` with a live Pi theme through the factory. `registerInputBand(pi, host, readConfig)` reads `ui.inputBand` once per activation. The shims forward the host's exported component classes, not the native bundle's copies. Share `foregroundFromBackground(ansi: string): string | undefined` and `reopenBackground(row: string, ansi: string): string` with Task 4.

- [ ] Drive a real Pi editor through the registered factory. Expect `▗▄▄`, `▐ `, and `▝▀▀` at the edges. Assert the actual ANSI background and `CURSOR_MARKER`, green with `!` and `!!`, and accent through a thinking color change. Test multiline rows, both scroll counts, completion placement, mouse clicks, and widths 1 to 12 with wide text. Test that an occupied editor remains, and `ui.inputBand: false` leaves the default editor on reload. Extend the shim test to require the running host's editor and transcript exports. Run each test file separately. Expect the stock editor or missing host bindings to fail.
- [ ] Call `CustomEditor.render(width - 2)` with no internal padding. Find its two edges through the protected border hooks. Prefix text and completion rows and translate mouse columns back by two. Keep Pi's render output if the edges do not match or the width cannot fit a prefix and text. Make `ui.inputBand` default to `true` in config and the settings schema.
- [ ] Rerun the editor, config, and shim tests separately. Commit the changes.

### Task 4: Style sent messages and transcript boxes

**Files:** `packages/host/src/input-band/{index,transcript,box}.ts`, `packages/host/src/input-band/transcript.test.ts`, `packages/host/src/{render-result,intercom-cards}.ts`, `packages/host/src/__tests__/card-background.test.ts`, and `packages/ui/src/{icons,index}.ts`.

**Interfaces:** `installTranscriptBands(host, options)` updates stable wrappers for the supplied Pi classes and returns a disposer. `createHalfBox(paddingX, bg)` gives Spider-owned messages the same edges. `icon(style, 'prompt')` is `❯` for Nerd Font and uses the spec's font coverage rule for text.

- [ ] Render real `UserMessageComponent`, `ToolExecutionComponent` with Pi's edit definition, and `CustomMessageComponent` instances. Assert half-row glyphs, correct foreground and background, one caret, hanging text, unchanged Markdown meaning, and the original OSC 133 start and end. Check a clickable row after blank trimming, a shape without padding, a tool with its own shell, a very narrow message, and repeated activation. In `card-background.test.ts`, require bare half edges and continuous color in Spider's own message boxes. Run each file separately. Expect Pi's blank padding and missing caret to fail.
- [ ] Add a `Symbol.for` render wrapper on each supplied host prototype. For sent messages, render at `width - 2` and add the two columns without changing the Markdown input. For tools and default custom messages, adapt only the known padded child and leave other children and Pi's mouse dispatch in place. Drop only the blank content rows next to the edges. Use the same half-edge helper for Spider's own message boxes, including received intercom cards. With `ui.inputBand: false`, keep Pi's sent-message drawing and omit the caret.
- [ ] Rerun transcript, card rules, background, hover, and intercom tests separately. Commit the changes.

### Task 5: Move the working moon into the usage footer

**Files:** `packages/ui/src/{icons,index,components/spinner}.ts`, `packages/host/src/usage/{footer,mount}.ts`, `packages/host/src/usage/__tests__/{footer-layout,mount}.test.ts`.

**Interfaces:** `ACTIVITY_FRAMES` contains the icon sets, and `MOON_CYCLE_MS = 1000`. The usage footer component accepts `setWorking(since?: number)` and owns its animation timer.

- [ ] At the actual footer, assert Nerd frames `U+E3E3` at 0 ms, `U+E3CE` at 250 ms, `U+E3D5` at 500 ms, and `U+E3E3` at 1000 ms. Assert the dim idle frame, stable context column, and the text frames. Use fake time to check one render request per frame, no animation after `agent_end`, shutdown, or reload, and one `setWorkingVisible(false)` per mount. Check a narrow pane and `usage.footer: false`. Run the mount and layout tests separately. Expect a missing moon and unchanged render requests.
- [ ] Draw the moon and two spaces before the stats. Keep the model and context layout rules. Schedule the next frame from elapsed time, not from a fixed rounded interval. Hide Pi's working row only while Spider owns the footer. Release the timer and restore Pi's row when the footer is disabled.
- [ ] Rerun footer tests separately and commit the changes.

### Task 6: Use one robot or status icon per agent row

**Files:** `packages/ui/src/{icons,components/spinner,agents/types,agents/footer,agents/agent-list,agents/grid-cell}.ts`, `packages/ui/src/screens/config-schema.ts`, `packages/host/src/{control,agents/mount,agents/agents-ui,agents/theme-adapter}.ts`, and the agent and icon tests.

**Interfaces:** `ThemeAdapter.spiderGlyphs?: boolean` and `ThemeAdapter.activityTint?(text, strength)` carry font availability and color mixing. `formatAgentLine(theme, agent, width, now)` chooses its own icon. `ui.spiderGlyphs` defaults to `false`.

- [ ] Render running and terminal rows in the footer, list, and grid. Check the centre, left, right, and closed glyphs at specified frame times for a fixed run, two different run offsets, and the 1800 ms stock-robot pulse without the patch. A finished row contains one status icon and no robot. Check a text terminal never gets a private-use character. Run each file separately. Expect the old spinner plus robot output to fail.
- [ ] Use one shared agent status renderer. Put the four robot frames in `icons.ts`; time them for 700, 350, 200, 350, 700, 120, 250, and 120 ms with a stable run ID offset. Keep the existing status colors. Wire the setting through the agent mount; use the stock robot and a dim-to-accent pulse otherwise.
- [ ] Rerun the agent and icon tests separately and commit the changes.

### Task 7: Patch installed fonts on request

**Files:** `scripts/fonts/patch-spider-glyphs.py`, `scripts/fonts/test_patch_spider_glyphs.py`, `docs/output-ui-guidelines.md`, and `docs/guide/configuration.md`.

**Interfaces:** `python3 scripts/fonts/patch-spider-glyphs.py FONT.ttf [FONT.ttf ...]` patches the named CaskaydiaCove Nerd Font files in place. A sibling `FONT.ttf.spider-original` preserves the first input file.

- [ ] Build a synthetic TrueType fixture with the source web and robot glyphs. Run the script and examine the saved font. Assert the four `U+F2120` through `U+F2123` glyphs and the new outline at `U+F0BCA`. Compare every other glyph and metric. Reject a conflicting codepoint without writing, and prove that a second run leaves the backup and patched bytes alone. Run `python3 -m unittest discover -s scripts/fonts`. Expect the missing command to fail.
- [ ] Port only the approved web and robot drawings. Do not generate any of the rejected spider spinner codepoints. Save and validate the new file before replacing the original. Never overwrite an existing backup. Document how to select the font, restart Herdr, and set `ui.spiderGlyphs`. Describe all approved styles in the output guidelines.
- [ ] Rerun the Python tests and patch a scratch copy of a real font. Do not modify the installed fonts. Commit the script, tests, and docs.

### Task 8: Preview and deliver

- [ ] Run the scratch preview against the real transpiled components at 84 columns. Inspect normal, bash, and scrolled input, the sent message, both tool boxes, five moon states, robot and status rows, a gutterless card, and the hover copy actions. The script waits for Enter. Keep the script outside git.
- [ ] Run the intercom parity test, the guards, the lockfile check, one full typecheck, and `git diff --check`. Inspect the explicit changed-file list and the draft body before pushing.
- [ ] Push the exact head SHA and verify the remote ref. Open a draft PR to `main`, record its number and head, and leave CI alone.
- [ ] Write the report at the brief's path. Include the plan and commits, red and green results, all 16 decisions mapped to tests, all changed files, the preview command, and any gaps.
