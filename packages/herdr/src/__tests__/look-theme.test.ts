// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkThemeContrast, checkGlassContrast, composite, type GlassEdits, type PiThemeData } from '../look/contrast.js';
import glassEdits from '../../assets/look/layout-edits.json' with { type: 'json' };
import { acceptanceK } from './acceptance/k.js';
import { runAcceptance } from './scenarios.js';
import { prepareFonts, inspectFont } from '../look/fonts.js';

const assets = fileURLToPath(new URL('../../assets/', import.meta.url));
// Approved Ghostty Dracula+ source: palette numbers 0–15, including 11 and 15.
const palette = ['#21222c', '#ff5555', '#50fa7b', '#ffcb6b', '#82aaff', '#c792ea', '#8be9fd', '#f8f8f2', '#545454', '#ff6e6e', '#69ff94', '#ffcb6b', '#d6acff', '#ff92df', '#a4ffff', '#f8f8f2'];
async function loadPiTheme(): Promise<PiThemeData> {
  const main = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const { validateThemeJson } = await import(pathToFileURL(join(dirname(main), 'modes/interactive/theme/theme-schema.js')).href);
  return validateThemeJson('dracula-plus-glass', JSON.parse(await readFile(join(assets, 'themes/dracula-plus-glass.json'), 'utf8')));
}

describe('glass themes and fonts', () => {
  it.skipIf(process.env.SPIDER_HERDR_APP_E2E === '1' && process.env.SPIDER_HERDR_APP_TESTS !== '1')('acceptanceK exercises isolated cores; app windows require SPIDER_HERDR_APP_TESTS=1', async () => {
    await runAcceptance('look', async h => {
      await acceptanceK(h);
      if (h.mode === 'fake') {
        const launches = (await h.calls()).filter(c => c.argv[0] === 'run');
        expect(launches.some(c => c.argv.includes('--on'))).toBe(true);
        expect(launches.every(c => c.argv.includes('--no-notify'))).toBe(true);
      } else {
        expect((await h.inventory()).some(r => r.kind === 'terminal' && r.id.startsWith('local:remote.invalid/'))).toBe(true);
      }
    });
  }, 30000);
  it('both themes preserve neutral backgrounds and readable pi roles', async () => {
    const theme = await loadPiTheme();
    const herdr = JSON.parse(await readFile(join(assets, 'themes/spider-glass.json'), 'utf8'));
    expect(herdr.background).toBe('#161618'); expect(herdr.foreground).toBe('#f8f8f2'); expect(herdr.cursor).toBe('#eceff4');
    expect(herdr.ansi).toEqual(palette);
    const report = checkThemeContrast(theme);
    expect(report.failures).toEqual([]); expect(report.rows.length).toBeGreaterThan(40);
    expect(Object.values(report.backgrounds).sort()).toEqual(['#161618', '#202022', '#202022', '#242426', '#262628', '#262628', '#29292a', '#29292a', '#303031', '#161618', '#202022'].sort());
    const fonts = await prepareFonts({}, { readFile, bundledRoot: join(assets, 'fonts') });
    expect(Object.values(fonts.families)).toEqual(expect.arrayContaining(['Google Sans Flex', 'Glass Label']));
    expect(fonts.families.paths).toBe('JetBrains Mono');
    expect(fonts.files.map(f => f.fileName)).toEqual(['GoogleSansFlex.ttf', 'GlassLabel-Bold.ttf', 'GoogleSansFlex-OFL.txt', 'GoogleSansFlex-TRADEMARKS.md']);
  });
  it('loads bundled fonts from the installed asset root, not the source module location', async () => {
    const installedRoot = '/fixture/installed/fonts';
    const fonts = await prepareFonts({}, { bundledRoot: installedRoot, readFile: async path => {
      if (!path.startsWith(installedRoot + '/')) throw new Error('Read outside installed asset root');
      return readFile(join(assets, 'fonts', path.slice(installedRoot.length + 1)));
    } });
    expect(fonts.families).toEqual({ body: 'Google Sans Flex', label: 'Glass Label', paths: 'JetBrains Mono' });
  });
  it('rejects an unreadable optional path font instead of silently substituting it', async () => {
    await expect(prepareFonts({ paths: { path: '/fixture/missing.ttf', license: '/fixture/notice.txt' } }, { bundledRoot: join(assets, 'fonts'), readFile: async path => {
      if (path === '/fixture/missing.ttf') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return readFile(path);
    } })).rejects.toMatchObject({ code: 'font-unreadable' });
  });
  it('reports tinted boxes and low text contrast instead of certifying them', async () => {
    const original = await loadPiTheme();
    const tinted = structuredClone(original); tinted.colors.toolErrorBg = '#282a36';
    expect(checkThemeContrast(tinted).failures).toEqual(expect.arrayContaining([expect.objectContaining({ token: 'toolErrorBg', code: 'tinted-background' })]));
    const low = structuredClone(original); low.colors.toolOutput = '#49494b';
    expect(checkThemeContrast(low).failures).toEqual(expect.arrayContaining([expect.objectContaining({ token: 'toolOutput', code: 'contrast', required: 4.5 })]));
  });
  it('the shipped glass keeps text near-opaque and readable over the opaque window ground', () => {
    const report = checkGlassContrast(glassEdits as GlassEdits);
    expect(report.failures).toEqual([]);
    expect(report.rows.map(r => r.token)).toEqual(['foreground', 'muted', 'dim']);
    expect(report.rows.every(r => r.ratio >= 4.5)).toBe(true);
    // Text panes and menus at Firefox's 0.94 menu level sit within one step of the solid surface on either ground end.
    for (const key of ['pane@0', 'pane@1', 'popover@0', 'popover@1']) expect(report.backgrounds[key]).toMatch(/^#1[67]1[67]1[78]$/);
  });
  it('reports translucent text surfaces, low glass contrast and invalid glass colours', () => {
    const edits = structuredClone(glassEdits) as GlassEdits;
    edits.pane.background = '#161618cc';
    expect(checkGlassContrast(edits).failures).toEqual([{ token: 'pane', code: 'translucent-text-surface' }]);
    const low = structuredClone(glassEdits) as GlassEdits;
    (low.root.colors as Record<string, string>).muted = '#5a5a5c';
    expect(checkGlassContrast(low).failures).toEqual([expect.objectContaining({ token: 'muted', code: 'contrast', required: 4.5 })]);
    const bright = structuredClone(glassEdits) as GlassEdits;
    (bright.root.colors as Record<string, string>).raised = '#ffffff66';
    expect(checkGlassContrast(bright).failures.map(f => f.token)).toContain('muted');
    const invalid = structuredClone(glassEdits) as GlassEdits;
    invalid.root.background = { gradient: ['#18181a', 'warm'], angle: 176 };
    expect(checkGlassContrast(invalid).failures).toEqual([{ token: 'background', code: 'invalid-color' }]);
  });
  it('composites alpha colours source-over onto an opaque ground', () => {
    expect(composite('#ff000080', '#161618')).toBe('#8b0b0c');
    expect(composite('#161618', '#ffffff')).toBe('#161618');
    expect(composite('#00000000', '#22201e')).toBe('#22201e');
  });
  it('enforces indicator contrast while exempting only decorative separators', async () => {
    const theme = await loadPiTheme(); theme.colors.thinkingLow = '#49494b';
    const report = checkThemeContrast(theme);
    expect(report.failures).toEqual(expect.arrayContaining([expect.objectContaining({ token: 'thinkingLow', code: 'contrast', required: 3 })]));
    expect(report.failures.some(f => ['borderMuted', 'scrollbarTrack'].includes(f.token))).toBe(false);
  });
  it('refuses unknown variables, cycles, and unsupported color values', async () => {
    for (const value of ['missing', 'cycle', '#xyzxyz', 999]) {
      const theme = await loadPiTheme(); theme.vars = { ...theme.vars, cycle: 'cycle' }; theme.colors.error = value;
      expect(checkThemeContrast(theme).failures).toEqual(expect.arrayContaining([expect.objectContaining({ token: 'error', code: 'invalid-color' })]));
    }
  });
  it('preserves OFL provenance and renamed bold condensed name tables', async () => {
    const original = inspectFont(await readFile(join(assets, 'fonts/GoogleSansFlex.ttf')));
    const label = inspectFont(await readFile(join(assets, 'fonts/GlassLabel-Bold.ttf')));
    expect(original.family).toBe('Google Sans Flex'); expect(original.variable).toBe(true);
    expect(label).toMatchObject({ family: 'Glass Label', weight: 700, width: 3, variable: false });
    expect(label.names[6]).toEqual(['GlassLabel-Bold']);
    expect(label.names[3]?.join(' ')).toContain('Derived from Google Sans Flex (OFL 1.1)');
    const fonts = await prepareFonts({}, { readFile, bundledRoot: join(assets, 'fonts') });
    expect(fonts.files.find(f => f.fileName.endsWith('OFL.txt'))!.bytes.toString()).toContain('SIL OPEN FONT LICENSE');
    expect(fonts.files.find(f => f.fileName.endsWith('TRADEMARKS.md'))!.bytes.toString()).toContain('Google');
  });
});
