# @spider/models

This package holds spider's model catalog, tier classification, model selection and one-shot completion calls. It turns the list of models that pi has available into a tiered catalog, picks one model for a task profile, and can call that model directly with a single prompt.

## Responsibility

This package owns:

- Tier classification, which maps a model id to `light`, `standard`, or `heavy` (`deriveTier`).
- Building a catalog of `ModelEntry` records from the models the caller enumerates (`catalog`).
- The model selection algorithm. It turns a request profile (role, tier, budget, complexity, thinking level, or an explicit model id) into one chosen entry (`pick`).
- A thin wrapper around pi's authenticated `ModelRegistry.streamSimple` that runs a single prompt against a chosen model and returns the full text (`complete`).
- Writing model invocation stats to the `model_stats` table (`recordModelStat`).

This package does not own:

- Discovering which models exist at runtime. `catalog()` takes an `enumerate()` callback. It never calls a provider API or pi itself to list models. The caller (`@spider/host`) asks pi for its live model list and converts it into `EnumeratedModel[]`.
- Storing or loading model configuration. `pick()` takes a `Partial<ModelsConfig>` (defaults, tier overrides, tier preference, thinking defaults) as a plain argument. The host saves that configuration through `spider control config`.
- Resolving model refs for spawned subagent processes. `@spider/subagents` has its own `qualifyModelProvider()`, which turns a bare model id into a provider-qualified CLI flag for a child pi process. Picking a model to call in-process is a separate problem.

## Key modules

| File | What it does |
| --- | --- |
| `index.ts` | Barrel file. Re-exports everything from `catalog.ts`, `pick.ts`, and `complete.ts`, plus `deriveTier` from `tiers.ts`. |
| `tiers.ts` | Defines the `Tier` type (`light`, `standard` or `heavy`) and `deriveTier(id)`, a regex heuristic that maps a model id string to a tier. |
| `catalog.ts` | Defines `ModelEntry`, `EnumeratedModel`, `ThinkingLevel`, `TIER_PREFERENCE`, and `catalog()`, which builds enriched `ModelEntry` records from enumerated models. |
| `pick.ts` | Defines `PickProfile`, `PickResult`, `ModelsConfig`, `DEFAULT_MODELS_CONFIG`, and `pick()`, the selection algorithm. |
| `complete.ts` | Defines `CompleteOpts`, `CompleteDeps`, `complete()` (runs one prompt through the authenticated registry), and `recordModelStat()` (writes to `model_stats`). |

## Public surface

These are the exact exports from `src/index.ts`:

| Export | Kind | Purpose |
| --- | --- | --- |
| `deriveTier(id)` | function | Maps a model id string to `"light" \| "standard" \| "heavy"` with a regex heuristic (from `tiers.ts`). |
| `Tier` | type | `"light" \| "standard" \| "heavy"` (re-exported through `catalog.ts`). |
| `ThinkingLevel` | type | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"`, derived from the shared db-core policy. |
| `ModelEntry` | interface | One catalog row: `provider`, `id`, `tier`, `thinking`, optional `thinkingLevelMap`, `vision`, `ctx`, `speed`, `costHint`, `available`. |
| `EnumeratedModel` | type | The shape that a caller's `enumerate()` function must return for each model, before `catalog()` enriches it. |
| `TIER_PREFERENCE` | const | The default ordered list of copilot model ids to try for each tier. `pick()` walks this list unless a config overrides it. |
| `catalog(enumerate, overrides?)` | function | Builds `ModelEntry[]` from an `enumerate()` callback and applies the tier, speed, cost hint and any per-model overrides. |
| `PickProfile` | interface | A selection request: `role`, `tier`, `complexity`, `budget`, `needsVision`, `thinkingLevel`, `model`. |
| `PickResult` | interface | `{ entry: ModelEntry; thinkingLevel: ThinkingLevel }`, the result of `pick()`. |
| `ModelsConfig` | interface | Config that the host supplies: `autoSelect`, `defaults`, `tierOverrides`, `tierPreference`, `thinkingDefaults`. |
| `pick(entries, profile, cfg?)` | function | Resolves a `PickProfile` against a catalog to one `PickResult`. |
| `DEFAULT_MODELS_CONFIG` | const | A ready `ModelsConfig` built from this package's own defaults. |
| `ROLE_POLICY` | const | Built-in role tiers and thinking levels. |
| `resolveRoleDefaults(entries, configured?)` | function | Resolves shipped role refs for display and dispatch, and keeps configured pins. |
| `CompleteOpts` | interface | `{ system?, thinkingLevel?, maxTokens?, registry?, signal?, onThinking? }`, the options for `complete()`. |
| `CompleteDeps` | interface | An injectable `{ getModel, run }` pair that `complete()` uses. It lets tests avoid the network. |
| `complete(model, prompt, opts?, deps?)` | function | Runs one prompt against a `ModelEntry` or `PickResult` and returns the full response text. |
| `recordModelStat(db, stat)` | function | Inserts one row (`model, ms, ok, tokens, ts`) into `model_stats`. |

## How it fits

- This package depends on `@spider/db-core` for the `Db` type that `recordModelStat` uses and for the shared runtime thinking resolver. It does not open or migrate a database. The pi model and registry APIs are type imports. The caller supplies the authenticated registry, so this package loads no separate credentials or provider setup.
- `@spider/host` depends on this package and passes `typeof import("@spider/models")` through `ActionCtx.models` on every dispatch. In `control/models-cmd.ts`, the host uses `catalog()`, built from pi's live model list, for the `spider control models` listing and for managing `models.defaults.<role>`. It uses `pick()` and `complete()` to route one-shot calls, such as the organism's aux-model digest step in `organism-runtime.ts`.
- `@spider/ui` depends on this package. It imports `ModelEntry` and `Tier` as types only, to group and render catalog rows on the models screen (`screens/models-model.ts`, `screens/models-view.ts`). `@spider/ui` does not call `catalog()`, `pick()`, or `complete()` itself.
- `@spider/subagents` does not depend on this package. Subagents resolve model refs for child pi processes with their own `qualifyModelProvider()`, which qualifies a bare model id against pi's model list for a spawned process.
- A request flows like this. The host's `enumerate()` adapts pi's model list into `EnumeratedModel[]`. `catalog()` builds that into `ModelEntry[]`. For a given `PickProfile`, `pick()` resolves the catalog to one entry and a thinking level. Then `complete()` either calls that entry directly with a single prompt, or the entry goes to a consumer outside this package, such as a subagent dispatch or a role default.

## Notes

**Tiers.** `deriveTier(id)` is a regex heuristic over the id string, not a lookup table of known models. The rules are:

- `opus` maps to `heavy`.
- `sonnet` maps to `standard`.
- `luna`, `haiku`, `mai`, `nano`, `mini`, `flash`, or `small` map to `light`.
- Ids that match `gpt-5.5` or the GPT-6 Astra family map to `heavy`.
- Anything else (the rest of the gpt-5.x family, gemini pro, gpt-4.x) defaults to `standard`.

You can pin a specific model to a different tier through `cfg.tierOverrides` without changing the heuristic. The internal `effectiveTier` in `pick()` checks it, keyed first by `"provider/id"` and then by bare id. Each tier also has a fixed `speed` score (light 3, standard 2, heavy 1) and a fixed `costHint` (light 0.1, standard 0.5, heavy 1). `catalog()` sets both once, and neither is measured live.

**Model resolution.** `pick()` keeps only available entries and, if requested, entries with vision. Explicit `profile.model` pins and configured `cfg.defaults[role]` pins win, including their thinking suffixes. Automatic selection excludes Claude Sonnet 5.5, the GPT-5 family and GPT-6 Terra, even from custom preferences and generic fallbacks. Automatic family matching strips provider prefixes and date or deployment suffixes, and treats dotted and hyphenated versions as the same. You can still pin an excluded model explicitly by its catalog id. If no eligible automatic model remains, selection throws.

Tier preferences list `github-copilot/gpt-6-luna` (light), `github-copilot/gpt-6.1-sol` (standard), and `github-copilot/claude-opus-5.5` (heavy) first, then bare policy ids and non-Copilot alternatives. Copilot's built-in catalog uses `gpt-6-sol` when `gpt-6.1-sol` is unavailable. Within each tier it visits, selection tries the preferences, then the newest matching family, then any eligible entry. Only then does it move to the nearest tiers. Family fallbacks prefer Luna or Haiku for light work, Sol or Sonnet for standard work, and Opus or Astra for heavy work. Budget and complexity can select a tier explicitly. Otherwise the role policy supplies it.

Workers, planners, and researchers use standard at high thinking. Scouts, digest, self naming and upstream watch use light at low thinking. Reviewers use heavy at high thinking, and oracle uses heavy at medium. Without a named role, the tier defaults are light with low thinking, standard with high, and heavy with medium. Thinking precedence, from highest to lowest, is the explicit profile or model suffix, configured role thinking, built-in role thinking, configured tier thinking, and built-in tier thinking. `resolveRoleDefaults()` gives the host's control display and subagent dispatch the same provider-qualified refs and thinking suffixes, without saving built-ins into user config.

**complete().** It accepts a bare `ModelEntry` or a `PickResult` from `pick()`. A `PickResult` supplies its thinking level unless `opts.thinkingLevel` overrides it. The default path requires `opts.registry`. It resolves the real handle with `registry.find(provider, id)` and clamps the request through the shared policy, using that handle's `reasoning` and `thinkingLevelMap`. It calls the authenticated `registry.streamSimple(handle, context, { reasoning, maxTokens, signal }).result()`. For `off`, it omits `reasoning`. This provider-neutral path maps reasoning into the actual OpenAI and Anthropic payloads. `onThinking` receives the requested and effective levels, the supported levels, an optional provider value, and a notice. The notice covers caps, upward adjustments, non-reasoning requests and unknown models. A request that is honored as asked gets no warning notice. Error and aborted stop reasons throw with the provider message, even when there is partial text. Empty or whitespace-only output also throws. On success, the text blocks are joined into one string. `CompleteDeps` is still a test injection point. It skips the default registry path and never makes a network call on its own.

**recordModelStat().** It runs a single `INSERT INTO model_stats (model, ms, ok, tokens, ts)` through a raw prepared statement against the `Db` handle it gets, project or global. The `stats` control command in `@spider/host` reads the same table back from the global database.

**Pi contract.** The registry path requires pi 1.2.0 or later and uses type imports from the root package. Provider-payload tests use the real registry against fixture HTTP servers. They use no personal configuration and make no real provider calls.

## See also

- [`packages/db-core/README.md`](../db-core/README.md)
- [`packages/host/README.md`](../host/README.md)
- [`packages/ui/README.md`](../ui/README.md)
- [`packages/subagents/README.md`](../subagents/README.md)
