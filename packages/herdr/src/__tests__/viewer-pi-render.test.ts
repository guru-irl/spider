// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, beforeAll, expect, test } from 'vitest';
import { createPiRunView, type PiRunView } from '../viewers/pi-app.js';
import { loadBuiltInRenderers, piPackageRoot } from '../viewers/pi-loader.js';

const plain = (lines: string[]) => lines.join('\n').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b_[^\x1b]*\x1b\\/g, '');
let renders: number;
const ui = () => ({ requestRender() { renders++; }, terminal: { columns: 100, rows: 40 } });
const views: PiRunView[] = [];
afterEach(() => { for (const view of views.splice(0)) view.dispose(); });
let builtInRenderers: (name: string) => never;
beforeAll(async () => { renders = 0; builtInRenderers = (await loadBuiltInRenderers(piPackageRoot()))!; });
function make(options: Partial<Parameters<typeof createPiRunView>[0]> = {}): PiRunView {
  const view = createPiRunView({ ui: ui() as never, runName: 'fix flaky test', ownerName: 'planner', cwd: '/work/project', themeName: 'dark', now: () => 1_000, builtInRenderers, ...options });
  views.push(view); return view;
}
const at = (n: number) => 1_700_000_000_000 + n;
const header = { type: 'session', version: 3, id: 'h', timestamp: 't', cwd: '/work/project' };
const user = (text: string, n: number) => ({ type: 'message', id: `u${n}`, parentId: null, timestamp: 't', message: { role: 'user', content: text, timestamp: at(n) } });
const usage = { input: 1200, output: 340, cacheRead: 40000, cacheWrite: 0, totalTokens: 41540, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 } };
const assistant = (content: unknown[], n: number, extra: Record<string, unknown> = {}) => ({ type: 'message', id: `a${n}`, parentId: null, timestamp: 't',
  message: { role: 'assistant', content, provider: 'example', model: 'model-one', usage, stopReason: content.some(part => (part as { type: string }).type === 'toolCall') ? 'toolUse' : 'stop', timestamp: at(n), api: 'x', ...extra } });
const toolResult = (id: string, name: string, text: string, n: number) => ({ type: 'message', id: `r${n}`, parentId: null, timestamp: 't',
  message: { role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError: false, timestamp: at(n) } });

test('session entries render with pi components: task, thinking, markdown, built-in tools, spider calls and custom messages', () => {
  const view = make();
  view.addEntries([header,
    { type: 'model_change', id: 'mc', parentId: null, timestamp: 't', provider: 'example', modelId: 'model-one' },
    { type: 'thinking_level_change', id: 'tl', parentId: null, timestamp: 't', thinkingLevel: 'high' },
    user('Fix the flaky retry test', 1),
    assistant([{ type: 'thinking', thinking: 'Looking at the retry loop first' }, { type: 'text', text: 'I will **run** the tests.' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'npm test -- retry' } }], 2),
    toolResult('call-1', 'bash', 'RETRY_SUITE_PASSED', 3),
    assistant([{ type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'src/retry.ts' } }], 4),
    toolResult('call-2', 'read', 'export const retries = 3;', 5),
    assistant([{ type: 'toolCall', id: 'call-3', name: 'spider', arguments: { action: 'search', query: 'retry flake' } }], 6),
    toolResult('call-3', 'spider', 'no results', 7),
    assistant([{ type: 'toolCall', id: 'call-4', name: 'other_extension_tool', arguments: { level: 2 } }], 8),
    toolResult('call-4', 'other_extension_tool', 'EXTENSION_OUTPUT', 9),
    { type: 'custom_message', id: 'cm', parentId: null, timestamp: 't', customType: 'note', content: 'CUSTOM_NOTE_TEXT', display: true },
    { type: 'message', id: 'b1', parentId: null, timestamp: 't', message: { role: 'bashExecution', command: 'git status', output: 'BASH_EXEC_OUTPUT', exitCode: 0, cancelled: false, truncated: false, timestamp: at(10) } },
    { type: 'compaction', id: 'c1', parentId: null, timestamp: 't', summary: 'Earlier work summarised', firstKeptEntryId: 'u1', tokensBefore: 90000 },
    assistant([{ type: 'text', text: 'All green now.' }], 11),
  ]);
  const text = plain(view.render(100));
  expect(text).toContain('Fix the flaky retry test');
  expect(text).toContain('Looking at the retry loop first');
  expect(text).toContain('I will run the tests.'); expect(text).not.toContain('**run**');
  expect(text).toContain('$ npm test -- retry'); expect(text).toContain('RETRY_SUITE_PASSED');
  expect(text).toContain('read'); expect(text).toContain('src/retry.ts');
  expect(text).toMatch(/search/); expect(text).not.toContain('"action"');
  expect(text).toContain('other_extension_tool'); expect(text).toContain('EXTENSION_OUTPUT');
  expect(text).toContain('CUSTOM_NOTE_TEXT');
  expect(text).toContain('git status'); expect(text).toContain('BASH_EXEC_OUTPUT');
  expect(text).toMatch(/[Cc]ompact/);
  expect(text).toContain('All green now.');
  expect(text.indexOf('Fix the flaky retry test')).toBeLessThan(text.indexOf('All green now.'));
});

test('live events stream text, show a pending tool, finish it, and the saved entry does not duplicate them', () => {
  const view = make();
  const partial = { role: 'assistant', content: [{ type: 'text', text: 'Streaming the first half' }], provider: 'example', model: 'model-one', usage, stopReason: 'stop', timestamp: at(20), api: 'x' };
  view.live({ type: 'message_start', message: partial });
  view.live({ type: 'message_update', message: { ...partial, content: [{ type: 'text', text: 'Streaming the first half and the second' }] } });
  expect(plain(view.render(100))).toContain('Streaming the first half and the second');
  const withTool = { ...partial, content: [{ type: 'text', text: 'Streaming the first half and the second' }, { type: 'toolCall', id: 'live-1', name: 'bash', arguments: { command: 'sleep 1' } }], stopReason: 'toolUse' };
  view.live({ type: 'message_end', message: withTool });
  view.live({ type: 'tool_execution_start', toolCallId: 'live-1', toolName: 'bash', args: { command: 'sleep 1' } });
  expect(plain(view.render(100))).toContain('$ sleep 1');
  view.live({ type: 'tool_execution_end', toolCallId: 'live-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'LIVE_TOOL_DONE' }] }, isError: false });
  expect(plain(view.render(100))).toContain('LIVE_TOOL_DONE');
  view.addEntries([{ type: 'message', id: 'a20', parentId: null, timestamp: 't', message: withTool }, toolResult('live-1', 'bash', 'LIVE_TOOL_DONE', 21)]);
  const text = plain(view.render(100));
  expect(text.split('Streaming the first half and the second')).toHaveLength(2);
  expect(text.split('$ sleep 1')).toHaveLength(2);
  expect(text.split('LIVE_TOOL_DONE')).toHaveLength(2);
});

test('a live message and its saved copy count usage once', () => {
  const view = make(); const entry = assistant([{ type: 'text', text: 'once' }], 22);
  view.live({ type: 'message_end', message: entry.message }); view.addEntries([entry]);
  expect(plain(view.footerLines(100))).toContain('↑1.2k');
  expect(plain(view.footerLines(100))).not.toContain('↑2.4k');
});

test('renamed and reset saved sessions replace the visible conversation', () => {
  const view = make(); view.addEntries([user('old session', 1)]);
  view.setRunName('renamed run'); view.reset(); view.addEntries([user('new session', 2)]);
  expect(plain(view.render(100))).not.toContain('old session');
  expect(plain(view.render(100))).toContain('new session');
  expect(plain(view.footerLines(100))).toContain('renamed run');
});

test('thinking can be hidden and expanded with the pi display control', () => {
  const view = make(); view.addEntries([assistant([{ type: 'thinking', thinking: 'PRIVATE_THOUGHT_TEXT' }, { type: 'text', text: 'visible answer' }], 23)]);
  view.toggleThinking(); expect(plain(view.render(100))).not.toContain('PRIVATE_THOUGHT_TEXT');
  view.toggleThinking(); expect(plain(view.render(100))).toContain('PRIVATE_THOUGHT_TEXT');
});

test('a saved entry that lands before its live events is not rendered twice', () => {
  const view = make();
  const message = { role: 'assistant', content: [{ type: 'text', text: 'SAVED_FIRST' }], provider: 'example', model: 'model-one', usage, stopReason: 'stop', timestamp: at(30), api: 'x' };
  view.addEntries([{ type: 'message', id: 'a30', parentId: null, timestamp: 't', message }]);
  view.live({ type: 'message_start', message }); view.live({ type: 'message_end', message });
  expect(plain(view.render(100)).split('SAVED_FIRST')).toHaveLength(2);
});

test('the footer shows run, owner, model, thinking, context, tokens and status like pi', () => {
  const view = make({ contextWindow: () => 200000 });
  view.addEntries([header, { type: 'thinking_level_change', id: 'tl', parentId: null, timestamp: 't', thinkingLevel: 'high' },
    user('task', 1), assistant([{ type: 'text', text: 'ok' }], 2)]);
  view.setState({ status: 'running', steerable: true, reachable: true, readOnlyReason: null });
  const footer = plain(view.footerLines(100));
  expect(footer).toContain('fix flaky test'); expect(footer).toContain('planner'); expect(footer).toContain('running');
  expect(footer).toContain('model-one'); expect(footer).toContain('high');
  expect(footer).toContain('↑1.2k'); expect(footer).toContain('↓340'); expect(footer).toContain('$0.012');
  expect(footer).toContain('20.8%/200k');
  view.setState({ status: 'done', steerable: false, reachable: true, readOnlyReason: 'This run is done.' });
  expect(plain(view.footerLines(100))).toContain('done'); expect(plain(view.footerLines(100))).toContain('read-only');
});

test('the footer takes thinking from the response and includes non-assistant usage without changing context use', () => {
  const view = make();
  view.addEntries([assistant([{ type: 'text', text: 'answer' }], 24, { thinkingLevel: 'xhigh' }),
    { type: 'usage', id: 'usage', parentId: 'a24', timestamp: 't', kind: 'cache_warm', usage: { input: 800, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
    { ...toolResult('unknown', 'other', 'result', 25), message: { ...toolResult('unknown', 'other', 'result', 25).message, usage: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
  ]);
  const footer = plain(view.footerLines(100));
  expect(footer).toContain('xhigh'); expect(footer).toContain('↑2.5k'); expect(footer).toContain('42k context');
});

test('compaction invalidates the old context reading until another model response arrives', () => {
  const view = make(); view.addEntries([assistant([{ type: 'text', text: 'before' }], 26),
    { type: 'compaction', id: 'compact', parentId: 'a26', timestamp: 't', summary: 'summary', firstKeptEntryId: 'compact', tokensBefore: 41540 }]);
  expect(plain(view.footerLines(100))).toContain('context unknown');
});

test('tail usage is labelled and terminal state remains visible beside long names', () => {
  const view = make(); view.setRunName('A very long run name '.repeat(20)); view.setHistoryTruncated();
  view.addEntries([assistant([{ type: 'text', text: 'answer' }], 27)]);
  view.setState({ status: 'failed', steerable: false, reachable: true, readOnlyReason: 'This run is failed.' });
  const footer = plain(view.footerLines(80));
  expect(footer).toContain('failed'); expect(footer).toContain('read-only'); expect(footer).toContain('tail totals');
  expect(footer.split('\n').every(line => line.length <= 80)).toBe(true);
});

test('the footer uses owner model metadata without starting a model runtime', () => {
  const view = make(); view.setRunInfo({ protocol: 2, model: 'example/model-one', thinking: 'high', contextWindow: 200000 });
  expect(plain(view.footerLines(100))).toContain('model-one • high');
  view.addEntries([assistant([{ type: 'text', text: 'answer' }], 28)]);
  expect(plain(view.footerLines(100))).toContain('20.8%/200k');
});

test('missing saved files show recorded events rather than an empty viewer', () => {
  const view = make(); view.text('FALLBACK_TOOL_COMPLETE');
  const text = plain(view.render(100));
  expect(text).toContain('FALLBACK_TOOL_COMPLETE'); expect(text).toContain('Saved transcript unavailable');
});

test('missing data is labelled, not hidden', () => {
  const view = make();
  view.setState({ status: 'queued', steerable: false, reachable: true, readOnlyReason: 'This run is queued.' });
  const footer = plain(view.footerLines(100));
  expect(footer).toContain('no model yet'); expect(footer).toContain('context unknown');
});

test('the footer says the owner is unreachable only after 3 seconds, and clears on recovery', () => {
  let now = 0; const view = make({ now: () => now });
  view.setState({ status: 'running', steerable: false, reachable: false, readOnlyReason: null });
  now = 2_000; expect(plain(view.footerLines(100))).not.toContain('unreachable');
  now = 3_500; expect(plain(view.footerLines(100))).toContain('owner unreachable');
  view.setState({ status: 'running', steerable: true, reachable: true, readOnlyReason: null });
  expect(plain(view.footerLines(100))).not.toContain('unreachable');
  expect(plain(view.render(100))).not.toMatch(/reconnect/i);
});

test('a steerable run shows a pi editor; a read-only run has none', () => {
  const view = make();
  view.setState({ status: 'running', steerable: true, reachable: true, readOnlyReason: null });
  expect(view.editor).not.toBeNull(); expect(view.render(100).join('\n')).toContain('─');
  view.setState({ status: 'done', steerable: false, reachable: true, readOnlyReason: 'This run is done.' });
  expect(view.editor).toBeNull();
});

test('an unfinished status after owner shutdown is explicitly last known, not presented as live', () => {
  const view = make();
  view.setState({ status: 'running', statusIsStale: true, steerable: false, reachable: true, readOnlyReason: 'The owning session is closed.' });
  const footer = plain(view.footerLines(100));
  expect(footer).toContain('last known running'); expect(footer).toContain('read-only'); expect(view.editor).toBeNull();
});

test('a slow owner keeps the editor and draft while refusing submission', () => {
  const view = make(); const sent: string[] = []; view.onSteer(async text => { sent.push(text); return null; });
  view.setState({ status: 'running', steerable: true, reachable: true, readOnlyReason: null });
  const editor = view.editor!; editor.setText('Keep this draft');
  view.setState({ status: 'running', steerable: false, reachable: false, canCompose: true, readOnlyReason: 'The owning session is reconnecting.' });
  expect(view.editor).toBe(editor);
  expect(view.editor!.getText()).toBe('Keep this draft');
  view.editor!.handleInput('\r');
  expect(sent).toEqual([]);
  expect(view.editor!.getText()).toBe('Keep this draft');
  expect(plain(view.render(100))).toContain('Not sent.');
  expect(plain(view.footerLines(100))).not.toContain('read-only');
});

test('an unsent draft survives a temporary owner disconnect without being submitted', () => {
  const view = make(); const sent: string[] = []; view.onSteer(async text => { sent.push(text); return null; });
  view.setState({ status: 'running', steerable: true, reachable: true, readOnlyReason: null });
  view.editor!.setText('Keep this unsent draft');
  view.setState({ status: 'running', steerable: false, reachable: false, readOnlyReason: 'Owner unavailable.' });
  expect(view.editor).toBeNull();
  view.setState({ status: 'running', steerable: true, reachable: true, readOnlyReason: null });
  expect(view.editor!.getText()).toBe('Keep this unsent draft'); expect(sent).toEqual([]);
});

test('a submitted steer shows as queued like pi, then its delivery, and leaves once the child records it', async () => {
  const view = make(); const sent: string[] = [];
  view.onSteer(async text => { sent.push(text); return { delivery: 'accepted but not confirmed', accepted: true, delivered: false, queued: true }; });
  view.setState({ status: 'running', steerable: true, reachable: true, readOnlyReason: null });
  view.editor!.onSubmit!('Use the retry helper');
  expect(sent).toEqual(['Use the retry helper']);
  expect(plain(view.render(100))).toContain('Steering: Use the retry helper');
  await Promise.resolve(); await Promise.resolve();
  expect(plain(view.render(100))).toContain('accepted but not confirmed');
  view.addEntries([user('Use the retry helper', 40)]);
  const text = plain(view.render(100));
  expect(text).not.toContain('Steering: Use the retry helper'); expect(text).toContain('Use the retry helper');
});

test('a refused steer stays visible with its reason', async () => {
  const view = make();
  view.onSteer(async () => ({ delivery: 'refused', accepted: false, delivered: false, queued: false, error: 'The child pipe closed.' }));
  view.setState({ status: 'running', steerable: true, reachable: true, readOnlyReason: null });
  view.editor!.onSubmit!('try again'); await Promise.resolve(); await Promise.resolve();
  expect(plain(view.render(100))).toContain('refused'); expect(plain(view.render(100))).toContain('The child pipe closed.');
});

test('a long steer cannot hide uncertain delivery or trigger an automatic retry', async () => {
  const view = make(); let sent = 0;
  view.onSteer(async () => { sent++; return null; });
  view.setState({ status: 'running', steerable: true, reachable: true, readOnlyReason: null });
  view.editor!.onSubmit!('A long instruction '.repeat(30)); await Promise.resolve(); await Promise.resolve();
  const text = plain(view.render(40));
  expect(text).toMatch(/delivery\s+unknown/); expect(text).toMatch(/Do not\s+resend/); expect(sent).toBe(1);
});

test('omitting older components does not omit their recorded usage or model settings', () => {
  const view = make({ maxItems: 20 });
  view.addEntries([header,
    { type: 'model_change', provider: 'example', modelId: 'model-one' }, { type: 'thinking_level_change', thinkingLevel: 'high' },
    { type: 'usage', usage: { input: 1000, output: 0 } },
    { ...toolResult('older', 'other', 'older result', 60), message: { ...toolResult('older', 'other', 'older result', 60).message, usage: { input: 500, output: 0 } } },
    ...Array.from({ length: 60 }, (_, n) => user(`newer question ${n}`, 100 + n))]);
  const footer = plain(view.footerLines(100));
  expect(footer).toContain('↑1.5k'); expect(footer).toContain('model-one • high'); expect(footer).not.toContain('tail totals');
});

test('hundreds of messages render quickly and keep a bounded number of components', () => {
  const view = make({ maxItems: 120 });
  const entries = [header]; for (let n = 0; n < 1500; n++) entries.push(n % 2 ? assistant([{ type: 'text', text: `answer ${n}` }], n) as never : user(`question ${n}`, n) as never);
  const started = performance.now(); view.addEntries(entries); const text = plain(view.render(100));
  expect(performance.now() - started).toBeLessThan(3000);
  expect(text).toContain('answer 1499'); expect(text).not.toContain('question 2\n');
  expect(view.itemCount()).toBeLessThanOrEqual(120);
  expect(text).toContain('Earlier messages are not shown');
});

test('session and live content cannot inject terminal controls', () => {
  const view = make();
  const attack = '\u001b]52;c;forbidden\u0007\u001b[H\u001b[2JVISIBLE_SAFE_TEXT';
  view.addEntries([user(attack, 55)]);
  view.live({ type: 'message_end', message: assistant([{ type: 'text', text: attack }], 56).message });
  const text = view.render(100).join('\n');
  expect(text).toContain('VISIBLE_SAFE_TEXT'); expect(text).not.toContain('\u001b]52;');
  expect(text).not.toContain('\u001b[2J'); expect(text).not.toContain('forbidden');
  view.setRunName(attack); view.setOwnerName(attack);
  expect(view.footerLines(100).join('\n')).not.toContain('\u001b]52;');
});

test('a notice is one dim line in the transcript', () => {
  const view = make(); view.notice('The owning session runs an older spider build. Live streaming is off until it reloads.');
  expect(plain(view.render(100)).match(/older spider build/g)).toHaveLength(1);
});
