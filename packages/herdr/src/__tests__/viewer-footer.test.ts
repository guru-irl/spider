// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { createPiRunView, type PiRunView } from '../viewers/pi-app.js';

const views: PiRunView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  vi.useRealTimers();
});
function make(requestRender = vi.fn()): PiRunView {
  const ui = { requestRender, setFocus: vi.fn(), terminal: { columns: 100, rows: 30 } } as unknown as TUI;
  const view = createPiRunView({ ui, runName: 'retry-check', ownerName: 'planner', cwd: '/fixture', themeName: 'dark' });
  views.push(view);
  return view;
}
const running = { status: 'running', steerable: true, reachable: true, readOnlyReason: null } as const;
const message = {
  role: 'assistant', content: [{ type: 'text', text: 'Finished checking the retry path.' }],
  provider: 'github-copilot', model: 'gpt-6.1-sol', api: 'openai-responses', stopReason: 'stop',
  timestamp: Date.parse('2026-10-02T12:00:00Z'),
  usage: { input: 1200, output: 340, cacheRead: 40000, cacheWrite: 0, totalTokens: 41540,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 } },
};
const entry = { type: 'message', timestamp: '2026-10-02T12:00:00Z', message };

test('viewer input uses the shared band and keeps a draft across reconnect', () => {
  const view = make();
  view.setState(running);
  view.editor!.setText('Keep the retry limit at three.');
  const rows = view.render(72).map(stripTerminalSequences);
  expect(rows).toContain(`▖${'▄'.repeat(71)}`);
  expect(rows.some(row => row.startsWith('▌ Keep the retry limit at three.'))).toBe(true);
  expect(rows).toContain(`▘${'▀'.repeat(71)}`);
  for (const width of [10, 40, 72]) expect(view.render(width).every(row => visibleWidth(row) <= width)).toBe(true);
  view.setState({ status: 'running', steerable: false, reachable: false, readOnlyReason: 'Owner unavailable.' });
  expect(view.editor).toBeNull();
  view.setState(running);
  expect(view.editor!.getText()).toBe('Keep the retry limit at three.');
});

test('viewer respects the owning session input-band preference without losing its draft', () => {
  const view = make();
  view.setRunInfo({ protocol: 2, inputBand: false });
  view.setState(running);
  view.editor!.setText('Keep this draft');
  expect(view.render(40).map(stripTerminalSequences).some(row => row.startsWith('─'))).toBe(true);
  view.setRunInfo({ protocol: 2, inputBand: true });
  expect(view.editor!.getText()).toBe('Keep this draft');
  expect(view.render(40).map(stripTerminalSequences).some(row => row.startsWith('▖'))).toBe(true);
});

test('viewer footer shows calibrated run credits, context, cache and the model display name', () => {
  const view = make();
  view.setRunInfo({ protocol: 2, model: 'github-copilot/gpt-6.1-sol', modelName: 'GPT-6.1 Sol',
    thinking: 'xhigh', contextWindow: 200000, creditFactor: 0.5 });
  view.setState(running);
  view.live({ type: 'message_end', message });
  view.addEntries([entry]); // The persisted copy of the live message must not double count.
  const lines = view.footerLines(120).map(stripTerminalSequences);
  const footer = lines.join('\n');
  expect(footer).toContain('retry-check');
  expect(footer).toContain('planner');
  expect(footer).toContain('20.8%/200k');
  expect(footer).toContain('0.5 AIC');
  expect(footer).toContain('CH97.1%');
  expect(footer).toContain('R40k W0');
  expect(footer).toContain('GPT-6.1 Sol · xhigh');
  expect(footer).not.toMatch(/↑|↓|\$|month|R80k|running/);
  view.setRunInfo({ protocol: 2, model: 'github-copilot/gpt-6.1-sol', modelName: 'GPT-6.1 Sol',
    thinking: 'xhigh', contextWindow: 200000, creditFactor: 1 });
  expect(view.footerLines(120).map(stripTerminalSequences).join('\n')).toContain('1.0 AIC');
  for (let width = 1; width <= 160; width++) {
    expect(view.footerLines(width).every(row => visibleWidth(row) <= width), `width ${width}`).toBe(true);
  }
});

test('viewer uses owner model metadata for an unqualified child model ID', () => {
  const view = make();
  view.setRunInfo({ protocol: 2, model: 'gpt-6.1-sol', modelName: 'GPT-6.1 Sol', thinking: 'high', contextWindow: 200000 });
  view.addEntries([entry]);
  const footer = view.footerLines(120).map(stripTerminalSequences).join('\n');
  expect(footer).toContain('20.8%/200k');
  expect(footer).toContain('GPT-6.1 Sol · high');
});

test('viewer footer does not claim zero credits or context when usage is unpriced', () => {
  const view = make();
  view.setRunInfo({ protocol: 2, model: 'unknown/model', thinking: 'high' });
  view.addEntries([{ ...entry, message: { ...message, provider: 'unknown', model: 'model' } }]);
  const footer = view.footerLines(120).map(stripTerminalSequences).join('\n');
  expect(footer).toContain('? AIC');
  expect(footer).toContain('42k context');
  view.addEntries([{ type: 'compaction', summary: 'Earlier turns', firstKeptEntryId: 'x', tokensBefore: 41540 }]);
  expect(view.footerLines(120).map(stripTerminalSequences).join('\n')).toContain('context unknown');
});

test('viewer context includes trailing tool and user messages and ignores failed response usage', () => {
  const view = make();
  view.setRunInfo({ protocol: 2, model: 'github-copilot/gpt-6.1-sol', contextWindow: 200000 });
  view.addEntries([entry, { type: 'message', timestamp: '2026-10-02T12:00:01Z', message: {
    role: 'toolResult', toolCallId: 'tool-1', toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(8000) }],
    isError: false, timestamp: message.timestamp + 1,
  } }]);
  expect(view.footerLines(120).map(stripTerminalSequences).join('\n')).toContain('21.8%/200k');
  view.addEntries([{ type: 'message', timestamp: '2026-10-02T12:00:02Z', message: {
    role: 'user', content: 'y'.repeat(4000), timestamp: message.timestamp + 2,
  } }, { type: 'message', timestamp: '2026-10-02T12:00:03Z', message: {
    ...message, content: [], stopReason: 'error', timestamp: message.timestamp + 3,
    usage: { ...message.usage, totalTokens: 1000 },
  } }]);
  expect(view.footerLines(120).map(stripTerminalSequences).join('\n')).toContain('22.3%/200k');
});

test('a context edit invalidates the last usage until a new response', () => {
  const view = make();
  view.setRunInfo({ protocol: 2, model: 'github-copilot/gpt-6.1-sol', contextWindow: 200000 });
  view.addEntries([entry, { type: 'context_edit', id: 'edit', parentId: 'message', timestamp: '2026-10-02T12:00:01Z',
    targetId: 'older-message', replacement: null }]);
  expect(view.footerLines(120).map(stripTerminalSequences).join('\n')).toContain('?/200k');
  view.addEntries([{ ...entry, timestamp: '2026-10-02T12:00:02Z', message: { ...message,
    timestamp: message.timestamp + 2000, usage: { ...message.usage, totalTokens: 50000 } } }]);
  expect(view.footerLines(120).map(stripTerminalSequences).join('\n')).toContain('25.0%/200k');
});

test('late saved history does not replace the live context with an older response', () => {
  const view = make();
  view.setRunInfo({ protocol: 2, model: 'github-copilot/gpt-6.1-sol', contextWindow: 200000 });
  view.live({ type: 'message_end', message });
  view.addEntries([{ type: 'compaction', timestamp: '2026-10-02T11:59:57Z', summary: 'Earlier turns', firstKeptEntryId: 'old', tokensBefore: 90000 },
    { type: 'message', timestamp: '2026-10-02T11:59:58Z', message: {
    ...message, timestamp: message.timestamp - 2000, usage: { ...message.usage, input: 1000, output: 0, cacheRead: 0, totalTokens: 1000 },
  } }, { type: 'message', timestamp: '2026-10-02T11:59:59Z', message: {
    role: 'user', content: 'y'.repeat(4000), timestamp: message.timestamp - 1000,
  } }, entry]);
  const footer = view.footerLines(120).map(stripTerminalSequences).join('\n');
  expect(footer).toContain('20.8%/200k');
  expect(footer).toContain('CH97.1%');
});

test('viewer labels missing transcript history rather than claiming the tail is total run credits', () => {
  const view = make();
  view.setRunInfo({ protocol: 2, model: 'github-copilot/gpt-6.1-sol', contextWindow: 200000 });
  view.addEntries([entry]);
  view.setHistoryTruncated();
  const footer = view.footerLines(120).map(stripTerminalSequences).join('\n');
  expect(footer).toContain('partial totals');
  expect(footer).toContain('? AIC');
});

test('recorded fallback events do not claim a complete run credit total', () => {
  const view = make();
  view.text('A saved tool event without its session transcript.');
  const footer = view.footerLines(120).map(stripTerminalSequences).join('\n');
  expect(footer).toContain('partial totals');
  expect(footer).toContain('? AIC');
});

test('a newly opened idle RPC child starts with the idle moon', () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const view = make();
    view.setRunInfo({ protocol: 2, working: false });
    view.setState({ status: 'running', steerable: true, reachable: true, readOnlyReason: null });
    expect(view.footerLines(100).map(stripTerminalSequences).join('\n')).toMatch(/○/);
    view.live({ type: 'agent_start' });
    expect(view.footerLines(100).map(stripTerminalSequences).join('\n')).toMatch(/◐/);
    view.dispose();
  } finally { vi.useRealTimers(); }
});

test('viewer moon advances while working and stops on agent end, stale state and disposal', () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const requestRender = vi.fn();
  const view = make(requestRender);
  view.setState(running);
  const moon = () => stripTerminalSequences(view.footerLines(120)[1])[0];
  expect(moon()).toBe('◐');
  requestRender.mockClear();
  vi.advanceTimersByTime(250);
  expect(moon()).toBe('◓');
  expect(requestRender).toHaveBeenCalled();
  view.live({ type: 'agent_end' });
  expect(moon()).toBe('○');
  requestRender.mockClear();
  vi.advanceTimersByTime(500);
  expect(moon()).toBe('○');
  expect(requestRender).not.toHaveBeenCalled();
  view.live({ type: 'agent_start' });
  expect(moon()).toBe('◐');
  view.setState({ ...running, statusIsStale: true, steerable: false });
  expect(moon()).toBe('○');
  view.setState(running);
  expect(moon()).toBe('◐');
  view.dispose();
  requestRender.mockClear();
  vi.advanceTimersByTime(1000);
  expect(requestRender).not.toHaveBeenCalled();
});
