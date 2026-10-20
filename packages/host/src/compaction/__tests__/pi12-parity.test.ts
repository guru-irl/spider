import { expect, test } from 'vitest';
import { setup, pi, user, assistant, summaryCalls } from './harness.js';
// Test-only oracle. Production stays on pi's public root exports.
const { prepareCompaction } = await import(new URL('../../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js', import.meta.url).href);

// Break: replayed reasoning or oversized results leak into spider's actual summary request.
test('pi summary serialization omits thinking while preserving visible work and truncating tool output', async () => {
  const f = setup();
  f.event.preparation.messagesToSummarize = [
    user('Visible request'),
    { ...assistant(''), content: [
      { type: 'thinking', thinking: 'PRIVATE_REASONING_' + 'r'.repeat(20000) },
      { type: 'text', text: 'Visible answer' },
      { type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'visible.ts' } },
    ] },
    { role: 'toolResult', toolName: 'read', toolCallId: 'read', timestamp: 3, isError: false,
      content: [{ type: 'text', text: 'x'.repeat(2000) + 'TRUNCATED_TAIL' }] },
  ];
  f.event.preparation.turnPrefixMessages = [];
  f.event.preparation.previousSummary = undefined;
  expect((await f.run()).compaction).toBeDefined();
  expect(f.requests).toHaveLength(1);
  const text = f.requests[0].context.messages.find((message: any) => message.role === 'user').content[0].text;
  expect(text).toContain('[User]: Visible request');
  expect(text).toContain('[Assistant]: Visible answer');
  expect(text).toContain('[Assistant tool calls]: read(path="visible.ts")');
  expect(text).toContain('[Tool result]: ' + 'x'.repeat(2000) + '\n\n[... 14 more characters truncated]');
  expect(text).not.toContain('PRIVATE_REASONING_');
  expect(text).not.toContain('[Assistant thinking]');
  expect(text).not.toContain('TRUNCATED_TAIL');
  expect(f.requests[0].options.cacheRetention).toBe('none');
});

// Break: nested read/write/edit records, incomplete records or edited/omitted entries diverge from pi's preparation.
test.each([7, 11, 23])('seed %s matches pi cuts and file sets across nested calls and context edits', async initialSeed => {
  let seed = initialSeed;
  const next = () => { seed = Math.imul(seed, 1664525) + 1013904223 >>> 0; return seed; };
  for (let i = 0; i < 80; i++) {
    const f = setup(true);
    const sm = pi.SessionManager.inMemory(f.ctx.cwd);
    const first = sm.appendMessage(user('HISTORY ' + 'h'.repeat(2000)));
    if (i % 4 === 0) sm.appendCompaction('## Goal\nPRIOR', first, 8000, { readFiles: ['prior.ts'], modifiedFiles: ['prior-edit.ts'] });
    for (let j = 0; j < 4 + next() % 8; j++) {
      const name = ['read', 'write', 'edit'][next() % 3];
      const path = `file-${next() % 8}.ts`;
      const id = `call-${j}`;
      sm.appendMessage({ ...assistant('Visible progress'), content: [
        { type: 'toolCall', id, name: 'codemode', arguments: { code: 'fixture' } },
      ], stopReason: 'toolUse' });
      sm.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'codemode', timestamp: j, isError: false,
        content: [{ type: 'text', text: 'x'.repeat(160) }], nestedCalls: { complete: false, calls: [
          { id: `${id}/1`, name, arguments: { path }, status: 'ok', durationMs: 1 },
          { id: `${id}/2`, name: 'read', arguments: { path }, status: 'ok', durationMs: 1 },
          { id: `${id}/3`, name: 'edit', status: 'error', durationMs: 0 },
          { id: `${id}/4`, name: 'read', arguments: { path: 42 }, status: 'ok', durationMs: 1 },
        ] } } as any);
      if (next() % 2) sm.appendCustomEntry('fixture.metadata', { index: j });
    }
    const edited = sm.appendMessage(user('Original input ' + 'u'.repeat(200)));
    if (i % 3 === 0) sm.appendContextEdit(edited, { content: 'Edited input ' + 'e'.repeat(200) });
    if (i % 2 === 0) {
      // A closed recovery suffix: only omitted attempts and invisible metadata follow the visible input.
      const omitted = sm.appendMessage(assistant('Abandoned attempt ' + 'a'.repeat(200)));
      sm.appendContextEdit(omitted, null);
      sm.appendCustomEntry('fixture.recovery', {});
    } else {
      sm.appendMessage({ ...assistant(''), content: [{ type: 'toolCall', id: 'keep', name: 'read', arguments: { path: 'kept.ts' } }], stopReason: 'toolUse' });
      sm.appendMessage({ role: 'toolResult', toolCallId: 'keep', toolName: 'read', content: [{ type: 'text', text: 'k'.repeat(160) }], isError: false, timestamp: 30 });
    }
    f.ctx.sessionManager = sm;
    const prep = prepareCompaction(sm.getBranch(), { enabled: false, reserveTokens: 1000, keepRecentTokens: 20 });
    expect(prep).toBeDefined();
    const result = await f.handlers.get('turn_end')({ outcome: 'completed', entries: [], toolResults: [{}] }, f.ctx);
    const draft = result?.entries.at(-1);
    expect(draft?.firstKeptEntryId).toBe(prep.firstKeptEntryId);
    expect(summaryCalls.at(-1).currentMessages).toEqual([...prep.messagesToSummarize, ...prep.turnPrefixMessages]);
    expect(summaryCalls.at(-1).previousSummary).toBe(prep.previousSummary);
    const modified = new Set([...prep.fileOps.edited, ...prep.fileOps.written]);
    expect(draft.details.readFiles).toEqual([...prep.fileOps.read].filter((file: string) => !modified.has(file)).sort());
    expect(draft.details.modifiedFiles).toEqual([...modified].sort());
    expect(f.requests).toHaveLength(1);
  }
});
