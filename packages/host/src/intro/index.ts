import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { sep } from "node:path";
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { FULLSCREEN_READER_OVERLAY, renderDocked, StartupHeader, TabbedReader,
  type DockedUsage, type IconStyle, type IntroTheme, type StartupFacts } from "@spider/ui";
import { modelName } from "../model-name.js";
import { openSessionHistoryDb } from "../session-run-db.js";
import { beginChange, finishChange, newVisitChanges, summarizeChanges } from "./changes.js";
import { countVisitCompactions, readIntroStats, readSpiderStats } from "./stats.js";
import { observeResources, resourceCounts, resourcesDocument } from "./resources.js";
export { readIntroStats } from "./stats.js";

interface QuitTerminal {
  isRestored(): boolean;
  width(): number;
  write(text: string): void;
}
interface IntroOptions {
  admitted(): boolean;
  piVersion?: string;
  iconStyle?(cwd: string): IconStyle | undefined;
  readVisitUsage?(sessionId: string, from: number, to: number): Promise<DockedUsage | undefined>;
  terminal?: QuitTerminal;
}
const tty: QuitTerminal = {
  // In Pi 1.5.2 normal quit restores cooked input before session_shutdown.
  // SIGHUP/SIGTERM emit the same event while input is still raw. Do not write then.
  isRestored: () => process.stdout.isTTY === true && process.stdin.isTTY === true && process.stdin.isRaw === false,
  width: () => process.stdout.columns || 80,
  write: text => { process.stdout.write(text); },
};

interface Visit {
  sessionId: string;
  from: number;
  openedAt: number;
  changes: ReturnType<typeof newVisitChanges>;
}
const visitsKey = Symbol.for("spider.intro.visits");
const processState = globalThis as typeof globalThis & { [visitsKey]?: Map<string, Visit> };

interface Mount {
  visit: Visit;
  context: ExtensionContext;
  facts: StartupFacts;
  theme?: IntroTheme;
  header?: StartupHeader;
  statsRead?: ReturnType<typeof setImmediate>;
  branchRead?: AbortController;
  readingResources?: boolean;
  closeResources?: () => void;
}

const oneLine = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/gu, " ");
const shortCwd = (cwd: string) => cwd === homedir() || cwd.startsWith(homedir() + sep) ? "~" + cwd.slice(homedir().length) : cwd;

function identity(ctx: ExtensionContext) {
  const model = ctx.model;
  return { model: model ? modelName(ctx.modelRegistry, `${model.provider}/${model.id}`) ?? oneLine(model.name || model.id) : undefined,
    thinking: model ? ctx.thinkingLevel : undefined };
}

export function registerIntro(pi: ExtensionAPI, options: IntroOptions): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  const terminal = options.terminal ?? tty;
  let mount: Mount | undefined;
  const update = (current: Mount, fields: Partial<StartupFacts>) => {
    if (mount !== current) return;
    current.facts = { ...current.facts, ...fields };
    current.header?.update(current.facts);
  };
  function dispose(keepVisit: boolean): Mount | undefined {
    const previous = mount;
    mount = undefined;
    if (previous?.statsRead) clearImmediate(previous.statsRead);
    previous?.branchRead?.abort();
    previous?.header?.dispose();
    previous?.closeResources?.();
    if (previous && !keepVisit) processState[visitsKey]?.delete(previous.visit.sessionId);
    return previous;
  }
  async function openResources(ctx: ExtensionContext): Promise<void> {
    const current = mount;
    if (!current || ctx.mode !== "tui" || ctx.sessionManager.getSessionId() !== current.visit.sessionId
      || current.readingResources || !options.admitted()) return;
    current.readingResources = true;
    try {
      const snapshot = observeResources(pi, ctx);
      update(current, { resources: resourceCounts(snapshot) });
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        current.closeResources = done;
        return new TabbedReader(resourcesDocument(snapshot, theme), {
          theme, height: () => tui.terminal.rows, requestRender: () => tui.requestRender(), close: done,
        });
      }, FULLSCREEN_READER_OVERLAY);
    } catch {
      if (mount === current) ctx.ui.notify?.("Could not open loaded resources.", "warning");
    } finally { current.readingResources = false; current.closeResources = undefined; }
  }
  const description = "Open the loaded resources reader";
  pi.registerShortcut?.("alt+o", { description, handler: openResources });
  pi.registerCommand?.("resources", { description, handler: (_args, ctx) => openResources(ctx) });

  function readDbLater(current: Mount): void {
    if (current.statsRead) return;
    current.statsRead = setImmediate(() => {
      current.statsRead = undefined;
      if (mount !== current || !options.admitted()) return;
      const { visit, context, facts } = current;
      try {
        const { db } = openSessionHistoryDb(context.cwd, visit.sessionId);
        try {
          const stats = readSpiderStats(visit.sessionId, false, db);
          update(current, { session: { ...facts.session, ...stats } });
        } finally { db.close(); }
      } catch { /* Missing or unreadable local history should not hold up the TUI. */ }
    });
    current.statsRead.unref?.();
  }
  pi.on("session_start", (event, ctx) => {
    dispose(event?.reason === "reload");
    if (ctx?.mode !== "tui" || !ctx.hasUI || !ctx.ui?.setHeader || !options.admitted()) return;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId) return;
    const now = Date.now();
    const visits = processState[visitsKey] ??= new Map();
    const visit = (event?.reason === "reload" && visits.get(sessionId)) || { sessionId, from: now, openedAt: performance.now(), changes: newVisitChanges() };
    visits.set(sessionId, visit);
    const facts: StartupFacts = {
      version: options.piVersion ?? VERSION,
      iconStyle: options.iconStyle?.(ctx.cwd), cwd: oneLine(shortCwd(ctx.cwd)), ...identity(ctx),
      session: readIntroStats(ctx.sessionManager, now), resources: resourceCounts(observeResources(pi, ctx)),
    };
    const current: Mount = { visit, context: ctx, facts };
    mount = current;
    ctx.ui.setHeader((tui, theme) => {
      current.theme = theme;
      const reducedMotion = process.env.PI_REDUCED_MOTION === "1" || process.env.NO_ANIMATION === "1"
        || ("reducedMotion" in tui.terminal && tui.terminal.reducedMotion === true);
      return current.header = new StartupHeader(theme, current.facts, {
        requestRender: () => tui.requestRender(), openResources: () => { void openResources(current.context); }, reducedMotion,
      });
    });
    readDbLater(current);
    const branchRead = current.branchRead = new AbortController();
    execFile("git", ["branch", "--show-current"], { cwd: ctx.cwd, timeout: 500, signal: branchRead.signal, maxBuffer: 4096 }, (err, output) => {
      current.branchRead = undefined;
      if (!err && output.trim()) update(current, { branch: oneLine(output.trim()) });
    });
  });
  function refresh(ctx: ExtensionContext): void {
    const current = mount;
    if (!current || ctx.sessionManager?.getSessionId() !== current.visit.sessionId || !options.admitted()) return;
    current.context = ctx;
    const session = readIntroStats(ctx.sessionManager, Date.now());
    // Keep previously observed DB counters until the deferred read completes.
    update(current, { ...identity(ctx), session: { ...session, runs: current.facts.session.runs, todos: current.facts.session.todos } });
    readDbLater(current);
  }
  pi.on("turn_end", (_event, ctx) => refresh(ctx));
  pi.on("session_compact", (_event, ctx) => refresh(ctx));
  pi.on("session_tree", (_event, ctx) => refresh(ctx));
  pi.on("model_select", (_event, ctx) => refresh(ctx));
  pi.on("thinking_level_select", (_event, ctx) => refresh(ctx));

  pi.on("tool_call", async (event, ctx) => {
    if (mount && options.admitted() && (event.toolName === "edit" || event.toolName === "write")) {
      await beginChange(mount.visit.changes, ctx.cwd, event.toolCallId, event.input.path);
    }
  });
  pi.on("tool_result", async event => {
    if (mount && options.admitted() && (event.toolName === "edit" || event.toolName === "write")) {
      await finishChange(mount.visit.changes, event.toolCallId, event.isError);
    }
  });
  pi.on("session_shutdown", async (event, ctx) => {
    const previous = dispose(event?.reason === "reload");
    if (!previous?.theme || ctx?.mode !== "tui" || event?.reason !== "quit" || !terminal.isRestored()) return;
    const { visit, theme } = previous;
    const timeMs = performance.now() - visit.openedAt;
    const to = Math.max(visit.from + 1, Date.now() + 1);
    let usage: DockedUsage | undefined;
    try { usage = await options.readVisitUsage?.(visit.sessionId, visit.from, to); }
    catch { /* Cached usage may be unavailable; the other visit statistics still print. */ }
    const lines = renderDocked(terminal.width(), theme, {
      timeMs, usage, changes: summarizeChanges(visit.changes), compactions: countVisitCompactions(ctx.sessionManager, visit.from),
    });
    // Pi emits its own persisted-session resume command immediately after this hook.
    if (lines.length > 0) terminal.write(`\n${lines.join("\n")}\n`);
  });
}
