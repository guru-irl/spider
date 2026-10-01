import { describe, expect, it, vi } from "vitest";
import { addMemory, MemoryOverflowError, type MemoryRecord } from "@spider/memory";
import { makeGlobalMemDb, makeMemDb } from "../../../memory/src/__tests__/helpers/tmpdb";
import { renderCommandOutput, renderSpiderResult } from "../render-result";

const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text };
const errorText = "Storage unavailable: retry after freeing space";
// Cover every action plus each distinct sub-dispatch, including the default paths.
const cases = [
  ...["run", "exec", "exec_file", "batch", "index", "fetch", "message", "kill", "remember", "recall", "search", "import", "unknown"].map(action => ({ action })),
  ...["add", "list", "toggle", "remove", "clear", "sessions", "view"].map(op => ({ action: "todo", op })),
  ...["list", "distill", "view", "add", "approve", "reject"].map(op => ({ action: "skill", op })),
  ...["pending", "doctor", "stats", "models", "config", "insights", "migrate", "bind", "unbind", "unknown"].map(command => ({ action: "control", command })),
  ...["pending", "status", "forget", "approve", "reject"].map(sub => ({ action: "control", command: "memory", sub })),
  { action: "control", command: "skill", sub: "curate" },
];
// pi-coding-agent 0.85.1 tool-execution.js:259 (0.87.0:267) passes
// {content, details}, {expanded, isPartial}, theme, getRenderContext().
// The error flag is ONLY in the fourth argument (getRenderContext():87).
const body = (args: unknown, result: unknown, expanded = false, activeTheme = theme, isError = false) =>
  renderSpiderResult(result, { expanded, isPartial: false }, activeTheme, { args, isError }).render(240).join("\n");

describe.each(cases)("error fallback for $action $command $sub $op", args => {
  // A broken success-shaped dispatch should lose the error text or print undefined.
  for (const expanded of [false, true]) {
    it(`shows thrown content errors (expanded=${expanded})`, () => {
      const out = body(args, { details: {}, content: [{ type: "text", text: errorText }] }, expanded, theme, true);
      expect(out).toContain(errorText);
      expect(out).toContain("✗");
      expect(out).not.toContain("undefined");
    });
    it(`shows returned details errors (expanded=${expanded})`, () => {
      const out = body(args, { details: { error: errorText }, content: [] }, expanded);
      expect(out).toContain(errorText);
      expect(out).not.toContain("undefined");
    });
  }
});

it.each([undefined, null, {}])("remember without a status is an error, not a success receipt (%j)", details => {
  const out = body({ action: "remember" }, { details, content: [{ type: "text", text: errorText }] });
  expect(out).toContain(errorText);
  expect(out).toContain("✗");
  expect(out).not.toContain("status:");
});

it("uses error theme styling and retains all error text when expanded", () => {
  const colored = { ...theme, fg: (token: string, text: string) => token === "error" ? `\x1b[31m${text}\x1b[39m` : text };
  const out = body({ action: "remember" }, { details: {}, content: [{ type: "text", text: "Not stored: storage unavailable\nRetry after freeing space" }] }, true, colored, true);
  expect(out).toContain("\x1b[31m");
  expect(out).toContain("Not stored: storage unavailable");
  expect(out).toContain("Retry after freeing space");
});

it.each([
  { details: {} },
  { details: { error: new Error(errorText) } },
  { details: {}, content: [{ type: "image", data: "fixture" }] },
])("shows a useful fallback for non-text or empty errors (%j)", result => {
  const out = body({ action: "remember" }, result, false, theme, true);
  expect(out).toContain("✗");
  expect(out).not.toContain("undefined");
  expect(out).toMatch(/unavailable|failed|no message/i);
});

it.each([
  [{ action: "control", command: "config" }, { key: "unset.key", source: "unset" }],
  [{ action: "todo", op: "remove" }, { seq: 1 }],
  [{ action: "todo", op: "clear" }, { removed: 0 }],
  [{ action: "batch", commands: [{ code: "first" }, { code: "second" }] }, [{ outcome: "aborted" }, { outcome: "signal", signal: "SIGTERM", exitCode: null }]],
])("does not print missing optional fields as undefined (%j)", (args, details) => {
  expect(body(args, { details })).not.toContain("undefined");
});

describe.each(["global", "repo"] as const)("%s cap card", scope => {
  it("shows only the headline collapsed, and actionable instructions and entry IDs expanded", () => {
    const ctx = scope === "global" ? makeGlobalMemDb() : makeMemDb();
    let message = "";
    let entry: MemoryRecord;
    try {
      entry = addMemory(ctx.db, scope, { category: "preference", content: "x".repeat(7952) });
      try { addMemory(ctx.db, scope, { category: "preference", content: "y".repeat(470) }); }
      catch (error) { expect(error).toBeInstanceOf(MemoryOverflowError); message = (error as Error).message; }
    } finally { ctx.cleanup(); }
    const args = { action: "remember", scope };
    const result = { details: {}, content: [{ type: "text", text: message }] };
    const collapsed = body(args, result, false, theme, true);
    const expanded = body(args, result, true, theme, true);
    expect(collapsed).toContain(`Not stored: ${scope} memory is full (7,952 of 8,000 chars used). This entry is 470 chars; free at least 422.`);
    expect(collapsed.trim().split("\n")).toHaveLength(1);
    expect(collapsed).not.toContain(entry!.uuid);
    expect(expanded).toContain(`spider control memory sub=forget uuid=<uuid> scope=${scope}`);
    expect(expanded).toContain(entry!.uuid);
    expect(expanded).toContain("7,952 chars");
    expect(expanded).not.toContain("undefined");
  });
});

// Catch a drift in the actual upstream boundary, not just our synthetic envelope.
it("renders a thrown exec through pi's root-exported ToolExecutionComponent", async () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", process.env.SPIDER_GLOBAL_ROOT!);
  try {
    const { ToolExecutionComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
    initTheme("dark", false); // Built-in theme only, no watcher or user config.
    const calls: unknown[][] = [];
    const row = new ToolExecutionComponent("spider", "fixture", { action: "exec", code: "x" }, { showImages: false }, {
      renderCall: () => ({ render: () => [], invalidate() {} }),
      renderResult: (result: unknown, options: unknown, activeTheme: unknown, context: unknown) => {
        calls.push([result, options, context]);
        const component = renderSpiderResult(result, options, activeTheme, context);
        return { render: (width: number) => component.render(width), invalidate: () => component.invalidate?.() };
      },
    }, { requestRender() {} } as ConstructorParameters<typeof ToolExecutionComponent>[5], process.cwd());
    row.updateResult({ content: [{ type: "text", text: errorText }], details: {}, isError: true });
    const [result, options, context] = calls.at(-1)! as any[];
    expect(result).toEqual({ content: [{ type: "text", text: errorText }], details: {} });
    expect(options).toEqual({ expanded: false, isPartial: false });
    expect(context).toMatchObject({ args: { action: "exec", code: "x" }, isError: true });
    const out = row.render(240).join("\n");
    expect(out).toContain(errorText);
    expect(out).toContain("✗");
    expect(out).not.toContain("exit 0");
  } finally { vi.unstubAllEnvs(); }
});

it.each([undefined, null, {}])("catches bare thrown exec details (%j)", details => {
  expect(body({ action: "exec" }, { details, content: [{ type: "text", text: errorText }] }, false, theme, true)).toContain(errorText);
});

it("keeps a nonzero exec's structured result even when context.isError is true", () => {
  const out = body({ action: "exec", code: "x" }, { details: { exitCode: 2, stdout: "useful output", stderr: "", outcome: "exited" }, content: [] }, false, theme, true);
  expect(out).toContain("exit 2");
  expect(out).toContain("useful output");
  expect(out).not.toContain("Call failed");
});

it.each([false, true])("keeps a failed doctor report in the slash card (expanded=%s)", expanded => {
  const out = renderCommandOutput({ details: { args: { action: "control", command: "doctor" }, result: {
    ok: false, lines: ["- memory global: unreadable: boom", "- memory repo: active=3 injected=3"],
  } } }, { expanded }, theme).render(240).join("\n");
  expect(out).toContain("issues found");
  expect(out).toContain("memory global: unreadable: boom");
  expect(out).toContain("memory repo: active=3 injected=3");
  expect(out).not.toContain('"ok"');
  expect(out).not.toContain('"lines"');
});

it("shows an unset config value once, without duplicating its unset source", () => {
  const out = body({ action: "control", command: "config" }, { details: { key: "unset.key", source: "unset" } });
  expect(out.trim()).toBe("unset.key: (unset)");
});

it.each(["queued", "broker-accepted"])("keeps %s message notes neutral through host dispatch", delivery => {
  const colored = { ...theme, fg: (token: string, text: string) => token === "error" ? `\x1b[31m${text}\x1b[39m` : text };
  const out = body({ action: "message", to: "peer", message: "ping" }, {
    details: { delivered: false, delivery, queued: true, error: "Recipient offline. Retry later." }, content: [],
  }, false, colored);
  expect(out).toContain("│ Recipient offline. Retry later.");
  expect(out).not.toContain("✗");
  expect(out).not.toContain("\x1b[31m");
});

it.each([false, true])("keeps a legacy queued note neutral through host dispatch (expanded=%s)", expanded => {
  const colored = { ...theme, fg: (token: string, text: string) => token === "error" ? `\x1b[31m${text}\x1b[39m` : text };
  const out = body({ action: "message", to: "peer", message: "ping" }, {
    details: { delivered: false, queued: true, error: "Recipient offline. Retry later." }, content: [],
  }, expanded, colored);
  expect(out).toContain("│ Recipient offline. Retry later.");
  expect(out).not.toContain("\x1b[31mRecipient offline.");
  expect(out).toContain("peer");
  expect(out).toContain("ping");
});

it.each([false, true])("forwards explicit command error flags for bare details (expanded=%s)", expanded => {
  const render = (isError: boolean) => renderCommandOutput({ details: {
    args: { action: "exec", code: "fixture" },
    result: { text: "Execution refused by policy", details: {}, isError },
  } }, { expanded }, theme).render(240).join("\n");
  const failed = render(true);
  expect(failed).toContain("✗ Execution refused by policy");
  expect(failed).not.toContain("exit 0");
  const succeeded = render(false);
  expect(succeeded).toContain("exit 0");
  expect(succeeded).not.toContain("✗");
  expect(succeeded).not.toContain("Execution refused by policy");
});

it.each([80, 240])("preserves the cap headline at width %i through host's outer fit boundary", width => {
  const headline = "Not stored: global memory is full (7,952 of 8,000 chars used). This entry is 470 chars; free at least 422.";
  const out = renderSpiderResult({ details: {}, content: [{ type: "text", text: headline + "\nHelp is expanded only." }] }, { expanded: false }, theme, { args: { action: "remember" }, isError: true }).render(width);
  expect(out.join(" ").replace(/\s+/g, " ").trim()).toBe(`✗ ${headline}`);
});
