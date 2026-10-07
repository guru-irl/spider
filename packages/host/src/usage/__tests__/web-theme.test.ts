import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const css = readFileSync(new URL("../web/theme.css", import.meta.url), "utf8");
const colors = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[\da-f]{6})\s*;/gi)].map(match => [match[1]!, match[2]!]));
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
describe("web theme", () => {
  it("contrast guards check same-rule backgrounds, SVG labels and every override", () => {
    expect(textContrastFailures(css + "\n.notice { color: var(--text-secondary); background: var(--text); }" )).not.toEqual([]);
    expect(textContrastFailures(css + "\n.pivot-label { fill: #44475a; }" )).not.toEqual([]);
    expect(textContrastFailures(css + "\n@media (max-width: 500px) { .notice { color: var(--text-secondary); background-color: var(--text); } }" )).not.toEqual([]);
    expect(textContrastFailures(css + "\n.muted { color: var(--text); }\n.muted { color: #44475a; }" )).not.toEqual([]);
    for (const declaration of ["border-bottom: 2px solid", "outline-style: solid", "outline-width: 2px", "box-shadow: 0 0 4px #000000"]) {
      expect(decorationFailures(css + `\n.action { ${declaration}; }`)).not.toEqual([]);
    }
  });
  it("disabled buttons and pills use secondary text, default cursor and no hover changes", () => {
    for (const selector of ['button:disabled', 'button[aria-disabled="true"]']) {
      const style = rule(selector); expect(style).toContain("color: var(--text-secondary)"); expect(style).toContain("cursor: default");
      expect(style).not.toMatch(/opacity:/);
    }
    for (const selector of ['.action:disabled', '.action[aria-disabled="true"]']) {
      expect(rule(selector)).toContain("background: var(--raised)"); expect(rule(selector)).toContain("color: var(--text-secondary)");
    }
    for (const block of blocks(css).filter(block => /:hover|:focus-visible/.test(block.selector) && /\.action|button/.test(block.selector))) {
      if (block.selector === '.action[aria-disabled="true"]:focus-visible') {
        expect(block.body).toContain("text-decoration: underline 2px"); expect(block.body).not.toMatch(/background|color|cursor|outline|border|shadow/);
      } else { expect(block.selector).toContain(":not(:disabled)"); expect(block.selector).toContain(':not([aria-disabled="true"])'); }
    }
    expect(rule(".chart-zero-line")).toContain("stroke: var(--text-secondary)");
  });
  it("font aliases carry their actual weights and NF fallback entries", () => {
    const faces = blocks(css).filter(block => block.selector === "@font-face").map(block => block.body);
    for (const [alias, weight] of [["Google Sans Flex Regular", 400], ["Google Sans Flex Medium", 500], ["Google Sans Flex SemiBold", 600], ["Cascadia Code Regular", 400], ["Cascadia Code Bold", 700], ["Cascadia Code NF Bold", 700], ["CascadiaCodeNF-Bold", 700]] as const) {
      const face = faces.filter(body => body.includes(`local("${alias}")`)); expect(face).toHaveLength(1); expect(face[0]).toMatch(new RegExp(`font-weight: ${weight};`));
    }
    const textBold = faces.find(body => body.includes('local("Google Sans Flex Bold")') && /font-weight: 700;/.test(body)); expect(textBold).toBeDefined();
    const dataFace = rule(":root").match(/--data-face:([^;]+);/)![1]!;
    for (const alias of ['"Cascadia Code NF"', '"CascadiaCodeNF-Regular"']) expect(dataFace).toContain(alias);
  });

  it("every text color declaration, literal or variable, meets AA on every surface", () => {
    expect(textContrastFailures(css)).toEqual([]);
    expect(textContrastFailures(css + "\n.muted { color: #6272a4; }")).toContain("#6272a4 on raised");
    const secondary = colors["text-secondary"]!;
    const channels = [1, 3, 5].map(start => parseInt(secondary.slice(start, start + 2), 16));
    expect(Math.max(...channels) - Math.min(...channels)).toBeLessThanOrEqual(5);
  });
  it("pills are distinct from panels and focus inverts only the focused control or cell", () => {
    expect(rule(".action")).toContain("background: var(--raised)");
    const focus = rule('.action:focus-visible:not([aria-pressed]):not(:disabled):not([aria-disabled="true"])');
    expect(focus).toContain("background: var(--text)"); expect(focus).toContain("color: var(--bg)");
    for (const surface of ["bg", "surface", "raised"]) expect(contrast(colors.text!, colors[surface]!)).toBeGreaterThanOrEqual(3);
    const pillFocus = rule('.action[aria-pressed]:focus-visible:not(:disabled):not([aria-disabled="true"])');
    expect(pillFocus).toContain("text-decoration: underline 2px"); expect(pillFocus).toContain("text-underline-offset: 3px");
    expect(pillFocus).not.toMatch(/background|color|outline|border|shadow/);
    const region = rule(".table-region:focus-visible .data-table caption");
    expect(region).toContain("color: var(--bg)"); expect(region).toContain("background: var(--text)");
    const selected = rule('.action[aria-pressed="true"]');
    expect(selected).toContain("background: var(--text)"); expect(selected).toContain("color: var(--bg)");
    expect(css).not.toMatch(/box-shadow|text-shadow|gradient/);
    expect(decorationFailures(css)).toEqual([]);
  });
  it("chart captions have an unscaled font size of 12 CSS pixels", () => {
    const text = rule(".chart-summary"), size = Number(text.match(/font-size:\s*([\d.]+)px/)?.[1]);
    expect(text).not.toMatch(/white-space:\s*nowrap|overflow(?:-[xy])?:\s*(?:hidden|clip)|text-overflow:/);
    expect(size).toBe(12); expect(rule(".observation-chart")).toContain("height: 160px");
  });
  it("unused axis and unreachable cell focus styles are removed", () => {
    expect(css).not.toContain("--axis-accent"); expect(css).not.toMatch(/(?:td|tr):focus-visible/);
    expect(css).not.toContain(".action:hover:not(:disabled)");
    const bold = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].filter(block => /font-weight:\s*(?:600 1000|700)/.test(block[1]!));
    expect(bold.some(block => block[1]!.includes('local("Google Sans Flex Bold")'))).toBe(true);
  });
  it("local faces include full and PostScript names", () => {
    for (const name of ["Google Sans Flex", "Google Sans Flex Regular", "GoogleSansFlex-Regular", "Google Sans Flex Medium", "GoogleSansFlex-Medium", "Google Sans Flex SemiBold", "GoogleSansFlex-SemiBold", "Cascadia Code", "Cascadia Code Regular", "CascadiaCode-Regular", "Cascadia Code NF", "CascadiaCodeNF-Regular", "Cascadia Mono", "Google Sans Flex Bold", "GoogleSansFlex-Bold", "Cascadia Code Bold", "CascadiaCode-Bold"]) expect(css).toContain(`local("${name}")`);
  });
});
