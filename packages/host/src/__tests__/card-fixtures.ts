import type { IconStyle } from "@spider/ui";
import type { DrainReport } from "@spider/organism";
import {
  renderCommandOutput, renderEscalationMessage, renderOrganismEntry, renderSpiderCall,
  renderSpiderResult, renderSubagentDone,
} from "../render-result";
import { toToolResult } from "../result";

type Render = (width: number, expanded: boolean, iconStyle: IconStyle) => string[];
interface CardFixture {
  name: string;
  verb: string;
  render: Render;
  runIds: string[];
  groups: number;
  callDetails: boolean;
  notification?: boolean;
  callOnly?: boolean;
}

const theme = {
  fg: (_token: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bg: (_token: string, text: string) => `\x1b[40m${text}\x1b[49m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

const runId = "beb58fc6-193f-4247-bb38-c59612f6985d";
const secondRunId = "5f3b8190-92e9-4ad5-8a01-d823e4bf0e09";
const sessionId = "cbf27a41-b5fc-49ee-b789-a265b40cd235";
const otherSessionId = "3ca9327d-9895-4ebe-a35d-ab55a5e8a406";
const memoryId = "bfc3fe01-cf01-46ba-b629-4d6ce7201ef2";
const noticeId = "c02d5f17-4ca0-48d3-83ea-0abfd30b06e0";
const run = { id: runId, name: "tia-3", agent: "worker", model: "github-copilot/gpt-6.2-sol", thinking: "high", status: "failed", cost: 0, token_count: 13616326, result: "The build failed in the final packaging step.\nThe package manifest is missing.\nSee the build report for the exact path." };
const todo = { seq: 935, text: "Check the packaging job with a fresh build directory.", done: false, session: sessionId, name: "release" };
const doneTodo = { ...todo, seq: 936, text: "Read the build logs.", done: true };
const memory = { uuid: memoryId, category: "convention", status: "active", content: "Check the output directory before packaging the release.", link: "docs/release.md" };
const skill = { name: "check-packaging", tier: "project", state: "active", status: "approved", useCount: 3, candidateBody: "Use the packaging report to verify the manifest and confirm that all listed files are present." };
const report: DrainReport = {
  kind: "organism-drain", sessionId, reason: "before_compact", status: "completed", startedAt: 0, finishedAt: 320,
  modelCalls: 1, inputs: { messages: 8, runs: 2, runEvents: 1, events: 0, completedTodos: 1 },
  memoryStaged: 1, skillsStaged: 0, skillsQueued: 1, todosAdded: 1, dropped: 0, rejected: 0, errors: [],
};
const commands = [
  "sqlite3 project.db 'SELECT seq, done, text FROM todos'", "date '+%H:%M:%S'", "printf 'report\\n'", "pwd",
  "git status --short", "git diff --stat", "test -d docs", "ls docs",
];
const exec = { stdout: "935|0|Check the packaging job with a fresh build directory.\n936|1|Read the build logs.\nready\ndone", stderr: "", exitCode: 0, outcome: "exited" };
const escalationMessage = {
  details: { runId, name: run.name, agent: run.agent, severity: "warning", summary: "The rebuild found two missing manifest entries. I will check the packaging logs before trying another build.\n\nThe current report lists both files and their expected paths." },
};

export function cardFixtures(): CardFixture[] {
  const tool = (
    name: string, args: { action: string; [key: string]: unknown },
    details: unknown, options: { groups?: number; runIds?: string[]; callDetails?: boolean; text?: string; isError?: boolean; isPartial?: boolean; callOnly?: boolean } = {},
  ): CardFixture => ({
    name, verb: args.action, runIds: options.runIds ?? [], groups: options.groups ?? 1,
    callDetails: options.callDetails ?? false, callOnly: options.callOnly,
    render(width, expanded, iconStyle) {
      const normalized = toToolResult({ details, text: options.text, isError: options.isError });
      const context = { args, expanded, iconStyle, sessionId, isError: normalized.isError, isPartial: options.isPartial };
      const call = renderSpiderCall(args, theme, context).render(width);
      return options.callOnly ? call : [...call, ...renderSpiderResult(normalized, { expanded, isPartial: options.isPartial }, theme, context).render(width)];
    },
  });
  const control = (name: string, args: object, details: unknown, options?: Parameters<typeof tool>[3]) =>
    tool(`control ${name}`, { action: "control", ...args }, details, options);
  const notification = (name: string, verb: string, render: Render, runIds: string[] = []): CardFixture =>
    ({ name, verb, render, runIds, groups: 1, callDetails: false, notification: true });
  const listGroup = { session: sessionId, name: "release", todos: [todo, doneTodo] };
  const otherGroup = { session: otherSessionId, name: "docs", todos: [{ ...todo, seq: 460, session: otherSessionId, name: "docs" }] };
  const defaultEntry = { provider: "github-copilot", id: "gpt-6.2-sol", tier: "standard", available: true, thinking: true, vision: true, ctx: 128000, speed: 2, costHint: 2 };
  const insights = {
    nodes: [{ id: memoryId, label: "Verify the manifest", kind: "memory", category: "convention" }],
    edges: [], stats: { nodes: 1, edges: 0, linkedPct: 0 },
  };
  return [
    tool("exec", { action: "exec", code: commands.join("\n") }, exec, { callDetails: true }),
    tool("exec file", { action: "exec_file", path: "scripts/check-manifest.sh", on: "build-box" }, exec, { callDetails: true }),
    tool("batch", { action: "batch", commands: commands.slice(0, 2).map(code => ({ code, language: "shell" })) }, [
      { ...exec, idx: 0 }, { ...exec, idx: 1, stdout: "ready", exitCode: 1 },
    ], { callDetails: true, isError: true }),
    tool("exec running", { action: "exec", code: commands[0] }, undefined, { callDetails: true, isPartial: true, text: "Running the packaging check" }),
    tool("exec call only", { action: "exec", code: commands.join("\n") }, undefined, { callDetails: true, callOnly: true }),
    tool("exec file call only", { action: "exec_file", path: "scripts/check-manifest.sh" }, undefined, { callDetails: true, callOnly: true }),
    tool("batch call only", { action: "batch", commands: commands.map(code => ({ code, language: "shell" })) }, undefined, { callDetails: true, callOnly: true }),
    tool("run call only", { action: "run", agent: "worker", task: "Check the manifest" }, undefined, { callOnly: true }),
    tool("run single", { action: "run", agent: "worker" }, { run: { ...run, task: "Check the manifest.\nRead the build logs." } }, { runIds: [runId] }),
    tool("run parallel", { action: "run", tasks: [{ agent: "worker" }, { agent: "reviewer" }] }, {
      runs: [run, { id: secondRunId, name: "audit", agent: "reviewer", status: "running", model: "github-copilot/claude-opus-5.5", task: "Check the package contents against the manifest." }],
    }, { runIds: [runId, secondRunId], groups: 2 }),
    tool("run chain", { action: "run", chain: [{ agent: "worker" }] }, { runs: [{ ...run, status: "running", result: null }] }, { runIds: [runId] }),
    tool("run pipeline", { action: "run", pipeline: [{ agent: "worker" }] }, { runs: [{ ...run, status: "running", result: null }] }, { runIds: [runId] }),
    tool("index", { action: "index", path: "docs/release.md" }, { source: "release guide", chunkCount: 12 }),
    tool("fetch", { action: "fetch", url: "https://example.com/packaging" }, { count: 1, chunks: 12, embedded: 8, sources: ["packaging guide"], urls: ["https://example.com/packaging"] }),
    tool("message run", { action: "message", to: runId.slice(0, 8), message: "Please check the two paths in the report." }, { runId, runName: run.name, delivered: true, delivery: "delivered" }, { runIds: [runId] }),
    tool("message peer", { action: "message", to: sessionId, message: "Can you confirm the release target?" }, { sessionName: "release", delivered: true, delivery: "broker-accepted" }, { runIds: [sessionId] }),
    tool("message refused", { action: "message", to: runId, message: "Check the logs again." }, { runId, runName: run.name, delivered: false, delivery: "refused", error: "The run has already finished." }, { runIds: [runId], isError: true }),
    tool("kill", { action: "kill", id: runId }, { requested: runId, killed: [{ runId, name: run.name, outcome: "killed", via: "handle", lastActivity: "Reading the packaging log" }] }, { runIds: [runId] }),
    tool("remember", { action: "remember" }, { ...memory, status: "staged", scope: "repo", reason: "Awaiting review" }, { runIds: [memoryId] }),
    tool("recall", { action: "recall", query: "packaging" }, [memory], { runIds: [memoryId] }),
    tool("todo add", { action: "todo", op: "add" }, todo, { runIds: [sessionId] }),
    tool("todo toggle", { action: "todo", op: "toggle", id: 936 }, doneTodo, { runIds: [sessionId] }),
    tool("todo remove", { action: "todo", op: "remove", id: 935 }, todo, { runIds: [sessionId] }),
    tool("todo remove from another session", { action: "todo", op: "remove", session: otherSessionId, id: 460 }, otherGroup.todos[0], { runIds: [otherSessionId] }),
    tool("todo clear", { action: "todo", op: "clear" }, { removed: 2, kept: 1 }),
    tool("todo list", { action: "todo", op: "list" }, listGroup.todos, { runIds: [sessionId] }),
    tool("todo view one session", { action: "todo", op: "view", session: sessionId }, [listGroup], { runIds: [sessionId] }),
    tool("todo view several sessions", { action: "todo", op: "view", session: "all" }, [listGroup, otherGroup], { runIds: [sessionId, otherSessionId], groups: 2 }),
    tool("todo sessions", { action: "todo", op: "sessions" }, [{ name: "release", session: sessionId, total: 2, done: 1, current: true }, { name: "docs", session: otherSessionId, total: 1, done: 0 }], { runIds: [sessionId, otherSessionId] }),
    tool("search", { action: "search", query: "packaging" }, [
      { kind: "memory", title: "Check the manifest", source: "repo", snippet: memory.content },
      { kind: "content", title: "Release guide", source: "docs/release.md", snippet: "Check files before upload.\nThe release workflow verifies the manifest after building the package." },
    ], { groups: 2 }),
    tool("skill list", { action: "skill", op: "list" }, [skill]),
    tool("skill view", { action: "skill", op: "view", name: skill.name }, skill),
    tool("skill distill", { action: "skill", op: "distill" }, { prompt: "Write a short skill that explains what to check before packaging a release." }),
    tool("skill approve", { action: "skill", op: "approve" }, { row: skill }),
    tool("skill reject", { action: "skill", op: "reject" }, { row: { ...skill, status: "rejected" } }),
    tool("import", { action: "import", session: sessionId }, { imported: 1, skipped: 0, staged: 2, committed: 0, perSession: [{ sessionId, name: "release", status: "imported", candidates: 2, chunks: 9 }] }, { runIds: [sessionId] }),
    tool("notify", { action: "notify", message: "The release is ready for approval." }, { ok: true, id: noticeId, presentation: "panel-feed" }, { runIds: [noticeId] }),
    tool("loop", { action: "loop", name: "check-release" }, { triggers: [{ name: "check-release", interval: "5m", prompt: "Check packaging CI" }] }, { text: "Loop check-release runs every 5 minutes." }),
    tool("schedule", { action: "schedule", name: "check-release" }, { name: "check-release", delaySeconds: 300 }, { text: "Scheduled check-release in 5 minutes." }),
    control("doctor", { command: "doctor" }, { ok: true, lines: ["## spider doctor", "- storage: open", "- vector recall: queue empty"] }),
    control("insights", { command: "insights" }, insights, { runIds: [memoryId] }),
    control("insights linked", { command: "insights" }, { ...insights, edges: [{ source: "Verify the manifest", target: "check-packaging" }], stats: { nodes: 2, edges: 1, linkedPct: 100 }, nodes: [...insights.nodes, { id: "check-packaging", label: "check-packaging", kind: "skill" }] }, { groups: 2, runIds: [memoryId] }),
    control("stats", { command: "stats" }, { tokenSavings: { indexedChunks: 12, estTokensSaved: 280 }, rowCounts: { todos: 2, runs: 3 }, models: [{ model: "github-copilot/gpt-6.2-sol", calls: 10, okRate: 0.9, avgMs: 120, tokens: 2000 }] }, { groups: 3 }),
    control("models", { command: "models" }, { catalog: [defaultEntry, { ...defaultEntry, id: "gpt-6-luna", tier: "light" }], defaults: { worker: "github-copilot/gpt-6.2-sol" } }, { groups: 2 }),
    control("models one tier", { command: "models" }, { catalog: [defaultEntry], defaults: { worker: "github-copilot/gpt-6.2-sol" } }),
    control("models set", { command: "models", op: "set" }, { ok: true, role: "worker", ref: "github-copilot/gpt-6.2-sol" }),
    control("models clear", { command: "models", op: "clear" }, { ok: true, role: "worker", cleared: true }),
    control("config list", { command: "config" }, { config: { "ui.icons": "text" } }, { groups: 2 }),
    control("config get", { command: "config", op: "get" }, { key: "ui.icons", value: "text", source: "repo" }),
    control("config set", { command: "config", op: "set" }, { ok: true, key: "ui.icons", op: "set", value: "text", scope: "repo", file: "config.json" }),
    control("config unset", { command: "config", op: "unset" }, { ok: true, key: "ui.icons", op: "unset", scope: "repo" }),
    control("memory status", { command: "memory", sub: "status" }, { entries: [memory], usage: memory.content.length }, { runIds: [memoryId] }),
    control("memory pending", { command: "memory", sub: "pending" }, [{ ...memory, status: "staged" }], { runIds: [memoryId] }),
    control("memory approve", { command: "memory", sub: "approve" }, { status: "active", uuid: memoryId }, { runIds: [memoryId] }),
    control("memory reject", { command: "memory", sub: "reject" }, { ok: true, uuid: memoryId }, { runIds: [memoryId] }),
    control("memory forget", { command: "memory", sub: "forget" }, { ok: true, uuid: memoryId, scope: "repo", removed: { status: "archived" } }, { runIds: [memoryId] }),
    control("memory consolidate error", { command: "memory", sub: "consolidate" }, { error: "Memory consolidate was renamed to memory status." }),
    control("skill curate", { command: "skill", sub: "curate" }, { toStale: [], toArchived: [], skipped: [skill] }),
    control("migrate", { command: "migrate" }, { dryRun: true, applied: false, wouldMove: { todos: 3 }, ambiguous: [{ table: "memories", uuid: memoryId, reason: "No repository was recorded." }] }, { runIds: [memoryId], groups: 2 }),
    control("bind", { command: "bind" }, { ok: true, path: "work/release", message: "Scope: repository memory and search." }),
    control("unbind", { command: "unbind" }, { ok: true, message: "Scope: current repository." }),
    control("upstream-watch", { command: "upstream-watch" }, { packages: [{ package: "superpowers", state: "up-to-date", head: "2a8368ee", candidates: [] }], todosAdded: 0 }),
    tool("tool error", { action: "index" }, {}, { isError: true, text: "Cannot read docs/release.md. Check that the release guide exists." }),
    notification("notification: run finished", "run", (w, expanded, icons) => renderSubagentDone({ details: { ...run, runId, output: run.result, tokenCount: run.token_count } }, { expanded }, theme, icons).render(w), [runId]),
    notification("notification: command", "control", (w, expanded, icons) => renderCommandOutput({ details: { args: { action: "control", command: "doctor" }, result: { ok: true, lines: ["- storage: open", "- search: available"] } } }, { expanded }, theme, icons).render(w)),
    notification("notification: organism", "organism", (w, expanded, icons) => renderOrganismEntry({ data: report }, { expanded }, theme, icons).render(w), [sessionId]),
    notification("notification: escalation", "escalation", (w, expanded, icons) => renderEscalationMessage(escalationMessage, { expanded }, theme, icons).render(w), [runId]),
  ];
}
