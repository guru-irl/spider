import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const css = readFileSync(new URL("../web/theme.css", import.meta.url), "utf8");
function blocks(source: string) { return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selector: match[1]!.trim(), body: match[2]! })); }
function rule(selector: string): string {
  const matches = blocks(css).filter(block => block.selector.split(",").map(value => value.trim()).includes(selector));
  expect(matches.length, `at least one rule for ${selector}`).toBeGreaterThan(0); return matches.map(block => block.body).join(";");
}
const aliases = [
  ["Fira Sans", 400], ["Fira Sans Regular", 400], ["FiraSans-Regular", 400],
  ["Fira Sans Medium", 500], ["FiraSans-Medium", 500],
  ["Fira Sans SemiBold", 600], ["FiraSans-SemiBold", 600],
  ["Fira Sans Bold", 700], ["FiraSans-Bold", 700],
  ["Cascadia Code", 400], ["Cascadia Code Regular", 400], ["CascadiaCode-Regular", 400],
  ["Cascadia Code NF", 400], ["Cascadia Code NF Regular", 400], ["CascadiaCodeNF-Regular", 400], ["Cascadia Mono", 400],
  ["Cascadia Code Bold", 700], ["CascadiaCode-Bold", 700], ["Cascadia Code NF Bold", 700], ["CascadiaCodeNF-Bold", 700],
] as const;
describe("web theme", () => {
  it("disabled buttons and pills use secondary text, default cursor and no hover changes", () => {
    for (const selector of ["button:disabled", "button[aria-disabled=true]"]) {
      const style = rule(selector); expect(style).toContain("color:var(--usage-muted)"); expect(style).toContain("cursor:default"); expect(style).not.toMatch(/opacity:/);
    }
    for (const block of blocks(css).filter(block => /button.*:hover/.test(block.selector))) {
      expect(block.selector).toContain(":not(:disabled)"); expect(block.selector).toContain(":not([aria-disabled=true])");
    }
  });
  it("font aliases carry their actual weights and NF fallback entries", () => {
    const faces = blocks(css).filter(block => block.selector === "@font-face").map(block => block.body);
    for (const [alias, weight] of aliases) {
      const face = faces.filter(body => body.includes(`local('${alias}')`)); expect(face, alias).toHaveLength(1); expect(face[0]).toMatch(new RegExp(`font-weight:(?:${weight}|400 700)(?:;|})`));
    }
    const code = rule(":root").match(/--usage-code:([^;]+);/)![1]!;
    expect(code).toContain("'Usage Code Local'"); expect(code).toContain("'Cascadia Code'");
  });
  it("unused axis and unreachable cell focus styles are removed", () => {
    expect(css).not.toContain("--axis-accent"); expect(css).not.toMatch(/(?:td|tr):focus-visible/); expect(css).not.toContain(".action:hover:not(:disabled)");
    expect(blocks(css).some(block => block.selector === "@font-face" && block.body.includes("local('Fira Sans Bold')") && /font-weight:(?:700|400 700);/.test(block.body))).toBe(true);
  });
  it("local faces include full and PostScript names", () => {
    for (const [name] of aliases) expect(css).toContain(`local('${name}')`);
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
