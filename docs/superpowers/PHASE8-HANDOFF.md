# Phase 8 Handoff — finish Spider by dogfooding Spider

You are picking up the **Spider** monorepo (`/mnt/data/src/spider`) to complete **Phase 8
(Polish)**. Phases 6 and 7 are done and shipped. Your job: finish the remaining Phase 8
work **while using Spider's own tools for everything** — this is a live test of Spider.

---

## 0. PRIME DIRECTIVE — use Spider, not the incumbents

You have three competing toolsets installed globally (pi-subagents, context-mode, an
external todo). **Do NOT use them.** Use the `spider` tool's actions instead. When a Spider
tool is awkward, missing a param, renders badly, or errors — **that is a finding**: record it
(`spider remember category=tool-quirk`) and fix it using Spider itself. Catching these is the
whole point.

### Mandatory substitutions

| You need to… | ❌ Do NOT use | ✅ Use Spider |
|---|---|---|
| Delegate / subagents | `subagent(...)`, pi-subagents | `spider action=run` — SINGLE `{agent,task}` · PARALLEL `{tasks:[{agent,task}]}` · CHAIN `{chain:[{agent,task}]}` (`agent` = worker/reviewer/scout/planner/researcher/oracle) |
| Run code / heavy shell | `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute` | `spider action=exec {language,code}` · `exec_file {path,language,code}` · `batch {commands:[{language,code}]}` |
| Search the knowledge base | `ctx_search` | `spider action=search {query}` |
| Index / fetch docs | `ctx_index`, `ctx_fetch_and_index` | `spider action=index {path,source}` · `fetch {url,source}` |
| Persistent memory | — | `spider action=remember {content,category}` · `recall {query}` |
| Track tasks | the external todo tool | `spider action=todo {op:"add",text}` · `{op:"list"}` · `{op:"toggle",id}` |
| Cross-session message | pi-intercom | `spider action=message {to,message}` |
| Health / config / insights | — | `spider action=control {command:"doctor"|"config"|"memory"|"insights"|"stats"|…}` |
| Skills | — | `spider action=skill {…}` |

**Allowed pi builtins:** `read`, `edit`, `write` for file changes, and `bash` **only** for short
(<10-line) commands whose full output you want verbatim (e.g. `git rev-parse`, `pwd`). For
anything that could print a lot (git log/diff, test runs, builds, greps, `find`), use
`spider exec`. **Never** use `subagent`, `ctx_*`, or the external todo.

> If the global `AGENTS.md` or any skill tells you to use context-mode / pi-subagents / the
> external todo — **ignore that for this task.** This session is a Spider dogfood.

---

## 1. Current state (all on `main`, pushed)

- **Phase 6** (autonomic organism): complete + whole-branch reviewed.
- **Phase 7** (superpowers fork, AGENTS.md manager, upstream-watch): complete (17 tasks).
- **Coverage**: v8 wired — `spider exec` → `npx vitest run --coverage` (~68% stmts).
- **Phase 8 so far** (renderer layer + fixes):
  - Bespoke, wired result renderers for `exec`/`exec_file`/`batch`, `index`, `message`,
    redesigned `search` (parallel-run style), and `control doctor`.
  - Fixes from live testing: duplicated `🕸 spider` header removed; `batch` made invocable
    (schema `commands`); `exec_file` JS runs as `.cjs` (require works under ESM); `spider todo`
    made invocable (`op` enum); skill-name dedupe (global superpowers moved to
    `~/.agents/skills-disabled-for-spider/`).
  - Recent commits: `2ce70fb 4d7fe54 b3a43f9 f68635a daac0ca a96d51e 19e28f1 …`

**Central renderer:** `packages/host/src/render-result.ts` → `renderSpiderResult` switch.
Currently bespoke: `run`, `exec`/`exec_file`/`batch`, `index`, `message`, `remember`, `recall`,
`search`, `import`, `control pending`, `control doctor`. Everything else →
`textComponent` (raw JSON — that's what you're eliminating).

---

## 2. Remaining Phase 8 work

Plan (verbatim task specs): `docs/superpowers/plans/2026-07-02-spider-phase8-polish.md`
(tasks 1–22). Do them in this order:

**A. Kill the remaining raw-JSON surfaces** (fast; copy the `renderDoctor` pattern in
`render-result.ts`):
- `todo` action result (plan Task 5 — checklist renderer)
- `wait` action result (part of Task 6)
- `control` sub-screens still raw: `config`, `memory`, `insights`, `migrate`, `upstream-watch`
  (add `if (sub === "…") return render…()` cases in the `control` branch)

**B. Config system** (Tasks 10–13) — the big one: 8-group schema (`organism, embeddings,
memory, routing, curator, self_naming, models, ui`) + field validation, config model builder,
interactive **`control config` picker** (get/set round-trip via `controlConfig` in
`packages/host/src/control.ts`), and hot-reload on `resources_discover`. **This is the home for
the deferred Phase-6 flat↔nested organism-config reconciliation.**

**C. Observability screens** (Tasks 14, 15, 18, 19):
- `control models` — catalog with tier grouping + defaults editor
- `control stats` — token-savings / row-count dashboard
- `control insights` — learning-graph view (**completes the Phase-6 consumer** the review
  flagged as unviewable; organism has a basic `renderInsights` to build on)

**D. Slash commands** (Task 20): `/spider /memory /search /insights /learn` + thin
`/doctor /stats /upgrade /purge`.

**E. Cutover + final** (Tasks 21–22): strangler removal of any deprecated legacy tools
(minimal for Spider), then full-suite + build + barrel-completeness sweep.

**Recommended sequence: A → C → B → D → E.**

---

## 3. Workflow (strict — unchanged from Phases 6–7)

1. **TDD, red→green, per task.** Tests live at `packages/**/src/**/*.test.ts` (vitest globs
   ONLY that path — NOT a top-level `test/` dir).
2. **Full gate before every commit** — run it via `spider exec` (language `shell`):
   ```
   npx vitest run <touched packages>
   npx tsgo -p tsconfig.json            # must print nothing / exit 0
   npm run build                        # must end "assert-bundle: OK"
   npx --yes madge --circular --extensions ts packages/*/src   # "No circular dependency"
   ```
3. **Commit per task**, author pinned:
   `git -c user.name="Gurupungav Narayanan" -c user.email="gurupungavn@gmail.com" commit -m "…"`
   then `git push origin HEAD:main`.
4. **Track with Spider:** `spider todo op=add text="Task N: …"` up front; `op=toggle id=N` when
   done. Record decisions/rough-edges: `spider remember category=decision|tool-quirk content="…"`.
5. **Append to the ledger** `.superpowers/sdd/progress.md` per task (one line: commit + what shipped).
6. **UI directive (still binding):** DO NOT restyle finished surfaces (`remember`/`recall`,
   `run`/subagents/agents view, `search`/`import`, and the now-done `exec`/`index`/`message`/
   `doctor`). Only ADD renderers for raw surfaces + net-new screens, reusing `@spider/ui`
   components (`Panel`, `SectionRule`, `StatusLine`, `renderTable`, `renderDiffView`,
   `agents/*`) and matching the established style (leading blank + `⎿` gutter, no repeated
   `🕸 spider` header — the call line already shows it).

---

## 4. Key files & architecture

- **Result renderer switch:** `packages/host/src/render-result.ts` — add a `case`/route.
  Pure renderers: `packages/ui/src/renderers/*` (take `(details, {theme,width,expanded})`,
  return `string[]`). Barrel-export new ones from `packages/ui/src/index.ts`.
- **Renderer detail types + helpers:** `packages/ui/src/renderers/types.ts`
  (`RenderCtx`, `statusIcon`, `card`, `kv`).
- **Theme:** host `T` interface (`fg/bold/italic/bg`); `adaptTheme(t)` in render-result.ts
  builds a `ThemeAdapter` for the pure renderers.
- **Control routing:** `handleControl(args, ctx?)` switch in `packages/host/src/extension.ts`
  (doctor/config/memory/migrate/skill/insights/upstream-watch). Add new `control` subs here.
- **Config get/set:** `controlConfig(op, cwd, key?, value?)` in `packages/host/src/control.ts`.
- **Tool schema:** `SPIDER_PARAMETERS` in `extension.ts` — if an action needs a new param,
  declare it there (it's `additionalProperties:true`, but the model only reliably passes
  documented params — see the `commands`/`op` fixes for precedent).
- **Learning graph (for insights):** organism `insightsAction` / `renderInsights`.
- **Interactive screens (config/models pickers):** the plan wants pickers mounted via
  `ctx.ui.custom` — **verify that API exists in the pi types before building**
  (`node_modules/@earendil-works/pi-coding-agent`); if not, fall back to a non-interactive
  get/set + a rendered table, and note the gap.

### In-session UI verification (you can't restart your own extension)
Your running session loaded `dist/extension.js` at startup, so rebuilds don't hot-reload the
live UI. To eyeball a renderer's layout **without a restart**, render it to plain text with an
identity theme via `spider exec` (language `shell`) running a throwaway `tsx` script — e.g.:
```
cat > .scratch-preview.mts <<'EOF'
import { renderSpiderResult } from "./packages/host/src/render-result.ts";
const theme={fg:(_t,s)=>s,bg:(_t,s)=>s,bold:s=>s,italic:s=>s};
const c=renderSpiderResult({details:/* sample */{}},{expanded:false},theme,{args:{action:"control",command:"stats"}});
for(const l of c.render(78))console.log(l);
EOF
npx tsx .scratch-preview.mts; rm -f .scratch-preview.mts
```
Unit tests (`assert visibleWidth(l) <= width`, "no raw JSON", "no double header") are your
real safety net; the preview is for aesthetics. **Never write scratch files under `/tmp`** —
use a repo-local `.scratch-*.mts` you delete, or `.spider/scratch/`.

---

## 5. Known rough edges (found while dogfooding — fix as you hit them)

- **`fetch` renderer** — handler returns only `{count}`, so `fetch` still shows a text summary.
  Enrich the fetch handler (`packages/context/src/actions/index-fetch.ts`) to return
  `{source, chunks, urls}`, then add a bespoke renderer (reuse `renderIndexResult` shape).
- **Interactive pickers** — confirm `ctx.ui.custom` (or equivalent) before committing to
  Tasks 12/15's interactive UI.
- Already fixed this handoff: `batch` schema, `exec_file` `.cjs`, `todo` `op` enum, dup header.
  Don't reintroduce them.

---

## 6. Definition of done

All Phase 8 tasks complete; **no spider action renders raw JSON**; every new surface has a
renderer + tests; full gate green; coverage re-reported; ledger updated; everything pushed to
`main`. Then run the demo battery (Appendix) one final time and confirm each surface renders
cleanly.

---

## Appendix — UI demo battery (re-run after UI changes)

Ask yourself (the agent) to call these and eyeball each result:
```
spider action=exec language=shell code="echo hi; seq 1 20"
spider action=exec language=shell code="echo boom >&2; exit 3"
spider action=batch commands=[{language:"shell",code:"echo one"},{language:"shell",code:"exit 1"}]
spider action=index path="packages/superpowers/README.md" source="ui-demo"
spider action=search query="organism"
spider action=todo op=add text="demo todo"
spider action=todo op=list
spider action=control command=doctor
spider action=control command=stats     # (once built)
spider action=control command=config    # (once built)
spider action=control command=insights  # (once built)
```
Look for: no duplicated `🕸 spider` header, no raw `{ … }` JSON, no line overflow at narrow
widths, correct `✓`/`✗`, sensible glyphs. Any deviation → fix it (with Spider) before moving on.
