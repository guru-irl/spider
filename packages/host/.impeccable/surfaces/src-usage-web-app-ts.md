---
version: 1
slug: "src-usage-web-app-ts"
primary_target: "src/usage/web/app.ts"
related_targets: []
---

# Usage dashboard

Scope: the local usage dashboard opened by `/usage`: Overview, Session, Calibration & data. Visitor mode: operate. Desktop browsers, dark only.

Audience: the spider owner and other spider users who pay for GitHub Copilot credits.

Job: see where credits went (models, sessions, roles) and whether the billing month is on pace, then find what to cut.

Action: open the costliest session and see which runs and idle gaps made it costly; set or check a monthly budget; check the correction factor.

Proof and content: the local usage ledger, counter snapshots and published rates. Mocks use synthetic data only.

Constraints: no framework or chart library; hand-built SVG; every chart has a table view; keyboard operable; WCAG AA; credits are never labelled with a basis marker.

Memorable moment: the session route, a transit line whose branches rise and fall by what each subagent run cost.

Critique reference: the approved static mock, round 7 (code-led build; no image comp exists).

Unresolved: none for the build. DESIGN.md is written at the finish from the built UI.

## Direction contract

THESIS: Spend is a journey on a transit map: each session is a line and every subagent run a branch whose height is its cost. Refuses the KPI-tile wall and the multi-tab analytics explorer.

OWN-WORLD: Warm night ground with cream ink; rounded boxes with 1px borders, never nested; outlined pills and chips for every control and fact; models as roundel colours (tomato, sky, sage, mustard) with shape markers, roles as a separate family (cream, teal, rose, violet); Cascadia Code numbers, Fira Sans text, a Bebas Neue wordmark beside the web mark.

STORY: The visitor reads the month's pace at a glance, sees which models and sessions took the credits, opens the costliest session, and learns which runs and idle gaps made it costly. Signature interactions: hovering a route branch dims the others and shows its run card; Cmd-click selects days and the page follows.

FIRST VIEWPORT: Menu bar with mark, wordmark, nav pills, freshness dot and refresh. Below it, the full-width pace bar as the topmost element, used credits inside the fill, projection hatched, popover at the ring. Then range presets and the Credits or Tokens switch. Then Daily credits stacked bars (two thirds) beside the ranked Models panel, equal height.

FORM: Transit map, position 4 of 7 on the ordered list, seed key 8c64920d.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
