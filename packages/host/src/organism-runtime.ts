import { join } from "node:path";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { openGlobal, openProject, openRepo, openDbAt, paths, resolveProject, type ProjectInfo } from "@spider/db-core";
import type { Embedder } from "@spider/memory";
import { complete, pick } from "@spider/models";
import { emitLog } from "@spider/subagents";
import {
  createDigestModel, OrganismWorker, readCuratorConfig, readOrganismConfig, safeError,
  type OrganismActionDeps, type WorkerDeps, type DrainReport,
} from "@spider/organism";
import { controlConfig } from "./control";
import { listCatalog } from "./control/models-cmd";
import { cwdOf, parentModelOf, sessionIdOf } from "./session-context";

interface RuntimeContext {
  sessionId: string;
  cwd: string;
  project?: ProjectInfo;
  modelRegistry?: unknown;
  parentModel?: string;
}
interface RuntimeEntry {
  context: RuntimeContext;
  actions: OrganismActionDeps;
  deps: WorkerDeps;
}
const BACKGROUND_INPUT_CHAR_CAP = 64_000;
function boundedPrompt(messages: readonly { role: string; content: string }[]): string {
  const text = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  if (text.length <= BACKGROUND_INPUT_CHAR_CAP) return text;
  const note = "[Earlier input omitted to bound background review; recent conversation follows.]\n";
  return note + text.slice(-(BACKGROUND_INPUT_CHAR_CAP - note.length));
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
function configuredAux(cfg: unknown): { provider?: string; model?: string } {
  const all = object(cfg);
  const nested = object(object(all.auxiliary).background_review);
  const grouped = object(all["auxiliary.background_review"]);
  const read = (key: "provider" | "model") => {
    const value = all[`auxiliary.background_review.${key}`] ?? grouped[key] ?? nested[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return { provider: read("provider"), model: read("model") };
}
function completionRegistry(value: unknown): ModelRegistry {
  const r = value as Partial<ModelRegistry> | undefined;
  if (typeof r?.find !== "function" || typeof r.complete !== "function") {
    throw new Error("Organism needs pi's authenticated ModelRegistry.complete API. Reload the updated extension in pi 0.85.1 or newer.");
  }
  return r as ModelRegistry;
}

/** Session-owned resources. Construction opens nothing; the first real context resolves the DBs. */
export class HostOrganismRuntime {
  readonly #entries = new Map<string, RuntimeEntry>();
  #disposed = false;
  /** False once `registerOrganism`'s own `pi.on` registration has failed for
   *  THIS runtime instance — deliberately per-instance (not module-global) so
   *  multiple extension/runtime instances (e.g. tests) never share state. */
  #wired = true;
  /** Honest in-memory fallback for a setup/registration failure that could not
   *  be persisted (no session identity, or storage unavailable), keyed by
   *  session id. Never a substitute for a real persisted receipt when one
   *  exists. */
  readonly #setupFailures = new Map<string, DrainReport>();
  constructor(
    private readonly getEmbedder: () => Promise<Embedder | null>,
    private readonly onDrainReport?: (report: DrainReport) => void,
  ) {}

  /** False once this instance's own lifecycle-hook registration has failed. */
  isWired(): boolean {
    return this.#wired;
  }

  /** The in-memory (possibly also persisted) setup-failure receipt for a
   *  session, when this runtime instance has recorded one. */
  getSetupFailure(sessionId: string): DrainReport | undefined {
    if (!sessionId) return undefined;
    const report = this.#setupFailures.get(sessionId);
    return report ? structuredClone(report) : undefined;
  }

  /**
   * Record a failure that happened BEFORE a worker/drain could even start:
   * `registerOrganism`'s own `pi.on` throwing (`phase:"register"`), a
   * lifecycle event with no resolvable context/session id
   * (`phase:"context"`), or the deps resolver/transcript capture throwing
   * (`phase:"resolve"`). Always kept in-memory (visible to doctor even when
   * nothing could be persisted); when a session id exists AND this runtime
   * is not disposed, makes ONE independent, bounded `resolveProject`+
   * `openProject` attempt to persist the same receipt into the real worktree
   * DB via the existing `readLastDrainReport` surface — NEVER by calling
   * `resolve()`/`fromContext()` (which could recurse into the very resolver
   * that just failed). The ad-hoc DB handle is always closed. Never invents
   * a session id, and never claims persistence when storage/project
   * resolution itself is the failure.
   */
  recordSetupFailure(phase: string, error: unknown, ctx?: ExtensionContext): void {
    if (phase === "register") this.#wired = false;
    const sessionId = ctx ? sessionIdOf(ctx) : "";
    const now = Date.now();
    const message = safeError(error);
    const report: DrainReport = {
      kind: "organism-drain",
      sessionId: sessionId || "(no-session)",
      reason: "shutdown",
      status: "failed",
      startedAt: now, finishedAt: now, modelCalls: 0,
      memoryStaged: 0, todosAdded: 0, skillsStaged: 0, dropped: 0, rejected: 0,
      inputs: { messages: 0, runs: 0, runEvents: 0, events: 0, completedTodos: 0 },
      errors: [{ phase: "setup", message: `(${phase}) ${message}` }],
    };
    if (!sessionId) return; // Never invent a session id; visible only via a future call that has one.
    this.#setupFailures.set(sessionId, report);
    if (this.#disposed) return; // Disposed runtime stays in-memory-only; no new resources.
    try {
      const cwd = cwdOf(ctx!) ?? process.cwd();
      const project = resolveProject(cwd, { sessionId, explicitCwd: false });
      const worktreeDb = openProject(project.projectKey);
      try {
        worktreeDb.prepare("INSERT OR IGNORE INTO sessions(id,reason,started_at) VALUES (?,?,?)")
          .run(sessionId, "organism-setup-failure", now);
        emitLog(worktreeDb, {
          sessionId,
          summary: `organism drain (${report.reason}): failed (setup)`,
          payload: report,
        });
      } finally {
        worktreeDb.close();
      }
    } catch {
      // Storage unavailable or project unresolved: the in-memory record above
      // remains the honest, doctor-visible evidence of this failure.
    }
  }

  fromContext(ctx: ExtensionContext): OrganismActionDeps {
    return this.resolve({
      sessionId: sessionIdOf(ctx), cwd: cwdOf(ctx) ?? process.cwd(),
      modelRegistry: ctx.modelRegistry, parentModel: parentModelOf(ctx),
    });
  }

  resolve(context: RuntimeContext): OrganismActionDeps {
    if (this.#disposed) throw new Error("Organism runtime has shut down; reload the session before using it.");
    if (!context.sessionId) throw new Error("Organism needs an active pi session.");
    const project = context.project ?? resolveProject(context.cwd, { sessionId: context.sessionId, explicitCwd: false });
    const key = JSON.stringify([context.sessionId, project.projectKey]);
    const existing = this.#entries.get(key);
    if (existing) {
      existing.context = { ...context, project };
      return existing.actions;
    }

    const worktreeDb = openProject(project.projectKey);
    const db = project.repoKey
      ? openRepo(project.repoKey)
      : openDbAt(join(paths.projectRoot(project.projectKey), "repo.db"), "repo");
    const globalDb = openGlobal();
    // /bind does not emit another session_start. Without this idempotent insert,
    // proposals land in the new repo but the session summary updates zero rows.
    worktreeDb.prepare("INSERT OR IGNORE INTO sessions(id,reason,started_at) VALUES (?,?,?)")
      .run(context.sessionId, "organism", Date.now());
    // Getters read current settings rather than freezing configuration at extension load.
    const config = () => controlConfig("get", project.realPath);
    const entry = {} as RuntimeEntry;
    entry.context = { ...context, project };
    const deps: WorkerDeps = {
      db, worktreeDb, globalDb, project, getEmbedder: this.getEmbedder,
      onDrainReport: this.onDrainReport,
      get org() { return readOrganismConfig(config()); },
      get curator() { return readCuratorConfig(config()); },
      makeModel: (signal) => {
        const current = entry.context;
        const registry = completionRegistry(current.modelRegistry);
        const available = listCatalog(registry);
        if (available.length === 0) throw new Error("Organism has no authenticated model available. Check pi /model and /login.");
        const cfg = config();
        const aux = configuredAux(cfg);
        const parent = current.parentModel;
        const parentProvider = parent?.slice(0, parent.indexOf("/"));
        let ref: string | undefined;
        if (aux.model?.includes("/")) {
          if (aux.provider && !aux.model.startsWith(`${aux.provider}/`)) {
            throw new Error("Organism auxiliary provider and qualified model disagree.");
          }
          ref = aux.model;
        } else if (aux.model) {
          const provider = aux.provider ?? parentProvider;
          const matches = available.filter(m => m.id === aux.model && (!provider || m.provider === provider));
          if (matches.length !== 1) throw new Error(`Organism auxiliary model '${aux.model}' is unavailable or ambiguous; configure its provider explicitly.`);
          ref = `${matches[0].provider}/${matches[0].id}`;
        } else if (aux.provider && aux.provider !== parentProvider) {
          throw new Error("Organism auxiliary provider needs an explicit model when it differs from the active provider.");
        } else {
          ref = parent;
        }
        if (ref === undefined) {
          throw new Error("Organism has no active model to mirror; select a model with /model.");
        }
        if (!available.some(m => `${m.provider}/${m.id}` === ref)) {
          throw new Error(`Organism model '${ref}' is not available in this authenticated session.`);
        }
        const selected = pick(available, { model: ref }, {});
        const requestSignal = signal ?? AbortSignal.timeout(30_000);
        return createDigestModel({
          cfg, parentModel: parent ?? "",
          call: async (_runtime, system, messages) => complete(selected, boundedPrompt(messages),
            { registry, system, maxTokens: 4096, signal: requestSignal },
          ),
        });
      },
    };
    entry.deps = deps;
    entry.actions = { db, globalDb, project, worker: new OrganismWorker(deps) };
    this.#entries.set(key, entry);
    return entry.actions;
  }

  /** Called after organism shutdown hooks have awaited their serialized work. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const { deps } of this.#entries.values()) {
      deps.worktreeDb.close();
      deps.db.close();
      deps.globalDb.close();
    }
    this.#entries.clear();
  }
}
