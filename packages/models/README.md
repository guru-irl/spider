# @spider/models

Model catalog, tier classification, model selection, and one-shot completion calls for spider. It turns a list of models pi has available into a tiered catalog, picks one model for a task profile, and can call that model directly for a single prompt.

## Responsibility

This package owns:

- Tier classification: mapping a model id to `light`, `standard`, or `heavy` (`deriveTier`).
- Building a catalog of `ModelEntry` records from whatever models the caller enumerates (`catalog`).
- The model selection algorithm: turning a request profile (role, tier, budget, complexity, thinking level, or an explicit model id) into one chosen entry (`pick`).
- A thin wrapper around pi's authenticated `ModelRegistry.streamSimple` for running a single prompt against a chosen model and returning the full text (`complete`).
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
| `complete.ts` | Defines `CompleteOpts`, `CompleteDeps`, `complete()` (runs one prompt through the authenticated registry), and `recordModelStat()` (writes to `model_stats`). |

## Public surface

Exact exports from `src/index.ts`:

| Export | Kind | Purpose |
| --- | --- | --- |
| `deriveTier(id)` | function | Maps a model id string to `"light" \| "standard" \| "heavy"` using a regex heuristic (from `tiers.ts`). |
| `Tier` | type | `"light" \| "standard" \| "heavy"` (re-exported through `catalog.ts`). |
| `ThinkingLevel` | type | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"`, derived from the shared db-core policy. |
| `ModelEntry` | interface | One catalog row: `provider`, `id`, `tier`, `thinking`, optional `thinkingLevelMap`, `vision`, `ctx`, `speed`, `costHint`, `available`. |
| `EnumeratedModel` | type | The shape a caller's `enumerate()` function must return per model, before `catalog()` enriches it. |
| `TIER_PREFERENCE` | const | Default ordered list of copilot model ids to try per tier; `pick()` walks this unless a config overrides it. |
| `catalog(enumerate, overrides?)` | function | Builds `ModelEntry[]` from an `enumerate()` callback, applying tier, speed, cost hint, and any per-model overrides. |
| `PickProfile` | interface | A selection request: `role`, `tier`, `complexity`, `budget`, `needsVision`, `thinkingLevel`, `model`. |
| `PickResult` | interface | `{ entry: ModelEntry; thinkingLevel: ThinkingLevel }`, the result of `pick()`. |
| `ModelsConfig` | interface | Host-supplied config: `autoSelect`, `defaults`, `tierOverrides`, `tierPreference`, `thinkingDefaults`. |
| `pick(entries, profile, cfg?)` | function | Resolves a `PickProfile` against a catalog to one `PickResult`. |
| `DEFAULT_MODELS_CONFIG` | const | A ready `ModelsConfig` built from this package's own defaults. |
| `ROLE_POLICY` | const | Built-in role tiers and thinking levels. |
| `resolveRoleDefaults(entries, configured?)` | function | Resolve shipped role refs for display and dispatch while preserving configured pins. |
| `CompleteOpts` | interface | `{ system?, thinkingLevel?, maxTokens?, registry?, signal?, onThinking? }`, options for `complete()`. |
| `CompleteDeps` | interface | Injectable `{ getModel, run }` pair used by `complete()`; lets tests avoid the network. |
| `complete(model, prompt, opts?, deps?)` | function | Runs one prompt against a `ModelEntry` or `PickResult` and returns the full response text. |
| `recordModelStat(db, stat)` | function | Inserts one row (`model, ms, ok, tokens, ts`) into `model_stats`. |

## How it fits

- Depends on `@spider/db-core` for the `Db` type used by `recordModelStat` and the shared runtime thinking resolver. This package does not open or migrate a database. Pi model and registry APIs are type imports; the caller supplies the authenticated registry, so no separate credentials or provider setup are loaded here.
- Depended on by `@spider/host`, which threads `typeof import("@spider/models")` through `ActionCtx.models` on every dispatch. Host uses `catalog()`, built from pi's live model list, in `control/models-cmd.ts` for the `spider control models` listing and for managing `models.defaults.<role>`, and uses `pick()` plus `complete()` to route one-shot calls such as the organism's aux-model digest step in `organism-runtime.ts`.
- Depended on by `@spider/ui`, which imports `ModelEntry` and `Tier` as types only, to group and render catalog rows on the models screen (`screens/models-model.ts`, `screens/models-view.ts`). `@spider/ui` does not call `catalog()`, `pick()`, or `complete()` itself.
- Not depended on by `@spider/subagents`. Subagents resolve model refs for child pi processes with their own `qualifyModelProvider()`, which qualifies a bare model id against pi's model list for a spawned process. It does not use this package.
- In a request, the flow is: pi's model list, adapted by host's `enumerate()` into `EnumeratedModel[]`, built into `ModelEntry[]` by `catalog()`, resolved to one entry and a thinking level by `pick()` for a given `PickProfile`, then either called directly by `complete()` for a single prompt, or handed elsewhere (a subagent dispatch, a role default) outside this package.

## Notes

**Tiers.** `deriveTier(id)` is a regex heuristic over the id string, not a lookup table of known models: `opus` maps to `heavy`; `sonnet` maps to `standard`; `luna`, `haiku`, `mai`, `nano`, `mini`, `flash`, or `small` map to `light`; ids matching `gpt-5.5` or the GPT-6 Astra family map to `heavy`; anything else (the rest of the gpt-5.x family, gemini pro, gpt-4.x) defaults to `standard`. A specific model can be pinned to a different tier through `cfg.tierOverrides` (checked in `pick()`'s internal `effectiveTier`, keyed by `"provider/id"` first, then by bare id) without touching the heuristic. Each tier also carries a fixed `speed` score (light 3, standard 2, heavy 1) and `costHint` (light 0.1, standard 0.5, heavy 1), set once in `catalog()`. Neither value is measured live.

**Model resolution.** `pick()` filters to available entries and any requested vision capability. Explicit `profile.model` and configured `cfg.defaults[role]` pins win, including thinking suffixes. Automatic selection excludes Claude Sonnet 5.5, the GPT-5 family, and GPT-6 Terra, even from custom preferences and generic fallbacks. Automatic family matching strips provider prefixes and date/deployment suffixes, and treats dotted and hyphenated versions alike. An excluded model can still be pinned explicitly using its catalog id. If no eligible automatic model remains, selection throws.

Tier preferences put `github-copilot/gpt-6-luna` (light), `github-copilot/gpt-6.1-sol` (standard), and `github-copilot/claude-opus-5.5` (heavy) first, then bare policy ids and non-Copilot alternatives. Copilot's built-in catalog uses `gpt-6-sol` when `gpt-6.1-sol` is unavailable. Within each visited tier, selection tries preferences, then the newest matching family, then any eligible entry, before visiting nearest tiers. Family fallbacks prefer Luna or Haiku for light work, Sol or Sonnet for standard work, and Opus or Astra for heavy work. Budget and complexity can select a tier explicitly; otherwise the role policy supplies it.

Workers, planners, and researchers use standard at high thinking. Scouts, digest, self naming, and upstream watch use light at low thinking. Reviewers use heavy at high thinking; oracle uses heavy at medium. Unnamed tier defaults are light/low, standard/high, and heavy/medium. Thinking precedence is explicit profile or model suffix, configured role thinking, built-in role thinking, configured tier thinking, then built-in tier thinking. `resolveRoleDefaults()` supplies the host's control display and subagent dispatch with the same provider-qualified refs and thinking suffixes, without persisting built-ins into user config.

**complete().** Accepts a bare `ModelEntry` or a `pick()` `PickResult`. A
`PickResult` supplies its thinking level unless `opts.thinkingLevel` overrides it.
The default path requires `opts.registry`, resolves the real handle with
`registry.find(provider, id)`, and clamps the request through the shared policy
using that handle's `reasoning` and `thinkingLevelMap`. It calls authenticated
`registry.streamSimple(handle, context, { reasoning, maxTokens, signal }).result()`;
`off` omits `reasoning`. This provider-neutral path maps reasoning into the actual
OpenAI and Anthropic payloads. `onThinking` receives requested/effective levels,
supported levels, optional provider value and a notice for caps, upward adjustments,
non-reasoning requests or unknown models. Honored requests have no warning notice.
Error and aborted stop reasons throw with the provider message, even with partial
text. Empty or whitespace-only output also throws. Successful text blocks are
joined into one string. `CompleteDeps` remains a test injection seam; it bypasses
the default registry path and never makes a network call on its own.

**recordModelStat().** Runs a single `INSERT INTO model_stats (model, ms, ok, tokens, ts)` through a raw prepared statement against whatever `Db` handle it is given (project or global). `@spider/host`'s `stats` control command reads the same table back out of the global database.

**Pi contract.** The registry path targets pi 0.87.x and uses root package type
imports. Provider-payload tests use the real registry against fixture HTTP servers;
no personal configuration or real provider calls are involved.

## See also

- [`packages/db-core/README.md`](../db-core/README.md)
- [`packages/host/README.md`](../host/README.md)
- [`packages/ui/README.md`](../ui/README.md)
- [`packages/subagents/README.md`](../subagents/README.md)
