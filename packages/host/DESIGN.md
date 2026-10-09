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

This system describes the usage web interface. Brown-black backgrounds and pale text provide a quiet setting for dense measurements. Outlined controls, short labels and aligned numbers keep the interface readable without separating every fact into a card.

Charts carry the visual identity. Session activity follows a horizontal baseline with colored branches, while stacked bars and connecting ribbons show attribution. Color, marker shape and line pattern distinguish data; they do not decorate the surrounding panels. The wordmark is condensed, but headings and controls remain ordinary reading text.

**Key Characteristics:**
- Warm dark surfaces with pale, high-contrast text.
- Thin outlines and rounded panels, with pills for controls and compact facts.
- Separate color families for models and participant roles.
- Monospaced measurements alongside sans-serif labels.
- Direct chart interaction with an equivalent table view.

## Colors

The palette combines warm neutrals with small, distinct data colors. The frontmatter records the implemented values; repeated values retain separate semantic names where the source does.

### Primary

- **Cream ink:** primary text, ordinary chart totals, own-call marks and the filled portion of the pace track. Focus uses the same pale color through its own semantic token.
- **Tomato:** a model-series color and, independently, the danger color for failed runs, range errors and over-pace conditions. Context and labels distinguish those uses.

### Secondary

- **Sky, sage and mustard:** the remaining model-series colors. Pair model colors with the circle, diamond, square or triangle marker supplied by the model catalogue.
- **Sage status:** accepted correction states and fresh data use sage through their respective semantic tokens. Mustard marks published-only correction data.

### Tertiary

- **Own cream, worker teal, reviewer rose and other violet:** participant-role attribution. These appear in role bars, legend dots and flow endpoints, not as alternative model identities.

### Neutral

- **Ground:** page background and resting section panels.
- **Surface:** fields, pace-track backing, tooltips and the pace popover.
- **Control:** selected toggles, row hover and the session-route detail card.
- **Muted:** secondary labels, chart axes, unavailable states and unknown model attribution. The hatch token shares this value for projected usage and missing-data marks.
- **Border:** panel outlines, table dividers, gridlines and default control strokes.
- **Stale gray:** freshness indication when recent ingestion is not confirmed.

**The Attribution Rule.** Model colors identify models; role colors identify participants. Preserve that distinction when both appear in the same chart.

**The State Needs Context Rule.** A colored status mark accompanies a label or accessible description. Tomato alone does not distinguish a model from a warning.

## Typography

**Wordmark Font:** Bebas Neue with the implemented sans-serif fallback stack.
**Body Font:** Fira Sans with platform sans-serif fallbacks.
**Numeric Font:** Cascadia Code with Menlo, Consolas and other monospace fallbacks.

Local fonts are preferred. Separate remotely loaded font aliases sit after the preferred families in the source stacks. If a font cannot load, controls and charts remain usable with the fallbacks; the fallback display face is not a new identity choice.

The hierarchy is deliberately compact. Medium-weight headings establish sections; bold monospaced values establish measurement emphasis. There is no oversized marketing headline role.

### Hierarchy

- **Wordmark:** the condensed brand name, not a heading style for other content.
- **Headline:** page and session titles.
- **Title:** chart and section headings.
- **Subsection:** smaller evidence headings use medium-weight body text or a slightly larger size (16px).
- **Body:** controls and explanatory text. Longer method text is limited to a readable measure (75ch).
- **Label:** short fact names and supporting notes. Navigation, model labels and freshness text also use an intermediate size (13px) where space requires it.
- **Numeric:** identifiers, timestamps, ranks, measurements and tabular values. The local numeric range is compact (11px to 15px), with right alignment for comparable table columns.
- **Metric:** inline session and calibration summary values, reduced in narrower desktop windows (28px).

**The Measurement Rule.** Use the code family for machine values and measurements, not as a substitute for the interface's reading face. Keep tabular numerals in data columns.

## Layout

The desktop shell has a full-width header with a minimum height (88px). Content is centered within a maximum width (1536px), with broad horizontal gutters and top and bottom padding (28px and 34px). Section panels share their padding and separation through the panel spacing step.

The overview pairs its main time-series chart with a narrower model column (1.85fr to 1fr). Both panels share one fixed height so the row never grows with the number of models: the model list scrolls inside its panel, and the daily plot is sized from its box so text always renders at its CSS size. Long lists (models, sessions, runs) scroll inside their panel rather than expanding the page. Further evidence sections use the full content width. Session and calibration summaries use open multi-column rows with vertical dividers rather than separate metric cards.

At the compact desktop breakpoint (1350px), gutters shrink, navigation becomes denser, metric values become smaller and the overview ratio adjusts (1.75fr to 1fr). The page retains a minimum width (1024px). Narrower windows scroll; this system does not claim a phone layout. Wide tables and route diagrams have their own horizontal scrolling regions.

Related items cluster with small gaps. Headings, chart summaries and plot regions are separated more generously. Chip groups and toolbar fields wrap when needed; the plot and its table remain within the same section.

## Elevation & Depth

There are no box shadows, gradients or blurred glass layers. Depth comes from the ground, surface and control tones, thin outlines and drawing order. Tooltips and popovers are opaque and sit above data without changing the page's lighting. Route casings use the ground color to separate crossing paths; this is chart legibility, not a shadow treatment.

**The Flat Surface Rule.** Use tone, outline and stacking to establish hierarchy. Do not add decorative shadows to the existing panel and control vocabulary.

Motion is limited to state feedback. Route emphasis changes opacity with a short ease-out transition (130ms) when reduced motion is not requested. The refresh icon rotates while busy (650ms per turn); reduced motion removes that animation. There are no page entrance animations.

## Shapes

Section panels have gently rounded corners and thin outlines (1px). Fields use the smaller field radius; tooltips use the intermediate tooltip radius. Buttons, compact facts, status labels, segmented groups and role stacks use the pill radius. Chips can sit inside a section without becoming another section card; do not add nested boxed content panels.

Charts use straight bars, rounded line joins, small geometric model markers and patterned lines where identity or state requires them. Session branches have short diagonal corner segments rather than loose curves. The flow diagram uses curved ribbons because it represents connections between attribution groups.

## Components

### Buttons and segmented controls

Ordinary actions are outlined pills, not solid accent buttons. Hover fills the control tone; disabled actions use muted text and lose the pointer cursor. Default actions have a minimum height (36px). Text-only table actions remove the enclosing pill and underline on hover.

Segmented groups have a shared outline, tight inner gaps and small inset padding (3px). Individual choices use a compact minimum height (30px). A pressed choice gains the control fill, ink text and its own thin border. The same pattern serves time ranges, units and chart representation.

Keyboard focus uses an explicit pale outline (2px) outside the element (4px offset). Table rows use an inset offset where an external outline would be clipped. Interactive SVG marks use an equivalent visible stroke treatment.

### Navigation and identity

The monochrome web mark is authored SVG, paired with the condensed wordmark. The navigation consists of Overview and Calibration & data. Session detail stays within Overview's current navigation state and provides a Back action.

Inactive navigation uses muted text. Hover brightens it; the current page uses an ink outline, ink text and medium weight. Freshness is a small status dot with a timestamp tooltip on hover or focus. Refresh is a compact outlined icon button with a busy state.

### Inputs and fields

Date-time inputs have a surface fill, thin border and field radius. Their values use the numeric family; labels use the body family. Native input behavior remains intact. The caret is pale, and custom-range validation appears as danger-colored text beside the apply action, not as an invented filled field state.

### Chips and status labels

Facts are noninteractive outlined pills. Summary chips pair a muted label with a monospaced value. The compact summary variant has a smaller minimum height (30px), padding (5px 10px) and gap (7px).

Role keys pair labels with colored dots and role-colored outlines. Model keys use geometric markers. Calibration status labels pair a small dot with text and a matching colored border; unavailable states stay muted. Do not make these labels look like clickable filters unless they are actual controls.

### Panels and tables

A section panel contains its heading, summary, chart or table and supporting notes. The Chart / Table toggle switches representations inside that panel. Numeric tables align comparable values to the right, retain readable column headers and use horizontal dividers rather than a boxed grid around every cell.

Session and run rows use the control tone on hover. Pinned runs use the same tone in their table row. Expand actions sit below the evidence, not in another boxed footer.

### Pace track

The monthly pace control is a full-width pill (40px high). A solid fill shows used credits; diagonal hatching shows the projection beyond use. A ring marks the current point. The label moves outside a short fill to remain legible, and the month label has an opaque backing.

Hover, focus or click reveals a bordered surface popover aligned to the ring. Escape, leaving the control or clicking away dismisses it. Over-pace conditions change the fill, hatch and ring to danger. Missing scale data does not fabricate a proportional fill.

### Session route

A horizontal baseline represents own activity; model-colored branches represent runs. Branch height encodes the selected measurement, and the horizontal span keeps the run's time endpoints. Marker shapes and dashed line patterns provide additional model cues. Endpoint geometry communicates run state.

Hover or focus thickens the active branch and dims the others. A control-toned detail card presents the run's fields. Enter, Space or click pins a run and synchronizes its table selection; Escape clears it. Arrow keys move between runs and events. Long inactive gaps can be compressed into explicit breaks, without shortening active runs. The diagram has a fixed vertical extent (430px) and can scroll horizontally.

### Attribution ribbons and browser surfaces

Flow ribbons connect participant roles to model endpoints. Ribbon width encodes the selected amount; labels and a table provide the same attribution without relying on color alone. The ribbons remain solid, not translucent decorative links.

Text selection reverses ink and ground. Scrollbars use muted thumbs on ground tracks, and links keep a visible underline offset (4px). These details belong to the same palette as the drawn controls.

## Do's and Don'ts

### Do:
- **Do** use warm neutral surfaces and reserve data colors for attribution and meaningful states.
- **Do** pair model color with marker shape and keep participant-role colors separate.
- **Do** align comparable numeric values and use the code family for measurements, identifiers and times.
- **Do** keep chart and table representations together with visible keyboard focus.
- **Do** show missing data with an explicit label rather than a fabricated amount or series.
- **Do** keep public examples synthetic and free of account details or user paths.

### Don't:
- **Don't** turn every summary value into a separate card or nest content panels inside panels.
- **Don't** add shadows, decorative gradients or translucent glass to this flat interface.
- **Don't** use the wordmark face for ordinary headings or controls.
- **Don't** rely on color alone to communicate model identity, status or selection.
- **Don't** remove chart patterns, neutral dividers or outlines merely to make the interface more minimal.
- **Don't** promise a mobile layout that the desktop implementation does not provide.
