// Phase 8: exec/exec_file/batch + index results route through the bespoke
// @spider/ui renderers (not the raw text fallback). Uses an identity theme.
import { describe, it, expect } from "vitest";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { renderSpiderResult } from "../render-result";

const theme = {
  fg: (_t: string, s: string) => s,
  bg: (_t: string, s: string) => s,
  bold: (s: string) => s,
  italic: (s: string) => s,
};

function lines(action: string, details: unknown, args: Record<string, unknown> = {}): string[] {
  const comp = renderSpiderResult({ details }, { expanded: true }, theme, { args: { action, ...args } });
  return comp.render(80);
}

describe("render-result exec/index wiring (Phase 8)", () => {
  it("preserves the themed tool-shell background across expanded row padding", () => {
    const colored = {
      ...theme,
      fg: (_token: string, text: string) => `\x1b[38;5;177m${text}\x1b[39m`,
      bg: (_token: string, text: string) => `\x1b[48;5;160m${text}\x1b[49m`,
    };
    const box = new Box(1, 1, (text) => colored.bg("toolSuccessBg", text));
    const result = renderSpiderResult({ details: { stdout: "short", exitCode: 0 } },
      { expanded: true }, colored, { args: { action: "exec", code: "echo short" } });
    box.addChild({ render: (width) => result.render(width), invalidate: () => result.invalidate?.() });
    const rows = box.render(80);
    expect(rows.some((row) => /\x1b\[0m +\x1b\[49m/.test(row))).toBe(false);
    expect(rows.some((row) => row.includes("\x1b[48;5;160m") && row.includes("short"))).toBe(true);
  });

  it("keeps collapsed truncation markers for run, fallback, and memory forget", () => {
    const x = "x".repeat(200);
    const render = (result: unknown, args: Record<string, unknown>) =>
      renderSpiderResult(result, { expanded: false }, theme, { args }).render(80);
    const run = render({ details: { run: { status: "done", task: x, result: x } } }, { action: "run" });
    const fallback = render({ content: [{ type: "text", text: x }] }, { action: "unknown" });
    const forget = render({ details: { ok: true, removed: { status: "archived" }, uuid: x } },
      { action: "control", command: "memory", sub: "forget" });
    const visible = (row: string) => row.replace(/\x1b\[[0-9;]*m/g, "");
    for (const [name, rows] of [["run", run], ["fallback", fallback], ["forget", forget]] as const) {
      expect(rows.every((row) => visibleWidth(row) <= 80), name).toBe(true);
      expect(rows.some((row) => visible(row).endsWith("…")), name).toBe(true);
    }
    expect(run.filter((row) => visible(row).endsWith("…"))).toHaveLength(2);
    expect(run.filter((row) => visible(row).endsWith("…")).map((row) => visible(row))).toEqual([
      "     ↳ " + "x".repeat(72) + "…",
      "     ⤴ " + "x".repeat(72) + "…",
    ]);
    expect(fallback.map(visible)).toEqual(["x".repeat(79) + "…"]);
    expect(visible(forget.at(-1) ?? "")).toBe(" " + "x".repeat(78) + "…");
  });

  it.each([
    ["models set", { ok: true, role: "worker", ref: "x".repeat(200) }, { command: "models" }, "● set worker → "],
    ["models cleared", { ok: true, cleared: true, role: "x".repeat(200) }, { command: "models" }, "● clear "],
    ["models shadow", { ok: true, role: "worker", ref: "ok", shadowedBy: { ref: "x".repeat(200), file: "local" } }, { command: "models" }, "This worktree overrides it with "],
    ["config set", { ok: true, key: "option", value: "x".repeat(200) }, { command: "config" }, "● set option → "],
    ["config errors", { config: {}, errors: ["x".repeat(200)] }, { command: "config" }, "x"],
    ["memory status header", { entries: [{ category: "insight", uuid: "x".repeat(200) }] }, { command: "memory", sub: "status" }, " ◆ [insight] "],
  ] as const)("collapsed %s ends at width 80 with an ellipsis", (_name, details, args, prefix) => {
    const rows = renderSpiderResult({ details }, { expanded: false }, theme,
      { args: { action: "control", ...args } }).render(80);
    const row = rows.find((line) => line.startsWith(prefix));
    expect(row).toBeDefined();
    expect(visibleWidth(row ?? "")).toBe(80);
    expect((row ?? "").replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/…$/);
  });

  it("strips ANSI escapes from collapsed fallback text", () => {
    const raw = `\x1b[31m${"x".repeat(200)}\x1b[0m`;
    const rows = renderSpiderResult({ content: [{ type: "text", text: raw }] },
      { expanded: false }, theme, { args: { action: "unknown" } }).render(80);
    expect(rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual(["x".repeat(79) + "…"]);
    expect(rows.join("")).not.toContain("\x1b[31m");
  });

  it("applies the outer result boundary to config get in both modes", () => {
    const value = "x".repeat(500);
    const render = (expanded: boolean) => renderSpiderResult({ details: { key: "option", value } },
      { expanded }, theme, { args: { action: "control", command: "config" } }).render(80);
    const full = render(true);
    const short = render(false);
    expect(full.every((row) => visibleWidth(row) <= 80)).toBe(true);
    expect(full.join("")).toContain(value);
    expect(short.every((row) => visibleWidth(row) <= 80)).toBe(true);
    expect(short.at(-1)).toContain("…");
  });
  it("shows the config write destination and a local shadow in the confirmation", () => {
    const out = lines("control", { ok: true, op: "set", key: "ui.footer", value: true, scope: "global", file: "fixture/global/config.json", shadowedBy: "local" }, { command: "config" }).join("\n");
    expect(out).toContain("global");
    expect(out).toContain("fixture/global/config.json");
    expect(out).toMatch(/shadowed by local/i);
  });

  it("labels config unset confirmations as unset", () => {
    const out = lines("control", { ok: true, op: "unset", key: "memory.reviewer.model", scope: "local", file: "fixture/local/config.json" }, { command: "config" }).join("\n");
    expect(out).toContain("unset memory.reviewer.model");
    expect(out).not.toContain("set memory.reviewer.model →");
  });

  it("shows the effective config value's source", () => {
    const out = lines("control", { key: "ui.footer", value: false, source: "local", errors: [] }, { command: "config" }).join("\n");
    expect(out).toContain("false");
    expect(out).toContain("local");
  });

  it("exec routes to the bespoke renderer (✓ exit 0, no duplicated header)", () => {
    const out = lines("exec", { stdout: "one\ntwo\nthree", stderr: "", exitCode: 0, timedOut: false }, { code: "ls -la" }).join("\n");
    expect(out).not.toMatch(/spider exec/);
    expect(out).toContain("✓");
    expect(out).toMatch(/exit 0/);
  });

  it("batch aggregates exit codes and marks failure", () => {
    const out = lines("batch", [
      { stdout: "ok", stderr: "", exitCode: 0, timedOut: false },
      { stdout: "bad", stderr: "boom", exitCode: 1, timedOut: false },
    ]).join("\n");
    expect(out).toContain("✗");
  });

  it("index routes to the bespoke renderer with source + chunk counts", () => {
    const out = lines("index", { source: "docs", chunkCount: 12 }, { path: "docs/x.md" }).join("\n");
    expect(out).not.toMatch(/spider index/);
    expect(out).toMatch(/docs/);
    expect(out).toMatch(/12 chunks/);
  });

  it("message routes to the bespoke renderer (delivered ✓ + target + body)", () => {
    const out = lines("message", { delivered: true }, { to: "peer", message: "ping" }).join("\n");
    expect(out).not.toMatch(/spider (send|message)/);
    expect(out).toContain("✓");
    expect(out).toMatch(/peer/);
    expect(out).toMatch(/ping/);
  });

  it("hangs continuation rows after one exec gutter without losing a long word", () => {
    const payload = "x".repeat(500);
    const rows = lines("exec", { stdout: payload, exitCode: 0 }, { code: "run" });
    const start = rows.findIndex((row) => row.startsWith(" ⎿ x"));
    expect(start).toBeGreaterThanOrEqual(0);
    const output = rows.slice(start);
    expect(output.length).toBeGreaterThan(1);
    expect(output[0].startsWith(" ⎿ x")).toBe(true);
    expect(output.slice(1).every((row) => row.startsWith("   x") && !row.includes("⎿"))).toBe(true);
    expect(output.map((row) => row.slice(3)).join("")).toBe(payload);
  });

  it("expanded exec wraps a 500-character preview without losing content", () => {
    const payload = "x".repeat(500);
    const comp = renderSpiderResult(
      { details: { stdout: payload, exitCode: 0 } },
      { expanded: true }, theme, { args: { action: "exec", code: "echo hi" } },
    );
    const rendered = comp.render(80);
    expect(rendered.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect((rendered.join("").match(/x{2,}/g) ?? []).join("").length).toBe(500);
  });

  it.each([
    ["index", { source: "x".repeat(500), chunkCount: 1 }, { path: "note" }],
    ["message", { delivered: true }, { to: "peer", message: "x".repeat(500) }],
    ["todo", [{ id: 1, text: "x".repeat(500), done: false }], {}],
    ["search", [{ kind: "content", title: "x".repeat(500), snippet: "short" }], {}],
    ["run", { run: { name: "worker", status: "done", result: "x".repeat(500) } }, {}],
    ["control", { ok: true, lines: ["check: " + "x".repeat(500)] }, { command: "doctor" }],
    ["recall", [{ category: "insight", content: "x".repeat(500) }], {}],
    ["control", { ok: true, key: "option", value: "x".repeat(500) }, { command: "config" }],
    ["control", { ok: true, role: "worker", ref: "x".repeat(500) }, { command: "models" }],
    ["control", { entries: [{ category: "insight", content: "x".repeat(500) }] }, { command: "memory", sub: "status" }],
    ["control", { error: "x".repeat(500) }, { command: "doctor" }],
    ["unknown", null, {}],
  ] as const)("expanded %s preserves long fields at width 80 (%#)", (action, details, args) => {
    const result = action === "unknown" ? { content: [{ type: "text", text: "x".repeat(500) }] } : { details };
    const rendered = renderSpiderResult(result, { expanded: true }, theme, { args: { action, ...args } }).render(80);
    expect(rendered.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect((rendered.join("").match(/x{2,}/g) ?? []).join("").length).toBe(500);
  });

  it("keeps a long search snippet dim on every wrapped row", () => {
    const dimTheme = { ...theme, fg: (token: string, text: string) => token === "dim" ? `\x1b[2m${text}\x1b[22m` : text };
    const rows = renderSpiderResult({ details: [{ kind: "content", title: "item", snippet: "x".repeat(180) }] },
      { expanded: true }, dimTheme, { args: { action: "search" } }).render(30);
    const snippet = rows.filter((row) => /^ {5,7}(?:\x1b\[2m)?(?:↳ |x)/.test(row));
    expect(snippet.length).toBeGreaterThan(1);
    expect(snippet.every((row) => row.includes("\x1b[2m"))).toBe(true);
    expect(snippet.slice(1).every((row) => row.replace(/\x1b\[[0-9;]*m/g, "").startsWith("       x"))).toBe(true);
  });

  it.each([
    ["recall", { action: "recall" }],
    ["pending", { action: "control", command: "memory", sub: "pending" }],
  ] as const)("expanded %s hangs continuation under a short category label", (_name, args) => {
    const payload = "x".repeat(180);
    const rows = renderSpiderResult({ details: [{ category: "insight", content: payload, uuid: "record-1" }] },
      { expanded: true }, theme, { args }).render(30);
    const marker = "[insight] ";
    const start = rows.findIndex((row) => row.startsWith(marker));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(rows[start]).toMatch(/^\[insight\] x/);
    expect(rows[start + 1]).toMatch(/^ {10}x/);
    expect(rows.slice(start).every((row) => visibleWidth(row) <= 30)).toBe(true);
  });

  it("expanded run output keeps the output gutter before the payload", () => {
    const rendered = renderSpiderResult({ details: { run: { status: "done", result: "payload" } } },
      { expanded: true }, theme, { args: { action: "run" } }).render(80);
    expect(rendered.some((line) => line.includes("⤴ payload"))).toBe(true);
  });

  it("collapsed exec still shows one shortened preview row", () => {
    const result = { details: { stdout: "x".repeat(500), exitCode: 0 } };
    const rows = renderSpiderResult(result, { expanded: false }, theme, { args: { action: "exec", code: "echo hi" } }).render(80);
    expect(rows.filter((line) => /x{2,}/.test(line))).toHaveLength(1);
    expect((rows.join("").match(/x{2,}/g) ?? []).join("").length).toBeLessThan(500);
  });

  it("expanded message keeps every error line beyond the collapsed cap", () => {
    const error = "e".repeat(1600) + "error15";
    const rendered = renderSpiderResult({ details: { delivered: false, error } }, { expanded: true }, theme,
      { args: { action: "message", to: "peer", message: "ping" } }).render(80).join("\n");
    expect(rendered).toContain("error15");
  });

  it("expanded exec puts stderr after stdout with a dim stderr label", () => {
    const rows = lines("exec", { stdout: "out-line", stderr: "err-line", exitCode: 1 }, { code: "run" });
    const out = rows.findIndex((row) => row.includes("out-line"));
    const label = rows.findIndex((row) => row.includes("stderr"));
    const err = rows.findIndex((row) => row.includes("err-line"));
    expect(out).toBeGreaterThanOrEqual(0);
    expect(label).toBeGreaterThan(out);
    expect(err).toBeGreaterThan(label);
  });

  it("leaves collapsed stderr hidden as on main", () => {
    const rows = renderSpiderResult({ details: { stdout: "", stderr: "private error", exitCode: 1 } },
      { expanded: false }, theme, { args: { action: "exec", code: "run" } }).render(80);
    expect(rows.join("\n")).toContain("✗ exit 1 · 0 lines");
    expect(rows.join("\n")).not.toContain("stderr");
    expect(rows.join("\n")).not.toContain("private error");
  });

  it("distinguishes the muted stderr separator from output whose text is stderr", () => {
    const styled = { ...theme, fg: (token: string, text: string) => token === "muted" ? `\x1b[2m${text}\x1b[22m` : text };
    const rows = renderSpiderResult({ details: { stdout: "stderr", stderr: "stderr", exitCode: 1 } },
      { expanded: true }, styled, { args: { action: "exec", code: "run" } }).render(80);
    expect(rows.filter((row) => row.includes("stderr"))).toEqual([
      " ⎿ stderr", " \x1b[2m── stderr ──\x1b[22m", " ⎿ stderr",
    ]);
  });

  it("groups each batch command's stdout and stderr in command order", () => {
    const rows = lines("batch", [
      { stdout: "out-1", stderr: "err-1", exitCode: 0 },
      { stdout: "out-2", stderr: "err-2", exitCode: 0 },
      { stdout: "out-3", stderr: "", exitCode: 0 },
    ]).filter((row) => /(?:out-|err-|── stderr ──)/.test(row));
    expect(rows).toEqual([" ⎿ out-1", " ── stderr ──", " ⎿ err-1", " ⎿ out-2", " ── stderr ──", " ⎿ err-2", " ⎿ out-3"]);
  });

  it("discloses when the last exec line is a partial UTF-8 tail", () => {
    const rows = lines("exec", { stdout: "earlier\n" + "界".repeat(20_000), exitCode: 0 }, { code: "run" });
    const output = rows.filter((row) => row.startsWith(" ⎿ 界") || row.startsWith("   界"));
    const text = output.map((row) => row.slice(3)).join("");
    expect(rows.some((row) => row.includes("1 earlier output line hidden"))).toBe(true);
    expect(text).not.toContain("�");
    expect(Buffer.byteLength(text)).toBe(51_198);
    expect(rows.at(-1)).toContain("[Showing last 50.0KB of line 2 (line is 58.6KB)]");
  });

  it("uses plural hidden-line wording when two earlier lines were dropped", () => {
    const stdout = Array.from({ length: 2002 }, (_, i) => `line${i}`).join("\n");
    const rows = lines("exec", { stdout, exitCode: 0 }, { code: "run" });
    expect(rows.join("\n")).toContain("2 earlier output lines hidden");
    expect(rows.join("\n")).not.toContain("2 earlier output line hidden\n");
  });

  it("caps expanded exec at pi's last 2,000 lines or 50 KiB and puts hidden count above output", () => {
    const render = (stdout: string) => lines("exec", { stdout, stderr: "", exitCode: 0 }, { code: "run" });
    const byLines = render(Array.from({ length: 2500 }, (_, i) => `marker${i}`).join("\n"));
    expect(byLines.some((row) => row.includes("marker500"))).toBe(true);
    expect(byLines.some((row) => row.includes("marker499"))).toBe(false);
    expect(byLines.some((row) => row.includes("marker2499"))).toBe(true);
    expect(byLines.findIndex((row) => row.includes("500 earlier"))).toBeLessThan(byLines.findIndex((row) => row.includes("marker500")));
    // Each input row is 51 bytes. A kept row after the first costs one newline byte.
    // Exactly 984 fit, so changing either the cap or newline accounting changes 16.
    const byBytes = render(Array.from({ length: 1000 }, (_, i) => `${"x".repeat(48)}${String(i).padStart(3, "0")}`).join("\n"));
    expect(byBytes.find((row) => row.includes("earlier output lines hidden"))).toContain("16 earlier output lines hidden");
    const output = byBytes.filter((row) => /^ ⎿ x/.test(row));
    expect(output).toHaveLength(984);
    expect(output[0]).toContain("016");
    expect(output.at(-1)).toContain("999");
  });

  it.each(["short", "long"])("caches 10,000 %s-line expanded exec renders by width", (size) => {
    const stdout = Array.from({ length: 10_000 }, (_, i) => `marker${i} ${"x".repeat(size === "long" ? 190 : 2)}`).join("\n");
    const comp = renderSpiderResult({ details: { stdout, exitCode: 0 } }, { expanded: true }, theme,
      { args: { action: "exec", code: "run" } });
    const firstStart = performance.now();
    const rows = comp.render(80);
    const first = performance.now() - firstStart;
    const cachedStart = performance.now();
    for (let i = 0; i < 20; i++) expect(comp.render(80)).toBe(rows);
    const cached = (performance.now() - cachedStart) / 20;
    console.info(`exec ${size}: first ${first.toFixed(2)} ms, cached ${cached.toFixed(3)} ms/render`);
    expect(cached).toBeLessThan(5);
    expect(comp.render(79)).not.toBe(rows);
  });

  it("expanded exec shows all stdout when it fits the pi cap", () => {
    const stdout = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const rendered = renderSpiderResult({ details: { stdout, exitCode: 0 } }, { expanded: true }, theme,
      { args: { action: "exec", code: "print" } }).render(80);
    expect(rendered.join("\n")).not.toContain("earlier output lines hidden");
    expect(rendered.filter((row) => row.startsWith(" ⎿ line"))).toEqual(
      Array.from({ length: 100 }, (_, i) => ` ⎿ line${i}`),
    );
  });

  it("renders a 10,000-line exec result with a bounded tail", () => {
    const stdout = Array.from({ length: 10_000 }, (_, i) => `line${i}`).join("\n");
    const start = performance.now();
    let rows: string[] = [];
    for (let i = 0; i < 20; i++) {
      rows = renderSpiderResult({ details: { stdout, exitCode: 0 } }, { expanded: true }, theme,
        { args: { action: "exec", code: "print" } }).render(80);
    }
    const elapsed = performance.now() - start;
    console.info(`expanded 10,000-line exec: 20 renders ${elapsed.toFixed(2)} ms (${(elapsed / 20).toFixed(2)} ms/render)`);
    expect(rows.join("\n")).toContain("8000 earlier output lines hidden");
    expect(rows.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
  });

  it("every rendered line stays within the width", () => {
    const comp = renderSpiderResult(
      { details: { stdout: "x".repeat(500), stderr: "", exitCode: 0, timedOut: false } },
      { expanded: true }, theme, { args: { action: "exec", code: "echo hi" } },
    );
    for (const l of comp.render(40)) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(40);
    }
  });
});
