# Spider Documentation Pass Superplan

> **For agentic workers:** Each document below is planned and written by a fresh subagent. A document task means: read the listed source files, outline the document, then write it in full. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Produce a complete, accurate documentation set for the spider monorepo: a root README, an architecture section with a full system diagram and the feedback and learning loops, a README for every package, and a guide on how to use spider well.

**Architecture of this effort:** Documents are written leaves first. Package READMEs and the data model come first, the architecture overview and loop docs build on them, and the root README plus the usage guide come last so they can link to everything. One subagent per document. The controller reviews each document, checks it against the source, and commits.

**Tech stack of the subject:** TypeScript monorepo, npm workspaces, one pi coding-agent extension, SQLite (better-sqlite3 + sqlite-vec), Vite bundle, Vitest.

## Global Constraints

These apply to every document and every subagent. Copied verbatim into each brief.

- **No em dashes.** Do not use the `—` character anywhere. Rewrite with commas, periods, parentheses, or a colon. Hyphens in compound words are fine.
- **No AI-esque language.** Do not use: delve, seamless, seamlessly, unleash, leverage (as a filler verb; "use" is fine), robust (as filler), elevate, game-changer, cutting-edge, "in today's world", "it's worth noting", "dive in", "dive into", embark, realm, tapestry, testament, "navigate the complexities", empower, "streamline" as filler, "at the end of the day", "that said" as a paragraph opener, "look no further", "unlock", "supercharge", "effortless", "boasts", "rich set of", "powerful" as filler, "simply", "just" as filler.
- **Neutral, natural tone.** Short declarative sentences. State what a thing does and why it exists. No marketing voice, no hype, no second-person cheerleading. It is fine to address the reader as "you" in the usage guide when giving instructions.
- **Accuracy over completeness.** Read the actual source before describing behavior. Do not invent flags, exports, or file names. If something is uncertain, describe what the code does and stop there.
- **Audience.** A competent developer who has never seen spider. Explain domain terms once, then use them.
- **Format.** GitHub-flavored Markdown. Fenced code blocks with language tags. Diagrams in Mermaid (` ```mermaid `). Relative links between docs. Keep line length reasonable but do not hard-wrap mid-sentence in tables.
- **Every document ends with a short "See also" list** linking related docs by relative path.
- **Do not run git.** Write the file and report. The controller commits.
- **Node 24 only** for any command you run (`~/.volta/tools/image/node/24.16.0/bin` on PATH). Do not run the test gate; these are docs.

---

## Shared Source Index

Every document subagent reads this section first. It is the ground truth for names and responsibilities. Verify against source before writing.

### What spider is

Spider is a single pi coding-agent extension that puts memory, unified search, todos, subagents, sandboxed execution, web fetch, and a skills library on one shared SQLite database. It replaces three older pi extensions (`pi-subagents`, `context-mode`, and a standalone todo tool). Everything the agent does goes through one tool named `spider` with an `action` parameter, plus a set of slash commands.

### The shared database (DB as truth)

- A **global registry DB** at `~/.pi/agent/spider/spider.db` tracks projects and holds global-scope memory and skills.
- A **per-project DB** at `<project>/.spider/project.db` holds that project's memory, todos, indexed content, runs, and sessions.
- `@spider/db-core` owns schema, migrations, connection handling, and a `run_events` bus. Native modules are `better-sqlite3` (SQL) and `sqlite-vec` (vector search). These are compiled for the running Node ABI; spider pins Node 24.
- Precedence for config and memory is defaults, then global, then project.

### Packages (dependency order, leaves first)

| Package | Responsibility | Key files (under `packages/<pkg>/src/`) |
| --- | --- | --- |
| `@spider/db-core` | SQLite foundation: registry + per-project DBs, schema, migrations, `run_events` bus, path resolution | `db.ts`, `schema.ts`, `migrate.ts`, `registry.ts`, `events.ts`, `paths.ts`, `index.ts` |
| `@spider/models` | Model catalog, tiers (`light`/`standard`/`heavy`), pick/resolve helpers, completion helper | `catalog.ts`, `tiers.ts`, `pick.ts`, `complete.ts`, `index.ts` |
| `@spider/memory` | Structured memory: categories, staged/pending writes (fail-closed), approve/reject, active-memory injection, embeddings queue, scrubber/guardrails, renderers | `actions.ts`, `recall.ts`, `overflow.ts`, `guardrails.ts`, `scrubber.ts`, `scanner.ts`, `hooks.ts`, `embeddings/*`, `renderers.ts`, `index.ts` |
| `@spider/todo` | Durable per-project and per-session todos, FTS sync, store, renderers, `/todos` command surface | `store.ts`, `actions.ts`, `command.ts`, `types.ts`, `renderers.ts`, `index.ts` |
| `@spider/context` | Unified search (FTS + vector fusion), sandboxed exec/exec_file/batch, index/fetch content store with chunking and embeddings, import | `actions/{exec,search,index-fetch,import}.ts`, `content-store.ts`, `chunker.ts`, `fusion.ts`, `fts-query.ts`, `executor.ts`, `fetch.ts`, `freshness.ts`, `index.ts` |
| `@spider/subagents` | Subagent dispatch (single/chain/parallel/pipeline), pi child spawn and args, model resolution, async completion reporting, intercom handoff | `actions/{run,message}.ts`, `single.ts`, `chain.ts`, `parallel.ts`, `coordinators.ts`, `pi-args.ts`, `pi-spawn.ts`, `model-resolve.ts`, `child-reporter.ts`, `intercom.ts`, `index.ts` |
| `@spider/organism` | The autonomic loop: drain sessions, stage memory and skills, curate, self-name, build the learning graph and insights | `drain.ts`, `curator.ts`, `apply.ts`, `learn.ts`, `learning-graph.ts`, `actions.ts`, `passes/*`, `config.ts`, `index.ts` |
| `@spider/superpowers` | Vendored skills library and the spider-managed `AGENTS.md` block; upstream-watch | `agentsmd.ts`, `agentsmd-content.ts`, `skills-dir.ts`, `upstream-watch.ts`, `index.ts` |
| `@spider/ui` | Pure themed renderers and screens for every surface (exec, todo, stats, models, config, insights, agents), reusable TUI components | `renderers/*`, `screens/*`, `components/*`, `agents/*`, `component.ts` |
| `@spider/host` | The pi extension entry point: the `spider` tool, action dispatch and context, control commands, result rendering, routing and safety, slash commands, hooks, agents UI | `extension.ts`, `dispatch.ts`, `render-result.ts`, `control/*`, `slash.ts`, `agents/*`, `result.ts` |

### The loops

Describe these accurately in the architecture and loop docs. They are the point of the system.

1. **Routing loop (token performance).** Large command output and large files are routed to the sandbox (`spider exec`, `exec_file`, `batch`) or indexed (`index`, `fetch`). The bytes stay in the DB. Only what the agent prints or queries enters the model context. `spider search` retrieves relevant slices later. This is what keeps the context window small.

2. **Memory lifecycle.** `spider remember` writes a structured memory linked to a file or skill. Foreground writes persist immediately. Background and auto-captured writes are staged as pending and fail closed; a human approves or rejects them with `spider control memory`. A frozen snapshot of active memory is injected at session start and re-injected next session.

3. **Feedback and learning loop (organism).** On before-compact and on shutdown, the organism drains the session transcript. It runs passes (reflection, learning, todo/memory reconciliation, consolidation) that stage new memory and candidate skills. Curation promotes durable items. The learning graph and insights surface recurring patterns. The result feeds back into the injected memory snapshot and into `AGENTS.md`, so the next session starts better informed.

4. **Subagent loop.** `spider run` dispatches a child pi process with a task, model, and thinking level. The child runs in the background. On completion it reports back through a `spider.subagent_done` message that wakes the parent. Pipelines chain a worker to a reviewer with intercom handoff.

5. **Skills-first loop.** `@spider/superpowers` ships skills and writes the managed `AGENTS.md` block that tells the agent to load skills before acting. Process skills gate creative work; the organism can distill new skills from sessions.

### Terminology

- **Action:** the `action` parameter on the `spider` tool (search, remember, recall, exec, run, todo, control, and so on).
- **Control command:** `spider control <command>` for admin surfaces (doctor, stats, insights, models, config, memory, migrate, upstream-watch).
- **Scope:** `global` or `project`. Determines which DB a memory or setting lives in.
- **Staging / pending:** a memory write held for human approval before it becomes active.
- **Drain:** reading a finished session transcript to extract memory and skills.
- **Curation:** promoting staged items into durable memory or skills.

---

## Documents

Paths are relative to the repo root. Each task lists the source files the subagent must read.

### Batch 1: package READMEs (10 documents, parallel)

For each package, write `packages/<pkg>/README.md` with this outline:

1. Title `# @spider/<pkg>` and a one or two sentence summary.
2. **Responsibility:** what this package owns and what it deliberately does not.
3. **Key modules:** a short table of the main files and what each does.
4. **Public surface:** the main exports from `index.ts` (names and one-line purpose). Read `index.ts` to get these right.
5. **How it fits:** which packages it depends on and which depend on it, and where it sits in a request.
6. **Notes:** any sharp edges (native ABI for db-core, fail-closed staging for memory, FTS sync for todo, ABI/model resolution for subagents, and so on).
7. **See also.**

- [ ] **D1 `packages/db-core/README.md`** — read `packages/db-core/src/{index,db,schema,migrate,registry,events,paths}.ts`.
- [ ] **D2 `packages/models/README.md`** — read `packages/models/src/{index,catalog,tiers,pick,complete}.ts`.
- [ ] **D3 `packages/memory/README.md`** — read `packages/memory/src/{index,actions,recall,overflow,guardrails,scrubber,hooks}.ts` and `embeddings/*`.
- [ ] **D4 `packages/todo/README.md`** — read `packages/todo/src/{index,store,actions,command,types,renderers}.ts`.
- [ ] **D5 `packages/context/README.md`** — read `packages/context/src/{index,content-store,chunker,fusion,fts-query,executor,fetch}.ts` and `actions/*`.
- [ ] **D6 `packages/subagents/README.md`** — read `packages/subagents/src/{index,single,chain,parallel,coordinators,pi-args,pi-spawn,model-resolve,child-reporter,intercom}.ts` and `actions/*`.
- [ ] **D7 `packages/organism/README.md`** — read `packages/organism/src/{index,drain,curator,apply,learn,learning-graph,actions,config}.ts` and `passes/*`.
- [ ] **D8 `packages/superpowers/README.md`** — the package already has a README; read it plus `src/{index,agentsmd,agentsmd-content,skills-dir,upstream-watch}.ts`. Keep the good parts, align structure to the outline above, keep the skills list accurate.
- [ ] **D9 `packages/ui/README.md`** — read `packages/ui/src/index.ts`, `renderers/*`, `screens/*`, `components/*`, `agents/*` (skim; list the surfaces).
- [ ] **D10 `packages/host/README.md`** — read `packages/host/src/{extension,dispatch,render-result,result,slash}.ts` and `control/*`, `agents/*`.

### Batch 2: architecture and data model (3 documents)

- [ ] **D11 `docs/architecture/data-model.md`** — read `packages/db-core/src/{schema,migrate,registry,paths,events}.ts`. Cover the global registry DB and per-project DB, the tables and what they hold, migrations and `user_version`, the `run_events` bus, path resolution, and the native module ABI requirement. Include a Mermaid entity diagram of the main tables and a note that vectors live in a `vec0` virtual table.

- [ ] **D12 `docs/architecture/feedback-and-learning-loops.md`** — read `packages/organism/src/{drain,curator,apply,learn,learning-graph,config}.ts` and `passes/*`, plus `packages/memory/src/{actions,overflow,hooks}.ts` and `packages/context/src/actions/search.ts`. Describe, with a Mermaid sequence or flow diagram for each: the routing loop, the memory lifecycle (foreground vs staged/fail-closed, active snapshot injection), the organism feedback and learning loop (drain, passes, curation, insights, learning graph), and how these feed the next session and `AGENTS.md`. This is the centerpiece; be precise about triggers (before-compact, shutdown, session-start).

- [ ] **D13 `docs/architecture/README.md`** — the architecture overview and the full interaction diagram. Read the Shared Source Index above, the package READMEs from Batch 1 (as written), and `packages/host/src/{extension,dispatch}.ts`. Cover: the one-tool model, the layered package structure, the shared DB, and how a single `spider` call flows from the tool through host dispatch into a package action and back through a renderer. Include one master Mermaid diagram showing all packages and the DB and how they connect, plus a smaller request-flow diagram. Link to D11 and D12 for detail.

### Batch 3: root README and usage guide (2 documents)

- [ ] **D14 `README.md`** (repo root) — read `package.json`, `scripts/{postinstall,dev-link,link}.mjs`, `docs/architecture/README.md` (as written), and the Shared Source Index. Cover: what spider is (short), the single-tool model, install and build (Node 24, native modules, `npm run link` for a stable install vs `npm run dev:link` for development), a one-screen quickstart, a package map table linking to each package README, and links into `docs/`. Keep it tight. This is the front door.

- [ ] **D15 `docs/guide/using-spider.md`** — read the Shared Source Index, `packages/superpowers/src/agentsmd-content.ts` (the managed workflow guidance), `packages/host/src/slash.ts`, and D12/D13 as written. Cover: how to get the most out of spider day to day; when to use `exec`/`exec_file`/`batch` vs raw reads; search and index habits; memory discipline and approving staged writes; dispatching subagents with the right model and thinking level; todos; slash commands; recommended global setup (`~/.pi/agent`, the managed `AGENTS.md`, stable install) and recommended per-project setup (`.spider/`, scratch under `.spider/scratch`, indexing reference material). Practical and example-driven.

### Final: cross-linking and verification (controller)

- [ ] Verify every Mermaid block parses, every relative link resolves, and no document contains an em dash or a banned word. Fix inline.
- [ ] Add a short docs index to `docs/README.md` if one does not exist.
- [ ] Commit each batch with the pinned author and push to `origin HEAD:main`.

---

## Execution

- Phase 0 (controller): write this plan. Done when committed.
- Phase 1: dispatch Batch 1 (10 package READMEs) as parallel subagents. Review each against source, fix tone, commit.
- Phase 2: dispatch Batch 2 (data model, loops, overview) after Batch 1 lands so they can link to package READMEs. Review, commit.
- Phase 3: dispatch Batch 3 (root README, usage guide) after Batch 2. Review, commit.
- Phase 4: controller cross-links, verifies, adds `docs/README.md` index, pushes.

**Model assignment.** Package READMEs and the data model are medium complexity: `github-copilot/claude-sonnet-5`, thinking medium. The loops doc, architecture overview, root README, and usage guide are higher stakes: `github-copilot/claude-opus-4.8`, thinking high. Every subagent gets `context:"fresh"` and the Global Constraints verbatim.
