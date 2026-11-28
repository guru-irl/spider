# Spider tool card guidelines

These rules apply to tool results and transcript notifications for run completion,
escalations, slash commands, and organism reports.

## Card layout

1. Pi owns the transcript spacer and the default tool box. Notification renderers
   return their box without another spacer. Use Pi's `outputPad` when supplied.
   The fallback is one column.
2. A title is `<logo> <bold command>[ · details]`. Do not add `spider` to the
   title. Italics identify agent roles only, including roles in rows and overlays.
3. Align status and gutter markers under the logo. Use `└` for detail gutters.
   Align gutter text with the command text, including the Nerd Font pad cell.
4. Start the body on the next line after a bare title. If the call has detail
   rows, put one blank line between those rows and the result. Separate
   multi-item blocks such as parallel runs with one blank line.
5. Show run and session names where available. Keep internal IDs in model-facing
   results rather than display rows. The message card falls back to the typed
   target if the result has no name.
6. Use a status icon and a color. Use the circled Nerd Font status icons only for
   todos. Other success, failure, and warning markers use the plain status icons.
7. Use `toolErrorBg` for failures and blocked escalations. Use `toolPendingBg`
   for warnings, questions, and running work. Use `toolSuccessBg` for success.
   Pi chooses the background for default tool shells.
8. Use `sectionRule` only when the body has more than one group.

Fit every line to the available display width. Respect Ctrl+O expansion without
repeating call details in the result. Escalations show the full summary even when
collapsed. Do not claim off-target clicks: Pi owns click-to-expand.

### Exec example

The following example uses text icons. The command is bold in the UI.

```text
 ◆ exec
 └ sqlite3 project.db 'SELECT seq, done, text FROM todos'
 └ date '+%H:%M:%S'
 └ … +6 more lines

 ✓ exit 0 · 4 lines
 └ 935|0|Check the packaging job with a fresh build directory.
 └ … 3 more
```

### Escalation example

The command is bold and `worker` is italic in the UI.

```text
 ◆ escalation · tia-3 · worker
 ▲ warning · The rebuild found two missing manifest entries. I will check
   the packaging logs before trying another build.
```

### Received intercom messages

A received message has a borderless title with the sender name and machine. A
local sender uses the short hostname, retaining its case. A remote sender uses
the configured machine alias. A collapsed message has a one-line gutter preview. An expanded message
shows the wrapped body aligned with the title text, followed by dim details.
Reply details do not show message IDs.

## Icon sets

All UI icons come from `packages/ui/src/icons.ts`. The `text` set is the
monochrome default. Its glyphs are present in Menlo, DejaVu Sans Mono, and
Cascadia Code. The `nerd` set uses Nerd Font glyphs where listed below.

Nerd Font private-use icons include one pad cell. A following separator adds a
second space. The Nerd gutter also includes one pad cell so its text aligns
with the title. Shared Unicode direction and status symbols do not have a pad
cell unless shown below. Copy buttons use the Nerd pad as their separator, so
those action labels keep one space and their clickable columns do not move.

| Role | Text | Nerd |
| --- | --- | --- |
| agent | ◇ U+25C7 | 󱙺 U+F167A |
| spider | ◆ U+25C6 | 󰯊 U+F0BCA |
| warning | ▲ U+25B2 | 󰀪 U+F002A |
| failure | × U+00D7 | 󰅖 U+F0156 |
| success | ✓ U+2713 | 󰄬 U+F012C |
| question | ? U+003F | 󰋖 U+F02D6 |
| running | ● U+25CF | ● U+25CF |
| open | ○ U+25CB | ○ U+25CB |
| paused | ■ U+25A0 | ■ U+25A0 |
| queued | ○ U+25CB | ○ U+25CB |
| active | ◆ U+25C6 | ◆ U+25C6 |
| todoDone | ✓ U+2713 | 󰗡 U+F05E1 |
| todoFailed | × U+00D7 | 󰅚 U+F015A |
| todoPending | ○ U+25CB | 󰝦 U+F0766 |
| gutter | └ U+2514 | └ U+2514, padded |
| task | → U+2192 | 󰘍 U+F060D |
| result | ↑ U+2191 | 󰁜 U+F005C |
| message | → U+2192 | 󰇰 U+F01F0 |
| reply | ← U+2190 | 󰼠 U+F0F20 |
| broadcast | » U+00BB | 󰬣 U+F0B23 |
| handoff | → U+2192 | 󱦰 U+F19B0 |
| pin | † U+2020 | 󰤱 U+F0931 |
| modelDefault | ← U+2190 | 󰁍 U+F004D |
| copy | □ U+25A1 | 󰆏 U+F018F |
| copied | ✓ U+2713 | 󰄬 U+F012C |
| content | □ U+25A1 | □ U+25A1 |
| todo | ▣ U+25A3 | ▣ U+25A3 |
| bullet | • U+2022 | • U+2022 |
| select | ▸ U+25B8 | ▸ U+25B8 |
| arrowLeft | ← U+2190 | ← U+2190 |
| arrowRight | → U+2192 | → U+2192 |
| arrowUp | ↑ U+2191 | ↑ U+2191 |
| arrowDown | ↓ U+2193 | ↓ U+2193 |

The text spinner uses `|`, `/`, `-`, and `\`. The Nerd Font spinner uses
`⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`.

## Overlays

Full screens and overlays such as `/todos` and pickers use the active theme, a
subtle heading rule, spacing between groups, a context line, and a footer with
key hints. The `card()` frame is for standalone views only.

## Tests

`packages/host/src/__tests__/card-rules.test.ts` checks tool and notification
cards at several widths in both icon styles and expansion modes. To save the
gallery, set `SPIDER_CARD_GALLERY` to a file path and run that test.
