import { describe, expect, it } from 'vitest';
import { validateInstalledLook } from './installed-look.js';

function observations(): Record<string, unknown> {
  return {
    appSettings: { theme: 'spider-glass' }, piSettings: { theme: 'dracula-plus-glass' },
    appTheme: { background: '#161618', foreground: '#f8f8f2', cursor: '#eceff4', ansi: ['#21222c','#ff5555','#50fa7b','#ffcb6b','#82aaff','#c792ea','#8be9fd','#f8f8f2','#545454','#ff6e6e','#69ff94','#ffcb6b','#d6acff','#ff92df','#a4ffff','#f8f8f2'] },
    layout: { theme: 'spider-glass', ui_font: 'Google Sans Flex', terminal_opacity: 0, colors: { chrome: '#00000000', canvas: '#00000000', hover: '#ffffff12', selected: '#ffffff14', raised: '#ffffff1c', border: '#00000000', popover: '#161618f0', surface: '#161618f0' }, children: [{ id: 'work-body', gap: 8, padding: 8, content: { tab: 'active', pane: { gap: 8, radius: 12, background: '#161618f0', border: { width: 0, color: '#00000000' }, focus: { width: 0, color: '#00000000' } } } }] },
    piTheme: { name: 'dracula-plus-glass', vars: { base: '#161618' }, colors: { text: '', muted: '#a6a6a7', border: '#656567', borderMuted: '#49494b', scrollbarTrack: '#49494b', selectedBg: '#29292a', searchMatchBg: '#303031', userMessageBg: '#262628', customMessageBg: '#202022', toolPendingBg: '#202022', toolSuccessBg: '#242426', toolErrorBg: '#262628', thinkingLow: '#8be9fd' } },
    keys: { terminal: { 'cmd-shift-a': 'send:\u001b[97;6u', 'cmd-shift-o': 'send:\u001b[111;6u', 'cmd-shift-u': 'send:\u001b[117;6u', 'cmd-shift-m': 'send:\u001b[109;6u', 'cmd-shift-k': 'send:\u001b[107;6u', 'ctrl-v': 'original-paste' } },
    previousKeys: { terminal: { 'ctrl-v': 'original-paste' } },
  };
}
describe('installed look observations', () => {
  it('accepts the promised palette, surfaces, contrast and receiving key fragment', () => {
    const report = validateInstalledLook(observations());
    expect(report.contrast.some(row => row.token === 'text' && row.ratio >= 4.5)).toBe(true);
    expect(report.contrast.find(row => row.token === 'borderMuted')?.required).toBe(0);
  });
  it('catches wrong active theme, tinted panes, missing keys and changed paste', () => {
    const active = observations(); (active.appSettings as Record<string, unknown>).theme = 'other';
    expect(() => validateInstalledLook(active)).toThrow(/active app theme/);
    const tinted = observations(); (tinted.appTheme as Record<string, unknown>).background = '#282a36';
    expect(() => validateInstalledLook(tinted)).toThrow(/background/);
    const keys = observations(); delete ((keys.keys as { terminal: Record<string, unknown> }).terminal)['cmd-shift-a'];
    expect(() => validateInstalledLook(keys)).toThrow(/shortcut/);
    const paste = observations(); (paste.keys as { terminal: Record<string, unknown> }).terminal['ctrl-v'] = 'changed';
    expect(() => validateInstalledLook(paste)).toThrow(/Ctrl-V/);
    const font = observations(); delete (font.layout as Record<string, unknown>).ui_font;
    expect(() => validateInstalledLook(font)).toThrow(/body font/);
  });
  it('rejects palette substitutions, unreadable text, pane shadows and malformed observations', () => {
    const palette = observations(); (palette.appTheme as { ansi: string[] }).ansi[0] = '#161618';
    expect(() => validateInstalledLook(palette)).toThrow(/ANSI palette/);
    const unreadable = observations(); (unreadable.piTheme as { colors: Record<string, unknown> }).colors.muted = '#303031';
    expect(() => validateInstalledLook(unreadable)).toThrow(/contrast/);
    const shadow = observations(); (shadow.layout as { children: Record<string, unknown>[] }).children[0].shadow = { blur: 1 };
    expect(() => validateInstalledLook(shadow)).toThrow(/shadow/);
    expect(() => validateInstalledLook({})).toThrow(/observations|object/);
  });
});
