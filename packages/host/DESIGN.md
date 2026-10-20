---
name: "Spider usage dashboard"
description: "A dark, data-focused interface with warm surfaces and route-based charts."
colors:
  ground: "#16120f"
  surface: "#201a16"
  control: "#332b24"
  ink: "#f3eadb"
  muted: "#c4b7a8"
  border: "#493d33"
  hatch: "#c4b7a8"
  danger: "#f8785c"
  focus-ring: "#f3eadb"
  model-tomato: "#f8785c"
  model-sky: "#91c7e5"
  model-sage: "#8fbf8a"
  model-mustard: "#e5b840"
  role-own: "#f3eadb"
  role-workers: "#46b5aa"
  role-reviewers: "#da91bc"
  role-others: "#a395e4"
  freshness-fresh: "#8fbf8a"
  freshness-stale: "#9b9690"
typography:
  wordmark:
    fontFamily: "'Bebas Neue', 'Usage Wordmark Remote', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif"
    fontSize: "32px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.025em"
  headline:
    fontFamily: "'Fira Sans', 'Usage Text Remote', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif"
    fontSize: "28px"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  title:
    fontFamily: "'Fira Sans', 'Usage Text Remote', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif"
    fontSize: "20px"
    fontWeight: 500
    lineHeight: 1.3
  body:
    fontFamily: "'Fira Sans', 'Usage Text Remote', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "'Fira Sans', 'Usage Text Remote', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  numeric:
    fontFamily: "'Cascadia Code', 'Usage Code Remote', Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  metric:
    fontFamily: "'Cascadia Code', 'Usage Code Remote', Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace"
    fontSize: "32px"
    fontWeight: 700
    lineHeight: 1.2
rounded:
  field: "8px"
  tooltip: "10px"
  panel: "12px"
  pill: "999px"
spacing:
  compact: "4px"
  group: "8px"
  detail: "12px"
  related: "16px"
  panel: "24px"
  gutter-compact: "36px"
  gutter: "48px"
components:
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "7px 13px"
  button-outline-hover:
    backgroundColor: "{colors.control}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "7px 13px"
  toggle-selected:
    backgroundColor: "{colors.control}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "7px 10px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "7px 13px"
  nav-item-current:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "7px 13px"
  fact-chip:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "7px 12px"
  status-calibrated:
    backgroundColor: "transparent"
    textColor: "{colors.model-sage}"
    rounded: "{rounded.pill}"
    padding: "5px 11px"
  panel:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "24px"
  pace-track:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    height: "40px"
  route-card:
    backgroundColor: "{colors.control}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "14px 17px"
    width: "310px"
---

# Design System: Spider usage dashboard

## Overview

**Creative North Star: "Night transit map"**

This system describes the usage web interface. Brown-black backgrounds and pale text keep the setting quiet for dense measurements. Outlined controls, short labels and aligned numbers keep the interface readable, so not every fact needs its own card.

The charts give the interface its look. Session activity follows a horizontal baseline with colored branches. Stacked bars and connecting ribbons show attribution. Color, marker shape and line pattern tell data apart. They do not decorate the panels around the data. The wordmark is condensed, but headings and controls use ordinary reading text.

**Key Characteristics:**
- Warm dark surfaces with pale, high-contrast text.
- Thin outlines and rounded panels, with pills for controls and compact facts.
- Separate color families for models and participant roles.
- Monospaced measurements next to sans-serif labels.
- Direct chart interaction, with a table view that shows the same data.

## Colors

The palette mixes warm neutrals with a few small, distinct data colors. The frontmatter records the implemented values. Where the source gives one value several semantic names, this file keeps each name.

### Primary

- **Cream ink:** primary text, ordinary chart totals, own-call marks and the filled part of the pace track. Focus uses the same pale color through its own semantic token.
- **Tomato:** a model-series color. It is also, separately, the danger color for failed runs, range errors and over-pace conditions. Context and labels tell those uses apart.

### Secondary

- **Sky, sage and mustard:** the other model-series colors. Pair each model color with the circle, diamond, square or triangle marker that the model catalogue supplies.
- **Sage status:** accepted correction states and fresh data use sage, each through its own semantic token. Mustard marks correction data that is published only.

### Tertiary

- **Own cream, worker teal, reviewer rose and other violet:** participant-role attribution. These colors appear in role bars, legend dots and flow endpoints. They are not extra model identities.

### Neutral

- **Ground:** the page background and section panels at rest.
- **Surface:** fields, the pace-track backing, tooltips and the pace popover.
- **Control:** selected toggles, row hover and the session-route detail card.
- **Muted:** secondary labels, chart axes, unavailable states and unknown model attribution. The hatch token has the same value and marks projected usage and missing data.
- **Border:** panel outlines, table dividers, gridlines and default control strokes.
- **Stale gray:** the freshness indicator when recent ingestion is not confirmed.

**The Attribution Rule.** Model colors identify models. Role colors identify participants. Keep the two apart when both appear in the same chart.

**The State Needs Context Rule.** A colored status mark always comes with a label or an accessible description. Tomato alone does not tell a model from a warning.

## Typography

**Wordmark Font:** Bebas Neue with the implemented sans-serif fallback stack.
**Body Font:** Fira Sans with platform sans-serif fallbacks.
**Numeric Font:** Cascadia Code with Menlo, Consolas and other monospace fallbacks.

The stacks list local fonts first. Separate aliases for remotely loaded fonts come after the preferred families. If a font cannot load, controls and charts still work with the fallbacks. The fallback display face is not a new identity choice.

The hierarchy is compact on purpose. Medium-weight headings mark sections. Bold monospaced values mark the measurements that matter. There is no role for a large marketing headline.

### Hierarchy

- **Wordmark:** the condensed brand name. It is not a heading style for other content.
- **Headline:** page and session titles.
- **Title:** chart and section headings.
- **Subsection:** smaller evidence headings use medium-weight body text or a slightly larger size (16px).
- **Body:** controls and explanatory text. Longer method text has a readable line length (75ch).
- **Label:** short fact names and supporting notes. Navigation, model labels and freshness text also use a size in between (13px) where space requires it.
- **Numeric:** identifiers, timestamps, ranks, measurements and table values. The local numeric sizes stay in a small range (11px to 15px). Comparable table columns are right-aligned.
- **Metric:** summary values inline in session and calibration views. They get smaller in narrower desktop windows (28px).

**The Measurement Rule.** Use the code family for machine values and measurements. Do not use it in place of the interface's reading face. Keep tabular numerals in data columns.

## Layout

The desktop shell has a full-width header with a minimum height (88px). Content is centered within a maximum width (1536px), with broad horizontal gutters and top and bottom padding (28px and 34px). Section panels share their padding and spacing, both taken from the panel spacing step.

The overview puts its main time-series chart next to a narrower model column (1.85fr to 1fr). Both panels have the same fixed height, so the row never grows with the number of models. The model list scrolls inside its panel. The daily plot takes its size from its box, so text always renders at its CSS size. Long lists (models, sessions, runs) scroll inside their panel instead of making the page longer. Later evidence sections use the full content width. Session and calibration summaries use open rows of several columns with vertical dividers, not separate metric cards.

At the compact desktop breakpoint (1350px), gutters shrink, navigation gets denser, metric values get smaller and the overview ratio changes (1.75fr to 1fr). The page keeps a minimum width (1024px). Narrower windows scroll. This system does not claim a phone layout. Wide tables and route diagrams have their own horizontal scrolling regions.

Related items sit close together with small gaps. Headings, chart summaries and plot regions have more space between them. Chip groups and toolbar fields wrap when needed. The plot and its table stay in the same section.

## Elevation & Depth

There are no box shadows, gradients or blurred glass layers. Depth comes from the ground, surface and control tones, from thin outlines and from drawing order. Tooltips and popovers are opaque and sit above the data without changing the page's lighting. Route casings use the ground color to separate paths that cross. This keeps the chart legible and is not a shadow.

**The Flat Surface Rule.** Use tone, outline and stacking order to set hierarchy. Do not add decorative shadows to the existing panels and controls.

Motion is only for state feedback. When reduced motion is not requested, route emphasis changes opacity with a short ease-out transition (130ms). The refresh icon rotates while busy (650ms per turn). Reduced motion removes that animation. Pages have no entrance animations.

## Shapes

Section panels have slightly rounded corners and thin outlines (1px). Fields use the smaller field radius. Tooltips use the tooltip radius, which sits between the field and panel radii. Buttons, compact facts, status labels, segmented groups and role stacks use the pill radius. Chips can sit inside a section without becoming another section card. Do not nest boxed content panels.

Charts use straight bars, rounded line joins, small geometric model markers, and patterned lines where identity or state needs them. Session branches turn corners with short diagonal segments, not loose curves. The flow diagram uses curved ribbons because it shows connections between attribution groups.

## Components

### Buttons and segmented controls

Ordinary actions are outlined pills, not solid accent buttons. On hover they fill with the control tone. Disabled actions use muted text and lose the pointer cursor. Default actions have a minimum height (36px). Text-only table actions drop the pill and show an underline on hover.

Segmented groups share one outline, with tight inner gaps and small inset padding (3px). Each choice has a compact minimum height (30px). A pressed choice gets the control fill, ink text and its own thin border. Time ranges, units and the chart view all use this pattern.

Keyboard focus shows a pale outline (2px) outside the element (4px offset). Table rows use an inset offset where an outside outline would be clipped. Interactive SVG marks show focus with a visible stroke that does the same job.

### Navigation and identity

The monochrome web mark is an authored SVG, shown next to the condensed wordmark. The navigation has two items, Overview and Calibration & data. Session detail stays within Overview's current navigation state and has a Back action.

Inactive navigation items use muted text, which brightens on hover. The current page uses an ink outline, ink text and medium weight. Freshness is a small status dot, with a timestamp tooltip on hover or focus. Refresh is a compact outlined icon button with a busy state.

### Inputs and fields

Date-time inputs have a surface fill, a thin border and the field radius. Their values use the numeric family, and their labels use the body family. Native input behavior is left unchanged. The caret is pale. A custom-range validation error appears as danger-colored text next to the apply action, not as a made-up filled field state.

### Chips and status labels

Facts are outlined pills that do not respond to clicks. Summary chips pair a muted label with a monospaced value. The compact summary variant has a smaller minimum height (30px), padding (5px 10px) and gap (7px).

Role keys pair labels with colored dots and outlines in the role color. Model keys use geometric markers. Calibration status labels pair a small dot with text and a border in the same color. Unavailable states stay muted. Do not make these labels look like clickable filters unless they are real controls.

### Panels and tables

A section panel holds its heading, its summary, a chart or table, and supporting notes. The Chart / Table toggle switches between the two views inside that panel. Numeric tables right-align comparable values, keep readable column headers, and use horizontal dividers instead of a box around every cell.

Session and run rows use the control tone on hover. A pinned run's table row uses the same tone. Expand actions sit below the evidence, not in another boxed footer.

### Pace track

The monthly pace control is a full-width pill (40px high). A solid fill shows the credits used. Diagonal hatching shows the projection past current use. A ring marks the current point. When the fill is short, the label moves outside it so that it stays legible. The month label has an opaque backing.

Hover, focus or click opens a bordered surface popover aligned to the ring. Escape, moving off the control or clicking elsewhere closes it. Over-pace conditions turn the fill, hatch and ring to the danger color. If scale data is missing, the track does not draw a made-up proportional fill.

### Session route

A horizontal baseline shows own activity. Branches in model colors show runs. Branch height encodes the selected measurement, and the horizontal span keeps the run's start and end times. Marker shapes and dashed line patterns give extra model cues. The shape at each endpoint shows the run's state.

Hover or focus makes the active branch thicker and dims the others. A detail card in the control tone shows the run's fields. Enter, Space or click pins a run and selects the same run in the table. Escape clears it. Arrow keys move between runs and events. Long inactive gaps can be shortened into explicit breaks, but active runs are never shortened. The diagram has a fixed height (430px) and can scroll horizontally.

### Attribution ribbons and browser surfaces

Flow ribbons connect participant roles to model endpoints. Ribbon width encodes the selected amount. Labels and a table give the same attribution, so the chart does not depend on color alone. The ribbons stay solid. They are not translucent decorative links.

Text selection swaps ink and ground. Scrollbars use muted thumbs on ground-colored tracks. Links keep a visible underline offset (4px). These details use the same palette as the drawn controls.

## Do's and Don'ts

### Do:
- **Do** use warm neutral surfaces, and keep data colors for attribution and states that carry meaning.
- **Do** pair each model color with a marker shape, and keep participant-role colors separate.
- **Do** align comparable numeric values, and use the code family for measurements, identifiers and times.
- **Do** keep the chart and table views together, with visible keyboard focus.
- **Do** show missing data with an explicit label, not a made-up amount or series.
- **Do** keep public examples synthetic, with no account details or user paths.

### Don't:
- **Don't** turn every summary value into a separate card or nest content panels inside panels.
- **Don't** add shadows, decorative gradients or translucent glass to this flat interface.
- **Don't** use the wordmark face for ordinary headings or controls.
- **Don't** rely on color alone to show model identity, status or selection.
- **Don't** remove chart patterns, neutral dividers or outlines just to make the interface look more minimal.
- **Don't** promise a mobile layout that the desktop implementation does not provide.
