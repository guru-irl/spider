# spider Phase 7 — Superpowers fork + AGENTS.md manager + upstream-watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor the `superpowers` fork into `spider/packages/superpowers/` upgraded onto upstream **v6.1.0** (compressed `using-superpowers` bootstrap + harness cleanup), stripped to **pi-only**, retargeted to lead with spider verbs, with four workflow skills rewritten for **intercom auto-wake handoff**; deliver a spider-managed idempotent **AGENTS.md block** in global `~/.pi/agent/AGENTS.md`; add the **`upstream-watch`** skill + `control upstream-watch` command; and contribute both skill tiers via `resources_discover`.

**Architecture:** A new `@spider/superpowers` package holds two things: (1) `skills/` — the full **15-skill** set (14 upstream skills kept + the new `upstream-watch` skill), copied from the existing fork (`/mnt/data/src/superpowers`, v6.0.3+3), upgraded to the v6.1.0 compressed bootstrap, with **all** non-pi harness artifacts stripped and tool references retargeted to spider verbs; and (2) `src/` — the AGENTS.md managed-block manager (`agentsmd.ts` + `agentsmd-content.ts`), the `control upstream-watch` handler (`upstream-watch.ts`), and the package registrar (`index.ts`) that the `host` extension calls at activation. The fork keeps the name `superpowers` for clean upstream diffing. Spider does **not** vendor the fork's always-on `context`-injection bootstrap — `using-superpowers` becomes discoverable-only, and the lean always-on preamble moves into the AGENTS.md block (pi auto-loads AGENTS.md as context per TC6). This upgrade is the **first `upstream-watch` job**.

**Tech Stack:** TypeScript (ESM, Node ≥ 22.19.0), better-sqlite3 via `@spider/db-core` (WAL + busy_timeout + retry), Vitest, esbuild. Skill payload is Markdown (`SKILL.md` frontmatter + body). No new native deps.

## Global Constraints

- **Language:** TypeScript, Node ≥ 22.19.0 (target Node 24). ESM (`"type": "module"`).
- **SQLite driver:** better-sqlite3 (synchronous). WAL + busy_timeout + retry wrapper everywhere DB is opened — always via `@spider/db-core` (`openGlobal`/`openProject`), never a raw `new Database()`.
- **Native deps:** this phase adds **none**.
- **Zero temp-dir:** ALL scratch/intermediate/golden data under `<project>/.spider/scratch/` or `~/.pi/agent/spider/scratch/` via `paths.scratch(scope, cwd?)`. **Never** `/tmp`, `$TMPDIR`, `/var/tmp`, `os.tmpdir()`. AGENTS.md manager + upstream-watch tests build temp files and temp git repos **only** under `paths.scratch(...)`.
- **Bundler:** esbuild; externalize native `.node`. Single extension entry from `host`. `src/` compiles into the ship bundle; `skills/` ships as static Markdown referenced by the `pi` manifest `skills` array (NOT bundled).
- **UI:** all visual output through `@spider/ui`; honor pi theme tokens; 🕸 signature. `upstream-watch` renders its report through a `@spider/ui` component — no ad-hoc `console.log`.
- **Tests:** Vitest; TDD (test first → red → green → refactor). Integration DBs via `openGlobal`/`openProject` in `.spider/scratch/`.
- **Naming (verbatim, do not rename):** the tool is `spider`; the fork stays `superpowers`; internal package `@spider/superpowers`; published `@guru-irl/spider`. Canonical symbols from `docs/superpowers/plans/README.md`: `registerAction`, `openGlobal`, `openProject`, `migrate`, `paths`, `resolveProject`; global table `upstream_refs (package, upstream_repo, upstream_ref, last_reviewed_commit, last_checked_at, notes)`; project table `todos (id, session_id, seq, text, done, created_at, updated_at)`.
- **Skill set is exactly 15:** the 14 upstream skills (`brainstorming`, `dispatching-parallel-agents`, `executing-plans`, `finishing-a-development-branch`, `receiving-code-review`, `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `using-superpowers`, `verification-before-completion`, `writing-plans`, `writing-skills`) **plus** `upstream-watch`. No other spider-specific skills.
- **Pi-only:** no `.claude-plugin`, `.codex-plugin`, `.cursor-plugin`, `.kimi-plugin`, `.opencode`, `GEMINI.md`, `gemini-extension.json`, `hooks/hooks-codex.json`, `hooks/hooks-cursor.json`, non-pi `tests/*`, or `references/{claude-code,codex,copilot,gemini,antigravity}-tools.md` may appear anywhere under `packages/superpowers/`. Only `references/pi-tools.md` survives.
- **Token budget:** the AGENTS.md managed block targets **~1.5–2K tokens** (proxy: ≤ **8500 chars**), replacing the current ~2.7K always-on (AGENTS.md ~1.4K + using-superpowers ~1.3K) for a net token win.
- **Memory writes:** all `[auto]`/background writes staged, fail-closed (referenced by the AGENTS.md memory-discipline copy; not implemented here).
- **Strangler:** when this phase lands, the standalone `guru-irl/superpowers` pi adapter (`.pi/extensions/superpowers.ts` always-on bootstrap) is deprecated for spider users — spider owns skill discovery + the AGENTS.md preamble. Note in Task 16 cutover.

---

## Interfaces consumed from earlier phases (do not redefine — import them)

**From `@spider/db-core` (Phase 0):**
```ts
import { openGlobal, openProject, migrate, paths, resolveProject } from "@spider/db-core";
import type { Db, ProjectInfo } from "@spider/db-core";
// paths.scratch(scope: "global" | "project", cwd?: string): string
// paths.globalRoot: string   // ~/.pi/agent/spider
// openGlobal(): Db ; openProject(projectKey: string): Db ; migrate(db, scope): void
```
> **VALIDATE FIRST:** confirm `paths` exposes `globalRoot`; confirm `openGlobal()` needs no args and `migrate(db,"global")` creates `upstream_refs`. Both are asserted by Phase 0 Task-6 (`upstream_refs` is in the global-scope table list). If `openProject` needs a `projectKey` (it does), tests register a temp project via `resolveProject(cwd)` first.

**From `@spider/host` (Phase 0 dispatcher):**
```ts
import { registerAction } from "@spider/host";   // re-exported from packages/host/src/extension.ts
export type ActionHandler = (args: SpiderArgs, ctx: unknown) => Promise<unknown> | unknown;
export function registerAction(name: string, handler: ActionHandler): void;
```
> **VALIDATE FIRST:** Phase 0 owns `control` (`registerAction("control", handleControl)`) and `packages/host/src/control.ts` routes by `args.command`. Phase 7 adds the `upstream-watch` case to that router (Task 15). Confirm `control.ts` switches on `command` and receives `ctx` (with a resolvable global DB + project + sessionId). If the host has a `registerControlCommand(name, handler)` seam, prefer it over editing the switch — validate at execution.

**From `@spider/host` resources_discover wiring (Phase 0):**
Phase 0 `packages/host/src/hooks.ts` registers `pi.on("resources_discover", () => undefined)`. Phase 7 replaces that placeholder so it returns `{ skillPaths }` from `@spider/superpowers` (Task 12/16).
> **VALIDATE FIRST:** confirm whether pi **merges** `skillPaths` across multiple `resources_discover` handlers or uses only the first. If it merges, Phase 7 may register an additional handler; if it uses the first, Phase 7 **must** edit the Phase 0 placeholder to delegate. This plan assumes the safe path (edit the placeholder). Confirm before Task 16.

**From `@spider/ui` (Phase 0 skeleton):**
```ts
import { Panel, ListView, Callout, theme } from "@spider/ui";   // theme.glyph === "🕸"
```

**From Phase 4 (intercom auto-wake) — referenced by the rewritten skills, not imported here:**
- `spider run { pipeline:[...], handoff:"intercom" }` — first-class push-based multi-phase pipeline; a finishing stage wakes the next stage with its outputs via intercom (replaces `spawn → wait → process → spawn-next`).
- `spider run { agent, role, task, model, context:"fresh"|"fork", async }` — single/chain/parallel/async spawn.
- `spider wait { id?, all? }` — await runs.
- `spider message { to, message }` — thin wrapper over pi-intercom; mirrored to `message_mirror`.
- `handoff` `run_event` edges recorded per pipeline stage (Phase 5 footer/grid visualize them).

---

## Source of truth for vendoring

- **Baseline copy:** `/mnt/data/src/superpowers/skills/` (fork v6.0.3+3, 14 skills). Copy verbatim, then apply the v6.1.0 delta + strip + retarget + rewrite per the tasks below.
- **v6.1.0 delta (from the spec + release notes, https://github.com/obra/superpowers/releases/tag/v6.1.0):** compressed `using-superpowers` bootstrap; **deleted** `references/claude-code-tools.md` + `references/copilot-tools.md` (and, for pi-only, ALSO delete `codex-tools.md`, `gemini-tools.md`, `antigravity-tools.md`); Codex marketplace + hook removal; Gemini removal. Re-fetch the release page via `spider fetch` / `ctx_fetch_and_index` if the exact compressed bootstrap wording is needed.
- **Do NOT vendor:** the fork's `.pi/extensions/superpowers.ts` (always-on bootstrap adapter), `.opencode/`, `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, `.kimi-plugin/`, `gemini-extension.json`, `GEMINI.md`, `CLAUDE.md`, `hooks/`, `scripts/`, `tests/`, `.version-bump.json`. Spider's `host` owns activation; the AGENTS.md block owns the always-on preamble.

---

## File Structure (all under `spider/packages/superpowers/`)

- `package.json`, `tsconfig.json` — manifest (`@spider/superpowers`; deps `@spider/db-core`, `@spider/ui`; peer `@earendil-works/pi-coding-agent`).
- `skills/<15 skills>/SKILL.md` (+ each skill's existing sibling reference/prompt/script files, minus stripped non-pi refs). `skills/using-superpowers/references/pi-tools.md` is the ONLY surviving reference-tools file.
- `src/index.ts` — `registerSuperpowers(host, pi, opts?)`: writes the AGENTS.md block once per process, registers `control upstream-watch` delegation, exposes `contributeSkillPaths(cwd)`.
- `src/agentsmd-content.ts` — `SPIDER_BLOCK_BODY` (the folded preamble text) + `buildSpiderBlock()`.
- `src/agentsmd.ts` — pure `upsertManagedBlock(existing, block)` + IO `writeAgentsMd(path)` + `defaultAgentsMdPath()`.
- `src/skills-dir.ts` — `baselineSkillsDir()` + `projectSkillsDir(cwd)` + `contributeSkillPaths(cwd)`.
- `src/upstream-watch.ts` — `diffUpstream`, `runUpstreamWatch`, `seedUpstreamRefs`, types + `GitRunner`.
- `test/agentsmd.test.ts`, `test/skills-guard.test.ts`, `test/upstream-watch.test.ts`, `test/skills-dir.test.ts`.

Host wiring (under `spider/packages/host/src/`):
- `extension.ts` — call `registerSuperpowers(host, pi)` at activation.
- `hooks.ts` — `resources_discover` returns `{ skillPaths: contributeSkillPaths(cwd) }`.
- `control.ts` — route `command === "upstream-watch"` to the superpowers handler.

---

### Task 1: Scaffold `@spider/superpowers` package

**Files:**
- Create: `spider/packages/superpowers/package.json`
- Create: `spider/packages/superpowers/tsconfig.json`
- Create: `spider/packages/superpowers/src/index.ts`
- Create: `spider/packages/superpowers/test/smoke.test.ts`

**Interfaces:**
- Consumes: workspace root `spider/package.json` (`workspaces: ["packages/*"]`), `tsconfig.base.json`, `vitest.config.ts` (Phase 0).
- Produces: `@spider/superpowers` resolvable; `registerSuperpowers` + `contributeSkillPaths` exported (stubs).

- [ ] **Step 1: Write the failing test**

```ts
// test/smoke.test.ts
import { describe, it, expect } from "vitest";
import * as pkg from "../src/index.js";

describe("@spider/superpowers", () => {
  it("exports registerSuperpowers and contributeSkillPaths", () => {
    expect(typeof pkg.registerSuperpowers).toBe("function");
    expect(typeof pkg.contributeSkillPaths).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers`
Expected: FAIL — cannot find module `../src/index.js`.

- [ ] **Step 3: Create the manifest, tsconfig, and stub entry**

```json
// packages/superpowers/package.json
{
  "name": "@spider/superpowers",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run" },
  "dependencies": {
    "@spider/db-core": "*",
    "@spider/ui": "*"
  },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*" }
}
```

```json
// packages/superpowers/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": "src", "outDir": "dist" }, "include": ["src"] }
```

```ts
// packages/superpowers/src/index.ts
export function registerSuperpowers(_host: unknown, _pi: unknown, _opts?: unknown): void {
  // filled by later tasks
}
export function contributeSkillPaths(_cwd: string): string[] {
  return []; // filled by Task 12
}
```

Run `npm install` at the workspace root so the new workspace resolves.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/superpowers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/package.json spider/packages/superpowers/tsconfig.json spider/packages/superpowers/src/index.ts spider/packages/superpowers/test/smoke.test.ts spider/package-lock.json
git commit -m "feat(superpowers): scaffold @spider/superpowers package"
```

---

### Task 2: Vendor the 14 skills, strip all non-pi harness artifacts

**Files:**
- Create: `spider/packages/superpowers/skills/**` (copy from `/mnt/data/src/superpowers/skills/`)
- Create: `spider/packages/superpowers/test/skills-guard.test.ts`

**Interfaces:**
- Consumes: nothing (filesystem content + guard test).
- Produces: `skills/` with the 14 upstream skill dirs, pi-only references, no cross-harness artifacts. The guard test is the executable contract for this and every later skill task.

- [ ] **Step 1: Write the failing test (the vendoring guard)**

```ts
// test/skills-guard.test.ts
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const EXPECTED_14 = [
  "brainstorming", "dispatching-parallel-agents", "executing-plans",
  "finishing-a-development-branch", "receiving-code-review", "requesting-code-review",
  "subagent-driven-development", "systematic-debugging", "test-driven-development",
  "using-git-worktrees", "using-superpowers", "verification-before-completion",
  "writing-plans", "writing-skills",
];

describe("skills vendoring guard", () => {
  it("contains the 14 upstream skills, each with a SKILL.md", () => {
    for (const name of EXPECTED_14) {
      expect(fs.existsSync(path.join(skillsDir, name, "SKILL.md")), `${name}/SKILL.md`).toBe(true);
    }
  });

  it("keeps ONLY pi-tools.md under using-superpowers/references", () => {
    const refs = path.join(skillsDir, "using-superpowers", "references");
    const files = fs.readdirSync(refs).sort();
    expect(files).toEqual(["pi-tools.md"]);
  });

  it("has no non-pi harness reference-tool files anywhere", () => {
    const banned = /(claude-code|codex|copilot|gemini|antigravity)-tools\.md$/;
    const hits = walk(skillsDir).filter((f) => banned.test(f));
    expect(hits).toEqual([]);
  });

  it("has no cross-harness plugin/hook artifacts", () => {
    const banned = /(\.claude-plugin|\.codex-plugin|\.cursor-plugin|\.kimi-plugin|\.opencode|GEMINI\.md|gemini-extension\.json|hooks-codex\.json|hooks-cursor\.json)/;
    const hits = walk(skillsDir).filter((f) => banned.test(f));
    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers -- skills-guard`
Expected: FAIL — `skills/` does not exist.

- [ ] **Step 3: Vendor + strip**

Copy the skill dirs verbatim, then delete non-pi references. Concrete commands (run from `spider/packages/superpowers/`):

```bash
mkdir -p skills
cp -R /mnt/data/src/superpowers/skills/. skills/
# Strip all non-pi reference-tool files (keep only pi-tools.md)
rm -f skills/using-superpowers/references/claude-code-tools.md \
      skills/using-superpowers/references/codex-tools.md \
      skills/using-superpowers/references/copilot-tools.md \
      skills/using-superpowers/references/gemini-tools.md \
      skills/using-superpowers/references/antigravity-tools.md
# Defensive: remove any stray non-pi artifacts that may have been copied
find skills -name 'GEMINI.md' -o -name 'gemini-extension.json' \
      -o -name 'hooks-codex.json' -o -name 'hooks-cursor.json' | xargs -r rm -f
```

Do **not** copy `.pi/`, `.opencode/`, `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, `.kimi-plugin/`, `hooks/`, `scripts/`, `tests/`, `GEMINI.md`, `gemini-extension.json`, `CLAUDE.md`, `.version-bump.json` — only the `skills/` subtree is vendored.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/superpowers -- skills-guard`
Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/skills spider/packages/superpowers/test/skills-guard.test.ts
git commit -m "feat(superpowers): vendor 14 skills, strip all non-pi harness references"
```

---

### Task 3: Apply the v6.1.0 compressed `using-superpowers` bootstrap (pi-only)

**Files:**
- Modify: `spider/packages/superpowers/skills/using-superpowers/SKILL.md`
- Modify: `spider/packages/superpowers/test/skills-guard.test.ts` (add v6.1.0 + pi-only assertions)

**Interfaces:**
- Consumes: v6.1.0 delta (see "Source of truth"). Re-fetch the release page with `spider fetch`/`ctx_fetch_and_index` if exact wording is needed.
- Produces: a pi-only `using-superpowers/SKILL.md` — no per-harness "How to Access Skills" / "Platform Adaptation" multi-ref clutter, referencing only `pi-tools.md`.

- [ ] **Step 1: Add the failing assertions to the guard test**

```ts
// append to test/skills-guard.test.ts
import { readFileSync } from "node:fs";

describe("using-superpowers is pi-only (v6.1.0)", () => {
  const md = readFileSync(path.join(skillsDir, "using-superpowers", "SKILL.md"), "utf8");

  it("drops all non-pi harness prose", () => {
    for (const harness of ["Claude Code", "Codex", "Copilot CLI", "Gemini CLI", "OpenCode", "Antigravity"]) {
      expect(md.includes(harness), `mentions ${harness}`).toBe(false);
    }
  });

  it("references only pi-tools.md", () => {
    const refLinks = [...md.matchAll(/references\/([a-z-]+)\.md/g)].map((m) => m[1]).sort();
    expect(new Set(refLinks)).toEqual(new Set(["pi-tools"]));
  });

  it("keeps the invocation rule and red-flags table", () => {
    expect(md).toMatch(/1% chance/i);
    expect(md).toMatch(/Red Flags/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers -- skills-guard`
Expected: FAIL — current SKILL.md mentions Claude Code/Codex/Gemini and links five reference files.

- [ ] **Step 3: Rewrite `using-superpowers/SKILL.md` to the pi-only compressed form**

Keep the frontmatter, the `<SUBAGENT-STOP>` / `<EXTREMELY-IMPORTANT>` blocks, the Instruction Priority section, "The Rule", the skill-flow `dot` graph, the Red Flags table, Skill Priority / Skill Types / User Instructions. **Replace** the multi-harness "How to Access Skills" and "Platform Adaptation" sections with a single pi section:

```markdown
## How to Access Skills

Pi discovers skills from its configured skill directories and installed pi
packages. Pi does not expose Claude Code's `Skill` tool: when a skill applies,
**load and follow it** — use `spider skill` if available, otherwise `read` the
skill's `SKILL.md` — before you respond. For the action→tool mapping on pi, see
[pi-tools.md](references/pi-tools.md).
```

Remove the `references/{claude-code,codex,copilot,gemini,antigravity}-tools.md` link list and any "Gemini loads … automatically via GEMINI.md" line. Preserve everything else verbatim from the vendored copy.

> The instruction-priority line naming "CLAUDE.md, GEMINI.md, AGENTS.md" becomes "AGENTS.md and direct requests" — pi-only.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/superpowers -- skills-guard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/skills/using-superpowers/SKILL.md spider/packages/superpowers/test/skills-guard.test.ts
git commit -m "feat(superpowers): compress using-superpowers to pi-only (v6.1.0 bootstrap)"
```

---

### Task 4: Retarget `pi-tools.md` to lead with spider verbs

**Files:**
- Modify: `spider/packages/superpowers/skills/using-superpowers/references/pi-tools.md`
- Modify: `spider/packages/superpowers/test/skills-guard.test.ts`

**Interfaces:**
- Produces: the canonical action→tool mapping now leads with the `spider` mega-tool verbs (`search`, `exec`/`exec_file`/`batch`, `run`/`wait`, `remember`/`recall`, `todo`, `index`/`fetch`, `message`), with pi built-ins (`read`/`write`/`edit`/`bash`) as the low-level fallback.

- [ ] **Step 1: Add the failing assertion**

```ts
// append to test/skills-guard.test.ts
describe("pi-tools.md leads with spider verbs", () => {
  const md = readFileSync(path.join(skillsDir, "using-superpowers", "references", "pi-tools.md"), "utf8");
  it("maps actions to the spider mega-tool", () => {
    for (const verb of ["spider search", "spider run", "spider exec", "spider remember", "spider todo"]) {
      expect(md.includes(verb), `mentions ${verb}`).toBe(true);
    }
  });
  it("does not present ctx_* / pi-subagents / pi-todo-sqlite as separate installs", () => {
    // spider unifies these; legacy standalone framing is gone
    expect(md).not.toMatch(/If the `context-mode` package is installed/);
    expect(md).not.toMatch(/from `pi-subagents`/);
    expect(md).not.toMatch(/`pi-todo-sqlite`/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers -- skills-guard`
Expected: FAIL — current pi-tools.md frames context-mode/pi-subagents/pi-todo-sqlite as optional standalone installs.

- [ ] **Step 3: Rewrite `pi-tools.md`**

Replace the mapping table and the "Subagents / Task lists / Context-mode" sections so every action resolves to a **`spider`** verb first. Concrete replacement content:

```markdown
# Pi Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "run a
command", "remember a fact"). On pi with spider installed, these resolve to the
single `spider` mega-tool first; pi's lowercase built-ins are the low-level
fallback.

| Action skills request | spider verb (primary) | pi built-in (fallback) |
| --- | --- | --- |
| Search memory / code / sessions / todos | `spider search` | `grep` / `find` |
| Remember a durable fact | `spider remember` (staged if `[auto]`) | — |
| Recall stored facts | `spider recall` | — |
| Run a command over large output | `spider exec` / `spider batch` | `bash` |
| Analyze a large file without editing | `spider exec_file` | `read` (only if you will edit) |
| Index / fetch docs for search | `spider index` / `spider fetch` | — |
| Dispatch a subagent | `spider run` (single/chain/parallel/async, `context:"fresh"\|"fork"`) | — |
| Await subagents | `spider wait` | — |
| Hand a finished stage to the next agent | `spider run { pipeline:[...], handoff:"intercom" }` / `spider message` | — |
| Task tracking (create/mark a todo) | `spider todo` (`list`/`add`/`toggle`/`clear`/`sessions`/`view`) | plan file / `TODO.md` |
| Invoke / distill a skill | `spider skill` | `read` the `SKILL.md` |
| Import a past session | `spider import` | — |
| Admin (stats/doctor/upstream-watch/memory/config) | `spider control <command>` | — |

## Read vs edit

Use `read` (not `spider exec_file`) when you are about to `edit` a file — the
`edit` tool must match exact text. Use `spider exec_file` only when you want
facts about a file you will **not** modify. Prefer `spider exec` / `spider batch`
over raw `bash` whenever output could exceed ~10 lines: the bytes stay sandboxed
and only what you print/query enters context.

## Subagents & auto-wake handoff

`spider run` spawns subagents (single, chain, parallel, async, forked context)
and persists them for the live agents footer/grid. For multi-phase work, prefer
push-based handoff: `spider run { pipeline:[stageA, stageB], handoff:"intercom" }`
wakes each next stage with the previous stage's outputs instead of the blocking
spawn→wait→process→spawn-next cycle. Use `spider message { to, message }` to wake
a specific peer/reviewer directly.

## Memory discipline

Memory is DB-as-truth: `spider remember` stores structured truths that **link
to** files/skills — never duplicate a doc or commit history. Background/`[auto]`
writes are staged (fail-closed); approve with `spider control memory`.
```

Delete the standalone "If the `context-mode` package is installed" / pi-subagents / pi-todo-sqlite paragraphs (spider unifies them).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/superpowers -- skills-guard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/skills/using-superpowers/references/pi-tools.md spider/packages/superpowers/test/skills-guard.test.ts
git commit -m "feat(superpowers): retarget pi-tools mapping to lead with spider verbs"
```

---

### Task 5: Rewrite `subagent-driven-development` for intercom auto-wake

**Files:**
- Modify: `spider/packages/superpowers/skills/subagent-driven-development/SKILL.md`
- Modify: `spider/packages/superpowers/skills/subagent-driven-development/implementer-prompt.md`
- Modify: `spider/packages/superpowers/skills/subagent-driven-development/task-reviewer-prompt.md`
- Create: `spider/packages/superpowers/test/autowake-guard.test.ts`

**Interfaces:**
- Consumes: Phase 4 `spider run`/`wait`/`message`/`run {pipeline, handoff:"intercom"}`.
- Produces: a spider-native SDD skill where the controller dispatches implementers/reviewers with `spider run` and uses **auto-wake** handoff — a finishing implementer wakes its reviewer via intercom with the diff/report outputs; the reviewer wakes the controller/fixer — instead of the controller blocking on `wait` then re-dispatching.

- [ ] **Step 1: Write the failing auto-wake guard test**

```ts
// test/autowake-guard.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");
const read = (rel: string) => readFileSync(path.join(skillsDir, rel), "utf8");

const AUTOWAKE_SKILLS = [
  "subagent-driven-development/SKILL.md",
  "test-driven-development/SKILL.md",
  "dispatching-parallel-agents/SKILL.md",
  "requesting-code-review/SKILL.md",
];

describe("auto-wake rewrite guard", () => {
  it("subagent-driven-development uses spider run + intercom handoff", () => {
    const md = read("subagent-driven-development/SKILL.md");
    expect(md).toMatch(/spider run/);
    expect(md).toMatch(/handoff:\s*"?intercom"?/);
    expect(md).not.toMatch(/Subagent \(general-purpose\):/);
  });

  it("no auto-wake skill fabricates the old Task/Subagent dispatch syntax", () => {
    for (const rel of AUTOWAKE_SKILLS) {
      const md = read(rel);
      expect(md, rel).not.toMatch(/Subagent \(general-purpose\):/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers -- autowake-guard`
Expected: FAIL — current SDD SKILL.md uses "Dispatch implementer subagent" prose and the reviewer templates say `Subagent (general-purpose):`.

- [ ] **Step 3: Rewrite the SDD skill + templates**

In `SKILL.md`, preserve the overall structure (When to Use, Model Selection, Handling Implementer Status, Reviewer prompts, File Handoffs, Durable Progress, Red Flags) but retarget the mechanics:

1. Replace every "Dispatch … subagent" with **"`spider run { agent, role, task, model, context:\"fresh\" }`"**. Reviewers use `role:"reviewer"`, `context:"fresh"`.
2. Add an **Auto-wake handoff** section after "The Process":

```markdown
## Auto-wake Handoff (spider)

Do not block on `spider wait` between every stage. For the per-task
implement → review → fix loop, wire a push pipeline:

`spider run { pipeline: [ implementer, reviewer ], handoff: "intercom" }`

The finishing implementer wakes the reviewer directly with its report + review
package path via intercom; a reviewer that finds Critical/Important issues wakes
a fix stage; a clean review wakes you (the controller) to mark the task
complete. Each hop records a `handoff` edge the agents footer/grid renders. Use
`spider wait { all: true }` only as the final barrier before the whole-branch
review, or when you genuinely have nothing else to do until a run returns.
```

3. In "Constructing Reviewer Prompts" / "File Handoffs", keep `scripts/review-package` and `scripts/task-brief` (they are git/bash utilities and still valid), but note the reviewer is **woken** with the printed paths via the pipeline rather than dispatched by a blocking controller. Where the text runs bash over large output, add "prefer `spider exec`".
4. Keep the model-selection guidance verbatim (still applies — pass `model:` on every `spider run`).

In `implementer-prompt.md` and `task-reviewer-prompt.md`, replace the `Subagent (general-purpose):` header and any `Task(...)`/dispatch framing with a spider-run brief: a plain task prompt block introduced as "This is a `spider run` task brief." Keep all substantive review rubric / status-contract content. In the implementer contract, add: "When done, wake the next stage per the controller's `handoff:\"intercom\"` wiring (send your report + review-package path); if no pipeline was wired, return status normally."

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/superpowers -- autowake-guard`
Expected: PASS (SDD assertions).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/skills/subagent-driven-development spider/packages/superpowers/test/autowake-guard.test.ts
git commit -m "feat(superpowers): rewrite subagent-driven-development for spider run + intercom auto-wake"
```

---

### Task 6: Rewrite `test-driven-development` for spider verbs + auto-wake handoff

**Files:**
- Modify: `spider/packages/superpowers/skills/test-driven-development/SKILL.md`
- Modify: `spider/packages/superpowers/test/autowake-guard.test.ts`

**Interfaces:**
- Produces: the TDD discipline unchanged, but test-run commands retargeted to `spider exec` and a short handoff note so a worker following TDD wakes its reviewer via intercom on green+commit.

- [ ] **Step 1: Add the failing assertion**

```ts
// append to test/autowake-guard.test.ts
describe("test-driven-development is spider-native", () => {
  const md = read("test-driven-development/SKILL.md");
  it("runs suites via spider exec and preserves the Iron Law", () => {
    expect(md).toMatch(/spider exec/);
    expect(md).toMatch(/NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST/);
  });
  it("notes intercom hand-off on green", () => {
    expect(md).toMatch(/handoff|intercom|wake/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers -- autowake-guard`
Expected: FAIL — TDD skill has no `spider exec` / handoff note.

- [ ] **Step 3: Rewrite TDD test-run mechanics + add handoff note**

Preserve the entire TDD skill verbatim (Iron Law, Red-Green-Refactor, rationalizations, checklists). Only:
1. Replace bare `npm test path/to/test.test.ts` invocations in the "Verify RED"/"Verify GREEN" blocks with **`spider exec "npm test path/to/test.test.ts"`** (and note: prefer `spider exec` so large failing output stays sandboxed — print only failures/summary).
2. Add one short subsection at the end of "Verification Checklist":

```markdown
## Handoff on green (when running as a spider subagent)

If you are a worker executing a task in a `handoff:"intercom"` pipeline, when
the suite is green and you have committed, wake the next stage (reviewer) via
intercom with your report + diff path — don't idle waiting to be polled. If you
are not in a pipeline, return your status normally.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/superpowers -- autowake-guard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/skills/test-driven-development/SKILL.md spider/packages/superpowers/test/autowake-guard.test.ts
git commit -m "feat(superpowers): retarget test-driven-development to spider exec + intercom handoff"
```

---

### Task 7: Rewrite `dispatching-parallel-agents` for spider run + intercom

**Files:**
- Modify: `spider/packages/superpowers/skills/dispatching-parallel-agents/SKILL.md`
- Modify: `spider/packages/superpowers/test/autowake-guard.test.ts`

**Interfaces:**
- Produces: parallel dispatch expressed as `spider run { tasks:[...], concurrency? }` (or multiple `spider run` calls in one turn), with intercom used to collect/wake on completion instead of `Subagent (general-purpose):` prose.

- [ ] **Step 1: Add the failing assertion**

```ts
// append to test/autowake-guard.test.ts
describe("dispatching-parallel-agents is spider-native", () => {
  const md = read("dispatching-parallel-agents/SKILL.md");
  it("uses spider run parallel form", () => {
    expect(md).toMatch(/spider run/);
    expect(md).toMatch(/tasks:\s*\[|parallel/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers -- autowake-guard`
Expected: FAIL — current skill uses `Subagent (general-purpose): "..."` blocks.

- [ ] **Step 3: Rewrite the dispatch mechanics**

Preserve the "When to Use", "Common Mistakes", "When NOT to Use", "Verification" sections (they are harness-neutral judgment). Replace the "Dispatch in Parallel" and "Real Example" code blocks:

```markdown
### 3. Dispatch in Parallel

Issue one `spider run` per independent domain in a single turn — they run
concurrently:

    spider run { agent: "worker", task: "Fix agent-tool-abort.test.ts failures", model: "<mid>" }
    spider run { agent: "worker", task: "Fix batch-completion-behavior.test.ts failures", model: "<mid>" }
    spider run { agent: "worker", task: "Fix tool-approval-race-conditions.test.ts failures", model: "<mid>" }

Or dispatch the whole fan-out at once: `spider run { tasks: [ ... ], concurrency: 3 }`.
Collect results with `spider wait { all: true }`, or let each worker wake you via
intercom (`spider message`) as it finishes so you integrate incrementally
instead of blocking on the slowest.
```

Update the "Real Example from Session" dispatch block similarly (three `spider run` lines). Keep the narrative outcomes.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/superpowers -- autowake-guard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/skills/dispatching-parallel-agents/SKILL.md spider/packages/superpowers/test/autowake-guard.test.ts
git commit -m "feat(superpowers): rewrite dispatching-parallel-agents for spider run + intercom"
```

---

### Task 8: Rewrite `requesting-code-review` for auto-wake

**Files:**
- Modify: `spider/packages/superpowers/skills/requesting-code-review/SKILL.md`
- Modify: `spider/packages/superpowers/skills/requesting-code-review/code-reviewer.md`
- Modify: `spider/packages/superpowers/test/autowake-guard.test.ts`

**Interfaces:**
- Produces: review requested via `spider run { role:"reviewer", context:"fresh" }` and, in pipelines, the reviewer is **woken by the finishing worker via intercom** with the diff package; findings wake a fix stage. The `code-reviewer.md` template drops the `Subagent (general-purpose):` header and the `/tmp/review-*` worktree suggestion (zero-temp-dir).

- [ ] **Step 1: Add the failing assertion**

```ts
// append to test/autowake-guard.test.ts
describe("requesting-code-review is spider-native", () => {
  const skill = read("requesting-code-review/SKILL.md");
  const tmpl = read("requesting-code-review/code-reviewer.md");
  it("requests review via spider run reviewer role", () => {
    expect(skill).toMatch(/spider run/);
    expect(skill).toMatch(/role:\s*"?reviewer"?|context:\s*"?fresh"?/);
  });
  it("template drops old dispatch header and /tmp worktree", () => {
    expect(tmpl).not.toMatch(/Subagent \(general-purpose\):/);
    expect(tmpl).not.toMatch(/\/tmp\/review-/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers -- autowake-guard`
Expected: FAIL — template uses `Subagent (general-purpose):` and `git worktree add /tmp/review-[SHA]`.

- [ ] **Step 3: Rewrite the review request mechanics**

In `SKILL.md`: replace "Dispatch code reviewer subagent" with **"`spider run { agent:\"worker\", role:\"reviewer\", context:\"fresh\", model:<scaled>, task:<filled code-reviewer.md> }`"**; add a short note that in a `handoff:"intercom"` pipeline the reviewer is woken by the finishing worker with the review-package path (no controller round-trip), and that the reviewer wakes a fix stage on Critical/Important findings. Keep the SHA capture, "Act on feedback", and Integration sections.

In `code-reviewer.md`: remove the `Subagent (general-purpose):` wrapper header and lead with "This is a `spider run` reviewer brief." Replace the `## Read-Only Review` `git worktree add /tmp/review-[SHA]` sentence with: "If you need a working copy of another revision, add a worktree **under `.spider/scratch/`** (never `/tmp`) — e.g. `git worktree add "$(git rev-parse --show-toplevel)/.spider/scratch/review-[SHA]" [SHA]` — and never move HEAD on this checkout." Suggest `spider exec` for large `git diff` inspection. Keep the full review rubric + output format verbatim.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/superpowers -- autowake-guard`
Expected: PASS (all autowake-guard assertions).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/skills/requesting-code-review spider/packages/superpowers/test/autowake-guard.test.ts
git commit -m "feat(superpowers): rewrite requesting-code-review for spider run reviewer + intercom auto-wake, zero-temp-dir"
```

---

### Task 9: AGENTS.md block content module

**Files:**
- Create: `spider/packages/superpowers/src/agentsmd-content.ts`
- Create: `spider/packages/superpowers/test/agentsmd-content.test.ts`

**Interfaces:**
- Produces:
```ts
export const SPIDER_BLOCK_START = "<!-- spider:start -->";
export const SPIDER_BLOCK_END = "<!-- spider:end -->";
export const SPIDER_BLOCK_BODY: string;              // the folded preamble (no markers)
export function buildSpiderBlock(): string;          // START + "\n" + SPIDER_BLOCK_BODY.trim() + "\n" + END
```
The body folds three disciplines into one lean block: (1) a spider-flavored `using-superpowers` preamble (skills-first), (2) tooling discipline (spider verbs, sandboxed exec, zero-temp-dir), (3) memory discipline (DB-as-truth, staged writes). Target ≤ 8500 chars.

- [ ] **Step 1: Write the failing test**

```ts
// test/agentsmd-content.test.ts
import { describe, it, expect } from "vitest";
import { SPIDER_BLOCK_START, SPIDER_BLOCK_END, SPIDER_BLOCK_BODY, buildSpiderBlock } from "../src/agentsmd-content.js";

describe("spider AGENTS.md block content", () => {
  it("folds skills + tooling + memory discipline", () => {
    expect(SPIDER_BLOCK_BODY).toMatch(/skill/i);           // skills-first preamble
    expect(SPIDER_BLOCK_BODY).toMatch(/spider search/);    // tooling
    expect(SPIDER_BLOCK_BODY).toMatch(/spider run/);
    expect(SPIDER_BLOCK_BODY).toMatch(/remember/);         // memory discipline
    expect(SPIDER_BLOCK_BODY).toMatch(/\.spider\/scratch/); // zero-temp-dir
    expect(SPIDER_BLOCK_BODY).toMatch(/never.*\/tmp/i);
  });

  it("stays within the token budget (≤ 8500 chars)", () => {
    expect(SPIDER_BLOCK_BODY.length).toBeLessThanOrEqual(8500);
  });

  it("buildSpiderBlock wraps the body in the delimiters exactly once", () => {
    const b = buildSpiderBlock();
    expect(b.startsWith(SPIDER_BLOCK_START)).toBe(true);
    expect(b.trimEnd().endsWith(SPIDER_BLOCK_END)).toBe(true);
    expect(b.match(/<!-- spider:start -->/g)!.length).toBe(1);
    expect(b.match(/<!-- spider:end -->/g)!.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers -- agentsmd-content`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `agentsmd-content.ts`**

```ts
// src/agentsmd-content.ts
export const SPIDER_BLOCK_START = "<!-- spider:start -->";
export const SPIDER_BLOCK_END = "<!-- spider:end -->";

export const SPIDER_BLOCK_BODY = `# spider (managed — do not edit inside the markers)

This block is written and updated by the **spider** pi extension. Edits between
the markers are overwritten on upgrade. Put your own notes outside the markers.

## Skills first

You have **superpowers** — a skills library. Before acting on any non-trivial
request, reflexively: if there is even a 1% chance a skill applies, load and
follow it (\`spider skill\`, or \`read\` its \`SKILL.md\`) BEFORE responding —
including before clarifying questions. Start process skills first
(\`brainstorming\`, \`systematic-debugging\`), then implementation
(\`test-driven-development\`, \`writing-plans\`,
\`subagent-driven-development\`, \`requesting-code-review\`,
\`finishing-a-development-branch\`). User instructions in this file always take
precedence over skills.

## The spider tool

Everything runs through the single \`spider\` tool. Prefer its verbs over raw
built-ins:

- \`spider search\` — unified FTS+vector search over memory, content, sessions,
  and todos. Reach for it before re-reading files.
- \`spider exec\` / \`spider exec_file\` / \`spider batch\` — run commands or
  analyze large files in a sandbox; only what you print/query enters context.
  **Prefer these over raw \`bash\`/\`read\` whenever output could exceed ~10
  lines** (git, tests, logs, repo-wide grep). Use plain \`read\` only when you
  will \`edit\` the file (so edits match exact text).
- \`spider index\` / \`spider fetch\` — index files/dirs or fetch+index URLs into
  the knowledge base for \`spider search\`.
- \`spider run\` / \`spider wait\` — dispatch subagents (single/chain/parallel/
  async, \`context:"fresh"|"fork"\`). Always pass an explicit \`model:\` scaled
  to task complexity (cheap for mechanical, capable for architecture/review).
  For multi-phase work use push-based handoff:
  \`spider run { pipeline:[worker, reviewer], handoff:"intercom" }\` — the
  finishing stage wakes the next with its outputs instead of blocking on
  \`wait\`. Give review-only children fresh context and tell them not to edit
  source.
- \`spider todo\` — durable, per-project + per-session task tracking
  (\`list\`/\`add\`/\`toggle\`/\`clear\`/\`sessions\`/\`view\`). One todo per
  checklist item; toggle as you complete each.
- \`spider message\` — wake a specific peer/reviewer session directly.
- \`spider control <command>\` — admin: \`stats\`, \`doctor\`, \`memory\`,
  \`upstream-watch\`, \`config\`, \`insights\`, and more.

## Memory discipline

Memory is **DB-as-truth**. Use \`spider remember\` to store structured truths
that **link to** a file/skill — never duplicate a document or commit history.
Categories: preference, convention, tool-quirk, failure, correction, insight.
Background/\`[auto]\` writes are **staged and fail-closed**; approve or reject via
\`spider control memory\`. A frozen memory snapshot is injected each session —
new writes persist immediately and re-inject next session. Use \`spider recall\`
to fetch by category/scope.

## Scratch — never /tmp

Never use \`/tmp\`, \`$TMPDIR\`, or \`/var/tmp\` for scratch, golden data, or
logs — they are volatile and destroy baselines mid-task. Put all
scratch/intermediate/golden/log data under the project's \`.spider/scratch/\`
(or \`~/.pi/agent/spider/scratch/\` for global work).
`;

export function buildSpiderBlock(): string {
  return `${SPIDER_BLOCK_START}\n${SPIDER_BLOCK_BODY.trim()}\n${SPIDER_BLOCK_END}`;
}
```

> If the char-budget assertion fails, tighten prose — do not drop any of the three disciplines. Keep it comfortably under 8500 (≈ 2K tokens).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/superpowers -- agentsmd-content`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/src/agentsmd-content.ts spider/packages/superpowers/test/agentsmd-content.test.ts
git commit -m "feat(superpowers): spider-managed AGENTS.md block content (folded preamble, ≤2K tokens)"
```

---

### Task 10: AGENTS.md managed-block manager (idempotent, preserves user content)

**Files:**
- Create: `spider/packages/superpowers/src/agentsmd.ts`
- Create: `spider/packages/superpowers/test/agentsmd.test.ts`

**Interfaces:**
- Consumes: `buildSpiderBlock`, `SPIDER_BLOCK_START`, `SPIDER_BLOCK_END` (Task 9); `paths` (only for `defaultAgentsMdPath` fallback — the block lives in `~/.pi/agent/AGENTS.md`, NOT under spider's root).
- Produces:
```ts
export function upsertManagedBlock(existing: string | null, block: string): string;   // PURE
export function isLegacyFiveToolGuide(existing: string): boolean;                      // PURE
export function writeAgentsMd(agentsMdPath: string): { path: string; action: "created" | "updated" | "unchanged" };
export function defaultAgentsMdPath(): string;   // ~/.pi/agent/AGENTS.md
```
Semantics of `upsertManagedBlock`:
- `existing` null/empty → return `block + "\n"` (**created**).
- `existing` contains `START…END` → replace **only** that span with `block`, preserving everything before/after byte-for-byte (**updated/unchanged**).
- `existing` has no markers but **is** the legacy spider-authored five-tool guide (`isLegacyFiveToolGuide`) → return `block + "\n"` (the guide is superseded — **updated**).
- `existing` has no markers and is genuine user content → **prepend** `block + "\n\n" + existing` (**updated**), preserving all user content.

- [ ] **Step 1: Write the failing tests (idempotency + preservation are the acceptance criteria)**

```ts
// test/agentsmd.test.ts
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "@spider/db-core";
import { upsertManagedBlock, isLegacyFiveToolGuide, writeAgentsMd } from "../src/agentsmd.js";
import { buildSpiderBlock, SPIDER_BLOCK_START, SPIDER_BLOCK_END } from "../src/agentsmd-content.js";

const BLOCK = buildSpiderBlock();
function countBlocks(s: string): number {
  return (s.match(/<!-- spider:start -->/g) ?? []).length;
}
let n = 0;
function scratchFile(name: string): string {
  const dir = path.join(paths.scratch("project", process.cwd()), `agentsmd-${process.pid}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

describe("upsertManagedBlock (pure)", () => {
  it("creates the block in an empty/null file", () => {
    const out = upsertManagedBlock(null, BLOCK);
    expect(out).toContain(SPIDER_BLOCK_START);
    expect(countBlocks(out)).toBe(1);
  });

  it("is idempotent — upserting twice yields identical content and one block", () => {
    const once = upsertManagedBlock(null, BLOCK);
    const twice = upsertManagedBlock(once, BLOCK);
    expect(twice).toBe(once);
    expect(countBlocks(twice)).toBe(1);
  });

  it("preserves user content OUTSIDE the block on update", () => {
    const user = "# My notes\n\nKeep this.\n";
    const first = upsertManagedBlock(user, BLOCK);
    expect(first).toContain("Keep this.");
    // simulate a block-content upgrade
    const upgraded = BLOCK.replace(SPIDER_BLOCK_END, "extra line\n" + SPIDER_BLOCK_END);
    const second = upsertManagedBlock(first, upgraded);
    expect(second).toContain("Keep this.");           // user content intact
    expect(second).toContain("extra line");           // block replaced
    expect(countBlocks(second)).toBe(1);              // no duplicate block
  });

  it("preserves user content added AFTER the block", () => {
    const withBlock = upsertManagedBlock(null, BLOCK);
    const edited = withBlock + "\n## User section\nhand-written\n";
    const out = upsertManagedBlock(edited, BLOCK);
    expect(out).toContain("hand-written");
    expect(countBlocks(out)).toBe(1);
  });

  it("replaces the legacy five-tool guide wholesale", () => {
    const legacy = "# Agent operating guide (global)\n\n## Task tracking — `todo`\n...\n";
    expect(isLegacyFiveToolGuide(legacy)).toBe(true);
    const out = upsertManagedBlock(legacy, BLOCK);
    expect(out).not.toContain("Agent operating guide (global)");
    expect(countBlocks(out)).toBe(1);
  });

  it("prepends (does not delete) genuine user content with no markers", () => {
    const user = "# Personal AGENTS\nremember my preferences\n";
    const out = upsertManagedBlock(user, BLOCK);
    expect(out.indexOf(SPIDER_BLOCK_START)).toBeLessThan(out.indexOf("Personal AGENTS"));
    expect(out).toContain("remember my preferences");
  });
});

describe("writeAgentsMd (IO)", () => {
  it("creates the file then reports unchanged on a second write", () => {
    const p = scratchFile("AGENTS.md");
    const r1 = writeAgentsMd(p);
    expect(r1.action).toBe("created");
    expect(fs.readFileSync(p, "utf8")).toContain(SPIDER_BLOCK_START);
    const r2 = writeAgentsMd(p);
    expect(r2.action).toBe("unchanged");
  });

  it("creates parent directories if missing", () => {
    const p = path.join(paths.scratch("project", process.cwd()), `agentsmd-nested-${process.pid}-${n++}`, "deep", "AGENTS.md");
    const r = writeAgentsMd(p);
    expect(r.action).toBe("created");
    expect(fs.existsSync(p)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers -- agentsmd.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `agentsmd.ts`**

```ts
// src/agentsmd.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SPIDER_BLOCK_START, SPIDER_BLOCK_END, buildSpiderBlock } from "./agentsmd-content.js";

export function isLegacyFiveToolGuide(existing: string): boolean {
  // The pre-spider global guide spider replaces. Match its distinctive heading
  // AND a section only that guide carries, so we never nuke unrelated user files.
  return /^#\s*Agent operating guide \(global\)/m.test(existing)
    && /##\s*Task tracking\s*—?\s*`?todo`?/.test(existing);
}

export function upsertManagedBlock(existing: string | null, block: string): string {
  if (existing == null || existing.trim() === "") return `${block}\n`;

  const start = existing.indexOf(SPIDER_BLOCK_START);
  const end = existing.indexOf(SPIDER_BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + SPIDER_BLOCK_END.length);
    return `${before}${block}${after}`;
  }

  if (isLegacyFiveToolGuide(existing)) return `${block}\n`;

  return `${block}\n\n${existing}`;
}

export function defaultAgentsMdPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "AGENTS.md");
}

export function writeAgentsMd(agentsMdPath: string): { path: string; action: "created" | "updated" | "unchanged" } {
  const block = buildSpiderBlock();
  let existing: string | null = null;
  let existed = false;
  try {
    existing = fs.readFileSync(agentsMdPath, "utf8");
    existed = true;
  } catch {
    existing = null;
  }
  const next = upsertManagedBlock(existing, block);
  if (existed && next === existing) return { path: agentsMdPath, action: "unchanged" };
  fs.mkdirSync(path.dirname(agentsMdPath), { recursive: true });
  fs.writeFileSync(agentsMdPath, next, "utf8");
  return { path: agentsMdPath, action: existed ? "updated" : "created" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/superpowers -- agentsmd.test`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/src/agentsmd.ts spider/packages/superpowers/test/agentsmd.test.ts
git commit -m "feat(superpowers): idempotent AGENTS.md managed-block manager (preserves user content, replaces legacy guide)"
```

---

### Task 11: `skills-dir` — resolve baseline + project skill tiers

**Files:**
- Create: `spider/packages/superpowers/src/skills-dir.ts`
- Create: `spider/packages/superpowers/test/skills-dir.test.ts`

**Interfaces:**
- Produces:
```ts
export function baselineSkillsDir(): string;              // packages/superpowers/skills (resolved from import.meta.url)
export function projectSkillsDir(cwd: string): string;    // <project>/.spider/skills
export function contributeSkillPaths(cwd: string): string[]; // [baseline, project?] (project only if it exists)
```
Both tiers are contributed via `resources_discover` (Task 16). Baseline is read-only in-package; the project tier is the committed AI-authored curator-managed dir.

- [ ] **Step 1: Write the failing test**

```ts
// test/skills-dir.test.ts
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "@spider/db-core";
import { baselineSkillsDir, projectSkillsDir, contributeSkillPaths } from "../src/skills-dir.js";

describe("skills-dir", () => {
  it("baselineSkillsDir points at the packaged skills with using-superpowers", () => {
    const d = baselineSkillsDir();
    expect(fs.existsSync(path.join(d, "using-superpowers", "SKILL.md"))).toBe(true);
  });

  it("contributeSkillPaths returns baseline only when no project skills dir exists", () => {
    const cwd = path.join(paths.scratch("project", process.cwd()), `noskills-${process.pid}`);
    fs.mkdirSync(cwd, { recursive: true });
    expect(contributeSkillPaths(cwd)).toEqual([baselineSkillsDir()]);
  });

  it("contributeSkillPaths appends the project tier when .spider/skills exists", () => {
    const cwd = path.join(paths.scratch("project", process.cwd()), `withskills-${process.pid}`);
    fs.mkdirSync(projectSkillsDir(cwd), { recursive: true });
    expect(contributeSkillPaths(cwd)).toEqual([baselineSkillsDir(), projectSkillsDir(cwd)]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers -- skills-dir`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `skills-dir.ts`**

```ts
// src/skills-dir.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function baselineSkillsDir(): string {
  // src/ → package root → skills/
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

export function projectSkillsDir(cwd: string): string {
  return path.join(cwd, ".spider", "skills");
}

export function contributeSkillPaths(cwd: string): string[] {
  const out = [baselineSkillsDir()];
  const proj = projectSkillsDir(cwd);
  try {
    if (fs.statSync(proj).isDirectory()) out.push(proj);
  } catch { /* no project tier */ }
  return out;
}
```

> The bundle ships `src/` compiled to `dist/`, but `skills/` stays as static Markdown next to the package. Confirm the esbuild ship layout keeps `packages/superpowers/skills` resolvable relative to the compiled `index.js` — if the host bundles `src/` elsewhere, `baselineSkillsDir()` must resolve against the manifest's `skills` entry instead. **Validate against Phase 0 esbuild output before Task 16.**

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/superpowers -- skills-dir`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/src/skills-dir.ts spider/packages/superpowers/test/skills-dir.test.ts
git commit -m "feat(superpowers): resolve baseline + project skill tiers for resources_discover"
```

---

### Task 12: `upstream-watch` skill (SKILL.md)

**Files:**
- Create: `spider/packages/superpowers/skills/upstream-watch/SKILL.md`
- Modify: `spider/packages/superpowers/test/skills-guard.test.ts` (bump the expected set to 15)

**Interfaces:**
- Produces: the 15th skill documenting the review/cherry-pick workflow (per Non-goals: **no live git merges**). It tells the agent to run `spider control upstream-watch`, review surfaced todos, and cherry-pick — never auto-merge.

- [ ] **Step 1: Update the guard test to require 15 skills including upstream-watch**

```ts
// in test/skills-guard.test.ts, extend EXPECTED_14 → EXPECTED_15
const EXPECTED_15 = [...EXPECTED_14, "upstream-watch"];
// add an assertion:
it("contains the upstream-watch skill", () => {
  expect(fs.existsSync(path.join(skillsDir, "upstream-watch", "SKILL.md"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers -- skills-guard`
Expected: FAIL — `upstream-watch/SKILL.md` missing.

- [ ] **Step 3: Write `upstream-watch/SKILL.md`**

```markdown
---
name: upstream-watch
description: Use when checking a vendored subsystem for new upstream commits to review and cherry-pick — never a live merge
---

# Upstream Watch

Spider vendors five subsystems (memory, context, todo, subagents, superpowers)
plus its shared db-core. Upstream repos keep evolving. This skill is the
**review-and-cherry-pick** workflow — spider never does live upstream merges
(that is an explicit non-goal).

## When to Use

- Periodically, or when you suspect an upstream fix/feature matters.
- Before a spider release, to decide what to pull forward.

## The Workflow

1. Run `spider control upstream-watch`. It diffs each vendored subsystem's
   `last_reviewed_commit` (recorded in the global DB `upstream_refs` table)
   against its upstream ref, and:
   - records `last_checked_at` + the current upstream head per package,
   - surfaces each new upstream commit as a **todo** (cherry-pick candidate),
   - renders a report grouped by package.
2. Review each surfaced todo. For candidates worth taking, cherry-pick or
   port the change into the vendored copy under `packages/<subsystem>/`,
   following `test-driven-development` (a port needs a test).
3. After you have reviewed a package's candidates, record the new
   `last_reviewed_commit` (via `spider control upstream-watch --mark <package> <sha>`)
   so the next run starts from there.

## Rules

- **Never** auto-merge or blind-apply upstream. Every candidate is a human/agent
  decision.
- Keep the fork's structure aligned with upstream so diffs stay clean (the
  `superpowers` package deliberately keeps the upstream name).
- A cherry-pick that changes behavior gets a test first (TDD).
- The first upstream-watch job on record is the superpowers v6.0.3 → v6.1.0
  upgrade this phase performed.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/superpowers -- skills-guard`
Expected: PASS (15 skills).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/skills/upstream-watch spider/packages/superpowers/test/skills-guard.test.ts
git commit -m "feat(superpowers): add upstream-watch skill (review/cherry-pick, no live merge)"
```

---

### Task 13: `upstream-watch` diff engine (pure, injectable git)

**Files:**
- Create: `spider/packages/superpowers/src/upstream-watch.ts`
- Create: `spider/packages/superpowers/test/upstream-watch.test.ts`

**Interfaces:**
- Produces:
```ts
export type GitRunner = (repoPath: string, args: string[]) => string;   // returns stdout; injectable
export interface UpstreamCheck { package: string; upstreamRepo: string; upstreamRef?: string; lastReviewedCommit?: string; }
export interface CherryCandidate { package: string; commit: string; subject: string; }
export interface PackageResult { package: string; head: string; candidates: CherryCandidate[]; }
export function diffUpstream(check: UpstreamCheck, repoPath: string, git: GitRunner): PackageResult;
export const DEFAULT_UPSTREAM_REFS: UpstreamCheck[];   // seed rows for the six packages
```
`diffUpstream` resolves the upstream head (`rev-parse <ref>`) and lists commits in `lastReviewedCommit..head` (`log --format=%H%x1f%s`), one candidate per commit. If `lastReviewedCommit` is unset, it reports the head with zero candidates (first run establishes the baseline, does not flood todos).

- [ ] **Step 1: Write the failing test (real temp git repo under scratch)**

```ts
// test/upstream-watch.test.ts
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { paths } from "@spider/db-core";
import { diffUpstream, type GitRunner } from "../src/upstream-watch.js";

const realGit: GitRunner = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

function tempRepo(): { dir: string; commit: (msg: string) => string } {
  const dir = path.join(paths.scratch("project", process.cwd()), `uw-repo-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "t@t"); run("config", "user.name", "t");
  return {
    dir,
    commit(msg: string) {
      fs.writeFileSync(path.join(dir, "f.txt"), msg);
      run("add", "."); run("commit", "-q", "-m", msg);
      return run("rev-parse", "HEAD").trim();
    },
  };
}

describe("diffUpstream", () => {
  it("first run (no last-reviewed) records head with zero candidates", () => {
    const r = tempRepo();
    const head = r.commit("initial");
    const res = diffUpstream({ package: "superpowers", upstreamRepo: "obra/superpowers" }, r.dir, realGit);
    expect(res.head).toBe(head);
    expect(res.candidates).toEqual([]);
  });

  it("surfaces one candidate per new upstream commit since last-reviewed", () => {
    const r = tempRepo();
    const base = r.commit("base");
    const c1 = r.commit("feat: one");
    const c2 = r.commit("fix: two");
    const res = diffUpstream({ package: "superpowers", upstreamRepo: "obra/superpowers", lastReviewedCommit: base }, r.dir, realGit);
    expect(res.head).toBe(c2);
    expect(res.candidates.map((c) => c.subject)).toEqual(["feat: one", "fix: two"]);
    expect(res.candidates.map((c) => c.commit)).toEqual([c1, c2]);
    expect(res.candidates.every((c) => c.package === "superpowers")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers -- upstream-watch.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `upstream-watch.ts` (diff engine + seeds)**

```ts
// src/upstream-watch.ts
export type GitRunner = (repoPath: string, args: string[]) => string;

export interface UpstreamCheck { package: string; upstreamRepo: string; upstreamRef?: string; lastReviewedCommit?: string; }
export interface CherryCandidate { package: string; commit: string; subject: string; }
export interface PackageResult { package: string; head: string; candidates: CherryCandidate[]; }

const UNIT = "\x1f";

export function diffUpstream(check: UpstreamCheck, repoPath: string, git: GitRunner): PackageResult {
  const ref = check.upstreamRef ?? "HEAD";
  const head = git(repoPath, ["rev-parse", ref]).trim();
  if (!check.lastReviewedCommit) return { package: check.package, head, candidates: [] };
  const range = `${check.lastReviewedCommit}..${head}`;
  const out = git(repoPath, ["log", "--reverse", `--format=%H${UNIT}%s`, range]).trim();
  const candidates: CherryCandidate[] = out
    ? out.split("\n").map((line) => {
        const [commit, subject] = line.split(UNIT);
        return { package: check.package, commit, subject: subject ?? "" };
      })
    : [];
  return { package: check.package, head, candidates };
}

// Seed rows for the six vendored subsystems. upstream_ref/repo values are the
// review targets; confirm exact repo URLs at execution (see Risks).
export const DEFAULT_UPSTREAM_REFS: UpstreamCheck[] = [
  { package: "superpowers", upstreamRepo: "https://github.com/obra/superpowers", upstreamRef: "main" },
  { package: "memory",      upstreamRepo: "https://github.com/guru-irl/pi-hermes-memory", upstreamRef: "main" },
  { package: "context",     upstreamRepo: "https://github.com/guru-irl/context-mode", upstreamRef: "main" },
  { package: "todo",        upstreamRepo: "https://github.com/guru-irl/pi-todo-sqlite", upstreamRef: "main" },
  { package: "subagents",   upstreamRepo: "https://github.com/guru-irl/pi-subagents", upstreamRef: "main" },
  { package: "db-core",     upstreamRepo: "https://github.com/guru-irl/spider", upstreamRef: "main" },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/superpowers -- upstream-watch.test`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/src/upstream-watch.ts spider/packages/superpowers/test/upstream-watch.test.ts
git commit -m "feat(superpowers): upstream-watch diff engine (injectable git, baseline-safe first run)"
```

---

### Task 14: `runUpstreamWatch` — persist refs, surface todos, return a report

**Files:**
- Modify: `spider/packages/superpowers/src/upstream-watch.ts`
- Modify: `spider/packages/superpowers/test/upstream-watch.test.ts`

**Interfaces:**
- Consumes: `openGlobal`/`openProject`, `migrate`, `paths` (via test); global `upstream_refs`, project `todos`; `diffUpstream`.
- Produces:
```ts
export interface UpstreamWatchReport { checkedAt: number; packages: PackageResult[]; todosAdded: number; }
export function seedUpstreamRefs(globalDb: Db): void;   // upsert DEFAULT_UPSTREAM_REFS (INSERT OR IGNORE)
export function markReviewed(globalDb: Db, pkg: string, sha: string): void;   // set last_reviewed_commit
export function runUpstreamWatch(
  globalDb: Db, projectDb: Db, sessionId: string,
  deps: { git: GitRunner; localRepos: Record<string, string> }
): UpstreamWatchReport;
```
`runUpstreamWatch`:
1. `seedUpstreamRefs` (idempotent).
2. For each `upstream_refs` row that has a `localRepos[package]` path: `diffUpstream`, then update `upstream_refs.last_checked_at` (+ `notes` = head). **Does not** advance `last_reviewed_commit` (that is a human decision via `markReviewed`).
3. For each candidate, insert a project `todos` row (`session_id`, next `seq`, `text` = `"upstream-watch(<pkg>): <sha7> <subject>"`, `done=0`) — **de-duped** by text so re-runs don't pile duplicates.
4. Return the report.

- [ ] **Step 1: Write the failing test**

```ts
// append to test/upstream-watch.test.ts
import { openGlobal, openProject, migrate, resolveProject } from "@spider/db-core";
import { runUpstreamWatch, seedUpstreamRefs, markReviewed } from "../src/upstream-watch.js";

function scratchProject(): { cwd: string; sessionId: string } {
  const cwd = path.join(paths.scratch("project", process.cwd()), `uw-proj-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(cwd, { recursive: true });
  return { cwd, sessionId: "s-uw" };
}

describe("runUpstreamWatch", () => {
  it("seeds refs, records candidates as todos, updates last_checked_at, and de-dupes on re-run", () => {
    const r = tempRepo();
    const base = r.commit("base");
    r.commit("feat: alpha");
    r.commit("fix: beta");

    const gdb = openGlobal();
    migrate(gdb, "global");
    seedUpstreamRefs(gdb);
    markReviewed(gdb, "superpowers", base);   // pretend we reviewed up to base

    const { cwd, sessionId } = scratchProject();
    const info = resolveProject(cwd);
    const pdb = openProject(info.projectKey);
    migrate(pdb, "project");

    const deps = { git: realGit, localRepos: { superpowers: r.dir } };
    const rep1 = runUpstreamWatch(gdb, pdb, sessionId, deps);
    const sp = rep1.packages.find((p) => p.package === "superpowers")!;
    expect(sp.candidates.map((c) => c.subject)).toEqual(["feat: alpha", "fix: beta"]);
    expect(rep1.todosAdded).toBe(2);

    const todoCount = () => (pdb.prepare("SELECT COUNT(*) AS c FROM todos WHERE text LIKE 'upstream-watch(superpowers):%'").get() as any).c;
    expect(todoCount()).toBe(2);

    const checked = (gdb.prepare("SELECT last_checked_at FROM upstream_refs WHERE package='superpowers'").get() as any).last_checked_at;
    expect(checked).toBeGreaterThan(0);

    // re-run: no new commits, no duplicate todos
    const rep2 = runUpstreamWatch(gdb, pdb, sessionId, deps);
    expect(rep2.todosAdded).toBe(0);
    expect(todoCount()).toBe(2);
  });
});
```

> **VALIDATE FIRST:** `openGlobal()` in tests writes the real `~/.pi/agent/spider/spider.db`. To keep tests hermetic, confirm Phase 0 honors a `SPIDER_HOME`/`paths` override, or add an `openGlobalAt(dbPath)` test seam. If neither exists, guard this test to a scratch global DB via a lower-level open helper — never touch the developer's real global DB. Resolve before Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers -- upstream-watch.test`
Expected: FAIL — `runUpstreamWatch`/`seedUpstreamRefs`/`markReviewed` not exported.

- [ ] **Step 3: Implement the persistence layer**

```ts
// append to src/upstream-watch.ts
import type { Db } from "@spider/db-core";

export interface UpstreamWatchReport { checkedAt: number; packages: PackageResult[]; todosAdded: number; }

export function seedUpstreamRefs(globalDb: Db): void {
  const stmt = globalDb.prepare(
    `INSERT OR IGNORE INTO upstream_refs (package, upstream_repo, upstream_ref, last_checked_at)
     VALUES (@package, @repo, @ref, 0)`
  );
  for (const c of DEFAULT_UPSTREAM_REFS) stmt.run({ package: c.package, repo: c.upstreamRepo, ref: c.upstreamRef ?? "main" });
}

export function markReviewed(globalDb: Db, pkg: string, sha: string): void {
  globalDb.prepare(`UPDATE upstream_refs SET last_reviewed_commit=@sha WHERE package=@pkg`).run({ sha, pkg });
}

function nextSeq(projectDb: Db, sessionId: string): number {
  const row = projectDb.prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM todos WHERE session_id=?`).get(sessionId) as any;
  return (row.m ?? 0) + 1;
}

export function runUpstreamWatch(
  globalDb: Db, projectDb: Db, sessionId: string,
  deps: { git: GitRunner; localRepos: Record<string, string> }
): UpstreamWatchReport {
  seedUpstreamRefs(globalDb);
  const now = Date.now();
  const rows = globalDb.prepare(`SELECT package, upstream_repo, upstream_ref, last_reviewed_commit FROM upstream_refs`).all() as any[];
  const packages: PackageResult[] = [];
  let todosAdded = 0;

  const findTodo = projectDb.prepare(`SELECT 1 FROM todos WHERE session_id=@sid AND text=@text`);
  const insTodo = projectDb.prepare(
    `INSERT INTO todos (session_id, seq, text, done, created_at) VALUES (@sid, @seq, @text, 0, @now)`
  );
  const touch = globalDb.prepare(`UPDATE upstream_refs SET last_checked_at=@now, notes=@head WHERE package=@pkg`);

  for (const row of rows) {
    const repoPath = deps.localRepos[row.package];
    if (!repoPath) continue;
    const res = diffUpstream(
      { package: row.package, upstreamRepo: row.upstream_repo, upstreamRef: row.upstream_ref ?? undefined, lastReviewedCommit: row.last_reviewed_commit ?? undefined },
      repoPath, deps.git,
    );
    packages.push(res);
    touch.run({ now, head: res.head, pkg: row.package });
    for (const c of res.candidates) {
      const text = `upstream-watch(${c.package}): ${c.commit.slice(0, 7)} ${c.subject}`;
      if (findTodo.get({ sid: sessionId, text })) continue;   // de-dupe
      insTodo.run({ sid: sessionId, seq: nextSeq(projectDb, sessionId), text, now });
      todosAdded++;
    }
  }
  return { checkedAt: now, packages, todosAdded };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/superpowers -- upstream-watch.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/src/upstream-watch.ts spider/packages/superpowers/test/upstream-watch.test.ts
git commit -m "feat(superpowers): runUpstreamWatch persists refs, surfaces cherry-pick todos (de-duped)"
```

---

### Task 15: Wire `control upstream-watch` into the host control router

**Files:**
- Modify: `spider/packages/host/src/control.ts`
- Create: `spider/packages/host/src/__tests__/control-upstream-watch.test.ts`

**Interfaces:**
- Consumes: `runUpstreamWatch`, `markReviewed`, `DEFAULT_UPSTREAM_REFS` from `@spider/superpowers`; `openGlobal`/`openProject` + the control `ctx` (global DB, project, sessionId).
- Produces: `spider control upstream-watch` runs the watch and returns a `@spider/ui`-rendered report; `spider control upstream-watch --mark <pkg> <sha>` records a reviewed commit. `localRepos` defaults to the workspace's `packages/*` dirs for dev; a `--repos` map overrides for CI/production checkouts.

- [ ] **Step 1: Write the failing test**

```ts
// packages/host/src/__tests__/control-upstream-watch.test.ts
import { describe, it, expect } from "vitest";
import { handleControl } from "../control.js";
// Build a fake ctx exposing globalDb/db/sessionId + a fake git + localRepos,
// per the Phase 0 control ctx shape (validate at execution).

describe("control upstream-watch", () => {
  it("routes command 'upstream-watch' to the superpowers handler and returns a report", async () => {
    // Arrange a scratch global+project DB and a temp git repo (as in Task 13/14),
    // inject them via ctx. Then:
    const res: any = await handleControl(
      { action: "control", command: "upstream-watch" } as any,
      /* ctx */ makeCtxWithScratchDbsAndFakeGit(),
    );
    expect(res).toBeDefined();
    expect(res.report ?? res).toHaveProperty("packages");
  });
});
```

> Fill `makeCtxWithScratchDbsAndFakeGit()` against the real Phase 0 control `ctx` shape at execution — reuse the `tempRepo`/scratch-DB helpers from `@spider/superpowers/test/upstream-watch.test.ts` (extract them to a shared test util if convenient).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/host -- control-upstream-watch`
Expected: FAIL — `control.ts` has no `upstream-watch` case.

- [ ] **Step 3: Add the router case**

In `packages/host/src/control.ts`, add a `case "upstream-watch"` to the command switch:

```ts
// control.ts (add import at top)
import { runUpstreamWatch, markReviewed, DEFAULT_UPSTREAM_REFS } from "@spider/superpowers";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

// ...inside handleControl(args, ctx), in the switch on args.command:
case "upstream-watch": {
  const git = (repo: string, gitArgs: string[]) => execFileSync("git", gitArgs, { cwd: repo, encoding: "utf8" });
  if (args.mark) {
    // args.mark = { package, sha } | "pkg sha"
    const [pkg, sha] = Array.isArray(args.mark) ? args.mark : String(args.mark).split(/\s+/);
    markReviewed(ctx.globalDb, pkg, sha);
    return { ok: true, marked: { package: pkg, sha } };
  }
  // Default local repos: the vendored source lives in this workspace's packages/*.
  const repoRoot = ctx.cwd;
  const localRepos: Record<string, string> = args.repos ?? Object.fromEntries(
    DEFAULT_UPSTREAM_REFS.map((r) => [r.package, path.join(repoRoot, "packages", r.package)]),
  );
  const report = runUpstreamWatch(ctx.globalDb, ctx.db, ctx.sessionId, { git, localRepos });
  return { report };
}
```

Render the report through a `@spider/ui` component in the control renderer (a `Panel` + `ListView` grouped by package with a `🕸` section rule) — no `console.log`. Keep the raw `report` object as the tool result so tests can assert on it.

> **VALIDATE FIRST:** confirm the Phase 0 control `ctx` exposes `globalDb`, `db` (project), `sessionId`, and `cwd`. If control handlers receive a narrower ctx, thread these through from the host's `spider` tool handler (they are the same values Phase 4's `ActionCtx` carries). If `localRepos` packages are not real git checkouts in production installs, upstream-watch skips them gracefully (Task 14 loops only over `localRepos` keys that exist) — surface this in the report as "not a local checkout".

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/host -- control-upstream-watch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/host/src/control.ts spider/packages/host/src/__tests__/control-upstream-watch.test.ts
git commit -m "feat(host): route control upstream-watch to @spider/superpowers"
```

---

### Task 16: Register `@spider/superpowers` in host — AGENTS.md write + skill contribution

**Files:**
- Modify: `spider/packages/superpowers/src/index.ts`
- Modify: `spider/packages/host/src/extension.ts`
- Modify: `spider/packages/host/src/hooks.ts`
- Create: `spider/packages/superpowers/test/register.test.ts`
- Create: `spider/packages/host/src/__tests__/resources-discover.test.ts`

**Interfaces:**
- Produces:
```ts
// @spider/superpowers
export function registerSuperpowers(
  host: { registerAction?: unknown },
  pi: unknown,
  opts?: { agentsMdPath?: string; skipAgentsMd?: boolean }
): { skillPaths(cwd: string): string[] };
export { contributeSkillPaths } from "./skills-dir.js";
```
`registerSuperpowers` writes the AGENTS.md managed block **once per process** (unless `skipAgentsMd`), returns a `skillPaths(cwd)` provider the host's `resources_discover` calls. `opts.agentsMdPath` (default `defaultAgentsMdPath()`) lets tests target a scratch file.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/superpowers/test/register.test.ts
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "@spider/db-core";
import { registerSuperpowers } from "../src/index.js";
import { baselineSkillsDir } from "../src/skills-dir.js";
import { SPIDER_BLOCK_START } from "../src/agentsmd-content.js";

describe("registerSuperpowers", () => {
  it("writes the AGENTS.md managed block to the given path and returns a skillPaths provider", () => {
    const p = path.join(paths.scratch("project", process.cwd()), `reg-${process.pid}`, "AGENTS.md");
    const api = registerSuperpowers({}, {}, { agentsMdPath: p });
    expect(fs.readFileSync(p, "utf8")).toContain(SPIDER_BLOCK_START);
    expect(api.skillPaths(process.cwd())).toContain(baselineSkillsDir());
  });

  it("does not throw and skips writing when skipAgentsMd is set", () => {
    const api = registerSuperpowers({}, {}, { skipAgentsMd: true });
    expect(typeof api.skillPaths).toBe("function");
  });
});
```

```ts
// packages/host/src/__tests__/resources-discover.test.ts
import { describe, it, expect } from "vitest";
// Boot the host extension against a fake pi that records handler return values,
// fire resources_discover, and assert skillPaths includes the baseline skills dir.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/superpowers -- register`
Expected: FAIL — `registerSuperpowers` is still a stub.

- [ ] **Step 3: Implement `registerSuperpowers` + host wiring**

```ts
// packages/superpowers/src/index.ts
import { writeAgentsMd, defaultAgentsMdPath } from "./agentsmd.js";
import { contributeSkillPaths } from "./skills-dir.js";
export { contributeSkillPaths } from "./skills-dir.js";

let agentsMdWritten = false;   // once per process

export function registerSuperpowers(
  _host: { registerAction?: unknown },
  _pi: unknown,
  opts?: { agentsMdPath?: string; skipAgentsMd?: boolean }
): { skillPaths(cwd: string): string[] } {
  if (!opts?.skipAgentsMd && !agentsMdWritten) {
    try {
      writeAgentsMd(opts?.agentsMdPath ?? defaultAgentsMdPath());
      agentsMdWritten = true;
    } catch { /* non-fatal: AGENTS.md is best-effort */ }
  }
  return { skillPaths: (cwd: string) => contributeSkillPaths(cwd) };
}
```

In `packages/host/src/extension.ts` activation (after `registerHooks`), call:

```ts
import { registerSuperpowers } from "@spider/superpowers";
// ...
const superpowers = registerSuperpowers({ registerAction }, pi);
```

In `packages/host/src/hooks.ts`, replace the placeholder `resources_discover` so it contributes skills. Thread the provider in (either pass `superpowers.skillPaths` into `registerHooks`, or register the real handler in `extension.ts` after `registerSuperpowers`):

```ts
// resources_discover handler (host)
pi.on("resources_discover", async (event: any) => ({
  skillPaths: superpowers.skillPaths(event?.cwd ?? process.cwd()),
}));
```

> **VALIDATE FIRST (from the Interfaces block):** confirm pi uses the FIRST `resources_discover` result or MERGES all. If first-only, ensure Phase 0's placeholder is removed/replaced (not left registered before this one). Confirm the `event` carries `cwd`; if not, use `process.cwd()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd spider && npm test -w @spider/superpowers -- register && npm test -w @spider/host -- resources-discover`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/src/index.ts spider/packages/host/src/extension.ts spider/packages/host/src/hooks.ts spider/packages/superpowers/test/register.test.ts spider/packages/host/src/__tests__/resources-discover.test.ts
git commit -m "feat(host): register @spider/superpowers — write AGENTS.md block + contribute skill tiers via resources_discover"
```

---

### Task 17: Full-package verification + smoke + strangler note

**Files:**
- Modify: `spider/docs/superpowers/plans/README.md` (mark Phase 7 landed — optional, if the repo tracks phase status there)
- Create: `spider/packages/superpowers/README.md` (short: what this package is, upstream relationship, do-not-edit-block note)

**Interfaces:**
- Consumes: everything above.
- Produces: a green package + a documented cutover.

- [ ] **Step 1: Run the whole suite**

Run: `cd spider && npm test -w @spider/superpowers && npm test -w @spider/host`
Expected: all green (skills-guard, autowake-guard, agentsmd-content, agentsmd, skills-dir, upstream-watch, register, control-upstream-watch, resources-discover).

- [ ] **Step 2: Build the ship bundle and confirm skills resolve**

Run: `cd spider && node esbuild.config.mjs && spider control doctor` (or the Phase 0 doctor invocation).
Expected: bundle builds; `packages/superpowers/skills` is present next to the shipped extension; `baselineSkillsDir()` resolves. If the bundle relocates `src/`, fix `baselineSkillsDir()` to resolve against the manifest `skills` entry (see Task 11 note) and re-run.

- [ ] **Step 3: Manual smoke — AGENTS.md**

Run in a throwaway HOME (`HOME=$(pwd)/.spider/scratch/home-smoke`): boot the extension once, confirm `.spider/scratch/home-smoke/.pi/agent/AGENTS.md` contains exactly one `<!-- spider:start -->…<!-- spider:end -->` block; boot again, confirm no duplicate block and any content you add outside the markers survives. **Never** point this at your real `$HOME`.

- [ ] **Step 4: Write the package README + cutover note**

`packages/superpowers/README.md` documents: this is the `superpowers` fork vendored into spider (name kept for clean upstream diffing); the AGENTS.md block is spider-managed (edit only outside the markers); the always-on `context`-injection bootstrap of the standalone fork is **deprecated** for spider users — spider owns skill discovery + the AGENTS.md preamble; `using-superpowers` is discoverable-only; run `spider control upstream-watch` to review upstream.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/superpowers/README.md spider/docs/superpowers/plans/README.md
git commit -m "docs(superpowers): package README + Phase 7 cutover (strangler) note"
```

---

## Files to Modify

- `spider/package.json` — workspace picks up `packages/superpowers` (no manual edit if `workspaces: ["packages/*"]`; run `npm install`). The `pi` manifest `skills` already points at `./packages/superpowers/skills` (Phase 0).
- `spider/packages/host/src/extension.ts` — call `registerSuperpowers({ registerAction }, pi)` at activation.
- `spider/packages/host/src/hooks.ts` — `resources_discover` returns `{ skillPaths }` from the superpowers provider (replaces the Phase 0 placeholder).
- `spider/packages/host/src/control.ts` — add `case "upstream-watch"` (+ `--mark`).
- `spider/docs/superpowers/plans/README.md` — optional Phase 7 status.

## New Files

- `spider/packages/superpowers/package.json`, `tsconfig.json`, `README.md`
- `spider/packages/superpowers/skills/**` — 15 skills (14 vendored + upgraded/retargeted, 1 new `upstream-watch`); `using-superpowers/references/pi-tools.md` only.
- `spider/packages/superpowers/src/index.ts` — registrar.
- `spider/packages/superpowers/src/agentsmd-content.ts` — block body + `buildSpiderBlock`.
- `spider/packages/superpowers/src/agentsmd.ts` — idempotent block manager.
- `spider/packages/superpowers/src/skills-dir.ts` — tier resolver.
- `spider/packages/superpowers/src/upstream-watch.ts` — diff engine + persistence + seeds.
- `spider/packages/superpowers/test/{smoke,skills-guard,autowake-guard,agentsmd-content,agentsmd,skills-dir,upstream-watch,register}.test.ts`
- `spider/packages/host/src/__tests__/{control-upstream-watch,resources-discover}.test.ts`

## Dependencies

- **Task 1** (scaffold) → gates all others.
- **Task 2** (vendor) → gates 3, 4, 5–8, 12 (skill content).
- **Task 3** (v6.1.0 bootstrap) and **Task 4** (pi-tools retarget) build on 2; independent of each other.
- **Tasks 5–8** (auto-wake rewrites) build on 2; independent of each other (share only the `autowake-guard` test file — serialize the test-file edits or merge carefully).
- **Task 9** (block content) → **Task 10** (block manager) → **Task 16** (register/write).
- **Task 11** (skills-dir) → **Task 16** (resources_discover).
- **Task 12** (skill) is independent content; **Task 13** (diff engine) → **Task 14** (persistence) → **Task 15** (control route).
- **Task 16** depends on 10, 11, 13–15 being present (host activation wires them). **Task 17** depends on all.
- **Cross-phase:** Phase 0 (host dispatcher, `control.ts`, `resources_discover` placeholder, esbuild, db-core `upstream_refs`/`todos`, `paths`) and Phase 4 (intercom auto-wake `run`/`message`/pipeline — referenced by the rewritten skills as documentation, not imported).

## Risks

1. **`resources_discover` merge semantics (highest coupling risk).** If pi uses only the first handler's result, Phase 7 MUST replace the Phase 0 placeholder rather than register a second handler — otherwise skills silently don't load. Validate before Task 16 (Interfaces block).
2. **Control `ctx` shape.** Task 15 assumes control handlers get `globalDb`, `db`, `sessionId`, `cwd`. If Phase 0's control ctx is narrower, thread these through. Confirm before Task 15.
3. **Hermetic global DB in tests.** `openGlobal()` targets the real `~/.pi/agent/spider/spider.db`. Task 14/15 tests need a scratch global DB (`SPIDER_HOME`/`paths` override or an `openGlobalAt` seam). Do **not** let tests mutate the developer's real global DB. Resolve in Task 14 Step 1.
4. **`baselineSkillsDir()` after bundling.** esbuild bundles `src/` → `dist/extension.js`; `skills/` ships as static Markdown. If the ship layout changes the relative path from compiled `index.js` to `skills/`, the resolver breaks at runtime. Validate against the real Phase 0 esbuild output (Task 11 note, Task 17 Step 2).
5. **"Replaces the five-tool guide" heuristic.** `isLegacyFiveToolGuide` matches a specific heading + section. If the real global `~/.pi/agent/AGENTS.md` differs from the recon copy, the wholesale replacement won't trigger and the block is prepended instead (user content preserved, but the stale guide lingers). Confirm the exact legacy signature against the live file, or accept prepend + a one-time manual cleanup. Surfaced here rather than guessed — **confirm with the supervisor if the live AGENTS.md must be auto-cleaned vs. prepended.**
6. **Seed upstream repo URLs.** `DEFAULT_UPSTREAM_REFS` URLs (obra/superpowers, guru-irl/pi-hermes-memory, context-mode, pi-todo-sqlite, pi-subagents, spider) are best-guess — confirm exact repos/refs before relying on `control upstream-watch` in production. `db-core` has no external upstream (it's spider-native); it is seeded pointing at spider itself and will usually have zero candidates.
7. **`localRepos` in production installs.** A git-installed spider package is not six separate upstream checkouts. `runUpstreamWatch` skips packages with no local repo (report notes "not a local checkout"); real upstream diffing needs a dev checkout or a fetch/clone step (out of scope here — the skill documents the review workflow; automation of fetching is a later enhancement).
8. **v6.1.0 exact bootstrap wording.** The compressed `using-superpowers` text is summarized from the release notes; if byte-exact upstream parity matters for clean diffing, re-fetch the v6.1.0 `SKILL.md` and reconcile (the guard test only checks pi-only invariants, not upstream byte parity).
9. **Skill-body retarget breadth.** Tasks 4–8 retarget the tool-mapping + four workflow skills. Other skills (`brainstorming`, `executing-plans`, `writing-plans`, etc.) speak in harness-neutral actions and need no rewrite; `executing-plans` still has a per-platform aside referencing non-pi harnesses — fold a cleanup of that line into Task 4 if the guard test is extended to cover it (currently it is not; flag if strict pi-only across ALL skill bodies is required).

## Self-Review notes

- **Spec coverage:** v6.1.0 upgrade (T3) ✓; strip non-pi (T2 guard) ✓; keep 14 + add upstream-watch = 15 (T2/T12 guard) ✓; retarget to spider verbs (T4) ✓; rewrite 4 skills for auto-wake (T5–T8) ✓; no new spider skills, using-superpowers discoverable-only (T3 + no context-injection vendored) ✓; AGENTS.md managed delimited block, idempotent, preserves user content, replaces five-tool guide, ~1.5–2K tokens (T9/T10) ✓; dynamic per-session injection stays out of the static file (unchanged — Phase 1/6 own `before_agent_start`) ✓; upstream-watch skill + command diffing each subsystem, todos, upstream_refs in global DB (T12–T15) ✓; both skill tiers via resources_discover (T11/T16) ✓; TDD against `.spider/scratch/` temp files/repos (T10/T13/T14) ✓.
- **Out of scope (correctly deferred):** skill curator (Phase 6), `before_agent_start` dynamic injection (Phase 1/6), per-action UI renderers beyond the upstream-watch report (Phase 8), automated upstream fetch/clone.
