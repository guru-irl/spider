// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
const colors = ['ansi2', 'ansi4', 'ansi5', 'ansi6', 'ansi12', 'ansi13'];
const shapes = ['circle', 'square', 'triangle', 'diamond', 'hexagon', 'star'];
function hashName(name) {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619) >>> 0;
  return hash;
}

// Up to six spaces get distinct shapes. Past six, later spaces in name order reuse their preferred shape.
export function assignSpaceIdentities(spaces) {
  const occupied = new Set(), result = new Map();
  const ordered = [...spaces].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const space of ordered) {
    let slot = hashName(space.name) % shapes.length;
    while (occupied.has(slot) && occupied.size < shapes.length) slot = (slot + 1) % shapes.length;
    occupied.add(slot);
    result.set(space.id, { shape: shapes[slot] });
  }
  return result;
}

export function threadKeylines(div, lines, height = 26, { start = 0, x = 24, first = 7 } = {}) {
  return lines.flatMap((line, depth) => {
    const left = x + depth * 26 - 0.5;
    const segments = [];
    if (line === "│" || line === "├") segments.push(div().absolute().left(left).top(start).bottom(0).w(1).border_l(1).border_color("#3a3a3d"));
    if (line === "└" || line === "├") segments.push(div().absolute().left(left).top(start).w(26 - first + 0.5).h(height / 2 - start + 0.5).border_l(1).border_b(1).rounded_bl(6).border_color("#3a3a3d"));
    return segments;
  });
}

// Use the focused header over the lightest glass stop as a conservative backdrop.
export function identityPill(name, t) {
  const color = t[colors[hashName(name) % 6]];
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) return null;
  const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const luminance = values => values.reduce((sum, value, i) => {
    const c = value / 255;
    return sum + [0.2126, 0.7152, 0.0722][i] * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  }, 0);
  const background = rgb.map((value, i) => value * 0.2 + [43, 43, 45][i] * 0.8);
  const fg = luminance(rgb), bg = luminance(background);
  const contrast = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  return { background: color + "33", text: contrast >= 4.5 ? color : t.foreground };
}
