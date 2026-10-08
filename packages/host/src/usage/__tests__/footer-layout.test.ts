import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { calibrationFallback } from "../calibration.js";
import { FooterAccumulator } from "../footer-state.js";
import * as pricing from "../price.js";
import { createUsageFooter, renderUsageFooter, type FooterInput } from "../footer.js";

function input(overrides: Partial<FooterInput> = {}): FooterInput {
  return { cwd: "~/src/demo", branch: "main", sessionName: "demo-session", modelId: "gpt-6.1-sol",
    thinking: "high", context: { percent: 14.6, contextWindow: 1000000 }, subscription: true,
    totals: { input: 3700000, output: 4000000, cacheRead: 763000000, cacheWrite: 65000000,
      piCost: 123, aic: 3294, unpricedEntries: 0, aggregateEntries: 1, estimated: true, latestCacheHitRate: 99.3 },
    counter: { availability: "available", snapshot: { creditsUsed: 34, entitlement: 1000, ts: 1234 } },
    statuses: new Map(), ...overrides };
}

describe("usage footer layout", () => {
  it("fits every width 40 to 200", () => {
    const variants = [input(), input({ cwd: "~/very/long/目录/".repeat(8), branch: "feature/".repeat(12),
      sessionName: "研究👩🏽‍💻e\u0301会话".repeat(12), statuses: new Map([["z", "\x1b[31m任务 完成\x1b[0m".repeat(20)], ["a", "first\nstatus"]]) }),
      input({ modelId: null, context: null }), input({ modelId: "界".repeat(250), context: { percent: null, contextWindow: 1000000 } })];
    for (const variant of variants) {
      for (let width = 40; width <= 200; width++) {
        const lines = renderUsageFooter(variant, width);
        for (const line of lines) {
          expect(visibleWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width);
          expect(line).not.toMatch(/[\r\n\t]/);
        }
        expect(lines[0]).toContain("high");
        expect(lines[1]).not.toContain("$");
      }
    }
  });

  it("row one preserves model thinking and name priority", () => {
    const variant = input({ cwd: "/very/long/directory/project", sessionName: "named-session", modelId: "model" });
    const wide = renderUsageFooter(variant, 100)[0];
    expect(wide).toContain("/very/long/directory/project (main) • named-session");
    const narrowCwd = renderUsageFooter(variant, 47)[0];
    expect(narrowCwd).toContain("...");
    expect(narrowCwd).toContain("project (main) • named-session");
    const noBranch = renderUsageFooter(variant, 30)[0];
    expect(noBranch).not.toContain("(main)");
    expect(noBranch).toContain("named-session");
    const shortName = renderUsageFooter(variant, 23)[0];
    expect(shortName).not.toContain("(main)");
    expect(shortName).toContain("named");
    expect(shortName).toContain("...");
    for (const line of [wide, narrowCwd, noBranch, shortName]) expect(line).toMatch(/model · high$/);
    // The narrow user case keeps the named session alongside the full active model.
    expect(renderUsageFooter(input({ sessionName: "session" }), 40)[0]).toContain("session");
  });

  it("shortens pathological models visibly while retaining thinking", () => {
    const row = renderUsageFooter(input({ modelId: "界".repeat(100), thinking: "xhigh" }), 40)[0];
    expect(stripTerminalSequences(row)).toContain("... · xhigh");
    expect(visibleWidth(row)).toBeLessThanOrEqual(40);
  });

  it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])("shows thinking level %s on row one", thinking => {
    expect(renderUsageFooter(input({ thinking }), 40)[0]).toContain(`gpt-6.1-sol · ${thinking}`);
  });

  it("row two drops entire lowest priority items", () => {
    const variant = input();
    const items = ["14.6%/1.0M", "3.3k credits", "CH99.3%", "month 3%", "↑3.7M ↓4.0M", "R763M W65M"];
    for (let retained = items.length; retained > 0; retained--) {
      const expected = items.slice(0, retained).join(" · ");
      expect(renderUsageFooter(variant, visibleWidth(expected))[1]).toBe(expected);
      expect(renderUsageFooter(variant, visibleWidth(expected) - 1)[1]).toBe(items.slice(0, retained - 1).join(" · "));
    }
    expect(renderUsageFooter(variant, 1)[1]).toBe("");
  });

  it("unknown auto state is not claimed", () => {
    expect(renderUsageFooter(input(), 200)[1]).not.toContain("(auto)");
    expect(renderUsageFooter(input({ autoCompaction: true }), 200)[1]).toContain("14.6%/1.0M (auto)");
    expect(renderUsageFooter(input({ autoCompaction: false }), 200)[1]).not.toContain("(auto)");
  });

  it("missing counter is not month zero", () => {
    for (const counter of [
      { availability: "disabled", snapshot: null }, { availability: "unavailable", snapshot: null },
      { availability: "unavailable", snapshot: { creditsUsed: 34, entitlement: 1000, ts: 1234 } },
      { availability: "available", snapshot: null },
      { availability: "available", snapshot: { creditsUsed: 0, ts: 1234 } },
      { availability: "available", snapshot: { creditsUsed: 0, entitlement: 0, ts: 1234 } },
    ] as const) expect(renderUsageFooter(input({ counter }), 200)[1]).not.toContain("month");
    expect(renderUsageFooter(input({ counter: { availability: "available", snapshot: {
      creditsUsed: 0, entitlement: 1000, ts: 1234 } } }), 200)[1]).toContain("month 0%");
  });

  it("absent context matches pi zero while explicit unknown remains unknown", () => {
    expect(renderUsageFooter(input({ context: null }), 200)[1]).toContain("0.0%/0");
    expect(renderUsageFooter(input({ context: { percent: null, contextWindow: 1000000 } }), 200)[1]).toContain("?/1.0M");
  });

  it.each([
    ["off", null, "3.3k credits"], ["uncalibrated", null, "3.3k credits"],
    ["implausible", 2, "3.3k credits"], ["calibrated", 0.56, "1.8k credits"],
  ] as const)("shows corrected credits with %s calibration without basis markers", (status, factor, expected) => {
    const variant = input({ calibration: { ...calibrationFallback(), status, factor } });
    variant.totals.unpricedEntries = 2;
    expect(variant.totals.estimated).toBe(true);
    const rendered = renderUsageFooter(variant, 200)[1];
    expect(rendered).toContain(expected);
    if (status === "calibrated") expect(rendered).not.toContain("~");
    expect(renderUsageFooter({ ...variant, subscription: false }, 200)[1]).toBe(rendered);
    variant.totals.estimated = false;
    variant.totals.aggregateEntries = 0;
    expect(renderUsageFooter(variant, 200)[1]).toBe(rendered);
  });

  it("retains nonzero fractional AIC rather than presenting estimated zero", () => {
    const variant = input();
    variant.totals.aic = 0.0323;
    expect(renderUsageFooter(variant, 200)[1]).toContain("<0.1 credits");
  });

  it.each([
    [0, "0.0", "0.0"], [0.04, "<0.1", "0.0"], [0.0323, "<0.1", "0.0"],
    [4.24, "4.2", "4.2"], [9.94, "9.9", "9.9"], [9.96, "10", "9.9"],
    [9.999999, "10", "9.9"], [99.999999, "100", "99"],
    [84.375, "84", "84"], [84.6, "85", "84"], [3294.4, "3.3k", "3.3k"],
    [1234567.891, "1.2M", "1.2M"],
  ])("formats %s credits without exposing lower-bound markers", (aic, rounded, lowerBound) => {
    for (const unpricedEntries of [0, 1]) {
      const variant = input();
      variant.totals.aic = aic;
      variant.totals.unpricedEntries = unpricedEntries;
      expect(renderUsageFooter(variant, 200)[1].split(" · ")[1]).toBe(`${rounded} credits`);
    }
  });

  it("gives a one-cell cwd stub and separator back to the session name", () => {
    for (const thinking of ["off", "minimal", "high", "max"]) {
      const row = renderUsageFooter(input({ cwd: "~/src/some/deep/project",
        sessionName: "my long session name here", thinking }), 40)[0];
      expect(stripTerminalSequences(row)).toMatch(/^my long session/);
      expect(row).not.toContain(" • ");
      expect(row).toContain(`gpt-6.1-sol · ${thinking}`);
    }
  });

  it("never shows a dot-only cwd stub across widths 40 to 80", () => {
    for (const cwd of ["~/src/some/deep/project", "~/src/目录/界界", "~/src/demo/👩🏽‍💻"]) {
      for (const sessionName of [null, "my long session name here"]) {
        for (const branch of [null, "main", "feature/long-branch-name"]) {
          for (let width = 40; width <= 80; width++) {
            const row = renderUsageFooter(input({ cwd, sessionName, branch }), width)[0];
            expect(row, `width ${width}, cwd ${cwd}, name ${sessionName}, branch ${branch}`)
              .not.toMatch(/^\.{1,3}(?: \(| •| |$)/);
            expect(visibleWidth(row)).toBeLessThanOrEqual(width);
            expect(row).toMatch(/ gpt-6\.1-sol · high$/);
          }
        }
      }
    }
  });

  it("returns the dot-only cwd budget and separator to the session name", () => {
    for (const width of [48, 49, 50]) {
      const row = renderUsageFooter(input({ cwd: "~/src/some/deep/project", branch: null,
        sessionName: "my long session name here" }), width)[0];
      expect(row).toMatch(/^my long session name here +gpt-6\.1-sol · high$/);
      expect(visibleWidth(row)).toBe(width);
    }
  });

  it("drops the branch to recover useful cwd characters before dropping cwd", () => {
    for (const width of [47, 48, 49]) {
      const row = renderUsageFooter(input({ cwd: "~/src/some/deep/project", sessionName: null,
        branch: "feature/long-branch-name" }), width)[0];
      expect(row).toMatch(/^~\/src\/some\/deep\/project +gpt-6\.1-sol · high$/);
      expect(row).not.toContain("(feature/");
    }
    for (const [width, tail] of [[56, "...roject"], [57, "...project"]] as const) {
      const row = renderUsageFooter(input({ cwd: "~/src/some/deep/project",
        sessionName: "my long session name here" }), width)[0];
      expect(row).toContain(`${tail} • my long session name here`);
      expect(row).not.toContain("(main)");
    }
  });

  it("retains the cwd once truncation can show a real character", () => {
    const row = renderUsageFooter(input({ cwd: "~/src/some/deep/project", branch: null,
      sessionName: "my long session name here" }), 51)[0];
    expect(row).toBe("...t • my long session name here gpt-6.1-sol · high");
  });

  it("omits an unnamed cwd rather than overflowing with an unclipped ellipsis at tiny widths", () => {
    for (const cwd of ["~/src/some/deep/project", "~/src/目录/界界", "~/src/demo/👩🏽‍💻"]) {
      const variant = input({ cwd, sessionName: null, branch: "feature/long-branch-name" });
      for (let width = 0; width < 40; width++) {
        const lines = renderUsageFooter(variant, width);
        for (const line of lines) expect(visibleWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width);
        expect(lines[0]).not.toMatch(/^\.{1,3}(?: \(| •| |$)/);
      }
    }
  });

  it("retains a short cwd that fits whole instead of treating it as a stub", () => {
    for (const cwd of ["~", "ab", "abc"]) {
      for (const branch of [null, "main", "feature/long-branch-name"]) {
        const row = renderUsageFooter(input({ cwd, branch, sessionName: "my long session name here" }), 51)[0];
        expect(row).toMatch(new RegExp(`^${cwd} • my long session name here +gpt-6\\.1-sol · high$`));
      }
    }
  });

  it("fits an unnamed session with a long branch across widths 40 to 200", () => {
    const variant = input({ cwd: "~/src/some/deep/project", sessionName: null,
      branch: "feature/long-branch-name" });
    for (let width = 40; width <= 200; width++) {
      const lines = renderUsageFooter(variant, width);
      for (const line of lines) expect(visibleWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width);
      expect(lines[0]).toMatch(/ gpt-6\.1-sol · high$/);
      expect(lines[0]).not.toContain(" • ");
    }
  });

  it.each([[100, "10"], [70, "7.0"], [30, "3.0"]])("does not floor %s accumulated tenths below their display boundary", (entries, expected) => {
    const variant = input();
    variant.totals.aic = Array.from({ length: entries }, () => 0.1).reduce((sum, value) => sum + value, 0);
    variant.totals.unpricedEntries = 1;
    expect(renderUsageFooter(variant, 200)[1]).toContain(`${expected} credits`);
  });

  it("hides CH for a cache-less session even when the latest ratio is zero", () => {
    const variant = input();
    Object.assign(variant.totals, { cacheRead: 0, cacheWrite: 0, latestCacheHitRate: 0 });
    expect(renderUsageFooter(variant, 200)[1]).not.toContain("CH");
    variant.totals.cacheWrite = 1;
    expect(renderUsageFooter(variant, 200)[1]).toContain("CH0.0%");
  });

  it("uses pi-tui ANSI-aware widths and ASCII truncation for footer text", () => {
    // Truncation resets styles internally; the footer must reapply them per segment.
    const text = "\x1b[31m界界abcdef\x1b[0m";
    expect(visibleWidth(text)).toBe(10);
    const shortened = truncateToWidth(text, 7, "...");
    expect(stripTerminalSequences(shortened)).toBe("界界...");
    expect(visibleWidth(shortened)).toBe(7);
    const status = renderUsageFooter(input({ statuses: new Map([["a", text]]) }), 7)[2];
    expect(stripTerminalSequences(status)).toBe("界界...");
    expect(visibleWidth(status)).toBe(7);
  });

  it("status row is retained in pi key order with ANSI-aware truncation", () => {
    const statuses = new Map([["z-last", "\x1b[31m尾部\x1b[0m"], ["a-first", "first\nstatus"], ["middle", "middle"]]);
    const lines = renderUsageFooter(input({ statuses }), 200);
    expect(stripTerminalSequences(lines[2])).toBe("first status middle 尾部");
    const long = renderUsageFooter(input({ statuses: new Map([["a", "\x1b[31m界\x1b[0m".repeat(60)]]) }), 40)[2];
    expect(visibleWidth(long)).toBeLessThanOrEqual(40);
    expect(stripTerminalSequences(long)).toContain("...");
    expect(long.replace(/\x1b\[[0-9;]*m/g, "")).not.toContain("\x1b");
    expect(renderUsageFooter(input(), 40)).toHaveLength(2);
  });
});

describe("public usage footer component", () => {
  function themed(variant: FooterInput) {
    const provider: ReadonlyFooterDataProvider = { getGitBranch: () => variant.branch,
      getExtensionStatuses: () => variant.statuses, getAvailableProviderCount: () => 1,
      onBranchChange: () => () => {} };
    const theme = { fg: (key: string, text: string) =>
      `${key === "warning" ? "\x1b[33m" : key === "error" ? "\x1b[31m" : "\x1b[2m"}${text}\x1b[0m` } as Theme;
    return createUsageFooter(() => variant, theme, provider, () => {});
  }

  it("keeps model and thinking dim after name or model truncation", () => {
    const component = themed(input({ cwd: "~/src/some/deep/project", sessionName: "my long session name here" }));
    try {
      const row = component.render(40)[0];
      expect(row).toContain("\x1b[2m...");
      expect(row).toContain("\x1b[2mgpt-6.1-sol");
      expect(row).toContain("\x1b[2m · high");
    } finally { component.dispose(); }
    const longModel = themed(input({ modelId: "model".repeat(30) }));
    try {
      const row = longModel.render(40)[0];
      expect(row).toContain("\x1b[2m...");
      expect(row).toContain("\x1b[2m · high");
    } finally { longModel.dispose(); }
  });

  it.each([[70, "\x1b[2m"], [70.1, "\x1b[33m"], [90, "\x1b[33m"], [90.1, "\x1b[31m"]])
    ("colours context at %s percent without colouring credits", (percent, color) => {
      const component = themed(input({ context: { percent, contextWindow: 1000000 } }));
      try {
        expect(component.render(200)[1]).toContain(`${color}${percent.toFixed(1)}%/1.0M\x1b[0m`);
        expect(component.render(200)[1]).toContain("\x1b[2m3.3k credits\x1b[0m");
      } finally { component.dispose(); }
    });

  it("reads branch and statuses live, themes at render, and releases its subscription", () => {
    let branch = "live-branch";
    let listener: (() => void) | undefined;
    const unsubscribe = vi.fn(() => { listener = undefined; });
    const provider: ReadonlyFooterDataProvider = { getGitBranch: () => branch,
      getExtensionStatuses: () => new Map([["test", "live-status"]]), getAvailableProviderCount: () => 1,
      onBranchChange: callback => { listener = callback; return unsubscribe; } };
    let color = "\x1b[31m";
    const theme = { fg: (_key: string, text: string) => `${color}${text}\x1b[0m` } as Theme;
    const requestRender = vi.fn();
    const component = createUsageFooter(() => input(), theme, provider, requestRender);
    expect(stripTerminalSequences(component.render(100)[0])).toContain("(live-branch)");
    expect(stripTerminalSequences(component.render(100)[2])).toBe("live-status");
    branch = "changed";
    listener?.();
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(stripTerminalSequences(component.render(100)[0])).toContain("(changed)");
    color = "\x1b[32m";
    component.invalidate();
    expect(component.render(100)[0]).toContain("\x1b[32m");
    component.dispose();
    component.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(listener).toBeUndefined();
  });

  it("render and invalidate never reprice session history", () => {
    const spy = vi.spyOn(pricing, "priceCall");
    try {
      const totals = new FooterAccumulator();
      totals.append([{ type: "usage", kind: "cache_warm", timestamp: "2026-10-02T00:00:00.000Z",
        provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
      const provider: ReadonlyFooterDataProvider = { getGitBranch: () => null,
        getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} };
      const component = createUsageFooter(() => input({ totals: totals.snapshot() }),
        { fg: (_key: string, text: string) => text } as Theme, provider, () => {});
      for (let i = 0; i < 20; i++) { component.invalidate(); component.render(40 + i); }
      expect(spy).toHaveBeenCalledTimes(1);
      component.dispose();
    } finally { spy.mockRestore(); }
  });
});

it.each([["calibrated",0.56,"1.8k"],["uncalibrated",null,"3.3k"],["implausible",2,"3.3k"],["off",null,"3.3k"]] as const)("footer %s credits fit forty to two hundred columns",(status,factor,amount)=>{
 const variant=input({calibration:{...calibrationFallback(),status,factor}});
 for(let width=40;width<=200;width++){
  const lines=renderUsageFooter(variant,width);for(const line of lines)expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  expect(lines[1]).toContain(`${amount} credits`);expect(lines[1]!.split(" · ")[1]).not.toMatch(/AIC|cal|est|[~+?]/);
 }
 variant.totals.unpricedEntries=1;expect(renderUsageFooter(variant,80)[1]).toContain(`${amount} credits`);
});


it("context comes first and credit copy is plain with budget before allowance",()=>{
 const variant=input({context:{percent:45.2,contextWindow:200000},monthlyBudget:200,monthUsed:48});variant.totals.aic=1200;
 const line=renderUsageFooter(variant,200)[1]!;expect(line).toMatch(/^45.2%\/200k · 1.2k credits · CH99.3% · month 24% · ↑/);
 expect(line.split(" · ")[1]).not.toMatch(/AIC|cal|est|[~+?]/);
 expect(renderUsageFooter({...variant,monthUsed:49},200)[1]).toContain("month 25%");
 expect(renderUsageFooter({...variant,monthlyBudget:undefined,counter:{availability:"available",snapshot:{creditsUsed:48,entitlement:400,ts:1}}},200)[1]).toContain("month 12%");
 expect(renderUsageFooter({...variant,counter:{availability:"unavailable",snapshot:null}},200)[1]).toContain("month 24%");
 for(const monthUsed of [null,NaN,Infinity])expect(renderUsageFooter({...variant,monthUsed},200)[1]).not.toContain("month");
});

it.each([[999.96,"1.0k"],[9999.6,"10k"],[999500,"1.0M"],[999999,"1.0M"]])("credits choose units after rounding %s",(count,want)=>{
 const variant=input();variant.totals={...variant.totals,aic:count};
 expect(renderUsageFooter(variant,200)[1]).toContain(`${want} credits`);
});
