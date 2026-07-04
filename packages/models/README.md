# @spider/models

Model catalog, tier classification, model selection, and one-shot completion calls for spider. It turns a list of models pi has available into a tiered catalog, picks one model for a task profile, and can call that model directly for a single prompt.

## Responsibility

This package owns:

- Tier classification: mapping a model id to `light`, `standard`, or `heavy` (`deriveTier`).
- Building a catalog of `ModelEntry` records from whatever models the caller enumerates (`catalog`).
- The model selection algorithm: turning a request profile (role, tier, budget, complexity, thinking level, or an explicit model id) into one chosen entry (`pick`).
- A thin wrapper around `@earendil-works/pi-ai` for running a single prompt against a chosen model and returning the full text (`complete`).
- Writing model invocation stats to the `model_stats` table (`recordModelStat`).

This package does not own:

- Discovering which models exist at runtime. `catalog()` takes an `enumerate()` callback; it never calls a provider API or pi itself to list models. The caller (`@spider/host`) asks pi for its live model list and shapes it into `EnumeratedModel[]`.
- Storing or loading model configuration. `pick()` takes a `Partial<ModelsConfig>` (defaults, tier overrides, tier preference, thinking defaults) as a plain argument. Persisting that configuration is the host's job, through `spider control config`.
- Resolving model refs for spawned subagent processes. `@spider/subagents` has its own `qualifyModelProvider()` for turning a bare model id into a provider-qualified CLI flag for a child pi process. That is a separate problem from picking a model to call in-process.

## Key modules

| File | What it does |
| --- | --- |
| `index.ts` | Barrel file. Re-exports everything from `catalog.ts`, `pick.ts`, and `complete.ts`, plus `deriveTier` from `tiers.ts`. |
| `tiers.ts` | Defines the `Tier` type (`light` / `standard` / `heavy`) and `deriveTier(id)`, a regex heuristic that maps a model id string to a tier. |
| `catalog.ts` | Defines `ModelEntry`, `EnumeratedModel`, `ThinkingLevel`, `TIER_PREFERENCE`, and `catalog()`, which builds enriched `ModelEntry` records from enumerated models. |
| `pick.ts` | Defines `PickProfile`, `PickResult`, `ModelsConfig`, `DEFAULT_MODELS_CONFIG`, and `pick()`, the selection algorithm. |
| `complete.ts` | Defines `CompleteOpts`, `CompleteDeps`, `complete()` (runs one prompt through `@earendil-works/pi-ai`), and `recordModelStat()` (writes to `model_stats`). |

## Public surface

Exact exports from `src/index.ts`:

| Export | Kind | Purpose |
| --- | --- | --- |
| `deriveTier(id)` | function | Maps a model id string to `"light" \| "standard" \| "heavy"` using a regex heuristic (from `tiers.ts`). |
| `Tier` | type | `"light" \| "standard" \| "heavy"` (re-exported through `catalog.ts`). |
| `ThinkingLevel` | type | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"`. |
| `ModelEntry` | interface | One catalog row: `provider`, `id`, `tier`, `thinking`, `vision`, `ctx`, `speed`, `costHint`, `available`. |
| `EnumeratedModel` | type | The shape a caller's `enumerate()` function must return per model, before `catalog()` enriches it. |
| `TIER_PREFERENCE` | const | Default ordered list of copilot model ids to try per tier; `pick()` walks this unless a config overrides it. |
| `catalog(enumerate, overrides?)` | function | Builds `ModelEntry[]` from an `enumerate()` callback, applying tier, speed, cost hint, and any per-model overrides. |
| `PickProfile` | interface | A selection request: `role`, `tier`, `complexity`, `budget`, `needsVision`, `thinkingLevel`, `model`. |
| `PickResult` | interface | `{ entry: ModelEntry; thinkingLevel: ThinkingLevel }`, the result of `pick()`. |
| `ModelsConfig` | interface | Host-supplied config: `autoSelect`, `defaults`, `tierOverrides`, `tierPreference`, `thinkingDefaults`. |
| `pick(entries, profile, cfg?)` | function | Resolves a `PickProfile` against a catalog to one `PickResult`. |
| `DEFAULT_MODELS_CONFIG` | const | A ready `ModelsConfig` built from this package's own defaults. |
| `CompleteOpts` | interface | `{ system?, thinkingLevel?, maxTokens? }`, options for `complete()`. |
| `CompleteDeps` | interface | Injectable `{ getModel, run }` pair used by `complete()`; lets tests avoid the network. |
| `complete(model, prompt, opts?, deps?)` | function | Runs one prompt against a `ModelEntry` or `PickResult` and returns the full response text. |
| `recordModelStat(db, stat)` | function | Inserts one row (`model, ms, ok, tokens, ts`) into `model_stats`. |

## How it fits

- Depends on `@spider/db-core` for the `Db` type used by `recordModelStat` (a type-only import; this package does not open or migrate a database itself), and on `@earendil-works/pi-ai` as a peer dependency, imported lazily inside `complete()` so it is not loaded unless `complete()` runs its default runner.
- Depended on by `@spider/host`, which threads `typeof import("@spider/models")` through `ActionCtx.models` on every dispatch. Host uses `catalog()`, built from pi's live model list, in `control/models-cmd.ts` for the `spider control models` listing and for managing `models.defaults.<role>`, and uses `pick()` plus `complete()` to route one-shot calls such as the organism's aux-model digest step in `extension.ts`.
- Depended on by `@spider/ui`, which imports `ModelEntry` and `Tier` as types only, to group and render catalog rows on the models screen (`screens/models-model.ts`, `screens/models-view.ts`). `@spider/ui` does not call `catalog()`, `pick()`, or `complete()` itself.
- Not depended on by `@spider/subagents`. Subagents resolve model refs for child pi processes with their own `qualifyModelProvider()`, which qualifies a bare model id against pi's model list for a spawned process. It does not use this package.
- In a request, the flow is: pi's model list, adapted by host's `enumerate()` into `EnumeratedModel[]`, built into `ModelEntry[]` by `catalog()`, resolved to one entry and a thinking level by `pick()` for a given `PickProfile`, then either called directly by `complete()` for a single prompt, or handed elsewhere (a subagent dispatch, a role default) outside this package.

## Notes

**Tiers.** `deriveTier(id)` is a regex heuristic over the id string, not a lookup table of known models: `opus` maps to `heavy`; `sonnet` maps to `standard`; `haiku`, `mai`, `nano`, `mini`, `flash`, or `small` map to `light`; ids matching `gpt-5.5` map to `heavy`; anything else (the rest of the gpt-5.x family, gemini pro, gpt-4.x) defaults to `standard`. A specific model can be pinned to a different tier through `cfg.tierOverrides` (checked in `pick()`'s internal `effectiveTier`, keyed by `"provider/id"` first, then by bare id) without touching the heuristic. Each tier also carries a fixed `speed` score (light 3, standard 2, heavy 1) and `costHint` (light 0.1, standard 0.5, heavy 1), set once in `catalog()`. Neither value is measured live.

**Model resolution.** `pick()` first filters the catalog to `available` entries (and to `vision` entries if `needsVision` is set), and throws if nothing is left. It then resolves in order: (1) an exact `profile.model` match against `"provider/id"` or a bare id; (2) a role default read from `cfg.defaults[profile.role]`, matched the same way; (3) a target tier computed from `profile.tier`, or from `profile.budget` / `profile.complexity` (`"premium"` or `"high"` maps to heavy, `"cheap"` or `"low"` maps to light, otherwise standard), walking outward from that tier across light, standard, and heavy in order of distance, trying each tier's preference list before falling back to any available entry of that tier; (4) as a last resort, the single available entry with the highest `speed` score. Thinking level is resolved separately from tier: `profile.thinkingLevel`, else `cfg.thinkingDefaults[tier]`, else a built-in default where light and heavy both resolve to `low` and only standard resolves to `medium`.

**complete().** Accepts a bare `ModelEntry` or a `pick()` `PickResult`. When given a `PickResult`, its resolved `thinkingLevel` is used unless `opts.thinkingLevel` is passed explicitly. The default runner, used unless a caller injects `deps`, imports `@earendil-works/pi-ai` at call time, gets a model handle with `getModel(provider, id)`, calls `streamProxy(handle, context, { thinkingLevel, maxTokens })`, and concatenates the text deltas from the resulting stream into one string. `complete()` returns the full text once the stream ends; it does not stream to its own caller. Because the import is lazy, tests can call `complete()` with injected `deps` and never touch the network or load the peer package.

**recordModelStat().** Runs a single `INSERT INTO model_stats (model, ms, ok, tokens, ts)` through a raw prepared statement against whatever `Db` handle it is given (project or global). `@spider/host`'s `stats` control command reads the same table back out of the global database.

**Typing the peer package.** `pi-ai.d.ts` declares a bare ambient module for `@earendil-works/pi-ai` (`declare module "@earendil-works/pi-ai";`), because that package ships without its own types. Calls into it inside `complete.ts` are cast manually rather than type-checked.

## See also

- [`packages/db-core/README.md`](../db-core/README.md)
- [`packages/host/README.md`](../host/README.md)
- [`packages/ui/README.md`](../ui/README.md)
- [`packages/subagents/README.md`](../subagents/README.md)
