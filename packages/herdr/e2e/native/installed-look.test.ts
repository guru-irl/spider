import { describe, expect, it } from 'vitest';
import { validateInstalledLook } from './installed-look.js';

function observations(): Record<string, unknown> {
  return {
    appSettings: { theme: 'spider-glass' }, piSettings: { theme: 'dracula-plus-glass' },
    appTheme: { background: '#161618', foreground: '#f8f8f2', cursor: '#eceff4', ansi: ['#21222c','#ff5555','#50fa7b','#ffcb6b','#82aaff','#c792ea','#8be9fd','#f8f8f2','#545454','#ff6e6e','#69ff94','#ffcb6b','#d6acff','#ff92df','#a4ffff','#f8f8f2'] },
    layout: { theme: 'spider-glass', ui_font: 'Google Sans Flex', terminal_opacity: 0, colors: { chrome: '#00000000', canvas: '#00000000', hover: '#ffffff12', selected: '#ffffff14', raised: '#ffffff1c', border: '#00000000', popover: '#161618f0', surface: '#161618f0' }, children: [{ id: 'work-body', gap: 8, padding: 8, content: { tab: 'active', pane: { gap: 8, radius: 12, background: '#161618f0', border: { width: 1, color: '#38383a' }, focus: { width: 1, color: 'accent' } } }, children: [{ id: 'panel', radius: 12, border: { width: 1, color: '#38383a' }, padding: 5, background: '#161618f0' }] }] },
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
  it('rejects wrong pane or panel frames and borders on unrelated chrome', () => {
    const pane = observations();
    const work = (pane.layout as any).children[0];
    work.content.pane.border.color = '#00000000';
    expect(() => validateInstalledLook(pane)).toThrow(/pane border/);
    const focus = observations(); (focus.layout as any).children[0].content.pane.focus.width = 0;
    expect(() => validateInstalledLook(focus)).toThrow(/pane focus/);
    const panel = observations(); (panel.layout as any).children[0].children[0].radius = 0;
    expect(() => validateInstalledLook(panel)).toThrow(/panel radius/);
    const border = observations(); (border.layout as any).children[0].children[0].border.width = 0;
    expect(() => validateInstalledLook(border)).toThrow(/panel border/);
    const inset = observations(); (inset.layout as any).children[0].children[0].padding = 0;
    expect(() => validateInstalledLook(inset)).toThrow(/panel padding/);
    const backing = observations(); (backing.layout as any).children[0].children[0].background = '#00000000';
    expect(() => validateInstalledLook(backing)).toThrow(/panel background/);
    const unrelated = observations(); (unrelated.layout as any).children[0].border = { width: 1, color: '#ffffff' };
    expect(() => validateInstalledLook(unrelated)).toThrow(/app border width/);
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
