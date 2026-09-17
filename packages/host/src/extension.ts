// packages/host/src/extension.ts
// THE single spider pi extension entry. Composes the whole surface:
// one `spider` tool + control routing + every contract hook. Later phases
// attach action handlers via registerAction (re-exported below).
import { dispatch, registerAction, type ActionCtx, type SpiderArgs } from "./dispatch";
import { registerSlashCommands } from "./slash";
import { removeLegacyTools } from "./legacy-removal";
import { registerHooks } from "./hooks";
import { HostOrganismRuntime } from "./organism-runtime";
import { cwdOf, parentModelOf, sessionIdOf } from "./session-context";
export { cwdOf, sessionIdOf } from "./session-context";
import { registerContextActions, runImport } from "@spider/context";
import { toToolResult, markToolCallError } from "./result";
import { controlDoctor, controlConfig, controlMigrate } from "./control";
import { collectStats } from "./control/stats-cmd";
import { setModelDefault, listCatalog } from "./control/models-cmd";
import { applyConfigEdit } from "./control/config-cmd";
import { registerRouting, DEFAULT_ROUTING_CONFIG, type RoutingConfig } from "./routing/index";
import { ContentStore } from "@spider/context";
import { enqueueEmbed } from "@spider/memory";
import * as models from "@spider/models";
import { resolveProject, openGlobal, openProject, openRepo, openDbAt, paths, type Db } from "@spider/db-core";
import {
  stageWrite, recall, listPending, approvePending, rejectPending, forgetMemory,
  activeCharTotal, listActive, resolveEmbedder, type Embedder,
  renderRememberResult, renderRecallResult, renderPending, MEMORY_CONSOLIDATE_RENAMED_MESSAGE,
} from "@spider/memory";
import { makeTodo, makeTodosCommand } from "@spider/todo";
import { registerSubagentActions } from "@spider/subagents";
import {
  registerOrganism,
  readOrganismConfig,
  readLastDrainReport,
  readLastDrainReportForWorktree,
  SkillStore,
  skillAction,
  curateAction,
  insightsAction,
  safeError,
  type OrganismActionDeps,
  type SkillActionArgs,
  type DrainReport,
} from "@spider/organism";
import { runUpstreamWatch, markReviewed, DEFAULT_UPSTREAM_REFS, registerSuperpowers } from "@spider/superpowers";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { mountAgentsUI } from "./agents/mount";
import { renderSpiderResult, renderSpiderCall, renderSubagentDone, renderCommandOutput, renderEscalationMessage, renderOrganismEntry } from "./render-result";

export { registerAction };

// Lazily-cached embedder shared across recall calls (avoids re-resolving the
// model per dispatch). resolveEmbedder degrades to null → recall falls back to FTS.
let _emb: Promise<Embedder | null> | undefined;
const getEmbedder = () => (_emb ??= resolveEmbedder());

// Each loaded extension owns its runtime; manual actions reuse its serialized workers.
const organismRuntimes = new WeakMap<object, HostOrganismRuntime>();

// A-M3 (branch-review A-architecture.md): per-pi-instance record of a `registerRouting`
// setup failure, read by doctor so it is surfaced instead of fully swallowed. Mirrors
// `organismRuntimes`'s own WeakMap-per-pi-instance pattern, used for the identical class
// of problem (registerOrganism's own setup-failure reporting).
const routingSetupErrors = new WeakMap<object, string>();

/** DEFAULT_ROUTING_CONFIG merged with any overrides stored under routing.* keys.
 *  Best-effort: never throws; on any doubt returns a fresh default clone. */
function readRoutingConfig(cwd: string): RoutingConfig {
  const cfg: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG };
  try {
    const tracking = controlConfig("get", cwd, "routing.tracking");
    if (typeof tracking === "boolean") cfg.tracking = tracking;
    const secretScrub = controlConfig("get", cwd, "routing.secret_scrub");
    if (typeof secretScrub === "boolean") cfg.secretScrub = secretScrub;
    const injectionScan = controlConfig("get", cwd, "routing.injection_scan");
    if (typeof injectionScan === "boolean") cfg.injectionScan = injectionScan;
    const threshold = controlConfig("get", cwd, "routing.auto_index_threshold");
    if (typeof threshold === "number" && Number.isFinite(threshold)) cfg.autoIndexThreshold = threshold;
  } catch {
    return { ...DEFAULT_ROUTING_CONFIG };
  }
  return cfg;
}

/** Large-output indexer handed to routing: store chunks in the content KB and
 *  enqueue their embeddings. Best-effort; swallows all errors. */
function makeIndexer(db: Db) {
  return (text: string, source: string) => {
    try {
      const store = new ContentStore(db);
      const r = store.indexContent({ content: text, source });
      const sel = db.prepare("SELECT chunk FROM content WHERE id = ?");
      for (const id of r.ids) {
        const row = sel.get(id) as { chunk?: string } | undefined;
        if (row?.chunk) enqueueEmbed(db, "content", String(id), row.chunk);
      }
    } catch {}
  };
}

// scope + per-call DB selection (ctx-native: reuse the DBs buildActionCtx resolved).
// "project" is a deprecated alias for "worktree"
// Default is "repo" for memory operations (memory tables live in repo tier post-71a2acf)
const scopeOf = (a: any): "global" | "repo" | "worktree" => {
  if (a?.scope === "global") return "global";
  if (a?.scope === "repo") return "repo";
  if (a?.scope === "worktree") return "worktree";
  if (a?.scope === "project") return "worktree"; // deprecated alias
  return "repo"; // default: memory tables are in repo tier
};
const dbFor = (scope: "global" | "repo" | "worktree", ctx: ActionCtx | undefined) => {
  if (scope === "global") return ctx!.globalDb;
  if (scope === "repo") return ctx!.repoDb;
  return ctx!.db; // worktree
};

interface PiToolAPI {
  registerTool(tool: {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;
    renderCall?: (args: unknown, theme: unknown, context: unknown) => unknown;
    renderShell?: "default" | "self";
    execute(toolCallId: string, params: SpiderArgs, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown>;
  }): void;
  registerCommand?(name: string, def: unknown): void;
  registerMessageRenderer?(customType: string, renderer: (message: unknown, options: unknown, theme: unknown) => unknown): void;
  registerEntryRenderer?(customType: string, renderer: (entry: unknown, options: unknown, theme: unknown) => unknown): void;
  appendEntry?(customType: string, data?: unknown): void;
  on(name: string, fn: (...args: unknown[]) => unknown): void;
}

export const SPIDER_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "search", "remember", "recall", "exec", "exec_file", "batch",
        "index", "fetch", "run", "kill", "todo", "skill", "import", "message", "control",
      ],
      description: "The spider verb to run.",
    },
    // control
    command: { type: "string", description: "Sub-command when action='control' (e.g. 'doctor','config','memory','bind','unbind')." },
    op: { type: "string", enum: ["get", "set", "add", "list", "toggle", "clear", "sessions", "view", "distill", "approve", "reject"], description: "Sub-op. control config: get/set. todo: add/list/toggle/clear/sessions/view. skill: list/view/distill/add/approve/reject; op=add STAGES a candidate for review (name+text; never activates); approval/rejection are explicit; an unrecognized op is a host-visible error, never a silent listing." },
    key: { type: "string", description: "control config key." },
    value: { description: "control config value (for op='set')." },
    sub: { type: "string", description: "control memory sub-command (pending|approve|reject|status|forget; consolidate is deprecated -> status + forget)." },
    uuid: { type: "string", description: "memory uuid for approve/reject/forget." },
    // scope / cwd (most actions)
    scope: { type: "string", enum: ["global", "repo", "worktree", "project"], description: "Memory/registry scope (default repo). \"Is this still true after I delete this worktree?\" → **repo**; \"Is this true in every repo?\" → **global**; otherwise → **worktree**. (\"project\" is deprecated, use \"worktree\")" },
    cwd: { type: "string", description: "Working-directory override." },
    // search / recall
    query: { type: "string", description: "Query text for action 'search' or 'recall'." },
    category: { type: "string", description: "Memory category (remember) or filter (recall); optional skill category for action='skill' op=add." },
    limit: { type: "number", description: "Max results (search/recall)." },
    // remember
    content: { type: "string", description: "Text to store for action 'remember' (or index/fetch body)." },
    link: { type: "string", description: "Optional link/url to attach to a remembered item." },
    auto: { type: "boolean", description: "Mark a remembered item as auto-captured." },
    // run / subagents
    agent: { type: "string", description: "SINGLE-mode agent/role for action 'run' (e.g. 'scout','worker','reviewer')." },
    name: { type: "string", description: "SINGLE-mode display name for the spawned subagent (surfaced in the UI; defaults to a slug of the task); also the skill name for action='skill' (op add/view/approve/reject)." },
    task: { type: "string", description: "SINGLE-mode task text for action 'run'." },
    tasks: {
      type: "array",
      description: "PARALLEL-mode: subagents to run concurrently. Give each a short descriptive `name`.",
      items: {
        type: "object",
        properties: {
          agent: { type: "string" },
          name: { type: "string", description: "Short display name surfaced in the UI." },
          task: { type: "string" },
          count: { type: "integer", minimum: 1 },
          model: { type: "string" },
          context: { type: "string", enum: ["fresh", "fork"] },
        },
        required: ["agent", "task"],
      },
    },
    chain: {
      type: "array",
      description: "CHAIN-mode: sequential steps ({previous} passed forward).",
      items: {
        type: "object",
        properties: {
          agent: { type: "string" },
          name: { type: "string", description: "Short display name surfaced in the UI." },
          task: { type: "string" },
          model: { type: "string" },
          context: { type: "string", enum: ["fresh", "fork"] },
        },
      },
    },
    pipeline: { type: "array", description: "PIPELINE-mode stages (advanced push-based auto-wake).", items: { type: "object" } },
    concurrency: { type: "integer", minimum: 1, description: "PARALLEL max concurrent (default 4)." },
    model: { type: "string", description: "Model override for spawned subagent(s)." },
    skill: { type: "string", description: "Skill the spawned subagent should follow." },
    context: { type: "string", enum: ["fresh", "fork"], description: "Child context: fresh, or fork from this session." },
    id: { type: "string", description: "Run id/prefix (also a todo id). For action 'kill': a run id, id prefix, run name, or \"all\" to kill every active subagent in this session." },
    timeoutMs: { type: "integer", minimum: 1, description: "Give up after N ms (message)." },
    // message
    to: { type: "string", description: "Target session name/id for action 'message'." },
    message: { type: "string", description: "Message body for action 'message'." },
    // todo
    text: { type: "string", description: "Todo body for action 'todo' op=add; skill candidate BODY (markdown) for action='skill' op=add; free-form request for action='skill' op=distill." },
    session: { type: "string", description: "For action 'todo' op 'view': which session's todos (session id/prefix/name or 'all')." },
    // exec
    code: { type: "string", description: "Code to run for action 'exec'/'exec_file'." },
    language: { type: "string", description: "Language for action 'exec' (javascript, shell, python, ruby, go, rust, php, perl, r, elixir, csharp, typescript)." },
    timeout: { type: "number", description: "Max execution time in ms for action 'exec'/'exec_file'." },
    background: { type: "boolean", description: "Capture stdout/stderr to durable files from launch (not a pipe). If `timeout` elapses while still running, the process is detached (exitCode:null, never fabricated 0) and its logs/receipt path are returned; output keeps growing on disk after that. With no `timeout`, this still waits and streams to the real exit code — it does not detach immediately." },
    commands: {
      type: "array",
      description: "Batch commands for action 'batch': each runs sequentially. Give each {language, code} (+ optional timeout).",
      items: {
        type: "object",
        properties: {
          language: { type: "string" },
          code: { type: "string" },
          timeout: { type: "number" },
        },
        required: ["language", "code"],
      },
    },
    // index / fetch
    url: { type: "string", description: "URL for action 'fetch'." },
    source: { type: "string", description: "Source label for action 'index'/'fetch'." },
    path: { type: "string", description: "File/dir path for action 'index'/'exec_file'." },
  },
  required: ["action"],
  additionalProperties: true,
} as const;

/** Manual and automatic entry points share the same session/project worker. */
function buildOrganismDeps(ctx: ActionCtx & { parentModel?: string }): OrganismActionDeps {
  const api = ctx.pi as object;
  let runtime = organismRuntimes.get(api);
  if (!runtime) {
    runtime = new HostOrganismRuntime(getEmbedder);
    organismRuntimes.set(api, runtime);
  }
  return runtime.resolve(ctx);
}

/** control routing lives in-host (doctor/config work in Phase 0; memory in Phase 1). */
/** Render a control upstream-watch report as a compact 🕸 panel string. */
function renderUpstreamReport(report: {
  packages: Array<{ package: string; head: string; candidates: Array<{ commit: string; subject: string }>; error?: string }>;
  todosAdded: number;
}): string {
  const lines = [`🕸 upstream-watch — ${report.packages.length} package(s) checked, ${report.todosAdded} new cherry-pick todo(s)`];
  for (const p of report.packages) {
    if (p.error) { lines.push(`  ${p.package}: skipped (${p.error.split("\n")[0]})`); continue; }
    if (p.candidates.length === 0) { lines.push(`  ${p.package} @ ${p.head.slice(0, 7)}: up to date`); continue; }
    lines.push(`  ${p.package} @ ${p.head.slice(0, 7)}: ${p.candidates.length} candidate(s)`);
    for (const c of p.candidates) lines.push(`    • ${c.commit.slice(0, 7)} ${c.subject}`);
  }
  return lines.join("\n");
}

async function handleControl(args: SpiderArgs, ctx?: ActionCtx): Promise<unknown> {
  const command = String(args.command ?? "");
  const cwd = String(args.cwd ?? ctx?.cwd ?? process.cwd());
  switch (command) {
    case "doctor": {
      const report = controlDoctor(cwd, ctx?.sessionId);
      if (ctx) {
        // A-M3: `registerRouting`'s failure used to be fully swallowed ("routing
        // registration must not break extension load") with NOTHING anywhere
        // reporting it — markToolCallError kept adding to result.ts's erroredCalls Set
        // with no consumer ever draining it, and doctor said nothing. Independent of
        // (and checked before) the organism diagnostics below, so a failure in one
        // never hides the other.
        const routingError = routingSetupErrors.get(ctx.pi as object);
        if (routingError) {
          report.ok = false;
          report.lines.push(`- routing: NOT WIRED (registration failed: ${routingError})`);
        }
        try {
          const enabled = readOrganismConfig(controlConfig("get", ctx.project.realPath)).enabled;
          // Read EXISTING runtime state directly — never create a replacement
          // runtime just to inspect a registration/setup failure.
          const runtime = organismRuntimes.get(ctx.pi as object);
          if (runtime && !runtime.isWired()) {
            report.ok = false;
            report.lines.push("- organism: NOT WIRED (registration failed)");
          }
          const memLast = (() => {
            try {
              return buildOrganismDeps(ctx).worker.getLastDrain();
            } catch (e) {
              // Runtime resolution (e.g. no active session id) must not swallow the
              // remaining independent fallbacks below (P12/F2) — only THIS call is isolated.
              // A-M4: was `String((e as Error)?.message ?? e)` — a raw stringifier, while
              // `safeError` (imported precisely because it redacts credentials and caps
              // length) sat unused on the very next lines. A resolver/config-read failure
              // is a plausible carrier of a token.
              report.ok = false;
              report.lines.push(`- organism runtime unavailable: ${safeError(e)}`);
              return undefined as DrainReport | undefined;
            }
          })();
          const sessionLast = memLast ?? readLastDrainReport(ctx.db, ctx.sessionId);
          const inMemorySetupFailure = sessionLast ? undefined : runtime?.getSetupFailure(ctx.sessionId);
          const current = sessionLast ?? inMemorySetupFailure;
          const worktreeLast = current ? undefined : readLastDrainReportForWorktree(ctx.db);
          const last = current ?? worktreeLast;
          const stale = current === undefined && worktreeLast !== undefined;
          const state = enabled
            ? (last
                ? stale
                  ? `last drain in this worktree (session ${last.sessionId}, ${new Date(last.finishedAt).toISOString()}): ${last.status}${last.skipReason ? ` (${last.skipReason})` : ""}`
                  : `${last.status}${last.skipReason ? ` (${last.skipReason})` : ""}`
                : "waiting for compaction or shutdown; no verified drain recorded")
            : "disabled";
          const pendingMemory = listPending(ctx.repoDb, "repo").length;
          const pendingSkills = new SkillStore(ctx.repoDb).list({ status: "staged" }).length;
          report.lines.push(`- organism: ${state}`);
          report.lines.push(`- organism proposals awaiting review: ${pendingMemory} memories, ${pendingSkills} skills`);
          if (enabled && last && (last.status === "failed" || last.status === "partial" || last.skipReason === "no-model")) report.ok = false;
          for (const error of last?.errors ?? []) report.lines.push(`- organism ${error.phase}: ${error.message}`);
          if (pendingMemory + pendingSkills > 0) report.lines.push("- review proposals: spider control memory sub=pending; spider skill op=list");
        } catch (e) {
          // A-M4: same fix as the inner catch above — was a raw stringifier.
          report.ok = false;
          report.lines.push(`- organism diagnostics unavailable: ${safeError(e)}`);
        }
      }
      return report;
    }
    case "config": {
      const op = (args.op as "get" | "set") ?? "get";
      if (op === "set" && args.key) {
        // Protected key: exec.enforce can only be changed by the user via slash command
        if (String(args.key) === "exec.enforce") {
          return { error: "exec.enforce is protected and can only be changed by the user via the /exec-enforce slash command" };
        }
        const r = applyConfigEdit(cwd, String(args.key), String(args.value));
        return { details: { ok: r.ok, error: r.error, key: args.key, value: args.value } };
      }
      if (args.key) return { details: { key: args.key, value: controlConfig("get", cwd, String(args.key)) } };
      return { details: { config: controlConfig("get", cwd) } };
    }
    case "memory": {
      const scope = scopeOf(args);
      const db = dbFor(scope, ctx);
      switch (args.sub) {
        case "pending": {
          const recs = listPending(db, scope);
          return { display: renderPending(recs), details: recs };
        }
        case "approve":
          return { details: approvePending(db, scope, args.uuid as string) };
        case "reject":
          rejectPending(db, scope, args.uuid as string);
          return { details: { ok: true, uuid: args.uuid } };
        case "status":
          // Read-only report: active entries (with uuids) + char usage for this scope.
          // Pair with `forget <uuid>` to actually free space once the cap is hit.
          return { details: { entries: listActive(db, scope), usage: activeCharTotal(db, scope) } };
        case "consolidate":
          // `consolidate` used to return exactly the same payload as `status` above --
          // a read-only report wearing an action's name. Nothing was ever merged, pruned,
          // or rewritten. Renamed so the name matches the behavior; the old name now
          // fails loudly (this error) instead of silently misleading a caller who expects
          // it to free space.
          return { error: MEMORY_CONSOLIDATE_RENAMED_MESSAGE };
        case "forget": {
          const uuid = args.uuid as string | undefined;
          if (!uuid) return { error: "control memory forget requires a uuid (see control memory status for active uuids)" };
          const removed = forgetMemory(db, scope, uuid);
          if (!removed) return { error: `control memory forget: no entry '${uuid}' in scope '${scope}'` };
          return { details: { ok: true, uuid, scope, removed } };
        }
        default:
          return { error: `control memory sub '${String(args.sub)}' unknown` };
      }
    }
    case "migrate": {
      const apply = Boolean(args.apply);
      const result = controlMigrate({ apply, dryRun: !apply, cwd });
      return { details: result };
    }
    case "skill": {
      if (!ctx) return { error: "control skill requires an action context" };
      if (args.sub === "curate") {
        return await curateAction(buildOrganismDeps(ctx), {
          force: args.force as boolean | undefined,
          consolidate: args.consolidate as boolean | undefined,
        });
      }
      return { error: `control skill sub '${String(args.sub)}' unknown (valid: curate)` };
    }
    case "insights": {
      if (!ctx) return { error: "control insights requires an action context" };
      return insightsAction(buildOrganismDeps(ctx));
    }
    case "stats": {
      if (!ctx) return { error: "control stats requires an action context" };
      return { details: collectStats({ worktreeDb: ctx.db, repoDb: ctx.repoDb }, ctx.globalDb) };
    }
    case "models": {
      if (!ctx) return { error: "control models requires an action context" };
      if (args.op === "set") {
        const r = setModelDefault(cwd, String(args.key ?? ""), String(args.value ?? ""), listCatalog(ctx.modelRegistry));
        return { details: { ok: r.ok, error: r.error, role: args.key, ref: args.value } };
      }
      return { details: { catalog: listCatalog(ctx.modelRegistry), defaults: (controlConfig("get", cwd, "models.defaults") as Record<string, string>) ?? {} } };
    }
    case "upstream-watch": {
      if (!ctx) return { error: "control upstream-watch requires an action context" };
      const mark = (args as { mark?: unknown }).mark;
      if (mark != null && mark !== false) {
        const parts = Array.isArray(mark) ? mark.map(String) : String(mark).split(/\s+/).filter(Boolean);
        const [pkg, sha] = parts;
        if (!pkg || !sha) return { error: "control upstream-watch --mark needs <package> <sha>" };
        markReviewed(ctx.globalDb, pkg, sha);
        return { display: `🕸 upstream-watch: marked ${pkg} reviewed @ ${sha}`, details: { ok: true, marked: { package: pkg, sha } } };
      }
      const git = (repo: string, gitArgs: string[]): string =>
        execFileSync("git", gitArgs, { cwd: repo, encoding: "utf8" });
      const injected = (args as { repos?: Record<string, string> }).repos;
      const localRepos = injected ?? Object.fromEntries(
        DEFAULT_UPSTREAM_REFS
          .map((r) => [r.package, path.join(ctx.cwd, "packages", r.package)] as const)
          .filter(([, p]) => existsSync(p)),
      );
      const report = runUpstreamWatch(ctx.globalDb, ctx.db, ctx.sessionId, { git, localRepos });
      return { display: renderUpstreamReport(report), details: report };
    }
    case "bind": {
      if (!ctx) return { error: "control bind requires an action context" };
      const bindPath = args.path ? String(args.path) : cwd;
      const { controlBind } = await import("./control-bind");
      const result = controlBind(ctx.globalDb, ctx.sessionId, bindPath);
      return { details: result };
    }
    case "unbind": {
      if (!ctx) return { error: "control unbind requires an action context" };
      const { controlUnbind } = await import("./control-bind");
      const result = controlUnbind(ctx.globalDb, ctx.sessionId);
      return { details: result };
    }
    default:
      return { error: `control command '${command}' is not yet implemented (Phase 0)` };
  }
}

// enumerate = pi's model surface ∩ availability, read from ExtensionContext.modelRegistry.
// The comment here used to say "VALIDATE-FIRST A6: confirm listModels/availableModels" -- that
// confirmation was never done, and neither method exists on pi, so this always returned [].
export function enumerate(registry: unknown): Array<{ provider: string; id: string; available: boolean; reasoning: boolean; vision: boolean; ctx: number }> {
  const r = registry as { getAll?: () => unknown[]; getAvailable?: () => unknown[] } | undefined;
  if (typeof r?.getAll !== "function") return [];
  const availableKeys = new Set<string>();
  const hasAvailability = typeof r.getAvailable === "function";
  if (hasAvailability) {
    for (const m of (r.getAvailable!() ?? []) as any[]) availableKeys.add(`${m?.provider ?? ""}/${m?.id ?? ""}`);
  }
  return ((r.getAll() ?? []) as any[]).map((m: any) => ({
    provider: String(m?.provider ?? ""), id: String(m?.id ?? ""),
    available: hasAvailability ? availableKeys.has(`${m?.provider ?? ""}/${m?.id ?? ""}`) : true,
    reasoning: !!m?.reasoning,
    vision: Array.isArray(m?.input) ? m.input.map(String).includes("image") : false,
    ctx: Number(m?.contextWindow ?? 0),
  }));
}

/** realpathSync, degrading to the raw path when it doesn't exist (never throws). */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** True when `target` is `root` itself or nested anywhere underneath it. Path-aware
 *  (via path.relative), NOT a naive string-prefix test — "/repo-2" must never look
 *  "contained" inside "/repo" just because the strings share a prefix. */
function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Build ONE ActionCtx per dispatch (A2): both DBs, the resolved project, and the
 *  @spider/models router. A handler routes via
 *  `ctx.models.pick(ctx.models.catalog(() => enumerate(ctx.pi as PiToolAPI)), profile)`. */
export function buildActionCtx(
  pi: PiToolAPI,
  args: SpiderArgs,
  sessionId: string,
  ctxCwd?: string,
  onPartial?: (text: string) => void,
  modelRegistry?: unknown,
  signal?: AbortSignal,
  parentModel?: string,
): ActionCtx & { parentModel?: string } {
  const rawCwd = String((args as { cwd?: unknown }).cwd ?? ctxCwd ?? process.cwd());
  // If args.cwd is provided, it's an explicit user-specified path; otherwise honor bindings
  const explicitCwd = !!(args as { cwd?: unknown }).cwd;
  const project = resolveProject(rawCwd, { sessionId, explicitCwd });
  // resolveProject may have selected a different worktree than rawCwd (a session binding
  // pointing at another tree entirely). An explicit args.cwd is always honored verbatim.
  // Otherwise: if rawCwd is still inside the selected WORKTREE (including nested
  // subdirectories — a binding to an ancestor, no binding at all, or a binding to a
  // *sibling* subdirectory of the same tree), keep rawCwd so callers running from a
  // subdirectory stay there. Only when rawCwd falls OUTSIDE the selected worktree (the
  // binding moved execution to a genuinely different tree) do we adopt project.realPath
  // (the bound destination, which may itself be a subdirectory), so DB writes and the
  // returned cwd agree on which worktree is live. Containment is judged against
  // project.projectKey (the worktree ROOT), not project.realPath — realPath can be a
  // bound subdirectory, and anchoring containment on it would wrongly treat a sibling
  // subdirectory of the SAME tree as "outside" and discard the caller's actual target.
  // Containment itself is path-aware (path.relative), never a naive string-prefix test
  // (e.g. "/repo-2" must not look "contained" in "/repo"). One consequence worth
  // naming explicitly: a binding to a SUBDIRECTORY of the SAME tree never forces a
  // chdir into that subdirectory — if rawCwd is anywhere inside project.projectKey,
  // including the tree's own root, rawCwd wins verbatim and the bound subdirectory is
  // only adopted when execution is actually moving to a DIFFERENT tree.
  const cwd = explicitCwd || isPathInside(project.projectKey, safeRealpath(rawCwd))
    ? rawCwd
    : project.realPath;
  const worktreeDb = openProject(project.projectKey);
  // For git repos: open the repo DB
  // For non-git dirs: create a repo-schema DB at worktree root (memory tables live in repo tier)
  // IMPORTANT 6: Use paths.projectRoot to get <root>/.spider (dotted dir)
  const repoDb = project.repoKey
    ? openRepo(project.repoKey)
    : openDbAt(path.join(paths.projectRoot(project.projectKey), "repo.db"), "repo");
  // Resolved once per dispatch so packages/subagents/src/actions/run.ts (which cannot
  // import @spider/host to read config itself) can apply the models.defaults[<role>]
  // precedence without ever touching the config file directly.
  const modelDefaults = (controlConfig("get", cwd, "models.defaults") as Record<string, string> | undefined) ?? {};
  return { db: worktreeDb, repoDb, globalDb: openGlobal(), project, sessionId, cwd, pi, models, onPartial, modelRegistry, modelDefaults, signal, parentModel };
}

export default function spiderExtension(pi: PiToolAPI): void {
  const organism = new HostOrganismRuntime(getEmbedder, report => {
    const meaningful = report.status === "failed" || report.status === "partial" ||
      report.memoryStaged + report.skillsStaged + report.todosAdded > 0;
    if (meaningful) pi.appendEntry?.("spider.organism", report);
  });
  organismRuntimes.set(pi, organism);
  let currentContext: unknown;
  let currentSessionId = "";
  const routingDbs = new Map<string, Db>();
  const routingProject = () => resolveProject(cwdOf(currentContext) ?? process.cwd(), {
    sessionId: sessionIdOf(currentContext) || undefined, explicitCwd: false,
  });
  const routingDb = () => {
    const project = routingProject();
    let db = routingDbs.get(project.projectKey);
    if (!db) { db = openProject(project.projectKey); routingDbs.set(project.projectKey, db); }
    return db;
  };
  // control is owned by the host from Phase 0; ctx is threaded for memory routing.
  registerAction("control", (args, ctx) => handleControl(args as SpiderArgs, ctx));

  // in-process exec/exec_file/batch handlers (Phase 2 Task 4).
  // Strangler: spider owns exec/exec_file/batch/index/fetch/search/import in-process; legacy context-mode ctx_* MCP tools are deprecated (spider does not register them).
  registerContextActions(registerAction);
  // subagents runtime: run/message (child-guard + shutdown teardown handled inside).
  registerSubagentActions({ registerAction }, pi);

  // memory verbs (ctx-native): use the per-call ActionCtx DBs buildActionCtx resolved.
  registerAction("remember", async (args, ctx) => {
    const scope = scopeOf(args);
    const r = stageWrite(dbFor(scope, ctx), scope, {
      category: args.category as any,
      content: args.content as string,
      link: (args.link as string | null) ?? null,
      source: args.auto ? "auto" : "user",
    });
    // Carry the saved content/category/scope on BOTH the rendered panel and the serialized
    // details payload, so a programmatic caller gets back what was actually remembered.
    const details = { ...r, content: args.content as string, category: args.category as any, scope };
    return { display: renderRememberResult(details), details };
  });

  registerAction("recall", async (args, ctx) => {
    const scope = scopeOf(args);
    const embedder = await getEmbedder();
    const recs = await recall(dbFor(scope, ctx), scope, args.query as string, embedder, {
      category: args.category as any,
      limit: args.limit as number | undefined,
    });
    return { display: renderRecallResult(recs), details: recs };
  });

  // todos (ctx-native): dispatch always supplies ctx.db + ctx.sessionId, so the
  // action needs no closure deps; the /todos command resolves db+session per call.
  registerAction("todo", makeTodo());

  // organism manual surface: `skill` (distill → /learn handoff, view, list).
  // Removes the Phase-0 stub for `skill` (dispatch now finds a handler).
  registerAction("skill", (args, ctx) => skillAction(buildOrganismDeps(ctx), args as SkillActionArgs));
  pi.registerCommand?.(
    "todos",
    makeTodosCommand({
      getDb: (ctx) => {
        const sessionId = sessionIdOf(ctx);
        const cwd = cwdOf(ctx) ?? process.cwd();
        return openProject(resolveProject(cwd, { sessionId, explicitCwd: false }).projectKey);
      },
      getSessionId: (ctx) => sessionIdOf(ctx),
    })
  );

  registerSlashCommands(pi as any, {
    run: (a, ctx) =>
      dispatch(a as SpiderArgs, buildActionCtx(pi, a as SpiderArgs, sessionIdOf(ctx), cwdOf(ctx), undefined, (ctx as { modelRegistry?: unknown })?.modelRegistry, undefined, parentModelOf(ctx))) as Promise<{
        content: string;
        details?: unknown;
      }>,
    alreadyRegistered: new Set(["todos", "agents"]),
  });

  // User-only /exec-enforce command (bypasses model-facing guard)
  pi.registerCommand?.("exec-enforce", {
    description: "Control bash enforcement (user only)",
    handler: async (args: string, ctx: unknown) => {
      const cwd = cwdOf(ctx) ?? process.cwd();
      const arg = typeof args === "string" ? args.trim().toLowerCase() : "";
      
      // No argument: report current state
      if (!arg) {
        const current = controlConfig("get", cwd, "exec.enforce");
        const state = current === false ? "OFF" : "ON";
        const text = `exec.enforce is ${state} (default: ON)`;
        
        if (typeof (pi as any).sendMessage === "function") {
          (pi as any).sendMessage({
            customType: "spider.command",
            content: text,
            display: true,
            details: { args: { command: "exec-enforce" }, result: { text, current } },
          });
        } else {
          const notify = (ctx as { ui?: { notify?: (t: string, k?: string) => void } })?.ui?.notify;
          if (typeof notify === "function") notify(text, "info");
        }
        return;
      }
      
      // Parse on/off/true/false/1/0
      let value: boolean;
      if (["on", "true", "1"].includes(arg)) {
        value = true;
      } else if (["off", "false", "0"].includes(arg)) {
        value = false;
      } else {
        const text = `Invalid argument: "${arg}". Use: on|off|true|false`;
        if (typeof (pi as any).sendMessage === "function") {
          (pi as any).sendMessage({
            customType: "spider.command",
            content: text,
            display: true,
            details: { args: { command: "exec-enforce", arg }, result: { error: text } },
          });
        } else {
          const notify = (ctx as { ui?: { notify?: (t: string, k?: string) => void } })?.ui?.notify;
          if (typeof notify === "function") notify(text, "error");
        }
        return;
      }
      
      // Set via controlConfig directly (bypasses the model-facing guard)
      controlConfig("set", cwd, "exec.enforce", value);
      const text = `exec.enforce set to ${value ? "ON" : "OFF"}`;
      
      if (typeof (pi as any).sendMessage === "function") {
        (pi as any).sendMessage({
          customType: "spider.command",
          content: text,
          display: true,
          details: { args: { command: "exec-enforce", arg, value }, result: { text, value } },
        });
      } else {
        const notify = (ctx as { ui?: { notify?: (t: string, k?: string) => void } })?.ui?.notify;
        if (typeof notify === "function") notify(text, "info");
      }
    },
  });

  // User-only /bind command
  pi.registerCommand?.("bind", {
    description: "Bind session to a worktree path",
    handler: async (args: string, ctx: unknown) => {
      const cwd = cwdOf(ctx) ?? process.cwd();
      const sessionId = sessionIdOf(ctx);
      const path = typeof args === "string" ? args.trim() : cwd;
      
      const { controlBind } = await import("./control-bind");
      const result = controlBind(openGlobal(), sessionId, path || cwd);
      
      const text = result.message ?? (result.ok ? "Session bound" : "Failed to bind");
      
      if (typeof (pi as any).sendMessage === "function") {
        (pi as any).sendMessage({
          customType: "spider.command",
          content: text,
          display: true,
          details: { args: { command: "bind", path }, result },
        });
      } else {
        const notify = (ctx as { ui?: { notify?: (t: string, k?: string) => void } })?.ui?.notify;
        if (typeof notify === "function") notify(text, result.ok ? "info" : "error");
      }
    },
  });

  // NOTE: the background embed worker is intentionally NOT started here (no eager
  // DB opens / lingering timers at registration). recall degrades to FTS when no
  // vectors exist; the embed worker is wired in a later integration task.

  pi.registerTool({
    name: "spider",
    label: "🕸 spider",
    description:
      "spider 🕸 — unified memory, context/search, todos, and subagents on one shared DB. Set `action` to the verb. Key params by action: search/recall→query; remember→content(+category); run→ SINGLE {agent,task} · PARALLEL {tasks:[{agent,task}]} · CHAIN {chain:[{agent,task}]}; subagents ALWAYS run in the background and report back when done; message→{to,message}; kill→{id}; todo→op:add/list/toggle(+text or id); control→command('doctor'|'config'|'memory'|'bind'|'unbind'). Every `run` needs a concrete `task` string — never call run without one.",
    parameters: SPIDER_PARAMETERS,
    renderCall: renderSpiderCall,
    renderResult: renderSpiderResult,
    async execute(toolCallId, args, signal, onUpdate, ctx) {
      // Stream partial output the way pi's built-in bash tool does. The FIRST call is an
      // empty update fired before any output exists: it materialises the result section
      // immediately, so a long command shows a live (and ctrl+o-expandable) result instead
      // of nothing until exit. Subsequent calls carry cumulative, capped snapshots.
      if (ctx) currentContext = ctx;
      const emit = typeof onUpdate === "function" ? (onUpdate as (u: unknown) => void) : undefined;
      const action = String((args as { action?: unknown })?.action ?? "");
      const streams = action === "exec" || action === "exec_file" || action === "batch";
      if (emit && streams) emit({ content: [], details: undefined });
      const onPartial = emit && streams
        ? (text: string) => {
            try { emit({ content: [{ type: "text", text }], details: undefined, isPartial: true }); } catch { /* UI only */ }
          }
        : undefined;

      // pi's real ToolDefinition.execute supplies a genuine `AbortSignal | undefined`
      // (types.d.ts:361) and fires it on Escape mid-run. Guard with `instanceof` so a
      // caller/test that passes a bare object (or omits it) degrades to "no signal"
      // instead of crashing on .aborted/.addEventListener — same defensive shape as the
      // `typeof onUpdate === "function"` guard just above.
      const abortSignal = signal instanceof AbortSignal ? signal : undefined;

      // Normalize the handler result into pi's AgentToolResult shape (content = model-facing
      // text blocks, details = structured payload). TUI Component rendering is separate
      // (renderResult, wired in the UI phase).
      const r = await dispatch(args, buildActionCtx(pi, args as SpiderArgs, sessionIdOf(ctx), cwdOf(ctx), onPartial, (ctx as { modelRegistry?: unknown })?.modelRegistry, abortSignal, parentModelOf(ctx)));
      const result = toToolResult(r);
      // Mechanism (B) (pi-tool-error-contract-report.md §3): pi's AgentToolResult has no
      // isError field of its own — returning one here does nothing. Hand the
      // already-computed signal off, keyed by this exact toolCallId, for the
      // tool_result hook (routing/index.ts) to pick up and flip isError on, without
      // altering content/details returned to pi below.
      if (result.isError) markToolCallError(toolCallId);
      return result;
    },
  });

  try {
    removeLegacyTools(pi as any);
  } catch {
    /* best-effort cutover; never break load */
  }

  // The async subagent_done message is expandable in the transcript: collapsed by default,
  // ctrl+o reveals the COMPLETE curated output. Best-effort — older hosts may lack the API.
  pi.registerMessageRenderer?.("spider.subagent_done", (message: any, options: any, theme: any) =>
    renderSubagentDone(message, options, theme),
  );

  // Slash commands (/spider, /doctor, /stats, …) emit a spider.command message; render its
  // output lines themed in the transcript instead of an ephemeral toast.
  pi.registerMessageRenderer?.("spider.command", (message: any, options: any, theme: any) =>
    renderCommandOutput(message, options, theme),
  );

  pi.registerEntryRenderer?.("spider.organism", (entry: unknown, options: any, theme: unknown) =>
    renderOrganismEntry(entry, options, theme),
  );

  // Escalation messages from subagents render in the error card style (red background).
  pi.registerMessageRenderer?.("spider.escalation", (message: any, options: any, theme: any) =>
    renderEscalationMessage(message, options, theme),
  );

  registerHooks(pi);

  // Register @spider/superpowers: writes the spider-managed AGENTS.md block once
  // per process (skipped under vitest so tests never mutate the real ~/.pi file),
  // and its skillPaths provider backs hooks.ts's resources_discover contribution.
  // Best-effort — never break extension load.
  try {
    registerSuperpowers({ registerAction }, pi, { skipAgentsMd: process.env.VITEST === "true" });
  } catch {
    /* superpowers registration is best-effort; never break extension load */
  }

  // Keep the mutable session id fresh: tool_call/tool_result events carry no
  // sessionId, so routing reads it via getSessionId() over this ref. pi.on
  // chains, so hooks.ts's own session_start handler still runs too.
  pi.on("session_start", (_event: any, ctx?: unknown) => {
    currentContext = ctx;
    currentSessionId = sessionIdOf(ctx);
    return undefined;
  });

  // Mount the live agents UI (footer + Ctrl+Shift+G grid + /agents) on session_start.
  // pi.on chains, so this runs alongside the currentSessionId updater above. The
  // mount is best-effort — never break the session if the UI can't initialize.
  let disposeAgentsUI: (() => void) | undefined;
  pi.on("session_start", (_event: any, ctx: any) => {
    try {
      if (!ctx?.hasUI) return undefined;
      disposeAgentsUI?.();
      const cwd = cwdOf(ctx) ?? process.cwd();
      const sessionId = sessionIdOf(ctx) || currentSessionId;
      const db = openProject(resolveProject(cwd, { sessionId, explicitCwd: false }).projectKey);
      disposeAgentsUI = mountAgentsUI(pi as any, ctx as any, {
        db,
        sessionId,
        cwd,
        dispatch: (action, args) => dispatch({ action, ...args } as SpiderArgs, buildActionCtx(pi, { action, ...args } as SpiderArgs, sessionId, cwd, undefined, ctx.modelRegistry, undefined, parentModelOf(ctx))),
      });
    } catch { /* UI mount best-effort; never break the session */ }
    return undefined;
  });
  pi.on("session_shutdown", () => {
    try { disposeAgentsUI?.(); disposeAgentsUI = undefined; } catch {}
    return undefined;
  });

  // Register tools now, but resolve their DB/CWD only when a session uses them.
  // Getters keep /bind and session replacement from sending activity to the
  // directory in which this extension happened to be loaded.
  try {
    registerRouting(pi as any, {
      get db() { return routingDb(); },
      getSessionId: () => sessionIdOf(currentContext) || currentSessionId,
      getCwd: () => routingProject().realPath,
      get config() { return readRoutingConfig(routingProject().realPath); },
      indexLargeOutput: (text, source) => makeIndexer(routingDb())(text, source),
    });
  } catch (e) {
    // A-M3: previously fully swallowed with nothing anywhere reporting it. Extension
    // load still must not throw (routing is best-effort against the rest of the
    // session), but the failure is now recorded per pi-instance and surfaced by
    // doctor above.
    routingSetupErrors.set(pi as object, safeError(e));
  }

  registerOrganism(pi, pi, ctx => organism.fromContext(ctx).worker, (phase, error, ctx) => organism.recordSetupFailure(phase, error, ctx));
  // Registered LAST: shutdown awaits the worker before closing its resources.
  pi.on("session_shutdown", () => {
    organism.dispose();
    organismRuntimes.delete(pi);
    for (const db of routingDbs.values()) db.close();
    routingDbs.clear();
    currentContext = undefined;
    currentSessionId = "";
  });
}
