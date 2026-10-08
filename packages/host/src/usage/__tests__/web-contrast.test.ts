import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import postcss from "postcss";
type Node = { simple: string; parent?: Node };
type Paint = { color: string; fill: string; background: string; size: number; weight: number };
it("actual CSS text/background pairs, including inherited controls, meet AA", () => {
  const web = new URL("../web/", import.meta.url);
  const sheet = postcss.parse(readdirSync(web).filter(f => f.endsWith(".css") && !["detail.css"].includes(f)).map(f => readFileSync(new URL(f, web), "utf8")).join("\n"));
  const tokens = new Map<string, string>(); sheet.walkDecls(/^--/, d => { tokens.set(d.prop, d.value); });
  const resolve = (value: string): string => { for (let i = 0; i < 10; i++) value = value.replace(/var\((--[\w-]+)\)/g, (_, k: string) => tokens.get(k) ?? "unknown"); return value; };
  const root: Paint = { color: resolve("var(--usage-ink)"), fill: resolve("var(--usage-ink)"), background: resolve("var(--usage-ground)"), size: 14, weight: 400 };
  const rules: { selector: string; declarations: { prop: string; value: string }[]; specificity: number; order: number }[] = [];
  sheet.walkRules(rule => { for (const selector of rule.selector.split(",")) {
    if (selector.includes("::") || selector.includes("@") || selector.includes(":has(")) continue;
    const declarations: { prop: string; value: string }[] = []; rule.walkDecls(d => { declarations.push({ prop: d.prop, value: resolve(d.value) }); });
    rules.push({ selector: selector.trim(), declarations, specificity: (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g)?.length ?? 0) * 10 + (selector.match(/(?:^|\s|>)[a-z]+/g)?.length ?? 0), order: rules.length });
  } });
  function simpleMatches(pattern: string, node: Node): boolean {
    if (pattern === "*") return true;
    const tag = pattern.match(/^[a-z]+/i)?.[0]; if (tag && node.simple.match(/^[a-z]+/i)?.[0] !== tag) return false;
    return [...pattern.matchAll(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g)].every(m => node.simple.includes(m[0]));
  }
  function matches(selector: string, node: Node): boolean {
    const parts = selector.replace(/>/g, " > ").trim().split(/\s+/); let cursor: Node | undefined = node;
    if (!simpleMatches(parts.pop()!, cursor)) return false;
    while (parts.length) {
      const direct = parts.at(-1) === ">"; if (direct) parts.pop(); const part = parts.pop()!;
      cursor = cursor?.parent;
      if (!direct) while (cursor && !simpleMatches(part, cursor)) cursor = cursor.parent;
      if (!cursor || !simpleMatches(part, cursor)) return false;
    }
    return true;
  }
  function paint(node: Node): Paint {
    const parent = node.parent ? paint(node.parent) : root; const result = { ...parent };
    for (const rule of rules.filter(r => matches(r.selector, node)).sort((a, b) => a.specificity - b.specificity || a.order - b.order)) {
      for (const d of rule.declarations) {
        if (d.prop === "color") result.color = d.value === "inherit" ? parent.color : d.value;
        if (d.prop === "fill" && !["none", "currentColor"].includes(d.value)) result.fill = d.value === "inherit" ? parent.fill : d.value;
        if (["background", "background-color"].includes(d.prop)) result.background = ["transparent", "none"].includes(d.value) ? parent.background : d.value;
        if (d.prop === "font-size" && d.value.endsWith("px")) result.size = parseFloat(d.value);
        if (d.prop === "font-weight") result.weight = d.value === "bold" ? 700 : Number(d.value) || parent.weight;
        if (d.prop === "font" && d.value.includes("px")) { result.size = Number(d.value.match(/([\d.]+)px/)?.[1]) || result.size; result.weight = Number(d.value.match(/^([\d]+)/)?.[1]) || result.weight; }
      }
    }
    return result;
  }
  const luminance = (s: string) => { const hex = s.slice(1); const rgb = (hex.length === 3 ? [...hex].map(c => c + c).join("") : hex).match(/../g)!.map(c => parseInt(c, 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4); return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722; };
  let count = 0;
  for (const rule of rules.filter(r => r.declarations.some(d => d.prop === "color" || d.prop === "fill" && /(?:^|\s)text[.:\s]|(?:^|\s)text$/.test(r.selector)))) {
    let node: Node | undefined; for (const simple of rule.selector.replace(/>/g, " ").split(/\s+/)) node = { simple, parent: node };
    const actual = paint(node!); const foreground = rule.declarations.some(d => d.prop === "fill") ? actual.fill : actual.color;
    expect(foreground, rule.selector).toMatch(/^#[0-9a-f]{3,6}$/i); expect(actual.background, rule.selector).toMatch(/^#[0-9a-f]{3,6}$/i);
    // SVG text is painted over shapes, not the inherited HTML background.
    const backgrounds = rule.selector.includes("text.pace-used")
      ? rule.selector.includes("[data-after=true]") ? [paint({ simple: "svg.pace-track" }).background]
        : [paint({ simple: ".pace-fill" }).fill, paint({ simple: ".pace-fill", parent: { simple: ".month-pace[data-danger=true]" } }).fill]
      : rule.selector.includes("text.segment-share") ? [...tokens].filter(([key]) => key.startsWith("--usage-role-")).map(([, value]) => resolve(value))
      : [actual.background];
    const minimum = actual.size >= 24 || actual.size >= 18.67 && actual.weight >= 700 ? 3 : 4.5;
    for (const background of backgrounds) {
      const a = luminance(foreground), b = luminance(background);
      expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05), `${rule.selector} (${foreground} on ${background})`).toBeGreaterThanOrEqual(minimum); count++;
    }
  }
  expect(count).toBeGreaterThan(10);
});
