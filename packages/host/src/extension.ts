import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { bootUsageWorker } from "./usage/worker-entry.js";
import { isUsageServerMain, runUsageServerEntry } from "./usage/server-entry.js";
import { startUsageServerIngest } from "./usage/server-ingest.js";
export { runUsageServerEntry } from "./usage/server-entry.js";
export { UsageRuntime } from "./usage/runtime.js";
import { reviewerThinkingDiagnostic } from "./reviewer-thinking";
import { skillReviewOptions, piLoadedSkills } from "./skill-reviewer";
import { persistReviewError } from "@spider/memory";
import { commandEnv, THINKING_LEVELS } from "@spider/db-core";
import { isAbsolutePathList } from "@spider/ui";
// packages/host/src/extension.ts
// THE single spider pi extension entry. Composes the whole surface:
// one `spider` tool + control routing + every contract hook. Later phases
// attach action handlers via registerAction (re-exported below).
import type { CacheWarmingDecisionEventResult, ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerUsage } from "./usage/mount.js";
import { makeRunCostFormatter } from "./run-credits.js";
import { registerUsageDashboardCommand } from "./usage/dashboard-command.js";
import { dispatch, registerAction as registerGlobalAction, clearActions, type ActionHandler, type ActionCtx, type SpiderArgs } from "./dispatch";
import { registerSlashCommands } from "./slash";
import { removeLegacyTools } from "./legacy-removal";
import { registerHooks } from "./hooks";
import { registerCompaction } from "./compaction/index.js";
import { HostOrganismRuntime } from "./organism-runtime";
import { HostEmbeddingRuntime } from "./embedding-runtime";
import { UsageAccounting } from "./usage-accounting";
import { cwdOf, parentModelOf, sessionIdOf } from "./session-context";
export { cwdOf, sessionIdOf } from "./session-context";
import { registerContextActions, runImport } from "@spider/context";
import { toToolResult, markToolCallError, clearToolCallErrors, rethrowWithMessage, repairBlankToolResults } from "./result";
import { controlDoctor, controlConfig, embeddingDrainEnabled, controlMigrate, modelDefaultLayers, configValues, execEnforcement } from "./control";
import { LOADED_BUILD, type LoadedBundle } from "./build-id";
import { collectStats } from "./control/stats-cmd";
import { setModelDefault, clearLocalModelDefault, listCatalog } from "./control/models-cmd";
import { applyConfigEdit, applyConfigUnset } from "./control/config-cmd";
import { readInjectionSnapshot, type InjectionSnapshot } from "./injection-snapshot";
import { registerRouting, DEFAULT_ROUTING_CONFIG, type RoutingConfig } from "./routing/index";
import { ContentStore } from "@spider/context";
import { enqueueEmbed } from "@spider/memory";
import * as models from "@spider/models";
import { resolveProject, openGlobal, openProject, openRepo, openDbAt, openDbReadOnlyAt, paths, SCHEMA_VERSION, type Db, type ProjectInfo } from "@spider/db-core";
import {
  stageWrite, reviewedWrite, recall, listPending, approvePending, rejectPending, forgetMemory,
  activeCharTotal, listActive, getReadyEmbedder, resolveEmbedder, startEmbedderSession, stopEmbedder,
  renderRememberResult, renderRecallResult, renderPending, MEMORY_CONSOLIDATE_RENAMED_MESSAGE,
} from "@spider/memory";
import { makeTodo, makeTodosCommand } from "@spider/todo";
import { registerSubagentActions, adoptReloadedChildren, adoptableFor, activeChildCount } from "@spider/subagents";
import {
  registerOrganism,
  readOrganismConfig,
  readLastDrainReport,
  readLastDrainReportForWorktree, skillReviewQueueStatus,
  SkillStore,
  skillAction,
  curateAction,
  insightsAction,
  safeError,
  type OrganismActionDeps,
  type SkillActionArgs,
  type DrainReport,
} from "@spider/organism";
import { runUpstreamWatch, markReviewed, registerSuperpowers } from "@spider/superpowers";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { openSessionRunDb } from "./session-run-db";
export { openSessionRunDb } from "./session-run-db";
import { mountAgentsUI } from "./agents/mount";
import { registerAgentsUI } from "./agents/agents-ui";
import { renderSpiderResult, renderSpiderCall, renderSubagentDone, renderCommandOutput, renderEscalationMessage, renderOrganismEntry } from "./render-result";
import { modelReviewer } from "./memory-reviewer";

export { registerGlobalAction as registerAction };

// Hot paths use the shared ready adapter, or FTS while initialization runs.
// The running module owns the comparison location, regardless of session cwd.
export const loadedBundle: LoadedBundle = { identity: LOADED_BUILD, url: import.meta.url };

// Native imports/registration remain inert. A usage worker never invokes the
// extension factory, tools, organism or model runtime, including through pi's shim.
if (!isMainThread && workerData?.spiderUsageWorker === 1 && parentPort) {
  void bootUsageWorker(parentPort, workerData.command).catch(() => {
    try { parentPort?.postMessage({ type: "error", code: "usage-worker-failed" }); } catch { /* parent gone */ }
    parentPort?.close();
  });
}

if (isUsageServerMain(import.meta.url)) {
  // Resolve packaged assets from this running bundle, never cwd or startup records.
  void runUsageServerEntry(import.meta.url, {
    dashboardDir: fileURLToPath(new URL("./dashboard/", import.meta.url)), startParticipant: startUsageServerIngest,
  });
}

const getEmbedder = async () => getReadyEmbedder();

// Each loaded extension owns its runtime; manual actions reuse its serialized workers.
const organismRuntimes = new WeakMap<object, HostOrganismRuntime>();
const usageRuntimes = new WeakMap<object, UsageAccounting>();
const usageControllers = new WeakMap<object, ReturnType<typeof registerUsage>>();

// A-M3 (branch-review A-architecture.md): per-pi-instance record of a `registerRouting`
// setup failure, read by doctor so it is surfaced instead of fully swallowed. Mirrors
// `organismRuntimes`'s own WeakMap-per-pi-instance pattern, used for the identical class
// of problem (registerOrganism's own setup-failure reporting).
const routingSetupErrors = new WeakMap<object, { message: string }>();

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

// Keep the removed names in the tool enum so callers receive this actionable error
// rather than a schema rejection. Only global and repo reach memory storage.
const removedMemoryScope = (a: SpiderArgs): boolean => a.scope === "worktree" || a.scope === "project";
const REMOVED_MEMORY_SCOPE = "worktree memory was removed; use repo (or global for facts true in every repo)";
const scopeOf = (a: SpiderArgs): "global" | "repo" => a.scope === "global" ? "global" : "repo";
const dbFor = (scope: "global" | "repo", ctx: ActionCtx | undefined) =>
  scope === "global" ? ctx!.globalDb : ctx!.repoDb;

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
    apply: { type: "boolean", description: "control migrate: apply changes (default is a dry-run)." },
    mark: { type: "string", description: "control upstream-watch: mark a reviewed baseline as '<package> <ref>' (run the watch first to fetch the mirror)." },
    force: { type: "boolean", description: "control skill sub=curate: run even when the organism is disabled, the curator is paused, or the minimum interval has not elapsed (decay can mark skills stale/archived). fetch: skip the cache TTL and refetch. todo op=clear: remove all todos in the current session, including open items (default removes only done items; session selectors are rejected)." },
    consolidate: { type: "boolean", description: "control skill sub=curate: request aux-model consolidation of eligible agent-created skills when a model and candidates are available; absorbed skills are archived." },
    op: { type: "string", enum: ["get", "set", "unset", "add", "list", "toggle", "remove", "clear", "sessions", "view", "distill", "approve", "reject"], description: "Sub-op. control config: get/set/unset. todo: add/list/toggle/remove/clear/sessions/view. skill: list/view/distill/add/approve/reject; op=add requires final-format SKILL.md with exactly name and a Use when description; STAGES a candidate for review (name+text; never activates); approval/rejection are explicit; an unrecognized op is a host-visible error, never a silent listing." },
    key: { type: "string", description: "control config key." },
    value: { description: "control config value (for op='set')." },
    sub: { type: "string", description: "control memory sub-command (pending|approve|reject|status|forget; consolidate is deprecated -> status + forget)." },
    uuid: { type: "string", description: "memory uuid for approve/reject/forget." },
    // scope / cwd (most actions)
    scope: { type: "string", enum: ["global", "repo", "worktree", "project"], description: "control config set/unset: global writes the global config; repo or omitted writes the worktree-local config. Other config scopes are rejected. Memory scope (default repo). \"Is this true in every repo?\" → **global**; otherwise → **repo**. Worktree/project memory was removed; use repo." },
    cwd: { type: "string", description: "Working-directory override. For run: sets the child's working directory and which project's model defaults apply; the run is still recorded in this session's database (or its /bind target), so kill and message find it without a cwd. Other actions use the override's project database." },
    // search / recall
    query: { type: "string", description: "Search matches any sanitized term. Repo recall ranks all-word matches first (AND), then fills from any-word matches (OR); FTS operators are ignored, and common words are removed unless all terms are common. Global recall matches the whole query as a substring." },
    category: { type: "string", description: "Memory category (remember) or filter (recall); optional skill category for action='skill' op=add." },
    limit: { type: "number", description: "Max results (search/recall)." },
    kinds: { type: "array", items: { type: "string", enum: ["memory", "content", "session", "todo"] }, description: "search: restrict results to these kinds; default includes memory, content, session and todo." },
    // remember
    content: { type: "string", description: "Text proposed for action 'remember' (or index/fetch body). Remember is reviewed for durability, overlap and scope before storage; on review failure it stores as requested." },
    justification: { type: "string", description: "Required for remember: state why the fact is durable (still true and useful after the current task ends), how it helps other agents in this project (repo) or in any repo (global), and why the chosen scope is right (global only if true in every repo; otherwise repo)." },
    link: { type: "string", description: "Optional link/url to attach to a remembered item." },
    auto: { type: "boolean", description: "Mark a remembered item as auto-captured." },
    supersedes: { type: "array", items: { type: "string" }, description: "Remember: active memory UUIDs or unique UUID prefixes in the write scope to replace. Credit their size against the cap and archive atomically with the new entry, including when review is unavailable. Unknown, ambiguous, inactive or cross-scope targets reject without a write. Explicit supersedes is not supported for staged/auto writes." },
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
          model: { type: "string", description: "Per-item model override for this task." },
          thinking: { type: "string", enum: THINKING_LEVELS as readonly string[], description: "Per-item reasoning/thinking level for this task; overrides the resolved model suffix." },
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
          model: { type: "string", description: "Per-item model override for this chain step." },
          thinking: { type: "string", enum: THINKING_LEVELS as readonly string[], description: "Per-item reasoning/thinking level for this chain step; overrides the resolved model suffix." },
          context: { type: "string", enum: ["fresh", "fork"] },
        },
      },
    },
    handoff: { type: "string", enum: ["intercom", "wait"], description: "No effect; accepted for compatibility. Pipeline stages start a fresh child after a done or failed stage with the previous result as {previous}/{handoff}; cancellation ends the pipeline. Neither value sends a mailbox message or waits synchronously." },
    pipeline: {
      type: "array", description: "PIPELINE-mode stages (advanced push-based auto-wake).",
      items: { type: "object", properties: {
        agent: { type: "string" }, role: { type: "string" }, phase: { type: "string" },
        task: { type: "string", description: "Template: {task}, {previous}, {handoff}, {outputs.<as>}." },
        as: { type: "string" }, model: { type: "string", description: "Per-stage model override for this pipeline stage." }, thinking: { type: "string", enum: THINKING_LEVELS as readonly string[], description: "Per-stage reasoning/thinking level for this pipeline stage; overrides the resolved model suffix." },
        skill: { type: "string" }, context: { type: "string", enum: ["fresh", "fork"] },
        count: { type: "integer", minimum: 1 }, wakeOn: { type: "string", enum: ["done", "accepted"] },
      }, required: ["agent"] },
    },
    concurrency: { type: "integer", minimum: 1, description: "PARALLEL max concurrent (default 4)." },
    model: { type: "string", description: "SINGLE-mode model override; tasks, chain and pipeline use per-item model fields." },
    thinking: { type: "string", enum: THINKING_LEVELS as readonly string[], description: "SINGLE-mode reasoning/thinking level; overrides the resolved model suffix. Tasks, chain and pipeline use per-item thinking fields." },
    skill: { type: "string", description: "Skill the spawned subagent should follow." },
    context: { type: "string", enum: ["fresh", "fork"], description: "Child context: fresh, or fork from this session." },
    id: { type: "string", description: "Run id/prefix (todo toggle/remove: per-session seq). For action 'kill': a run id, id prefix, run name, or \"all\" to kill every active subagent in this session." },
    timeoutMs: { type: "integer", minimum: 1, description: "Give up after N ms (message)." },
    // message
    to: { type: "string", description: "Target session name/id for action 'message'." },
    message: { type: "string", description: "Message body for action 'message'." },
    kind: { type: "string", description: "message: optional intercom message kind; defaults to 'message'." },
    // todo
    text: { type: "string", description: "Todo body for action 'todo' op=add; skill candidate final-format SKILL.md (YAML frontmatter with exactly name and a Use when description, then concise body; agent limit 1500 words/16 KB) for action='skill' op=add; free-form request for action='skill' op=distill." },
    session: { type: "string", description: "todo op=view/toggle/remove: session id/prefix/name in the same project DB; toggle/remove default to current session; 'all' is rejected for toggle/remove and accepted for view. import: single transcript file path, taking precedence over sessions and select." },
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
    requests: { type: "array", items: { type: "object", properties: { url: { type: "string" }, source: { type: "string" } }, required: ["url"] }, description: "fetch: batch of {url, source?} requests; when supplied, replaces the single url/source request." },
    ttl: { type: "number", description: "fetch: cache lifetime in milliseconds (24 h default); force bypasses this TTL." },
    source: { type: "string", description: "Source label for action 'index'/'fetch'." },
    path: { type: "string", description: "File/dir path for action 'index'/'exec_file'." },
    // import
    sessions: { type: "array", items: { type: "string" }, description: "import: session transcript file paths; used when session is absent." },
    select: { type: "object", properties: { project: { type: "string" }, all: { type: "boolean" }, since: { type: "number" }, glob: { type: "string" } }, description: "import: select local pi session transcripts by project path (default cwd); all replaces project and searches all projects. since is an epoch timestamp in milliseconds: include files modified at or after it. glob is a path substring. Filters combine (AND); used when session and sessions are absent." },
    commit: { type: "boolean", description: "import: approve staged memory/skill candidates immediately; default leaves them staged." },
    sourceMode: { type: "string", enum: ["pi", "hermes-db", "todos-db", "context-db"], description: "import: only 'pi' session transcripts are implemented; other modes return an error." },
  },
  required: ["action"],
  additionalProperties: true,
} as const;

/** Manual and automatic entry points share the same session/project worker. */
function buildOrganismDeps(ctx: ActionCtx): OrganismActionDeps {
  if (process.env.PI_SUBAGENT_CHILD === "1") throw new Error("organism is disabled in subagent sessions");
  const api = ctx.pi as object;
  let runtime = organismRuntimes.get(api);
  if (!runtime) {
    runtime = new HostOrganismRuntime(getEmbedder, undefined, () => piLoadedSkills(ctx.pi), () => ctx.usage ?? (() => undefined));
    organismRuntimes.set(api, runtime);
  }
  return runtime.resolve(ctx);
}

// Test hosts can supply local watch sources without exposing them to JSON tool calls.
export const UPSTREAM_REPOS_FOR_TESTS: unique symbol = Symbol("upstream-repos-for-tests");

/** control routing lives in-host (doctor/config work in Phase 0; memory in Phase 1). */
/** Render a control upstream-watch report as a compact 🕸 panel string. */
function renderUpstreamReport(report: {
  packages: Array<{
    package: string;
    state: "no-baseline" | "fetch-failed" | "unreachable" | "up-to-date" | "candidates";
    head: string;
    candidates: Array<{ commit: string; subject: string }>;
    reason?: string;
  }>;
  todosAdded: number;
}): string {
  const lines = [`🕸 upstream-watch — ${report.packages.length} package(s) checked, ${report.todosAdded} new cherry-pick todo(s)`];
  for (const p of report.packages) {
    const head = p.head ? ` @ ${p.head.slice(0, 7)}` : "";
    const reason = (p.reason ?? "unknown reason").split("\n")[0];
    if (p.state === "no-baseline") {
      lines.push(`  ${p.package}${head}: NO BASELINE — ${reason}`);
      continue;
    }
    if (p.state === "fetch-failed") {
      lines.push(`  ${p.package}: FETCH FAILED / UNREACHABLE — ${reason}`);
      continue;
    }
    if (p.state === "unreachable") {
      lines.push(`  ${p.package}${head}: UNREACHABLE — ${reason}`);
      continue;
    }
    if (p.state === "up-to-date") {
      lines.push(`  ${p.package}${head}: up to date`);
      continue;
    }
    lines.push(`  ${p.package}${head}: ${p.candidates.length} candidate(s)`);
    for (const candidate of p.candidates) lines.push(`    • ${candidate.commit.slice(0, 7)} ${candidate.subject}`);
  }
  return lines.join("\n");
}

type DoctorActionCtx = Omit<ActionCtx, "repoDb"> & { repoDb?: Db };

async function handleControl(args: SpiderArgs, ctx?: DoctorActionCtx, doctorSnapshot?: InjectionSnapshot, doctorSessionId?: string, usageController?: ReturnType<typeof registerUsage>): Promise<unknown> {
  const command = String(args.command ?? "");
  const cwd = String(args.cwd ?? ctx?.cwd ?? process.cwd());
  const fullCtx: ActionCtx | undefined = ctx?.repoDb ? { ...ctx, repoDb: ctx.repoDb } : undefined;
  switch (command) {
    case "doctor": {
      const report = controlDoctor(cwd, ctx?.sessionId ?? doctorSessionId, loadedBundle, await (usageController ?? (ctx ? usageControllers.get(ctx.pi as object) : undefined))?.doctor());
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
          report.lines.push(`- routing: NOT WIRED (registration failed: ${routingError.message})`);
        }
        if (process.env.PI_SUBAGENT_CHILD === "1") {
          report.lines.push("- organism: disabled in subagent sessions");
        } else try {
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
              if (!ctx.sessionId) throw new Error("Organism needs an active pi session.");
              return runtime?.peekLastDrain(ctx.sessionId, ctx.project.projectKey);
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
          const version = ctx.repoDb ? Number(ctx.repoDb.pragma("user_version")) : undefined;
          if (version !== undefined && version < SCHEMA_VERSION) {
            report.ok = false;
            report.lines.push(`- repo DB schema v${version} < v${SCHEMA_VERSION}; run spider control migrate with apply=true`);
          } else if (version !== undefined && version > SCHEMA_VERSION) {
            report.ok = false;
            report.lines.push(`- repo DB schema v${version} is newer than this build (v${SCHEMA_VERSION}); proposal counts unavailable`);
          }
          const pendingMemory = ctx.repoDb && version === SCHEMA_VERSION ? listPending(ctx.repoDb, "repo").length : 0;
          const pendingSkills = ctx.repoDb && version === SCHEMA_VERSION ? new SkillStore(ctx.repoDb).list({ status: "staged" }).length : 0;
          const queue = ctx.repoDb && version === SCHEMA_VERSION ? skillReviewQueueStatus(ctx.repoDb) : { pending: 0, recent: [] };
          report.lines.push(`- skill review queue: ${queue.pending}`);
          for (const item of queue.recent) report.lines.push(`- skill review ${item.name}: ${safeError(`${item.verdict}: ${item.reason}`)}`);
          report.lines.push(`- organism: ${state}`);
          if (version === undefined || version === SCHEMA_VERSION) {
            report.lines.push(`- organism proposals awaiting review: ${pendingMemory} memories, ${pendingSkills} skills`);
          } else if (version < SCHEMA_VERSION) {
            report.lines.push("- organism proposal counts unavailable until migrated");
          }
          if (enabled && last && (last.status === "failed" || last.status === "partial" || last.skipReason === "no-model")) report.ok = false;
          for (const reason of last?.skillReviewReasons ?? []) report.lines.push(`- organism skill review: ${safeError(reason)}`);
          if (last?.skillCapDropped) report.lines.push(`- organism skill proposal cap dropped: ${last.skillCapDropped}`);
          for (const error of last?.errors ?? []) report.lines.push(`- organism ${error.phase}: ${error.message}`);
          if (pendingMemory + pendingSkills > 0) report.lines.push("- review proposals: spider control memory sub=pending; spider skill op=list");
        } catch (e) {
          // A-M4: same fix as the inner catch above — was a raw stringifier.
          report.ok = false;
          report.lines.push(`- organism diagnostics unavailable: ${safeError(e)}`);
        }
      }
      {
        try {
          const snap = ctx?.injectionSnapshot ?? doctorSnapshot ?? readInjectionSnapshot(ctx?.injectionCwd ?? cwd, ctx?.sessionId);
          let omitted = 0;
          for (const scope of ["global", "repo"] as const) {
            const error = snap.errors[scope];
            if (error) {
              report.ok = false;
              report.lines.push(`- memory ${scope}: unreadable: ${safeError(error)}`);
            } else {
              const { active, injected } = snap.counts[scope];
              report.lines.push(`- memory ${scope}: active=${active} injected=${injected}`);
              omitted += active - injected;
            }
          }
          if (snap.errors.config) {
            report.ok = false;
            report.lines.push(`- memory ${safeError(snap.errors.config)}`);
          }
          if (omitted) {
            if (!snap.capped) report.ok = false;
            report.lines.push(`- memory WARNING: ${omitted} ${omitted === 1 ? "entry" : "entries"} omitted from injection (memory.snapshotCharCap)`);
          }
        } catch (e) {
          report.ok = false;
          report.lines.push(`- memory diagnostics unavailable: ${safeError(e)}`);
        }
      }
      return report;
    }
    case "config": {
      const op = args.op ?? "get";
      if (op !== "get" && op !== "set" && op !== "unset") {
        return { error: `control config: unsupported op '${String(op)}'; supported ops: get/set/unset` };
      }
      if (op === "set" || op === "unset") {
        if (args.scope !== undefined && args.scope !== "global" && args.scope !== "repo") {
          return { error: "control config: scope must be global or repo (omit scope for local config)" };
        }
        if (!args.key) return { error: `control config ${op}: key required` };
        const scope = args.scope === "global" ? "global" : "local";
        const r = op === "unset"
          ? applyConfigUnset(cwd, String(args.key), scope)
          : applyConfigEdit(cwd, String(args.key), String(args.value), scope);
        if (r.ok) (usageController ?? (ctx ? usageControllers.get(ctx.pi as object) : undefined))?.reload();
        return { details: r };
      }
      const { config, sources, errors } = configValues(cwd);
      if (args.key) return { details: { key: args.key, value: config[String(args.key)], source: sources[String(args.key)] ?? "unset", errors } };
      return { details: { config, sources, errors } };
    }
    case "memory": {
      if (removedMemoryScope(args)) return { error: REMOVED_MEMORY_SCOPE };
      const scope = scopeOf(args);
      const db = dbFor(scope, fullCtx);
      switch (args.sub) {
        case "pending": {
          const recs = listPending(db, scope);
          return { display: renderPending(recs), details: recs };
        }
        case "approve": {
          const uuid = args.uuid as string;
          const approved = approvePending(db, scope, uuid);
          if (!approved) return { error: `control memory approve: no staged entry '${uuid}' in scope '${scope}'` };
          return { details: approved };
        }
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
      if (process.env.PI_SUBAGENT_CHILD === "1") return { error: "organism is disabled in subagent sessions" };
      if (!fullCtx) return { error: "control skill requires an action context" };
      if (args.sub === "curate") {
        return await curateAction(buildOrganismDeps(fullCtx), {
          force: args.force as boolean | undefined,
          consolidate: args.consolidate as boolean | undefined,
        });
      }
      return { error: `control skill sub '${String(args.sub)}' unknown (valid: curate)` };
    }
    case "insights": {
      if (process.env.PI_SUBAGENT_CHILD === "1") return { error: "organism is disabled in subagent sessions" };
      if (!fullCtx) return { error: "control insights requires an action context" };
      return insightsAction(buildOrganismDeps(fullCtx));
    }
    case "stats": {
      if (!fullCtx) return { error: "control stats requires an action context" };
      return { details: collectStats({ worktreeDb: fullCtx.db, repoDb: fullCtx.repoDb }, fullCtx.globalDb) };
    }
    case "models": {
      if (!ctx) return { error: "control models requires an action context" };
      if (args.op === "set") {
        const r = setModelDefault(cwd, String(args.key ?? ""), String(args.value ?? ""), listCatalog(ctx.modelRegistry));
        return { details: { ...r, role: args.key, ref: args.value } };
      }
      if (args.op === "clear") {
        const r = clearLocalModelDefault(cwd, String(args.key ?? ""));
        return { details: { ...r, role: args.key } };
      }
      const { defaults, sources, global, local, errors } = modelDefaultLayers(cwd);
      const catalog = listCatalog(ctx.modelRegistry);
      const effective = models.resolveRoleDefaults(catalog, defaults);
      const origins = Object.fromEntries(Object.keys(effective).map(role => [role, sources[role] ?? "default"]));
      return { details: { catalog, defaults: effective, sources: origins, global, local, errors } };
    }
    case "upstream-watch": {
      if (!ctx) return { error: "control upstream-watch requires an action context" };
      const git = (
        repo: string,
        gitArgs: string[],
        options: { timeoutMs: number; env: Readonly<Record<string, string>> },
      ): Promise<string> => new Promise((resolve, reject) => {
        execFile("git", gitArgs, {
          cwd: repo,
          encoding: "utf8",
          timeout: options.timeoutMs,
          env: commandEnv({ ...process.env, ...options.env }),
        }, (error, stdout, stderr) => {
          if (error) {
            Object.assign(error, { stderr });
            reject(error);
          } else {
            resolve(stdout);
          }
        });
      });
      const mirrorRoot = path.join(paths.globalRoot, "upstream");
      const mark = (args as { mark?: unknown }).mark;
      const parts = Array.isArray(mark) ? mark.map(value => String(value).trim())
        : mark == null || mark === false ? [] : String(mark).trim().split(/\s+/).filter(Boolean);
      if (parts.some(Boolean)) {
        const [pkg, ref] = parts;
        if (!pkg || !ref || parts.length !== 2) return { error: "control upstream-watch --mark needs <package> <ref>" };
        try {
          const sha = await markReviewed(ctx.globalDb, pkg, ref, { git, mirrorRoot });
          return {
            display: `🕸 upstream-watch: marked ${pkg} reviewed @ ${sha}`,
            details: { ok: true, marked: { package: pkg, ref, sha } },
          };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      }
      const upstreamRepos = (ctx.pi as { [UPSTREAM_REPOS_FOR_TESTS]?: Record<string, string> })[UPSTREAM_REPOS_FOR_TESTS];
      const report = await runUpstreamWatch(ctx.globalDb, ctx.db, ctx.sessionId, {
        git,
        mirrorRoot,
        upstreamRepos,
        packages: upstreamRepos ? Object.keys(upstreamRepos) : undefined,
      });
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
  pi: PiToolAPI, args: SpiderArgs, sessionId: string, ctxCwd: string | undefined,
  onPartial: ((text: string) => void) | undefined, modelRegistry: unknown, signal: AbortSignal | undefined,
  parentModel: string | undefined, readOnlyRepo: true,
): DoctorActionCtx & { parentModel?: string };
export function buildActionCtx(
  pi: PiToolAPI, args: SpiderArgs, sessionId: string, ctxCwd?: string,
  onPartial?: (text: string) => void, modelRegistry?: unknown, signal?: AbortSignal,
  parentModel?: string, readOnlyRepo?: false,
): ActionCtx & { parentModel?: string };
export function buildActionCtx(
  pi: PiToolAPI,
  args: SpiderArgs,
  sessionId: string,
  ctxCwd?: string,
  onPartial?: (text: string) => void,
  modelRegistry?: unknown,
  signal?: AbortSignal,
  parentModel?: string,
  readOnlyRepo = false,
): (ActionCtx | DoctorActionCtx) & { parentModel?: string } {
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
  const settings = configValues(cwd);
  const configuredExtensions = settings.config["subagents.extensions"];
  const extensionsFile = settings.globalFile;
  const validExtensions = isAbsolutePathList(configuredExtensions);
  if (args.action === "run" && !validExtensions) throw new Error(`invalid subagents.extensions in ${extensionsFile}: expected a JSON array of absolute file paths`);
  const subagentOnlyExtensions = validExtensions ? configuredExtensions as string[] : [];
  // Run records are owned by the dispatching session, not by the child's cwd.
  // Keep `project`, `cwd`, repoDb and modelDefaults tied to the target as before.
  const runRecordAction = args.action === "run" || args.action === "kill" || args.action === "message";
  // With no explicit override, this resolution also identifies the session-owned DB.
  const sessionRun = runRecordAction ? openSessionRunDb(ctxCwd ?? process.cwd(), sessionId, !explicitCwd ? project : undefined) : undefined;
  const worktreeDb = sessionRun?.db ?? openProject(project.projectKey);
  // For git repos: open the repo DB
  // For non-git dirs: create a repo-schema DB at worktree root (memory tables live in repo tier)
  // IMPORTANT 6: Use paths.projectRoot to get <root>/.spider (dotted dir)
  const repoPath = project.repoKey
    ? path.join(project.repoKey, "spider", "repo.db")
    : path.join(paths.projectRoot(project.projectKey), "repo.db");
  // Reporting on a repo must never create or migrate its DB. Other actions still
  // use the writable, migrated connection they require.
  const repoDb = readOnlyRepo
    ? openDbReadOnlyAt(repoPath)
    : project.repoKey ? openRepo(project.repoKey) : openDbAt(repoPath, "repo");
  // Resolved once per dispatch so packages/subagents/src/actions/run.ts (which cannot
  // import @spider/host to read config itself) can apply the models.defaults[<role>]
  // precedence without ever touching the config file directly.
  const configuredModels = (settings.config["models.defaults"] as Record<string, string> | undefined) ?? {};
  const modelDefaults = args.action === "run" ? models.resolveRoleDefaults(listCatalog(modelRegistry), configuredModels) : configuredModels;
  const configuredChildMode = settings.config["subagents.childMode"];
  if (args.action === "run" && configuredChildMode !== "rpc" && configuredChildMode !== "print") throw new Error("subagents.childMode must be rpc or print");
  const childMode = configuredChildMode === "print" ? "print" : "rpc";
  const accounting = usageRuntimes.get(pi);
  return { formatRunCost: makeRunCostFormatter(() => usageControllers.get(pi)?.snapshot()), usage: accounting?.factory(sessionId), reportUsage: accounting ? (db, run) => accounting.reportRun(db, run) : undefined, db: worktreeDb, runDbPath: sessionRun?.dbPath, repoDb, globalDb: openGlobal(), project, sessionId, cwd, injectionCwd: ctxCwd ?? rawCwd, pi, models, onPartial, modelRegistry, modelDefaults, signal, parentModel, childMode, subagentOnlyExtensions };
}

async function dispatchWithDoctorSnapshot(
  pi: PiToolAPI, params: SpiderArgs, ctx: unknown, ownedActions: ReadonlyMap<string, ActionHandler>,
  onPartial?: (text: string) => void, signal?: AbortSignal, onSessionProject?: (project: ProjectInfo) => void,
): Promise<unknown> {
  const sessionId = sessionIdOf(ctx);
  const injectionSnapshot = params.action === "control" && params.command === "doctor"
    ? readInjectionSnapshot(cwdOf(ctx) ?? String(params.cwd ?? process.cwd()), sessionId) : undefined;
  try {
    if (injectionSnapshot) {
      const actionCtx = buildActionCtx(pi, params, sessionId, cwdOf(ctx), onPartial,
        (ctx as { modelRegistry?: unknown })?.modelRegistry, signal, parentModelOf(ctx), true);
      if (!params.cwd) onSessionProject?.(actionCtx.project);
      actionCtx.injectionSnapshot = injectionSnapshot;
      // An older schema can still be inspected, but a corrupt file must retain
      // the existing action-context fallback rather than hiding the open error.
      if (injectionSnapshot.errors.repo && actionCtx.repoDb) actionCtx.repoDb.pragma("user_version");
      return await handleControl(params, actionCtx);
    }
    if (params.action === "control" && params.command === "migrate") {
      // A dry-run must not migrate the repo as a side effect of context creation.
      const actionCtx = buildActionCtx(pi, params, sessionId, cwdOf(ctx), onPartial,
        (ctx as { modelRegistry?: unknown })?.modelRegistry, signal, parentModelOf(ctx), true);
      if (!params.cwd) onSessionProject?.(actionCtx.project);
      return await handleControl(params, actionCtx);
    }
    const actionCtx = buildActionCtx(pi, params, sessionId, cwdOf(ctx), onPartial,
      (ctx as { modelRegistry?: unknown })?.modelRegistry, signal, parentModelOf(ctx));
    if (!params.cwd) onSessionProject?.(actionCtx.project);
    return await dispatch(params, actionCtx, ownedActions);
  } catch (e) {
    if (!injectionSnapshot) throw e;
    const report = await handleControl({ ...params, cwd: params.cwd ?? cwdOf(ctx) ?? process.cwd() }, undefined, injectionSnapshot, sessionId, usageControllers.get(pi)) as { ok: boolean; lines: string[] };
    report.ok = false;
    report.lines.push(`- action context unavailable: ${safeError(e)}`);
    return report;
  }
}

export default function spiderExtension(pi: PiToolAPI): void {
  const accounting = new UsageAccounting();
  usageRuntimes.set(pi, accounting);
  const ownedActions = new Map<string, ActionHandler>();
  const registerAction = (name: string, handler: ActionHandler) => {
    // Context packages reuse module-level functions. Wrap even those handlers so
    // registry identity always identifies one activation, not a shared function.
    const ownedHandler: ActionHandler = (args, ctx) => handler(args, ctx);
    ownedActions.set(name, ownedHandler);
    registerGlobalAction(name, ownedHandler, true);
  };
  const errorOwner = {};
  const agentsUI = registerAgentsUI(pi as any);
  // Only error results need this backstop: empty successful reads are valid, and rewriting
  // them makes pi replace the message list, disrupting prompt caching for ordinary sessions.
  pi.on("context", (event: unknown) => {
    try { return repairBlankToolResults((event as ContextEvent)?.messages ?? []); }
    catch { return undefined; }
  });
  const organism = new HostOrganismRuntime(getEmbedder, report => {
    const meaningful = report.status === "failed" || report.status === "partial" ||
      report.memoryStaged + report.skillsStaged + (report.skillsQueued ?? 0) + report.todosAdded > 0;
    if (meaningful) pi.appendEntry?.("spider.organism", report);
  }, () => piLoadedSkills(pi), sessionId => accounting.factory(sessionId));
  organismRuntimes.set(pi, organism);
  let currentContext: unknown;
  let currentSessionId = "";
  const embeddings = new HostEmbeddingRuntime(() => currentContext, resolveEmbedder, { enabled: project => embeddingDrainEnabled(path.dirname(project.dbPath)) });
  // Fence embedding writes before later shutdown hooks await other background work.
  pi.on("session_shutdown", async () => { await embeddings.stop(); });
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

  // A child completion will request a parent turn. Keep that parent's cache warm
  // using the live session-owned handles, never a runs-table scan.
  if (process.env.PI_SUBAGENT_CHILD !== "1") {
    pi.on("cache_warming_decision", (_event, ctx): CacheWarmingDecisionEventResult | undefined => {
      try {
        if (process.env.PI_SUBAGENT_CHILD === "1") return undefined;
        const sessionId = sessionIdOf(ctx);
        if (!sessionId || activeChildCount(sessionId) === 0) return undefined;
        if (controlConfig("get", cwdOf(ctx) ?? process.cwd(), "subagents.keepCacheWarm") !== true) return undefined;
        return { action: "warm" };
      } catch { return undefined; }
    });
  }

  // memory verbs (ctx-native): use the per-call ActionCtx DBs buildActionCtx resolved.
  registerAction("remember", async (args, ctx) => {
    if (removedMemoryScope(args)) return { error: REMOVED_MEMORY_SCOPE };
    const scope = scopeOf(args);
    // Justification is deterministic, even when the model is disabled or unavailable.
    if (typeof args.justification !== "string" || !args.justification.trim()) {
      return { error: "justification required: say why the fact is durable after this task, how it helps other agents, and why the chosen scope is right (global in every repo, otherwise repo)" };
    }
    const enabled = controlConfig("get", ctx.cwd, "memory.reviewer.enabled") !== false;
    const model = controlConfig("get", ctx.cwd, "memory.reviewer.model");
    const timeoutMs = controlConfig("get", ctx.cwd, "memory.reviewer.timeoutMs");
    const thinkingDiagnostics: import("@spider/db-core").ThinkingResolution[] = [];
    const recordThinking = reviewerThinkingDiagnostic(ctx.cwd, "memory", String(model));
    const r = await reviewedWrite({ repo: ctx.repoDb, global: ctx.globalDb }, scope, {
      category: args.category as any,
      content: args.content as string,
      link: (args.link as string | null) ?? null,
      source: args.auto ? "auto" : "user",
    }, args.justification, {
      supersedes: args.supersedes as string[] | undefined,
      reviewer: enabled ? modelReviewer(typeof model === "string" ? model : "github-copilot/gpt-6-luna", ctx.modelRegistry, controlConfig("get", ctx.cwd, "memory.reviewer.thinking") as import("@spider/db-core").ThinkingLevel, info => { thinkingDiagnostics.push(info); recordThinking(info); }, ctx.usage) : undefined,
      skipReason: "reviewer disabled",
      timeoutMs: timeoutMs as number,
      signal: ctx.signal,
      repoAvailable: Boolean(ctx.project.repoKey),
      onReviewError: (error, raw) => persistReviewError(ctx.cwd, "memory", error, raw),
    });
    // Carry the saved content/category/scope on BOTH the rendered panel and the serialized
    // details payload, so a programmatic caller gets back what was actually remembered.
    const details = { ...r, content: args.content as string, category: args.category as any, justification: args.justification, thinkingDiagnostics };
    const notes = thinkingDiagnostics.filter(info => info.effective === "off" || info.requested !== info.effective).map(info => info.notice).filter(Boolean).join("\n");
    return { text: [r.message, notes].filter(Boolean).join("\n"), display: [renderRememberResult(details), notes].filter(Boolean).join("\n"), details };
  });

  registerAction("recall", async (args, ctx) => {
    if (removedMemoryScope(args)) return { error: REMOVED_MEMORY_SCOPE };
    const scope = scopeOf(args);
    const embedder = scope === "repo" && typeof args.query === "string" && args.query ? getReadyEmbedder() : null;
    const recs = await recall(dbFor(scope, ctx), scope, args.query as string, embedder, {
      category: args.category as any,
      limit: args.limit as number | undefined,
    });
    return { display: renderRecallResult(recs), details: recs };
  });

  // todos (ctx-native): dispatch always supplies ctx.db + ctx.sessionId, so the
  // action needs no closure deps; the /todos command resolves db+session per call.
  registerAction("todo", makeTodo());

  // Explicit staging is foreground review, including in children. It never
  // constructs a background organism, learner or drain.
  registerAction("skill", (args, ctx) => {
    if (process.env.PI_SUBAGENT_CHILD === "1" && ["distill", "approve", "reject"].includes(String(args.op))) {
      return { error: "organism is disabled in subagent sessions" };
    }
    if (process.env.PI_SUBAGENT_CHILD === "1" || args.op === "add") {
      return skillAction({ db: ctx.repoDb, project: ctx.project,
        skillReview: skillReviewOptions(ctx.cwd, ctx.modelRegistry, ctx.signal, piLoadedSkills(ctx.pi), ctx.usage) }, args as SkillActionArgs);
    }
    return skillAction(buildOrganismDeps(ctx), args as SkillActionArgs);
  });
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
      dispatchWithDoctorSnapshot(pi, a as SpiderArgs, ctx, ownedActions) as Promise<{
        content: string;
        details?: unknown;
      }>,
    alreadyRegistered: new Set(["todos", "agents"]),
  });

  // User-only /exec-enforce command (bypasses model-facing guard)
  const enforcementProblems = (diagnostics: string[]) => diagnostics.map(error =>
    error.replace(/^cannot parse config file /, "config file does not parse: ")
      .replace(/^invalid models\.defaults in /, "invalid value for models.defaults in ")
  ).join("; ");
  pi.registerCommand?.("exec-enforce", {
    description: "Control bash enforcement (user only)",
    handler: async (args: string, ctx: unknown) => {
      const cwd = cwdOf(ctx) ?? process.cwd();
      const arg = typeof args === "string" ? args.trim().toLowerCase() : "";
      
      // No argument: report current state
      if (!arg) {
        const { current, errors, diagnostics } = execEnforcement(cwd);
        const state = errors.length === 0 && current === false ? "OFF" : "ON";
        const text = `exec.enforce is ${state} (default: ON${diagnostics.length ? `; config problems: ${enforcementProblems(diagnostics)}` : ""})`;
        
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
      const { errors, diagnostics } = execEnforcement(cwd);
      const text = errors.length
        ? `exec.enforce remains ON (config problems: ${enforcementProblems(diagnostics)})`
        : `exec.enforce set to ${value ? "ON" : "OFF"}${diagnostics.length ? ` (config problems: ${enforcementProblems(diagnostics)})` : ""}`;
      
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

  // Embedding maintenance starts lazily on parent session_start, not registration.
  // It is independent of optional organism learning and never runs in children.

  pi.registerTool({
    name: "spider",
    label: "🕸 spider",
    description:
      "spider 🕸: unified memory, context/search, todos, and subagents on one shared DB. Set `action` to the verb. Key params by action: search/recall→query; remember→content+category+required justification, optional supersedes:[uuid or unique prefix] for atomic same-scope replacement with cap credit (foreground only; reviewer still checks durability, usefulness and scope and may skip storage, change scope or archive replaced entries); run→ SINGLE {agent,task} · PARALLEL {tasks:[{agent,task}]} · CHAIN {chain:[{agent,task}]}; subagents ALWAYS run in the background and report back when done; message→{to,message} (owned RPC run: delivered only after observed conversation entry, otherwise accepted but not confirmed, no reply yet with delivery unknown, or refused; slash-prefixed steers are refused); kill→{id}; todo→op:add/list/toggle/remove/clear/sessions/view(+text, id or session); control→command('doctor'|'config'|'memory'|'bind'|'unbind'). Every `run` needs a concrete `task` string; never call run without one.",
    parameters: SPIDER_PARAMETERS,
    renderCall: renderSpiderCall,
    renderResult: (result: any, options: any, theme: any, context: any) => renderSpiderResult(result, options, theme,
      { ...context, formatRunCost: makeRunCostFormatter(() => usageControllers.get(pi)?.snapshot()) }),
    async execute(toolCallId, args, signal, onUpdate, ctx) {
      // Stream partial output the way pi's built-in bash tool does. The FIRST call is an
      // empty update fired before any output exists: it materialises the result section
      // immediately, so a long command shows a live (and ctrl+o-expandable) result instead
      // of nothing until exit. Subsequent calls carry cumulative, capped snapshots.
      if (ctx) { currentContext = ctx; accounting.activate(ctx); }
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
      let r: unknown;
      // Reuse only this call's non-explicit resolution, never a prior binding or cwd.
      let sessionProject: ProjectInfo | undefined;
      try {
        r = await dispatchWithDoctorSnapshot(pi, args as SpiderArgs, ctx, ownedActions, onPartial, abortSignal, project => { sessionProject = project; });
      } catch (error) {
        rethrowWithMessage(error, `spider ${action || "call"}`);
      }
      const result = toToolResult(r);
      // Mechanism (B) (pi-tool-error-contract-report.md §3): pi's AgentToolResult has no
      // isError field of its own — returning one here does nothing. Hand the
      // already-computed signal off, keyed by this exact toolCallId, for the
      // tool_result hook (routing/index.ts) to pick up and flip isError on, without
      // altering content/details returned to pi below.
      if (result.isError) markToolCallError(toolCallId, errorOwner);
      const sessionId = sessionIdOf(ctx);
      if (sessionId && process.env.PI_SUBAGENT_CHILD !== "1") {
        try {
          const { db } = openSessionRunDb(cwdOf(ctx) ?? process.cwd(), sessionId,
            sessionProject && existsSync(sessionProject.projectKey) ? sessionProject : undefined);
          try {
            const usage = accounting.takeFallback(db, sessionId);
            if (usage) return { ...result, usage };
          } finally { db.close(); }
        } catch { /* accounting must not replace the action's result, including doctor on a broken DB */ }
      }
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
  registerUsageDashboardCommand(pi as unknown as ExtensionAPI, loadedBundle.url);
  const usageController = registerUsage(pi as unknown as ExtensionAPI, loadedBundle.url);
  usageControllers.set(pi, usageController);

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
    accounting.activate(ctx);
    currentContext = ctx;
    currentSessionId = sessionIdOf(ctx);
    startEmbedderSession();
    embeddings.start();
    if (currentSessionId && process.env.PI_SUBAGENT_CHILD !== "1") {
      try {
        const { db } = openSessionRunDb(cwdOf(ctx) ?? process.cwd(), currentSessionId);
        try { accounting.restore(db, currentSessionId); } finally { db.close(); }
      } catch { /* usage restoration is best effort, even when the project DB is broken */ }
    }
    return undefined;
  });

  // Mount the agents UI (configured footer + Alt+Shift+Up selector + /agents) on session_start.
  // pi.on chains, so this runs alongside the currentSessionId updater above. The
  // mount is best-effort — never break the session if the UI can't initialize.
  let disposeAgentsUI: (() => void) | undefined;
  pi.on("session_start", (_event: any, ctx: any) => {
    try {
      if (!ctx?.hasUI || process.env.PI_SUBAGENT_CHILD === "1") return undefined;
      disposeAgentsUI?.();
      const cwd = cwdOf(ctx) ?? process.cwd();
      const sessionId = sessionIdOf(ctx) || currentSessionId;
      const { db } = openSessionRunDb(cwd, sessionId);
      disposeAgentsUI = mountAgentsUI(pi as any, ctx as any, {
        db,
        sessionId,
        cwd,
        registration: agentsUI,
        formatRunCost: makeRunCostFormatter(() => usageControllers.get(pi)?.snapshot()),
        dispatch: (action, args) => dispatch({ action, ...args } as SpiderArgs, buildActionCtx(pi, { action, ...args } as SpiderArgs, sessionId, cwd, undefined, ctx.modelRegistry, undefined, parentModelOf(ctx)), ownedActions),
      });
    } catch { /* UI mount best-effort; never break the session */ }
    return undefined;
  });
  // A /reload keeps this session's async subagents running (see subagents/child-registry.ts).
  // The reloaded activation takes them over here, against ITS pi, db and notifier. Runs on any
  // session_start reason and only does work when this session has detached children waiting.
  pi.on("session_start", (_event: any, ctx: any) => {
    try {
      if (process.env.PI_SUBAGENT_CHILD === "1") return undefined;
      const sessionId = sessionIdOf(ctx);
      if (!sessionId || !adoptableFor(sessionId).length) return undefined;
      const cwd = cwdOf(ctx) ?? process.cwd();
      const actionCtx = buildActionCtx(pi, { action: "kill" } as SpiderArgs, sessionId, cwd, undefined, ctx.modelRegistry, undefined, parentModelOf(ctx));
      // The action ctx has no ui of its own; hand over the session's so a refused adoption is visible.
      adoptReloadedChildren({ ...actionCtx, ui: ctx.ui });
    } catch (error) {
      // Best-effort, but never silent: the registry TTL will stop whatever is left detached.
      try { ctx.ui?.notify?.(`Subagents could not be re-adopted after the reload: ${String((error as Error)?.message ?? error)}. Detached runs will be stopped shortly.`, "warning"); } catch { /* no UI */ }
    }
    return undefined;
  });
  pi.on("session_shutdown", () => {
    try { disposeAgentsUI?.(); disposeAgentsUI = undefined; } catch {}
    return undefined;
  });

  // Register tools now, but resolve their DB/CWD only when a session uses them.
  // Getters keep /bind and session replacement from sending activity to the
  // directory in which this extension happened to be loaded.
  let routingSetupError: { message: string } | undefined;
  try {
    registerRouting(pi as any, {
      toolErrorOwner: errorOwner,
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
    routingSetupError = { message: safeError(e) };
    routingSetupErrors.set(pi as object, routingSetupError);
  }

  // Cancel storage maintenance and reviewers before any shutdown learning drain starts.
  pi.on("session_shutdown", async () => { await organism.stopSkillReviews(); });
  if (process.env.PI_SUBAGENT_CHILD !== "1") {
    registerOrganism(pi, pi, ctx => organism.fromContext(ctx).worker, (phase, error, ctx) => organism.recordSetupFailure(phase, error, ctx));
  }
  // Pi keeps the last truthy before-compact result. The organism returns undefined;
  // register the managed summary after it, for both parent and child activations.
  registerCompaction(pi as unknown as ExtensionAPI, { readConfig: cwd => configValues(cwd).config });
  // Registered LAST: shutdown awaits the worker before closing its resources.
  pi.on("session_shutdown", async () => {
    try {
      await organism.stopSkillReviews();
      organism.dispose();
      for (const db of routingDbs.values()) db.close();
    } finally {
      // Reflection can use the ready worker until its shutdown drain completes.
      await stopEmbedder();
      // The organism's earlier handler has completed drain and curate. Invalidate only
      // now so shutdown calls count, but responses still in flight cannot append later.
      accounting.shutdown();
      // Node retains the module record after a rebuilt reload. Release its heavy
      // references only after the earlier organism shutdown handler has drained.
      clearActions(ownedActions);
      ownedActions.clear();
      clearToolCallErrors(errorOwner);
      if (organismRuntimes.get(pi) === organism) organismRuntimes.delete(pi);
      if (usageRuntimes.get(pi) === accounting) usageRuntimes.delete(pi);
      if (usageControllers.get(pi) === usageController) usageControllers.delete(pi);
      if (routingSetupErrors.get(pi) === routingSetupError) routingSetupErrors.delete(pi);
      routingDbs.clear();
      currentContext = undefined;
      currentSessionId = "";
    }
  });
}
