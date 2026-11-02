import { contrastRatio } from './png.js';

export interface InstalledLookReport { contrast: { token: string; foreground: string; background: string; ratio: number; required: number }[] }
const ansi = ['#21222c','#ff5555','#50fa7b','#ffcb6b','#82aaff','#c792ea','#8be9fd','#f8f8f2','#545454','#ff6e6e','#69ff94','#ffcb6b','#d6acff','#ff92df','#a4ffff','#f8f8f2'];
const shortcuts: Readonly<Record<string, string>> = { 'cmd-shift-a': 'send:\u001b[97;6u', 'cmd-shift-o': 'send:\u001b[111;6u', 'cmd-shift-u': 'send:\u001b[117;6u', 'cmd-shift-m': 'send:\u001b[109;6u', 'cmd-shift-k': 'send:\u001b[107;6u' };
const backgroundTokens = ['selectedBg', 'searchMatchBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg'];
const neutral = new Set(['#161618','#202022','#242426','#262628','#29292a','#303031']);
const decorative = new Set(['borderMuted', 'scrollbarTrack']);
const indicators = new Set(['border','borderAccent','scrollbarThumb','mdCodeBlockBorder','mdQuoteBorder','mdHr','thinkingOff','thinkingMinimal','thinkingLow','thinkingMedium','thinkingHigh','thinkingXhigh','thinkingMax','bashMode']);
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('installed-look: expected observations object');
  return raw as Record<string, unknown>;
}
function equal(actual: unknown, expected: unknown, name: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`installed-look: ${name}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
}
function noEdges(raw: unknown, framed: ReadonlySet<object>): void {
  if (!raw || typeof raw !== 'object') return;
  if (Array.isArray(raw)) { for (const value of raw) noEdges(value, framed); return; }
  for (const [key, value] of Object.entries(raw)) {
    if ((key === 'shadow' || key === 'outline' || key === 'divider') && value !== null && value !== false && value !== 0 && value !== 'none') throw new Error(`installed-look: app ${key} must be absent`);
    if (!framed.has(raw) && (key === 'border' || key === 'focus') && value && typeof value === 'object' && 'width' in value) equal((value as Record<string, unknown>).width, 0, `app ${key} width`);
    noEdges(value, framed);
  }
}
export function validateInstalledLook(raw: unknown): InstalledLookReport {
  const actual = object(raw), appTheme = object(actual.appTheme), layout = object(actual.layout), piTheme = object(actual.piTheme);
  equal(object(actual.appSettings).theme, 'spider-glass', 'active app theme');
  equal(object(actual.piSettings).theme, 'dracula-plus-glass', 'active pi theme');
  equal(appTheme.background, '#161618', 'app background');
  equal(appTheme.foreground, '#f8f8f2', 'terminal foreground');
  equal(appTheme.cursor, '#eceff4', 'terminal cursor');
  equal(appTheme.ansi, ansi, 'ANSI palette');
  equal(layout.theme, 'spider-glass', 'layout theme');
  equal(layout.ui_font, 'Google Sans Flex', 'body font');
  equal(layout.terminal_opacity, 0, 'terminal opacity');
  const colors = object(layout.colors);
  for (const [key, expected] of Object.entries({ chrome: '#00000000', canvas: '#00000000', hover: '#ffffff12', selected: '#ffffff14', raised: '#ffffff1c', border: '#00000000', popover: '#161618f0', surface: '#161618f0' })) equal(colors[key], expected, `layout ${key}`);
  const panes: Record<string, unknown>[] = [], work: Record<string, unknown>[] = [], panels: Record<string, unknown>[] = [];
  const walk = (node: Record<string, unknown>): void => {
    if (node.id === 'work-body') work.push(node);
    if (node.id === 'panel') panels.push(node);
    if (node.content && typeof node.content === 'object') {
      const content = object(node.content);
      if (content.tab === 'active') panes.push(object(content.pane));
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new Error('installed-look: invalid layout children');
      for (const child of node.children) walk(object(child));
    }
  };
  walk(layout);
  if (panes.length !== 1 || work.length !== 1 || panels.length !== 1) throw new Error('installed-look: expected one active pane, work-body and panel');
  equal(work[0].gap, 8, 'work gap'); equal(work[0].padding, 8, 'work padding');
  equal(panes[0].gap, 8, 'pane gap'); equal(panes[0].radius, 12, 'pane radius'); equal(panes[0].background, '#161618f0', 'text pane background');
  equal(panes[0].border, { width: 1, color: '#38383a' }, 'pane border');
  equal(panes[0].focus, { width: 1, color: 'accent' }, 'pane focus');
  equal(panels[0].radius, 12, 'panel radius');
  equal(panels[0].border, { width: 1, color: '#38383a' }, 'panel border');
  equal(panels[0].padding, 5, 'panel padding');
  equal(panels[0].background, '#161618f0', 'panel background');
  noEdges(layout, new Set([panes[0], panels[0]]));
  const keys = object(object(actual.keys).terminal), previous = object(object(actual.previousKeys).terminal);
  for (const [key, value] of Object.entries(shortcuts)) equal(keys[key], value, `shortcut ${key}`);
  equal(keys['ctrl-v'], previous['ctrl-v'], 'Ctrl-V unchanged');
  equal(piTheme.name, 'dracula-plus-glass', 'pi theme name');
  const vars = object(piTheme.vars), tokens = object(piTheme.colors);
  const resolve = (rawColor: unknown, fallback = '#f8f8f2'): string => {
    let value = rawColor;
    const seen = new Set<string>();
    while (typeof value === 'string' && value !== '' && !value.startsWith('#')) {
      if (seen.has(value) || !(value in vars)) throw new Error('installed-look: invalid theme variable');
      seen.add(value); value = vars[value];
    }
    if (value === '') return fallback;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255) {
      if (value < 16) return ansi[value];
      if (value >= 232) return `#${(8 + (value - 232) * 10).toString(16).padStart(2, '0').repeat(3)}`;
      const n = value - 16, steps = [0,95,135,175,215,255];
      return '#' + [Math.floor(n / 36), Math.floor(n / 6) % 6, n % 6].map(i => steps[i].toString(16).padStart(2, '0')).join('');
    }
    if (typeof value !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) throw new Error('installed-look: invalid theme color');
    return value.length === 4 ? '#' + value.slice(1).split('').map(c => c + c).join('').toLowerCase() : value.toLowerCase();
  };
  const base = resolve(vars.base, '#161618'); equal(base, '#161618', 'pi background');
  const backgrounds = [base, ...backgroundTokens.map(key => resolve(tokens[key], '#161618'))];
  for (const background of backgrounds) if (!neutral.has(background)) throw new Error(`installed-look: tinted or unexpected background ${background}`);
  const contrast: InstalledLookReport['contrast'] = [];
  for (const [token, color] of Object.entries(tokens)) {
    if (backgroundTokens.includes(token)) continue;
    const foreground = resolve(color), required = decorative.has(token) ? 0 : indicators.has(token) ? 3 : 4.5;
    const candidates = required === 3 || required === 0 ? [base] : backgrounds;
    const rows = candidates.map(background => ({ token, foreground, background, ratio: contrastRatio(foreground, background), required }));
    const row = rows.reduce((worst, candidate) => candidate.ratio < worst.ratio ? candidate : worst);
    if (row.ratio < required) throw new Error(`installed-look: contrast ${token} ${row.ratio.toFixed(2)} < ${required} on ${row.background}`);
    contrast.push(row);
  }
  return { contrast };
}
