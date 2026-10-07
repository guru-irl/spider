import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const theme = readFileSync(new URL("../web/theme.css", import.meta.url), "utf8");
const detail = readFileSync(new URL("../web/detail.css", import.meta.url), "utf8");
const css = theme + "\n" + detail;
// Same fail-closed contrast/decoration algorithm as Task 5b, applied to the consumer's complete CSS.
function luminance(hex: string): number {
  const rgb = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
function contrast(a: string, b: string): number { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
function blocks(source: string) { return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selector: match[1]!.trim(), body: match[2]! })); }
function rule(selector: string): string {
  const matches = blocks(css).filter(block => block.selector.split(",").map(value => value.trim()).includes(selector));
  expect(matches, `exactly one rule for ${selector}`).toHaveLength(1); return matches[0]!.body;
}
function textContrastFailures(source: string): string[] {
  const palette = Object.fromEntries([...source.matchAll(/--([\w-]+):\s*(#[\da-f]{6})\s*;/gi)].map(match => [match[1]!, match[2]!]));
  const failures: string[] = [];
  const resolve = (value: string) => {
    const token = value.trim().match(/^var\(--([\w-]+)\)$/)?.[1];
    const hex = token ? palette[token] : value.trim();
    return hex && /^#[\da-f]{6}$/i.test(hex) ? hex : undefined;
  };
  for (const block of blocks(source)) {
    const backgrounds = [...block.body.matchAll(/(?:^|;)\s*background(?:-color)?:\s*([^;}]+)/g)].map(match => match[1]!.trim());
    for (const declaration of block.body.matchAll(/(?:^|;)\s*(color|fill):\s*([^;}]+)/g)) {
      if (declaration[1] === "fill" && block.selector === ".chart-dot") continue;
      const value = declaration[2]!.trim();
      if (value === "inherit" || value === "currentColor") continue; // checked at the inherited source
      const hex = resolve(value);
      if (!hex) { failures.push(`Unresolved text color: ${value}`); continue; }
      // Explicit rule-local backgrounds win. Otherwise check every dashboard surface.
      const surfaces = backgrounds.length ? backgrounds : ["bg", "surface", "raised"];
      for (const surface of surfaces) {
        const background = backgrounds.length ? resolve(surface) : palette[surface];
        if (!background) failures.push(`Unresolved background: ${surface}`);
        else if (contrast(hex, background) < 4.5) failures.push(`${value} on ${surface}`);
      }
    }
  }
  return failures;
}
function decorationFailures(source: string): string[] {
  return [...source.matchAll(/(?:^|[;{])\s*((?:outline|border)(?:-[a-z-]+)?|box-shadow|text-shadow):\s*([^;}]+)/g)]
    .filter(match => !["border-radius", "border-collapse", "border-spacing"].includes(match[1]!) && !/^(?:none|0)(?:\s*!important)?$/.test(match[2]!.trim()))
    .map(match => `${match[1]}: ${match[2]!.trim()}`);
}
describe("Detail consumer theme", () => {
  it("every text/fill override meets AA against its own background or all dashboard surfaces", () => {
    expect(textContrastFailures(css)).toEqual([]);
    for (const bad of ["color: #6272a4", "color: var(--text-secondary); background: var(--text)", "fill: #44475a", "color: var(--text-secondary); background-color: var(--text)"]) {
      expect(textContrastFailures(css + `\n@media (max-width: 500px) { .detail-view .action { ${bad}; } }`), bad).not.toEqual([]);
    }
  });
  it("consumer rules add no decorations or overrides of shared control states", () => {
    expect(decorationFailures(css)).toEqual([]);
    for (const bad of ["border-bottom: 2px solid", "outline-style: solid", "outline-width: 2px", "text-shadow: 0 0 4px #000000", "box-shadow: 0 0 4px #000000"]) {
      expect(decorationFailures(css + `\n.detail-view .action { ${bad}; }`)).not.toEqual([]);
    }
    expect(detail).not.toMatch(/opacity:|gradient|\.action|button|aria-pressed|aria-disabled|:focus|:hover/);
    for (const selector of ['button:disabled', 'button[aria-disabled="true"]', '.action:disabled', '.action[aria-disabled="true"]']) {
      const style = rule(selector); expect(style).toContain("color: var(--text-secondary)"); expect(style).not.toMatch(/opacity:/);
      if (selector.startsWith("button")) expect(style).toContain("cursor: default");
      else expect(style).toContain("background: var(--raised)");
    }
    const selected = rule('.action[aria-pressed="true"]'); expect(selected).toContain("background: var(--text)"); expect(selected).toContain("color: var(--bg)");
    const focus = rule('.action[aria-pressed]:focus-visible:not(:disabled):not([aria-disabled="true"])');
    expect(focus).toContain("text-decoration: underline 2px"); expect(focus).toContain("text-underline-offset: 3px"); expect(focus).not.toMatch(/background|color|outline|border|shadow/);
    for (const block of blocks(css).filter(b => /:hover|:focus-visible/.test(b.selector) && /\.action|button/.test(b.selector))) {
      if (block.selector === '.action[aria-disabled="true"]:focus-visible') {
        expect(block.body).toContain("text-decoration: underline 2px"); expect(block.body).not.toMatch(/background|color|cursor|outline|border|shadow/);
      } else { expect(block.selector).toContain(":not(:disabled)"); expect(block.selector).toContain(':not([aria-disabled="true"])'); }
    }
  });
});
