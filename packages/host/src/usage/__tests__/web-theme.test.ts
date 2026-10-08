import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const css = readFileSync(new URL("../web/theme.css", import.meta.url), "utf8");
function blocks(source: string) { return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selector: match[1]!.trim(), body: match[2]! })); }
function rule(selector: string): string {
  const matches = blocks(css).filter(block => block.selector.split(",").map(value => value.trim()).includes(selector));
  expect(matches.length, `at least one rule for ${selector}`).toBeGreaterThan(0); return matches.map(block => block.body).join(";");
}
describe("web theme", () => {
  it("disabled buttons and pills use secondary text, default cursor and no hover changes", () => {
    for (const selector of ["button:disabled", "button[aria-disabled=true]"]) {
      const style = rule(selector); expect(style).toContain("color:var(--usage-muted)"); expect(style).toContain("cursor:default"); expect(style).not.toMatch(/opacity:/);
    }
    for (const block of blocks(css).filter(block => /button.*:hover/.test(block.selector))) {
      expect(block.selector).toContain(":not(:disabled)"); expect(block.selector).toContain(":not([aria-disabled=true])");
    }
  });
  it("installed font stacks precede separately named remote faces and safe named fallbacks", () => {
    const root = rule(":root");
    expect(root).toContain("--usage-text:'Fira Sans','Usage Text Remote',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;");
    expect(root).toContain("--usage-code:'Cascadia Code','Usage Code Remote',Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace;");
    expect(root).toContain("--usage-wordmark:'Bebas Neue','Usage Wordmark Remote',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;");
    expect(css).not.toMatch(/local\(|@font-face/);
  });
  it("unused axis and unreachable cell focus styles are removed", () => {
    expect(css).not.toContain("--axis-accent"); expect(css).not.toMatch(/(?:td|tr):focus-visible/); expect(css).not.toContain(".action:hover:not(:disabled)");
  });
  it("shared fact and stat chips use the approved compact summary grammar", () => {
    for (const selector of [".fact-chip", ".stat-chip"]) {
      const style = rule(selector); expect(style).toContain("border:1px solid var(--usage-border)"); expect(style).toContain("border-radius:999px"); expect(style).toContain("padding:7px 12px"); expect(style).toContain("min-height:36px");
    }
    expect(rule(".fact-chip")).toContain("color:var(--usage-muted)");
    expect(rule(".stat-chip>span")).toContain("color:var(--usage-muted)");
    expect(rule(".stat-chip strong.mono")).toContain("font-family:var(--usage-code)");
    expect(rule(".summary-chips .stat-chip")).toContain("padding:5px 10px"); expect(rule(".summary-chips .stat-chip")).toContain("min-height:30px");
    expect(rule(".chip-row")).toContain("display:flex");
  });
});

it("counter legend and bars use a neutral colour outside the model palette", () => {
  const calibration = readFileSync(new URL("../web/calibration.css", import.meta.url), "utf8");
  for (const selector of [".calibration-page .counter-key::before", ".calibration-page .counter-bar"]) {
    const body = blocks(calibration).find(block => block.selector === selector)!.body;
    expect(body).toMatch(/(?:background|fill):var\(--usage-muted\)/);
    expect(body).not.toContain("--usage-model-");
  }
});
