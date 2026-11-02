// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { ThemeToken } from '@earendil-works/pi-coding-agent';
import herdr from '../../assets/themes/spider-glass.json' with { type: 'json' };
export interface PiThemeData { name: string; vars?: Readonly<Record<string, string | number>>; colors: Partial<Record<ThemeToken, string | number>>; export?: Partial<Record<'pageBg' | 'cardBg' | 'infoBg', string | number>> }
export interface ContrastRow { token: string; foreground: string; background: string; ratio: number; required: number }
export interface ContrastFailure { token: string; code: string; ratio?: number; required?: number }
export interface ContrastReport { failures: ContrastFailure[]; rows: ContrastRow[]; backgrounds: Record<string, string> }
const backgroundKeys: readonly ThemeToken[] = ['selectedBg', 'searchMatchBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg'];
const decorative = new Set<ThemeToken>(['borderMuted', 'scrollbarTrack']);
const indicators = new Set<ThemeToken>(['border', 'borderAccent', 'borderMuted', 'scrollbarTrack', 'scrollbarThumb', 'mdCodeBlockBorder', 'mdQuoteBorder', 'mdHr', 'thinkingOff', 'thinkingMinimal', 'thinkingLow', 'thinkingMedium', 'thinkingHigh', 'thinkingXhigh', 'thinkingMax', 'bashMode']);
const channels = (hex: string): number[] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex: string): number => channels(hex).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
export function contrastRatio(a: string, b: string): number {
  const light = Math.max(luminance(a), luminance(b)), dark = Math.min(luminance(a), luminance(b));
  return (light + 0.05) / (dark + 0.05);
}
function indexed(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('Invalid palette index');
  if (value < 16) return herdr.ansi[value];
  if (value >= 232) return '#' + (8 + (value - 232) * 10).toString(16).padStart(2, '0').repeat(3);
  const i = value - 16, steps = [0, 95, 135, 175, 215, 255];
  return '#' + [Math.floor(i / 36), Math.floor(i / 6) % 6, i % 6].map(n => steps[n].toString(16).padStart(2, '0')).join('');
}

export interface GlassEdits {
  root: { background: string | { gradient: readonly string[]; angle?: number }; colors: Readonly<Record<string, string>> };
  pane: { background: string };
}
/** Where text sits, glass must be near-opaque: Herdr's window is opaque, so lower alphas only show the ground, never a blurred desktop. */
export const GLASS_TEXT_ALPHA = 0.9;
const overlays = ['hover', 'selected', 'raised', 'input'] as const;
const alphaOf = (hex: string): number => hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
/** Source-over compositing of `top` (#rrggbb or #rrggbbaa) onto an opaque `bottom`. */
export function composite(top: string, bottom: string): string {
  const a = alphaOf(top), t = channels(top), b = channels(bottom);
  return '#' + t.map((v, i) => Math.round(v * a + b[i] * (1 - a)).toString(16).padStart(2, '0')).join('');
}

/**
 * Checks the glass layout against the Herdr theme. Herdr paints its window opaque (a transparent root shows the theme
 * background), so every alpha composites over the root gradient's ends on top of the theme background. Primary and
 * muted text must reach 4.5:1 on every text surface and fill; dim text must reach it on the unfilled surfaces.
 */
export function checkGlassContrast(edits: GlassEdits, theme: { background: string; colors: Readonly<Record<string, string>> } = herdr): ContrastReport {
  const failures: ContrastFailure[] = [], rows: ContrastRow[] = [], backgrounds: Record<string, string> = {};
  const valid = (v: unknown): v is string => typeof v === 'string' && /^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i.test(v);
  const paint = edits.root.background, ends = typeof paint === 'string' ? [paint] : [...paint.gradient];
  const colors = { ...theme.colors, ...edits.root.colors };
  if (![theme.background, ...ends].every(valid)) return { failures: [{ token: 'background', code: 'invalid-color' }], rows, backgrounds };
  const grounds = ends.map(end => composite(end, theme.background));
  const surfaces: Record<string, string | undefined> = { chrome: colors.chrome, canvas: colors.canvas, pane: edits.pane.background, surface: colors.surface, popover: colors.popover };
  for (const [name, value] of Object.entries(surfaces)) {
    if (!valid(value)) { failures.push({ token: name, code: 'invalid-color' }); continue; }
    if (name !== 'chrome' && name !== 'canvas' && alphaOf(value) < GLASS_TEXT_ALPHA) failures.push({ token: name, code: 'translucent-text-surface' });
    grounds.forEach((ground, i) => {
      const base = composite(value, ground); backgrounds[`${name}@${i}`] = base;
      for (const fill of overlays) if (valid(colors[fill])) backgrounds[`${name}+${fill}@${i}`] = composite(colors[fill], base);
        else failures.push({ token: fill, code: 'invalid-color' });
    });
  }
  for (const token of ['foreground', 'muted', 'dim'] as const) {
    const foreground = colors[token];
    if (!valid(foreground) || foreground.length !== 7) { failures.push({ token, code: 'invalid-color' }); continue; }
    const on = Object.entries(backgrounds).filter(([key]) => token !== 'dim' || !key.includes('+'));
    const worst = on.map(([, background]) => ({ background, ratio: contrastRatio(foreground, background) })).sort((a, b) => a.ratio - b.ratio)[0];
    if (!worst) continue;
    rows.push({ token, foreground, ...worst, required: 4.5 });
    if (worst.ratio < 4.5) failures.push({ token, code: 'contrast', ratio: worst.ratio, required: 4.5 });
  }
  return { failures, rows, backgrounds };
}

/** The terminal defaults are the paired Herdr theme, not a black/white guess. */
export function checkThemeContrast(theme: PiThemeData): ContrastReport {
  const failures: ContrastFailure[] = [], rows: ContrastRow[] = [], backgrounds: Record<string, string> = {};
  const resolve = (value: string | number | undefined, fallback: string): string => {
    const seen = new Set<string>();
    while (typeof value === 'string' && value !== '' && !value.startsWith('#')) {
      if (seen.has(value) || theme.vars?.[value] === undefined) throw new Error('Invalid variable');
      seen.add(value); value = theme.vars[value];
    }
    if (value === '') return fallback;
    if (typeof value === 'number') return indexed(value);
    if (typeof value !== 'string' || !/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(value)) throw new Error('Invalid color');
    return value.length === 4 ? '#' + value.slice(1).split('').map(c => c + c).join('').toLowerCase() : value.toLowerCase();
  };
  const addBackground = (token: string, value: string | number | undefined): void => {
    try {
      const hex = resolve(value, herdr.background), rgb = channels(hex);
      backgrounds[token] = hex;
      if (Math.max(...rgb) - Math.min(...rgb) > 2 || rgb[2] < rgb[0]) failures.push({ token, code: 'tinted-background' });
    } catch { failures.push({ token, code: 'invalid-color' }); }
  };
  addBackground('terminal', theme.vars?.base ?? herdr.background);
  for (const token of backgroundKeys) addBackground(token, theme.colors[token]);
  for (const [token, value] of Object.entries(theme.export ?? {})) addBackground(`export.${token}`, value);
  for (const [key, value] of Object.entries(theme.colors)) {
    const token = key as ThemeToken; if (backgroundKeys.includes(token)) continue;
    try {
      const foreground = resolve(value, herdr.foreground);
      const required = decorative.has(token) ? 0 : indicators.has(token) ? 3 : 4.5;
      const surfaces = indicators.has(token) ? [backgrounds.terminal] : Object.values(backgrounds);
      if (!surfaces.length || surfaces.some(s => !s)) { failures.push({ token, code: 'invalid-background' }); continue; }
      const worst = surfaces.map(background => ({ background, ratio: contrastRatio(foreground, background) })).sort((a, b) => a.ratio - b.ratio)[0];
      rows.push({ token, foreground, ...worst, required });
      if (worst.ratio < required) failures.push({ token, code: 'contrast', ratio: worst.ratio, required });
    } catch { failures.push({ token, code: 'invalid-color' }); }
  }
  return { failures, rows, backgrounds };
}
