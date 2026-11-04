// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Use the focused header over the lightest glass stop as a conservative backdrop.
export function identityPill(name, t) {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619) >>> 0;
  const color = [t.ansi2, t.ansi4, t.ansi5, t.ansi6, t.ansi12, t.ansi13][hash % 6];
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

