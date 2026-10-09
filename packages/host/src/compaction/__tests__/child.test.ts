import { test, expect, vi } from 'vitest';
import { setup, pi, user, assistant, summaryCalls } from './harness.js';
function history(f: any) {
  const sm = pi.SessionManager.inMemory(f.ctx.cwd);
  sm.appendMessage(user('HISTORY ' + 'h'.repeat(2000)));
  sm.appendMessage(assistant('history'));
  sm.appendMessage({ ...assistant(''), content: [{ type: 'toolCall', id: 'keep', name: 'read', arguments: { path: 'kept.ts' } }], stopReason: 'toolUse' });
  sm.appendMessage({ role: 'toolResult', toolCallId: 'keep', toolName: 'read', content: [{ type: 'text', text: 'k'.repeat(160) }], isError: false, timestamp: 3 });
  f.ctx.sessionManager = sm;
  return sm;
}
const turn = { outcome: 'completed', entries: [], toolResults: [{}] };
// Break: an ineligible child boundary issues a model request or returns a draft.
for (const kind of ['error', 'no-tools', 'draft', 'aborted', 'below', 'no-usage', 'unknown-percent', 'no-model']) {
  test(`child skips ${kind} boundary`, async () => {
    const f = setup(true); history(f); const event = structuredClone(turn);
    if (kind === 'error') event.outcome = 'error';
    if (kind === 'no-tools') event.toolResults = [];
    if (kind === 'draft') (event.entries as any[]).push({ type: 'compaction' });
    if (kind === 'aborted') f.ctx.signal = AbortSignal.abort();
    if (kind === 'below') f.ctx.getContextUsage = () => ({ tokens: 60000, percent: 49.9 });
    if (kind === 'no-usage') f.ctx.getContextUsage = () => undefined;
    if (kind === 'unknown-percent') f.ctx.getContextUsage = () => ({ tokens: null, percent: null });
    if (kind === 'no-model') f.ctx.model = undefined;
    expect(await f.handlers.get('turn_end')(event, f.ctx)).toBeUndefined(); expect(summaryCalls).toHaveLength(0);
  });
}
// Break: pending edits are summarized, or repeat skips spam stderr.
test('pending context edits skip with one diagnostic per reason', async () => {
  const f = setup(true); history(f); const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const event = { ...turn, entries: [{ type: 'context_edit' }] };
    for (let i = 0; i < 3; i++) expect(await f.handlers.get('turn_end')(event, f.ctx)).toBeUndefined();
    expect(summaryCalls).toHaveLength(0);
    expect(write.mock.calls.map(call => call[0]).join('').match(/pending context edit/g)).toHaveLength(1);
  } finally { write.mockRestore(); }
});
test('empty history skips with one nothing-to-compact diagnostic', async () => {
  const f = setup(true); f.ctx.sessionManager = pi.SessionManager.inMemory(f.ctx.cwd);
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const handler = f.handlers.get('turn_end');
    expect(await handler(turn, f.ctx)).toBeUndefined(); expect(await handler(turn, f.ctx)).toBeUndefined();
    expect(summaryCalls).toHaveLength(0); expect(write.mock.calls.map(call => call[0]).join('')).toMatch(/nothing to compact/);
    expect(write).toHaveBeenCalledTimes(1);
  } finally { write.mockRestore(); }
});
// Break: unknown failure tokens or unknown current tokens permit immediate retries.
for (const unknownFailure of [false, true]) test(`child backoff keeps unknown ${unknownFailure ? 'failure' : 'current'} tokens inactive`, async () => {
  const f = setup(true); history(f);
  if (unknownFailure) f.ctx.getContextUsage = () => ({ tokens: null, percent: 60 });
  f.response.content = [{ type: 'text', text: 'invalid' }];
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    expect(await f.handlers.get('turn_end')(turn, f.ctx)).toBeUndefined(); expect(summaryCalls).toHaveLength(1);
    f.response.content = [{ type: 'text', text: '## Goal\nvalid' }];
    f.ctx.getContextUsage = () => ({ tokens: unknownFailure ? 700000 : null, percent: 60 });
    expect(await f.handlers.get('turn_end')(turn, f.ctx)).toBeUndefined(); expect(summaryCalls).toHaveLength(1);
    expect(write.mock.calls.map(call => call[0]).join('')).toMatch(/back-off/);
  } finally { write.mockRestore(); }
});
// Break: parent file-list cap, measurements or summary settings leak into children, or legacy lists vanish.
for (const source of ['per-model-compaction', 'spider-compaction']) test(`child recovers all ${source} files without parent limits`, async () => {
  const f = setup(true); const sm = history(f);
  const entries = sm.getBranch();
  const earlier = Array.from({ length: 550 }, (_, i) => `old-${i}.ts`);
  sm.appendCompaction('## Goal\nPREVIOUS', entries[0].id, 8000, { source, readFiles: earlier, modifiedFiles: ['changed.ts'] }, true);
  f.config['compaction.fileListCap'] = 1;
  const r = await f.handlers.get('turn_end')(turn, f.ctx);
  expect(r?.entries.at(-1)?.details.readFiles).toHaveLength(550);
  expect(r.entries.at(-1).details.modifiedFiles).toEqual(['changed.ts']);
  expect(r.entries.at(-1).details.summarySectionTokens).toBeUndefined();
  expect(r.entries.at(-1).details.summaryModel).toBeUndefined();
});

// Break: summarizable spans smaller than the retained-token budget are drafted anyway.
test('too-small prefix is skipped rather than compacting a negligible span', async () => {
  const f = setup(true); const sm = pi.SessionManager.inMemory(f.ctx.cwd);
  sm.appendMessage(user('old')); sm.appendMessage(assistant('answer'));
  sm.appendMessage({ ...assistant(''), content: [{ type: 'toolCall', id: 'keep', name: 'read', arguments: { path: 'kept.ts' } }], stopReason: 'toolUse' });
  sm.appendMessage({ role: 'toolResult', toolCallId: 'keep', toolName: 'read', content: [{ type: 'text', text: 'k'.repeat(160) }], isError: false, timestamp: 3 });
  f.ctx.sessionManager = sm;
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    expect(await f.handlers.get('turn_end')(turn, f.ctx)).toBeUndefined();
    expect(summaryCalls).toHaveLength(0); expect(write.mock.calls.map(call => call[0]).join('')).toMatch(/too little to compact/);
  } finally { write.mockRestore(); }
});
